"""
TabData API 接口测试
测试 Organization 相关的所有 API 端点
"""

import json
import uuid
from django.test import TestCase, Client
from django.contrib.auth import get_user_model
from apps.tabtinspace.models import Organization, OrganizationMember
from apps.users.auth.session_manager import SessionManager
from apps.users.auth.utils import generate_jwt_token

User = get_user_model()

_SESSION_COUNTER = 0


def _jwt_headers(user):
    global _SESSION_COUNTER
    _SESSION_COUNTER += 1
    raw_key = f'tabdata_test_session_{_SESSION_COUNTER:040d}'
    from datetime import timedelta
    from django.utils import timezone
    from apps.users.auth.models import UserSession
    UserSession.objects.get_or_create(
        session_key=SessionManager.hash_session_key(raw_key),
        defaults={
            'user': user,
            'session_type': 'web',
            'ip_address': '127.0.0.1',
            'user_agent': 'tabdata-test',
            'expires_at': timezone.now() + timedelta(hours=2),
        },
    )
    token = generate_jwt_token(user, expire_hours=1, token_type='access', session_key=raw_key)
    return {'HTTP_AUTHORIZATION': f'Bearer {token}'}


class OrganizationAPITest(TestCase):
    """组织 API 测试"""
    databases = {"default", "postgresql"}

    def setUp(self):
        """设置测试数据"""
        self.client = Client()

        self.user1 = User.objects.create_user(
            username='testuser1',
            email='test1@example.com',
            password='testpass123'
        )

        self.user2 = User.objects.create_user(
            username='testuser2',
            email='test2@example.com',
            password='testpass123'
        )

        self.organization = Organization.objects.create(
            name='测试组织',
            description='测试描述',
            owner=self.user1
        )

        self._auth = _jwt_headers(self.user1)

    def test_create_organization(self):
        """测试创建组织"""
        data = {
            'name': '新组织',
            'description': '新组织描述',
            'settings': {'theme': 'dark'}
        }

        response = self.client.post(
            '/api/context/organizations',
            data=json.dumps(data),
            content_type='application/json',
            **self._auth
        )

        self.assertEqual(response.status_code, 201)
        response_data = response.json()

        self.assertTrue(response_data['success'])
        self.assertEqual(response_data['data']['name'], '新组织')
        self.assertEqual(response_data['data']['description'], '新组织描述')
        self.assertEqual(response_data['data']['owner_id'], str(self.user1.id))

        # 验证数据库中的记录
        organization = Organization.objects.get(name='新组织')
        self.assertEqual(organization.owner, self.user1)
        self.assertEqual(organization.settings, {'theme': 'dark'})

    def test_create_organization_invalid_data(self):
        """测试创建组织 - 无效数据"""
        data = {
            'name': '',  # 空名称
            'description': '描述'
        }

        response = self.client.post(
            '/api/context/organizations',
            data=json.dumps(data),
            content_type='application/json',
            **self._auth
        )

        self.assertEqual(response.status_code, 400)
        response_data = response.json()
        self.assertFalse(response_data.get('success'))

    def test_get_organization_list(self):
        """测试获取组织列表"""
        # 创建另一个组织
        organization2 = Organization.objects.create(
            name='组织2',
            owner=self.user1
        )

        response = self.client.get('/api/context/organizations', **self._auth)

        self.assertEqual(response.status_code, 200)
        response_data = response.json()

        self.assertTrue(response_data['success'])
        organizations = response_data['data']['organizations']
        self.assertEqual(len(organizations), 3)
        self.assertEqual(response_data['data']['total'], 3)
        self.assertEqual(response_data['data']['page'], 1)
        self.assertEqual(response_data['data']['page_size'], 50)

        # 验证返回的组织
        organization_names = [item['name'] for item in organizations]
        self.assertIn('测试组织', organization_names)
        self.assertIn('组织2', organization_names)
        self.assertIn(f'{self.user1.get_display_name()}的组织', organization_names)

    def test_get_organization_detail(self):
        """测试获取组织详情"""
        organization_id = self.organization.id
        response = self.client.get(
            f'/api/context/organizations/{organization_id}',
            **self._auth
        )

        self.assertEqual(response.status_code, 200)
        response_data = response.json()

        self.assertTrue(response_data['success'])
        self.assertEqual(response_data['data']['id'], str(self.organization.id))
        self.assertEqual(response_data['data']['name'], '测试组织')
        self.assertEqual(response_data['data']['description'], '测试描述')

    def test_get_organization_detail_not_found(self):
        """测试获取不存在的组织详情"""
        fake_id = uuid.uuid4()
        response = self.client.get(
            f'/api/context/organizations/{fake_id}',
            **self._auth
        )

        self.assertEqual(response.status_code, 404)
        response_data = response.json()
        self.assertFalse(response_data.get('success'))

    def test_update_organization(self):
        """测试更新组织"""
        organization_id = self.organization.id
        data = {
            'name': '更新后的组织',
            'description': '更新后的描述',
            'settings': {'theme': 'light', 'language': 'en'}
        }

        response = self.client.put(
            f'/api/context/organizations/{organization_id}',
            data=json.dumps(data),
            content_type='application/json',
            **self._auth
        )

        self.assertEqual(response.status_code, 200)
        response_data = response.json()

        self.assertTrue(response_data['success'])
        self.assertEqual(response_data['data']['name'], '更新后的组织')
        self.assertEqual(response_data['data']['description'], '更新后的描述')

        # 验证数据库中的更新
        self.organization.refresh_from_db()
        self.assertEqual(self.organization.name, '更新后的组织')
        self.assertEqual(self.organization.settings, {'theme': 'light', 'language': 'en'})

    def test_update_organization_unauthorized(self):
        """测试更新组织 - 未授权"""
        organization_id = self.organization.id
        data = {'name': '尝试更新'}

        response = self.client.put(
            f'/api/context/organizations/{organization_id}',
            data=json.dumps(data),
            content_type='application/json',
            **_jwt_headers(self.user2)
        )

        self.assertEqual(response.status_code, 403)
        response_data = response.json()
        self.assertFalse(response_data.get('success'))

    def test_delete_organization(self):
        """测试删除组织"""
        organization_id = self.organization.id

        response = self.client.delete(
            f'/api/context/organizations/{organization_id}',
            **self._auth
        )

        self.assertEqual(response.status_code, 200)
        response_data = response.json()
        self.assertTrue(response_data['success'])

        # 验证组织被删除
        self.assertFalse(Organization.objects.filter(id=organization_id).exists())

    def test_delete_organization_unauthorized(self):
        """测试删除组织 - 未授权"""
        organization_id = self.organization.id
        response = self.client.delete(
            f'/api/context/organizations/{organization_id}',
            **_jwt_headers(self.user2)
        )

        self.assertEqual(response.status_code, 403)
        response_data = response.json()
        self.assertFalse(response_data.get('success'))

        # 验证组织未被删除
        self.assertTrue(Organization.objects.filter(id=self.organization.id).exists())


