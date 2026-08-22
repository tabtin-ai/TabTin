"""会话管理（清空聊天记录 / 退出群聊）后端测试。

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

from apps.tabchat.constants import ConversationType, MemberRole, MessageType
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
            "description": "conversation manage tests bootstrap",
            "max_tables": -1,
            "max_records_per_table": -1,
            "max_api_calls_per_day": -1,
            "max_crawl_tasks_per_day": -1,
            "features": {},
            "sort_order": 0,
            "is_active": True,
        },
    )


class ClearHistoryTests(TestCase):
    databases = ["default", "postgresql"]

    def setUp(self):
        _ensure_free_tier()
        self.user_a = User.objects.create_user(
            username="ch_a", email="ch_a@test.com", password="pass123", nickname="甲",
        )
        self.user_b = User.objects.create_user(
            username="ch_b", email="ch_b@test.com", password="pass123", nickname="乙",
        )
        self.organization = Organization.objects.create(name="Clear History Test", owner=self.user_a)
        OrganizationMember.objects.create(organization=self.organization, user=self.user_a, role="owner")
        OrganizationMember.objects.create(organization=self.organization, user=self.user_b, role="editor")
        self.conv = ConversationService.create_dm(
            organization_id=str(self.organization.id),
            creator_id=str(self.user_a.id),
            other_user_id=str(self.user_b.id),
        )

    def test_clear_history_only_affects_self(self):
        # A、B 各发一条
        MessageService.send_message(str(self.conv.id), str(self.user_a.id), "hello from A")
        MessageService.send_message(str(self.conv.id), str(self.user_b.id), "hello from B")

        # 清空前两人都能看到 2 条
        self.assertEqual(
            len(MessageService.get_messages(str(self.conv.id), str(self.user_a.id))), 2
        )
        self.assertEqual(
            len(MessageService.get_messages(str(self.conv.id), str(self.user_b.id))), 2
        )

        # A 清空自己侧
        cleared_seq = ConversationService.clear_history(str(self.conv.id), str(self.user_a.id))
        self.conv.refresh_from_db()
        self.assertEqual(cleared_seq, self.conv.latest_message_seq)
        self.assertEqual(
            ConversationService.get_history_cleared_seq(str(self.conv.id), str(self.user_a.id)),
            cleared_seq,
        )

        # A 看不到旧消息，B 仍看到全部
        self.assertEqual(
            len(MessageService.get_messages(str(self.conv.id), str(self.user_a.id))), 0
        )
        self.assertEqual(
            len(MessageService.get_messages(str(self.conv.id), str(self.user_b.id))), 2
        )

        # 清空后的新消息，A 仍能看到
        MessageService.send_message(str(self.conv.id), str(self.user_b.id), "after clear")
        a_msgs = MessageService.get_messages(str(self.conv.id), str(self.user_a.id))
        self.assertEqual(len(a_msgs), 1)
        self.assertEqual(a_msgs[0]["content"], "after clear")

    def test_clear_history_non_member_denied(self):
        outsider = User.objects.create_user(
            username="ch_out", email="ch_out@test.com", password="pass123",
        )
        with self.assertRaises(PermissionError):
            ConversationService.clear_history(str(self.conv.id), str(outsider.id))


class LeaveConversationTests(TestCase):
    databases = ["default", "postgresql"]

    def setUp(self):
        _ensure_free_tier()
        self.owner = User.objects.create_user(
            username="lv_owner", email="lv_owner@test.com", password="pass123", nickname="群主",
        )
        self.admin = User.objects.create_user(
            username="lv_admin", email="lv_admin@test.com", password="pass123", nickname="管理",
        )
        self.member = User.objects.create_user(
            username="lv_member", email="lv_member@test.com", password="pass123", nickname="成员",
        )
        self.organization = Organization.objects.create(name="Leave Test", owner=self.owner)
        for u, role in [(self.owner, "owner"), (self.admin, "admin"), (self.member, "editor")]:
            OrganizationMember.objects.create(organization=self.organization, user=u, role=role)
        self.conv = ConversationService.create_group(
            organization_id=str(self.organization.id),
            creator_id=str(self.owner.id),
            name="Leave Group",
            member_ids=[str(self.admin.id), str(self.member.id)],
        )
        # 提升 admin 成员角色
        ConversationMember.objects.filter(
            conversation=self.conv, user_id=str(self.admin.id)
        ).update(role=MemberRole.ADMIN)

    def test_member_leave(self):
        ok = ConversationService.leave_conversation(str(self.conv.id), str(self.member.id))
        self.assertTrue(ok)
        self.assertFalse(
            ConversationMember.objects.filter(
                conversation=self.conv, user_id=str(self.member.id)
            ).exists()
        )
        self.conv.refresh_from_db()
        self.assertEqual(self.conv.member_count, 2)

    def test_owner_leave_transfers_to_highest_earliest(self):
        ok = ConversationService.leave_conversation(str(self.conv.id), str(self.owner.id))
        self.assertTrue(ok)
        # 群主转给 admin（角色最高）
        successor = ConversationMember.objects.get(
            conversation=self.conv, user_id=str(self.admin.id)
        )
        self.assertEqual(successor.role, MemberRole.OWNER)
        self.assertFalse(
            ConversationMember.objects.filter(
                conversation=self.conv, user_id=str(self.owner.id)
            ).exists()
        )

    def test_owner_self_remove_member_also_transfers(self):
        ok = ConversationService.remove_member(
            conversation_id=str(self.conv.id),
            operator_id=str(self.owner.id),
            target_user_id=str(self.owner.id),
        )
        self.assertTrue(ok)
        successor = ConversationMember.objects.get(
            conversation=self.conv, user_id=str(self.admin.id)
        )
        self.assertEqual(successor.role, MemberRole.OWNER)
        self.assertFalse(
            ConversationMember.objects.filter(
                conversation=self.conv, user_id=str(self.owner.id)
            ).exists()
        )
        message = Message.objects.get(conversation=self.conv)
        self.assertEqual(message.content, "群主 已退出群聊")

    def test_regular_member_cannot_rename_but_can_add_group_members(self):
        candidate = User.objects.create_user(
            username="lv_candidate", email="lv_candidate@test.com", password="pass123",
        )
        OrganizationMember.objects.create(
            organization=self.organization, user=candidate, role="editor",
        )

        with self.assertRaises(PermissionError):
            ConversationService.update_conversation(
                str(self.conv.id), str(self.member.id), name="不应改名",
            )

        added = ConversationService.add_members(
            str(self.conv.id), str(self.member.id), [str(candidate.id)],
        )
        self.assertEqual(added, [str(candidate.id)])

        self.conv.refresh_from_db()
        self.assertEqual(self.conv.name, "Leave Group")
        self.assertTrue(
            ConversationMember.objects.filter(
                conversation=self.conv, user_id=str(candidate.id),
            ).exists()
        )

    def test_rename_group_sends_system_message_with_actor_and_new_name(self):
        updated = ConversationService.update_conversation(
            str(self.conv.id), str(self.admin.id), name="设计讨论群",
        )

        self.assertIsNotNone(updated)
        message = Message.objects.get(conversation=self.conv)
        self.assertEqual(message.message_type, MessageType.SYSTEM)
        self.assertEqual(message.sender_type, "system")
        self.assertFalse(message.counts_as_unread)
        self.assertEqual(message.content, "管理将群名修改为设计讨论群")

        self.conv.refresh_from_db()
        self.assertEqual(self.conv.name, "设计讨论群")
        self.assertEqual(self.conv.latest_message_id, message.id)
        self.assertEqual(self.conv.last_message_preview, "管理将群名修改为设计讨论群")

    def test_non_rename_update_does_not_send_group_name_system_message(self):
        ConversationService.update_conversation(
            str(self.conv.id), str(self.owner.id), avatar_url="https://example.com/group.png",
        )
        ConversationService.update_conversation(
            str(self.conv.id), str(self.owner.id), name="Leave Group",
        )

        self.assertFalse(Message.objects.filter(conversation=self.conv).exists())

    def test_dm_cannot_leave(self):
        peer = User.objects.create_user(
            username="lv_peer", email="lv_peer@test.com", password="pass123",
        )
        OrganizationMember.objects.create(organization=self.organization, user=peer, role="editor")
        dm = ConversationService.create_dm(
            organization_id=str(self.organization.id),
            creator_id=str(self.owner.id),
            other_user_id=str(peer.id),
        )
        with self.assertRaises(ValueError):
            ConversationService.leave_conversation(str(dm.id), str(self.owner.id))
