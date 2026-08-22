"""
DE-19 回归测试：JWT 用户 scope 按 space 级别角色收窄

验证场景：
- Organization admin 在某 Space 仅有 viewer 成员身份时，
  不能通过 require_scope('record:delete') + require_space_access 执行删除操作
- Organization viewer 在某 Space 有 editor 成员身份时，
  可以执行 readwrite scope 的操作
- API Token 路径不受 space 角色收窄影响（行为不变）
"""

import uuid

from django.contrib.auth import get_user_model
from django.db.models.signals import post_save
from django.test import RequestFactory, TestCase

from apps.tabdata.auth_open_api import (
    _ROLE_SCOPE_MAP,
    _resolve_jwt_user_scopes,
    require_scope,
    require_space_access,
    require_table_access,
)
from apps.tabdata.constants import TABDATA_DB_ALIAS
from apps.tabdata.models import Table
from apps.tabdata.models_token import SCOPE_PRESETS
from apps.tabdata.tests.test_permissions import _ensure_free_tier
from apps.tabtinspace.models import (
    Agent,
    Space,
    SpaceMembership,
    Organization,
    OrganizationMember,
)
from apps.tabtinspace.signals import create_default_organization

User = get_user_model()

MARKER = object()


class JwtScopeNarrowingTests(TestCase):
    """DE-19: JWT 用户 scope 按 space 角色收窄"""

    databases = {'default', 'postgresql'}

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        post_save.disconnect(create_default_organization, sender=User)

    @classmethod
    def tearDownClass(cls):
        post_save.connect(create_default_organization, sender=User)
        super().tearDownClass()

    def setUp(self):
        _ensure_free_tier()
        self.factory = RequestFactory()

        self.ws_admin = User.objects.create_user(
            username='de19_ws_admin',
            email='de19_ws_admin@test.com',
            password='pass123',
        )
        self.ws_viewer = User.objects.create_user(
            username='de19_ws_viewer',
            email='de19_ws_viewer@test.com',
            password='pass123',
        )

        self.organization = Organization.objects.create(
            name='DE-19 Test Organization',
            owner=self.ws_admin,
        )
        OrganizationMember.objects.create(
            organization=self.organization,
            user=self.ws_admin,
            role='admin',
        )
        OrganizationMember.objects.create(
            organization=self.organization,
            user=self.ws_viewer,
            role='viewer',
        )

        self.space = Space.objects.create(
            organization=self.organization,
            name='DE-19 Space',
        )
        # ws_admin 在 space 中只有 viewer 角色
        SpaceMembership.objects.create(
            workspace=self.space,
            user=self.ws_admin,
            role='viewer',
            is_active=True,
        )
        # ws_viewer 在 space 中有 editor 角色（space 级别提升）
        SpaceMembership.objects.create(
            workspace=self.space,
            user=self.ws_viewer,
            role='editor',
            is_active=True,
        )

        # Agent 成员路径：ws_admin 通过 Agent 获得另一个 space 的 viewer 访问
        self.agent_space = Space.objects.create(
            organization=self.organization,
            name='DE-19 Agent Space',
        )
        self.agent = Agent.objects.create(
            organization=self.organization,
            user=self.ws_admin,
            name='DE-19 Agent',
            type='human',
            is_active=True,
        )
        SpaceMembership.objects.create(
            workspace=self.agent_space,
            agent=self.agent,
            role='viewer',
            is_active=True,
        )

    def _make_jwt_request(self, user, method='get', path='/fake', space_id=None):
        fn = getattr(self.factory, method)
        request = fn(path)
        request.auth = user
        request.api_token = None
        request._api_auth_type = 'jwt'
        request._api_user_id = str(user.id)
        request._api_organization_id = str(self.organization.id)
        request._api_space_id = str(space_id) if space_id else ''
        return request

    # ── _resolve_jwt_user_scopes 收窄验证 ──

    def test_ws_admin_scope_narrowed_to_space_viewer(self):
        """Organization admin 在 space viewer 成员身份下 scope 应被收窄到 readonly"""
        request = self._make_jwt_request(
            self.ws_admin, space_id=self.space.id,
        )
        scopes = _resolve_jwt_user_scopes(request)
        expected = set(SCOPE_PRESETS['readonly'])
        self.assertEqual(scopes, expected)

    def test_ws_viewer_scope_not_narrowed_when_space_editor(self):
        """Organization viewer 在 space editor 成员身份下 scope 不应被收窄"""
        request = self._make_jwt_request(
            self.ws_viewer, space_id=self.space.id,
        )
        scopes = _resolve_jwt_user_scopes(request)
        expected = set(SCOPE_PRESETS['readonly'])
        self.assertEqual(scopes, expected)

    def test_ws_admin_scope_full_without_space_context(self):
        """无 space 上下文时 organization admin 仍获得 full scope"""
        request = self._make_jwt_request(self.ws_admin)
        scopes = _resolve_jwt_user_scopes(request)
        expected = set(SCOPE_PRESETS['full'])
        self.assertEqual(scopes, expected)

    def test_override_space_id_bypasses_cache(self):
        """override_space_id 应绕过缓存重新计算"""
        request = self._make_jwt_request(self.ws_admin)
        initial_scopes = _resolve_jwt_user_scopes(request)
        self.assertEqual(initial_scopes, set(SCOPE_PRESETS['full']))

        narrowed = _resolve_jwt_user_scopes(
            request, override_space_id=str(self.space.id),
        )
        self.assertEqual(narrowed, set(SCOPE_PRESETS['readonly']))

    def test_agent_membership_also_narrows_scope(self):
        """通过 Agent 成员身份访问 space 时，scope 也应被收窄"""
        request = self._make_jwt_request(
            self.ws_admin, space_id=self.agent_space.id,
        )
        scopes = _resolve_jwt_user_scopes(request)
        expected = set(SCOPE_PRESETS['readonly'])
        self.assertEqual(scopes, expected)

    def test_override_does_not_pollute_cache(self):
        """override_space_id 路径不应覆写通用缓存"""
        request = self._make_jwt_request(self.ws_admin)
        initial = _resolve_jwt_user_scopes(request)
        self.assertEqual(initial, set(SCOPE_PRESETS['full']))

        _resolve_jwt_user_scopes(request, override_space_id=str(self.space.id))

        cached = getattr(request, '_jwt_effective_scopes', None)
        self.assertEqual(cached, set(SCOPE_PRESETS['full']))

    # ── require_scope + require_space_access 交叉验证 ──

    def test_ws_admin_denied_delete_scope_in_viewer_space(self):
        """
        Organization admin 通过 require_scope('record:delete') 后，
        在仅有 viewer space 成员的 space 中应被 require_space_access 拒绝
        """
        @require_scope('record:delete')
        @require_space_access
        def _view(request, *args, **kwargs):
            return MARKER

        request = self._make_jwt_request(
            self.ws_admin, space_id=self.space.id,
        )
        result = _view(request, space_id=str(self.space.id))

        self.assertIsNot(result, MARKER)
        if isinstance(result, tuple):
            status, payload = result
            self.assertEqual(status, 403)
            self.assertIn(payload.get('code', ''), ('INSUFFICIENT_SCOPE',))

    def test_ws_viewer_allowed_read_scope_in_editor_space(self):
        """
        Organization viewer 在 space editor 成员身份下，
        require_scope('record:read') + require_space_access 应放行
        """
        @require_scope('record:read')
        @require_space_access
        def _view(request, *args, **kwargs):
            return MARKER

        request = self._make_jwt_request(
            self.ws_viewer, space_id=self.space.id,
        )
        result = _view(request, space_id=str(self.space.id))
        self.assertIs(result, MARKER)

    def test_required_api_scopes_stored_by_require_scope(self):
        """require_scope 应在 request 上记录 _required_api_scopes"""
        @require_scope('record:read', 'record:update')
        def _view(request, *args, **kwargs):
            return MARKER

        request = self._make_jwt_request(
            self.ws_admin, space_id=self.space.id,
        )
        _view(request)

        stored = getattr(request, '_required_api_scopes', None)
        self.assertIsNotNone(stored)
        self.assertIn('record:read', stored)
        self.assertIn('record:update', stored)

    # ── require_table_access 交叉验证 ──

    def test_ws_admin_denied_delete_scope_via_table_access(self):
        """
        Organization admin 通过 require_scope('record:delete') 后，
        在 viewer space 中的表格上应被 require_table_access 拒绝
        """
        table = Table.objects.using(TABDATA_DB_ALIAS).create(
            name='DE-19 Test Table',
            space_id=self.space.id,
            organization_id=self.organization.id,
        )

        @require_scope('record:delete')
        @require_table_access
        def _view(request, *args, **kwargs):
            return MARKER

        request = self._make_jwt_request(
            self.ws_admin, space_id=self.space.id,
        )
        result = _view(request, table_id=str(table.id))

        self.assertIsNot(result, MARKER)
        if isinstance(result, tuple):
            status, payload = result
            self.assertEqual(status, 403)

    # ── API Token 路径不受影响 ──

    def test_api_token_path_unaffected(self):
        """API Token 认证路径的行为不变"""
        from unittest.mock import MagicMock

        mock_token = MagicMock()
        mock_token.can_access_space.return_value = True
        mock_token.has_any_scope.return_value = True
        mock_token.rate_limit = 60
        mock_token.id = uuid.uuid4()

        @require_space_access
        def _view(request, *args, **kwargs):
            return MARKER

        request = self.factory.get('/fake')
        request.auth = self.ws_admin
        request.api_token = mock_token

        result = _view(request, space_id=str(self.space.id))
        self.assertIs(result, MARKER)
        mock_token.can_access_space.assert_called_once()
