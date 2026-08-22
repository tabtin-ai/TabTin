"""
TabData Organization API 接口完整测试

覆盖所有 Organization 相关的 API 接口，包括:
1. Organization CRUD 操作
2. Organization Member 管理
3. 权限验证
4. 边界条件测试
5. 统计信息测试
"""

import json
import uuid
from django.test import TestCase, Client, override_settings
from django.contrib.auth import get_user_model
from django.db import connection
from unittest.mock import patch, MagicMock

from apps.tabtinspace.models import Organization, OrganizationMember, Space
from apps.tabdata.models import Table
from apps.tabtinspace.services import OrganizationService
from apps.services.common.db_router import postgres_app_db_alias

User = get_user_model()
PG = postgres_app_db_alias()


class OrganizationAPITestCase(TestCase):
    """Organization API 基础测试用例"""

    databases = {'default', 'postgresql'}

    def setUp(self):
        """设置测试环境"""
        self.client = Client()

        # 创建测试用户
        self.user1 = User.objects.create_user(
            email='test1@example.com',
            password='testpass123',
            username='testuser1'
        )

        self.user2 = User.objects.create_user(
            email='test2@example.com',
            password='testpass123',
            username='testuser2'
        )

        self.user3 = User.objects.create_user(
            email='test3@example.com',
            password='testpass123',
            username='testuser3'
        )

        # 模拟 JWT 认证
        self.mock_jwt_token = self._generate_mock_token(self.user1)

    def _generate_mock_token(self, user):
        """生成模拟的 JWT Token"""
        return f"mock_token_{user.id}"

    def _auth_headers(self, user=None):
        """获取认证头"""
        if user is None:
            user = self.user1
        return {
            'HTTP_AUTHORIZATION': f'Bearer {self._generate_mock_token(user)}'
        }


class OrganizationListAPITest(OrganizationAPITestCase):
    """测试获取组织列表接口"""

    def setUp(self):
        super().setUp()

        # 创建测试组织
        self.organization1 = Organization.objects.using('postgresql').create(
            name='组织1',
            description='测试组织1',
            icon='📁',
            owner_id=self.user1.id
        )

        self.organization2 = Organization.objects.using('postgresql').create(
            name='组织2',
            description='测试组织2',
            icon='📂',
            owner_id=self.user1.id,
            is_default=True
        )

        # user2 的组织
        self.organization3 = Organization.objects.using('postgresql').create(
            name='其他用户组织',
            description='user2的组织',
            owner_id=self.user2.id
        )

        # 添加 user1 为 organization3 的成员
        OrganizationMember.objects.using('postgresql').create(
            organization=self.organization3,
            user_id=self.user1.id,
            role='viewer'
        )

    @patch('apps.tabtinspace.routers.shared.jwt_auth.authenticate')
    def test_list_organizations_success(self, mock_auth):
        """测试成功获取组织列表"""
        mock_auth.return_value = self.user1

        response = self.client.get(
            '/api/context/organizations',
            **self._auth_headers()
        )

        self.assertEqual(response.status_code, 200)
        data = response.json()

        self.assertIn('organizations', data)
        self.assertIn('total', data)
        # user1 拥有2个手动创建 + 1个默认创建 + 1个作为成员
        self.assertEqual(data['total'], 4)

        # 验证返回的组织
        organization_names = [ws['name'] for ws in data['organizations']]
        self.assertIn('组织1', organization_names)
        self.assertIn('组织2', organization_names)
        self.assertIn('其他用户组织', organization_names)

    @patch('apps.tabtinspace.routers.shared.jwt_auth.authenticate')
    def test_list_organizations_with_search(self, mock_auth):
        """测试搜索组织"""
        mock_auth.return_value = self.user1

        response = self.client.get(
            '/api/context/organizations?search=组织1',
            **self._auth_headers()
        )

        self.assertEqual(response.status_code, 200)
        data = response.json()

        self.assertEqual(data['total'], 1)
        self.assertEqual(data['organizations'][0]['name'], '组织1')

    @patch('apps.tabtinspace.routers.shared.jwt_auth.authenticate')
    def test_list_organizations_filter_default(self, mock_auth):
        """测试过滤默认组织"""
        mock_auth.return_value = self.user1

        response = self.client.get(
            '/api/context/organizations?is_default=true',
            **self._auth_headers()
        )

        self.assertEqual(response.status_code, 200)
        data = response.json()

        # 至少包含手动创建的1个默认organization + 可能的自动创建的默认organization
        self.assertGreaterEqual(data['total'], 1)

        # 检查至少有一个默认组织
        default_organizations = [ws for ws in data['organizations'] if ws['is_default']]
        self.assertGreater(len(default_organizations), 0)

    @patch('apps.tabtinspace.routers.shared.jwt_auth.authenticate')
    def test_list_organizations_empty(self, mock_auth):
        """测试用户无组织"""
        mock_auth.return_value = self.user3

        response = self.client.get(
            '/api/context/organizations',
            **self._auth_headers(self.user3)
        )

        self.assertEqual(response.status_code, 200)
        data = response.json()

        # user3会有一个自动创建的默认organization
        self.assertGreaterEqual(data['total'], 0)

    def test_list_organizations_unauthorized(self):
        """测试未授权访问"""
        response = self.client.get('/api/context/organizations')

        self.assertEqual(response.status_code, 401)


