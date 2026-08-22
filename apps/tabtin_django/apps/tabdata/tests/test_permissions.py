"""
权限系统测试

覆盖 TabData 的 RBAC 权限模型：
1. Service 层权限检查（check_table_permission / check_organization_permission / check_space_permission）
2. API 层权限验证（未认证拒绝、角色级操作边界）
3. 跨 Organization 隔离
4. Owner 为空（SET_NULL）场景
"""

import json
import uuid
from unittest.mock import patch, MagicMock

from django.contrib.auth import get_user_model
from django.test import TestCase, Client, RequestFactory

from apps.tabtinspace.models import (
    Organization, OrganizationMember, Workspace, Device, SpaceMembership,
)
from apps.tabdata.models import Table, TableField, TableRecord
from apps.tabdata.services.base import BaseService
from apps.tabdata.auth_open_api import require_space_access
from apps.users.auth.utils import generate_jwt_token
from apps.users.membership.models import MembershipTier

User = get_user_model()


def _ensure_free_tier() -> None:
    """确保测试环境存在 free 会员等级，避免配额校验阻塞业务测试。"""
    MembershipTier.objects.update_or_create(
        tier_type='free',
        defaults={
            'name': '免费版',
            'description': '权限测试自动初始化',
            'max_tables': -1,
            'max_records_per_table': -1,
            'max_api_calls_per_day': -1,
            'max_crawl_tasks_per_day': -1,
            'features': {},
            'sort_order': 0,
            'is_active': True,
        }
    )


def _create_workspace(organization, owner, name, *, agent=None):
    """创建测试 Workspace（：Space 表已 DROP，供给方式参考
    apps/tabtinspace/tests/fixtures.py 的 create_test_bot_space）。"""
    device = Device.objects.create(
        organization=organization,
        user=owner,
        name=f'{name}-设备',
        device_type='electron',
        role='control',
        fingerprint=f'perm-test-{uuid.uuid4().hex}',
    )
    working_dir = f'/tmp/perm-test-{uuid.uuid4().hex}'
    # ：现场不挂 agent；可选身份走 SpaceMembership
    workspace = Workspace.objects.create(
        organization=organization,
        device=device,
        name=name,
        working_dir=working_dir,
        normalized_working_dir=working_dir,
        created_by=owner,
    )
    if agent is not None:
        SpaceMembership.objects.get_or_create(
            workspace_id=workspace.id,
            agent_id=agent.id,
            defaults={"role": "owner", "is_active": True, "permissions": {}},
        )
    return workspace


def _ensure_project_membership(organization, project, user, role):
    """确保用户在 Workspace 内具备明确角色。

    ：Agent 不再充当用户影子身份，个人域权限判定
    （space_visibility.resolve_user_space_role）只认直挂 user 的
    SpaceMembership，因此改为直接对 user 授予角色。
    """
    SpaceMembership.objects.update_or_create(
        workspace=project,
        user=user,
        defaults={
            'role': role,
            'is_active': True,
        },
    )


def _auth_header(token):
    """构造 JWT Bearer header。"""
    return {'HTTP_AUTHORIZATION': f'Bearer {token}'}


# ==================== Service 层权限测试 ====================

