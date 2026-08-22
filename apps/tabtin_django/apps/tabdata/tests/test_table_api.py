"""
Table API 完整测试用例

测试 Table 相关的所有 API 端点，包括：
1. Table CRUD 操作
2. Field 管理操作
3. Record 增删改查
4. 批量操作
5. 权限验证
6. 数据验证
"""

import json
import uuid
from decimal import Decimal
from django.test import TestCase, Client
from django.contrib.auth import get_user_model
from datetime import datetime, date

from apps.tabtinspace.models import Organization, OrganizationMember, Space
from apps.tabdata.models import Table, TableField, TableRecord, RecordHistory

User = get_user_model()


class TableAPITest(TestCase):
    """表格 API 基础测试"""

    databases = ['default', 'postgresql']

    def setUp(self):
        """设置测试数据"""
        self.client = Client()

        # 创建测试用户
        self.owner = User.objects.using('default').create_user(
            username='table_owner',
            email='owner@test.com',
            password='testpass123'
        )

        self.editor = User.objects.using('default').create_user(
            username='table_editor',
            email='editor@test.com',
            password='testpass123'
        )

        self.viewer = User.objects.using('default').create_user(
            username='table_viewer',
            email='viewer@test.com',
            password='testpass123'
        )

        # 创建组织
        self.organization = Organization.objects.create(
            name='测试组织',
            description='Table API 测试',
            owner_id=str(self.owner.id)
        )

        # 添加成员
        OrganizationMember.objects.create(
            organization=self.organization,
            user_id=str(self.editor.id),
            role='editor'
        )

        OrganizationMember.objects.create(
            organization=self.organization,
            user_id=str(self.viewer.id),
            role='viewer'
        )

        # 创建项目
        self.space = Space.objects.create(
            organization=self.organization,
            name='测试项目',
            description='Table API 测试项目',
            goal='测试 Table 功能'
        )

        # 创建表格
        self.table = Table.objects.create(
            project_id=self.space.id,
            organization_id=self.space.organization_id,
            name='测试表格',
            description='用于测试的表格',
            owner_id=str(self.owner.id),
            icon='📊'
        )

        # 创建主键字段
        self.pk_field = TableField.objects.create(
            table=self.table,
            name='ID',
            field_type='text',
            is_primary=True,
            sort_order=0
        )

        # 默认使用 owner 登录
        self.client.force_login(self.owner)

    def test_list_tables_in_organization(self):
        """测试获取组织的表格列表"""
        # 创建额外表格
        Table.objects.create(
            project_id=self.space.id,
            organization_id=self.space.organization_id,
            name='表格2',
            owner_id=str(self.owner.id)
        )

        response = self.client.get(
            f'/api/tabdata/organizations/{self.organization.id}/tables'
        )

        self.assertEqual(response.status_code, 200)
        data = response.json()

        self.assertEqual(data['total'], 2)
        self.assertEqual(len(data['tables']), 2)

        # 验证表格数据
        table_names = [t['name'] for t in data['tables']]
        self.assertIn('测试表格', table_names)
        self.assertIn('表格2', table_names)

    def test_list_tables_with_search(self):
        """测试表格搜索"""
        Table.objects.create(
            project_id=self.space.id,
            organization_id=self.space.organization_id,
            name='用户数据表',
            description='存储用户信息',
            owner_id=str(self.owner.id)
        )

        response = self.client.get(
            f'/api/tabdata/organizations/{self.organization.id}/tables',
            {'search': '用户'}
        )

        self.assertEqual(response.status_code, 200)
        data = response.json()

        self.assertEqual(data['total'], 1)
        self.assertEqual(data['tables'][0]['name'], '用户数据表')

    def test_list_archived_tables(self):
        """测试查询已归档表格"""
        archived_table = Table.objects.create(
            project_id=self.space.id,
            organization_id=self.space.organization_id,
            name='归档表格',
            owner_id=str(self.owner.id),
            is_archived=True
        )

        # 查询归档表格
        response = self.client.get(
            f'/api/tabdata/organizations/{self.organization.id}/tables',
            {'is_archived': 'true'}
        )

        self.assertEqual(response.status_code, 200)
        data = response.json()

        self.assertEqual(data['total'], 1)
        self.assertEqual(data['tables'][0]['name'], '归档表格')
        self.assertTrue(data['tables'][0]['is_archived'])

    def test_get_table_detail(self):
        """测试获取表格详情"""
        response = self.client.get(f'/api/tabdata/tables/{self.table.id}')

        self.assertEqual(response.status_code, 200)
        data = response.json()

        self.assertEqual(data['id'], str(self.table.id))
        self.assertEqual(data['name'], '测试表格')
        self.assertEqual(data['description'], '用于测试的表格')
        self.assertEqual(data['organization_id'], str(self.organization.id))
        self.assertEqual(data['icon'], '📊')
        self.assertFalse(data['is_archived'])

    def test_get_table_not_found(self):
        """测试获取不存在的表格"""
        fake_id = uuid.uuid4()
        response = self.client.get(f'/api/tabdata/tables/{fake_id}')

        self.assertEqual(response.status_code, 404)
        data = response.json()
        self.assertFalse(data['success'])
        self.assertIn('不存在', data['message'])

    def test_create_table(self):
        """测试创建表格"""
        table_data = {
            'organization_id': str(self.organization.id),
            'name': '新建表格',
            'description': '这是一个新建的表格',
            'icon': '📝'
        }

        response = self.client.post(
            '/api/tabdata/tables',
            data=json.dumps(table_data),
            content_type='application/json'
        )

        self.assertEqual(response.status_code, 201)
        data = response.json()

        self.assertEqual(data['name'], '新建表格')
        self.assertEqual(data['description'], '这是一个新建的表格')
        self.assertEqual(data['icon'], '📝')

        # 验证数据库
        table = Table.objects.get(id=data['id'])
        self.assertEqual(table.name, '新建表格')
        self.assertEqual(str(table.owner_id), str(self.owner.id))

        # 验证自动创建了主键字段
        pk_field = TableField.objects.filter(
            table=table,
            is_primary=True
        ).first()
        self.assertIsNotNone(pk_field)
        self.assertEqual(pk_field.name, 'ID')

    def test_create_table_invalid_data(self):
        """测试创建表格 - 无效数据"""
        table_data = {
            'organization_id': str(self.organization.id),
            'name': '',  # 空名称
        }

        response = self.client.post(
            '/api/tabdata/tables',
            data=json.dumps(table_data),
            content_type='application/json'
        )

        self.assertEqual(response.status_code, 400)

    def test_create_table_no_permission(self):
        """测试创建表格 - 无权限"""
        self.client.force_login(self.viewer)

        table_data = {
            'organization_id': str(self.organization.id),
            'name': '尝试创建表格',
        }

        response = self.client.post(
            '/api/tabdata/tables',
            data=json.dumps(table_data),
            content_type='application/json'
        )

        self.assertEqual(response.status_code, 403)

    def test_update_table(self):
        """测试更新表格"""
        update_data = {
            'name': '更新后的表格名称',
            'description': '更新后的描述',
            'icon': '🎯'
        }

        response = self.client.put(
            f'/api/tabdata/tables/{self.table.id}',
            data=json.dumps(update_data),
            content_type='application/json'
        )

        self.assertEqual(response.status_code, 200)
        data = response.json()

        self.assertEqual(data['name'], '更新后的表格名称')
        self.assertEqual(data['description'], '更新后的描述')
        self.assertEqual(data['icon'], '🎯')

        # 验证数据库
        self.table.refresh_from_db()
        self.assertEqual(self.table.name, '更新后的表格名称')

    def test_update_table_partial(self):
        """测试部分更新表格"""
        update_data = {
            'name': '仅更新名称',
        }

        response = self.client.put(
            f'/api/tabdata/tables/{self.table.id}',
            data=json.dumps(update_data),
            content_type='application/json'
        )

        self.assertEqual(response.status_code, 200)
        data = response.json()

        self.assertEqual(data['name'], '仅更新名称')
        # 描述应该保持不变
        self.assertEqual(data['description'], '用于测试的表格')

    def test_archive_table(self):
        """测试归档表格"""
        response = self.client.post(
            f'/api/tabdata/tables/{self.table.id}/archive'
        )

        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertTrue(data['success'])

        # 验证数据库
        self.table.refresh_from_db()
        self.assertTrue(self.table.is_archived)

    def test_restore_table(self):
        """测试恢复归档的表格"""
        # 先归档
        self.table.is_archived = True
        self.table.save()

        response = self.client.post(
            f'/api/tabdata/tables/{self.table.id}/restore'
        )

        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertTrue(data['success'])

        # 验证数据库
        self.table.refresh_from_db()
        self.assertFalse(self.table.is_archived)

    def test_delete_table(self):
        """测试删除表格"""
        table_id = self.table.id

        response = self.client.delete(f'/api/tabdata/tables/{table_id}')

        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertTrue(data['success'])

        # 验证已删除
        self.assertFalse(Table.objects.filter(id=table_id).exists())

    def test_delete_table_no_permission(self):
        """测试删除表格 - 无权限"""
        self.client.force_login(self.editor)

        response = self.client.delete(f'/api/tabdata/tables/{self.table.id}')

        self.assertEqual(response.status_code, 403)

        # 验证未删除
        self.assertTrue(Table.objects.filter(id=self.table.id).exists())