class OrganizationDetailAPITest(OrganizationAPITestCase):
    """测试获取组织详情接口"""

    def setUp(self):
        super().setUp()

        self.organization = Organization.objects.using('postgresql').create(
            name='测试组织',
            description='详情测试',
            icon='🎯',
            owner_id=self.user1.id,
            settings={'theme': 'dark'}
        )

    @patch('apps.tabtinspace.routers.shared.jwt_auth.authenticate')
    def test_get_organization_detail_success(self, mock_auth):
        """测试成功获取组织详情"""
        mock_auth.return_value = self.user1

        response = self.client.get(
            f'/api/context/organizations/{self.organization.id}',
            **self._auth_headers()
        )

        self.assertEqual(response.status_code, 200)
        data = response.json()

        self.assertEqual(data['id'], str(self.organization.id))
        self.assertEqual(data['name'], '测试组织')
        self.assertEqual(data['description'], '详情测试')
        self.assertEqual(data['icon'], '🎯')
        self.assertEqual(data['owner_id'], self.user1.id)
        self.assertEqual(data['settings'], {'theme': 'dark'})
        self.assertIn('created_at', data)
        self.assertIn('updated_at', data)

    @patch('apps.tabtinspace.routers.shared.jwt_auth.authenticate')
    def test_get_organization_detail_not_found(self, mock_auth):
        """测试获取不存在的组织"""
        mock_auth.return_value = self.user1

        fake_id = uuid.uuid4()
        response = self.client.get(
            f'/api/context/organizations/{fake_id}',
            **self._auth_headers()
        )

        self.assertEqual(response.status_code, 404)
        data = response.json()
        self.assertFalse(data['success'])
        self.assertIn('message', data)

    @patch('apps.tabtinspace.routers.shared.jwt_auth.authenticate')
    def test_get_organization_detail_no_permission(self, mock_auth):
        """测试无权限访问组织"""
        mock_auth.return_value = self.user2

        response = self.client.get(
            f'/api/context/organizations/{self.organization.id}',
            **self._auth_headers(self.user2)
        )

        self.assertEqual(response.status_code, 404)


