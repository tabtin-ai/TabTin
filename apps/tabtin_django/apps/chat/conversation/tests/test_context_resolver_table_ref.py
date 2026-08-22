"""：表格 @ 引用解析必须输出 table_id，且模型名用 Table/TableField/TableRecord。

历史 bug：context_resolver 仍 import 已删除的 TabData/TinField/TinRecord，
ImportError 被吞掉后只返回 preview 名（如「成绩表」），Agent 拿不到 ID，
只能按执行 Space 的 table list 瞎找。
"""

import json
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from django.contrib.auth import get_user_model
from django.test import SimpleTestCase, TestCase

from apps.chat.conversation.services.context_resolver import (
    _get_sample_records,
    _resolve_field_ref,
    _resolve_table_ref,
    _resolve_table_selection,
    _user_can_view_table,
    resolve_context_blocks,
)
from apps.tabdata.models import Table, TableField, TablePermission
from apps.tabdata.services.base import BaseService
from apps.tabtinspace.models import Organization, OrganizationMember


def _fake_table(**kwargs):
    defaults = {
        'id': 'ade1f15a-b6aa-4d9d-ad07-416bf598b8d0',
        'name': '成绩表',
        'description': '班级成绩',
    }
    defaults.update(kwargs)
    return SimpleNamespace(**defaults)


def _fake_field(**kwargs):
    defaults = {
        'id': 'f1',
        'name': '姓名',
        'field_type': 'text',
        'description': '',
        'is_deleted': False,
        'order': 0,
    }
    defaults.update(kwargs)
    return SimpleNamespace(**defaults)


class TableRefPermissionIntegrationTest(TestCase):
    """真实 PG 权限链：table UUID 不能成为跨用户读取后门。"""

    databases = {'default'}

    def setUp(self):
        user_model = get_user_model()
        self.owner = user_model.objects.create_user(
            username='table_ref_owner',
            email='table-ref-owner@example.com',
            password='test-password',
        )
        self.outsider = user_model.objects.create_user(
            username='table_ref_outsider',
            email='table-ref-outsider@example.com',
            password='test-password',
        )
        self.org_editor = user_model.objects.create_user(
            username='table_ref_org_editor',
            email='table-ref-editor@example.com',
            password='test-password',
        )
        self.organization = Organization.objects.filter(owner=self.owner).first()
        self.assertIsNotNone(self.organization)
        OrganizationMember.objects.update_or_create(
            organization=self.organization,
            user=self.org_editor,
            defaults={'role': 'editor'},
        )
        self.table = Table.objects.create(
            name='仅 owner 可见的成绩表',
            description='敏感成绩',
            organization_id=self.organization.id,
            owner=self.owner,
        )

    def test_owner_can_resolve_table(self):
        self.assertTrue(_user_can_view_table(str(self.owner.id), str(self.table.id)))
        text = _resolve_table_ref(
            {'type': 'table', 'table_id': str(self.table.id), 'preview': '成绩表'},
            str(self.owner.id),
            4000,
        )
        self.assertIn('仅 owner 可见的成绩表', text)

    def test_outsider_cannot_resolve_table_data(self):
        self.assertFalse(_user_can_view_table(str(self.outsider.id), str(self.table.id)))
        text = _resolve_table_ref(
            {'type': 'table', 'table_id': str(self.table.id), 'preview': '调用方已知标题'},
            str(self.outsider.id),
            4000,
        )
        self.assertIn('无权读取', text)
        self.assertNotIn('仅 owner 可见的成绩表', text)
        self.assertNotIn('敏感成绩', text)

    def test_table_viewer_cannot_resolve_owner_only_field(self):
        TablePermission.objects.create(
            table=self.table,
            subject_type='user',
            subject_id=str(self.org_editor.id),
            permission='viewer',
            is_active=True,
        )
        hidden_field = TableField.objects.create(
            table=self.table,
            name='仅 owner 可见字段',
            field_type='text',
            config={'visibility_roles': ['owner']},
        )
        self.assertEqual(
            BaseService(user=self.org_editor).get_table_role(str(self.table.id)),
            'viewer',
        )

        text = _resolve_field_ref(
            {
                'type': 'field',
                'table_id': str(self.table.id),
                'field_ids': [str(hidden_field.id)],
                'preview': '调用方已知标题',
            },
            str(self.org_editor.id),
            4000,
        )

        self.assertIn('无权读取', text)
        self.assertNotIn('仅 owner 可见字段', text)