class OrganizationMemberAPITest(TestCase):
    """组织成员 API 测试"""
    databases = {"default", "postgresql"}

    def setUp(self):
        """设置测试数据"""
        self.client = Client()

        # 创建测试用户
        self.owner = User.objects.create_user(
            username='owner',
            email='owner@example.com',
            password='testpass123'
        )

        self.member = User.objects.create_user(
            username='member',
            email='member@example.com',
            password='testpass123'
        )

        self.user3 = User.objects.create_user(
            username='user3',
            email='user3@example.com',
            password='testpass123'
        )

        # 创建测试组织
        self.organization = Organization.objects.create(
            name='测试组织',
            owner=self.owner
        )

        # 添加一个成员
        self.organization_member = OrganizationMember.objects.create(
            organization=self.organization,
            user=self.member,
            role='editor',
        )

        self._auth = _jwt_headers(self.owner)

    def test_add_organization_member(self):
        """测试添加组织成员"""
        organization_id = self.organization.id
        data = {
            'user_id': str(self.user3.id),
            'role': 'viewer',
        }

        response = self.client.post(
            f'/api/context/organizations/{organization_id}/members',
            data=json.dumps(data),
            content_type='application/json',
            **self._auth
        )

        self.assertEqual(response.status_code, 201)
        response_data = response.json()

        self.assertTrue(response_data['success'])
        self.assertEqual(response_data['data']['user_id'], str(self.user3.id))
        self.assertEqual(response_data['data']['role'], 'viewer')

        # 验证数据库中的记录
        member = OrganizationMember.objects.get(
            organization=self.organization,
            user=self.user3
        )
        self.assertEqual(member.role, 'viewer')

    def test_add_organization_member_duplicate(self):
        """测试添加重复的组织成员"""
        organization_id = self.organization.id
        data = {
            'user_id': str(self.member.id),
            'role': 'admin'
        }

        response = self.client.post(
            f'/api/context/organizations/{organization_id}/members',
            data=json.dumps(data),
            content_type='application/json',
            **self._auth
        )

        self.assertEqual(response.status_code, 400)
        response_data = response.json()
        self.assertFalse(response_data.get('success'))

    def test_get_organization_members(self):
        """测试获取组织成员列表"""
        organization_id = self.organization.id
        response = self.client.get(
            f'/api/context/organizations/{organization_id}/members',
            **self._auth
        )

        self.assertEqual(response.status_code, 200)
        response_data = response.json()

        self.assertTrue(response_data['success'])
        members = response_data['data']['members']
        self.assertEqual(len(members), 1)
        self.assertEqual(response_data['data']['total'], 1)

        member_data = members[0]
        self.assertEqual(member_data['user_id'], str(self.member.id))
        self.assertEqual(member_data['role'], 'editor')

    def test_update_organization_member(self):
        """测试更新组织成员"""
        organization_id = self.organization.id
        target_user_id = str(self.member.id)
        data = {'role': 'admin'}

        response = self.client.put(
            f'/api/context/organizations/{organization_id}/members/{target_user_id}',
            data=json.dumps(data),
            content_type='application/json',
            **self._auth
        )

        self.assertEqual(response.status_code, 200)
        response_data = response.json()

        self.assertTrue(response_data['success'])

        # 验证数据库中的更新（PUT 仅返回 message，不含更新后的成员体）
        self.organization_member.refresh_from_db()
        self.assertEqual(self.organization_member.role, 'admin')

    def test_remove_organization_member(self):
        """测试移除组织成员"""
        organization_id = self.organization.id
        target_user_id = str(self.member.id)

        response = self.client.delete(
            f'/api/context/organizations/{organization_id}/members/{target_user_id}',
            **self._auth
        )

        self.assertEqual(response.status_code, 200)
        response_data = response.json()
        self.assertTrue(response_data['success'])

        # 验证成员被移除
        self.assertFalse(
            OrganizationMember.objects.filter(
                organization_id=organization_id,
                user_id=target_user_id,
            ).exists()
        )

    def test_organization_member_unauthorized_access(self):
        """测试未授权访问组织成员"""
        organization_id = self.organization.id
        response = self.client.get(
            f'/api/context/organizations/{organization_id}/members',
            **_jwt_headers(self.user3)
        )

        # 非成员对列表接口会收到「不存在」以避免泄漏资源信息
        self.assertEqual(response.status_code, 404)
        response_data = response.json()
        self.assertFalse(response_data.get('success'))