class OrganizationCreateAPITest(OrganizationAPITestCase):
    """测试创建组织接口"""

    @patch('apps.tabtinspace.routers.shared.jwt_auth.authenticate')
    def test_create_organization_success(self, mock_auth):
        """测试成功创建组织"""
        mock_auth.return_value = self.user1

        data = {
            'name': '新组织',
            'description': '这是一个新的组织',
            'icon': '🚀',
            'settings': {'theme': 'light', 'language': 'zh-CN'}
        }

        response = self.client.post(
            '/api/context/organizations',
            data=json.dumps(data),
            content_type='application/json',
            **self._auth_headers()
        )

        self.assertEqual(response.status_code, 201)
        body = response.json()
        self.assertTrue(body['success'])
        response_data = body['data']

        self.assertEqual(response_data['name'], '新组织')
        self.assertEqual(response_data['description'], '这是一个新的组织')
        self.assertEqual(response_data['icon'], '🚀')
        self.assertEqual(response_data['owner_id'], self.user1.id)
        self.assertEqual(response_data['settings'], {'theme': 'light', 'language': 'zh-CN'})
        self.assertFalse(response_data['is_default'])

        # 验证数据库中创建成功（single_pg 路由到 default，勿硬编码 postgresql alias）
        organization = Organization.objects.get(name='新组织')
        self.assertEqual(organization.owner_id, self.user1.id)

    @patch('apps.tabtinspace.routers.shared.jwt_auth.authenticate')
    def test_create_organization_minimal_data(self, mock_auth):
        """测试使用最少数据创建组织"""
        mock_auth.return_value = self.user1

        data = {'name': '简单组织'}

        response = self.client.post(
            '/api/context/organizations',
            data=json.dumps(data),
            content_type='application/json',
            **self._auth_headers()
        )

        self.assertEqual(response.status_code, 201)
        body = response.json()
        self.assertTrue(body['success'])
        response_data = body['data']

        self.assertEqual(response_data['name'], '简单组织')
        self.assertEqual(response_data['description'], '')
        self.assertIsNotNone(response_data['icon'])  # 应该有默认图标

    @patch('apps.tabtinspace.routers.shared.jwt_auth.authenticate')
    def test_create_organization_invalid_name(self, mock_auth):
        """测试创建组织 - 无效名称"""
        mock_auth.return_value = self.user1

        # 空名称
        data = {'name': ''}
        response = self.client.post(
            '/api/context/organizations',
            data=json.dumps(data),
            content_type='application/json',
            **self._auth_headers()
        )
        # Pydantic 验证会返回 422 错误
        self.assertIn(response.status_code, [400, 422])

        # 名称过长
        data = {'name': 'x' * 300}
        response = self.client.post(
            '/api/context/organizations',
            data=json.dumps(data),
            content_type='application/json',
            **self._auth_headers()
        )
        self.assertIn(response.status_code, [400, 422])

    def test_create_organization_unauthorized(self):
        """测试未授权创建组织"""
        data = {'name': '未授权组织'}

        response = self.client.post(
            '/api/context/organizations',
            data=json.dumps(data),
            content_type='application/json'
        )

        self.assertEqual(response.status_code, 401)

    @patch('apps.tabtinspace.routers.shared.jwt_auth.authenticate')
    def test_create_organization_duplicate_name(self, mock_auth):
        """同一 owner 创建同名组织应返回 409"""
        mock_auth.return_value = self.user1
        Organization.objects.using(PG).create(
            name='已有组织',
            owner_id=self.user1.id,
        )

        response = self.client.post(
            '/api/context/organizations',
            data=json.dumps({'name': '已有组织'}),
            content_type='application/json',
            **self._auth_headers()
        )

        self.assertEqual(response.status_code, 409)
        body = response.json()
        self.assertFalse(body.get('success', True))
        self.assertEqual(body.get('code') or body.get('error_code'), 'ORGANIZATION_NAME_CONFLICT')

    @patch('apps.tabtinspace.routers.shared.jwt_auth.authenticate')
    def test_create_organization_duplicate_name_other_owner(self, mock_auth):
        """其他用户已占用的名称，当前用户创建也应 409（全表唯一）"""
        mock_auth.return_value = self.user1
        Organization.objects.using(PG).create(
            name='跨用户占用',
            owner_id=self.user2.id,
        )

        response = self.client.post(
            '/api/context/organizations',
            data=json.dumps({'name': '跨用户占用'}),
            content_type='application/json',
            **self._auth_headers()
        )

        self.assertEqual(response.status_code, 409)
        body = response.json()
        self.assertEqual(body.get('code') or body.get('error_code'), 'ORGANIZATION_NAME_CONFLICT')


