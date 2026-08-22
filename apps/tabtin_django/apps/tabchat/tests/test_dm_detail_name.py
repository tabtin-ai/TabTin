"""DM 会话详情接口的对方名解析测试。

回归：`get_conversation_detail` 对 DM 应返回对方昵称作为顶层 name（与
`list_conversations` 一致），否则前端点名片「发消息」打开既有 DM 时，详情返回的
空名会覆盖侧栏列表里已解析好的名字，使其退回「私聊」。
对真 PG 跑：USE_SQLITE_FOR_TESTS=0 python -m pytest <path> --reuse-db
"""

import os
import sys
from datetime import datetime, timezone
from types import SimpleNamespace


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
from unittest.mock import patch

from apps.tabchat.constants import ConversationType
from apps.tabchat.services.conversation_service import ConversationService, _versioned_conversation_avatar_url
from apps.tabchat.services.profile_sync_service import avatar_version, publish_user_profile_updated
from apps.tabtinspace.models import Organization, OrganizationMember
from apps.users.membership.models import MembershipTier

User = get_user_model()


def _ensure_free_tier() -> None:
    MembershipTier.objects.update_or_create(
        tier_type='free',
        defaults={
            'name': '免费版',
            'description': 'dm detail name tests bootstrap',
            'max_tables': -1,
            'max_records_per_table': -1,
            'max_api_calls_per_day': -1,
            'max_crawl_tasks_per_day': -1,
            'features': {},
            'sort_order': 0,
            'is_active': True,
        },
    )


class ConversationAvatarVersionTests(TestCase):
    def test_profile_revision_changes_avatar_cache_key_even_for_same_object_key(self):
        self.assertNotEqual(avatar_version(1), avatar_version(2))

    def test_group_avatar_url_carries_conversation_update_version(self):
        conversation = SimpleNamespace(
            type=ConversationType.GROUP,
            avatar_url='https://cdn.example.com/group.png?token=abc',
            updated_at=datetime(2026, 1, 2, 3, 4, 5, tzinfo=timezone.utc),
        )

        self.assertEqual(
            _versioned_conversation_avatar_url(conversation),
            'https://cdn.example.com/group.png?token=abc&v=1767323045000',
        )


