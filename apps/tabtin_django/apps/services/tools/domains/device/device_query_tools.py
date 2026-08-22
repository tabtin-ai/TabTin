"""
设备数据查询工具。

通过统一的设备查询服务查询当前 Space 可用的能力设备，
首批覆盖 device_info / battery / network_info 三类只读能力。
"""

from __future__ import annotations

import logging
import threading
import time
from types import SimpleNamespace
from typing import Annotated, Any, Dict, Optional

from pydantic import BaseModel, Field

from apps.services.common.state.injected_state import InjectedState
from apps.services.agent_engine.services.device_runtime_query_service import DeviceRuntimeQueryService
from apps.services.tools import BaseTool
from apps.services.tools.error_envelope import build_tool_error

# ---------------------------------------------------------------------------
# 审计日志 (P0-2)
# ---------------------------------------------------------------------------
audit_logger = logging.getLogger("device_audit")

# ---------------------------------------------------------------------------
# Per-device 并发限流 (P1-FUN-6)
# ---------------------------------------------------------------------------

_DEVICE_MAX_CONCURRENT = 3
_DEVICE_WAIT_TIMEOUT = 30  # 排队等待最大秒数


class _DeviceRateLimiter:
    """简易 per-device 并发限流器（进程内 Semaphore）。

    同一 space（即同一设备）同时最多 _DEVICE_MAX_CONCURRENT 个操作。
    超过时排队等待，超过 _DEVICE_WAIT_TIMEOUT 则拒绝（429）。
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._semaphores: Dict[str, threading.Semaphore] = {}

    def _get_semaphore(self, device_key: str) -> threading.Semaphore:
        with self._lock:
            if device_key not in self._semaphores:
                self._semaphores[device_key] = threading.Semaphore(_DEVICE_MAX_CONCURRENT)
            return self._semaphores[device_key]

    def acquire(self, device_key: str, timeout: float = _DEVICE_WAIT_TIMEOUT) -> bool:
        """尝试获取槽位，返回 True 表示成功。"""
        sem = self._get_semaphore(device_key)
        return sem.acquire(timeout=timeout)

    def release(self, device_key: str) -> None:
        sem = self._get_semaphore(device_key)
        sem.release()


_rate_limiter = _DeviceRateLimiter()

# P1-FUN-5: required_permission → Space role 映射
_PERMISSION_TO_ROLE = {
    "read": "viewer",
    "write": "editor",
    "admin": "admin",
}


def _sanitize_params_for_audit(params: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """对请求参数做脱敏处理，用于审计日志。"""
    if not params:
        return {}
    sanitized: Dict[str, Any] = {}
    _sensitive_keys = frozenset({"message", "text", "to", "number", "credential_id"})
    _full_mask_keys = frozenset({"text"})
    for k, v in params.items():
        if k in _full_mask_keys:
            sanitized[k] = "***"
        elif k in _sensitive_keys:
            sv = str(v)
            if len(sv) > 4:
                sanitized[k] = sv[:2] + "***" + sv[-2:]
            else:
                sanitized[k] = "***"
        else:
            sanitized[k] = v
    return sanitized


def _get_injected_field_names(schema: type[BaseModel]) -> frozenset[str]:
    """Return field names whose annotation carries an InjectedState marker."""
    names: set[str] = set()
    for name, info in schema.model_fields.items():
        for meta in info.metadata:
            if isinstance(meta, InjectedState):
                names.add(name)
                break
    return frozenset(names)


def _map_device_error_code(code: str | None) -> tuple[str, str, bool]:
    """Map DeviceRuntimeQueryService / local codes → (error_kind, hint, retryable)."""
    normalized = (code or "").strip().upper()
    if normalized == "PERMISSION_DENIED":
        return (
            "permission_denied",
            "Ask the user to grant Space access for this device action, then retry.",
            False,
        )
    if normalized == "NOT_FOUND":
        return (
            "resource_not_found",
            "Confirm the Space still exists, then retry the device tool.",
            False,
        )
    if normalized in {"DEVICE_RUNTIME_OFFLINE", "DEVICE_RUNTIME_UNAVAILABLE"}:
        return (
            "host_unsupported",
            "Bind an online capability device to this Space, then retry.",
            True,
        )
    if normalized in {
        "DEVICE_ACTION_DELIVERY_FAILED",
        "TASK_TIMEOUT",
        "BACKEND_ERROR",
    }:
        return (
            "network_failed",
            "Retry once. If it fails again, check the device connection and try later.",
            True,
        )
    if normalized == "RATE_LIMITED":
        return (
            "rate_limited",
            "Wait a moment, then retry the device action.",
            True,
        )
    if normalized == "WORKING_DIR_NOT_SET":
        return (
            "runtime_misconfig",
            "Set the Space working directory before browsing device files.",
            False,
        )
    return (
        "upstream_error",
        "Retry once. If it fails again, tell the user the device action is unavailable.",
        True,
    )


_DEVICE_CONTEXT_KEYS = (
    "device_fingerprint",
    "device_type",
    "dispatch_reason",
    "http_status",
    "degraded",
    "required_capability",
    "binding_source",
)


def _device_tool_error(
    error: str,
    *,
    error_kind: str | None = None,
    hint: str | None = None,
    retryable: bool | None = None,
    upstream_code: str | None = None,
    context: dict[str, Any] | None = None,
) -> Dict[str, Any]:
    if error_kind is None:
        error_kind, mapped_hint, mapped_retryable = _map_device_error_code(upstream_code)
        if hint is None:
            hint = mapped_hint
        if retryable is None:
            retryable = mapped_retryable
    if hint is None:
        hint = "Retry once after fixing the reported device issue."
    return build_tool_error(
        error,
        error_kind=error_kind,
        hint=hint,
        retryable=retryable,
        upstream_code=upstream_code,
        context=context,
    )


def _normalize_device_failure(
    result: Dict[str, Any],
    *,
    fallback_error: str,
) -> Dict[str, Any]:
    code = result.get("error_code")
    upstream = str(code).strip() if code else None
    error = str(result.get("error") or fallback_error)
    context = {
        key: result[key]
        for key in _DEVICE_CONTEXT_KEYS
        if key in result and result[key] is not None
    }
    return _device_tool_error(
        error,
        upstream_code=upstream,
        context=context or None,
    )


class DeviceQueryInput(BaseModel):
    user_id: Annotated[Optional[str], InjectedState("user_id")] = Field(
        default=None,
        description="User ID (auto-injected)",
    )
    current_space_id: Annotated[Optional[str], InjectedState("current_space_id")] = Field(
        default=None,
        description="Space ID (auto-injected)",
    )


class _BaseDeviceQueryTool(BaseTool):
    risk_level: str = "safe"
    timeout: int = 30
    cacheable: bool = False
    args_schema: type[BaseModel] = DeviceQueryInput

    # P1-FUN-5: 权限分级 — read / write / admin
    required_permission: str = "read"

    def _extract_device_params(self, kwargs: Dict[str, Any]) -> Dict[str, Any]:
        """Extract non-injected kwargs as device params, using schema metadata."""
        injected = _get_injected_field_names(self.args_schema)
        return {k: v for k, v in kwargs.items() if k not in injected and v is not None}

    def _run_query(
        self,
        *,
        user_id: Optional[str],
        current_space_id: Optional[str],
        fallback_error: str,
        params: Optional[Dict[str, Any]] = None,
        action_override: Optional[str] = None,
    ) -> Dict[str, Any]:
        action_name = action_override or self.name

        if not current_space_id:
            audit_logger.warning(
                "device_query_rejected | user=%s space=None action=%s reason=missing_space_id",
                user_id, action_name,
            )
            return _device_tool_error(
                "current_space_id is required",
                error_kind="runtime_misconfig",
                hint="Start the Agent inside a Space so current_space_id is injected before calling device tools.",
                retryable=False,
            )

        if not user_id:
            audit_logger.warning(
                "device_query_rejected | user=None space=%s action=%s reason=missing_user_id",
                current_space_id, action_name,
            )
            return _device_tool_error(
                "user_id is required for device query",
                error_kind="runtime_misconfig",
                hint="Ensure the Agent session injects user_id before calling device tools.",
                retryable=False,
            )

        # 审计日志 — 记录每次访问 (P0-2)
        sanitized = _sanitize_params_for_audit(params)
        audit_logger.info(
            "device_query_start | user=%s space=%s action=%s permission=%s risk=%s params=%s",
            user_id, current_space_id, action_name,
            self.required_permission, self.risk_level, sanitized,
        )

        # 并发限流 (P1-FUN-6)
        device_key = f"device:{current_space_id}"
        if not _rate_limiter.acquire(device_key):
            audit_logger.warning(
                "device_query_throttled | user=%s space=%s action=%s reason=concurrent_limit_exceeded",
                user_id, current_space_id, action_name,
            )
            return _device_tool_error(
                "Device is busy — too many concurrent operations. Please retry shortly.",
                upstream_code="RATE_LIMITED",
            )

        try:
            service = DeviceRuntimeQueryService(user=SimpleNamespace(id=user_id))
            transport_timeout = self.timeout + 5
            mapped_role = _PERMISSION_TO_ROLE.get(self.required_permission, "admin")
            result = service.dispatch_space_action(
                space_id=str(current_space_id),
                action=action_name,
                params=params,
                timeout_seconds=transport_timeout,
                required_role=mapped_role,
            )

            if not result.get("success"):
                result["error"] = result.get("error", fallback_error)
                audit_logger.warning(
                    "device_query_failed | user=%s space=%s action=%s error_code=%s",
                    user_id, current_space_id, action_name,
                    result.get("error_code"),
                )
                return _normalize_device_failure(result, fallback_error=fallback_error)

            data = result.get("data")
            if isinstance(data, dict):
                audit_logger.info(
                    "device_query_success | user=%s space=%s action=%s device=%s",
                    user_id, current_space_id, action_name,
                    result.get("device_fingerprint", "unknown"),
                )
                return {
                    "success": True,
                    "data": data,
                    "device_fingerprint": result.get("device_fingerprint"),
                    "device_type": result.get("device_type"),
                    "dispatch_reason": result.get("dispatch_reason"),
                }

            audit_logger.warning(
                "device_query_failed | user=%s space=%s action=%s reason=empty_data",
                user_id, current_space_id, action_name,
            )
            return _device_tool_error(
                fallback_error,
                error_kind="upstream_error",
                hint="Retry once. If it fails again, tell the user the device returned no data.",
                retryable=True,
            )
        finally:
            _rate_limiter.release(device_key)


class GetDeviceInfoTool(_BaseDeviceQueryTool):
    name: str = "get_device_info"
    description: str = (
        "Read normalized information from an available Space capability device runtime, "
        "including platform, OS version, model, and device name. "
        "Use when the user asks which iPhone/mobile device is available or wants runtime identity details."
    )

    def run(
        self,
        user_id: Optional[str] = None,
        current_space_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        return self._run_query(
            user_id=user_id,
            current_space_id=current_space_id,
            fallback_error="Failed to read device information from the connected device runtime",
        )


class GetBatteryInfoTool(_BaseDeviceQueryTool):
    name: str = "get_battery_info"
    description: str = (
        "Read live battery state from an available Space capability device, "
        "including charge level, percent, charging state, and low power mode. "
        "Use when the user asks about iPhone/mobile battery health or remaining power."
    )

    def run(
        self,
        user_id: Optional[str] = None,
        current_space_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        return self._run_query(
            user_id=user_id,
            current_space_id=current_space_id,
            fallback_error="Failed to read battery information from the connected device runtime",
        )


class GetNetworkInfoTool(_BaseDeviceQueryTool):
    name: str = "get_network_info"
    description: str = (
        "Read current network connectivity from an available Space capability device, "
        "including whether it is connected and the connection type such as wifi or cellular. "
        "Use when the user asks about the mobile device's network status."
    )

    def run(
        self,
        user_id: Optional[str] = None,
        current_space_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        return self._run_query(
            user_id=user_id,
            current_space_id=current_space_id,
            fallback_error="Failed to read network information from the connected device runtime",
        )


__all__ = [
    "GetBatteryInfoTool",
    "GetDeviceInfoTool",
    "GetNetworkInfoTool",
]
