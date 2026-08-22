"""
device.capabilities.report handler.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Dict

from channels.db import database_sync_to_async

from apps.tabtinspace.services.device_service import DeviceService

from ..protocol import (
    ERROR_NOT_FOUND,
    ERROR_PERMISSION_DENIED,
    ERROR_SCHEMA_INVALID,
    build_envelope,
)
from ..device_broadcast import _broadcast_device_status
from ..async_io import run_sync_io

logger = logging.getLogger(__name__)

_SYSTEM_INFO_MAX_BYTES = 64 * 1024  # 64 KB
_SYSTEM_INFO_MAX_DEPTH = 8
_SYSTEM_INFO_MAX_KEYS = 200


def _check_depth(obj: Any, max_depth: int, current: int = 0) -> bool:
    """Return True if obj depth <= max_depth."""
    if current > max_depth:
        return False
    if isinstance(obj, dict):
        return all(_check_depth(v, max_depth, current + 1) for v in obj.values())
    if isinstance(obj, list):
        return all(_check_depth(v, max_depth, current + 1) for v in obj)
    return True


def _count_keys(obj: Any) -> int:
    """Count total keys in nested dicts."""
    if isinstance(obj, dict):
        return len(obj) + sum(_count_keys(v) for v in obj.values())
    if isinstance(obj, list):
        return sum(_count_keys(v) for v in obj)
    return 0


def _validate_system_info(system_info: Dict[str, Any]) -> str | None:
    """G-082: 校验 system_info 大小/深度，返回错误信息或 None。"""
    try:
        raw = json.dumps(system_info, ensure_ascii=False)
    except (TypeError, ValueError):
        return "system_info not JSON-serializable"
    if len(raw.encode("utf-8")) > _SYSTEM_INFO_MAX_BYTES:
        return f"system_info too large (>{_SYSTEM_INFO_MAX_BYTES // 1024}KB)"
    if not _check_depth(system_info, _SYSTEM_INFO_MAX_DEPTH):
        return f"system_info too deep (>{_SYSTEM_INFO_MAX_DEPTH} levels)"
    if _count_keys(system_info) > _SYSTEM_INFO_MAX_KEYS:
        return f"system_info too many keys (>{_SYSTEM_INFO_MAX_KEYS})"
    return None


def create_device_capabilities_report_handler(consumer):
    async def handle_device_capabilities_report(envelope: Dict[str, Any]) -> None:
        request_id = envelope["request_id"]
        payload = dict(envelope.get("payload") or {})

        if consumer.role not in ("daemon", "device_runtime"):
            await consumer._send_error(request_id, ERROR_PERMISSION_DENIED, "role not allowed")
            return

        if not consumer.user or not consumer.device_fingerprint:
            await consumer._send_error(request_id, ERROR_SCHEMA_INVALID, "missing authenticated device")
            return

        capabilities = payload.get("capabilities")
        system_info = payload.get("system_info")
        status = payload.get("status")

        if capabilities is not None and not isinstance(capabilities, list):
            await consumer._send_error(request_id, ERROR_SCHEMA_INVALID, "invalid capabilities")
            return
        if system_info is not None and not isinstance(system_info, dict):
            await consumer._send_error(request_id, ERROR_SCHEMA_INVALID, "invalid system_info")
            return
        if system_info is not None:
            validation_error = _validate_system_info(system_info)
            if validation_error:
                logger.warning(
                    "[DeviceRuntime] system_info rejected (fp=%s): %s",
                    consumer.device_fingerprint, validation_error,
                )
                await consumer._send_error(request_id, ERROR_SCHEMA_INVALID, validation_error)
                return
        if status is not None and status not in {"online", "busy", "offline"}:
            await consumer._send_error(request_id, ERROR_SCHEMA_INVALID, "invalid status")
            return

        service = DeviceService(user=consumer.user)
        should_broadcast = False
        capabilities_changed = False

        if status == "offline":
            device = await database_sync_to_async(service.update_device_status)(
                consumer.device_fingerprint,
                "offline",
                user_id=consumer.user_id,
            )
            should_broadcast = bool(device and getattr(device, "_status_changed", True))

            # G-031: 主动上报 offline 时清理路由缓存，
            # 防止 is_device_ws_connected() 仍返回 True 导致 action 路由到已离线设备。
            # 条件删除：仅当缓存值属于当前连接时才删除，避免多窗口场景误删。
            if device:
                try:
                    from django.core.cache import cache as _cache
                    from ..bus import release_device_action_ready
                    fp = consumer.device_fingerprint
                    def _clear_routing_cache() -> None:
                        release_device_action_ready(
                            fp,
                            consumer.channel_name,
                            getattr(consumer, "_device_action_ready_generation", None),
                        )
                        for key in (f"daemon_channel:{fp}", f"runtime_channel:{fp}"):
                            if _cache.get(key) == consumer.channel_name:
                                _cache.delete(key)

                    await run_sync_io(_clear_routing_cache)
                except Exception as exc:
                    import logging
                    logging.getLogger(__name__).debug(
                        "[DeviceRuntime] offline routing cache cleanup failed (fp=%s): %s",
                        consumer.device_fingerprint, exc,
                    )
        else:
            device = await database_sync_to_async(service.heartbeat)(
                fingerprint=consumer.device_fingerprint,
                capabilities=capabilities,
                system_info=system_info,
            )
            capabilities_changed = bool(device and getattr(device, "_capabilities_changed", False))
            # 仅当前精确路由连接可续期；旧连接不能重建或覆盖新连接。
            if consumer.device_fingerprint:
                try:
                    from ..bus import renew_device_action_ready
                    generation = getattr(
                        consumer,
                        "_device_action_ready_generation",
                        None,
                    )
                    if generation is not None:
                        renewed_generation = await run_sync_io(
                            renew_device_action_ready,
                            consumer.device_fingerprint,
                            consumer.channel_name,
                            generation,
                        )
                        if renewed_generation is not None:
                            consumer._device_action_ready_generation = renewed_generation
                except Exception as exc:
                    logger.warning("[DeviceRuntime] heartbeat ready key refresh failed (fp=%s): %s", consumer.device_fingerprint, exc)
            if device and status == "busy":
                device = await database_sync_to_async(service.update_device_status)(
                    consumer.device_fingerprint,
                    "busy",
                    user_id=consumer.user_id,
                )
                if device is not None:
                    setattr(device, "_capabilities_changed", capabilities_changed)
                should_broadcast = bool(
                    device
                    and (
                        getattr(device, "_status_changed", True)
                        or capabilities_changed
                    )
                )
            else:
                should_broadcast = capabilities_changed

        if not device:
            await consumer._send_error(request_id, ERROR_NOT_FOUND, "device not found")
            return

        if should_broadcast and device.organization_id:
            await database_sync_to_async(_broadcast_device_status)(
                device,
                getattr(device, "status", "offline"),
            )

        response = build_envelope(
            "device.capabilities.report.ok",
            request_id,
            {
                "status": getattr(device, "status", "offline"),
                "capabilities": getattr(device, "capabilities", []) or [],
            },
            organization_id=str(device.organization_id) if getattr(device, "organization_id", None) else None,
        )
        await consumer._send_envelope(response)

    return handle_device_capabilities_report


__all__ = ["create_device_capabilities_report_handler"]
