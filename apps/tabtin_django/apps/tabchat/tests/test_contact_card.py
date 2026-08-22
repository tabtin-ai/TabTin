"""个人名片卡（metadata.card.type=contact）后端校验测试。

覆盖：合法名片以 DB 真实身份回填（防伪造）、非本团队成员被拒、
缺字段/用户不存在报错、会话 preview 为 [名片] name。
对真 PG 跑：USE_SQLITE_FOR_TESTS=0 python -m pytest <path> --reuse-db
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
from apps.tabchat.services.conversation_service import ConversationService
from apps.tabchat.services.message_service import MessageService
from apps.tabtinspace.models import Organization, OrganizationMember
from apps.users.membership.models import MembershipTier

User = get_user_model()


def _ensure_free_tier() -> None:
    MembershipTier.objects.update_or_create(
        tier_type='free',
        defaults={
            'name': '免费版',
            'description': 'contact card tests bootstrap',
            'max_tables': -1,
            'max_records_per_table': -1,
            'max_api_calls_per_day': -1,
            'max_crawl_tasks_per_day': -1,
            'features': {},
            'sort_order': 0,
            'is_active': True,
        },
    )


class ContactCardValidationTests(TestCase):
    databases = ['default', 'postgresql']

    def setUp(self):
        _ensure_free_tier()
        self.user_a = User.objects.create_user(
            username='cc_a', email='cc_a@test.com', password='pass123', nickname='阿强',
        )
        self.user_b = User.objects.create_user(
            username='cc_b', email='cc_b@test.com', password='pass123', nickname='小美',
        )
        # 不属于该 organization 的外部用户
        self.user_c = User.objects.create_user(
            username='cc_c', email='cc_c@test.com', password='pass123', nickname='外人',
        )
        self.organization = Organization.objects.create(name='Contact Test', owner=self.user_a)
        OrganizationMember.objects.create(organization=self.organization, user=self.user_a, role='owner')
        OrganizationMember.objects.create(organization=self.organization, user=self.user_b, role='editor')
        self.conv = ConversationService.create_dm(
            organization_id=str(self.organization.id),
            creator_id=str(self.user_a.id),
            other_user_id=str(self.user_b.id),
        )

    def _send_contact(self, sender, target_user_id, fake_name='伪造的名字'):
        return MessageService.send_message(
            conversation_id=str(self.conv.id),
            sender_id=str(sender.id),
            content=f'[名片] {fake_name}',
            message_type=MessageType.TEXT,
            metadata={"card": {"type": "contact", "user_id": str(target_user_id), "name": fake_name}},
        )

    def test_valid_contact_card_backfills_real_identity(self):
        msg = self._send_contact(self.user_a, self.user_b.id, fake_name='伪造的名字')
        msg.refresh_from_db()
        card = msg.metadata.get("card")
        self.assertEqual(card["type"], "contact")
        self.assertEqual(card["user_id"], str(self.user_b.id))
        # 后端以 DB 真实昵称回填，覆盖客户端伪造值
        self.assertEqual(card["name"], '小美')
        self.assertEqual(card["username"], 'cc_b')

    def test_contact_card_for_non_member_rejected(self):
        with self.assertRaises(PermissionError):
            self._send_contact(self.user_a, self.user_c.id)

    def test_contact_card_missing_user_id_rejected(self):
        with self.assertRaises(ValueError):
            MessageService.send_message(
                conversation_id=str(self.conv.id),
                sender_id=str(self.user_a.id),
                content='[名片]',
                message_type=MessageType.TEXT,
                metadata={"card": {"type": "contact"}},
            )

    def test_contact_card_nonexistent_user_rejected(self):
        bogus = '00000000-0000-0000-0000-0000000000ff'
        with self.assertRaises(ValueError):
            self._send_contact(self.user_a, bogus)

    def test_contact_card_invalid_uuid_rejected(self):
        with self.assertRaises(ValueError):
            self._send_contact(self.user_a, 'not-a-uuid')

    def test_contact_card_updates_conversation_preview(self):
        self._send_contact(self.user_a, self.user_b.id)
        self.conv.refresh_from_db()
        self.assertEqual(self.conv.last_message_preview, '[名片] 小美')
