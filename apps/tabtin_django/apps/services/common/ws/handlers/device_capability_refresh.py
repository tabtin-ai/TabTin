"""
device.capabilities.refresh.* handlers.

G-034: 在存储 ack/result 到 Redis（向后兼容 brpop 路径）的同时，
额外通过 channel_layer.group_send 广播到 organization topic，
前端直接订阅即可收到。

注意：WS 广播必须在 async handler 中用 await channel_layer.group_send，
不可在 sync 路径中调用 publish_ws_event（含 async_to_sync），
否则会在已有事件循环中嵌套调用导致死锁。
"""

from __future__ import annotations

import logging
from typing import Any, Dict, Optional, Tuple

from channels.db import database_sync_to_async

from ..protocol import (
    CHANNEL_SAFE_PATTERN,
    ERROR_PERMISSION_DENIED,
    ERROR_SCHEMA_INVALID,
    build_envelope,
)

logger = logging.getLogger(__name__)


def _store_and_build_response(
    consumer, envelope: Dict[str, Any], bucket: str,
) -> Tuple[Optional[Dict[str, Any]], Optional[Dict[str, Any]], Optional[str]]:
    """Sync: 存储 payload 到 Redis + 构建响应信封 + 构建广播信封。

    返回 (response_envelope, broadcast_envelope, broadcast_topic)。
    response 发给发送者，broadcast 发到 organization topic。
    """
    request_id = envelope["request_id"]
    payload = dict(envelope.get("payload") or {})

    if consumer.role not in ("daemon", "device_runtime"):
        return (
            build_envelope(
                "error", request_id,
                {"code": ERROR_PERMISSION_DENIED, "message": "role not allowed", "details": {}},
            ),
            None,
            None,
        )

    refresh_request_id = payload.get("refresh_request_id")
    if not isinstance(refresh_request_id, str) or not refresh_request_id:
        return (
            build_envelope(
                "error", request_id,
                {"code": ERROR_SCHEMA_INVALID, "message": "missing refresh_request_id", "details": {"field": "refresh_request_id"}},
            ),
            None,
            None,
        )

    from apps.tabtinspace.services.capability_refresh_transport import CapabilityRefreshTransport
    transport = CapabilityRefreshTransport()
    stored_payload = {
        "device_fingerprint": consumer.device_fingerprint,
        "user_id": consumer.user_id,
        **payload,
    }

    if bucket == "ack":
        transport.store_ack(refresh_request_id, stored_payload)
        ws_type = "device.capabilities.refresh.ack"
    else:
        transport.store_result(refresh_request_id, stored_payload)
        ws_type = "device.capabilities.refresh.result"

    ok_type = f"{ws_type}.ok"
    response = build_envelope(ok_type, request_id, {"refresh_request_id": refresh_request_id})

    fp = consumer.device_fingerprint
    organization_id = ""
    # Fast path（热路径）：Daemon / device_runtime / electron 在 auth 阶段已经
    # 把 bound organization_id 写入 OrganizationContext.primary_id（参见 handlers/auth.py
    # 的角色分流），这里直接从内存读，避免每次 ack/result 都查 Device 表。
    ctx = getattr(consumer, 'organization_ctx', None)
    if ctx is not None and ctx.primary_id:
        organization_id = str(ctx.primary_id)
    elif fp:
        # Fallback：理论上只在 auth 尚未设置 organization_ctx 时触发，写日志便于排查。
        try:
            from apps.tabtinspace.models import Device
            device_ws_id = Device.objects.filter(
                fingerprint=fp,
            ).values_list('organization_id', flat=True).first()
            if device_ws_id:
                organization_id = str(device_ws_id)
                logger.warning(
                    "[device_capability_refresh] organization_ctx missing, fallback "
                    "to DB lookup (fingerprint=%s bucket=%s organization=%s)",
                    fp, bucket, organization_id,
                )
            else:
                logger.warning(
                    "[device_capability_refresh] Device.organization_id missing "
                    "(fingerprint=%s bucket=%s) — broadcast skipped",
                    fp, bucket,
                )
        except Exception as exc:
            logger.warning(
                "[device_capability_refresh] failed to resolve organization for "
                "fingerprint=%s bucket=%s: %s — broadcast skipped",
                fp, bucket, exc,
            )
    broadcast_envelope = None
    broadcast_topic = None
    if organization_id:
        broadcast_envelope = build_envelope(
            ws_type, request_id,
            {
                "refresh_request_id": refresh_request_id,
                "device_fingerprint": consumer.device_fingerprint,
                **payload,
            },
            organization_id=organization_id,
        )
        broadcast_topic = f"device.capabilities.refresh.{organization_id}"

    return response, broadcast_envelope, broadcast_topic


async def _handle_refresh_envelope(consumer, envelope: Dict[str, Any], bucket: str) -> None:
    """Async handler: DB 存储（sync）+ WS 广播（async），避免嵌套事件循环。"""
    response, broadcast_envelope, broadcast_topic = await database_sync_to_async(
        _store_and_build_response
    )(consumer, envelope, bucket)

    if response:
        await consumer._send_envelope(response)

    if broadcast_envelope and broadcast_topic:
        def _buffer_append():
            try:
                from ..event_buffer import get_event_buffer
                return get_event_buffer().append_event(broadcast_topic, broadcast_envelope)
            except Exception:
                return None

        try:
            event_id = await database_sync_to_async(_buffer_append)()
            if event_id:
                broadcast_envelope["event_id"] = event_id
        except Exception:
            pass

        broadcast_envelope["_topic"] = broadcast_topic
        group_name = CHANNEL_SAFE_PATTERN.sub(".", f"topic.{broadcast_topic}")
        try:
            await consumer.channel_layer.group_send(
                group_name,
                {"type": "broadcast_message", "message": broadcast_envelope},
            )
        except Exception as exc:
            logger.warning(
                "[device_capability_refresh] broadcast to organization topic failed: %s", exc
            )


def create_device_capability_refresh_ack_handler(consumer):
    async def handle_ack(envelope: Dict[str, Any]) -> None:
        await _handle_refresh_envelope(consumer, envelope, "ack")

    return handle_ack


def create_device_capability_refresh_result_handler(consumer):
    async def handle_result(envelope: Dict[str, Any]) -> None:
        await _handle_refresh_envelope(consumer, envelope, "result")

    return handle_result


__all__ = [
    "create_device_capability_refresh_ack_handler",
    "create_device_capability_refresh_result_handler",
]
