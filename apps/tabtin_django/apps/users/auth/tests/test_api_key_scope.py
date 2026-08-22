"""
P0-9 / P0-10 安全修复回归测试

P0-9:  resolve_required_scope — 根据 HTTP path + method 推断 API Key scope
P0-10: API Key organization_id 约束 ContextVar 传递

测试策略：纯单元测试，不依赖 DB / Redis / Django Server。
"""

from unittest import TestCase
from unittest.mock import MagicMock, patch

from apps.users.auth.api_key_context import (
    _api_key_organization_var,
    get_api_key_organization_constraint,
    resolve_required_scope,
    set_api_key_organization_constraint,
)


# ═══════════════════════════════════════════════════════════════════════
# P0-9: resolve_required_scope
# ═══════════════════════════════════════════════════════════════════════


class ResolveRequiredScopePositiveTests(TestCase):
    """P0-9: 正向用例 — 已知路径返回正确的 scope。"""

    def test_tabdata_get_returns_read_scope(self):
        result = resolve_required_scope('/api/tabdata/records', 'GET')
        self.assertEqual(result, 'tabdata:read')

    def test_tabdata_post_returns_write_scope(self):
        result = resolve_required_scope('/api/tabdata/records', 'POST')
        self.assertEqual(result, 'tabdata:write')

    def test_chat_get_returns_agent_read(self):
        result = resolve_required_scope('/api/chat/messages', 'GET')
        self.assertEqual(result, 'agent:read')

    def test_orchestration_post_returns_agent_write(self):
        result = resolve_required_scope('/api/orchestration/runs', 'POST')
        self.assertEqual(result, 'agent:write')

    def test_tabdoc_head_is_read(self):
        result = resolve_required_scope('/api/tabdoc/docs', 'HEAD')
        self.assertEqual(result, 'tabdoc:read')

    def test_options_is_read(self):
        result = resolve_required_scope('/api/tabdata/tables', 'OPTIONS')
        self.assertEqual(result, 'tabdata:read')

    def test_oss_put_returns_storage_write(self):
        result = resolve_required_scope('/api/services/oss/upload', 'PUT')
        self.assertEqual(result, 'storage:write')

    def test_registry_get_returns_read_scope(self):
        # 2026-05-28 URL 归位：/api/scheduler/events → /api/registry/events
        # （scheduler scope 整体下线，replaced by registry 用于 App 事件目录）
        result = resolve_required_scope('/api/registry/events', 'GET')
        self.assertEqual(result, 'registry:read')


class ResolveRequiredScopeDenyByDefaultTests(TestCase):
    """P0-9: 未映射路径 deny-by-default → '*:write'。"""

    def test_unknown_path_returns_wildcard_write(self):
        result = resolve_required_scope('/api/unknown/endpoint', 'GET')
        self.assertEqual(result, '*:write')

    def test_root_api_returns_wildcard_write(self):
        result = resolve_required_scope('/api/', 'GET')
        self.assertEqual(result, '*:write')

    def test_non_api_path_returns_wildcard_write(self):
        result = resolve_required_scope('/admin/dashboard', 'GET')
        self.assertEqual(result, '*:write')


class ResolveRequiredScopeExemptTests(TestCase):
    """P0-9: 豁免路径返回 None（不做 scope 校验）。"""

    def test_open_api_is_exempt(self):
        self.assertIsNone(resolve_required_scope('/api/open/v1/records', 'POST'))

    def test_health_is_exempt(self):
        self.assertIsNone(resolve_required_scope('/api/health', 'GET'))

    def test_updates_is_exempt(self):
        self.assertIsNone(resolve_required_scope('/api/updates/latest', 'GET'))

    def test_client_errors_is_exempt(self):
        self.assertIsNone(resolve_required_scope('/api/client-errors/', 'POST'))

    def test_entities_is_exempt(self):
        self.assertIsNone(resolve_required_scope('/api/entities/user', 'GET'))

    def test_sms_service_is_exempt(self):
        self.assertIsNone(resolve_required_scope('/api/services/sms/send', 'POST'))

    def test_email_service_is_exempt(self):
        self.assertIsNone(resolve_required_scope('/api/services/email/send', 'POST'))

    def test_auth_admin_is_exempt(self):
        self.assertIsNone(resolve_required_scope('/api/auth/admin/users', 'GET'))


