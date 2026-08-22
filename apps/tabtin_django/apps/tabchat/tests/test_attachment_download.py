"""IM 附件下载 URL（TC-13）后端测试。

对真 PG 跑：USE_SQLITE_FOR_TESTS=0 python -m pytest <path> --reuse-db
"""

import os
import sys
from unittest.mock import MagicMock, patch


def _ensure_django():
    django_root = os.path.abspath(
        os.path.join(os.path.dirname(__file__), os.pardir, os.pardir, os.pardir)
    )
    if django_root not in sys.path:
        sys.path.insert(0, django_root)
    if "DJANGO_SETTINGS_MODULE" not in os.environ:
        os.environ["DJANGO_SETTINGS_MODULE"] = "tabtin.settings"
    import django
    from django.apps import apps
    if not apps.ready:
        django.setup()


_ensure_django()

from django.contrib.auth import get_user_model
from django.test import TestCase

from apps.tabchat.constants import MessageType
from apps.tabchat.models import Conversation, Message
from apps.tabchat.services.conversation_service import ConversationService
from apps.tabchat.services.message_service import MessageService
from apps.services.oss.models import FileRecord, FileUsage
from apps.tabtinspace.models import Organization, OrganizationMember
from apps.users.membership.models import MembershipTier

User = get_user_model()


def _ensure_free_tier() -> None:
    MembershipTier.objects.update_or_create(
        tier_type="free",
        defaults={
            "name": "免费版",
            "description": "attachment download tests bootstrap",
            "max_tables": -1,
            "max_records_per_table": -1,
            "max_api_calls_per_day": -1,
            "max_crawl_tasks_per_day": -1,
            "features": {},
            "sort_order": 0,
            "is_active": True,
        },
    )


