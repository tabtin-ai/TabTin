"""
DS-006 / DS-007 回归测试

DS-006: OpenApiAuth._authenticate_jwt 必须校验 session 绑定，
        用户 logout（session 失效）后 JWT 不能在 Open API 路径上继续有效。

DS-007: verify_daemon_device_claim 对不含 device_id 的旧 token 必须拒绝（fail-close），
        而非放行。
"""

import inspect
import unittest
from datetime import timedelta
from unittest.mock import patch, MagicMock

import django
from django.conf import settings

if not settings.configured:
    import os
    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")
    django.setup()

from django.test import RequestFactory
from django.utils import timezone
from django.contrib.auth import get_user_model

_USER_MODEL = get_user_model()

_VERIFY_JWT = "apps.tabdata.auth_open_api.verify_jwt_token"
_VALIDATE_SESSION = "apps.users.auth.session_manager.SessionManager.validate_session"
_USER_OBJ_GET = "apps.tabdata.auth_open_api.User.objects.get"
_IS_REVOKED = "apps.tabtinspace.services.daemon_token_service.is_daemon_token_revoked"


def _make_jwt_payload(user_id="u-ds006", sid="sk-ds006", token_type="access",
                      jti=None, hours=24):
    payload = {
        "user_id": user_id,
        "token_type": token_type,
        "exp": timezone.now() + timedelta(hours=hours),
        "iat": timezone.now(),
    }
    if sid is not None:
        payload["sid"] = sid
    if jti is not None:
        payload["jti"] = jti
    return payload


def _make_mock_user(user_id="u-ds006"):
    user = MagicMock()
    user.id = user_id
    user.is_active = True
    return user


# ---------------------------------------------------------------------------
# DS-006: OpenApiAuth._authenticate_jwt session 绑定校验
# ---------------------------------------------------------------------------

class TestDS006_OpenApiAuthSessionBinding(unittest.TestCase):
    """DS-006: OpenApiAuth._authenticate_jwt 必须校验 session 绑定"""

    def setUp(self):
        self.factory = RequestFactory()
        from apps.tabdata.auth_open_api import OpenApiAuth
        self.auth = OpenApiAuth()
        self.mock_user = _make_mock_user()

    @patch(_VALIDATE_SESSION)
    @patch(_USER_OBJ_GET)
    @patch(_VERIFY_JWT)
    def test_valid_jwt_with_active_session_passes(self, mock_verify, mock_get,
                                                   mock_validate):
        """有效 JWT + 活跃 session → 认证通过"""
        mock_verify.return_value = _make_jwt_payload()
        mock_get.return_value = self.mock_user
        mock_session = MagicMock()
        mock_session.user_id = "u-ds006"
        mock_validate.return_value = mock_session

        request = self.factory.get("/open-api/test")
        result = self.auth._authenticate_jwt(request, "fake-jwt")
        self.assertIsNotNone(result)
        self.assertEqual(result.id, "u-ds006")
        mock_validate.assert_called_once_with("sk-ds006")

    @patch(_VALIDATE_SESSION)
    @patch(_USER_OBJ_GET)
    @patch(_VERIFY_JWT)
    def test_jwt_rejected_after_session_invalidated(self, mock_verify, mock_get,
                                                     mock_validate):
        """用户 logout 后（session 失效），JWT 必须被拒绝"""
        mock_verify.return_value = _make_jwt_payload()
        mock_get.return_value = self.mock_user
        mock_validate.return_value = None

        request = self.factory.get("/open-api/test")
        result = self.auth._authenticate_jwt(request, "fake-jwt")
        self.assertIsNone(result, "session 失效后 JWT 不应通过 OpenApiAuth 认证")

    @patch(_VERIFY_JWT)
    def test_jwt_without_sid_rejected(self, mock_verify):
        """不含 sid 的 JWT 必须被拒绝"""
        mock_verify.return_value = _make_jwt_payload(sid=None)

        request = self.factory.get("/open-api/test")
        result = self.auth._authenticate_jwt(request, "fake-jwt")
        self.assertIsNone(result, "不含 sid 的 JWT 不应通过 OpenApiAuth 认证")

    @patch(_VALIDATE_SESSION)
    @patch(_USER_OBJ_GET)
    @patch(_VERIFY_JWT)
    def test_jwt_with_session_user_mismatch_rejected(self, mock_verify, mock_get,
                                                      mock_validate):
        """session user_id 与 JWT user_id 不匹配 → 拒绝"""
        mock_verify.return_value = _make_jwt_payload(user_id="u-ds006")
        mock_get.return_value = self.mock_user
        mock_session = MagicMock()
        mock_session.user_id = "u-attacker"
        mock_validate.return_value = mock_session

        request = self.factory.get("/open-api/test")
        result = self.auth._authenticate_jwt(request, "fake-jwt")
        self.assertIsNone(result, "session user_id 与 JWT user_id 不匹配时应拒绝")

    @patch(_VERIFY_JWT)
    def test_daemon_token_type_rejected(self, mock_verify):
        """token_type=daemon 不应通过 OpenApiAuth"""
        mock_verify.return_value = _make_jwt_payload(token_type="daemon")

        request = self.factory.get("/open-api/test")
        result = self.auth._authenticate_jwt(request, "fake-jwt")
        self.assertIsNone(result)

    @patch(_VERIFY_JWT)
    def test_invalid_jwt_rejected(self, mock_verify):
        """无效 JWT（verify 返回 None）→ 拒绝"""
        mock_verify.return_value = None

        request = self.factory.get("/open-api/test")
        result = self.auth._authenticate_jwt(request, "invalid-token")
        self.assertIsNone(result)

    @patch(_IS_REVOKED, return_value=True)
    @patch(_VERIFY_JWT)
    def test_revoked_jti_rejected_in_open_api(self, mock_verify, mock_revoked):
        """含已吊销 jti 的 JWT 在 Open API 也必须被拒绝"""
        mock_verify.return_value = _make_jwt_payload(jti="revoked-jti-ds006")

        request = self.factory.get("/open-api/test")
        result = self.auth._authenticate_jwt(request, "fake-jwt")
        self.assertIsNone(result)
        mock_revoked.assert_called_once_with("revoked-jti-ds006")

    @patch(_IS_REVOKED, return_value=False)
    @patch(_VALIDATE_SESSION)
    @patch(_USER_OBJ_GET)
    @patch(_VERIFY_JWT)
    def test_non_revoked_jti_continues_to_session_check(self, mock_verify,
                                                         mock_get, mock_validate,
                                                         mock_revoked):
        """未吊销 jti → 继续走 session 校验"""
        mock_verify.return_value = _make_jwt_payload(jti="valid-jti-ds006")
        mock_get.return_value = self.mock_user
        mock_session = MagicMock()
        mock_session.user_id = "u-ds006"
        mock_validate.return_value = mock_session

        request = self.factory.get("/open-api/test")
        result = self.auth._authenticate_jwt(request, "fake-jwt")
        self.assertIsNotNone(result)
        mock_revoked.assert_called_once_with("valid-jti-ds006")
        mock_validate.assert_called_once()

    @patch(_USER_OBJ_GET)
    @patch(_VERIFY_JWT)
    def test_user_not_found_rejected(self, mock_verify, mock_get):
        """User.DoesNotExist → 拒绝"""
        mock_verify.return_value = _make_jwt_payload()
        mock_get.side_effect = _USER_MODEL.DoesNotExist()

        request = self.factory.get("/open-api/test")
        result = self.auth._authenticate_jwt(request, "fake-jwt")
        self.assertIsNone(result)

    def test_source_code_has_session_validation_call(self):
        """源码级验证：_authenticate_jwt 必须调用 SessionManager.validate_session"""
        from apps.tabdata.auth_open_api import OpenApiAuth
        source = inspect.getsource(OpenApiAuth._authenticate_jwt)
        self.assertIn("SessionManager.validate_session", source)
        self.assertIn("payload.get('sid')", source)