class OrganizationPermissionTest(TestCase):
    """组织权限测试"""
    databases = {"default", "postgresql"}

    def setUp(self):
        """设置测试数据"""
        self.client = Client()

        # 创建测试用户
        self.owner = User.objects.create_user(
            username='owner',
            email='owner@example.com',
            password='testpass123'
        )

        self.admin = User.objects.create_user(
            username='admin',
            email='admin@example.com',
            password='testpass123'
        )

        self.editor = User.objects.create_user(
            username='editor',
            email='editor@example.com',
            password='testpass123'
        )

        self.viewer = User.objects.create_user(
            username='viewer',
            email='viewer@example.com',
            password='testpass123'
        )

        # 创建测试组织
        self.organization = Organization.objects.create(
            name='测试组织',
            owner=self.owner
        )

        # 添加不同角色的成员
        OrganizationMember.objects.create(
            organization=self.organization,
            user=self.admin,
            role='admin',
        )

        OrganizationMember.objects.create(
            organization=self.organization,
            user=self.editor,
            role='editor',
        )

        OrganizationMember.objects.create(
            organization=self.organization,
            user=self.viewer,
            role='viewer',
        )

    def test_owner_permissions(self):
        """测试所有者权限"""
        auth = _jwt_headers(self.owner)
        organization_id = self.organization.id

        # 所有者可以更新组织
        response = self.client.put(
            f'/api/context/organizations/{organization_id}',
            data=json.dumps({'name': '更新名称'}),
            content_type='application/json',
            **auth
        )
        self.assertEqual(response.status_code, 200)

        # 所有者可以删除组织
        response = self.client.delete(
            f'/api/context/organizations/{organization_id}',
            **auth
        )
        self.assertEqual(response.status_code, 200)

    def test_admin_permissions(self):
        """测试管理员权限"""
        auth = _jwt_headers(self.admin)
        organization_id = self.organization.id

        # 管理员可以查看组织
        response = self.client.get(
            f'/api/context/organizations/{organization_id}',
            **auth
        )
        self.assertEqual(response.status_code, 200)

        # 管理员可以管理成员
        response = self.client.get(
            f'/api/context/organizations/{organization_id}/members',
            **auth
        )
        self.assertEqual(response.status_code, 200)

    def test_editor_permissions(self):
        """测试编辑者权限"""
        auth = _jwt_headers(self.editor)
        organization_id = self.organization.id

        # 编辑者可以查看组织
        response = self.client.get(
            f'/api/context/organizations/{organization_id}',
            **auth
        )
        self.assertEqual(response.status_code, 200)

        # 编辑者不能删除组织
        response = self.client.delete(
            f'/api/context/organizations/{organization_id}',
            **auth
        )
        self.assertEqual(response.status_code, 403)

    def test_viewer_permissions(self):
        """测试查看者权限"""
        auth = _jwt_headers(self.viewer)
        organization_id = self.organization.id

        # 查看者可以查看组织
        response = self.client.get(
            f'/api/context/organizations/{organization_id}',
            **auth
        )
        self.assertEqual(response.status_code, 200)

        # 查看者不能更新组织
        response = self.client.put(
            f'/api/context/organizations/{organization_id}',
            data=json.dumps({'name': '尝试更新'}),
            content_type='application/json',
            **auth
        )
        self.assertEqual(response.status_code, 403)