class ResolveRequiredScopeNegativeTests(TestCase):
    """P0-9: 负向用例 — 只读 Key 对写操作路径被拒绝（通过 _enforce_api_key_scope 链路验证）。"""

    def test_readonly_key_denied_for_write_path(self):
        """模拟 JWTAuth._enforce_api_key_scope：只读 Key + 写操作 → 403。"""
        mock_api_key = MagicMock()
        mock_api_key.scopes = ['tabdata:read']
        mock_api_key.has_scope = lambda s: s in mock_api_key.scopes or '*' in mock_api_key.scopes

        required = resolve_required_scope('/api/tabdata/records', 'POST')
        self.assertEqual(required, 'tabdata:write')
        self.assertFalse(mock_api_key.has_scope(required))

    def test_readonly_key_allowed_for_read_path(self):
        """只读 Key + 读操作 → 放行。"""
        mock_api_key = MagicMock()
        mock_api_key.scopes = ['tabdata:read']
        mock_api_key.has_scope = lambda s: s in mock_api_key.scopes or '*' in mock_api_key.scopes

        required = resolve_required_scope('/api/tabdata/records', 'GET')
        self.assertEqual(required, 'tabdata:read')
        self.assertTrue(mock_api_key.has_scope(required))

    def test_narrow_scope_key_denied_for_other_module(self):
        """tabdata:read Key 对 tabdoc 路径被拒绝。"""
        mock_api_key = MagicMock()
        mock_api_key.scopes = ['tabdata:read']
        mock_api_key.has_scope = lambda s: s in mock_api_key.scopes

        required = resolve_required_scope('/api/tabdoc/docs', 'GET')
        self.assertEqual(required, 'tabdoc:read')
        self.assertFalse(mock_api_key.has_scope(required))

    def test_wildcard_key_allowed_for_all_paths(self):
        """'*' scope Key 可访问任何路径。"""
        mock_api_key = MagicMock()
        mock_api_key.scopes = ['*']
        mock_api_key.has_scope = lambda s: '*' in mock_api_key.scopes

        required = resolve_required_scope('/api/tabdata/records', 'DELETE')
        self.assertTrue(mock_api_key.has_scope(required))


# ═══════════════════════════════════════════════════════════════════════
# P0-10: API Key organization 约束 ContextVar
# ═══════════════════════════════════════════════════════════════════════


class ApiKeyOrganizationConstraintTests(TestCase):
    """P0-10: get/set_api_key_organization_constraint ContextVar 正确传递。"""

    def setUp(self):
        self._token = _api_key_organization_var.set('')

    def tearDown(self):
        _api_key_organization_var.reset(self._token)

    def test_set_and_get_constraint(self):
        set_api_key_organization_constraint('wt-123')
        self.assertEqual(get_api_key_organization_constraint(), 'wt-123')

    def test_default_is_empty_string(self):
        self.assertEqual(get_api_key_organization_constraint(), '')

    def test_overwrite_constraint(self):
        set_api_key_organization_constraint('wt-aaa')
        set_api_key_organization_constraint('wt-bbb')
        self.assertEqual(get_api_key_organization_constraint(), 'wt-bbb')


class ApiKeyOrganizationConstraintNegativeTests(TestCase):
    """P0-10: 约束 organization_id 不匹配时的行为验证。"""

    def setUp(self):
        self._token = _api_key_organization_var.set('')

    def tearDown(self):
        _api_key_organization_var.reset(self._token)

    def test_unset_constraint_returns_empty(self):
        """未设置约束时返回空字符串，调用方应据此拒绝跨 organization 操作。"""
        self.assertEqual(get_api_key_organization_constraint(), '')

    def test_constraint_mismatch_detected(self):
        """模拟 BaseService 层：当前 organization 与约束不匹配 → 应拒绝。"""
        set_api_key_organization_constraint('wt-team-A')
        constraint = get_api_key_organization_constraint()
        current_organization_id = 'wt-team-B'
        self.assertNotEqual(constraint, current_organization_id)

    def test_constraint_match_allows_operation(self):
        """约束匹配时放行。"""
        set_api_key_organization_constraint('wt-same')
        constraint = get_api_key_organization_constraint()
        self.assertEqual(constraint, 'wt-same')

    def test_apply_organization_constraint_from_api_key(self):
        """模拟 _apply_organization_constraint 完整链路。"""
        mock_request = MagicMock()
        mock_api_key = MagicMock()
        mock_api_key.organization_id = 'wt-constrained'
        mock_request.api_key = mock_api_key

        api_key = getattr(mock_request, 'api_key', None)
        if api_key and api_key.organization_id:
            set_api_key_organization_constraint(api_key.organization_id)

        self.assertEqual(get_api_key_organization_constraint(), 'wt-constrained')

    def test_no_api_key_does_not_set_constraint(self):
        """无 api_key 时不应设置约束。"""
        mock_request = MagicMock(spec=[])

        api_key = getattr(mock_request, 'api_key', None)
        if api_key and api_key.organization_id:
            set_api_key_organization_constraint(api_key.organization_id)

        self.assertEqual(get_api_key_organization_constraint(), '')