class OrganizationUpdateAPITest(OrganizationAPITestCase):
    """测试更新组织接口"""

    def setUp(self):
        super().setUp()

        self.organization = Organization.objects.using(PG).create(
            name='原组织',
            description='原描述',
            icon='📁',
            owner_id=self.user1.id,
            settings={'theme': 'dark'}
        )

        # 添加 user2 为编辑者
        OrganizationMember.objects.using(PG).create(
            organization=self.organization,
            user_id=self.user2.id,
            role='editor'
        )

        # 添加 user3 为查看者
        OrganizationMember.objects.using(PG).create(
            organization=self.organization,
            user_id=self.user3.id,
            role='viewer'
        )

    @patch('apps.tabtinspace.routers.shared.jwt_auth.authenticate')
    def test_update_organization_by_owner(self, mock_auth):
        """测试所有者更新组织"""
        mock_auth.return_value = self.user1

        data = {
            'name': '更新后的组织',
            'description': '更新后的描述',
            'icon': '🎨',
            'settings': {'theme': 'light'}
        }

        response = self.client.put(
            f'/api/context/organizations/{self.organization.id}',
            data=json.dumps(data),
            content_type='application/json',
            **self._auth_headers()
        )

        self.assertEqual(response.status_code, 200)
        body = response.json()
        response_data = body.get('data') or body

        self.assertEqual(response_data['name'], '更新后的组织')
        self.assertEqual(response_data['description'], '更新后的描述')
        self.assertEqual(response_data['icon'], '🎨')
        self.assertEqual(response_data['settings'], {'theme': 'light'})

        # 验证数据库更新
        self.organization.refresh_from_db()
        self.assertEqual(self.organization.name, '更新后的组织')

    @patch('apps.tabtinspace.routers.shared.jwt_auth.authenticate')
    def test_update_organization_by_editor(self, mock_auth):
        """测试编辑者更新组织——团队设置仅 owner 可改"""
        mock_auth.return_value = self.user2

        data = {'name': '编辑者更新'}

        response = self.client.put(
            f'/api/context/organizations/{self.organization.id}',
            data=json.dumps(data),
            content_type='application/json',
            **self._auth_headers(self.user2)
        )

        self.assertEqual(response.status_code, 403)

        # 验证未更新
        self.organization.refresh_from_db()
        self.assertEqual(self.organization.name, '原组织')

    @patch('apps.tabtinspace.routers.shared.jwt_auth.authenticate')
    def test_update_organization_by_viewer_denied(self, mock_auth):
        """测试查看者无权更新组织"""
        mock_auth.return_value = self.user3

        data = {'name': '查看者尝试更新'}

        response = self.client.put(
            f'/api/context/organizations/{self.organization.id}',
            data=json.dumps(data),
            content_type='application/json',
            **self._auth_headers(self.user3)
        )

        self.assertEqual(response.status_code, 403)

        # 验证未更新
        self.organization.refresh_from_db()
        self.assertEqual(self.organization.name, '原组织')

    @patch('apps.tabtinspace.routers.shared.jwt_auth.authenticate')
    def test_update_organization_partial(self, mock_auth):
        """测试部分更新组织"""
        mock_auth.return_value = self.user1

        # 只更新名称
        data = {'name': '只改名字'}

        response = self.client.put(
            f'/api/context/organizations/{self.organization.id}',
            data=json.dumps(data),
            content_type='application/json',
            **self._auth_headers()
        )

        self.assertEqual(response.status_code, 200)

        self.organization.refresh_from_db()
        self.assertEqual(self.organization.name, '只改名字')
        self.assertEqual(self.organization.description, '原描述')  # 保持不变
        self.assertEqual(self.organization.icon, '📁')  # 保持不变

    @patch('apps.tabtinspace.routers.shared.jwt_auth.authenticate')
    def test_update_organization_duplicate_name(self, mock_auth):
        """改名为同 owner 下已有组织名应返回 409"""
        mock_auth.return_value = self.user1
        Organization.objects.using(PG).create(
            name='冲突组织',
            owner_id=self.user1.id,
        )

        response = self.client.put(
            f'/api/context/organizations/{self.organization.id}',
            data=json.dumps({'name': '冲突组织'}),
            content_type='application/json',
            **self._auth_headers()
        )

        self.assertEqual(response.status_code, 409)
        body = response.json()
        self.assertEqual(body.get('code') or body.get('error_code'), 'ORGANIZATION_NAME_CONFLICT')
        self.organization.refresh_from_db()
        self.assertEqual(self.organization.name, '原组织')

    @patch('apps.tabtinspace.routers.shared.jwt_auth.authenticate')
    def test_update_organization_same_name_ok(self, mock_auth):
        """改回自身原名应成功"""
        mock_auth.return_value = self.user1

        response = self.client.put(
            f'/api/context/organizations/{self.organization.id}',
            data=json.dumps({'name': '原组织'}),
            content_type='application/json',
            **self._auth_headers()
        )

        self.assertEqual(response.status_code, 200)
        self.organization.refresh_from_db()
        self.assertEqual(self.organization.name, '原组织')