class TestBaseServicePermission(TestCase):
    """测试 BaseService 的权限检查方法"""

    databases = ['default', 'postgresql']

    def setUp(self):
        _ensure_free_tier()

        self.owner = User.objects.create_user(
            username='perm_owner', email='perm_owner@test.com', password='pass123'
        )
        self.admin = User.objects.create_user(
            username='perm_admin', email='perm_admin@test.com', password='pass123'
        )
        self.editor = User.objects.create_user(
            username='perm_editor', email='perm_editor@test.com', password='pass123'
        )
        self.viewer = User.objects.create_user(
            username='perm_viewer', email='perm_viewer@test.com', password='pass123'
        )
        self.outsider = User.objects.create_user(
            username='perm_outsider', email='perm_outsider@test.com', password='pass123'
        )

        # Organization → owner 拥有
        self.organization = Organization.objects.create(
            name='权限测试组织',
            owner=self.owner,
        )
        OrganizationMember.objects.create(organization=self.organization, user=self.owner, role='owner')
        OrganizationMember.objects.create(organization=self.organization, user=self.admin, role='admin')
        OrganizationMember.objects.create(organization=self.organization, user=self.editor, role='editor')
        OrganizationMember.objects.create(organization=self.organization, user=self.viewer, role='viewer')

        # Workspace（：Space 表已 DROP，改用 Workspace）
        self.space = _create_workspace(self.organization, self.owner, '权限测试项目')
        _ensure_project_membership(self.organization, self.space, self.owner, 'owner')
        _ensure_project_membership(self.organization, self.space, self.admin, 'admin')
        _ensure_project_membership(self.organization, self.space, self.editor, 'editor')
        _ensure_project_membership(self.organization, self.space, self.viewer, 'viewer')

        # Table
        self.table = Table.objects.create(
            space_id=self.space.id,
            organization_id=self.space.organization_id,
            name='权限测试表格',
            owner=self.owner,
        )

    # ── check_organization_permission ──

    def test_organization_owner_has_all_permissions(self):
        """Organization owner 应拥有最高权限"""
        svc = BaseService(user=self.owner)
        self.assertTrue(svc.check_organization_permission(str(self.organization.id), 'owner'))
        self.assertTrue(svc.check_organization_permission(str(self.organization.id), 'admin'))
        self.assertTrue(svc.check_organization_permission(str(self.organization.id), 'editor'))
        self.assertTrue(svc.check_organization_permission(str(self.organization.id), 'viewer'))

    def test_organization_admin_level(self):
        """Admin 可以执行 admin 及以下操作，但不能执行 owner 操作"""
        svc = BaseService(user=self.admin)
        self.assertTrue(svc.check_organization_permission(str(self.organization.id), 'admin'))
        self.assertTrue(svc.check_organization_permission(str(self.organization.id), 'editor'))
        self.assertTrue(svc.check_organization_permission(str(self.organization.id), 'viewer'))
        # admin 没有 owner 级别权限（organization owner 不是 admin 用户）
        self.assertFalse(svc.check_organization_permission(str(self.organization.id), 'owner'))

    def test_organization_editor_level(self):
        """Editor 可以查看和编辑，但不能执行 admin/owner 操作"""
        svc = BaseService(user=self.editor)
        self.assertTrue(svc.check_organization_permission(str(self.organization.id), 'viewer'))
        self.assertTrue(svc.check_organization_permission(str(self.organization.id), 'editor'))
        self.assertFalse(svc.check_organization_permission(str(self.organization.id), 'admin'))
        self.assertFalse(svc.check_organization_permission(str(self.organization.id), 'owner'))

    def test_organization_viewer_level(self):
        """Viewer 只能查看"""
        svc = BaseService(user=self.viewer)
        self.assertTrue(svc.check_organization_permission(str(self.organization.id), 'viewer'))
        self.assertFalse(svc.check_organization_permission(str(self.organization.id), 'editor'))
        self.assertFalse(svc.check_organization_permission(str(self.organization.id), 'admin'))
        self.assertFalse(svc.check_organization_permission(str(self.organization.id), 'owner'))

    def test_outsider_has_no_organization_permission(self):
        """非成员用户没有任何 Organization 权限"""
        svc = BaseService(user=self.outsider)
        self.assertFalse(svc.check_organization_permission(str(self.organization.id), 'viewer'))

    def test_none_user_has_no_organization_permission(self):
        """未认证用户（user=None）没有任何权限"""
        svc = BaseService(user=None)
        self.assertFalse(svc.check_organization_permission(str(self.organization.id), 'viewer'))

    def test_nonexistent_organization_returns_false(self):
        """不存在的 Organization 返回 False"""
        svc = BaseService(user=self.owner)
        fake_id = str(uuid.uuid4())
        self.assertFalse(svc.check_organization_permission(fake_id, 'viewer'))

    def test_user_space_membership_grants_space_permission(self):
        """直接 user membership 也应被视为合法的 Space 权限来源。"""
        dm_space = _create_workspace(self.organization, self.viewer, 'DM 权限空间')
        SpaceMembership.objects.create(
            workspace=dm_space,
            user=self.viewer,
            role='editor',
            is_active=True,
        )

        viewer_svc = BaseService(user=self.viewer)
        outsider_svc = BaseService(user=self.outsider)

        self.assertTrue(viewer_svc.check_space_permission(str(dm_space.id), 'editor'))
        self.assertFalse(outsider_svc.check_space_permission(str(dm_space.id), 'viewer'))

    # ── check_table_permission ──

    def test_table_permission_inherits_from_project(self):
        """表格权限继承自 Space 权限"""
        # owner 可以编辑
        svc = BaseService(user=self.owner)
        self.assertTrue(svc.check_table_permission(str(self.table.id), 'editor'))

        # viewer 不能编辑
        svc = BaseService(user=self.viewer)
        self.assertFalse(svc.check_table_permission(str(self.table.id), 'editor'))

        # viewer 可以查看
        self.assertTrue(svc.check_table_permission(str(self.table.id), 'viewer'))

    def test_outsider_has_no_table_permission(self):
        """外部用户没有任何表格权限"""
        svc = BaseService(user=self.outsider)
        self.assertFalse(svc.check_table_permission(str(self.table.id), 'viewer'))

    def test_nonexistent_table_returns_false(self):
        """不存在的 Table 返回 False"""
        svc = BaseService(user=self.owner)
        fake_id = str(uuid.uuid4())
        self.assertFalse(svc.check_table_permission(fake_id, 'viewer'))

    # ── get_table_role ──

    def test_get_table_role_returns_owner_for_table_owner(self):
        """表格创建者获得 'owner' 角色"""
        svc = BaseService(user=self.owner)
        self.assertEqual(svc.get_table_role(str(self.table.id)), 'owner')

    def test_get_table_role_returns_correct_role(self):
        """各角色成员获得正确的角色字符串"""
        svc = BaseService(user=self.editor)
        role = svc.get_table_role(str(self.table.id))
        # editor 的 organization role 是 editor
        self.assertEqual(role, 'editor')

    def test_get_table_role_returns_none_for_outsider(self):
        """外部用户获得 None"""
        svc = BaseService(user=self.outsider)
        self.assertIsNone(svc.get_table_role(str(self.table.id)))

    def test_get_table_role_returns_none_for_none_user(self):
        """未认证用户获得 None"""
        svc = BaseService(user=None)
        self.assertIsNone(svc.get_table_role(str(self.table.id)))


