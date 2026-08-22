"""
CR-006 / CR-009 回归测试

CR-006: api.py 的 JWTAuth 必须与 permissions.py 统一（含 daemon JTI 吊销检查）
CR-009: /refresh-token 端点必须有速率限制
"""

from unittest.mock import patch, MagicMock

from django.core.cache import cache
from django.test import SimpleTestCase, RequestFactory

from apps.users.auth.permissions import JWTAuth as PermissionsJWTAuth


class CR006JWTAuthUnifiedTests(SimpleTestCase):
    """CR-006: api.py 的 JWTAuth 应来自 permissions.py（含 daemon JTI 吊销检查）"""

    def test_api_jwt_auth_is_permissions_jwt_auth(self):
        """api.py 导出的 JWTAuth 类应与 permissions.py 的完全一致"""
        from apps.users.auth.api import JWTAuth as ApiJWTAuth
        self.assertIs(ApiJWTAuth, PermissionsJWTAuth)

    def test_jwt_auth_instance_uses_unified_class(self):
        """api.py 的 jwt_auth 实例应是 permissions.JWTAuth 的实例"""
        from apps.users.auth.api import jwt_auth
        self.assertIsInstance(jwt_auth, PermissionsJWTAuth)

    def test_jwt_auth_checks_daemon_jti_revocation(self):
        """统一的 JWTAuth.authenticate 应检查 daemon JTI 吊销状态"""
        import inspect
        source = inspect.getsource(PermissionsJWTAuth.authenticate)
        self.assertIn("is_daemon_token_revoked", source)

    @patch("apps.users.auth.permissions.verify_jwt_token")
    @patch("apps.users.auth.permissions.SessionManager.validate_session")
    def test_revoked_daemon_jti_rejected_by_api_jwt_auth(
        self, mock_validate, mock_verify
    ):
        """持有已吊销 JTI 的 token 应被 api.py 的 jwt_auth 拒绝"""
        from apps.users.auth.api import jwt_auth

        mock_verify.return_value = {
            "user_id": "fake-uid",
            "token_type": "access",
            "jti": "revoked-jti-001",
            "sid": "some-session",
        }

        factory = RequestFactory()
        request = factory.get("/api/auth/profile")

        with patch(
            "apps.tabtinspace.services.daemon_token_service.is_daemon_token_revoked",
            return_value=True,
        ):
            result = jwt_auth.authenticate(request, "fake-token")

        self.assertIsNone(result)


class CR009RefreshTokenRateLimitTests(SimpleTestCase):
    """CR-009: /refresh-token 必须有速率限制"""

    def setUp(self):
        cache.clear()

    def tearDown(self):
        cache.clear()

    def test_ip_rate_allows_normal_traffic(self):
        """正常频率的刷新请求不被限制"""
        from apps.users.auth.api import _check_refresh_token_rate
        ok, _ = _check_refresh_token_rate("192.168.1.1")
        self.assertTrue(ok)

    def test_ip_rate_blocks_after_threshold(self):
        """同一 IP 超过 20 次/分钟后被拒绝"""
        from apps.users.auth.api import (
            _check_refresh_token_rate,
            REFRESH_TOKEN_IP_MAX,
        )

        ip = "10.0.0.50"
        for _ in range(REFRESH_TOKEN_IP_MAX):
            ok, _ = _check_refresh_token_rate(ip)
            self.assertTrue(ok)

        ok, msg = _check_refresh_token_rate(ip)
        self.assertFalse(ok)
        self.assertTrue(len(msg) > 0)

    def test_session_rate_blocks_after_threshold(self):
        """同一 session 超过 5 次/分钟后被拒绝"""
        from apps.users.auth.api import (
            _check_refresh_token_rate,
            REFRESH_TOKEN_SESSION_MAX,
        )

        sess = "session_key_rate_test_001"
        for _ in range(REFRESH_TOKEN_SESSION_MAX):
            ok, _ = _check_refresh_token_rate(None, session_key=sess)
            self.assertTrue(ok)

        ok, msg = _check_refresh_token_rate(None, session_key=sess)
        self.assertFalse(ok)
        self.assertTrue(len(msg) > 0)

    def test_different_ips_isolated(self):
        """不同 IP 的速率计数互不影响"""
        from apps.users.auth.api import (
            _check_refresh_token_rate,
            REFRESH_TOKEN_IP_MAX,
        )

        for _ in range(REFRESH_TOKEN_IP_MAX):
            _check_refresh_token_rate("10.0.0.1")

        ok, _ = _check_refresh_token_rate("10.0.0.2")
        self.assertTrue(ok)

    def test_different_sessions_isolated(self):
        """不同 session 的速率计数互不影响"""
        from apps.users.auth.api import (
            _check_refresh_token_rate,
            REFRESH_TOKEN_SESSION_MAX,
        )

        for _ in range(REFRESH_TOKEN_SESSION_MAX):
            _check_refresh_token_rate(None, session_key="sess_a")

        ok, _ = _check_refresh_token_rate(None, session_key="sess_b")
        self.assertTrue(ok)

    def test_none_ip_and_none_session_passes(self):
        """IP 和 session_key 均为 None 时不限制"""
        from apps.users.auth.api import _check_refresh_token_rate
        ok, _ = _check_refresh_token_rate(None, session_key=None)
        self.assertTrue(ok)

    def test_constants_exported(self):
        """速率限制常量已定义且值合理"""
        from apps.users.auth.api import (
            REFRESH_TOKEN_IP_MAX,
            REFRESH_TOKEN_IP_WINDOW,
            REFRESH_TOKEN_SESSION_MAX,
            REFRESH_TOKEN_SESSION_WINDOW,
        )
        self.assertEqual(REFRESH_TOKEN_IP_MAX, 20)
        self.assertEqual(REFRESH_TOKEN_IP_WINDOW, 60)
        self.assertEqual(REFRESH_TOKEN_SESSION_MAX, 5)
        self.assertEqual(REFRESH_TOKEN_SESSION_WINDOW, 60)