class AttachmentDownloadUrlTests(TestCase):
    databases = ["default", "postgresql"]

    def setUp(self):
        _ensure_free_tier()
        self.user_a = User.objects.create_user(
            username="att_a", email="att_a@test.com", password="pass123", nickname="甲",
        )
        self.user_b = User.objects.create_user(
            username="att_b", email="att_b@test.com", password="pass123", nickname="乙",
        )
        self.organization = Organization.objects.create(name="Attachment Test", owner=self.user_a)
        OrganizationMember.objects.create(organization=self.organization, user=self.user_a, role="owner")
        OrganizationMember.objects.create(organization=self.organization, user=self.user_b, role="editor")
        self.conv = ConversationService.create_dm(
            organization_id=str(self.organization.id),
            creator_id=str(self.user_a.id),
            other_user_id=str(self.user_b.id),
        )
        self.file_record = FileRecord.objects.create(
            file_name="report.pdf",
            file_key="im/attachments/report.pdf",
            file_size=1024,
            mime_type="application/pdf",
            upload_user=str(self.user_a.id),
            organization_id=str(self.organization.id),
            status="completed",
            access_url="https://oss.example.com/stale/report.pdf",
        )

    def _create_file_message(self, sender, file_id: str) -> Message:
        return Message.objects.create(
            conversation=self.conv,
            seq=Message.objects.filter(conversation=self.conv).count() + 1,
            sender_id=str(sender.id),
            content="[文件] report.pdf",
            message_type=MessageType.FILE,
            metadata={
                "file_id": file_id,
                "file_name": "report.pdf",
                "file_size": 1024,
                "access_url": "https://oss.example.com/stale/report.pdf",
            },
            has_attachment=True,
        )

    def test_send_message_persists_only_attachment_identity_and_snapshot(self):
        msg = MessageService.send_message(
            conversation_id=str(self.conv.id),
            sender_id=str(self.user_a.id),
            content="[文件] report.pdf",
            message_type=MessageType.FILE,
            metadata={
                "file_id": str(self.file_record.id),
                "file_name": "report.pdf",
                "file_size": 1024,
                "access_url": "https://oss.example.com/stale/report.pdf?Signature=secret",
                "remote_url": "https://example.com/remote.pdf",
                "__client_local_path": "/tmp/report.pdf",
            },
        )

        self.assertEqual(msg.metadata["file_id"], str(self.file_record.id))
        self.assertNotIn("access_url", msg.metadata)
        self.assertNotIn("remote_url", msg.metadata)
        self.assertNotIn("__client_local_path", msg.metadata)

    def test_send_message_persists_codex_session_file_card_and_preview(self):
        msg = MessageService.send_message(
            conversation_id=str(self.conv.id),
            sender_id=str(self.user_a.id),
            content="[Codex 会话] 排查 IM",
            message_type=MessageType.FILE,
            metadata={
                "file_id": str(self.file_record.id),
                "file_name": "session.zip",
                "file_size": 1024,
                "file_type": "application/zip",
                "card": {
                    "type": "codex_session",
                    "schema_version": 1,
                    "codex_session_id": " session-1 ",
                    "codex_session_name": " 排查 IM ",
                    "suggested_working_directory": " /workspace/tabtin ",
                    "untrusted_extra": "drop-me",
                },
            },
        )

        self.assertEqual(
            msg.metadata["card"],
            {
                "type": "codex_session",
                "schema_version": 1,
                "codex_session_id": "session-1",
                "codex_session_name": "排查 IM",
                "suggested_working_directory": "/workspace/tabtin",
            },
        )
        self.assertTrue(
            FileUsage.objects.filter(
                file_record=self.file_record,
                module="tabchat",
                context_type="im_message",
                context_id=str(msg.id),
                is_active=True,
            ).exists()
        )
        self.conv.refresh_from_db()
        self.assertEqual(self.conv.last_message_preview, "[Codex 会话] 排查 IM")

    def test_forward_creates_independent_usage_without_revoking_source(self):
        source = MessageService.send_message(
            conversation_id=str(self.conv.id),
            sender_id=str(self.user_a.id),
            content="[文件] report.pdf",
            message_type=MessageType.FILE,
            metadata={
                "file_id": str(self.file_record.id),
                "file_name": "report.pdf",
                "file_size": 1024,
            },
        )
        forwarded = MessageService.send_message(
            conversation_id=str(self.conv.id),
            sender_id=str(self.user_b.id),
            content="[文件] report.pdf",
            message_type=MessageType.FILE,
            metadata={
                "file_id": str(self.file_record.id),
                "file_name": "report.pdf",
                "file_size": 1024,
                "forwarded_from": {
                    "original_message_id": source.id,
                    "original_conversation_id": str(self.conv.id),
                },
            },
        )

        for message in (source, forwarded):
            self.assertTrue(FileUsage.objects.filter(
                file_record=self.file_record,
                module="tabchat",
                context_type="im_message",
                context_id=str(message.id),
                is_active=True,
            ).exists())
        self.assertEqual(
            forwarded.metadata["forwarded_from"]["original_message_id"],
            source.id,
        )

    @patch("apps.services.oss.services.factory.get_oss_service")
    def test_member_can_get_fresh_download_url(self, mock_get_oss):
        mock_get_oss.return_value.generate_presigned_url.return_value = "https://oss.example.com/fresh/report.pdf"
        msg = self._create_file_message(self.user_a, str(self.file_record.id))
        FileUsage.add_usage(
            file_record=self.file_record,
            user_id=str(self.user_a.id),
            module="tabchat",
            context_type="im_message",
            context_id=str(msg.id),
        )

        data = MessageService.get_attachment_download_url(
            conversation_id=str(self.conv.id),
            message_id=msg.id,
            user_id=str(self.user_b.id),
        )
        self.assertEqual(data["download_url"], "https://oss.example.com/fresh/report.pdf")
        self.assertEqual(data["file_name"], "report.pdf")
        self.assertEqual(data["expires_in"], 3600)

    def test_non_member_denied(self):
        outsider = User.objects.create_user(
            username="att_out", email="att_out@test.com", password="pass123",
        )
        msg = self._create_file_message(self.user_a, str(self.file_record.id))
        with self.assertRaises(PermissionError):
            MessageService.get_attachment_download_url(
                conversation_id=str(self.conv.id),
                message_id=msg.id,
                user_id=str(outsider.id),
            )

    def test_inactive_file_usage_denied(self):
        msg = self._create_file_message(self.user_a, str(self.file_record.id))
        usage = FileUsage.add_usage(
            file_record=self.file_record,
            user_id=str(self.user_a.id),
            module="tabchat",
            context_type="im_message",
            context_id=str(msg.id),
        )
        usage.deactivate()

        with self.assertRaises(PermissionError):
            MessageService.get_attachment_download_url(
                conversation_id=str(self.conv.id),
                message_id=msg.id,
                user_id=str(self.user_b.id),
            )

    def test_cross_organization_file_id_is_denied_before_message_is_created(self):
        other_organization = Organization.objects.create(name="Other Attachment Test", owner=self.user_a)
        foreign_record = FileRecord.objects.create(
            file_name="foreign.pdf",
            file_key="im/attachments/foreign.pdf",
            file_size=1024,
            mime_type="application/pdf",
            upload_user=str(self.user_a.id),
            organization_id=str(other_organization.id),
            status="completed",
        )

        with self.assertRaisesRegex(ValueError, "不属于当前组织"):
            MessageService.send_message(
                conversation_id=str(self.conv.id),
                sender_id=str(self.user_a.id),
                content="[文件] foreign.pdf",
                message_type=MessageType.FILE,
                metadata={
                    "file_id": str(foreign_record.id),
                    "file_name": "foreign.pdf",
                    "file_size": 1024,
                },
            )
        self.assertFalse(Message.objects.filter(conversation=self.conv, content="[文件] foreign.pdf").exists())

    def _owned_by_a_shared_to_b_file(self):
        """owner=A 的云盘文件，给 B 显式 viewer ACL；B 非上传者且无 FileUsage。"""
        from apps.tabtinspace.models import ContextItem, FilePermission

        record = FileRecord.objects.create(
            file_name="shared-cloud.pdf",
            file_key="tabfiles/shared-cloud.pdf",
            file_size=2048,
            mime_type="application/pdf",
            upload_user=str(self.user_a.id),
            organization_id=str(self.organization.id),
            status="completed",
        )
        item = ContextItem.objects.create(
            organization_id=self.organization.id,
            item_type="tabfiles",
            title="shared-cloud.pdf",
            resource_id=str(record.id),
            status="active",
            created_by=self.user_a,
            updated_by=self.user_a,
        )
        FilePermission.objects.create(
            file_record_id=record.id,
            subject_type="user",
            subject_id=str(self.user_b.id),
            permission="viewer",
            is_active=True,
            granted_by=str(self.user_a.id),
            created_by=self.user_a,
        )
        return record, item

    def test_tabfiles_viewer_acl_can_reference_as_im_attachment(self):
        """#7986：对未回收 TabFiles 有 viewer+ 时，非上传者也可把 FileRecord 发成 IM 附件。"""
        record, _item = self._owned_by_a_shared_to_b_file()

        msg = MessageService.send_message(
            conversation_id=str(self.conv.id),
            sender_id=str(self.user_b.id),
            content="[文件] shared-cloud.pdf",
            message_type=MessageType.FILE,
            metadata={
                "file_id": str(record.id),
                "file_name": "shared-cloud.pdf",
                "file_size": 2048,
            },
        )
        self.assertEqual(msg.metadata["file_id"], str(record.id))
        self.assertTrue(FileUsage.objects.filter(
            file_record=record,
            module="tabchat",
            context_type="im_message",
            context_id=str(msg.id),
            is_active=True,
        ).exists())

    def test_trashed_tabfiles_context_item_cannot_be_referenced_via_acl(self):
        """回收站中的 TabFiles ContextItem 不再认可 ACL 引用路径。"""
        from django.utils import timezone

        record, item = self._owned_by_a_shared_to_b_file()
        item.trashed_at = timezone.now()
        item.status = "trashed"
        item.save(update_fields=["trashed_at", "status", "updated_at"])

        with self.assertRaises(PermissionError):
            MessageService.send_message(
                conversation_id=str(self.conv.id),
                sender_id=str(self.user_b.id),
                content="[文件] shared-cloud.pdf",
                message_type=MessageType.FILE,
                metadata={
                    "file_id": str(record.id),
                    "file_name": "shared-cloud.pdf",
                    "file_size": 2048,
                },
            )

    def test_file_permission_without_context_item_cannot_reference_attachment(self):
        """仅有 FilePermission、无未回收 ContextItem 时，不开放 IM 附件引用。"""
        from apps.tabtinspace.models import FilePermission

        record = FileRecord.objects.create(
            file_name="orphan-acl.pdf",
            file_key="tabfiles/orphan-acl.pdf",
            file_size=1024,
            mime_type="application/pdf",
            upload_user=str(self.user_a.id),
            organization_id=str(self.organization.id),
            status="completed",
        )
        FilePermission.objects.create(
            file_record_id=record.id,
            subject_type="user",
            subject_id=str(self.user_b.id),
            permission="viewer",
            is_active=True,
            granted_by=str(self.user_a.id),
            created_by=self.user_a,
        )

        with self.assertRaises(PermissionError):
            MessageService.send_message(
                conversation_id=str(self.conv.id),
                sender_id=str(self.user_b.id),
                content="[文件] orphan-acl.pdf",
                message_type=MessageType.FILE,
                metadata={
                    "file_id": str(record.id),
                    "file_name": "orphan-acl.pdf",
                    "file_size": 1024,
                },
            )

    def test_tabfiles_acl_on_foreign_org_context_item_is_ignored(self):
        """跨组织：即使外组织 ContextItem + FilePermission，也不能引用本会话附件。"""
        other_organization = Organization.objects.create(name="Foreign TabFiles Org", owner=self.user_a)
        OrganizationMember.objects.create(
            organization=other_organization, user=self.user_a, role="owner",
        )
        OrganizationMember.objects.create(
            organization=other_organization, user=self.user_b, role="editor",
        )
        from apps.tabtinspace.models import ContextItem, FilePermission

        foreign_record = FileRecord.objects.create(
            file_name="foreign-cloud.pdf",
            file_key="tabfiles/foreign-cloud.pdf",
            file_size=1024,
            mime_type="application/pdf",
            upload_user=str(self.user_a.id),
            organization_id=str(other_organization.id),
            status="completed",
        )
        ContextItem.objects.create(
            organization_id=other_organization.id,
            item_type="tabfiles",
            title="foreign-cloud.pdf",
            resource_id=str(foreign_record.id),
            status="active",
            created_by=self.user_a,
            updated_by=self.user_a,
        )
        FilePermission.objects.create(
            file_record_id=foreign_record.id,
            subject_type="user",
            subject_id=str(self.user_b.id),
            permission="viewer",
            is_active=True,
            granted_by=str(self.user_a.id),
            created_by=self.user_a,
        )

        with self.assertRaisesRegex(ValueError, "不属于当前组织"):
            MessageService.send_message(
                conversation_id=str(self.conv.id),
                sender_id=str(self.user_b.id),
                content="[文件] foreign-cloud.pdf",
                message_type=MessageType.FILE,
                metadata={
                    "file_id": str(foreign_record.id),
                    "file_name": "foreign-cloud.pdf",
                    "file_size": 1024,
                },
            )
