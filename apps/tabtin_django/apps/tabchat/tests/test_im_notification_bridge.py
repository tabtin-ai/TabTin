"""IM 与铃铛分流回归：消息未读只挂「消息」入口，不再写入通知中心。

覆盖：
- 私信 / 群聊 @ 均不创建 im.message 铃铛卡；
- 读会话仍可清理历史遗留的 im.message 卡；
- dedup key 与历史 recipients 口径保持稳定（供回滚参考）。
"""
import os
import sys
from unittest.mock import patch


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

from apps.services.common.db_router import postgres_app_db_alias
from apps.services.notification.models import Notification
from apps.tabchat.constants import ConversationType, MessageType
from apps.tabchat.services.conversation_service import ConversationService
from apps.tabchat.services.im_notification_bridge import (
    IM_MESSAGE_NOTIFICATION_TYPE,
    compute_bell_recipients,
    im_conversation_dedup_key,
)
from apps.tabchat.services.message_service import MessageService
from apps.tabtinspace.models import Organization, OrganizationMember
from apps.users.membership.models import MembershipTier

User = get_user_model()


def _ensure_free_tier() -> None:
    MembershipTier.objects.update_or_create(
        tier_type='free',
        defaults={
            'name': '免费版', 'description': 'im bridge tests', 'max_tables': -1,
            'max_records_per_table': -1, 'max_api_calls_per_day': -1,
            'max_crawl_tasks_per_day': -1, 'features': {}, 'sort_order': 0,
            'is_active': True,
        },
    )


class IMNotificationBridgeTests(TestCase):
    databases = ['default', 'postgresql']

    def setUp(self):
        _ensure_free_tier()
        self.user_a = User.objects.create_user(
            username='imb_a', email='imb_a@test.com', password='p'
        )
        self.user_b = User.objects.create_user(
            username='imb_b', email='imb_b@test.com', password='p'
        )
        self.user_c = User.objects.create_user(
            username='imb_c', email='imb_c@test.com', password='p'
        )
        self.org = Organization.objects.create(name='IMB Org', owner=self.user_a)
        for user, role in (
            (self.user_a, 'owner'),
            (self.user_b, 'editor'),
            (self.user_c, 'editor'),
        ):
            OrganizationMember.objects.create(
                organization=self.org, user=user, role=role
            )

    def _send(self, conv_id, sender, content, *, message_type=MessageType.TEXT, metadata=None):
        with self.captureOnCommitCallbacks(
            using=postgres_app_db_alias(), execute=True
        ):
            return MessageService.send_message(
                conversation_id=str(conv_id),
                sender_id=str(sender.id),
                content=content,
                message_type=message_type,
                metadata=metadata,
            )

    def _im_notifs(self, user):
        return Notification.objects.filter(
            user_id=str(user.id),
            type=IM_MESSAGE_NOTIFICATION_TYPE,
        )

    def test_dm_message_does_not_create_bell_notification(self):
        conv = ConversationService.create_dm(
            str(self.org.id), str(self.user_a.id), str(self.user_b.id)
        )
        self._send(conv.id, self.user_a, '在吗？')

        self.assertEqual(self._im_notifs(self.user_b).count(), 0)
        self.assertEqual(self._im_notifs(self.user_a).count(), 0)

    def test_group_mention_does_not_create_bell_notification(self):
        conv = ConversationService.create_group(
            organization_id=str(self.org.id),
            creator_id=str(self.user_a.id),
            name='项目群',
            member_ids=[str(self.user_b.id), str(self.user_c.id)],
        )
        self._send(
            conv.id,
            self.user_a,
            '@b 看下这个',
            metadata={'mentioned_user_ids': [str(self.user_b.id)]},
        )

        self.assertEqual(self._im_notifs(self.user_b).count(), 0)
        self.assertEqual(self._im_notifs(self.user_c).count(), 0)

    def test_group_plain_message_does_not_notify_bell(self):
        conv = ConversationService.create_group(
            organization_id=str(self.org.id),
            creator_id=str(self.user_a.id),
            name='项目群',
            member_ids=[str(self.user_b.id), str(self.user_c.id)],
        )
        self._send(conv.id, self.user_a, '大家好')

        self.assertEqual(self._im_notifs(self.user_b).count(), 0)
        self.assertEqual(self._im_notifs(self.user_c).count(), 0)

    @patch("apps.tabchat.services.message_service._safe_enqueue_im_message_push")
    def test_django_message_commit_enqueues_mobile_push(self, mock_push):
        conv = ConversationService.create_group(
            organization_id=str(self.org.id),
            creator_id=str(self.user_a.id),
            name='项目群',
            member_ids=[str(self.user_b.id), str(self.user_c.id)],
        )
        self._send(
            conv.id,
            self.user_a,
            '@b 看下这个',
            metadata={'mentioned_user_ids': [str(self.user_b.id)]},
        )

        mock_push.assert_called_once()
        payload = mock_push.call_args.args[0]
        self.assertEqual(payload['conversation_id'], str(conv.id))
        recipients = {item['user_id']: item for item in payload['recipients']}
        self.assertTrue(recipients[str(self.user_b.id)]['mention'])
        self.assertFalse(recipients[str(self.user_c.id)]['mention'])
        self.assertEqual(
            recipients[str(self.user_b.id)]['organization_id'],
            str(self.org.id),
        )

    def test_mark_as_read_clears_legacy_conversation_notification(self):
        conv = ConversationService.create_dm(
            str(self.org.id), str(self.user_a.id), str(self.user_b.id)
        )
        legacy = Notification.objects.create(
            user_id=str(self.user_b.id),
            type=IM_MESSAGE_NOTIFICATION_TYPE,
            title='遗留卡',
            body='旧消息',
            organization_id=str(self.org.id),
            source_event_id=im_conversation_dedup_key(str(conv.id)),
            is_read=False,
            metadata={'conversation_id': str(conv.id)},
        )
        msg = self._send(conv.id, self.user_a, '读一下')

        with self.captureOnCommitCallbacks(
            using=postgres_app_db_alias(), execute=True
        ):
            MessageService.mark_as_read(
                conversation_id=str(conv.id),
                user_id=str(self.user_b.id),
                last_message_id=msg.id,
            )

        legacy.refresh_from_db()
        self.assertTrue(legacy.is_read)

    def test_compute_bell_recipients_dm_and_group_mention(self):
        dm = compute_bell_recipients(
            conversation_type=ConversationType.DM,
            other_ids=['u1', 'u2'],
            mentioned_recipients=['u2'],
        )
        self.assertEqual(
            dm,
            [
                {'user_id': 'u1', 'mention': False},
                {'user_id': 'u2', 'mention': True},
            ],
        )
        group = compute_bell_recipients(
            conversation_type=ConversationType.GROUP,
            other_ids=['u1', 'u2', 'u3'],
            mentioned_recipients=['u2'],
        )
        self.assertEqual(group, [{'user_id': 'u2', 'mention': True}])

    def test_dedup_key_stable_per_conversation(self):
        self.assertEqual(
            im_conversation_dedup_key('abc'), im_conversation_dedup_key('abc')
        )
        self.assertNotEqual(
            im_conversation_dedup_key('abc'), im_conversation_dedup_key('xyz')
        )
