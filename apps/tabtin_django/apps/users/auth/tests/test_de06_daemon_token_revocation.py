"""
DE-06 回归测试：JWTAuth 必须拒绝已吊销的 daemon token。

验证场景：
- 含已吊销 jti 的 token → 拒绝（核心修复）
- 含未吊销 jti 的 token → 不受 revocation 阻拦（后续检查照常）
- 无 jti 的普通 access token → 不受影响，正常通过
- revocation check 被正确调用且参数正确
"""

from datetime import timedelta
from unittest.mock import patch

from django.test import TestCase, RequestFactory
from django.utils import timezone

from apps.users.auth.models import User, UserSession
from apps.users.auth.permissions import JWTAuth
from apps.users.auth.session_manager import SessionManager
from apps.users.auth.utils import generate_jwt_token

_REVOKE_FN = "apps.tabtinspace.services.daemon_token_service.is_daemon_token_revoked"

_PLAIN_SESSION_KEY = "de06_plain_session_key_for_revocation_test"


class DaemonTokenRevocationTests(TestCase):
    """DE-06: JWTAuth 必须检查 daemon token 吊销状态"""

    databases = {"default", "postgresql"}

    def setUp(self):
        self.factory = RequestFactory()
        self.auth = JWTAuth()
        self.user = User.objects.create_user(
            email="de06_test@test.com",
            password="StrongPass123!",
        )
        self.request = self.factory.get("/api/test")
        hashed_key = SessionManager.hash_session_key(_PLAIN_SESSION_KEY)
        self.session = UserSession.objects.create(
            user=self.user,
            session_key=hashed_key,
            session_type="web",
            ip_address="127.0.0.1",
            user_agent="test-agent",
            device_info={},
            expires_at=timezone.now() + timedelta(hours=24),
            is_active=True,
        )

    def _make_token_with_jti(self, jti="test-jti-001"):
        """生成含 jti 的 JWT（模拟 daemon token 或含 jti 的伪造 token 通过 JWTAuth 的场景）"""
        import jwt as _pyjwt
        from django.conf import settings

        payload = {
            "user_id": str(self.user.id),
            "token_type": "access",
            "jti": jti,
            "sid": _PLAIN_SESSION_KEY,
            "exp": timezone.now() + timedelta(hours=24),
            "iat": timezone.now(),
        }
        return _pyjwt.encode(payload, settings.JWT_SECRET_KEY, algorithm="HS256")

    def _make_normal_token(self):
        """生成无 jti 的普通 access token"""
        return generate_jwt_token(
            self.user,
            expire_hours=24,
            token_type="access",
            session_key=_PLAIN_SESSION_KEY,
        )

    @patch(_REVOKE_FN, return_value=True)
    def test_revoked_jti_rejected(self, mock_revoked):
        """含已吊销 jti 的 token 必须被拒绝"""
        token = self._make_token_with_jti(jti="revoked-jti-001")
        result = self.auth.authenticate(self.request, token)
        self.assertIsNone(result)
        mock_revoked.assert_called_once_with("revoked-jti-001")

    @patch(_REVOKE_FN, return_value=False)
    def test_non_revoked_jti_passes_revocation_check(self, mock_revoked):
        """含未吊销 jti 的 token 应通过吊销检查（后续 session 校验照常生效）"""
        token = self._make_token_with_jti(jti="valid-jti-001")
        result = self.auth.authenticate(self.request, token)
        self.assertIsNotNone(result)
        self.assertEqual(str(result.id), str(self.user.id))
        mock_revoked.assert_called_once_with("valid-jti-001")

    def test_normal_token_without_jti_unaffected(self):
        """普通 access token（无 jti）不受 revocation 检查影响"""
        token = self._make_normal_token()
        with patch(_REVOKE_FN) as mock_revoked:
            result = self.auth.authenticate(self.request, token)
            self.assertIsNotNone(result)
            self.assertEqual(str(result.id), str(self.user.id))
            mock_revoked.assert_not_called()

    @patch(_REVOKE_FN, return_value=True)
    def test_revoked_jti_blocks_before_session_check(self, mock_revoked):
        """吊销检查在 session 校验之前执行 — 即使 session 有效，吊销 token 仍被拒绝"""
        token = self._make_token_with_jti(jti="early-block-jti")
        result = self.auth.authenticate(self.request, token)
        self.assertIsNone(result)

    @patch(_REVOKE_FN, return_value=True)
    def test_empty_jti_string_not_checked(self, mock_revoked):
        """jti 为空字符串时不触发吊销检查（空字符串是 falsy）"""
        token = self._make_token_with_jti(jti="")
        result = self.auth.authenticate(self.request, token)
        mock_revoked.assert_not_called()
