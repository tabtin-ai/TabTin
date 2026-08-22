"""
视图API集成测试

测试视图相关的API接口
"""
import json
from datetime import date, timedelta
from unittest import skipUnless
from django.contrib.auth import get_user_model
from django.db import connection
from django.test import TestCase, Client
from django.urls import reverse

from apps.tabtinspace.models import Organization, Space
from apps.tabdata.models import LinkRecord, Table, TableField, TableRecord, TableView
from apps.users.auth.utils import generate_jwt_token

User = get_user_model()


class ViewAPITestCase(TestCase):
    """视图API集成测试用例"""

    databases = ['default', 'postgresql']

    def setUp(self):
        """设置测试数据"""
        # 创建测试客户端
        self.client = Client()

        # 创建用户
        self.user = User.objects.create_user(
            phone='13800000004',
            nickname='API测试用户',
            password='testpass123'
        )

        # 登录获取Token（这里简化处理，实际应该通过登录API获取）
        self.token = self._get_auth_token()

        # 创建组织
        self.organization = Organization.objects.create(
            name='API测试组织',
            owner=self.user
        )

        # 创建项目
        self.space = Space.objects.create(
            organization=self.organization,
            name='API测试项目'
        )

        # 创建表格
        self.table = Table.objects.create(
            space_id=self.space.id,
            organization_id=self.space.organization_id,
            name='API测试表格',
            owner=self.user
        )

        # 创建字段
        self.title_field = TableField.objects.create(
            table=self.table,
            name='标题',
            field_type='text',
            is_primary=True,
            order=0
        )

        self.status_field = TableField.objects.create(
            table=self.table,
            name='状态',
            field_type='select',
            config={
                'options': [
                    {'value': '待办', 'label': '待办'},
                    {'value': '进行中', 'label': '进行中'},
                    {'value': '已完成', 'label': '已完成'}
                ]
            },
            order=1
        )

        self.date_field = TableField.objects.create(
            table=self.table,
            name='日期',
            field_type='date',
            order=2
        )

        # 创建测试记录
        today = date.today()
        for i in range(5):
            TableRecord.objects.create(
                table=self.table,
                created_by=self.user,
                data={
                    str(self.title_field.id): f'任务{i+1}',
                    str(self.status_field.id): ['待办', '进行中', '已完成'][i % 3],
                    str(self.date_field.id): (today + timedelta(days=i)).isoformat()
                }
            )

    def _get_auth_token(self):
        """获取认证Token（简化实现）"""
        return generate_jwt_token(self.user, expire_hours=1, token_type='access')

    def _auth_headers(self):
        """获取认证头"""
        if self.token:
            return {'HTTP_AUTHORIZATION': f'Bearer {self.token}'}
        return {}

    # ==================== 视图CRUD测试 ====================

    def test_create_grid_view(self):
        """测试创建表格视图"""
        # 先登录
        self.client.force_login(self.user)

        url = '/api/tabdata/views'
        data = {
            'table_id': str(self.table.id),
            'name': '测试表格视图',
            'view_type': 'grid',
            'config': {}
        }

        response = self.client.post(
            url,
            data=json.dumps(data),
            content_type='application/json',
            **self._auth_headers()
        )

        self.assertEqual(response.status_code, 201)
        response_data = response.json()
        self.assertTrue(response_data['success'])
        self.assertEqual(response_data['data']['view_type'], 'grid')
        self.assertIn('column_meta', response_data['data'])
        self.assertIn('columnMeta', response_data['data'])
        self.assertEqual(response_data['data']['column_meta'], response_data['data']['columnMeta'])

    def test_delete_first_view_allowed_when_multiple_views_exist(self):
        """删除首个视图时，只要仍有其他视图，应允许删除并同步新的首个视图。"""
        self.client.force_login(self.user)

        first_view = TableView.objects.create(
            table=self.table,
            name='表格视图',
            view_type='grid',
            created_by=self.user,
            order=0,
            config={},
        )
        second_view = TableView.objects.create(
            table=self.table,
            name='看板视图',
            view_type='kanban',
            created_by=self.user,
            order=1,
            config={},
        )
        self.table.default_view = first_view
        self.table.save(update_fields=['default_view'])

        response = self.client.delete(
            f'/api/tabdata/views/{first_view.id}',
            **self._auth_headers()
        )

        self.assertEqual(response.status_code, 200)
        self.assertFalse(TableView.objects.filter(id=first_view.id).exists())
        self.table.refresh_from_db()
        self.assertEqual(self.table.default_view_id, second_view.id)

    def test_delete_last_view_denied(self):
        """只有一个视图时不允许删除，保证表始终至少有一个视图。"""
        self.client.force_login(self.user)

        view = TableView.objects.create(
            table=self.table,
            name='表格视图',
            view_type='grid',
            created_by=self.user,
            order=0,
            config={},
        )
        self.table.default_view = view
        self.table.save(update_fields=['default_view'])

        response = self.client.delete(
            f'/api/tabdata/views/{view.id}',
            **self._auth_headers()
        )

        self.assertEqual(response.status_code, 400)
        self.assertTrue(TableView.objects.filter(id=view.id).exists())

    def test_set_default_route_moves_view_to_first(self):
        """旧 set-default 路由语义改为设置首个视图。"""
        self.client.force_login(self.user)

        first_view = TableView.objects.create(
            table=self.table,
            name='表格视图',
            view_type='grid',
            created_by=self.user,
            order=0,
            config={},
        )
        second_view = TableView.objects.create(
            table=self.table,
            name='看板视图',
            view_type='kanban',
            created_by=self.user,
            order=1,
            config={},
        )
        self.table.default_view = first_view
        self.table.save(update_fields=['default_view'])

        response = self.client.post(
            f'/api/tabdata/tables/{self.table.id}/views/set-default/{second_view.id}',
            **self._auth_headers()
        )

        self.assertEqual(response.status_code, 200)
        first_view.refresh_from_db()
        second_view.refresh_from_db()
        self.assertEqual(second_view.order, 0)
        self.assertEqual(first_view.order, 1)
        self.table.refresh_from_db()
        self.assertEqual(self.table.default_view_id, second_view.id)

    def test_create_kanban_view(self):
        """测试创建看板视图"""
        self.client.force_login(self.user)

        url = '/api/tabdata/views'
        data = {
            'table_id': str(self.table.id),
            'name': '任务看板',
            'view_type': 'kanban',
            'config': {
                'group_by_field': str(self.status_field.id),
                'card_title_field': str(self.title_field.id)
            }
        }

        response = self.client.post(
            url,
            data=json.dumps(data),
            content_type='application/json',
            **self._auth_headers()
        )

        self.assertEqual(response.status_code, 201)
        response_data = response.json()
        self.assertTrue(response_data['success'])
        self.assertEqual(response_data['data']['view_type'], 'kanban')

    def test_create_calendar_view(self):
        """测试创建日历视图"""
        self.client.force_login(self.user)

        url = '/api/tabdata/views'
        data = {
            'table_id': str(self.table.id),
            'name': '项目日历',
            'view_type': 'calendar',
            'config': {
                'date_field': str(self.date_field.id),
                'title_field': str(self.title_field.id),
                'default_view_mode': 'month'
            }
        }

        response = self.client.post(
            url,
            data=json.dumps(data),
            content_type='application/json',
            **self._auth_headers()
        )

        self.assertEqual(response.status_code, 201)
        response_data = response.json()
        self.assertTrue(response_data['success'])
        self.assertEqual(response_data['data']['view_type'], 'calendar')

    def test_create_gallery_view(self):
        """测试创建画廊视图"""
        self.client.force_login(self.user)

        url = '/api/tabdata/views'
        data = {
            'table_id': str(self.table.id),
            'name': '图片画廊',
            'view_type': 'gallery',
            'config': {
                'title_field': str(self.title_field.id),
                'card_size': 'medium'
            }
        }

        response = self.client.post(
            url,
            data=json.dumps(data),
            content_type='application/json',
            **self._auth_headers()
        )

        self.assertEqual(response.status_code, 201)
        response_data = response.json()
        self.assertTrue(response_data['success'])
        self.assertEqual(response_data['data']['view_type'], 'gallery')

    def test_create_calendar_view_without_primary_title_field(self):
        """测试无主字段表快捷创建日历视图：不依赖 title_field 硬校验"""
        self.client.force_login(self.user)
        table = Table.objects.create(
            space_id=self.space.id,
            organization_id=self.space.organization_id,
            name='无主字段日历表',
            owner=self.user
        )
        name_field = TableField.objects.create(
            table=table,
            name='项目名称',
            field_type='text',
            is_primary=False,
            order=0
        )
        date_field = TableField.objects.create(
            table=table,
            name='创建日期',
            field_type='date',
            is_primary=False,
            order=1
        )

        response = self.client.post(
            '/api/tabdata/views',
            data=json.dumps({
                'table_id': str(table.id),
                'name': '日历',
                'view_type': 'calendar',
                'config': {}
            }),
            content_type='application/json',
            **self._auth_headers()
        )

        self.assertEqual(response.status_code, 201)
        response_data = response.json()
        self.assertTrue(response_data['success'])
        self.assertEqual(response_data['data']['config']['date_field'], str(date_field.id))
        self.assertEqual(response_data['data']['config']['title_field'], str(name_field.id))

    def test_create_calendar_view_with_date_only_config(self):
        """测试日历视图显式只传 date_field 时可创建且不补硬依赖标题字段"""
        self.client.force_login(self.user)

        response = self.client.post(
            '/api/tabdata/views',
            data=json.dumps({
                'table_id': str(self.table.id),
                'name': '仅日期日历',
                'view_type': 'calendar',
                'config': {
                    'date_field': str(self.date_field.id),
                }
            }),
            content_type='application/json',
            **self._auth_headers()
        )

        self.assertEqual(response.status_code, 201)
        response_data = response.json()
        self.assertTrue(response_data['success'])
        self.assertNotIn('title_field', response_data['data']['config'])

    def test_create_gallery_view_without_primary_title_field(self):
        """测试无主字段表快捷创建画廊视图：不依赖 title_field 硬校验"""
        self.client.force_login(self.user)
        table = Table.objects.create(
            space_id=self.space.id,
            organization_id=self.space.organization_id,
            name='无主字段画廊表',
            owner=self.user
        )
        name_field = TableField.objects.create(
            table=table,
            name='项目名称',
            field_type='text',
            is_primary=False,
            order=0
        )
        TableField.objects.create(
            table=table,
            name='数值',
            field_type='number',
            is_primary=False,
            order=1
        )

        response = self.client.post(
            '/api/tabdata/views',
            data=json.dumps({
                'table_id': str(table.id),
                'name': '画廊',
                'view_type': 'gallery',
                'config': {}
            }),
            content_type='application/json',
            **self._auth_headers()
        )

        self.assertEqual(response.status_code, 201)
        response_data = response.json()
        self.assertTrue(response_data['success'])
        self.assertEqual(response_data['data']['config']['title_field'], str(name_field.id))

    def test_create_gallery_view_with_invalid_title_field_returns_400(self):
        """测试显式无效 title_field 返回 400 而不是 500"""
        self.client.force_login(self.user)

        response = self.client.post(
            '/api/tabdata/views',
            data=json.dumps({
                'table_id': str(self.table.id),
                'name': '无效标题画廊',
                'view_type': 'gallery',
                'config': {
                    'title_field': 'not-a-uuid',
                }
            }),
            content_type='application/json',
            **self._auth_headers()
        )

        self.assertEqual(response.status_code, 400)
        response_data = response.json()
        self.assertFalse(response_data['success'])

    def test_create_view_with_invalid_config(self):
        """测试创建视图：创建阶段为宽松校验，缺失必填项仍可创建"""
        self.client.force_login(self.user)

        url = '/api/tabdata/views'
        data = {
            'table_id': str(self.table.id),
            'name': '无效看板',
            'view_type': 'kanban',
            'config': {
                # 缺少必需的 group_by_field
                'card_title_field': str(self.title_field.id)
            }
        }

        response = self.client.post(
            url,
            data=json.dumps(data),
            content_type='application/json',
            **self._auth_headers()
        )

        self.assertEqual(response.status_code, 201)
        response_data = response.json()
        self.assertTrue(response_data['success'])
        self.assertEqual(response_data['data']['view_type'], 'kanban')

    def test_update_view_column_meta(self):
        """测试更新视图列元数据"""
        self.client.force_login(self.user)

        view = TableView.objects.create(
            table=self.table,
            name='列元数据测试视图',
            view_type='grid',
            created_by=self.user,
            visible_fields=[
                str(self.title_field.id),
                str(self.status_field.id),
                str(self.date_field.id),
            ],
            field_order=[
                str(self.title_field.id),
                str(self.status_field.id),
                str(self.date_field.id),
            ],
            config={},
        )

        url = f'/api/tabdata/views/{view.id}/column-meta'
        data = {
            'column_meta': {
                str(self.title_field.id): {'order': 0},
                str(self.status_field.id): {'order': 1},
                str(self.date_field.id): {'order': 2, 'hidden': True, 'width': 260},
            }
        }

        response = self.client.put(
            url,
            data=json.dumps(data),
            content_type='application/json',
            **self._auth_headers()
        )

        self.assertEqual(response.status_code, 200)
        response_data = response.json()
        self.assertTrue(response_data['success'])
        self.assertEqual(
            response_data['data']['config']['column_widths'][str(self.date_field.id)],
            260,
        )
        self.assertNotIn(str(self.date_field.id), response_data['data']['visible_fields'])

    def test_update_view_column_meta_with_column_meta_ro_array(self):
        """测试更新视图列元数据：支持 columnMetaRo 数组请求体"""
        self.client.force_login(self.user)

        view = TableView.objects.create(
            table=self.table,
            name='列元数据数组补丁视图',
            view_type='grid',
            created_by=self.user,
            visible_fields=[
                str(self.title_field.id),
                str(self.status_field.id),
                str(self.date_field.id),
            ],
            field_order=[
                str(self.title_field.id),
                str(self.status_field.id),
                str(self.date_field.id),
            ],
            config={},
        )

        url = f'/api/tabdata/views/{view.id}/column-meta'
        data = [
            {'fieldId': str(self.title_field.id), 'columnMeta': {'order': 0}},
            {'fieldId': str(self.status_field.id), 'columnMeta': {'order': 1}},
            {'fieldId': str(self.date_field.id), 'columnMeta': {'order': 2, 'hidden': True, 'width': 300}},
        ]

        response = self.client.put(
            url,
            data=json.dumps(data),
            content_type='application/json',
            **self._auth_headers()
        )

        self.assertEqual(response.status_code, 200)
        response_data = response.json()
        self.assertTrue(response_data['success'])
        self.assertEqual(
            response_data['data']['config']['column_widths'][str(self.date_field.id)],
            300,
        )
        self.assertNotIn(str(self.date_field.id), response_data['data']['visible_fields'])

    def test_update_view_column_meta_partial_patch_should_merge_and_persist(self):
        """测试列元数据 partial patch：应基于现有元数据合并并持久化"""
        self.client.force_login(self.user)

        title_id = str(self.title_field.id)
        status_id = str(self.status_field.id)
        date_id = str(self.date_field.id)

        view = TableView.objects.create(
            table=self.table,
            name='列元数据 partial patch 视图',
            view_type='grid',
            created_by=self.user,
            visible_fields=[title_id, status_id, date_id],
            field_order=[title_id, status_id, date_id],
            config={'column_widths': {title_id: 180}},
            column_meta={
                title_id: {'order': 0, 'width': 180},
                status_id: {'order': 1},
                date_id: {'order': 2},
            },
        )

        url = f'/api/tabdata/views/{view.id}/column-meta'
        data = {
            'column_meta': {
                status_id: {'hidden': True, 'width': 260},
            }
        }

        response = self.client.put(
            url,
            data=json.dumps(data),
            content_type='application/json',
            **self._auth_headers()
        )

        self.assertEqual(response.status_code, 200)
        response_data = response.json()
        self.assertTrue(response_data['success'])
        updated = response_data['data']

        self.assertEqual(updated['column_meta'][title_id]['width'], 180)
        self.assertEqual(updated['column_meta'][status_id]['hidden'], True)
        self.assertEqual(updated['column_meta'][status_id]['width'], 260)
        self.assertNotIn(status_id, updated['visible_fields'])

        view.refresh_from_db()
        self.assertEqual(view.column_meta[title_id]['width'], 180)
        self.assertEqual(view.column_meta[status_id]['hidden'], True)
        self.assertEqual(view.column_meta[status_id]['width'], 260)

    def test_update_view_visible_fields_should_sync_column_meta(self):
        """测试通用更新 visible_fields/field_order 时，column_meta 会同步重建"""
        self.client.force_login(self.user)

        title_id = str(self.title_field.id)
        status_id = str(self.status_field.id)
        date_id = str(self.date_field.id)

        view = TableView.objects.create(
            table=self.table,
            name='通用更新同步列元数据视图',
            view_type='grid',
            created_by=self.user,
            visible_fields=[title_id, status_id, date_id],
            field_order=[title_id, status_id, date_id],
            config={},
            column_meta={
                title_id: {'order': 0},
                status_id: {'order': 1},
                date_id: {'order': 2},
            },
        )

        url = f'/api/tabdata/views/{view.id}'
        data = {
            'visible_fields': [title_id, date_id],
            'field_order': [title_id, status_id, date_id],
        }

        response = self.client.put(
            url,
            data=json.dumps(data),
            content_type='application/json',
            **self._auth_headers()
        )

        self.assertEqual(response.status_code, 200)
        response_data = response.json()
        self.assertTrue(response_data['success'])
        updated = response_data['data']

        self.assertEqual(updated['visible_fields'], [title_id, date_id])
        self.assertEqual(updated['column_meta'][status_id]['hidden'], True)

        view.refresh_from_db()
        self.assertEqual(view.visible_fields, [title_id, date_id])
        self.assertEqual(view.column_meta[status_id]['hidden'], True)

    def test_update_view_column_meta_reject_hide_primary_field_for_grid(self):
        """测试 grid 视图隐藏主字段被拒绝"""
        self.client.force_login(self.user)

        view = TableView.objects.create(
            table=self.table,
            name='主字段校验视图',
            view_type='grid',
            created_by=self.user,
            visible_fields=[
                str(self.title_field.id),
                str(self.status_field.id),
                str(self.date_field.id),
            ],
            field_order=[
                str(self.title_field.id),
                str(self.status_field.id),
                str(self.date_field.id),
            ],
            config={},
        )

        url = f'/api/tabdata/views/{view.id}/column-meta'
        data = {
            'column_meta': {
                str(self.title_field.id): {'hidden': True},
            }
        }

        response = self.client.put(
            url,
            data=json.dumps(data),
            content_type='application/json',
            **self._auth_headers()
        )

        self.assertEqual(response.status_code, 400)
        response_data = response.json()
        self.assertFalse(response_data['success'])

    # ==================== 视图配置验证API测试 ====================

    def test_validate_view_config_valid(self):
        """测试验证视图配置：合法配置"""
        self.client.force_login(self.user)

        url = '/api/tabdata/views/validate-config'
        data = {
            'table_id': str(self.table.id),
            'view_type': 'kanban',
            'config': {
                'group_by_field': str(self.status_field.id),
                'card_title_field': str(self.title_field.id)
            }
        }

        response = self.client.post(
            url,
            data=json.dumps(data),
            content_type='application/json',
            **self._auth_headers()
        )

        self.assertEqual(response.status_code, 200)
        response_data = response.json()
        self.assertTrue(response_data['success'])
        self.assertTrue(response_data['data']['is_valid'])
        self.assertEqual(len(response_data['data']['errors']), 0)

    def test_validate_view_config_invalid(self):
        """测试验证视图配置：无效配置"""
        self.client.force_login(self.user)

        url = '/api/tabdata/views/validate-config'
        data = {
            'table_id': str(self.table.id),
            'view_type': 'kanban',
            'config': {
                # 缺少 group_by_field
                'card_title_field': str(self.title_field.id)
            }
        }

        response = self.client.post(
            url,
            data=json.dumps(data),
            content_type='application/json',
            **self._auth_headers()
        )

        self.assertEqual(response.status_code, 200)
        response_data = response.json()
        self.assertTrue(response_data['success'])
        self.assertFalse(response_data['data']['is_valid'])
        self.assertGreater(len(response_data['data']['errors']), 0)

    def test_validate_view_config_with_suggestions(self):
        """测试验证视图配置：返回建议"""
        self.client.force_login(self.user)

        url = '/api/tabdata/views/validate-config'
        data = {
            'table_id': str(self.table.id),
            'view_type': 'kanban',
            'config': {
                'group_by_field': str(self.status_field.id),
                'card_title_field': str(self.title_field.id)
            }
        }

        response = self.client.post(
            url,
            data=json.dumps(data),
            content_type='application/json',
            **self._auth_headers()
        )

        self.assertEqual(response.status_code, 200)
        response_data = response.json()
        self.assertIn('suggestions', response_data['data'])
        suggestions = response_data['data']['suggestions']
        self.assertIsInstance(suggestions, dict)

    # ==================== 视图数据查询API测试 ====================

    def test_get_view_records_grid(self):
        """测试获取表格视图数据"""
        self.client.force_login(self.user)

        # 先创建视图
        view = TableView.objects.create(
            table=self.table,
            name='表格视图',
            view_type='grid',
            created_by=self.user,
            config={}
        )

        url = f'/api/tabdata/views/{view.id}/records'
        response = self.client.get(url, **self._auth_headers())

        self.assertEqual(response.status_code, 200)
        response_data = response.json()
        self.assertTrue(response_data['success'])
        self.assertIn('view', response_data['data'])
        self.assertIn('records', response_data['data'])
        self.assertIn('total', response_data['data'])
        self.assertEqual(response_data['data']['total'], 5)

    def test_get_view_records_kanban(self):
        """测试获取看板视图数据"""
        self.client.force_login(self.user)

        view = TableView.objects.create(
            table=self.table,
            name='看板视图',
            view_type='kanban',
            created_by=self.user,
            config={
                'group_by_field': str(self.status_field.id),
                'card_title_field': str(self.title_field.id)
            }
        )

        url = f'/api/tabdata/views/{view.id}/records'
        response = self.client.get(url, **self._auth_headers())

        self.assertEqual(response.status_code, 200)
        response_data = response.json()
        self.assertTrue(response_data['success'])
        self.assertEqual(response_data['data']['metadata']['view_type'], 'kanban')
        self.assertIn('groups', response_data['data']['metadata'])

    def test_get_view_records_calendar_with_date_range(self):
        """测试获取日历视图数据（带日期范围）"""
        self.client.force_login(self.user)

        view = TableView.objects.create(
            table=self.table,
            name='日历视图',
            view_type='calendar',
            created_by=self.user,
            config={
                'date_field': str(self.date_field.id),
                'title_field': str(self.title_field.id)
            }
        )

        today = date.today()
        end_date = today + timedelta(days=10)
        date_range = f"{today.isoformat()},{end_date.isoformat()}"

        url = f'/api/tabdata/views/{view.id}/records?date_range={date_range}'
        response = self.client.get(url, **self._auth_headers())

        self.assertEqual(response.status_code, 200)
        response_data = response.json()
        self.assertTrue(response_data['success'])
        self.assertEqual(response_data['data']['metadata']['view_type'], 'calendar')
        self.assertIn('date_range', response_data['data']['metadata'])

    def test_get_view_records_gallery(self):
        """测试获取画廊视图数据"""
        self.client.force_login(self.user)

        view = TableView.objects.create(
            table=self.table,
            name='画廊视图',
            view_type='gallery',
            created_by=self.user,
            config={
                'title_field': str(self.title_field.id),
                'card_size': 'medium',
                'cards_per_row': 3
            }
        )

        url = f'/api/tabdata/views/{view.id}/records'
        response = self.client.get(url, **self._auth_headers())

        self.assertEqual(response.status_code, 200)
        response_data = response.json()
        self.assertTrue(response_data['success'])
        self.assertEqual(response_data['data']['metadata']['view_type'], 'gallery')
        self.assertIn('grid_layout', response_data['data']['metadata'])
        self.assertEqual(response_data['data']['metadata']['grid_layout']['columns'], 3)

    def test_get_view_records_pagination(self):
        """测试视图数据分页"""
        self.client.force_login(self.user)

        view = TableView.objects.create(
            table=self.table,
            name='表格视图',
            view_type='grid',
            created_by=self.user,
            config={}
        )

        # 第一页
        url = f'/api/tabdata/views/{view.id}/records?page=1&page_size=2'
        response = self.client.get(url, **self._auth_headers())

        self.assertEqual(response.status_code, 200)
        response_data = response.json()
        self.assertEqual(len(response_data['data']['records']), 2)
        self.assertEqual(response_data['data']['page'], 1)

        # 第二页
        url = f'/api/tabdata/views/{view.id}/records?page=2&page_size=2'
        response = self.client.get(url, **self._auth_headers())

        self.assertEqual(response.status_code, 200)
        response_data = response.json()
        self.assertEqual(len(response_data['data']['records']), 2)
        self.assertEqual(response_data['data']['page'], 2)

    def test_get_view_records_not_found(self):
        """测试获取不存在的视图数据"""
        self.client.force_login(self.user)

        url = '/api/tabdata/views/00000000-0000-0000-0000-000000000000/records'
        response = self.client.get(url, **self._auth_headers())

        # 应该返回404或错误
        self.assertIn(response.status_code, [400, 404, 500])

    def test_get_view_records_with_query_overrides_should_not_return_304(self):
        """测试带查询覆写参数时不应返回304（即使If-None-Match命中）"""
        self.client.force_login(self.user)

        view = TableView.objects.create(
            table=self.table,
            name='表格视图',
            view_type='grid',
            created_by=self.user,
            config={}
        )

        url = f'/api/tabdata/views/{view.id}/records'

        first_response = self.client.get(url, **self._auth_headers())
        self.assertEqual(first_response.status_code, 200)
        etag = first_response.headers.get('ETag')
        self.assertIsNotNone(etag)
        self.assertIn(':', str(etag))

        baseline_304 = self.client.get(
            url,
            HTTP_IF_NONE_MATCH=etag,
            **self._auth_headers()
        )
        self.assertEqual(baseline_304.status_code, 304)

        grouped_response = self.client.get(
            url,
            data={
                'groups': json.dumps([
                    {
                        'field_id': str(self.status_field.id),
                        'direction': 'desc',
                    }
                ])
            },
            HTTP_IF_NONE_MATCH=etag,
            **self._auth_headers()
        )
        self.assertEqual(grouped_response.status_code, 200)
        grouped_data = grouped_response.json()
        self.assertTrue(grouped_data['success'])
        self.assertIn('groups', grouped_data['data']['metadata'])

        page2_response = self.client.get(
            url,
            data={
                'page': 2,
                'page_size': 2,
            },
            HTTP_IF_NONE_MATCH=etag,
            **self._auth_headers()
        )
        self.assertEqual(page2_response.status_code, 200)
        page2_etag = page2_response.headers.get('ETag')
        self.assertIsNotNone(page2_etag)
        self.assertNotEqual(page2_etag, etag)

        page2_304 = self.client.get(
            url,
            data={
                'page': 2,
                'page_size': 2,
            },
            HTTP_IF_NONE_MATCH=page2_etag,
            **self._auth_headers()
        )
        self.assertEqual(page2_304.status_code, 304)

    def test_get_view_records_invalid_search_hide_not_match_rows(self):
        """测试 search_hide_not_match_rows 参数非法时返回 400"""
        self.client.force_login(self.user)

        view = TableView.objects.create(
            table=self.table,
            name='搜索参数校验视图',
            view_type='grid',
            created_by=self.user,
            config={},
        )

        response = self.client.get(
            f'/api/tabdata/views/{view.id}/records',
            data={
                'search': '任务',
                'search_hide_not_match_rows': 'not-a-bool',
            },
            **self._auth_headers()
        )

        self.assertEqual(response.status_code, 400)
        payload = response.json()
        self.assertFalse(payload.get('success', True))
        self.assertIn('search_hide_not_match_rows', payload.get('message', ''))

    @skipUnless(connection.vendor == 'postgresql', 'Requires PostgreSQL (native SQL uses :: cast)')
    def test_get_view_records_sub_record_search_hide_not_match_rows_keeps_parent_chain(self):
        """测试 API 在子记录模式搜索隐藏不匹配行时会返回完整父链"""
        self.client.force_login(self.user)

        parent_field = TableField.objects.create(
            table=self.table,
            name='父记录',
            field_type='link',
            order=20,
            config={
                'foreignTableId': str(self.table.id),
                'relationship': 'ManyOne',
                'isOneWay': True,
                'isSubRecordParentField': True,
            },
        )

        root = TableRecord.objects.create(
            table=self.table,
            created_by=self.user,
            data={str(self.title_field.id): 'Root'},
            order=100,
        )
        parent = TableRecord.objects.create(
            table=self.table,
            created_by=self.user,
            data={str(self.title_field.id): 'Parent'},
            order=101,
        )
        child = TableRecord.objects.create(
            table=self.table,
            created_by=self.user,
            data={str(self.title_field.id): 'Match Child'},
            order=102,
        )
        unrelated = TableRecord.objects.create(
            table=self.table,
            created_by=self.user,
            data={str(self.title_field.id): 'Unrelated'},
            order=103,
        )

        LinkRecord.objects.create(
            link_field=parent_field,
            self_record=parent,
            foreign_record=root,
            order=0,
        )
        LinkRecord.objects.create(
            link_field=parent_field,
            self_record=child,
            foreign_record=parent,
            order=0,
        )

        view = TableView.objects.create(
            table=self.table,
            name='子记录搜索视图',
            view_type='grid',
            created_by=self.user,
            config={'subRecordParentFieldId': str(parent_field.id)},
        )

        response = self.client.get(
            f'/api/tabdata/views/{view.id}/records',
            data={
                'search': 'Match',
                'search_field_ids': str(self.title_field.id),
                'search_hide_not_match_rows': 'true',
                'field_key_type': 'id',
                'page': 1,
                'page_size': 50,
            },
            **self._auth_headers()
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload['success'])

        response_data = payload['data']
        returned_ids = [record['id'] for record in response_data['records']]
        self.assertEqual(returned_ids, [str(root.id), str(parent.id), str(child.id)])
        self.assertNotIn(str(unrelated.id), returned_ids)

        tree_data = (
            response_data.get('metadata', {})
            .get('sub_records', {})
            .get('tree_data', {})
        )
        self.assertEqual(tree_data.get(str(root.id), {}).get('depth'), 0)
        self.assertEqual(tree_data.get(str(parent.id), {}).get('depth'), 1)
        self.assertEqual(tree_data.get(str(child.id), {}).get('depth'), 2)

    # ==================== 权限测试 ====================

    def test_create_view_without_permission(self):
        """测试无权限创建视图"""
        # 创建另一个用户
        other_user = User.objects.create_user(
            phone='13800000005',
            nickname='无权限用户'
        )
        self.client.force_login(other_user)
        other_token = generate_jwt_token(other_user, expire_hours=1, token_type='access')

        url = '/api/tabdata/views'
        data = {
            'table_id': str(self.table.id),
            'name': '无权限视图',
            'view_type': 'grid',
            'config': {}
        }

        response = self.client.post(
            url,
            data=json.dumps(data),
            content_type='application/json',
            HTTP_AUTHORIZATION=f'Bearer {other_token}',
        )

        # 应该返回403或无法创建
        self.assertEqual(response.status_code, 403)