class TestRequireSpaceAccessDecorator(TestCase):
    """验证 OpenAPI 的 Space 访问装饰器兼容 `space_id` 路由参数。"""

    databases = ['default', 'postgresql']

    def setUp(self):
        _ensure_free_tier()
        self.factory = RequestFactory()
        self.user = User.objects.create_user(
            username='decorator_user',
            email='decorator_user@test.com',
            password='pass123',
        )
        self.outsider = User.objects.create_user(
            username='decorator_outsider',
            email='decorator_outsider@test.com',
            password='pass123',
        )
        self.organization = Organization.objects.create(
            name='Decorator 权限测试空间',
            owner=self.user,
        )
        OrganizationMember.objects.create(organization=self.organization, user=self.user, role='owner')
        self.dm_space = _create_workspace(self.organization, self.user, 'Decorator DM')
        SpaceMembership.objects.create(
            workspace=self.dm_space,
            user=self.user,
            role='editor',
            is_active=True,
        )

    def test_accepts_space_id_and_direct_user_membership(self):
        marker = object()

        @require_space_access
        def _view(request, *args, **kwargs):
            return marker

        request = self.factory.get('/fake')
        request.auth = self.user
        request.api_token = None

        result = _view(request, space_id=str(self.dm_space.id))
        self.assertIs(result, marker)

    def test_rejects_outsider_with_space_id_param(self):
        @require_space_access
        def _view(request, *args, **kwargs):
            return {'ok': True}

        request = self.factory.get('/fake')
        request.auth = self.outsider
        request.api_token = None

        status, payload = _view(request, space_id=str(self.dm_space.id))
        self.assertEqual(status, 403)
        self.assertEqual(payload['code'], 'SPACE_ACCESS_DENIED')


# ==================== Owner SET_NULL 安全性测试 ====================

