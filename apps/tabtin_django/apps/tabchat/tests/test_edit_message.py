"""消息编辑（功能4）后端测试。

对真 PG 跑：USE_SQLITE_FOR_TESTS=0 python -m pytest <path> -p no:cacheprovider
"""

import os
import sys


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
from apps.tabchat.models import Message
from apps.tabchat.services.conversation_service import ConversationService
from apps.tabchat.services.message_service import MessageService
from apps.tabtinspace.models import Organization, OrganizationMember
from apps.users.membership.models import MembershipTier

User = get_user_model()


def _ensure_free_tier() -> None:
    MembershipTier.objects.update_or_create(
        tier_type="free",
        defaults={
            "name": "免费版",
            "description": "edit message tests bootstrap",
            "max_tables": -1,
            "max_records_per_table": -1,
            "max_api_calls_per_day": -1,
            "max_crawl_tasks_per_day": -1,
            "features": {},
            "sort_order": 0,
            "is_active": True,
        },
    )


class EditMessageTests(TestCase):
    databases = ["default", "postgresql"]

    def setUp(self):
        _ensure_free_tier()
        self.user_a = User.objects.create_user(
            username="ed_a", email="ed_a@test.com", password="pass123", nickname="甲",
        )
        self.user_b = User.objects.create_user(
            username="ed_b", email="ed_b@test.com", password="pass123", nickname="乙",
        )
        self.organization = Organization.objects.create(name="Edit Test", owner=self.user_a)
        OrganizationMember.objects.create(organization=self.organization, user=self.user_a, role="owner")
        OrganizationMember.objects.create(organization=self.organization, user=self.user_b, role="editor")
        self.conv = ConversationService.create_dm(
            organization_id=str(self.organization.id),
            creator_id=str(self.user_a.id),
            other_user_id=str(self.user_b.id),
        )

    def test_edit_own_text_sets_edited_at_and_content(self):
        msg = MessageService.send_message(str(self.conv.id), str(self.user_a.id), "原文")
        self.assertIsNone(msg.edited_at)
        data = MessageService.edit_message(str(self.conv.id), msg.id, str(self.user_a.id), "改后的文字")
        self.assertEqual(data["content"], "改后的文字")
        self.assertIsNotNone(data["edited_at"])
        msg.refresh_from_db()
        self.assertEqual(msg.content, "改后的文字")
        self.assertIsNotNone(msg.edited_at)

    def test_cannot_edit_others_message(self):
        msg = MessageService.send_message(str(self.conv.id), str(self.user_a.id), "甲的消息")
        with self.assertRaises(PermissionError):
            MessageService.edit_message(str(self.conv.id), msg.id, str(self.user_b.id), "乙想改")

    def test_cannot_edit_deleted(self):
        msg = MessageService.send_message(str(self.conv.id), str(self.user_a.id), "to delete")
        MessageService.delete_message(str(self.conv.id), msg.id, str(self.user_a.id))
        with self.assertRaises(ValueError):
            MessageService.edit_message(str(self.conv.id), msg.id, str(self.user_a.id), "改")

    def test_cannot_edit_empty(self):
        msg = MessageService.send_message(str(self.conv.id), str(self.user_a.id), "x")
        with self.assertRaises(ValueError):
            MessageService.edit_message(str(self.conv.id), msg.id, str(self.user_a.id), "   ")

    def test_cannot_edit_non_text(self):
        # 系统消息无法编辑
        sysmsg = Message.objects.create(
            conversation=self.conv,
            seq=Message.objects.filter(conversation=self.conv).count() + 1,
            sender_id=str(self.user_a.id), content="sys",
            message_type=MessageType.SYSTEM,
        )
        with self.assertRaises((ValueError, PermissionError)):
            MessageService.edit_message(str(self.conv.id), sysmsg.id, str(self.user_a.id), "改")

    def test_edit_latest_updates_preview(self):
        MessageService.send_message(str(self.conv.id), str(self.user_a.id), "first")
        latest = MessageService.send_message(str(self.conv.id), str(self.user_a.id), "second")
        MessageService.edit_message(str(self.conv.id), latest.id, str(self.user_a.id), "second-edited")
        self.conv.refresh_from_db()
        self.assertIn("second-edited", self.conv.last_message_preview)

    def test_edit_revalidates_mentions(self):
        msg = MessageService.send_message(str(self.conv.id), str(self.user_a.id), "@乙 hi")
        # 编辑时带一个伪造的 mention（非成员）应被过滤
        data = MessageService.edit_message(
            str(self.conv.id), msg.id, str(self.user_a.id), "@乙 hello again",
            metadata={"mentioned_user_ids": [str(self.user_b.id), "fake-user-id"]},
        )
        msg.refresh_from_db()
        self.assertEqual(msg.metadata.get("mentioned_user_ids"), [str(self.user_b.id)])
        self.assertEqual(data["content"], "@乙 hello again")
