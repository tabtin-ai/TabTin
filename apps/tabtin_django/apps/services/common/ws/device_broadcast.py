"""
Device status broadcast utilities.

Extracted from handlers/auth.py (R2-03) — these functions are cross-referenced
by 6+ modules and belong to "device broadcast infrastructure", not "WS auth".
"""

from __future__ import annotations

import logging

from .protocol import (
    CHANNEL_SAFE_PATTERN,
    DomainEvent,
    build_envelope,
    new_event_id,
)

logger = logging.getLogger(__name__)


def _serialize_device_for_broadcast(device, status: str) -> dict:
    """Extract broadcast-needed fields from Device inside sync context."""
    event_id = new_event_id()
    return {
        "event_id": event_id,
        "device_id": str(device.id),
        "user_id": str(device.user_id),
        "fingerprint": device.fingerprint,
        "name": device.name,
        "device_type": device.device_type,
        "role": getattr(device, "role", "control"),
        "status": status,
        "capabilities": device.capabilities or [],
        "organization_id": str(device.organization_id),
    }


async def _broadcast_device_status_async(data: dict) -> None:
    """G-044: 在 async 上下文中直接 await channel layer，不占用 DB 线程池。"""
    try:
        from channels.layers import get_channel_layer

        envelope = build_envelope(
            DomainEvent.DEVICE_STATUS,
            data["event_id"],
            {k: data[k] for k in (
                "device_id", "user_id", "fingerprint", "name",
                "device_type", "role", "status", "capabilities",
            )},
            event_id=data["event_id"],
            organization_id=data["organization_id"],
        )

        channel_layer = get_channel_layer()
        if channel_layer is None:
            return

        group_name = CHANNEL_SAFE_PATTERN.sub(".", f"user.{data['user_id']}")
        await channel_layer.group_send(
            group_name,
            {"type": "broadcast_message", "message": envelope},
        )
        logger.info("[DeviceBroadcast] 设备状态广播: %s -> %s (user=%s)", data["name"], data["status"], data["user_id"])
    except Exception as exc:
        logger.debug("[DeviceBroadcast] 设备状态广播失败: %s", exc)


async def _broadcast_device_unbound_async(data: dict) -> None:
    """广播 device.unbound 事件，通知旧设备已解绑。"""
    try:
        from channels.layers import get_channel_layer

        envelope = build_envelope(
            DomainEvent.DEVICE_UNBOUND,
            data["event_id"],
            {
                "device_id": data["device_id"],
                "agent_id": data["agent_id"],
                "organization_id": data["organization_id"],
            },
            event_id=data["event_id"],
            organization_id=data["organization_id"],
        )

        channel_layer = get_channel_layer()
        if channel_layer is None:
            return

        group_name = CHANNEL_SAFE_PATTERN.sub(".", f"user.{data['user_id']}")
        await channel_layer.group_send(
            group_name,
            {"type": "broadcast_message", "message": envelope},
        )
        logger.info(
            "[DeviceBroadcast] 设备解绑广播: device=%s agent=%s (user=%s)",
            data["device_id"], data["agent_id"], data["user_id"],
        )
    except Exception as exc:
        logger.warning("[DeviceBroadcast] 设备解绑广播失败: %s", exc)


def _broadcast_device_unbound(device, agent_id: str, organization_id: str) -> None:
    """广播 device.unbound 事件（sync 版本），供换绑场景调用。"""
    event_id = new_event_id()
    data = {
        "event_id": event_id,
        "device_id": str(device.id),
        "user_id": str(device.user_id),
        "agent_id": agent_id,
        "organization_id": organization_id,
    }
    try:
        from asgiref.sync import async_to_sync
        result = async_to_sync(_broadcast_device_unbound_async)(data)
        if hasattr(result, '__await__'):
            import asyncio
            asyncio.get_event_loop().run_until_complete(result)
    except Exception as exc:
        logger.warning("[DeviceBroadcast] 设备解绑广播失败: %s", exc)


def _broadcast_device_status(device, status: str) -> None:
    """G-044 兼容层：供 device_service、Celery、device_runtime 等 sync 调用方使用。

    这些路径在纯 sync 上下文（HTTP 请求、Celery 任务）中，使用 async_to_sync 包装
    _broadcast_device_status_async 不会造成 auth 路径中的 DB 线程池嵌套问题。
    """
    data = _serialize_device_for_broadcast(device, status)
    try:
        from asgiref.sync import async_to_sync
        result = async_to_sync(_broadcast_device_status_async)(data)
        if hasattr(result, '__await__'):
            import asyncio
            asyncio.get_event_loop().run_until_complete(result)
    except Exception as exc:
        logger.debug("[DeviceBroadcast] 设备状态广播失败: %s", exc)
