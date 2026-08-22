import json
import uuid
from dataclasses import dataclass
from datetime import timedelta
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.test import Client, SimpleTestCase, TestCase
from django.utils import timezone

from apps.tabdata.models import Table, TableField
from apps.tabdata.services.view_service import ViewService
from apps.tabtinspace.models import Device, Organization, SpaceMembership, Workspace
from apps.users.auth.models import UserSession
from apps.users.auth.session_manager import SessionManager
from apps.users.auth.utils import generate_jwt_token

User = get_user_model()


@dataclass
class _FakeField:
    id: str
    is_primary: bool


class ViewServiceRuleTestCase(SimpleTestCase):
    def test_grid_view_primary_field_must_be_visible(self):
        fields = [
            _FakeField(id='fld_primary', is_primary=True),
            _FakeField(id='fld_status', is_primary=False),
        ]

        with self.assertRaises(ValueError):
            ViewService._ensure_primary_fields_visible(
                'grid',
                fields,  # type: ignore[arg-type]
                ['fld_status'],
            )

    def test_calendar_view_allows_hiding_primary_field(self):
        fields = [
            _FakeField(id='fld_primary', is_primary=True),
            _FakeField(id='fld_date', is_primary=False),
        ]

        ViewService._ensure_primary_fields_visible(
            'calendar',
            fields,  # type: ignore[arg-type]
            ['fld_date'],
        )

    def test_empty_visible_fields_treated_as_show_all(self):
        fields = [
            _FakeField(id='fld_primary', is_primary=True),
            _FakeField(id='fld_title', is_primary=False),
        ]

        ViewService._ensure_primary_fields_visible(
            'grid',
            fields,  # type: ignore[arg-type]
            [],
        )

    def test_sync_groups_fills_group_by_field(self):
        config, groups = ViewService._sync_groups_and_group_by_field(
            {'card_title_field': 'fld_title'},
            [{'field_id': 'fld_status', 'direction': 'asc'}],
        )
        self.assertEqual(config['group_by_field'], 'fld_status')
        self.assertEqual(groups[0]['field_id'], 'fld_status')

    def test_sync_group_by_field_fills_groups(self):
        config, groups = ViewService._sync_groups_and_group_by_field(
            {'group_by_field': 'fld_status'},
            None,
        )
        self.assertEqual(config['group_by_field'], 'fld_status')
        self.assertEqual(groups, [{'field_id': 'fld_status', 'direction': 'asc'}])

    def test_sync_groups_field_alias(self):
        config, groups = ViewService._sync_groups_and_group_by_field(
            {},
            [{'field': 'fld_status'}],
        )
        self.assertEqual(config['group_by_field'], 'fld_status')
        self.assertEqual(groups[0].get('field'), 'fld_status')