class TestTableOwnerSetNull(TestCase):
    """测试 Table.owner SET_NULL 后的兼容性"""

    databases = ['default', 'postgresql']

    def setUp(self):
        _ensure_free_tier()

        self.user = User.objects.create_user(
            username='owner_null_test', email='owner_null@test.com', password='pass123'
        )
        self.organization = Organization.objects.create(
            name='OwnerNull 组织', owner=self.user
        )
        self.space = _create_workspace(self.organization, self.user, 'OwnerNull 项目')
        _ensure_project_membership(self.organization, self.space, self.user, 'owner')

    def test_table_with_null_owner_is_valid(self):
        """owner=None 的表格可以正常创建"""
        table = Table.objects.create(
            space_id=self.space.id,
            organization_id=self.space.organization_id,
            name='无主表格',
            owner=None,
        )
        table.refresh_from_db()
        self.assertIsNone(table.owner_id)
        self.assertEqual(table.name, '无主表格')

    def test_table_permission_works_with_null_owner(self):
        """owner=None 的表格权限检查不崩溃"""
        table = Table.objects.create(
            space_id=self.space.id,
            organization_id=self.space.organization_id,
            name='无主表格',
            owner=None,
        )
        svc = BaseService(user=self.user)
        # 用户通过 project membership 仍然有权限
        self.assertTrue(svc.check_table_permission(str(table.id), 'editor'))

    def test_get_table_role_with_null_owner(self):
        """owner=None 时 get_table_role 返回 organization 角色而非崩溃"""
        table = Table.objects.create(
            space_id=self.space.id,
            organization_id=self.space.organization_id,
            name='无主表格',
            owner=None,
        )
        svc = BaseService(user=self.user)
        role = svc.get_table_role(str(table.id))
        # user 是 organization owner，应该得到 'owner'
        self.assertEqual(role, 'owner')


# ==================== API 层权限测试 ====================

