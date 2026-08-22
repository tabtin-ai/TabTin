"""device 域失败路径迁移到标准 error envelope。"""
from __future__ import annotations

from unittest.mock import MagicMock, patch

from apps.services.tools.domains.device.device_query_tools import GetDeviceInfoTool
from apps.services.tools.domains.device.mobile_data_tools import SendSmsTool
from apps.services.tools.domains.device.screen_automation_tools import ScreenTypeSecretTool
from apps.services.tools.error_envelope import is_standard_tool_error


def test_get_device_info_missing_space_uses_standard_envelope():
    payload = GetDeviceInfoTool().run(user_id="u1", current_space_id=None)
    assert is_standard_tool_error(payload)
    assert payload["error_kind"] == "runtime_misconfig"
    assert payload["retryable"] is False


def test_get_device_info_offline_device_maps_host_unsupported():
    service = MagicMock()
    service.dispatch_space_action.return_value = {
        "success": False,
        "error": "目标能力设备当前未在线或未建立 device_runtime 连接",
        "error_code": "DEVICE_RUNTIME_OFFLINE",
        "device_fingerprint": "fp1",
    }
    with patch(
        "apps.services.tools.domains.device.device_query_tools.DeviceRuntimeQueryService",
        return_value=service,
    ):
        payload = GetDeviceInfoTool().run(user_id="u1", current_space_id="space-1")
    assert is_standard_tool_error(payload)
    assert payload["error_kind"] == "host_unsupported"
    assert payload["upstream_code"] == "DEVICE_RUNTIME_OFFLINE"
    assert payload["retryable"] is True
    assert payload.get("device_fingerprint") == "fp1"


def test_send_sms_rate_limit_uses_standard_envelope():
    with patch(
        "apps.services.tools.domains.device.mobile_data_tools._check_sms_rate_limit",
        return_value=False,
    ):
        payload = SendSmsTool().run(
            user_id="u1",
            current_space_id="space-1",
            to="+10000000000",
            message="hi",
        )
    assert is_standard_tool_error(payload)
    assert payload["error_kind"] == "rate_limited"
    assert payload["upstream_code"] == "RATE_LIMITED"


def test_screen_type_secret_missing_credential_uses_standard_envelope():
    payload = ScreenTypeSecretTool().run(
        user_id="u1",
        current_space_id="space-1",
        index=0,
        credential_id=None,
    )
    assert is_standard_tool_error(payload)
    assert payload["error_kind"] == "missing_required_param"
    assert "credential" in payload["hint"].lower()


def test_screen_type_secret_scrubs_upstream_error_and_data_echoes():
    password = "server-echoed-password"
    service = MagicMock()
    service.dispatch_space_action.return_value = {
        "success": False,
        "error": f"Failed to type password {password}",
        "error_code": "BACKEND_ERROR",
        "data": {
            "password": password,
            "text": password,
            "debug": {"secret": password},
        },
        "device_type": "android",
        "dispatch_reason": "bound_device",
    }

    with patch.object(
        ScreenTypeSecretTool,
        "_resolve_credential",
        return_value=(password, ""),
    ), patch(
        "apps.services.tools.domains.device.device_query_tools.DeviceRuntimeQueryService",
        return_value=service,
    ), patch(
        "apps.services.tools.domains.device.device_query_tools.audit_logger.info"
    ) as log_info, patch(
        "apps.services.tools.domains.device.device_query_tools.audit_logger.warning"
    ) as log_warning:
        payload = ScreenTypeSecretTool().run(
            user_id="u1",
            current_space_id="space-1",
            credential_id="11111111-1111-1111-1111-111111111111",
            index=1,
        )

    assert is_standard_tool_error(payload)
    assert payload["error"] == "Secure credential typing failed."
    assert payload["error_kind"] == "network_failed"
    assert payload["secret_typed"] is False
    assert payload["device_type"] == "android"
    assert "data" not in payload
    assert password not in repr(payload)
    assert password not in repr(log_info.call_args_list)
    assert password not in repr(log_warning.call_args_list)
