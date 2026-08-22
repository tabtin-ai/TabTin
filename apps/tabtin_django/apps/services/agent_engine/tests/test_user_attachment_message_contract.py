from unittest.mock import MagicMock, patch
from contextlib import nullcontext

from django.test import SimpleTestCase

# Import before the narrow transaction patch below; the handlers package uses
# ``transaction.atomic`` as a decorator during module initialization.
from apps.services.common.ws.handlers.content_block_reassembler import derive_text_summary  # noqa: F401
from apps.services.agent_engine.services.persistence_pipeline import persist_user_messages
from apps.services.agent_engine.services.user_attachment_contract import (
    canonical_user_blocks,
    merge_user_text_into_blocks,
    merge_attachment_blocks,
)


def test_attachment_message_persists_visible_text_block():
    blocks = [{"type": "image", "file_id": "file-1", "url": "https://files/image.png"}]

    assert merge_user_text_into_blocks("请看这张图", blocks) == [
        {"type": "text", "text": "请看这张图"},
        blocks[0],
    ]


def test_image_block_is_forwarded_as_runtime_attachment():
    image = {
        "type": "image",
        "file_id": "file-1",
        "filename": "image.png",
        "mime_type": "image/png",
        "url": "https://files/image.png",
    }

    assert merge_attachment_blocks(None, [image]) == [image]


def test_explicit_attachments_win_without_duplicates():
    image = {"type": "image", "file_id": "file-1", "url": "https://files/image.png"}

    assert merge_attachment_blocks([image], [image]) == [image]


def test_attachments_only_are_canonical_message_blocks():
    image = {"type": "image", "file_id": "file-1", "url": "https://files/image.png"}

    assert canonical_user_blocks("", None, [image]) == [image]


def test_text_and_image_are_canonical_message_blocks_once():
    image = {"type": "image", "file_id": "file-1", "url": "https://files/image.png"}

    assert canonical_user_blocks("描述图片", [image], [image]) == [
        {"type": "text", "text": "描述图片"},
        image,
    ]


class PersistUserAttachmentContractTests(SimpleTestCase):
    def _persisted_blocks(self, *, text="", blocks=None, attachments=None):
        created = MagicMock()
        session = MagicMock(id="11111111-1111-4111-8111-111111111111")
        model = MagicMock(id="22222222-2222-4222-8222-222222222222")
        with (
            patch("apps.chat.conversation.models.ChatMessage.objects.create", return_value=created) as create,
            patch("django.db.transaction.atomic", side_effect=nullcontext),
        ):
            persist_user_messages(session, [text], None, model, blocks, attachments)
        persisted = create.call_args.kwargs["content_blocks_json"]
        return [
            {key: value for key, value in block.items() if key not in {"arrival_seq", "arrived_at"}}
            for block in persisted
        ]

    def test_attachments_only_are_persisted_as_canonical_blocks(self):
        image = {"type": "image", "file_id": "file-1", "url": "https://files/image.png"}

        self.assertEqual(self._persisted_blocks(attachments=[image]), [image])

    def test_text_and_image_are_persisted_once(self):
        image = {"type": "image", "file_id": "file-1", "url": "https://files/image.png"}

        self.assertEqual(
            self._persisted_blocks(text="描述图片", blocks=[image], attachments=[image]),
            [{"type": "text", "text": "描述图片"}, image],
        )