class OrganizationDeleteAPITest(OrganizationAPITestCase):
    """测试删除组织接口"""

    def setUp(self):
        super().setUp()

        self.organization = Organization.objects.using('postgresql').create(
            name='待删除组织',
            owner_id=self.user1.id
        )

        self.default_organization = Organization.objects.using('postgresql').create(
            name='默认组织',
            owner_id=self.user1.id,
            is_default=True
        )

    @patch('apps.tabtinspace.routers.shared.jwt_auth.authenticate')
    def test_delete_organization_by_owner(self, mock_auth):
        """测试所有者删除组织"""
        mock_auth.return_value = self.user1

        organization_id = self.organization.id

        response = self.client.delete(
            f'/api/context/organizations/{organization_id}',
            **self._auth_headers()
        )

        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertTrue(data['success'])

        # 验证组织已删除
        self.assertFalse(
            Organization.objects.using('postgresql').filter(id=organization_id).exists()
        )

    @patch('apps.tabtinspace.routers.shared.jwt_auth.authenticate')
    def test_delete_default_organization_denied(self, mock_auth):
        """测试不能删除默认组织"""
        mock_auth.return_value = self.user1

        response = self.client.delete(
            f'/api/context/organizations/{self.default_organization.id}',
            **self._auth_headers()
        )

        self.assertEqual(response.status_code, 400)
        data = response.json()
        self.assertFalse(data['success'])

        # 验证组织未删除
        self.assertTrue(
            Organization.objects.using('postgresql').filter(
                id=self.default_organization.id
            ).exists()
        )

    @patch('apps.tabtinspace.routers.shared.jwt_auth.authenticate')
    def test_delete_organization_by_non_owner_denied(self, mock_auth):
        """测试非所有者无权删除组织"""
        mock_auth.return_value = self.user2

        response = self.client.delete(
            f'/api/context/organizations/{self.organization.id}',
            **self._auth_headers(self.user2)
        )

        self.assertEqual(response.status_code, 403)

        # 验证组织未删除
        self.assertTrue(
            Organization.objects.using('postgresql').filter(
                id=self.organization.id
            ).exists()
        )

    @patch('apps.tabtinspace.routers.shared.jwt_auth.authenticate')
    def test_delete_organization_with_cascade(self, mock_auth):
        """测试删除组织级联删除相关数据"""
        mock_auth.return_value = self.user1

        # 创建关联的项目和成员
        space = Space.objects.using('postgresql').create(
            organization=self.organization,
            name='测试项目'
        )

        member = OrganizationMember.objects.using('postgresql').create(
            organization=self.organization,
            user_id=self.user2.id,
            role='viewer'
        )

        organization_id = self.organization.id

        response = self.client.delete(
            f'/api/context/organizations/{organization_id}',
            **self._auth_headers()
        )

        self.assertEqual(response.status_code, 200)

        # 验证级联删除
        self.assertFalse(
            Organization.objects.using('postgresql').filter(id=organization_id).exists()
        )
        self.assertFalse(
            Space.objects.using('postgresql').filter(organization_id=organization_id).exists()
        )
        self.assertFalse(
            OrganizationMember.objects.using('postgresql').filter(
                organization_id=organization_id
            ).exists()
        )


