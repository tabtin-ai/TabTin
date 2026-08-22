"""
层级API测试用例
测试 /api/tabdata/organizations/{organization_id}/agent-spaces/{space_id}/tables 端点
"""
import json
from django.test import TestCase, Client
from django.contrib.auth import get_user_model
from apps.tabtinspace.models import Organization, Space
from apps.tabdata.models import Table

User = get_user_model()


class HierarchicalAPITestCase(TestCase):
    databases = ['default', 'postgresql']
    def setUp(self):
        """设置测试数据"""
        self.client = Client()

        # 创建测试用户
        self.user = User.objects.create_user(
            username='testuser',
            email='test@example.com',
            password='testpass123'
        )

        # 创建组织
        self.organization = Organization.objects.create(
            name='测试组织',
            owner=self.user
        )

        # 创建项目
        self.space = Space.objects.create(
            name='测试项目',
            organization=self.organization,
            owner=self.user
        )

        # 创建测试表格
        self.table = Table.objects.create(
            name='测试表格',
            project_id=self.space.id,
            organization_id=self.space.organization_id
        )

        # 登录用户
        self.client.force_login(self.user)

    def test_get_project_tables_hierarchical(self):
        """测试获取项目下的表格列表（层级API）"""
        url = f'/api/tabdata/organizations/{self.organization.id}/agent-spaces/{self.space.id}/tables'
        response = self.client.get(url)

        self.assertEqual(response.status_code, 200)
        data = response.json()

        # 验证响应结构
        self.assertIn('data', data)
        self.assertIsInstance(data['data'], list)
        self.assertEqual(len(data['data']), 1)

        # 验证表格数据
        table_data = data['data'][0]
        self.assertEqual(table_data['id'], str(self.table.id))
        self.assertEqual(table_data['name'], '测试表格')

    def test_create_project_table_hierarchical(self):
        """测试在项目下创建表格（层级API）"""
        url = f'/api/tabdata/organizations/{self.organization.id}/agent-spaces/{self.space.id}/tables'

        table_data = {
            'name': '新建测试表格',
            'description': '通过层级API创建的表格'
        }

        response = self.client.post(url, data=json.dumps(table_data), content_type='application/json')

        self.assertEqual(response.status_code, 201)
        data = response.json()

        # 验证响应结构
        self.assertIn('data', data)
        table_data = data['data']

        # 验证表格数据
        self.assertEqual(table_data['name'], '新建测试表格')
        self.assertEqual(table_data['description'], '通过层级API创建的表格')

        # 验证数据库中的表格
        created_table = Table.objects.get(id=table_data['id'])
        self.assertEqual(created_table.name, '新建测试表格')
        self.assertEqual(created_table.project, self.space)

    def test_hierarchical_api_permission_check(self):
        """测试层级API的权限检查"""
        # 创建另一个用户和组织
        other_user = User.objects.create_user(
            username='otheruser',
            email='other@example.com',
            password='otherpass123'
        )

        other_organization = Organization.objects.create(
            name='其他组织',
            owner=other_user
        )

        other_space = Space.objects.create(
            name='其他项目',
            organization=other_organization,
            owner=other_user
        )

        # 尝试访问其他用户的项目
        url = f'/api/tabdata/organizations/{other_organization.id}/agent-spaces/{other_space.id}/tables'
        response = self.client.get(url)

        # 应该返回403或404（取决于权限实现）
        self.assertIn(response.status_code, [403, 404])

    def test_hierarchical_api_invalid_organization_project(self):
        """测试层级API中组织和项目不匹配的情况"""
        # 创建另一个组织
        other_organization = Organization.objects.create(
            name='其他组织',
            owner=self.user
        )

        # 使用错误的组织ID访问项目
        url = f'/api/tabdata/organizations/{other_organization.id}/agent-spaces/{self.space.id}/tables'
        response = self.client.get(url)

        # 应该返回404，因为项目不属于指定的组织
        self.assertEqual(response.status_code, 404)

    def test_create_table_with_invalid_data(self):
        """测试使用无效数据创建表格"""
        url = f'/api/tabdata/organizations/{self.organization.id}/agent-spaces/{self.space.id}/tables'

        # 测试空名称
        table_data = {
            'name': '',
            'description': '测试描述'
        }

        response = self.client.post(url, data=json.dumps(table_data), content_type='application/json')
        self.assertEqual(response.status_code, 400)

        # 测试缺少名称
        table_data = {
            'description': '测试描述'
        }

        response = self.client.post(url, data=json.dumps(table_data), content_type='application/json')
        self.assertEqual(response.status_code, 400)
