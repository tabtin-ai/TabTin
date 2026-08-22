"""
CD-001 / CD-004 端点层回归测试：心跳和续期端点接受 daemon token。

验证场景：
- /devices/heartbeat 路由注册了 [JWTAuth, DaemonJWTAuth] 双认证器
- /devices/token/renew 保留旧 access token，并接受 DaemonJWTAuth
- daemon token 通过 DaemonJWTAuth 认证后，心跳端点正常响应
- daemon token 通过 DaemonJWTAuth 认证后，续期端点正常响应
- 普通 access token 通过 JWTAuth 后心跳仍正常（无回归）
"""
import os
import sys
from unittest.mock import patch, MagicMock

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

if "test" not in sys.argv:
    sys.argv.append("test")

import django  # noqa: E402
django.setup()

import pytest  # noqa: E402
from django.test import RequestFactory, override_settings  # noqa: E402

from apps.users.auth.permissions import DaemonJWTAuth, JWTAuth  # noqa: E402


class TestEndpointDualAuthConfig:
    """CD-001: 心跳和续期端点必须同时注册 JWTAuth 和 DaemonJWTAuth。"""

    def _get_auth_types_for_path(self, target_path: str):
        from apps.tabtinspace.routers import router
        for path_view in router.path_operations.values():
            for op in path_view.operations:
                if target_path in str(getattr(path_view, '_path', '')) or \
                   any(target_path in str(getattr(op, 'path', ''))
                       for _ in [1]):
                    auth_list = op.auth_callbacks or []
                    return [type(a).__name__ for a in auth_list]
        return None

    def test_heartbeat_route_has_dual_auth(self):
        """CD-001: /devices/heartbeat 路由包含 JWTAuth 和 DaemonJWTAuth。"""
        from apps.tabtinspace.routers import router
        for k, path_view in router.path_operations.items():
            if "heartbeat" not in str(k):
                continue
            for op in path_view.operations:
                auth_list = op.auth_callbacks or []
                auth_names = [type(a).__name__ for a in auth_list]
                assert "DaemonJWTAuth" in auth_names, (
                    f"heartbeat auth should include DaemonJWTAuth, got {auth_names}"
                )
                assert "JWTAuth" in auth_names, (
                    f"heartbeat auth should include JWTAuth, got {auth_names}"
                )
                return
        pytest.fail("heartbeat route not found in router")

    def test_token_renew_route_keeps_legacy_and_daemon_auth(self):
        """旧 access token 契约保留；启用控制面后 view 再要求设备 claim。"""
        from apps.tabtinspace.routers import router
        for k, path_view in router.path_operations.items():
            if "token/renew" not in str(k):
                continue
            for op in path_view.operations:
                auth_list = op.auth_callbacks or []
                auth_names = [type(a).__name__ for a in auth_list]
                assert auth_names == ["JWTAuth", "DaemonJWTAuth"], auth_names
                return
        pytest.fail("token/renew route not found in router")

    def test_regular_endpoints_not_affected(self):
        """CD-001 无回归：非 daemon 端点仍只使用 JWTAuth。"""
        from apps.tabtinspace.routers import router
        for k, path_view in router.path_operations.items():
            if "organizations" not in str(k):
                continue
            for op in path_view.operations:
                auth_list = op.auth_callbacks or []
                auth_names = [type(a).__name__ for a in auth_list]
                if auth_names:
                    assert "DaemonJWTAuth" not in auth_names, (
                        f"non-daemon route {k} should not have DaemonJWTAuth"
                    )
                return


