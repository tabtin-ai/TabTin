"""TabChat 附件 metadata 的长期存储合同测试。"""

from django.test import SimpleTestCase

from apps.tabchat.constants import MessageType
from apps.tabchat.services.message_service import (
    _build_preview,
    _sanitize_attachment_metadata,
    _validate_card_metadata,
    _validate_attachment_metadata,
)


class AttachmentMetadataValidationTests(SimpleTestCase):
    def _metadata(self) -> dict:
        return {
            "file_id": "file-1",
            "file_name": "image.png",
            "file_size": 128,
        }

    def test_strips_runtime_urls_and_local_paths_before_persisting(self):
        metadata = {
            **self._metadata(),
            "access_url": "https://oss.example.com/image.png?Expires=1&Signature=secret",
            "cdn_url": "https://cdn.example.com/image.png",
            "download_url": "https://oss.example.com/download",
            "presigned_url": "https://oss.example.com/presigned",
            "__client_local_path": "/Users/seda/Desktop/image.png",
            "forwarded_from": {
                "original_message_id": 12,
                "original_conversation_id": "conv-1",
                "access_url": "https://oss.example.com/forwarded?Signature=secret",
            },
        }

        sanitized = _sanitize_attachment_metadata(metadata, MessageType.IMAGE)

        self.assertEqual(
            sanitized,
            {
                **self._metadata(),
                "forwarded_from": {
                    "original_message_id": 12,
                    "original_conversation_id": "conv-1",
                },
            },
        )
        self.assertIn("access_url", metadata)

    def test_keeps_message_ref_on_file_and_image_messages(self):
        message_ref = "019f0000-0000-7000-8000-000000000042"
        metadata = {
            **self._metadata(),
            "message_ref": message_ref,
            "client_request_id": "019f0000-0000-7000-8000-000000000043",
            "access_url": "https://oss.example.com/image.png?Signature=secret",
        }

        image_sanitized = _sanitize_attachment_metadata(metadata, MessageType.IMAGE)
        file_sanitized = _sanitize_attachment_metadata(
            {**metadata, "file_name": "deck.pptx"},
            MessageType.FILE,
        )

        self.assertEqual(image_sanitized["message_ref"], message_ref)
        self.assertEqual(file_sanitized["message_ref"], message_ref)
        self.assertEqual(
            image_sanitized["client_request_id"],
            metadata["client_request_id"],
        )
        self.assertNotIn("access_url", image_sanitized)
        self.assertNotIn("access_url", file_sanitized)

    def test_requires_file_id_for_new_attachment_messages(self):
        with self.assertRaisesRegex(ValueError, "缺少 file_id"):
            _validate_attachment_metadata({"file_name": "image.png"}, MessageType.IMAGE)

    def test_accepts_file_identity_and_display_snapshot(self):
        _validate_attachment_metadata(self._metadata(), MessageType.IMAGE)

    def test_keeps_known_sticker_on_image_messages(self):
        metadata = {
            **self._metadata(),
            "sticker": {"pack": "tabtin-robot", "id": "happy", "extra": "drop-me"},
            "access_url": "https://oss.example.com/sticker.png?Signature=secret",
        }

        sanitized = _sanitize_attachment_metadata(metadata, MessageType.IMAGE)

        self.assertEqual(
            sanitized,
            {
                **self._metadata(),
                "sticker": {"pack": "tabtin-robot", "id": "happy"},
            },
        )
        _validate_attachment_metadata(sanitized, MessageType.IMAGE)

    def test_drops_unknown_or_file_message_stickers(self):
        image_sanitized = _sanitize_attachment_metadata(
            {**self._metadata(), "sticker": {"pack": "other", "id": "happy"}},
            MessageType.IMAGE,
        )
        self.assertNotIn("sticker", image_sanitized)

        file_sanitized = _sanitize_attachment_metadata(
            {**self._metadata(), "sticker": {"pack": "tabtin-robot", "id": "happy"}},
            MessageType.FILE,
        )
        self.assertNotIn("sticker", file_sanitized)

    def test_rejects_invalid_sticker_when_present(self):
        with self.assertRaisesRegex(ValueError, "sticker 不合法"):
            _validate_attachment_metadata(
                {**self._metadata(), "sticker": {"pack": "tabtin-robot", "id": "nope"}},
                MessageType.IMAGE,
            )

    def test_keeps_and_normalizes_codex_session_card_on_file_messages(self):
        metadata = {
            **self._metadata(),
            "file_name": "session.zip",
            "file_type": "application/zip",
            "card": {
                "type": "codex_session",
                "schema_version": 1,
                "codex_session_id": " session-1 ",
                "codex_session_name": " 排查 IM ",
                "suggested_working_directory": " /workspace/tabtin ",
                "untrusted_extra": "drop-me",
            },
        }

        sanitized = _sanitize_attachment_metadata(metadata, MessageType.FILE)
        validated = _validate_card_metadata(
            sanitized,
            sender_id="user-1",
            conv_organization_id="org-1",
        )

        self.assertEqual(
            validated["card"],
            {
                "type": "codex_session",
                "schema_version": 1,
                "codex_session_id": "session-1",
                "codex_session_name": "排查 IM",
                "suggested_working_directory": "/workspace/tabtin",
            },
        )

    def test_drops_other_cards_from_attachment_metadata(self):
        sanitized = _sanitize_attachment_metadata(
            {
                **self._metadata(),
                "card": {"type": "prompt", "prompt_text": "不要随文件夹带"},
            },
            MessageType.FILE,
        )

        self.assertNotIn("card", sanitized)

    def test_preserves_future_codex_schema_and_rejects_v1_non_file_card(self):
        future = {
            **self._metadata(),
            "file_name": "session.zip",
            "card": {
                "type": "codex_session",
                "schema_version": 2,
                "codex_session_id": "session-1",
                "codex_session_name": "排查 IM",
                "future_field": {"mode": "portable"},
            },
        }
        sanitized = _sanitize_attachment_metadata(future, MessageType.FILE)
        validated = _validate_card_metadata(
            sanitized,
            sender_id="user-1",
            conv_organization_id="org-1",
        )

        self.assertEqual(validated["card"], future["card"])
        with self.assertRaisesRegex(ValueError, "只能用于文件消息"):
            _validate_attachment_metadata(
                {
                    "card": {
                        "type": "codex_session",
                        "schema_version": 1,
                        "codex_session_id": "session-1",
                        "codex_session_name": "排查 IM",
                    }
                },
                MessageType.TEXT,
            )

    def test_codex_session_file_uses_session_name_in_conversation_preview(self):
        preview = _build_preview(
            MessageType.FILE,
            "[Codex 会话] 排查 IM",
            {
                "file_name": "session.zip",
                "card": {
                    "type": "codex_session",
                    "schema_version": 1,
                    "codex_session_id": "session-1",
                    "codex_session_name": "排查 IM",
                },
            },
        )

        self.assertEqual(preview, "[Codex 会话] 排查 IM")
