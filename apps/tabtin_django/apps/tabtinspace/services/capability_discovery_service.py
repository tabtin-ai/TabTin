from __future__ import annotations

import uuid
import warnings
from datetime import timedelta
from typing import Any, Dict, Optional

from django.utils import timezone
from django.utils.dateparse import parse_datetime

from apps.tabtinspace.models import Workspace

from .base import BaseService, ServiceError
from .capability_contract import (
    CAPABILITY_DISCOVERY_SNAPSHOT_VERSION,
    normalize_host_runtime_snapshot,
)
from .capability_refresh_transport import CapabilityRefreshTransport
from .execution_binding import resolve_execution_binding

_FRESH_WINDOW = timedelta(seconds=90)
_STALE_WINDOW = timedelta(minutes=5)
_BACKEND_REFRESH_SUPPORTED_TYPES = frozenset({"daemon", "mobile", "iot"})


def _parse_reported_at(value: Any) -> Optional[timezone.datetime]:
    if not isinstance(value, str) or not value:
        return None
    dt = parse_datetime(value)
    if dt is None:
        return None
    if timezone.is_naive(dt):
        return timezone.make_aware(dt, timezone=timezone.get_default_timezone())
    return dt


class CapabilityDiscoveryService(BaseService):
    def __init__(self, user=None) -> None:
        super().__init__(user=user)
        self._refresh_transport = CapabilityRefreshTransport()

    def get_space_summary(self, space_id: str) -> Dict[str, Any]:
        space = self._get_space(space_id)
        binding = resolve_execution_binding(space=space)
        device = binding.device

        snapshot = self._read_device_snapshot(device)
        freshness = self._build_freshness(device, snapshot)
        backend_type = "builtin"
        refresh_transport = self._resolve_refresh_transport(device)

        runtime_tools = snapshot.get("runtime_tools", []) if snapshot else []
        mcp_server = snapshot.get("mcp_server") if snapshot else None
        mcp_tools = mcp_server.get("tools", []) if isinstance(mcp_server, dict) else []

        execution_binding = {
            "bound": device is not None,
            "binding_source": binding.source,
            "device_id": str(getattr(device, "id", "")) if device is not None else None,
            "device_fingerprint": getattr(device, "fingerprint", None) if device is not None else None,
            "device_name": getattr(device, "name", None) if device is not None else None,
            "device_type": getattr(device, "device_type", None) if device is not None else None,
            "device_status": getattr(device, "status", None) if device is not None else None,
            "last_heartbeat_at": device.last_heartbeat_at.isoformat() if getattr(device, "last_heartbeat_at", None) else None,
            "refresh_transport": refresh_transport,
            "can_refresh_via_backend": bool(device is not None and refresh_transport == "ws_device_topic"),
            "can_refresh_locally": bool(device is not None and refresh_transport == "heartbeat_only"),
            "reason_codes": freshness["binding_reason_codes"],
        }

        return {
            "space_id": str(space.id),
            "organization_id": str(space.organization_id),
            "generated_at": timezone.now().isoformat(),
            "backend_type": backend_type,
            "space_device_binding": {
                "bound_device_id": str(device.id) if device is not None else None,
                "control_device_id": str(device.id) if device is not None else None,
            },
            "execution_binding": execution_binding,
            "execution_snapshot": {
                "available": snapshot is not None,
                "observed_at": freshness["observed_at"],
                "freshness_state": freshness["freshness_state"],
                "stale_reason": freshness["stale_reason"],
                "reason_codes": freshness["reason_codes"],
                "snapshot_version": snapshot.get("version") if snapshot else None,
                "snapshot_source": snapshot.get("source") if snapshot else None,
                "runtime_tools_count": len(runtime_tools),
                "mcp_tools_count": len(mcp_tools),
                "snapshot": snapshot,
            },
        }

    def initiate_space_refresh(
        self,
        *,
        space_id: str,
        requested_by: str = "manual",
    ) -> Dict[str, Any]:
        """G-034: 非阻塞 refresh — 仅发布请求，不等待设备响应。

        返回 refresh_request_id + pending 状态，设备通过 WS callback
        将 ack/result 广播到 organization topic，前端通过 WS 订阅接收。
        """
        space = self._get_space(space_id)
        binding = resolve_execution_binding(space=space)
        device = binding.device
        summary = self.get_space_summary(space_id)

        if device is None:
            return {
                "status": "unbound",
                "reason_code": "binding_missing",
                "refresh_request_id": None,
                "summary": summary,
            }

        refresh_transport = self._resolve_refresh_transport(device)
        if refresh_transport != "ws_device_topic":
            return {
                "status": "unsupported",
                "reason_code": "refresh_unsupported",
                "refresh_request_id": None,
                "summary": summary,
            }

        if getattr(device, "status", None) != "online":
            return {
                "status": "offline",
                "reason_code": "refresh_offline",
                "refresh_request_id": None,
                "summary": summary,
            }

        refresh_request_id = f"cap_refresh_{uuid.uuid4().hex}"
        requested_at = timezone.now().isoformat()
        published = self._refresh_transport.publish_refresh_request_async(
            refresh_request_id=refresh_request_id,
            organization_id=str(space.organization_id),
            device_fingerprint=str(getattr(device, "fingerprint", "") or ""),
            payload={
                "space_id": str(space.id),
                "requested_by": requested_by,
                "requested_at": requested_at,
            },
        )
        if not published:
            return {
                "status": "failed",
                "reason_code": "refresh_failed",
                "refresh_request_id": refresh_request_id,
                "summary": summary,
            }

        return {
            "status": "pending",
            "reason_code": "refresh_initiated",
            "refresh_request_id": refresh_request_id,
            "summary": summary,
        }

    def request_space_refresh(
        self,
        *,
        space_id: str,
        requested_by: str = "manual",
        timeout_seconds: int = 12,
    ) -> Dict[str, Any]:
        """.. deprecated:: G-034 同步阻塞模式，耗尽 worker 线程。请使用 initiate_space_refresh()。"""
        warnings.warn(
            "request_space_refresh() is deprecated (G-034). Use initiate_space_refresh() instead.",
            DeprecationWarning,
            stacklevel=2,
        )
        space = self._get_space(space_id)
        binding = resolve_execution_binding(space=space)
        device = binding.device
        summary = self.get_space_summary(space_id)

        if device is None:
            return {
                "status": "unbound",
                "reason_code": "binding_missing",
                "refresh_request_id": None,
                "summary": summary,
            }

        refresh_transport = self._resolve_refresh_transport(device)
        if refresh_transport != "ws_device_topic":
            return {
                "status": "unsupported",
                "reason_code": "refresh_unsupported",
                "refresh_request_id": None,
                "summary": summary,
            }

        if getattr(device, "status", None) != "online":
            return {
                "status": "offline",
                "reason_code": "refresh_offline",
                "refresh_request_id": None,
                "summary": summary,
            }

        refresh_request_id = f"cap_refresh_{uuid.uuid4().hex}"
        requested_at = timezone.now().isoformat()
        published = self._refresh_transport.publish_refresh_request(
            refresh_request_id=refresh_request_id,
            organization_id=str(space.organization_id),
            device_fingerprint=str(getattr(device, "fingerprint", "") or ""),
            payload={
                "space_id": str(space.id),
                "requested_by": requested_by,
                "requested_at": requested_at,
            },
        )
        if not published:
            return {
                "status": "failed",
                "reason_code": "refresh_failed",
                "refresh_request_id": refresh_request_id,
                "summary": summary,
            }

        with warnings.catch_warnings():
            warnings.simplefilter("ignore", DeprecationWarning)
            ack = self._refresh_transport.wait_for_ack(refresh_request_id, timeout_seconds=min(timeout_seconds, 3))
        if ack is None:
            return {
                "status": "timeout",
                "reason_code": "refresh_timeout",
                "refresh_request_id": refresh_request_id,
                "summary": summary,
            }

        result_timeout = max(timeout_seconds - min(timeout_seconds, 3), 1)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", DeprecationWarning)
            result = self._refresh_transport.wait_for_result(refresh_request_id, timeout_seconds=result_timeout)
        if result is None:
            return {
                "status": "timeout",
                "reason_code": "refresh_timeout",
                "refresh_request_id": refresh_request_id,
                "ack": ack,
                "summary": summary,
            }

        refreshed_summary = self.get_space_summary(space_id)
        status = result.get("status") if isinstance(result.get("status"), str) else "accepted"
        return {
            "status": status,
            "reason_code": "refresh_supported" if status in {"accepted", "ok"} else "refresh_failed",
            "refresh_request_id": refresh_request_id,
            "ack": ack,
            "result": result,
            "summary": refreshed_summary,
        }

    def _get_space(self, space_id: str) -> Workspace:
        if not self.user:
            raise ServiceError("AUTH_REQUIRED", "认证失败", status=401)
        try:
            workspace = Workspace.objects.select_related("device").get(id=space_id)
        except Workspace.DoesNotExist as exc:
            raise ServiceError("NOT_FOUND", "Workspace 不存在", status=404) from exc
        if str(workspace.created_by_id) != str(self.user.id):
            raise ServiceError("PERMISSION_DENIED", "当前用户无权访问该 Workspace", status=403)
        return workspace

    @staticmethod
    def _read_device_snapshot(device) -> Optional[Dict[str, Any]]:
        if device is None:
            return None
        os_info = getattr(device, "os_info", None)
        if not isinstance(os_info, dict):
            return None
        runtime_info = os_info.get("runtime")
        if not isinstance(runtime_info, dict):
            return None
        raw_snapshot = runtime_info.get("host_runtime_snapshot")
        return normalize_host_runtime_snapshot(raw_snapshot, fallback_source=str(getattr(device, "device_type", "unknown") or "unknown"))

    @staticmethod
    def _resolve_refresh_transport(device) -> str:
        if device is None:
            return "unsupported"
        device_type = str(getattr(device, "device_type", "") or "")
        if device_type in _BACKEND_REFRESH_SUPPORTED_TYPES:
            return "ws_device_topic"
        if device_type == "electron":
            return "heartbeat_only"
        return "unsupported"

    @staticmethod
    def _build_freshness(device, snapshot: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        binding_reason_codes: list[str] = []
        reason_codes: list[str] = []
        stale_reason: Optional[str] = None

        if device is None:
            binding_reason_codes.append("space_unbound")
            reason_codes.append("space_unbound")
            return {
                "observed_at": None,
                "freshness_state": "unknown",
                "stale_reason": "snapshot_missing",
                "reason_codes": reason_codes,
                "binding_reason_codes": binding_reason_codes,
            }

        status = str(getattr(device, "status", "") or "")
        if status == "offline":
            binding_reason_codes.append("device_offline")
            reason_codes.append("device_offline")
        elif status == "busy":
            binding_reason_codes.append("device_busy")
            reason_codes.append("device_busy")

        observed_at = None
        observed_dt = None
        if snapshot:
            observed_at = snapshot.get("reported_at") or None
            observed_dt = _parse_reported_at(observed_at)
            if observed_dt is None and getattr(device, "last_heartbeat_at", None):
                observed_dt = device.last_heartbeat_at
                observed_at = device.last_heartbeat_at.isoformat()
            version = snapshot.get("version")
            if isinstance(version, int) and version > CAPABILITY_DISCOVERY_SNAPSHOT_VERSION:
                reason_codes.append("unsupported_version")
        else:
            reason_codes.append("snapshot_missing")
            stale_reason = "snapshot_missing"

        if observed_dt is None and getattr(device, "last_heartbeat_at", None):
            observed_dt = device.last_heartbeat_at
            observed_at = device.last_heartbeat_at.isoformat()

        if status == "offline":
            freshness_state = "expired"
            stale_reason = stale_reason or "device_offline"
        elif snapshot is None:
            freshness_state = "unknown"
        elif observed_dt is None:
            freshness_state = "unknown"
            stale_reason = stale_reason or "snapshot_missing"
        else:
            age = timezone.now() - observed_dt
            if age <= _FRESH_WINDOW:
                freshness_state = "fresh"
            elif age <= _STALE_WINDOW:
                freshness_state = "stale"
                stale_reason = "snapshot_stale"
                reason_codes.append("snapshot_stale")
            else:
                freshness_state = "expired"
                stale_reason = "snapshot_expired"
                reason_codes.append("snapshot_expired")

        if freshness_state == "fresh":
            reason_codes = [code for code in reason_codes if code not in {"snapshot_stale", "snapshot_expired"}]

        deduped_reason_codes: list[str] = []
        for code in reason_codes:
            if code not in deduped_reason_codes:
                deduped_reason_codes.append(code)

        deduped_binding_codes: list[str] = []
        for code in binding_reason_codes:
            if code not in deduped_binding_codes:
                deduped_binding_codes.append(code)

        return {
            "observed_at": observed_at,
            "freshness_state": freshness_state,
            "stale_reason": stale_reason,
            "reason_codes": deduped_reason_codes,
            "binding_reason_codes": deduped_binding_codes,
        }


__all__ = ["CapabilityDiscoveryService"]