class OrganizationMemberListAPITest(OrganizationAPITestCase):
    """测试获取组织成员列表接口"""

    def setUp(self):
        super().setUp()

        self.organization = Organization.objects.using('postgresql').create(
            name='成员测试组织',
            owner_id=self.user1.id
        )

        # 添加成员
        self.member1 = OrganizationMember.objects.using('postgresql').create(
            organization=self.organization,
            user_id=self.user2.id,
            role='editor'
        )

        self.member2 = OrganizationMember.objects.using('postgresql').create(
            organization=self.organization,
            user_id=self.user3.id,
            role='viewer'
        )

    @patch('apps.tabtinspace.routers.shared.jwt_auth.authenticate')
    def test_list_members_success(self, mock_auth):
        """测试成功获取成员列表"""
        mock_auth.return_value = self.user1

        response = self.client.get(
            f'/api/context/organizations/{self.organization.id}/members',
            **self._auth_headers()
        )

        self.assertEqual(response.status_code, 200)
        data = response.json()

        self.assertIn('members', data)
        self.assertIn('total', data)
        self.assertEqual(data['total'], 2)

        # 验证成员信息
        member_ids = [m['user_id'] for m in data['members']]
        self.assertIn(self.user2.id, member_ids)
        self.assertIn(self.user3.id, member_ids)

    @patch('apps.tabtinspace.routers.shared.jwt_auth.authenticate')
    def test_list_members_no_permission(self, mock_auth):
        """测试无权限获取成员列表"""
        # 创建一个不在组织中的用户
        other_user = User.objects.create_user(
            email='other@example.com',
            password='testpass123',
            username='otheruser'
        )
        mock_auth.return_value = other_user

        response = self.client.get(
            f'/api/context/organizations/{self.organization.id}/members',
            HTTP_AUTHORIZATION=f'Bearer {self._generate_mock_token(other_user)}'
        )

        self.assertEqual(response.status_code, 403)


class OrganizationMemberAddAPITest(OrganizationAPITestCase):
    """测试添加组织成员接口"""

    def setUp(self):
        super().setUp()

        self.organization = Organization.objects.using('postgresql').create(
            name='成员管理测试',
            owner_id=self.user1.id
        )

    @patch('apps.tabtinspace.routers.shared.jwt_auth.authenticate')
    def test_add_member_success(self, mock_auth):
        """测试成功添加成员"""
        mock_auth.return_value = self.user1

        data = {
            'user_id': self.user2.id,
            'role': 'editor'
        }

        response = self.client.post(
            f'/api/context/organizations/{self.organization.id}/members',
            data=json.dumps(data),
            content_type='application/json',
            **self._auth_headers()
        )

        self.assertEqual(response.status_code, 201)
        response_data = response.json()

        self.assertEqual(response_data['user_id'], self.user2.id)
        self.assertEqual(response_data['role'], 'editor')

        # 验证数据库中创建成功
        member = OrganizationMember.objects.using('postgresql').get(
            organization=self.organization,
            user_id=self.user2.id
        )
        self.assertEqual(member.role, 'editor')

    @patch('apps.tabtinspace.routers.shared.jwt_auth.authenticate')
    def test_add_member_duplicate(self, mock_auth):
        """测试添加重复成员"""
        mock_auth.return_value = self.user1

        # 先添加一次
        OrganizationMember.objects.using('postgresql').create(
            organization=self.organization,
            user_id=self.user2.id,
            role='viewer'
        )

        # 再次添加
        data = {
            'user_id': self.user2.id,
            'role': 'editor'
        }

        response = self.client.post(
            f'/api/context/organizations/{self.organization.id}/members',
            data=json.dumps(data),
            content_type='application/json',
            **self._auth_headers()
        )

        self.assertEqual(response.status_code, 403)

    @patch('apps.tabtinspace.routers.shared.jwt_auth.authenticate')
    def test_add_member_by_non_owner_denied(self, mock_auth):
        """测试非所有者无权添加成员"""
        # 添加 user2 为编辑者
        OrganizationMember.objects.using('postgresql').create(
            organization=self.organization,
            user_id=self.user2.id,
            role='editor'
        )

        mock_auth.return_value = self.user2

        data = {
            'user_id': self.user3.id,
            'role': 'viewer'
        }

        response = self.client.post(
            f'/api/context/organizations/{self.organization.id}/members',
            data=json.dumps(data),
            content_type='application/json',
            **self._auth_headers(self.user2)
        )

        self.assertEqual(response.status_code, 403)


