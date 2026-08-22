"""runtime 域失败路径迁移到标准 error envelope。"""
from __future__ import annotations

from unittest.mock import MagicMock, patch

from apps.services.tools.domains.runtime.monitor_tool import (
    ListMonitorsTool,
    MonitorProcessTool,
    StopMonitorTool,
)
from apps.services.tools.error_envelope import is_standard_tool_error


def test_monitor_process_missing_command_uses_standard_envelope():
    payload = MonitorProcessTool().run(command="  ", description="dev")
    assert is_standard_tool_error(payload)
    assert payload["error_kind"] == "missing_required_param"


def test_stop_monitor_not_found_uses_standard_envelope():
    svc = MagicMock()
    svc.stop_monitor.return_value = False
    svc.get_monitor.return_value = None
    with patch(
        "apps.services.agent_engine.services.monitor_service.get_monitor_service",
        return_value=svc,
    ):
        payload = StopMonitorTool().run(monitor_id="m-missing")
    assert is_standard_tool_error(payload)
    assert payload["error_kind"] == "resource_not_found"


def test_list_monitors_missing_thread_uses_standard_envelope():
    payload = ListMonitorsTool().run(thread_id=None)
    assert is_standard_tool_error(payload)
    assert payload["error_kind"] == "runtime_misconfig"


def test_monitor_process_create_exception_is_sanitized():
    svc = MagicMock()
    svc.create_monitor.side_effect = RuntimeError("secret-monitor-token")
    with patch(
        "apps.services.agent_engine.services.monitor_service.get_monitor_service",
        return_value=svc,
    ), patch(
        "apps.services.tools.domains.runtime.monitor_tool.logger.error"
    ) as log_error:
        payload = MonitorProcessTool().run(
            command="pnpm dev",
            description="Frontend",
            thread_id="t1",
        )
    assert is_standard_tool_error(payload)
    assert payload["error_kind"] == "internal_error"
    assert "secret-monitor-token" not in payload["error"]
    assert "secret-monitor-token" not in repr(log_error.call_args_list)