class TableFieldAPITest(TestCase):
    """字段 API 测试"""

    databases = ['default', 'postgresql']

    def setUp(self):
        """设置测试数据"""
        self.client = Client()

        # 创建测试用户
        self.user = User.objects.using('default').create_user(
            username='field_tester',
            email='field@test.com',
            password='testpass123'
        )

        # 创建组织和项目
        self.organization = Organization.objects.create(
            name='字段测试空间',
            owner_id=str(self.user.id)
        )

        self.space = Space.objects.create(
            organization=self.organization,
            name='字段测试项目'
        )

        # 创建表格
        self.table = Table.objects.create(
            project_id=self.space.id,
            organization_id=self.space.organization_id,
            name='字段测试表',
            owner_id=str(self.user.id)
        )

        # 创建主键字段
        self.pk_field = TableField.objects.create(
            table=self.table,
            name='ID',
            field_type='text',
            is_primary=True,
            sort_order=0
        )

        self.client.force_login(self.user)

    def test_list_fields(self):
        """测试获取字段列表"""
        # 创建额外字段
        TableField.objects.create(
            table=self.table,
            name='用户名',
            field_type='text',
            sort_order=1
        )

        TableField.objects.create(
            table=self.table,
            name='年龄',
            field_type='number',
            sort_order=2
        )

        response = self.client.get(
            f'/api/tabdata/tables/{self.table.id}/fields'
        )

        self.assertEqual(response.status_code, 200)
        data = response.json()

        self.assertEqual(data['total'], 3)
        self.assertEqual(len(data['fields']), 3)
        self.assertIn('schema_version', data)
        self.assertEqual(data['schema_version'], self.table.schema_version)

        # 验证排序
        field_names = [f['name'] for f in data['fields']]
        self.assertEqual(field_names, ['ID', '用户名', '年龄'])

    def test_get_field_detail(self):
        """测试获取字段详情"""
        field = TableField.objects.create(
            table=self.table,
            name='邮箱',
            field_type='email',
            description='用户邮箱地址',
            sort_order=1
        )

        response = self.client.get(f'/api/tabdata/fields/{field.id}')

        self.assertEqual(response.status_code, 200)
        data = response.json()

        self.assertEqual(data['name'], '邮箱')
        self.assertEqual(data['field_type'], 'email')
        self.assertEqual(data['description'], '用户邮箱地址')
        self.assertFalse(data['is_primary'])

    def test_create_text_field(self):
        """测试创建文本字段"""
        field_data = {
            'table_id': str(self.table.id),
            'name': '姓名',
            'field_type': 'text',
            'description': '用户姓名'
        }

        response = self.client.post(
            '/api/tabdata/fields',
            data=json.dumps(field_data),
            content_type='application/json'
        )

        self.assertEqual(response.status_code, 201)
        data = response.json()

        self.assertEqual(data['name'], '姓名')
        self.assertEqual(data['field_type'], 'text')
        self.assertEqual(data['description'], '用户姓名')

    def test_create_number_field(self):
        """测试创建数字字段"""
        field_data = {
            'table_id': str(self.table.id),
            'name': '价格',
            'field_type': 'number',
            'description': '商品价格',
            'options': {
                'precision': 2,
                'format': 'currency'
            }
        }

        response = self.client.post(
            '/api/tabdata/fields',
            data=json.dumps(field_data),
            content_type='application/json'
        )

        self.assertEqual(response.status_code, 201)
        data = response.json()

        self.assertEqual(data['name'], '价格')
        self.assertEqual(data['field_type'], 'number')
        self.assertEqual(data['options']['precision'], 2)

    def test_create_select_field(self):
        """测试创建单选字段"""
        field_data = {
            'table_id': str(self.table.id),
            'name': '状态',
            'field_type': 'select',
            'options': {
                'choices': ['待处理', '进行中', '已完成']
            }
        }

        response = self.client.post(
            '/api/tabdata/fields',
            data=json.dumps(field_data),
            content_type='application/json'
        )

        self.assertEqual(response.status_code, 201)
        data = response.json()

        self.assertEqual(data['field_type'], 'select')
        self.assertEqual(len(data['options']['choices']), 3)

    def test_create_date_field(self):
        """测试创建日期字段"""
        field_data = {
            'table_id': str(self.table.id),
            'name': '创建日期',
            'field_type': 'date',
            'description': '记录创建日期'
        }

        response = self.client.post(
            '/api/tabdata/fields',
            data=json.dumps(field_data),
            content_type='application/json'
        )

        self.assertEqual(response.status_code, 201)
        data = response.json()

        self.assertEqual(data['field_type'], 'date')

    def test_update_field(self):
        """测试更新字段"""
        field = TableField.objects.create(
            table=self.table,
            name='旧名称',
            field_type='text',
            sort_order=1
        )

        update_data = {
            'name': '新名称',
            'description': '更新后的描述',
        }

        response = self.client.put(
            f'/api/tabdata/fields/{field.id}',
            data=json.dumps(update_data),
            content_type='application/json'
        )

        self.assertEqual(response.status_code, 200)
        data = response.json()

        self.assertEqual(data['name'], '新名称')
        self.assertEqual(data['description'], '更新后的描述')

    def test_reorder_fields(self):
        """测试字段重新排序"""
        field1 = TableField.objects.create(
            table=self.table,
            name='字段1',
            field_type='text',
            sort_order=1
        )

        field2 = TableField.objects.create(
            table=self.table,
            name='字段2',
            field_type='text',
            sort_order=2
        )

        reorder_data = {
            'field_orders': [
                {'field_id': str(self.pk_field.id), 'sort_order': 0},
                {'field_id': str(field2.id), 'sort_order': 1},
                {'field_id': str(field1.id), 'sort_order': 2},
            ]
        }

        response = self.client.post(
            f'/api/tabdata/tables/{self.table.id}/fields/reorder',
            data=json.dumps(reorder_data),
            content_type='application/json'
        )

        self.assertEqual(response.status_code, 200)

        # 验证排序
        field1.refresh_from_db()
        field2.refresh_from_db()

        self.assertEqual(field2.sort_order, 1)
        self.assertEqual(field1.sort_order, 2)

    def test_delete_field(self):
        """测试删除字段"""
        field = TableField.objects.create(
            table=self.table,
            name='可删除字段',
            field_type='text',
            sort_order=1
        )

        field_id = field.id

        response = self.client.delete(f'/api/tabdata/fields/{field_id}')

        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertTrue(data['success'])

        # 验证软删除
        field.refresh_from_db()
        self.assertTrue(field.is_deleted)

    def test_delete_primary_field(self):
        """测试删除主键字段 - 应该失败"""
        response = self.client.delete(f'/api/tabdata/fields/{self.pk_field.id}')

        self.assertEqual(response.status_code, 403)

        # 验证未删除
        self.pk_field.refresh_from_db()
        self.assertFalse(self.pk_field.is_deleted)

    def _create_link_field_fixture(self):
        """创建 linkable-records 测试夹具"""
        foreign_table = Table.objects.create(
            project_id=self.space.id,
            organization_id=self.space.organization_id,
            name='关联目标表',
            owner_id=str(self.user.id),
        )
        foreign_primary = TableField.objects.create(
            table=foreign_table,
            name='标题',
            field_type='text',
            is_primary=True,
            sort_order=0,
        )
        foreign_extra = TableField.objects.create(
            table=foreign_table,
            name='分数',
            field_type='number',
            sort_order=1,
        )

        record_a = TableRecord.objects.create(
            table=foreign_table,
            data={
                str(foreign_primary.id): 'A',
                str(foreign_extra.id): 10,
            },
            order=1,
        )
        record_b = TableRecord.objects.create(
            table=foreign_table,
            data={
                str(foreign_primary.id): 'B',
                str(foreign_extra.id): 20,
            },
            order=2,
        )
        record_c = TableRecord.objects.create(
            table=foreign_table,
            data={
                str(foreign_primary.id): 'C',
                str(foreign_extra.id): 30,
            },
            order=3,
        )

        link_field = TableField.objects.create(
            table=self.table,
            name='关联项',
            field_type='link',
            sort_order=1,
            config={
                'foreignTableId': str(foreign_table.id),
                'relationship': 'ManyMany',
                'lookupFieldId': str(foreign_primary.id),
            },
        )

        return link_field, record_a, record_b, record_c

    def test_get_linkable_records_excludes_selected_record_ids(self):
        """候选模式应排除 selected_record_ids"""
        link_field, record_a, record_b, record_c = self._create_link_field_fixture()

        response = self.client.get(
            f'/api/tabdata/tables/{self.table.id}/fields/{link_field.id}/linkable-records',
            {
                'selected_record_ids': f'{record_a.id},{record_c.id}',
                'page': 1,
                'page_size': 50,
            },
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload.get('success'))
        data = payload.get('data') or {}
        self.assertEqual(data.get('total'), 1)
        records = data.get('records') or []
        self.assertEqual([item['id'] for item in records], [str(record_b.id)])

    def test_get_linkable_records_only_selected_keeps_order(self):
        """only_selected 模式应保持 selected_record_ids 顺序"""
        link_field, record_a, _, record_c = self._create_link_field_fixture()

        selected_ids = f'{record_c.id},{record_a.id}'
        response = self.client.get(
            f'/api/tabdata/tables/{self.table.id}/fields/{link_field.id}/linkable-records',
            {
                'selected_record_ids': selected_ids,
                'only_selected': 'true',
                'page': 1,
                'page_size': 50,
            },
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload.get('success'))
        data = payload.get('data') or {}
        self.assertEqual(data.get('total'), 2)
        records = data.get('records') or []
        self.assertEqual([item['id'] for item in records], [str(record_c.id), str(record_a.id)])

    def test_get_linkable_records_invalid_selected_record_ids(self):
        """selected_record_ids 含非法 UUID 应返回 400"""
        link_field, _, _, _ = self._create_link_field_fixture()

        response = self.client.get(
            f'/api/tabdata/tables/{self.table.id}/fields/{link_field.id}/linkable-records',
            {
                'selected_record_ids': 'not-a-uuid',
            },
        )

        self.assertEqual(response.status_code, 400)
        payload = response.json()
        self.assertFalse(payload.get('success'))
        self.assertIn('selected_record_ids', payload.get('message', ''))

    def test_get_linkable_records_only_selected_with_pagination(self):
        """only_selected 模式应按 selected 顺序分页"""
        link_field, record_a, _, record_c = self._create_link_field_fixture()
        selected_ids = f'{record_c.id},{record_a.id}'

        first_page = self.client.get(
            f'/api/tabdata/tables/{self.table.id}/fields/{link_field.id}/linkable-records',
            {
                'selected_record_ids': selected_ids,
                'only_selected': 'true',
                'page': 1,
                'page_size': 1,
            },
        )
        second_page = self.client.get(
            f'/api/tabdata/tables/{self.table.id}/fields/{link_field.id}/linkable-records',
            {
                'selected_record_ids': selected_ids,
                'only_selected': 'true',
                'page': 2,
                'page_size': 1,
            },
        )

        self.assertEqual(first_page.status_code, 200)
        self.assertEqual(second_page.status_code, 200)

        first_payload = first_page.json()
        second_payload = second_page.json()
        self.assertTrue(first_payload.get('success'))
        self.assertTrue(second_payload.get('success'))

        first_data = first_payload.get('data') or {}
        second_data = second_payload.get('data') or {}
        self.assertEqual(first_data.get('total'), 2)
        self.assertEqual(second_data.get('total'), 2)
        self.assertEqual([item['id'] for item in first_data.get('records', [])], [str(record_c.id)])
        self.assertEqual([item['id'] for item in second_data.get('records', [])], [str(record_a.id)])