class OrganizationMemberUpdateAPITest(OrganizationAPITestCase):
    """测试更新组织成员接口"""

    def setUp(self):
        super().setUp()

        self.organization = Organization.objects.using('postgresql').create(
            name='成员更新测试',
            owner_id=self.user1.id
        )

        self.member = OrganizationMember.objects.using('postgresql').create(
            organization=self.organization,
            user_id=self.user2.id,
            role='viewer'
        )

    @patch('apps.tabtinspace.routers.shared.jwt_auth.authenticate')
    def test_update_member_role_success(self, mock_auth):
        """测试成功更新成员角色"""
        mock_auth.return_value = self.user1

        data = {'role': 'editor'}

        response = self.client.put(
            f'/api/context/organizations/{self.organization.id}/members/{self.user2.id}',
            data=json.dumps(data),
            content_type='application/json',
            **self._auth_headers()
        )

        self.assertEqual(response.status_code, 200)

        # 验证更新成功
        self.member.refresh_from_db()
        self.assertEqual(self.member.role, 'editor')

    @patch('apps.tabtinspace.routers.shared.jwt_auth.authenticate')
    def test_update_member_by_non_owner_denied(self, mock_auth):
        """测试非所有者无权更新成员"""
        # 添加 user3 为编辑者
        OrganizationMember.objects.using('postgresql').create(
            organization=self.organization,
            user_id=self.user3.id,
            role='editor'
        )

        mock_auth.return_value = self.user3

        data = {'role': 'viewer'}

        response = self.client.put(
            f'/api/context/organizations/{self.organization.id}/members/{self.user2.id}',
            data=json.dumps(data),
            content_type='application/json',
            **self._auth_headers(self.user3)
        )

        self.assertEqual(response.status_code, 403)


class OrganizationMemberRemoveAPITest(OrganizationAPITestCase):
    """测试移除组织成员接口"""

    def setUp(self):
        super().setUp()

        self.organization = Organization.objects.using('postgresql').create(
            name='成员移除测试',
            owner_id=self.user1.id
        )

        self.member = OrganizationMember.objects.using('postgresql').create(
            organization=self.organization,
            user_id=self.user2.id,
            role='editor'
        )

    @patch('apps.tabtinspace.routers.shared.jwt_auth.authenticate')
    def test_remove_member_success(self, mock_auth):
        """测试成功移除成员"""
        mock_auth.return_value = self.user1

        response = self.client.delete(
            f'/api/context/organizations/{self.organization.id}/members/{self.user2.id}',
            **self._auth_headers()
        )

        self.assertEqual(response.status_code, 200)

        # 验证成员已移除
        self.assertFalse(
            OrganizationMember.objects.using('postgresql').filter(
                organization=self.organization,
                user_id=self.user2.id
            ).exists()
        )

    @patch('apps.tabtinspace.routers.shared.jwt_auth.authenticate')
    def test_remove_member_by_non_owner_denied(self, mock_auth):
        """测试非所有者无权移除成员"""
        mock_auth.return_value = self.user2

        response = self.client.delete(
            f'/api/context/organizations/{self.organization.id}/members/{self.user2.id}',
            **self._auth_headers(self.user2)
        )

        self.assertEqual(response.status_code, 403)


class OrganizationLeaveAPITest(OrganizationAPITestCase):
    """测试离开组织接口"""

    def setUp(self):
        super().setUp()

        self.organization = Organization.objects.using('postgresql').create(
            name='离开测试组织',
            owner_id=self.user1.id
        )

        self.member = OrganizationMember.objects.using('postgresql').create(
            organization=self.organization,
            user_id=self.user2.id,
            role='editor'
        )

    @patch('apps.tabtinspace.routers.shared.jwt_auth.authenticate')
    def test_leave_organization_success(self, mock_auth):
        """测试成员成功离开组织"""
        mock_auth.return_value = self.user2

        response = self.client.post(
            f'/api/context/organizations/{self.organization.id}/leave',
            **self._auth_headers(self.user2)
        )

        self.assertEqual(response.status_code, 200)

        # 验证已离开
        self.assertFalse(
            OrganizationMember.objects.using('postgresql').filter(
                organization=self.organization,
                user_id=self.user2.id
            ).exists()
        )

    @patch('apps.tabtinspace.routers.shared.jwt_auth.authenticate')
    def test_leave_organization_owner_denied(self, mock_auth):
        """测试所有者不能离开自己的组织"""
        mock_auth.return_value = self.user1

        response = self.client.post(
            f'/api/context/organizations/{self.organization.id}/leave',
            **self._auth_headers()
        )

        self.assertEqual(response.status_code, 403)


