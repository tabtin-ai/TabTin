"""
CD-001 / CD-004 回归测试：DaemonJWTAuth 专用认证器。

验证场景：
- 合法 daemon token（含 jti + device_id）→ 通过
- 普通 access token → 拒绝（token_type 不匹配）
- refresh token → 拒绝
- 无 jti 的 daemon token → 拒绝
- 无 device_id 的 daemon token → 拒绝（CD-004 核心验证）
- 已吊销 jti → 拒绝
- 用户不存在 / 未激活 → 拒绝
- 认证成功后 request 上挂载 daemon_device_id 和 daemon_jti
- daemon token 不需要 sid 字段（CD-004 跳过 session 绑定）
"""
import os
import sys
from datetime import timedelta
from unittest.mock import patch, MagicMock

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

if "test" not in sys.argv:
    sys.argv.append("test")

import django  # noqa: E402
django.setup()

import jwt as _pyjwt  # noqa: E402
import pytest  # noqa: E402
from django.conf import settings  # noqa: E402
from django.test import RequestFactory  # noqa: E402
from django.utils import timezone  # noqa: E402

from apps.users.auth.permissions import DaemonJWTAuth  # noqa: E402

_REVOKE_FN = "apps.tabtinspace.services.daemon_token_service.is_daemon_token_revoked"
_USER_GET_FN = "apps.users.auth.permissions.User.objects"

DEVICE_FP = "daemon-test-fingerprint-001"


def _make_daemon_token(user_id="test-user-uuid-001", **overrides):
    payload = {
        "user_id": user_id,
        "token_type": "daemon",
        "device_id": DEVICE_FP,
        "jti": "test-daemon-jti-001",
        "exp": timezone.now() + timedelta(hours=24),
        "iat": timezone.now(),
    }
    payload.update(overrides)
    return _pyjwt.encode(payload, settings.JWT_SECRET_KEY, algorithm="HS256")


def _make_mock_user(user_id="test-user-uuid-001", is_active=True):
    user = MagicMock()
    user.id = user_id
    user.is_active = is_active
    return user


class TestDaemonJWTAuth:
    """CD-001/CD-004: DaemonJWTAuth 认证器回归测试"""

    def setup_method(self):
        self.factory = RequestFactory()
        self.auth = DaemonJWTAuth()
        self.request = self.factory.get("/api/devices/heartbeat")

    @patch(_REVOKE_FN, return_value=False)
    @patch(_USER_GET_FN)
    def test_valid_daemon_token_passes(self, mock_user_mgr, mock_revoked):
        """合法 daemon token 应通过认证"""
        user = _make_mock_user()
        mock_user_mgr.get.return_value = user
        token = _make_daemon_token()
        result = self.auth.authenticate(self.request, token)
        assert result is not None
        assert result.id == "test-user-uuid-001"
        mock_revoked.assert_called_once_with("test-daemon-jti-001")

    @patch(_REVOKE_FN, return_value=False)
    @patch(_USER_GET_FN)
    def test_request_attrs_set_on_success(self, mock_user_mgr, _mock):
        """认证成功后 request 应挂载 daemon_device_id 和 daemon_jti"""
        mock_user_mgr.get.return_value = _make_mock_user()
        token = _make_daemon_token()
        self.auth.authenticate(self.request, token)
        assert self.request.daemon_device_id == DEVICE_FP
        assert self.request.daemon_jti == "test-daemon-jti-001"

    def test_access_token_rejected(self):
        """CD-001 核心：普通 access token 被 DaemonJWTAuth 拒绝"""
        token = _make_daemon_token(token_type="access")
        result = self.auth.authenticate(self.request, token)
        assert result is None

    def test_refresh_token_rejected(self):
        """refresh token 被拒绝"""
        token = _make_daemon_token(token_type="refresh")
        result = self.auth.authenticate(self.request, token)
        assert result is None

    def test_missing_jti_rejected(self):
        """无 jti 的 daemon token 被拒绝"""
        payload = {
            "user_id": "test-user-uuid-001",
            "token_type": "daemon",
            "device_id": DEVICE_FP,
            "exp": timezone.now() + timedelta(hours=24),
            "iat": timezone.now(),
        }
        token = _pyjwt.encode(payload, settings.JWT_SECRET_KEY, algorithm="HS256")
        result = self.auth.authenticate(self.request, token)
        assert result is None

    def test_missing_device_id_rejected(self):
        """CD-004 核心：无 device_id 的 daemon token 被拒绝"""
        payload = {
            "user_id": "test-user-uuid-001",
            "token_type": "daemon",
            "jti": "test-jti-no-device",
            "exp": timezone.now() + timedelta(hours=24),
            "iat": timezone.now(),
        }
        token = _pyjwt.encode(payload, settings.JWT_SECRET_KEY, algorithm="HS256")
        result = self.auth.authenticate(self.request, token)
        assert result is None

    @patch(_REVOKE_FN, return_value=True)
    def test_revoked_jti_rejected(self, mock_revoked):
        """已吊销 jti 的 daemon token 被拒绝"""
        token = _make_daemon_token(jti="revoked-daemon-jti")
        result = self.auth.authenticate(self.request, token)
        assert result is None
        mock_revoked.assert_called_once_with("revoked-daemon-jti")

    @patch(_REVOKE_FN, return_value=False)
    @patch(_USER_GET_FN)
    def test_nonexistent_user_rejected(self, mock_user_mgr, _mock):
        """用户不存在时拒绝"""
        from django.contrib.auth import get_user_model
        mock_user_mgr.get.side_effect = get_user_model().DoesNotExist
        token = _make_daemon_token()
        result = self.auth.authenticate(self.request, token)
        assert result is None

    @patch(_REVOKE_FN, return_value=False)
    @patch(_USER_GET_FN)
    def test_inactive_user_rejected(self, mock_user_mgr, _mock):
        """用户未激活时拒绝"""
        mock_user_mgr.get.return_value = _make_mock_user(is_active=False)
        token = _make_daemon_token()
        result = self.auth.authenticate(self.request, token)
        assert result is None

    def test_expired_token_rejected(self):
        """过期 daemon token 被拒绝"""
        token = _make_daemon_token(exp=timezone.now() - timedelta(hours=1))
        result = self.auth.authenticate(self.request, token)
        assert result is None

    def test_invalid_signature_rejected(self):
        """签名错误的 token 被拒绝"""
        payload = {
            "user_id": "test-user-uuid-001",
            "token_type": "daemon",
            "device_id": DEVICE_FP,
            "jti": "test-jti",
            "exp": timezone.now() + timedelta(hours=24),
            "iat": timezone.now(),
        }
        token = _pyjwt.encode(payload, "wrong-secret-key", algorithm="HS256")
        result = self.auth.authenticate(self.request, token)
        assert result is None

    @patch(_REVOKE_FN, return_value=False)
    @patch(_USER_GET_FN)
    def test_no_sid_required(self, mock_user_mgr, _mock):
        """CD-004 核心：daemon token 不需要 sid 字段即可通过（跳过 session 绑定）"""
        mock_user_mgr.get.return_value = _make_mock_user()
        token = _make_daemon_token()
        payload = _pyjwt.decode(token, settings.JWT_SECRET_KEY, algorithms=["HS256"])
        assert "sid" not in payload
        result = self.auth.authenticate(self.request, token)
        assert result is not None