class TableRecordAPITest(TestCase):
    """记录 API 测试"""

    databases = ['default', 'postgresql']

    def setUp(self):
        """设置测试数据"""
        self.client = Client()

        # 创建测试用户
        self.user = User.objects.using('default').create_user(
            username='record_tester',
            email='record@test.com',
            password='testpass123'
        )

        # 创建组织和项目
        self.organization = Organization.objects.create(
            name='记录测试空间',
            owner_id=str(self.user.id)
        )

        self.space = Space.objects.create(
            organization=self.organization,
            name='记录测试项目'
        )

        # 创建表格
        self.table = Table.objects.create(
            project_id=self.space.id,
            organization_id=self.space.organization_id,
            name='用户表',
            owner_id=str(self.user.id)
        )

        # 创建字段
        self.field_id = TableField.objects.create(
            table=self.table,
            name='ID',
            field_type='text',
            is_primary=True,
            sort_order=0
        )

        self.field_name = TableField.objects.create(
            table=self.table,
            name='姓名',
            field_type='text',
            sort_order=1
        )

        self.field_age = TableField.objects.create(
            table=self.table,
            name='年龄',
            field_type='number',
            sort_order=2
        )

        self.field_email = TableField.objects.create(
            table=self.table,
            name='邮箱',
            field_type='email',
            sort_order=3
        )

        self.client.force_login(self.user)

    def test_create_record(self):
        """测试创建记录"""
        record_data = {
            'table_id': str(self.table.id),
            'data': {
                '姓名': '张三',
                '年龄': 25,
                '邮箱': 'zhangsan@example.com'
            }
        }

        response = self.client.post(
            '/api/tabdata/records',
            data=json.dumps(record_data),
            content_type='application/json'
        )

        self.assertEqual(response.status_code, 201)
        data = response.json()

        self.assertIn('id', data)
        self.assertEqual(data['data']['姓名'], '张三')
        self.assertEqual(data['data']['年龄'], 25)

        # 验证数据库
        record = TableRecord.objects.get(id=data['id'])
        self.assertEqual(record.data['姓名'], '张三')

    def test_create_record_with_order_context_after_anchor(self):
        """测试创建记录 - 指定锚点后插入"""
        anchor = TableRecord.objects.create(
            table=self.table,
            data={'姓名': '锚点记录', '年龄': 20},
            order=1024,
            created_by_id=str(self.user.id),
        )
        tail = TableRecord.objects.create(
            table=self.table,
            data={'姓名': '尾部记录', '年龄': 30},
            order=2048,
            created_by_id=str(self.user.id),
        )

        record_data = {
            'table_id': str(self.table.id),
            'data': {
                '姓名': '插入记录',
                '年龄': 25,
            },
            'order_context': {
                'anchor_record_id': str(anchor.id),
                'position': 'after',
            },
        }

        response = self.client.post(
            '/api/tabdata/records',
            data=json.dumps(record_data),
            content_type='application/json'
        )

        self.assertEqual(response.status_code, 201)
        data = response.json()
        created_record = TableRecord.objects.get(id=data['id'])
        self.assertGreater(created_record.order, anchor.order)
        self.assertLess(created_record.order, tail.order)

    def test_create_record_with_order_context_before_anchor(self):
        """测试创建记录 - 指定锚点前插入"""
        head = TableRecord.objects.create(
            table=self.table,
            data={'姓名': '头部记录', '年龄': 20},
            order=1024,
            created_by_id=str(self.user.id),
        )
        anchor = TableRecord.objects.create(
            table=self.table,
            data={'姓名': '锚点记录', '年龄': 30},
            order=2048,
            created_by_id=str(self.user.id),
        )

        record_data = {
            'table_id': str(self.table.id),
            'data': {
                '姓名': '插入记录',
                '年龄': 25,
            },
            'order_context': {
                'anchor_record_id': str(anchor.id),
                'position': 'before',
            },
        }

        response = self.client.post(
            '/api/tabdata/records',
            data=json.dumps(record_data),
            content_type='application/json'
        )

        self.assertEqual(response.status_code, 201)
        data = response.json()
        created_record = TableRecord.objects.get(id=data['id'])
        self.assertGreater(created_record.order, head.order)
        self.assertLess(created_record.order, anchor.order)

    def test_create_record_with_invalid_anchor_record_id(self):
        """测试创建记录 - 锚点不存在时返回错误"""
        record_data = {
            'table_id': str(self.table.id),
            'data': {
                '姓名': '插入记录',
                '年龄': 25,
            },
            'order_context': {
                'anchor_record_id': str(uuid.uuid4()),
                'position': 'after',
            },
        }

        response = self.client.post(
            '/api/tabdata/records',
            data=json.dumps(record_data),
            content_type='application/json'
        )

        self.assertEqual(response.status_code, 400)
        data = response.json()
        self.assertIn('锚点记录', data['message'])

    def test_create_record_missing_legacy_required_field(self):
        """历史必填字段缺值不再阻断创建记录。"""
        record_data = {
            'table_id': str(self.table.id),
            'data': {
                '年龄': 30  # 缺少必填的"姓名"字段
            }
        }

        response = self.client.post(
            '/api/tabdata/records',
            data=json.dumps(record_data),
            content_type='application/json'
        )

        self.assertEqual(response.status_code, 201)

    def test_create_record_invalid_type(self):
        """测试创建记录 - 字段类型错误"""
        record_data = {
            'table_id': str(self.table.id),
            'data': {
                '姓名': '李四',
                '年龄': '不是数字',  # 应该是数字类型
            }
        }

        response = self.client.post(
            '/api/tabdata/records',
            data=json.dumps(record_data),
            content_type='application/json'
        )

        self.assertEqual(response.status_code, 400)
        data = response.json()
        self.assertIn('类型', data['message'])

    def test_list_records(self):
        """测试获取记录列表"""
        # 创建测试记录
        for i in range(5):
            TableRecord.objects.create(
                table=self.table,
                data={
                    '姓名': f'用户{i}',
                    '年龄': 20 + i
                },
                created_by_id=str(self.user.id)
            )

        response = self.client.get(
            f'/api/tabdata/tables/{self.table.id}/records'
        )

        self.assertEqual(response.status_code, 200)
        data = response.json()

        self.assertEqual(data['total'], 5)
        self.assertEqual(len(data['records']), 5)
        self.assertEqual(data['page'], 1)

    def test_list_records_with_pagination(self):
        """测试记录分页"""
        # 创建10条记录
        for i in range(10):
            TableRecord.objects.create(
                table=self.table,
                data={'姓名': f'用户{i}', '年龄': 20 + i},
                created_by_id=str(self.user.id)
            )

        # 获取第2页，每页3条
        response = self.client.get(
            f'/api/tabdata/tables/{self.table.id}/records',
            {'page': 2, 'page_size': 3}
        )

        self.assertEqual(response.status_code, 200)
        data = response.json()

        self.assertEqual(data['total'], 10)
        self.assertEqual(len(data['records']), 3)
        self.assertEqual(data['page'], 2)
        self.assertEqual(data['page_size'], 3)

    def test_list_records_with_search(self):
        """测试记录搜索"""
        TableRecord.objects.create(
            table=self.table,
            data={'姓名': '张三丰', '年龄': 108},
            created_by_id=str(self.user.id)
        )

        TableRecord.objects.create(
            table=self.table,
            data={'姓名': '李小龙', '年龄': 32},
            created_by_id=str(self.user.id)
        )

        response = self.client.get(
            f'/api/tabdata/tables/{self.table.id}/records',
            {'search': '张三'}
        )

        self.assertEqual(response.status_code, 200)
        data = response.json()

        self.assertEqual(data['total'], 1)
        self.assertEqual(data['records'][0]['data']['姓名'], '张三丰')

    def test_list_records_with_sort(self):
        """测试记录排序"""
        TableRecord.objects.create(
            table=self.table,
            data={'姓名': '张三', '年龄': 30},
            created_by_id=str(self.user.id)
        )

        TableRecord.objects.create(
            table=self.table,
            data={'姓名': '李四', '年龄': 25},
            created_by_id=str(self.user.id)
        )

        TableRecord.objects.create(
            table=self.table,
            data={'姓名': '王五', '年龄': 35},
            created_by_id=str(self.user.id)
        )

        # 按年龄升序
        response = self.client.get(
            f'/api/tabdata/tables/{self.table.id}/records',
            {'sort_by': '年龄', 'sort_order': 'asc'}
        )

        self.assertEqual(response.status_code, 200)
        data = response.json()

        ages = [r['data']['年龄'] for r in data['records']]
        self.assertEqual(ages, [25, 30, 35])

    def test_get_record_detail(self):
        """测试获取记录详情"""
        record = TableRecord.objects.create(
            table=self.table,
            data={
                '姓名': '测试用户',
                '年龄': 28,
                '邮箱': 'test@example.com'
            },
            created_by_id=str(self.user.id)
        )

        response = self.client.get(f'/api/tabdata/records/{record.id}')

        self.assertEqual(response.status_code, 200)
        data = response.json()

        self.assertEqual(data['id'], str(record.id))
        self.assertEqual(data['data']['姓名'], '测试用户')
        self.assertEqual(data['data']['年龄'], 28)

    def test_update_record(self):
        """测试更新记录"""
        record = TableRecord.objects.create(
            table=self.table,
            data={'姓名': '原名称', '年龄': 25},
            created_by_id=str(self.user.id)
        )

        update_data = {
            'data': {
                '姓名': '新名称',
                '年龄': 26
            }
        }

        response = self.client.put(
            f'/api/tabdata/records/{record.id}',
            data=json.dumps(update_data),
            content_type='application/json'
        )

        self.assertEqual(response.status_code, 200)
        data = response.json()

        self.assertEqual(data['data']['姓名'], '新名称')
        self.assertEqual(data['data']['年龄'], 26)

        # 验证数据库
        record.refresh_from_db()
        self.assertEqual(record.data['姓名'], '新名称')

    def test_update_record_partial(self):
        """测试部分更新记录"""
        record = TableRecord.objects.create(
            table=self.table,
            data={'姓名': '张三', '年龄': 25, '邮箱': 'old@example.com'},
            created_by_id=str(self.user.id)
        )

        update_data = {
            'data': {
                '邮箱': 'new@example.com'  # 只更新邮箱
            }
        }

        response = self.client.put(
            f'/api/tabdata/records/{record.id}',
            data=json.dumps(update_data),
            content_type='application/json'
        )

        self.assertEqual(response.status_code, 200)
        data = response.json()

        # 邮箱已更新
        self.assertEqual(data['data']['邮箱'], 'new@example.com')
        # 其他字段保持不变
        self.assertEqual(data['data']['姓名'], '张三')
        self.assertEqual(data['data']['年龄'], 25)

    def test_delete_record(self):
        """测试删除记录"""
        record = TableRecord.objects.create(
            table=self.table,
            data={'姓名': '待删除用户', '年龄': 30},
            created_by_id=str(self.user.id)
        )

        record_id = record.id

        response = self.client.delete(f'/api/tabdata/records/{record_id}')

        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertTrue(data['success'])

        # 验证软删除
        record.refresh_from_db()
        self.assertTrue(record.is_deleted)

    def test_bulk_create_records(self):
        """测试批量创建记录"""
        bulk_data = {
            'table_id': str(self.table.id),
            'records': [
                {'姓名': '用户1', '年龄': 20},
                {'姓名': '用户2', '年龄': 21},
                {'姓名': '用户3', '年龄': 22},
            ]
        }

        response = self.client.post(
            '/api/tabdata/records/bulk-create',
            data=json.dumps(bulk_data),
            content_type='application/json'
        )

        self.assertEqual(response.status_code, 201)
        data = response.json()

        self.assertEqual(data['success_count'], 3)
        self.assertEqual(len(data['errors']), 0)

        # 验证数据库
        records = TableRecord.objects.filter(
            table=self.table,
            is_deleted=False
        )
        self.assertEqual(records.count(), 3)

    def test_bulk_create_records_with_order_context_and_operation_group_id(self):
        """批量创建应复用前端透传的 operation_group_id，并按 order_context 插入"""
        anchor = TableRecord.objects.create(
            table=self.table,
            data={'姓名': '锚点', '年龄': 30},
            created_by_id=str(self.user.id),
            order=1024,
        )
        tail = TableRecord.objects.create(
            table=self.table,
            data={'姓名': '尾部', '年龄': 40},
            created_by_id=str(self.user.id),
            order=2048,
        )
        operation_group_id = str(uuid.uuid4())

        response = self.client.post(
            '/api/tabdata/records/bulk-create',
            data=json.dumps({
                'table_id': str(self.table.id),
                'records': [
                    {'姓名': '批量1', '年龄': 20},
                    {'姓名': '批量2', '年龄': 21},
                ],
                'order_context': {
                    'anchor_record_id': str(anchor.id),
                    'position': 'after',
                },
                'operation_group_id': operation_group_id,
            }),
            content_type='application/json'
        )

        self.assertEqual(response.status_code, 201)
        payload = response.json()['data']
        self.assertEqual(payload['success_count'], 2)
        self.assertEqual(len(payload['records']), 2)

        created_record_ids = [item['id'] for item in payload['records']]
        created_records = list(
            TableRecord.objects.using('postgresql')
            .filter(id__in=created_record_ids, is_deleted=False)
            .order_by('order')
        )
        self.assertEqual(len(created_records), 2)
        self.assertGreater(created_records[0].order, anchor.order)
        self.assertLess(created_records[1].order, tail.order)
        self.assertLess(created_records[0].order, created_records[1].order)

        history_group_ids = {
            str(history.operation_group_id)
            for history in RecordHistory.objects.using('postgresql').filter(
                record_id__in=[record.id for record in created_records],
                action='create',
            )
        }
        self.assertEqual(history_group_ids, {operation_group_id})

    def test_bulk_create_with_errors(self):
        """测试批量创建 - 部分失败"""
        bulk_data = {
            'table_id': str(self.table.id),
            'records': [
                {'姓名': '正常用户', '年龄': 20},
                {'年龄': 21},  # 缺少必填字段
                {'姓名': '另一个正常用户', '年龄': 22},
            ]
        }

        response = self.client.post(
            '/api/tabdata/records/bulk-create',
            data=json.dumps(bulk_data),
            content_type='application/json'
        )

        self.assertEqual(response.status_code, 201)
        data = response.json()

        self.assertEqual(data['success_count'], 2)
        self.assertEqual(len(data['errors']), 1)
        self.assertIn('第2条', data['errors'][0])

    def test_bulk_update_records(self):
        """测试批量更新记录"""
        # 创建测试记录
        record1 = TableRecord.objects.create(
            table=self.table,
            data={'姓名': '用户1', '年龄': 20},
            created_by_id=str(self.user.id)
        )

        record2 = TableRecord.objects.create(
            table=self.table,
            data={'姓名': '用户2', '年龄': 21},
            created_by_id=str(self.user.id)
        )

        bulk_data = {
            'updates': [
                {
                    'record_id': str(record1.id),
                    'data': {'年龄': 25}
                },
                {
                    'record_id': str(record2.id),
                    'data': {'年龄': 26}
                }
            ]
        }

        response = self.client.post(
            '/api/tabdata/records/bulk-update',
            data=json.dumps(bulk_data),
            content_type='application/json'
        )

        self.assertEqual(response.status_code, 200)
        data = response.json()

        self.assertEqual(data['success_count'], 2)

        # 验证更新
        record1.refresh_from_db()
        record2.refresh_from_db()
        self.assertEqual(record1.data['年龄'], 25)
        self.assertEqual(record2.data['年龄'], 26)

    def test_bulk_update_records_with_operation_group_id(self):
        """批量更新应沿用前端透传的 operation_group_id"""
        record1 = TableRecord.objects.create(
            table=self.table,
            data={'姓名': '用户1', '年龄': 20},
            created_by_id=str(self.user.id)
        )
        record2 = TableRecord.objects.create(
            table=self.table,
            data={'姓名': '用户2', '年龄': 21},
            created_by_id=str(self.user.id)
        )
        operation_group_id = str(uuid.uuid4())

        response = self.client.post(
            '/api/tabdata/records/bulk-update',
            data=json.dumps({
                'updates': [
                    {'record_id': str(record1.id), 'data': {'年龄': 25}},
                    {'record_id': str(record2.id), 'data': {'年龄': 26}},
                ],
                'operation_group_id': operation_group_id,
            }),
            content_type='application/json'
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['data']['success_count'], 2)
        histories = RecordHistory.objects.using('postgresql').filter(
            record_id__in=[record1.id, record2.id],
            action='update',
        )
        self.assertEqual(
            {str(history.operation_group_id) for history in histories},
            {operation_group_id},
        )

    def test_bulk_delete_records_with_operation_group_id(self):
        """批量删除应沿用前端透传的 operation_group_id"""
        record1 = TableRecord.objects.create(
            table=self.table,
            data={'姓名': '待删1', '年龄': 20},
            created_by_id=str(self.user.id)
        )
        record2 = TableRecord.objects.create(
            table=self.table,
            data={'姓名': '待删2', '年龄': 21},
            created_by_id=str(self.user.id)
        )
        operation_group_id = str(uuid.uuid4())

        response = self.client.post(
            '/api/tabdata/records/bulk-delete',
            data=json.dumps({
                'record_ids': [str(record1.id), str(record2.id)],
                'operation_group_id': operation_group_id,
            }),
            content_type='application/json'
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['data']['success_count'], 2)
        histories = RecordHistory.objects.using('postgresql').filter(
            record_id__in=[record1.id, record2.id],
            action='delete',
        )
        self.assertEqual(
            {str(history.operation_group_id) for history in histories},
            {operation_group_id},
        )

    def test_reorder_records_after_anchor(self):
        """测试记录重排：移动到锚点后"""
        record1 = TableRecord.objects.create(
            table=self.table,
            data={'姓名': '用户1'},
            created_by_id=str(self.user.id),
            order=1024,
        )
        record2 = TableRecord.objects.create(
            table=self.table,
            data={'姓名': '用户2'},
            created_by_id=str(self.user.id),
            order=2048,
        )
        record3 = TableRecord.objects.create(
            table=self.table,
            data={'姓名': '用户3'},
            created_by_id=str(self.user.id),
            order=3072,
        )
        tail = TableRecord.objects.create(
            table=self.table,
            data={'姓名': '用户4'},
            created_by_id=str(self.user.id),
            order=4096,
        )

        payload = {
            'table_id': str(self.table.id),
            'record_ids': [str(record1.id)],
            'anchor_record_id': str(record3.id),
            'position': 'after',
        }

        response = self.client.post(
            '/api/tabdata/records/reorder',
            data=json.dumps(payload),
            content_type='application/json',
        )
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data['success_count'], 1)
        self.assertEqual(data['errors'], [])

        record1.refresh_from_db()
        record2.refresh_from_db()
        record3.refresh_from_db()
        tail.refresh_from_db()

        self.assertLess(record2.order, record3.order)
        self.assertGreater(record1.order, record3.order)
        self.assertLess(record1.order, tail.order)

    def test_reorder_records_before_anchor_keep_drag_order(self):
        """测试记录重排：多条拖拽顺序保持"""
        record1 = TableRecord.objects.create(
            table=self.table,
            data={'姓名': '用户1'},
            created_by_id=str(self.user.id),
            order=1024,
        )
        record2 = TableRecord.objects.create(
            table=self.table,
            data={'姓名': '用户2'},
            created_by_id=str(self.user.id),
            order=2048,
        )
        record3 = TableRecord.objects.create(
            table=self.table,
            data={'姓名': '用户3'},
            created_by_id=str(self.user.id),
            order=3072,
        )
        record4 = TableRecord.objects.create(
            table=self.table,
            data={'姓名': '用户4'},
            created_by_id=str(self.user.id),
            order=4096,
        )

        payload = {
            'table_id': str(self.table.id),
            'record_ids': [str(record3.id), str(record4.id)],
            'anchor_record_id': str(record1.id),
            'position': 'before',
        }

        response = self.client.post(
            '/api/tabdata/records/reorder',
            data=json.dumps(payload),
            content_type='application/json',
        )
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data['success_count'], 2)
        self.assertEqual(data['errors'], [])

        ordered_ids = list(
            TableRecord.objects.filter(
                table=self.table,
                is_deleted=False,
            )
            .order_by('order', 'created_at', 'id')
            .values_list('id', flat=True)
        )
        self.assertEqual(ordered_ids, [record3.id, record4.id, record1.id, record2.id])

    def test_reorder_records_with_group_values_sync(self):
        """测试记录重排：跨分组拖拽时同步分组字段值"""
        status_field = TableField.objects.create(
            table=self.table,
            name='状态',
            field_type='select',
            sort_order=4,
            config={
                'choices': ['待处理', '进行中']
            },
        )
        status_key = str(status_field.id)

        record_todo = TableRecord.objects.create(
            table=self.table,
            data={status_key: '待处理'},
            created_by_id=str(self.user.id),
            order=1024,
        )
        record_doing = TableRecord.objects.create(
            table=self.table,
            data={status_key: '进行中'},
            created_by_id=str(self.user.id),
            order=2048,
        )
        record_tail = TableRecord.objects.create(
            table=self.table,
            data={status_key: '进行中'},
            created_by_id=str(self.user.id),
            order=3072,
        )

        payload = {
            'table_id': str(self.table.id),
            'record_ids': [str(record_todo.id)],
            'anchor_record_id': str(record_doing.id),
            'position': 'after',
            'group_values': {
                '状态': '进行中',
            },
        }

        response = self.client.post(
            '/api/tabdata/records/reorder',
            data=json.dumps(payload),
            content_type='application/json',
        )
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data['success_count'], 1)
        self.assertEqual(data['errors'], [])

        record_todo.refresh_from_db()
        record_doing.refresh_from_db()
        record_tail.refresh_from_db()

        self.assertEqual(record_todo.data.get(status_key), '进行中')
        self.assertGreater(record_todo.order, record_doing.order)
        self.assertLess(record_todo.order, record_tail.order)

    def test_bulk_delete_records(self):
        """测试批量删除记录"""
        # 创建测试记录
        records = []
        for i in range(3):
            record = TableRecord.objects.create(
                table=self.table,
                data={'姓名': f'用户{i}', '年龄': 20 + i},
                created_by_id=str(self.user.id)
            )
            records.append(record)

        bulk_data = {
            'record_ids': [str(r.id) for r in records]
        }

        response = self.client.post(
            '/api/tabdata/records/bulk-delete',
            data=json.dumps(bulk_data),
            content_type='application/json'
        )

        self.assertEqual(response.status_code, 200)
        data = response.json()

        self.assertEqual(data['success_count'], 3)

        # 验证软删除
        for record in records:
            record.refresh_from_db()
            self.assertTrue(record.is_deleted)

    def test_get_table_stats(self):
        """测试获取表格统计"""
        # 创建5条记录
        for i in range(5):
            TableRecord.objects.create(
                table=self.table,
                data={'姓名': f'用户{i}', '年龄': 20 + i},
                created_by_id=str(self.user.id)
            )

        response = self.client.get(
            f'/api/tabdata/tables/{self.table.id}/stats'
        )

        self.assertEqual(response.status_code, 200)
        data = response.json()

        self.assertEqual(data['table_id'], str(self.table.id))
        self.assertEqual(data['record_count'], 5)