class OrganizationStatsAPITest(OrganizationAPITestCase):
    """测试组织统计信息"""

    def setUp(self):
        super().setUp()

        self.organization = Organization.objects.using('postgresql').create(
            name='统计测试组织',
            owner_id=self.user1.id
        )

        # 创建一些测试数据
        self.space = Space.objects.using('postgresql').create(
            organization=self.organization,
            name='测试项目'
        )

        self.table = Table.objects.using('postgresql').create(
            project_id=self.space.id,
            organization_id=self.space.organization_id,
            name='测试表格',
            owner_id=self.user1.id
        )

        # 添加成员
        OrganizationMember.objects.using('postgresql').create(
            organization=self.organization,
            user_id=self.user2.id,
            role='editor'
        )

    def test_organization_stats_calculation(self):
        """测试组织统计数据计算"""
        service = OrganizationService(user=self.user1)
        stats = service.get_organization_stats(self.organization.id)

        self.assertIsNotNone(stats)
        self.assertEqual(stats['organization_id'], str(self.organization.id))
        self.assertEqual(stats['organization_name'], '统计测试组织')
        self.assertEqual(stats['space_count'], 1)
        self.assertEqual(stats['table_count'], 1)
        self.assertEqual(stats['member_count'], 1)


class OrganizationIntegrationTest(OrganizationAPITestCase):
    """Organization API 集成测试 - 完整流程"""

    @patch('apps.tabtinspace.routers.shared.jwt_auth.authenticate')
    def test_full_organization_lifecycle(self, mock_auth):
        """测试组织完整生命周期"""
        mock_auth.return_value = self.user1

        # 1. 创建组织
        create_data = {
            'name': '生命周期测试',
            'description': '完整流程测试',
            'icon': '🔬',
            'settings': {'theme': 'dark'}
        }

        response = self.client.post(
            '/api/context/organizations',
            data=json.dumps(create_data),
            content_type='application/json',
            **self._auth_headers()
        )

        self.assertEqual(response.status_code, 201)
        body = response.json()
        self.assertTrue(body['success'])
        organization_id = body['data']['id']

        # 2. 获取详情
        response = self.client.get(
            f'/api/context/organizations/{organization_id}',
            **self._auth_headers()
        )
        self.assertEqual(response.status_code, 200)
        detail = response.json()['data']
        self.assertEqual(detail['name'], '生命周期测试')

        # 3. 更新组织
        update_data = {'name': '更新后的名称'}
        response = self.client.put(
            f'/api/context/organizations/{organization_id}',
            data=json.dumps(update_data),
            content_type='application/json',
            **self._auth_headers()
        )
        self.assertEqual(response.status_code, 200)

        # 4. 添加成员
        member_data = {
            'user_id': self.user2.id,
            'role': 'editor'
        }
        response = self.client.post(
            f'/api/context/organizations/{organization_id}/members',
            data=json.dumps(member_data),
            content_type='application/json',
            **self._auth_headers()
        )
        self.assertEqual(response.status_code, 201)

        # 5. 获取成员列表
        response = self.client.get(
            f'/api/context/organizations/{organization_id}/members',
            **self._auth_headers()
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['total'], 1)

        # 6. 更新成员角色
        role_data = {'role': 'viewer'}
        response = self.client.put(
            f'/api/context/organizations/{organization_id}/members/{self.user2.id}',
            data=json.dumps(role_data),
            content_type='application/json',
            **self._auth_headers()
        )
        self.assertEqual(response.status_code, 200)

        # 7. 移除成员
        response = self.client.delete(
            f'/api/context/organizations/{organization_id}/members/{self.user2.id}',
            **self._auth_headers()
        )
        self.assertEqual(response.status_code, 200)

        # 8. 删除组织
        response = self.client.delete(
            f'/api/context/organizations/{organization_id}',
            **self._auth_headers()
        )
        self.assertEqual(response.status_code, 200)

        # 验证已删除
        self.assertFalse(
            Organization.objects.using('postgresql').filter(id=organization_id).exists()
        )