# ---------------------------------------------------------------------------
# DS-007: verify_daemon_device_claim fail-close
# ---------------------------------------------------------------------------

class TestDS007_DaemonDeviceClaimFailClose(unittest.TestCase):
    """DS-007: verify_daemon_device_claim 对无 device_id 的 token 必须拒绝"""

    def test_matching_device_id_passes(self):
        from apps.tabtinspace.services.daemon_token_service import verify_daemon_device_claim
        payload = {"device_id": "fp-match", "token_type": "daemon"}
        self.assertTrue(verify_daemon_device_claim(payload, "fp-match"))

    def test_mismatched_device_id_fails(self):
        from apps.tabtinspace.services.daemon_token_service import verify_daemon_device_claim
        payload = {"device_id": "fp-original", "token_type": "daemon"}
        self.assertFalse(verify_daemon_device_claim(payload, "fp-attacker"))

    def test_legacy_token_without_device_id_rejected(self):
        """DS-007 核心：不含 device_id 的旧 token 必须被拒绝"""
        from apps.tabtinspace.services.daemon_token_service import verify_daemon_device_claim
        payload = {"token_type": "daemon", "user_id": "u1"}
        self.assertFalse(
            verify_daemon_device_claim(payload, "fp-abc123"),
            "不含 device_id 的 daemon token 必须被拒绝（DS-007 fail-close）",
        )

    def test_non_daemon_token_without_device_id_rejected(self):
        from apps.tabtinspace.services.daemon_token_service import verify_daemon_device_claim
        payload = {"token_type": "access", "user_id": "u1"}
        self.assertFalse(verify_daemon_device_claim(payload, "fp-abc123"))

    def test_device_id_none_explicitly_rejected(self):
        from apps.tabtinspace.services.daemon_token_service import verify_daemon_device_claim
        payload = {"device_id": None, "token_type": "daemon"}
        self.assertFalse(verify_daemon_device_claim(payload, "fp-abc123"))

    def test_empty_payload_rejected(self):
        from apps.tabtinspace.services.daemon_token_service import verify_daemon_device_claim
        self.assertFalse(verify_daemon_device_claim({}, "fp-abc123"))

    def test_timing_safe_comparison(self):
        """device_id 比较必须使用 hmac.compare_digest（常量时间）"""
        from apps.tabtinspace.services.daemon_token_service import verify_daemon_device_claim
        source = inspect.getsource(verify_daemon_device_claim)
        self.assertIn("hmac.compare_digest", source)


if __name__ == "__main__":
    unittest.main()