class TablePermissionTest(TestCase):
    """表格权限测试"""

    databases = ['default', 'postgresql']

    def setUp(self):
        """设置测试数据"""
        self.client = Client()

        # 创建测试用户
        self.owner = User.objects.using('default').create_user(
            username='table_owner',
            email='owner@test.com',
            password='testpass123'
        )

        self.editor = User.objects.using('default').create_user(
            username='table_editor',
            email='editor@test.com',
            password='testpass123'
        )

        self.viewer = User.objects.using('default').create_user(
            username='table_viewer',
            email='viewer@test.com',
            password='testpass123'
        )

        self.outsider = User.objects.using('default').create_user(
            username='outsider',
            email='outsider@test.com',
            password='testpass123'
        )

        # 创建组织
        self.organization = Organization.objects.create(
            name='权限测试空间',
            owner_id=str(self.owner.id)
        )

        # 添加成员
        OrganizationMember.objects.create(
            organization=self.organization,
            user_id=str(self.editor.id),
            role='editor'
        )

        OrganizationMember.objects.create(
            organization=self.organization,
            user_id=str(self.viewer.id),
            role='viewer'
        )

        # 创建项目和表格
        self.space = Space.objects.create(
            organization=self.organization,
            name='权限测试项目'
        )

        self.table = Table.objects.create(
            project_id=self.space.id,
            organization_id=self.space.organization_id,
            name='权限测试表',
            owner_id=str(self.owner.id)
        )

        # 创建字段
        TableField.objects.create(
            table=self.table,
            name='ID',
            field_type='text',
            is_primary=True,
            sort_order=0
        )

        TableField.objects.create(
            table=self.table,
            name='名称',
            field_type='text',
            sort_order=1
        )

        # 创建记录
        self.record = TableRecord.objects.create(
            table=self.table,
            data={'名称': '测试记录'},
            created_by_id=str(self.owner.id)
        )

    def test_viewer_can_read_table(self):
        """测试viewer可以查看表格"""
        self.client.force_login(self.viewer)

        response = self.client.get(f'/api/tabdata/tables/{self.table.id}')
        self.assertEqual(response.status_code, 200)

    def test_viewer_can_read_records(self):
        """测试viewer可以查看记录"""
        self.client.force_login(self.viewer)

        response = self.client.get(
            f'/api/tabdata/tables/{self.table.id}/records'
        )
        self.assertEqual(response.status_code, 200)

    def test_viewer_cannot_create_table(self):
        """测试viewer不能创建表格"""
        self.client.force_login(self.viewer)

        table_data = {
            'organization_id': str(self.organization.id),
            'name': '尝试创建的表格'
        }

        response = self.client.post(
            '/api/tabdata/tables',
            data=json.dumps(table_data),
            content_type='application/json'
        )

        self.assertEqual(response.status_code, 403)

    def test_viewer_cannot_update_table(self):
        """测试viewer不能更新表格"""
        self.client.force_login(self.viewer)

        update_data = {'name': '尝试更新'}

        response = self.client.put(
            f'/api/tabdata/tables/{self.table.id}',
            data=json.dumps(update_data),
            content_type='application/json'
        )

        self.assertEqual(response.status_code, 403)

    def test_viewer_cannot_create_record(self):
        """测试viewer不能创建记录"""
        self.client.force_login(self.viewer)

        record_data = {
            'table_id': str(self.table.id),
            'data': {'名称': '尝试创建'}
        }

        response = self.client.post(
            '/api/tabdata/records',
            data=json.dumps(record_data),
            content_type='application/json'
        )

        self.assertEqual(response.status_code, 403)

    def test_editor_can_create_table(self):
        """测试editor可以创建表格"""
        self.client.force_login(self.editor)

        table_data = {
            'organization_id': str(self.organization.id),
            'name': 'Editor创建的表格'
        }

        response = self.client.post(
            '/api/tabdata/tables',
            data=json.dumps(table_data),
            content_type='application/json'
        )

        self.assertEqual(response.status_code, 201)

    def test_editor_can_update_table(self):
        """测试editor可以更新表格"""
        self.client.force_login(self.editor)

        update_data = {'name': 'Editor更新的名称'}

        response = self.client.put(
            f'/api/tabdata/tables/{self.table.id}',
            data=json.dumps(update_data),
            content_type='application/json'
        )

        self.assertEqual(response.status_code, 200)

    def test_editor_can_create_record(self):
        """测试editor可以创建记录"""
        self.client.force_login(self.editor)

        record_data = {
            'table_id': str(self.table.id),
            'data': {'名称': 'Editor创建的记录'}
        }

        response = self.client.post(
            '/api/tabdata/records',
            data=json.dumps(record_data),
            content_type='application/json'
        )

        self.assertEqual(response.status_code, 201)

    def test_editor_cannot_delete_table(self):
        """测试editor不能删除表格"""
        self.client.force_login(self.editor)

        response = self.client.delete(f'/api/tabdata/tables/{self.table.id}')

        self.assertEqual(response.status_code, 403)

    def test_owner_can_delete_table(self):
        """测试owner可以删除表格"""
        self.client.force_login(self.owner)

        response = self.client.delete(f'/api/tabdata/tables/{self.table.id}')

        self.assertEqual(response.status_code, 200)

    def test_outsider_cannot_access(self):
        """测试外部用户无法访问"""
        self.client.force_login(self.outsider)

        # 无法查看表格
        response = self.client.get(f'/api/tabdata/tables/{self.table.id}')
        self.assertEqual(response.status_code, 404)

        # 无法查看记录
        response = self.client.get(
            f'/api/tabdata/tables/{self.table.id}/records'
        )
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data['total'], 0)  # 没有权限,返回空列表