class OrganizationAPIIntegrationTest(TestCase):
    """组织 API 集成测试"""
    databases = {"default", "postgresql"}

    def setUp(self):
        """设置测试数据"""
        self.client = Client()

        self.user = User.objects.create_user(
            username='testuser',
            email='test@example.com',
            password='testpass123'
        )

        self._auth = _jwt_headers(self.user)

    def test_organization_full_lifecycle(self):
        """测试组织完整生命周期"""
        # 1. 创建组织
        create_data = {
            'name': '生命周期测试组织',
            'description': '测试完整生命周期',
            'settings': {'theme': 'dark'}
        }

        response = self.client.post(
            '/api/context/organizations',
            data=json.dumps(create_data),
            content_type='application/json',
            **self._auth
        )

        self.assertEqual(response.status_code, 201)
        organization_id = response.json()['data']['id']

        # 2. 获取组织详情
        response = self.client.get(
            f'/api/context/organizations/{organization_id}',
            **self._auth
        )
        self.assertEqual(response.status_code, 200)

        # 3. 更新组织
        update_data = {
            'name': '更新后的组织',
            'description': '更新后的描述'
        }

        response = self.client.put(
            f'/api/context/organizations/{organization_id}',
            data=json.dumps(update_data),
            content_type='application/json',
            **self._auth
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['data']['name'], '更新后的组织')

        # 4. 添加成员
        member = User.objects.create_user(
            username='member',
            email='member@example.com',
            password='testpass123'
        )

        member_data = {
            'user_id': str(member.id),
            'role': 'editor'
        }

        response = self.client.post(
            f'/api/context/organizations/{organization_id}/members',
            data=json.dumps(member_data),
            content_type='application/json',
            **self._auth
        )

        self.assertEqual(response.status_code, 201)

        # 5. 获取成员列表
        response = self.client.get(
            f'/api/context/organizations/{organization_id}/members',
            **self._auth
        )
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        members = payload['data']['members']
        # 创建团队时 owner 会写入成员表，再加一名 editor 共 2 人
        self.assertEqual(len(members), 2)
        self.assertEqual(payload['data']['total'], 2)
        member_user_ids = {m['user_id'] for m in members}
        self.assertIn(str(member.id), member_user_ids)

        # 6. 删除组织
        response = self.client.delete(
            f'/api/context/organizations/{organization_id}',
            **self._auth
        )
        self.assertEqual(response.status_code, 200)

        # 验证组织和相关数据被删除
        self.assertFalse(Organization.objects.filter(id=organization_id).exists())
        self.assertFalse(OrganizationMember.objects.filter(organization_id=organization_id).exists())


if __name__ == '__main__':
    import unittest
    unittest.main()
