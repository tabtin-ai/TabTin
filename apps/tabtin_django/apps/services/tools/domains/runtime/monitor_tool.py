"""
Monitor Process Tool — 启动长驻进程并实时接收其 stdout

Agent 使用 monitor_process 启动一个不会退出的进程（dev server、日志尾随等），
进程的 stdout 通过设备端过滤后实时推入 Agent 对话循环。

与 run_terminal_command 的区别：
- run_terminal_command: 执行 → 等结果 → 返回（或 run_in_background=true 后用
  read_file 轮询 output_file）
- monitor_process: 启动 → 立即返回 → 后续 stdout 行通过 middleware 自动注入
  到对话循环（不需要 LLM 主动轮询）
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field
from typing_extensions import Annotated

from apps.services.common.state.injected_state import InjectedState
from apps.services.tools import BaseTool
from apps.services.tools.error_envelope import build_tool_error

logger = logging.getLogger(__name__)


# ═══════════════════════════════════════════════════════════════════════
# monitor_process
# ═══════════════════════════════════════════════════════════════════════

class MonitorProcessInput(BaseModel):
    command: str = Field(
        ..., description="Shell command to run (e.g. 'pnpm dev', 'docker compose logs -f', 'tail -f /var/log/syslog')",
    )
    description: str = Field(
        ..., description="Human-readable label for this monitor (e.g. 'Frontend dev server', 'Backend logs')",
    )
    notify_on: Literal["every_line", "on_error", "on_pattern", "on_build"] = Field(
        "every_line",
        description=(
            "When to push stdout lines to you:\n"
            "- every_line: every line of output (for log tailing)\n"
            "- on_error: only lines containing error/Error/ERROR/FAIL/fatal keywords\n"
            "- on_build: error keywords PLUS build-success keywords (compiled, build succeeded, ready in, done in, etc.) — use this for dev servers so you see both failures and successful rebuilds\n"
            "- on_pattern: only lines matching the regex in 'pattern' parameter"
        ),
    )
    pattern: Optional[str] = Field(
        None,
        description="Regex pattern — only matching lines trigger notifications (when notify_on='on_pattern')",
    )
    working_directory: Optional[str] = Field(
        None, description="Override working directory for this command",
    )

    thread_id: Annotated[Optional[str], InjectedState("thread_id")] = Field(
        None, description="(auto-injected)",
    )
    device_id: Annotated[Optional[str], InjectedState("device_id")] = Field(
        None, description="(auto-injected)",
    )
    current_space_id: Annotated[Optional[str], InjectedState("current_space_id")] = Field(
        None, description="(auto-injected)",
    )
    subagent_run_id: Annotated[Optional[str], InjectedState("subagent_run_id")] = Field(
        None, description="(auto-injected)",
    )


class MonitorProcessTool(BaseTool):
    category: str = "terminal"
    name: str = "monitor_process"
    description: str = (
        "Start a long-running process and stream its stdout to the conversation in real time. "
        "Each matching line of output becomes a notification that you can see and react to. "
        "Use this for dev servers, log tailing, test suites — any process that produces "
        "continuous output you need to watch. "
        "For one-shot commands that will finish, use run_terminal_command instead "
        "(with run_in_background=true if you want to detach without watching live output). "
        "Returns a monitor_id that you can use with stop_monitor or list_monitors."
    )
    risk_level: str = "review"
    args_schema: type[MonitorProcessInput] = MonitorProcessInput

    def run(
        self,
        command: str,
        description: str,
        notify_on: str = "every_line",
        pattern: Optional[str] = None,
        working_directory: Optional[str] = None,
        thread_id: Optional[str] = None,
        device_id: Optional[str] = None,
        current_space_id: Optional[str] = None,
        subagent_run_id: Optional[str] = None,
        **kwargs,
    ) -> Dict[str, Any]:
        if not command or not command.strip():
            return build_tool_error(
                "command is required",
                error_kind="missing_required_param",
                hint="Provide the shell command to monitor before calling monitor_process.",
                retryable=False,
            )
        if not description or not description.strip():
            return build_tool_error(
                "description is required",
                error_kind="missing_required_param",
                hint="Provide a short human-readable description for this monitor.",
                retryable=False,
            )
        if notify_on == "on_pattern" and not pattern:
            return build_tool_error(
                "pattern is required when notify_on='on_pattern'",
                error_kind="missing_required_param",
                hint="Pass a regex pattern, or change notify_on to every_line/on_error/on_build.",
                retryable=False,
            )
        if not thread_id:
            return build_tool_error(
                "thread_id not available (internal error)",
                error_kind="runtime_misconfig",
                hint="Retry in an active Agent conversation so thread_id is injected.",
                retryable=False,
            )

        device_fingerprint = device_id or "unknown"

        from apps.services.agent_engine.services.monitor_service import get_monitor_service
        svc = get_monitor_service()

        try:
            monitor = svc.create_monitor(
                thread_id=thread_id,
                command=command.strip(),
                description=description.strip(),
                device_fingerprint=device_fingerprint,
                notify_on=notify_on,
                pattern=pattern,
                working_directory=working_directory,
                parent_subagent_id=subagent_run_id if subagent_run_id else None,
            )
        except ValueError:
            logger.warning(
                "[MonitorProcessTool] create_monitor rejected type=%s",
                "ValueError",
            )
            return build_tool_error(
                "Monitor could not be created with the provided parameters.",
                error_kind="invalid_param_format",
                hint="Check command/pattern/working_directory and retry monitor_process.",
                retryable=False,
            )
        except Exception as exc:
            logger.error(
                "[MonitorProcessTool] create_monitor failed type=%s",
                type(exc).__name__,
                exc_info=True,
            )
            return build_tool_error(
                "Failed to create monitor.",
                error_kind="internal_error",
                hint="Retry once. If it fails again, ask the user to restart the Agent session.",
                retryable=True,
            )

        self._dispatch_monitor_start(
            thread_id=thread_id,
            monitor=monitor,
            device_fingerprint=device_fingerprint,
        )

        return {
            "success": True,
            "monitor_id": monitor["monitor_id"],
            "description": monitor["description"],
            "status": monitor["status"],
            "message": (
                f'Monitor "{description}" started. '
                f"Matching output lines (notify_on={notify_on}) will be pushed to you automatically. "
                f"Use stop_monitor(monitor_id='{monitor['monitor_id']}') when done."
            ),
        }

    @staticmethod
    def _dispatch_monitor_start(
        *, thread_id: str, monitor: Dict[str, Any], device_fingerprint: str,
    ) -> None:
        """Fire-and-forget: send monitor_start action to the bound device."""
        try:
            from apps.services.agent_engine.services.frontend_action_service import get_frontend_action_service
            from apps.services.common.ws.protocol import build_envelope, new_event_id
            from apps.services.common.agent_protocol.namespace import action_event_type

            svc = get_frontend_action_service()
            event_id = new_event_id()
            payload = {
                "task_id": monitor["monitor_id"],
                "action": "monitor_start",
                "params": {
                    "monitor_id": monitor["monitor_id"],
                    "thread_id": thread_id,
                    "command": monitor["command"],
                    "description": monitor["description"],
                    "notify_on": monitor["notify_on"],
                    "pattern": monitor.get("pattern"),
                    "working_directory": monitor.get("working_directory"),
                },
                "thread_id": thread_id,
            }
            envelope = build_envelope(
                action_event_type("request"),
                event_id,
                payload,
                event_id=event_id,
                thread_id=thread_id,
            )
            target_fp = device_fingerprint if device_fingerprint != "unknown" else None
            svc.publish_action(thread_id, envelope, target_device_fingerprint=target_fp)
            logger.info("[MonitorProcessTool] Dispatched monitor_start to device: %s", monitor["monitor_id"])
        except Exception as exc:
            logger.warning("[MonitorProcessTool] Failed to dispatch monitor_start: %s", exc)


# ═══════════════════════════════════════════════════════════════════════
# stop_monitor
# ═══════════════════════════════════════════════════════════════════════

class StopMonitorInput(BaseModel):
    monitor_id: str = Field(
        ..., description="ID of the monitor to stop (returned by monitor_process)",
    )


class StopMonitorTool(BaseTool):
    name: str = "stop_monitor"
    description: str = "Stop a running process monitor. The underlying process will be killed."
    risk_level: str = "safe"
    args_schema: type[StopMonitorInput] = StopMonitorInput

    def run(self, monitor_id: str, **kwargs) -> Dict[str, Any]:
        if not monitor_id:
            return build_tool_error(
                "monitor_id is required",
                error_kind="missing_required_param",
                hint="Pass the monitor_id returned by monitor_process.",
                retryable=False,
            )

        from apps.services.agent_engine.services.monitor_service import get_monitor_service
        svc = get_monitor_service()

        stopped = svc.stop_monitor(monitor_id)
        if not stopped:
            existing = svc.get_monitor(monitor_id)
            if existing is None:
                return build_tool_error(
                    f"Monitor '{monitor_id}' not found",
                    error_kind="resource_not_found",
                    hint="Call list_monitors to find an active monitor_id, then retry.",
                    retryable=False,
                )
            return build_tool_error(
                f"Monitor '{monitor_id}' is not running (status={existing['status']})",
                error_kind="invalid_param_format",
                hint="Only running monitors can be stopped. Use list_monitors to check status.",
                retryable=False,
                context={"status": existing.get("status")},
            )

        self._dispatch_monitor_stop(monitor_id)

        return {"success": True, "message": f"Monitor '{monitor_id}' stopped."}

    @staticmethod
    def _dispatch_monitor_stop(monitor_id: str) -> None:
        """Fire-and-forget: send monitor_stop action to the bound device."""
        try:
            from apps.services.agent_engine.services.monitor_service import get_monitor_service
            monitor = get_monitor_service().get_monitor(monitor_id)
            if not monitor:
                return

            from apps.services.agent_engine.services.frontend_action_service import get_frontend_action_service
            from apps.services.common.ws.protocol import build_envelope, new_event_id
            from apps.services.common.agent_protocol.namespace import action_event_type

            svc = get_frontend_action_service()
            event_id = new_event_id()
            payload = {
                "task_id": monitor_id,
                "action": "monitor_stop",
                "params": {"monitor_id": monitor_id},
                "thread_id": monitor["thread_id"],
            }
            envelope = build_envelope(
                action_event_type("request"),
                event_id,
                payload,
                event_id=event_id,
                thread_id=monitor["thread_id"],
            )
            fp = monitor.get("device_fingerprint")
            svc.publish_action(
                monitor["thread_id"], envelope,
                target_device_fingerprint=fp if fp and fp != "unknown" else None,
            )
            logger.info("[StopMonitorTool] Dispatched monitor_stop to device: %s", monitor_id)
        except Exception as exc:
            logger.warning("[StopMonitorTool] Failed to dispatch monitor_stop: %s", exc)


# ═══════════════════════════════════════════════════════════════════════
# list_monitors
# ═══════════════════════════════════════════════════════════════════════

class ListMonitorsInput(BaseModel):
    status: Optional[str] = Field(
        None, description="Filter by status: 'running', 'stopped', 'stream_ended', 'failed'. Omit for all.",
    )
    thread_id: Annotated[Optional[str], InjectedState("thread_id")] = Field(
        None, description="(auto-injected)",
    )


class ListMonitorsTool(BaseTool):
    name: str = "list_monitors"
    description: str = (
        "List all process monitors for the current conversation. "
        "Shows monitor_id, description, status, command, and notify_on mode."
    )
    risk_level: str = "safe"
    args_schema: type[ListMonitorsInput] = ListMonitorsInput

    def run(
        self,
        status: Optional[str] = None,
        thread_id: Optional[str] = None,
        **kwargs,
    ) -> Dict[str, Any]:
        if not thread_id:
            return build_tool_error(
                "thread_id not available",
                error_kind="runtime_misconfig",
                hint="Retry in an active Agent conversation so thread_id is injected.",
                retryable=False,
            )

        from apps.services.agent_engine.services.monitor_service import get_monitor_service
        svc = get_monitor_service()

        monitors = svc.list_monitors(thread_id, status=status)
        return {
            "success": True,
            "monitors": monitors,
            "count": len(monitors),
        }


__all__ = ["MonitorProcessTool", "StopMonitorTool", "ListMonitorsTool"]