class TableFieldTypeValidationTest(TestCase):
    """字段类型验证测试"""

    databases = ['default', 'postgresql']

    def setUp(self):
        """设置测试数据"""
        self.client = Client()

        self.user = User.objects.using('default').create_user(
            username='validator',
            email='validator@test.com',
            password='testpass123'
        )

        self.organization = Organization.objects.create(
            name='验证测试空间',
            owner_id=str(self.user.id)
        )

        self.space = Space.objects.create(
            organization=self.organization,
            name='验证测试项目'
        )

        self.table = Table.objects.create(
            project_id=self.space.id,
            organization_id=self.space.organization_id,
            name='字段验证表',
            owner_id=str(self.user.id)
        )

        # 创建各种类型的字段
        TableField.objects.create(
            table=self.table,
            name='文本字段',
            field_type='text',
            sort_order=0
        )

        TableField.objects.create(
            table=self.table,
            name='数字字段',
            field_type='number',
            sort_order=1
        )

        TableField.objects.create(
            table=self.table,
            name='日期字段',
            field_type='date',
            sort_order=2
        )

        TableField.objects.create(
            table=self.table,
            name='复选框字段',
            field_type='checkbox',
            sort_order=3
        )

        TableField.objects.create(
            table=self.table,
            name='单选字段',
            field_type='select',
            options={'choices': ['选项1', '选项2', '选项3']},
            sort_order=4
        )

        self.client.force_login(self.user)

    def test_valid_text_field(self):
        """测试有效的文本字段"""
        record_data = {
            'table_id': str(self.table.id),
            'data': {'文本字段': '这是一段文本'}
        }

        response = self.client.post(
            '/api/tabdata/records',
            data=json.dumps(record_data),
            content_type='application/json'
        )

        self.assertEqual(response.status_code, 201)

    def test_valid_number_field(self):
        """测试有效的数字字段"""
        record_data = {
            'table_id': str(self.table.id),
            'data': {
                '数字字段': 123.45
            }
        }

        response = self.client.post(
            '/api/tabdata/records',
            data=json.dumps(record_data),
            content_type='application/json'
        )

        self.assertEqual(response.status_code, 201)

    def test_invalid_number_field(self):
        """测试无效的数字字段"""
        record_data = {
            'table_id': str(self.table.id),
            'data': {
                '数字字段': '不是数字'
            }
        }

        response = self.client.post(
            '/api/tabdata/records',
            data=json.dumps(record_data),
            content_type='application/json'
        )

        self.assertEqual(response.status_code, 400)

    def test_valid_date_field(self):
        """测试有效的日期字段"""
        record_data = {
            'table_id': str(self.table.id),
            'data': {
                '日期字段': '2024-01-15'
            }
        }

        response = self.client.post(
            '/api/tabdata/records',
            data=json.dumps(record_data),
            content_type='application/json'
        )

        self.assertEqual(response.status_code, 201)

    def test_invalid_date_field(self):
        """测试无效的日期字段"""
        record_data = {
            'table_id': str(self.table.id),
            'data': {
                '日期字段': '2024-13-45'  # 无效日期
            }
        }

        response = self.client.post(
            '/api/tabdata/records',
            data=json.dumps(record_data),
            content_type='application/json'
        )

        self.assertEqual(response.status_code, 400)

    def test_valid_checkbox_field(self):
        """测试有效的复选框字段"""
        record_data = {
            'table_id': str(self.table.id),
            'data': {
                '复选框字段': True
            }
        }

        response = self.client.post(
            '/api/tabdata/records',
            data=json.dumps(record_data),
            content_type='application/json'
        )

        self.assertEqual(response.status_code, 201)

    def test_valid_select_field(self):
        """测试有效的单选字段"""
        record_data = {
            'table_id': str(self.table.id),
            'data': {
                '单选字段': '选项2'
            }
        }

        response = self.client.post(
            '/api/tabdata/records',
            data=json.dumps(record_data),
            content_type='application/json'
        )

        self.assertEqual(response.status_code, 201)

    def test_invalid_select_field(self):
        """测试无效的单选字段 - 选项不存在"""
        record_data = {
            'table_id': str(self.table.id),
            'data': {
                '单选字段': '不存在的选项'
            }
        }

        response = self.client.post(
            '/api/tabdata/records',
            data=json.dumps(record_data),
            content_type='application/json'
        )

        self.assertEqual(response.status_code, 400)


if __name__ == '__main__':
    import unittest
    unittest.main()
