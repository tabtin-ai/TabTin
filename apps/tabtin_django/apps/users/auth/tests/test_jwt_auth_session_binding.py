"""
CA-1 回归测试：JWTAuth 必须验证 session 绑定。

验证场景：
- 合法 access token + 有效 session → 通过
- refresh token → 拒绝
- 无 sid 的 access token → 拒绝
- session 失效后旧 token → 拒绝（登出场景）
- 用户 is_active=False → 拒绝
- sid 指向其他用户的 session → 拒绝
"""

from datetime import timedelta
from unittest.mock import MagicMock

from django.test import TestCase, RequestFactory
from django.utils import timezone

from apps.users.auth.models import User, UserSession
from apps.users.auth.permissions import JWTAuth
from apps.users.auth.session_manager import SessionManager
from apps.users.auth.utils import generate_jwt_token


class JWTAuthSessionBindingTests(TestCase):
    """CA-1: JWTAuth 必须包含 session 绑定校验"""

    databases = {"default", "postgresql"}

    def setUp(self):
        self.factory = RequestFactory()
        self.auth = JWTAuth()

        self.user = User.objects.create_user(
            email="session_bind@test.com",
            password="StrongPass123!",
        )

        self.request = self.factory.get("/api/test")

        self.session = UserSession.objects.create(
            user=self.user,
            session_key="test_session_key_00000000000000000001",
            session_type="web",
            ip_address="127.0.0.1",
            user_agent="test-agent",
            device_info={},
            expires_at=timezone.now() + timedelta(hours=24),
            is_active=True,
        )

    def _make_token(self, user=None, token_type="access", session_key=None, expire_hours=24):
        """生成测试用 JWT token"""
        return generate_jwt_token(
            user or self.user,
            expire_hours,
            token_type=token_type,
            session_key=session_key,
        )

    def test_valid_access_token_with_active_session_passes(self):
        """合法 access token + 有效 session → 应通过认证"""
        token = self._make_token(session_key=self.session.session_key)
        result = self.auth.authenticate(self.request, token)
        self.assertIsNotNone(result)
        self.assertEqual(str(result.id), str(self.user.id))

    def test_refresh_token_rejected(self):
        """refresh token 不应通过业务接口认证"""
        token = self._make_token(
            token_type="refresh",
            session_key=self.session.session_key,
        )
        result = self.auth.authenticate(self.request, token)
        self.assertIsNone(result)

    def test_token_without_sid_rejected(self):
        """缺少 sid 的 access token → 拒绝"""
        token = self._make_token(session_key=None)
        result = self.auth.authenticate(self.request, token)
        self.assertIsNone(result)

    def test_invalidated_session_rejected(self):
        """session 失效后旧 token 被拒绝（模拟登出/改密）"""
        token = self._make_token(session_key=self.session.session_key)

        result_before = self.auth.authenticate(self.request, token)
        self.assertIsNotNone(result_before)

        SessionManager.invalidate_session(self.session.session_key)

        result_after = self.auth.authenticate(self.request, token)
        self.assertIsNone(result_after)

    def test_inactive_user_rejected(self):
        """is_active=False 的用户 → 拒绝"""
        token = self._make_token(session_key=self.session.session_key)

        self.user.is_active = False
        self.user.save(update_fields=["is_active"])

        result = self.auth.authenticate(self.request, token)
        self.assertIsNone(result)

    def test_session_belonging_to_other_user_rejected(self):
        """sid 指向其他用户的 session → 拒绝"""
        other_user = User.objects.create_user(
            email="other_user@test.com",
            password="StrongPass456!",
        )
        other_session = UserSession.objects.create(
            user=other_user,
            session_key="other_session_key_0000000000000000002",
            session_type="web",
            ip_address="127.0.0.1",
            user_agent="test-agent",
            device_info={},
            expires_at=timezone.now() + timedelta(hours=24),
            is_active=True,
        )

        token = self._make_token(
            user=self.user,
            session_key=other_session.session_key,
        )
        result = self.auth.authenticate(self.request, token)
        self.assertIsNone(result)

    def test_expired_session_rejected(self):
        """过期 session → 拒绝"""
        expired_session = UserSession.objects.create(
            user=self.user,
            session_key="expired_session_key_000000000000000003",
            session_type="web",
            ip_address="127.0.0.1",
            user_agent="test-agent",
            device_info={},
            expires_at=timezone.now() - timedelta(hours=1),
            is_active=True,
        )

        token = self._make_token(session_key=expired_session.session_key)
        result = self.auth.authenticate(self.request, token)
        self.assertIsNone(result)

    def test_unknown_token_type_rejected(self):
        """非 access 的自定义 token_type → 拒绝（CA-9 修复验证）"""
        token = self._make_token(
            token_type="magic_link",
            session_key=self.session.session_key,
        )
        result = self.auth.authenticate(self.request, token)
        self.assertIsNone(result)

    def test_invalid_token_string_rejected(self):
        """无效 token 字符串 → 拒绝"""
        result = self.auth.authenticate(self.request, "totally.invalid.token")
        self.assertIsNone(result)

    def test_password_change_invalidates_all_sessions(self):
        """修改密码后使所有 session 失效，旧 token 被拒绝"""
        token = self._make_token(session_key=self.session.session_key)

        result_before = self.auth.authenticate(self.request, token)
        self.assertIsNotNone(result_before)

        UserSession.objects.filter(
            user=self.user, is_active=True
        ).update(is_active=False)

        result_after = self.auth.authenticate(self.request, token)
        self.assertIsNone(result_after)