class DMDetailNameTests(TestCase):
    databases = ['default', 'postgresql']

    def setUp(self):
        _ensure_free_tier()
        self.user_a = User.objects.create_user(
            username='dn_a', email='dn_a@test.com', password='pass123', nickname='阿强',
        )
        self.user_b = User.objects.create_user(
            username='dn_b', email='dn_b@test.com', password='pass123', nickname='小美',
        )
        self.organization = Organization.objects.create(name='DM Name Test', owner=self.user_a)
        OrganizationMember.objects.create(organization=self.organization, user=self.user_a, role='owner')
        OrganizationMember.objects.create(organization=self.organization, user=self.user_b, role='editor')
        self.conv = ConversationService.create_dm(
            organization_id=str(self.organization.id),
            creator_id=str(self.user_a.id),
            other_user_id=str(self.user_b.id),
        )

    def test_detail_resolves_peer_name_for_each_viewer(self):
        # A 看到的对方是小美
        detail_a = ConversationService.get_conversation_detail(
            str(self.conv.id), str(self.user_a.id),
        )
        self.assertEqual(detail_a["name"], '小美')

        # B 看到的对方是阿强（同一会话，按观察者解析）
        detail_b = ConversationService.get_conversation_detail(
            str(self.conv.id), str(self.user_b.id),
        )
        self.assertEqual(detail_b["name"], '阿强')

    def test_profile_change_is_the_dm_name_source_for_list_and_detail(self):
        self.user_b.nickname = '新版小美'
        self.user_b.save(update_fields=['nickname'])

        detail = ConversationService.get_conversation_detail(str(self.conv.id), str(self.user_a.id))
        listed = ConversationService.list_conversations(
            organization_id=str(self.organization.id), user_id=str(self.user_a.id),
        )
        listed_conv = next(c for c in listed if c['id'] == str(self.conv.id))

        self.assertEqual(detail['name'], '新版小美')
        self.assertEqual(listed_conv['name'], '新版小美')

    @patch('apps.tabchat.services.profile_sync_service.IMOutboxService.enqueue')
    def test_profile_update_fans_out_to_unopened_conversation_participants(self, enqueue):
        self.user_b.nickname = '新版小美'
        self.user_b.avatar = 'user-avatars/new.png'
        self.user_b.profile_revision = 2

        publish_user_profile_updated(self.user_b)

        enqueue.assert_called_once()
        payload = enqueue.call_args.kwargs
        self.assertEqual(payload['organization_id'], str(self.organization.id))
        self.assertEqual(set(payload['target_channels']), {
            f'personal:{self.user_a.id}', f'personal:{self.user_b.id}',
        })
        self.assertEqual(payload['data']['nickname'], '新版小美')
        self.assertEqual(payload['data']['avatar_version'], '2')
        self.assertEqual(payload['data']['revision'], 2)

    @patch('apps.tabchat.services.profile_sync_service.IMOutboxService.enqueue')
    @patch(
        'apps.tabchat.services.profile_sync_service.ConversationAccessResolver.human_user_ids',
        return_value=[],
    )
    def test_profile_update_excludes_stale_conversation_members(self, human_user_ids, enqueue):
        """投递人由实时访问 resolver 决定，不能直接信任 ConversationMember 快照。"""
        publish_user_profile_updated(self.user_b)

        human_user_ids.assert_called_once_with(self.conv)
        enqueue.assert_not_called()

    def test_detail_name_matches_list(self):
        detail = ConversationService.get_conversation_detail(
            str(self.conv.id), str(self.user_a.id),
        )
        listed = ConversationService.list_conversations(
            organization_id=str(self.organization.id), user_id=str(self.user_a.id),
        )
        listed_conv = next(c for c in listed if c["id"] == str(self.conv.id))
        # 详情与列表对 DM 名解析口径一致，避免 upsert 覆盖
        self.assertEqual(detail["name"], listed_conv["name"])

    def test_create_dm_is_idempotent(self):
        again = ConversationService.create_dm(
            organization_id=str(self.organization.id),
            creator_id=str(self.user_a.id),
            other_user_id=str(self.user_b.id),
        )
        self.assertEqual(again.id, self.conv.id)

    def test_create_dm_rejects_self(self):
        with self.assertRaisesRegex(ValueError, "不能与自己创建私信"):
            ConversationService.create_dm(
                organization_id=str(self.organization.id),
                creator_id=str(self.user_a.id),
                other_user_id=str(self.user_a.id),
            )

    def test_create_dm_rejects_user_outside_organization(self):
        outsider = User.objects.create_user(
            username='dn_outsider', email='dn_outsider@test.com', password='pass123', nickname='外部用户',
        )
        with self.assertRaisesRegex(ValueError, "不属于该组织"):
            ConversationService.create_dm(
                organization_id=str(self.organization.id),
                creator_id=str(self.user_a.id),
                other_user_id=str(outsider.id),
            )

    def test_detail_contains_avatar_ready_human_member_fields(self):
        self.user_b.avatar = 'user-avatars/dm-peer.png'
        self.user_b.save(update_fields=['avatar'])

        detail = ConversationService.get_conversation_detail(
            str(self.conv.id), str(self.user_a.id),
        )
        peer = next(member for member in detail['members'] if member['user_id'] == str(self.user_b.id))
        self.assertEqual(peer['member_type'], 'user')
        self.assertEqual(peer['nickname'], '小美')
        self.assertEqual(peer['username'], 'dn_b')
        self.assertIn('object_key=user-avatars%2Fdm-peer.png', peer['avatar'])