class TestAPIPermissions(TestCase):
    """测试 API 端点的权限控制"""

    databases = ['default', 'postgresql']

    def setUp(self):
        _ensure_free_tier()

        self.client = Client()

        self.owner = User.objects.create_user(
            username='api_perm_owner', email='api_perm_owner@test.com', password='pass123'
        )
        self.editor = User.objects.create_user(
            username='api_perm_editor', email='api_perm_editor@test.com', password='pass123'
        )
        self.viewer = User.objects.create_user(
            username='api_perm_viewer', email='api_perm_viewer@test.com', password='pass123'
        )
        self.outsider = User.objects.create_user(
            username='api_perm_outsider', email='api_perm_outsider@test.com', password='pass123'
        )

        self.owner_token = generate_jwt_token(self.owner, expire_hours=1, token_type='access')
        self.editor_token = generate_jwt_token(self.editor, expire_hours=1, token_type='access')
        self.viewer_token = generate_jwt_token(self.viewer, expire_hours=1, token_type='access')
        self.outsider_token = generate_jwt_token(self.outsider, expire_hours=1, token_type='access')

        # Organization + Members
        self.organization = Organization.objects.create(
            name='API权限测试空间', owner=self.owner
        )
        OrganizationMember.objects.create(organization=self.organization, user=self.owner, role='owner')
        OrganizationMember.objects.create(organization=self.organization, user=self.editor, role='editor')
        OrganizationMember.objects.create(organization=self.organization, user=self.viewer, role='viewer')

        # Workspace + Memberships
        self.space = _create_workspace(self.organization, self.owner, 'API权限测试项目')
        _ensure_project_membership(self.organization, self.space, self.owner, 'owner')
        _ensure_project_membership(self.organization, self.space, self.editor, 'editor')
        _ensure_project_membership(self.organization, self.space, self.viewer, 'viewer')

        # Table + Fields
        self.table = Table.objects.create(
            space_id=self.space.id, organization_id=self.space.organization_id, name='API权限测试表', owner=self.owner
        )
        self.pk_field = TableField.objects.create(
            table=self.table, name='标题', field_type='text',
            is_primary=True, order=0
        )
        self.text_field = TableField.objects.create(
            table=self.table, name='备注', field_type='text', order=1
        )

        # 创建测试记录
        self.record = TableRecord.objects.create(
            table=self.table,
            created_by=self.owner,
            data={
                str(self.pk_field.id): '测试记录',
                str(self.text_field.id): '一些备注',
            }
        )

    # ── 未认证访问 ──

    def test_unauthenticated_request_returns_401(self):
        """未携带 Token 的请求返回 401"""
        url = f'/api/tabdata/tables/{self.table.id}/fields'
        response = self.client.get(url)
        self.assertEqual(response.status_code, 401)

    def test_invalid_token_returns_401(self):
        """无效 Token 返回 401"""
        url = f'/api/tabdata/tables/{self.table.id}/fields'
        response = self.client.get(url, **_auth_header('invalid.jwt.token'))
        self.assertEqual(response.status_code, 401)

    # ── 字段列表（viewer 可读） ──

    def test_owner_can_list_fields(self):
        """Owner 可以获取字段列表"""
        url = f'/api/tabdata/tables/{self.table.id}/fields'
        response = self.client.get(url, **_auth_header(self.owner_token))
        self.assertEqual(response.status_code, 200)

    def test_viewer_can_list_fields(self):
        """Viewer 可以获取字段列表"""
        url = f'/api/tabdata/tables/{self.table.id}/fields'
        response = self.client.get(url, **_auth_header(self.viewer_token))
        self.assertEqual(response.status_code, 200)

    def test_outsider_cannot_list_fields(self):
        """外部用户无法获取字段列表"""
        url = f'/api/tabdata/tables/{self.table.id}/fields'
        response = self.client.get(url, **_auth_header(self.outsider_token))
        data = response.json()
        # 外部用户看不到表格，service 会返回空列表或权限拒绝
        if response.status_code == 200:
            self.assertEqual(data.get('data', {}).get('total', 0), 0)

    # ── 创建字段（需要 editor+） ──

    def test_editor_can_create_field(self):
        """Editor 可以创建字段"""
        url = '/api/tabdata/fields'
        payload = {
            'table_id': str(self.table.id),
            'name': 'Editor创建的字段',
            'field_type': 'text',
        }
        response = self.client.post(
            url,
            data=json.dumps(payload),
            content_type='application/json',
            **_auth_header(self.editor_token),
        )
        self.assertIn(response.status_code, [200, 201])

    def test_viewer_cannot_create_field(self):
        """Viewer 无法创建字段"""
        url = '/api/tabdata/fields'
        payload = {
            'table_id': str(self.table.id),
            'name': 'Viewer尝试创建',
            'field_type': 'text',
        }
        response = self.client.post(
            url,
            data=json.dumps(payload),
            content_type='application/json',
            **_auth_header(self.viewer_token),
        )
        # 权限不足应返回 403 或创建失败
        if response.status_code == 200:
            data = response.json()
            self.assertFalse(data.get('success', True))
        else:
            self.assertIn(response.status_code, [403, 422])

    # ── 创建记录（需要 editor+） ──

    @patch('apps.tabdata.services.record_service.RecordService._native_write_record')
    @patch('apps.tabdata.services.record_service.RecordService._native_get_io', return_value=MagicMock())
    def test_editor_can_create_record(self, mock_native_io, mock_native_write):
        """Editor 可以创建记录"""
        url = '/api/tabdata/records'
        payload = {
            'table_id': str(self.table.id),
            'data': {
                str(self.pk_field.id): 'Editor新记录',
            }
        }
        response = self.client.post(
            url,
            data=json.dumps(payload),
            content_type='application/json',
            **_auth_header(self.editor_token),
        )
        self.assertIn(response.status_code, [200, 201])

    def test_viewer_cannot_create_record(self):
        """Viewer 无法创建记录"""
        url = '/api/tabdata/records'
        payload = {
            'table_id': str(self.table.id),
            'data': {
                str(self.pk_field.id): 'Viewer尝试创建',
            }
        }
        response = self.client.post(
            url,
            data=json.dumps(payload),
            content_type='application/json',
            **_auth_header(self.viewer_token),
        )
        # Viewer 没有 editor 权限，创建应失败
        if response.status_code == 200:
            data = response.json()
            self.assertFalse(data.get('success', True))
        else:
            self.assertIn(response.status_code, [403, 422])

    # ── 删除字段（需要 editor+，且非主键） ──

    def test_viewer_cannot_delete_field(self):
        """Viewer 无法删除字段"""
        url = f'/api/tabdata/fields/{self.text_field.id}'
        response = self.client.delete(
            url,
            **_auth_header(self.viewer_token),
        )
        if response.status_code == 200:
            data = response.json()
            self.assertFalse(data.get('success', True))
        else:
            self.assertIn(response.status_code, [403, 404])

    def test_editor_can_delete_non_primary_field(self):
        """Editor 可以删除非主键字段"""
        # 创建一个临时字段用于删除
        temp_field = TableField.objects.create(
            table=self.table, name='待删除', field_type='text', order=10
        )
        url = f'/api/tabdata/fields/{temp_field.id}'
        response = self.client.delete(
            url,
            **_auth_header(self.editor_token),
        )
        self.assertEqual(response.status_code, 200)