class ResolveTableRefMachineReadableTest(SimpleTestCase):
    """成功路径：输出含 table_id、直读提示、跨 Space 提示。"""

    BUDGET = 4000

    def setUp(self):
        super().setUp()
        permission_patcher = patch(
            'apps.chat.conversation.services.context_resolver._user_can_view_table',
            return_value=True,
        )
        permission_patcher.start()
        self.addCleanup(permission_patcher.stop)
        visibility_patcher = patch(
            'apps.chat.conversation.services.context_resolver._filter_visible_fields',
            side_effect=lambda _user_id, _table_id, fields: fields,
        )
        visibility_patcher.start()
        self.addCleanup(visibility_patcher.stop)

    @patch('apps.tabdata.models.TableField')
    @patch('apps.tabdata.models.Table')
    @patch(
        'apps.chat.conversation.services.context_resolver._get_sample_records',
        return_value='姓名 | 总分\n--- | ---\n张三 | 90',
    )
    def test_table_ref_includes_table_id_and_space_hint(
        self, _mock_sample, mock_table_model, mock_field_model,
    ):
        mock_table_model.objects.filter.return_value.first.return_value = _fake_table()
        mock_field_model.objects.filter.return_value.order_by.return_value = [
            _fake_field(),
            _fake_field(id='f2', name='总分', field_type='number'),
        ]

        text = _resolve_table_ref(
            {
                'type': 'table_selection',
                'table_id': 'ade1f15a-b6aa-4d9d-ad07-416bf598b8d0',
                'preview': '成绩表',
                'space_id': 'b33cfd62-ead7-4456-9a4b-7ce08efcdfea',
                'space_name': '01 的作坊 Workspace',
            },
            'user-1',
            self.BUDGET,
        )

        self.assertIn('## 表格: 成绩表', text)
        self.assertIn('table_id: ade1f15a-b6aa-4d9d-ad07-416bf598b8d0', text)
        self.assertIn('引用解析已按当前用户权限', text)
        self.assertIn('01 的作坊 Workspace', text)
        self.assertIn('字段 Schema', text)
        self.assertIn('姓名', text)
        self.assertIn('采样数据', text)

    @patch('apps.tabdata.models.TableField')
    @patch('apps.tabdata.models.Table')
    def test_table_selection_without_records_still_has_table_id(
        self, mock_table_model, mock_field_model,
    ):
        mock_table_model.objects.filter.return_value.first.return_value = _fake_table()
        fields = [_fake_field()]
        mock_field_model.objects.filter.return_value.order_by.return_value = fields

        text = _resolve_table_selection(
            {
                'type': 'table_selection',
                'table_id': 'ade1f15a-b6aa-4d9d-ad07-416bf598b8d0',
                'preview': '成绩表',
                'space_name': '01 的作坊 Workspace',
            },
            'user-1',
            self.BUDGET,
        )

        self.assertIn('## 表格选区: 成绩表', text)
        self.assertIn('table_id: ade1f15a-b6aa-4d9d-ad07-416bf598b8d0', text)
        self.assertIn('引用解析已按当前用户权限', text)

    @patch('apps.tabdata.models.TableField')
    @patch('apps.tabdata.models.Table')
    def test_table_selection_reads_native_record_service_with_rls(
        self,
        mock_table_model,
        mock_field_model,
    ):
        mock_table_model.objects.filter.return_value.first.return_value = _fake_table()
        mock_field_model.objects.filter.return_value = [_fake_field()]
        reader = MagicMock()
        reader.get_record_data.return_value = {'fields': {'f1': '张三'}}
        rls_context = object()

        with patch(
            'apps.chat.conversation.services.context_resolver._record_reader',
            return_value=(reader, rls_context),
        ):
            text = _resolve_table_selection(
                {
                    'type': 'table_selection',
                    'table_id': 'ade1f15a-b6aa-4d9d-ad07-416bf598b8d0',
                    'record_ids': ['record-1'],
                    'field_ids': ['f1'],
                    'preview': '成绩表',
                },
                'user-1',
                self.BUDGET,
            )

        reader.get_record_data.assert_called_once_with(
            'record-1',
            field_key_type='id',
            rls_context=rls_context,
        )
        self.assertIn('姓名: 张三', text)

    @patch('apps.tabdata.models.TableField')
    @patch('apps.tabdata.models.Table')
    def test_query_failure_still_keeps_table_id(self, mock_table_model, _mock_field_model):
        """ORM 异常时不能只返回 preview 名——必须保留 table_id 逃逸路径。"""
        mock_table_model.objects.filter.side_effect = RuntimeError('db down')

        text = _resolve_table_ref(
            {
                'type': 'table_selection',
                'table_id': 'ade1f15a-b6aa-4d9d-ad07-416bf598b8d0',
                'preview': '成绩表',
                'space_name': '01 的作坊 Workspace',
            },
            'user-1',
            self.BUDGET,
        )

        self.assertIn('table_id: ade1f15a-b6aa-4d9d-ad07-416bf598b8d0', text)
        self.assertIn('表格数据解析失败', text)
        self.assertNotEqual(text.strip(), '成绩表')

    @patch('apps.tabdata.models.Table')
    def test_permission_denied_never_queries_or_returns_table_data(self, mock_table_model):
        """调用方可回显自己的指针，但不能拿到服务端表名/schema/采样。"""
        with patch(
            'apps.chat.conversation.services.context_resolver._user_can_view_table',
            return_value=False,
        ):
            text = _resolve_table_ref(
                {
                    'type': 'table',
                    'table_id': 'ade1f15a-b6aa-4d9d-ad07-416bf598b8d0',
                    'preview': '调用方已知标题',
                },
                'outsider-user',
                self.BUDGET,
            )

        mock_table_model.objects.filter.assert_not_called()
        self.assertIn('table_id: ade1f15a-b6aa-4d9d-ad07-416bf598b8d0', text)
        self.assertIn('无权读取', text)
        self.assertNotIn('字段 Schema', text)
        self.assertNotIn('采样数据', text)

    @patch('apps.tabdata.models.TableField')
    def test_field_lookup_is_bound_to_the_authorized_table(self, mock_field_model):
        mock_field_model.objects.filter.return_value.first.return_value = None

        _resolve_field_ref(
            {
                'type': 'field',
                'table_id': 'authorized-table',
                'field_ids': ['foreign-field'],
                'preview': '敏感字段',
            },
            'user-1',
            self.BUDGET,
        )

        mock_field_model.objects.filter.assert_called_once_with(
            id='foreign-field',
            table_id='authorized-table',
            is_deleted=False,
        )

    def test_sample_records_use_native_record_service_with_rls(self):
        reader = MagicMock()
        reader.list_records.return_value = {
            'records': [{'fields': {'f1': '张三'}}],
        }
        rls_context = object()

        with patch(
            'apps.chat.conversation.services.context_resolver._record_reader',
            return_value=(reader, rls_context),
        ):
            text = _get_sample_records(
                'table-1',
                [_fake_field()],
                user_id='user-1',
                max_rows=5,
            )

        reader.list_records.assert_called_once_with(
            table_id='table-1',
            page=1,
            page_size=5,
            sort_by='updated_at',
            sort_order='desc',
            field_key_type='id',
            rls_context=rls_context,
        )
        self.assertIn('张三', text)