class TestHeartbeatWithDaemonToken:
    """CD-001/CD-004: daemon token 通过 DaemonJWTAuth 后心跳端点正常工作。"""

    def setup_method(self):
        self.factory = RequestFactory()

    @patch("apps.tabtinspace.routers.device.DeviceService")
    def test_heartbeat_succeeds_with_daemon_auth(self, mock_svc_cls):
        """daemon 认证后心跳返回正常响应。"""
        from apps.tabtinspace.routers.device import device_heartbeat
        from apps.tabtinspace.schemas.device import DeviceHeartbeat

        mock_device = MagicMock()
        mock_device.status = "online"
        mock_device.last_heartbeat_at = MagicMock()
        mock_device.last_heartbeat_at.isoformat.return_value = "2026-03-18T00:00:00Z"
        mock_device.device_type = "daemon"
        mock_svc_cls.return_value.heartbeat.return_value = mock_device

        request = self.factory.post("/api/v1/tabtinspace/devices/heartbeat")
        mock_user = MagicMock()
        mock_user.id = "test-user-001"
        request.auth = mock_user
        request.daemon_device_id = "daemon-fp-test"
        request.daemon_jti = "daemon-jti-test"
        request.META['HTTP_AUTHORIZATION'] = ''

        payload = DeviceHeartbeat(fingerprint="daemon-fp-test")
        result = device_heartbeat(request, payload)
        assert result is not None
        if isinstance(result, dict):
            assert result.get("success") is True or "status" in result.get("data", {})
        elif isinstance(result, tuple):
            assert result[1] == 200

    @patch("apps.tabtinspace.routers.device.DeviceService")
    def test_heartbeat_succeeds_with_regular_jwt(self, mock_svc_cls):
        """普通 access token 通过 JWTAuth 后心跳仍正常工作（无回归）。"""
        from apps.tabtinspace.routers.device import device_heartbeat
        from apps.tabtinspace.schemas.device import DeviceHeartbeat

        mock_device = MagicMock()
        mock_device.status = "online"
        mock_device.last_heartbeat_at = MagicMock()
        mock_device.last_heartbeat_at.isoformat.return_value = "2026-03-18T00:00:00Z"
        mock_device.device_type = "electron"
        mock_svc_cls.return_value.heartbeat.return_value = mock_device

        request = self.factory.post("/api/v1/tabtinspace/devices/heartbeat")
        mock_user = MagicMock()
        mock_user.id = "test-user-002"
        request.auth = mock_user
        request.META['HTTP_AUTHORIZATION'] = ''

        payload = DeviceHeartbeat(fingerprint="electron-fp-test")
        result = device_heartbeat(request, payload)
        assert result is not None


class TestTokenRenewWithDaemonToken:
    """CD-001/CD-004: daemon token 通过 DaemonJWTAuth 后续期端点正常工作。"""

    def setup_method(self):
        self.factory = RequestFactory()

    @patch("apps.tabtinspace.services.daemon_token_service.renew_daemon_token")
    @patch("apps.tabtinspace.services.device_control_guard.is_device_blocked", return_value=False)
    def test_renew_succeeds_with_daemon_auth(self, _mock_blocked, mock_renew):
        from apps.tabtinspace.routers.device import device_token_renew
        from apps.tabtinspace.schemas.device import DeviceTokenRenew

        mock_renew.return_value = "new-jwt-token-abc"

        request = self.factory.post("/api/v1/tabtinspace/devices/token/renew")
        mock_user = MagicMock()
        mock_user.id = "test-user-001"
        request.auth = mock_user
        request.daemon_device_id = "daemon-fp-renew"
        request.daemon_jti = "daemon-jti-renew"

        payload = DeviceTokenRenew(fingerprint="daemon-fp-renew")
        result = device_token_renew(request, payload)
        assert "new-jwt-token-abc" in str(result)

    @override_settings(DAEMON_CONTROL_ENABLED=True)
    @patch("apps.tabtinspace.services.device_control_guard.is_device_blocked", return_value=False)
    def test_enabled_control_plane_rejects_account_token_without_device_claim(self, _mock_blocked):
        from apps.tabtinspace.routers.device import device_token_renew
        from apps.tabtinspace.schemas.device import DeviceTokenRenew

        request = self.factory.post("/api/v1/tabtinspace/devices/token/renew")
        request.auth = MagicMock(id="test-user-001")

        result = device_token_renew(
            request,
            DeviceTokenRenew(fingerprint="daemon-fp-renew"),
        )

        assert "DEVICE_MISMATCH" in str(result)
