import hashlib

from django.contrib.auth import get_user_model
from django.test import SimpleTestCase, TestCase

from apps.chat.conversation.signals import _extract_file_ids_from_blocks


class ConversationFileUsageExtractionTest(SimpleTestCase):
    def test_extracts_formal_oss_image_file_identity(self):
        blocks = [{
            "type": "tabtin_rich_content",
            "kind": "image",
            "payload": {
                "artifact_kind": "oss_file",
                "file_id": "file-image-1",
                "access_url": "https://oss.example/image.png",
                "url": "tabtin://resource/file/file-image-1?hint=tabfiles",
            },
        }]

        self.assertEqual(_extract_file_ids_from_blocks(blocks), ["file-image-1"])

    def test_keeps_legacy_rich_file_support(self):
        blocks = [{
            "type": "tabtin_rich_content",
            "kind": "file",
            "payload": {"file_id": "file-legacy-1"},
        }]

        self.assertEqual(_extract_file_ids_from_blocks(blocks), ["file-legacy-1"])

    def test_does_not_register_arbitrary_image_url(self):
        blocks = [{
            "type": "tabtin_rich_content",
            "kind": "image",
            "payload": {
                "file_id": "unmanaged-id",
                "url": "https://provider.example/temporary.png",
            },
        }]

        self.assertEqual(_extract_file_ids_from_blocks(blocks), [])


class ConversationFileUsageLifecycleTest(TestCase):
    def setUp(self):
        from apps.chat.conversation.models import ChatSession
        from apps.services.oss.models import FileRecord

        self.user = get_user_model().objects.create_user(
            email="media-file-usage-owner@example.com",
            password="x",
        )
        self.session = ChatSession.objects.create(
            user=self.user,
            organization_id="org-media-file-usage",
            title="generated image",
        )
        file_key = "media-gen/text2image/task-1_0.png"
        self.file_record = FileRecord.objects.create(
            file_name="image.png",
            file_key=file_key,
            file_key_hash=hashlib.sha256(file_key.encode()).hexdigest(),
            file_path=file_key,
            file_size=1024,
            file_type="image",
            mime_type="image/png",
            file_extension=".png",
            file_hash="hash",
            bucket_name="test-bucket",
            access_url="https://oss.example/image.png",
            upload_user=str(self.user.id),
            organization_id="org-media-file-usage",
            status="completed",
        )

    def _block(self):
        return [{
            "type": "tabtin_rich_content",
            "kind": "image",
            "payload": {
                "artifact_kind": "oss_file",
                "file_id": str(self.file_record.id),
                "access_url": self.file_record.access_url,
            },
        }]

    def test_same_file_can_remain_active_in_multiple_messages(self):
        from apps.chat.conversation.models import ChatMessage
        from apps.services.oss.models import FileUsage

        first = ChatMessage.objects.create(
            session=self.session,
            role="assistant",
            message_kind="tool_artifact",
            content_blocks_json=self._block(),
        )
        second = ChatMessage.objects.create(
            session=self.session,
            role="assistant",
            message_kind="tool_artifact",
            content_blocks_json=self._block(),
        )

        active_ids = set(FileUsage.objects.filter(
            file_record=self.file_record,
            module="chat",
            context_type="message",
            is_active=True,
        ).values_list("context_id", flat=True))
        self.assertEqual(active_ids, {str(first.id), str(second.id)})