class ResolveContextBlocksTableIntegrationTest(SimpleTestCase):
    """resolve_context_blocks 集成：整表引用（无 record_ids）走 _resolve_table_ref。"""

    @patch(
        'apps.chat.conversation.services.context_resolver._resolve_table_ref',
        return_value=(
            '## 表格: 成绩表\n'
            'table_id: ade1f15a-b6aa-4d9d-ad07-416bf598b8d0\n'
            '引用解析已按当前用户权限注入可见数据'
        ),
    )
    def test_table_selection_without_record_ids_uses_table_ref(self, mock_ref):
        blocks = [{
            'type': 'table_selection',
            'table_id': 'ade1f15a-b6aa-4d9d-ad07-416bf598b8d0',
            'preview': '成绩表',
        }]
        context_text, resolved = resolve_context_blocks(blocks, user_id='user-1')
        mock_ref.assert_called_once()
        self.assertIn('table_id: ade1f15a-b6aa-4d9d-ad07-416bf598b8d0', context_text)
        self.assertIn('_resolved_text', resolved[0])


class ResolveContextApiErrorSurfaceTest(SimpleTestCase):
    """/resolve-context 整体异常必须返回非 2xx，不能静默 200 + 空文本。"""

    def test_resolve_context_returns_500_on_resolver_crash(self):
        from apps.chat.conversation.api.context import resolve_context
        from apps.chat.conversation.schemas import ResolveContextRequest

        request = MagicMock()
        request.auth = MagicMock(id='user-1')
        data = ResolveContextRequest(blocks=[{
            'type': 'table_selection',
            'table_id': 'ade1f15a-b6aa-4d9d-ad07-416bf598b8d0',
            'preview': '成绩表',
        }])

        with patch(
            'apps.chat.conversation.services.context_resolver.resolve_context_blocks',
            side_effect=RuntimeError('boom'),
        ):
            resp = resolve_context(request, data)

        self.assertEqual(resp.status_code, 500)
        body = json.loads(resp.content.decode('utf-8'))
        self.assertFalse(body.get('success'))
        self.assertEqual(body.get('code'), 'RESOLVE_CONTEXT_FAILED')
        self.assertTrue((body.get('data') or {}).get('resolve_failed'))
