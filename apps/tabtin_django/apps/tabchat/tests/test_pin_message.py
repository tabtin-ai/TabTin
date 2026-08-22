"""消息置顶（功能3）后端测试。

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

from apps.tabchat.constants import MemberRole, MessageType
from apps.tabchat.models import ConversationMember, Message
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
            "description": "pin message tests bootstrap",
            "max_tables": -1,
            "max_records_per_table": -1,
            "max_api_calls_per_day": -1,
            "max_crawl_tasks_per_day": -1,
            "features": {},
            "sort_order": 0,
            "is_active": True,
        },
    )


class PinMessageGroupTests(TestCase):
    databases = ["default", "postgresql"]

    def setUp(self):
        _ensure_free_tier()
        self.owner = User.objects.create_user(
            username="pin_owner", email="pin_owner@test.com", password="pass123", nickname="群主",
        )
        self.admin = User.objects.create_user(
            username="pin_admin", email="pin_admin@test.com", password="pass123", nickname="管理",
        )
        self.member = User.objects.create_user(
            username="pin_member", email="pin_member@test.com", password="pass123", nickname="成员",
        )
        self.organization = Organization.objects.create(name="Pin Test", owner=self.owner)
        for u, role in [(self.owner, "owner"), (self.admin, "admin"), (self.member, "editor")]:
            OrganizationMember.objects.create(organization=self.organization, user=u, role=role)
        self.conv = ConversationService.create_group(
            organization_id=str(self.organization.id),
            creator_id=str(self.owner.id),
            name="Pin Group",
            member_ids=[str(self.admin.id), str(self.member.id)],
        )
        ConversationMember.objects.filter(
            conversation=self.conv, user_id=str(self.admin.id)
        ).update(role=MemberRole.ADMIN)
        self.msg = MessageService.send_message(
            str(self.conv.id), str(self.member.id), "重要通知",
        )

    def test_admin_can_pin_and_list(self):
        data = MessageService.pin_message(str(self.conv.id), self.msg.id, str(self.admin.id))
        self.assertTrue(data["is_pinned"])
        self.assertEqual(data["id"], self.msg.id)
        pinned = MessageService.list_pinned_messages(str(self.conv.id), str(self.member.id))
        self.assertEqual(len(pinned), 1)
        self.assertEqual(pinned[0]["content"], "重要通知")
        self.assertEqual(pinned[0]["sender_name"], "成员")

    def test_regular_member_cannot_pin(self):
        with self.assertRaises(PermissionError):
            MessageService.pin_message(str(self.conv.id), self.msg.id, str(self.member.id))

    def test_unpin_removes_from_list(self):
        MessageService.pin_message(str(self.conv.id), self.msg.id, str(self.owner.id))
        MessageService.unpin_message(str(self.conv.id), self.msg.id, str(self.admin.id))
        pinned = MessageService.list_pinned_messages(str(self.conv.id), str(self.owner.id))
        self.assertEqual(len(pinned), 0)

    def test_recall_auto_unpins(self):
        own = MessageService.send_message(str(self.conv.id), str(self.admin.id), "我发的")
        MessageService.pin_message(str(self.conv.id), own.id, str(self.admin.id))
        MessageService.delete_message(str(self.conv.id), own.id, str(self.admin.id))
        own.refresh_from_db()
        self.assertFalse(own.is_pinned)
        pinned = MessageService.list_pinned_messages(str(self.conv.id), str(self.admin.id))
        self.assertEqual(len(pinned), 0)

    def test_cannot_pin_deleted_or_system(self):
        own = MessageService.send_message(str(self.conv.id), str(self.admin.id), "to delete")
        MessageService.delete_message(str(self.conv.id), own.id, str(self.admin.id))
        with self.assertRaises(ValueError):
            MessageService.pin_message(str(self.conv.id), own.id, str(self.admin.id))
        sysmsg = Message.objects.create(
            conversation=self.conv,
            seq=Message.objects.filter(conversation=self.conv).count() + 1,
            sender_id="system", content="x",
            message_type=MessageType.SYSTEM,
        )
        with self.assertRaises(ValueError):
            MessageService.pin_message(str(self.conv.id), sysmsg.id, str(self.admin.id))

    def test_non_member_cannot_list(self):
        outsider = User.objects.create_user(
            username="pin_out", email="pin_out@test.com", password="pass123",
        )
        with self.assertRaises(PermissionError):
            MessageService.list_pinned_messages(str(self.conv.id), str(outsider.id))


class PinMessageDMTests(TestCase):
    databases = ["default", "postgresql"]

    def setUp(self):
        _ensure_free_tier()
        self.user_a = User.objects.create_user(
            username="pdm_a", email="pdm_a@test.com", password="pass123", nickname="甲",
        )
        self.user_b = User.objects.create_user(
            username="pdm_b", email="pdm_b@test.com", password="pass123", nickname="乙",
        )
        self.organization = Organization.objects.create(name="Pin DM Test", owner=self.user_a)
        OrganizationMember.objects.create(organization=self.organization, user=self.user_a, role="owner")
        OrganizationMember.objects.create(organization=self.organization, user=self.user_b, role="editor")
        self.conv = ConversationService.create_dm(
            organization_id=str(self.organization.id),
            creator_id=str(self.user_a.id),
            other_user_id=str(self.user_b.id),
        )

    def test_dm_any_member_can_pin(self):
        msg = MessageService.send_message(str(self.conv.id), str(self.user_a.id), "私聊置顶")
        # 私聊里非管理员的对方也能置顶
        data = MessageService.pin_message(str(self.conv.id), msg.id, str(self.user_b.id))
        self.assertTrue(data["is_pinned"])
        pinned = MessageService.list_pinned_messages(str(self.conv.id), str(self.user_a.id))
        self.assertEqual(len(pinned), 1)