class ViewServiceCreateKanbanGroupsTestCase(TestCase):
    """服务层：create_view 接受 groups 并与 group_by_field 双向对齐"""

    databases = ['default']

    def setUp(self):
        self.user = User.objects.create_user(
            username='kanban-groups-owner',
            email='kanban-groups@example.com',
            password='password123',
        )
        self.organization = Organization.objects.create(
            name='看板分组测试组织',
            owner=self.user,
        )
        self.organization.members.create(user=self.user, role='owner')
        # ：Space 表已 DROP，改用 Workspace + 直挂 user 的 SpaceMembership
        device = Device.objects.create(
            organization=self.organization,
            user=self.user,
            name='看板分组测试设备',
            device_type='electron',
            role='control',
            fingerprint=f'kanban-groups-{uuid.uuid4().hex}',
        )
        working_dir = f'/tmp/kanban-groups-{uuid.uuid4().hex}'
        self.space = Workspace.objects.create(
            organization=self.organization,
            device=device,
            name='看板分组测试 Workspace',
            working_dir=working_dir,
            normalized_working_dir=working_dir,
            created_by=self.user,
        )
        SpaceMembership.objects.update_or_create(
            workspace=self.space,
            user=self.user,
            defaults={'role': 'owner', 'is_active': True},
        )
        self.table = Table.objects.create(
            space_id=self.space.id,
            organization_id=self.space.organization_id,
            name='看板分组表',
            owner=self.user,
        )
        self.title_field = TableField.objects.create(
            table=self.table,
            name='标题',
            field_type='text',
            is_primary=True,
            order=0,
        )
        self.status_field = TableField.objects.create(
            table=self.table,
            name='状态',
            field_type='select',
            config={'choices': ['待联系', '已联系']},
            order=1,
        )
        self.service = ViewService(user=self.user)

    def test_create_with_groups_syncs_config(self):
        view = self.service.create_view(
            table_id=self.table.id,
            name='跟进看板',
            view_type='kanban',
            groups=[{'field_id': str(self.status_field.id), 'direction': 'asc'}],
            config={'card_title_field': str(self.title_field.id)},
        )
        self.assertIsNotNone(view)
        self.assertEqual(view.config.get('group_by_field'), str(self.status_field.id))
        self.assertEqual(view.groups[0].get('field_id'), str(self.status_field.id))

    def test_create_with_groups_defaults_title_to_primary_field(self):
        """CLI 只指定分组字段时，应创建可直接使用且标题完整的看板。"""
        view = self.service.create_view(
            table_id=self.table.id,
            name='Agent 创建的看板',
            view_type='kanban',
            groups=[{'field_id': str(self.status_field.id), 'direction': 'asc'}],
        )

        self.assertIsNotNone(view)
        self.assertEqual(view.config.get('group_by_field'), str(self.status_field.id))
        self.assertEqual(view.config.get('card_title_field'), str(self.title_field.id))
        self.assertEqual(view.groups[0].get('field_id'), str(self.status_field.id))

    def test_create_with_groups_defaults_title_to_first_text_field(self):
        """表里没有主字段时，应回退到排序最前的文本字段。"""
        TableField.objects.filter(id=self.title_field.id).update(is_primary=False)

        view = self.service.create_view(
            table_id=self.table.id,
            name='无主字段看板',
            view_type='kanban',
            groups=[{'field_id': str(self.status_field.id), 'direction': 'asc'}],
        )

        self.assertIsNotNone(view)
        self.assertEqual(view.config.get('card_title_field'), str(self.title_field.id))

    def test_create_with_groups_defaults_title_to_first_field(self):
        """表里既无主字段也无文本字段时，应回退到排序最前的字段。"""
        TableField.objects.filter(id=self.title_field.id).update(
            is_primary=False,
            field_type='number',
        )

        view = self.service.create_view(
            table_id=self.table.id,
            name='无文本字段看板',
            view_type='kanban',
            groups=[{'field_id': str(self.status_field.id), 'direction': 'asc'}],
        )

        self.assertIsNotNone(view)
        self.assertEqual(view.config.get('card_title_field'), str(self.title_field.id))

    def test_api_create_with_groups_only_returns_usable_kanban(self):
        """真实 HTTP 契约：CLI 转出的 groups-only 请求应返回 201。"""
        raw_session_key = f'kanban_groups_{uuid.uuid4().hex}'
        UserSession.objects.create(
            session_key=SessionManager.hash_session_key(raw_session_key),
            user=self.user,
            session_type='web',
            ip_address='127.0.0.1',
            user_agent='kanban-groups-test',
            expires_at=timezone.now() + timedelta(hours=2),
        )
        token = generate_jwt_token(
            self.user,
            expire_hours=1,
            token_type='access',
            session_key=raw_session_key,
        )
        client = Client()
        with patch(
            'apps.users.auth.invite_gate_middleware.is_invite_gate_enabled',
            return_value=False,
        ):
            response = client.post(
                '/api/tabdata/views',
                data=json.dumps({
                    'table_id': str(self.table.id),
                    'name': 'Agent 创建的任务看板',
                    'view_type': 'kanban',
                    'groups': [{
                        'field_id': str(self.status_field.id),
                        'direction': 'asc',
                    }],
                }),
                content_type='application/json',
                HTTP_AUTHORIZATION=f'Bearer {token}',
            )

        self.assertEqual(response.status_code, 201, response.content)
        view_data = response.json()['data']
        self.assertEqual(view_data['config']['group_by_field'], str(self.status_field.id))
        self.assertEqual(view_data['config']['card_title_field'], str(self.title_field.id))
        self.assertEqual(view_data['groups'][0]['field_id'], str(self.status_field.id))

    def test_create_with_group_by_field_syncs_groups(self):
        view = self.service.create_view(
            table_id=self.table.id,
            name='配置看板',
            view_type='kanban',
            config={
                'group_by_field': str(self.status_field.id),
                'card_title_field': str(self.title_field.id),
            },
        )
        self.assertIsNotNone(view)
        self.assertEqual(view.config.get('group_by_field'), str(self.status_field.id))
        self.assertGreaterEqual(len(view.groups or []), 1)
        self.assertEqual(view.groups[0].get('field_id'), str(self.status_field.id))

    def test_create_kanban_without_config_skips_suggestions(self):
        """REST 快速新建看板不得自动写入首个 select，否则会跳过前端配置卡。"""
        view = self.service.create_view(
            table_id=self.table.id,
            name='空壳看板',
            view_type='kanban',
        )
        self.assertIsNotNone(view)
        self.assertNotIn('group_by_field', view.config or {})
        self.assertNotIn('card_title_field', view.config or {})
        self.assertEqual(view.groups or [], [])

    def test_create_calendar_without_config_skips_suggestions(self):
        """日历同路径：空创建不落库 date_field，留给前端 needsConfig 配置卡。"""
        date_field = TableField.objects.create(
            table=self.table,
            name='截止日期',
            field_type='date',
            order=2,
        )
        view = self.service.create_view(
            table_id=self.table.id,
            name='空壳日历',
            view_type='calendar',
        )
        self.assertIsNotNone(view)
        self.assertNotIn('date_field', view.config or {})
        self.assertNotEqual((view.config or {}).get('date_field'), str(date_field.id))