# ==================== 跨 Organization 隔离测试 ====================

class TestCrossOrganizationIsolation(TestCase):
    """测试不同 Organization 之间的数据隔离"""

    databases = ['default', 'postgresql']

    def setUp(self):
        _ensure_free_tier()

        self.client = Client()

        # Organization A
        self.user_a = User.objects.create_user(
            username='ws_a_owner', email='ws_a@test.com', password='pass123'
        )
        self.organization_a = Organization.objects.create(
            name='组织A', owner=self.user_a
        )
        OrganizationMember.objects.create(
            organization=self.organization_a, user=self.user_a, role='owner'
        )
        self.space_a = _create_workspace(self.organization_a, self.user_a, '项目A')
        _ensure_project_membership(self.organization_a, self.space_a, self.user_a, 'owner')
        self.table_a = Table.objects.create(
            space_id=self.space_a.id, organization_id=self.space_a.organization_id, name='表格A', owner=self.user_a
        )
        self.field_a = TableField.objects.create(
            table=self.table_a, name='字段A', field_type='text',
            is_primary=True, order=0
        )

        # Organization B
        self.user_b = User.objects.create_user(
            username='ws_b_owner', email='ws_b@test.com', password='pass123'
        )
        self.organization_b = Organization.objects.create(
            name='组织B', owner=self.user_b
        )
        OrganizationMember.objects.create(
            organization=self.organization_b, user=self.user_b, role='owner'
        )
        self.space_b = _create_workspace(self.organization_b, self.user_b, '项目B')
        _ensure_project_membership(self.organization_b, self.space_b, self.user_b, 'owner')
        self.table_b = Table.objects.create(
            space_id=self.space_b.id, organization_id=self.space_b.organization_id, name='表格B', owner=self.user_b
        )

        self.token_a = generate_jwt_token(self.user_a, expire_hours=1, token_type='access')
        self.token_b = generate_jwt_token(self.user_b, expire_hours=1, token_type='access')

    def test_user_a_cannot_access_organization_b_tables(self):
        """用户A 无法访问组织B 的表格"""
        svc = BaseService(user=self.user_a)
        self.assertFalse(svc.check_table_permission(str(self.table_b.id), 'viewer'))

    def test_user_b_cannot_access_organization_a_fields(self):
        """用户B 无法通过 API 获取组织A 的字段"""
        url = f'/api/tabdata/tables/{self.table_a.id}/fields'
        response = self.client.get(url, **_auth_header(self.token_b))
        data = response.json()
        # 应返回空列表或权限拒绝
        if response.status_code == 200:
            self.assertEqual(data.get('data', {}).get('total', 0), 0)
        else:
            self.assertIn(response.status_code, [403, 404])

    def test_user_b_cannot_create_record_in_organization_a(self):
        """用户B 无法在组织A 的表格中创建记录"""
        url = '/api/tabdata/records'
        payload = {
            'table_id': str(self.table_a.id),
            'data': {
                str(self.field_a.id): '跨空间入侵',
            }
        }
        response = self.client.post(
            url,
            data=json.dumps(payload),
            content_type='application/json',
            **_auth_header(self.token_b),
        )
        if response.status_code == 200:
            data = response.json()
            self.assertFalse(data.get('success', True))
        else:
            self.assertIn(response.status_code, [403, 422])

    def test_mutual_isolation(self):
        """双向隔离：A 不能访问 B，B 不能访问 A"""
        svc_a = BaseService(user=self.user_a)
        svc_b = BaseService(user=self.user_b)

        # A -> B: 拒绝
        self.assertFalse(svc_a.check_table_permission(str(self.table_b.id), 'viewer'))
        self.assertFalse(svc_a.check_organization_permission(str(self.organization_b.id), 'viewer'))

        # B -> A: 拒绝
        self.assertFalse(svc_b.check_table_permission(str(self.table_a.id), 'viewer'))
        self.assertFalse(svc_b.check_organization_permission(str(self.organization_a.id), 'viewer'))

        # 各自可以访问自己的
        self.assertTrue(svc_a.check_table_permission(str(self.table_a.id), 'editor'))
        self.assertTrue(svc_b.check_table_permission(str(self.table_b.id), 'editor'))


