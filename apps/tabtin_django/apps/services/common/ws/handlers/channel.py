"""
Channel gateway handlers — inbound / outbound_ack / status.

Extracted from GatewayConsumer._handle_channel_*.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Dict

from pydantic import ValidationError

from apps.channel_gateway.schemas import (
    ChannelInboundMessage,
    ChannelOutboundAckMessage,
    ChannelStatusMessage,
)
from apps.channel_gateway.services.inbound_service import ChannelInboundService
from apps.channel_gateway.services.outbound_service import ChannelOutboundService
from apps.channel_gateway.services.runtime_status_service import ChannelRuntimeStatusService

from ..bus import publish_ws_event_async
from ..protocol import (
    ERROR_NOT_FOUND,
    ERROR_PERMISSION_DENIED,
    ERROR_SCHEMA_INVALID,
    build_envelope,
    new_event_id,
)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# channel.inbound
# ---------------------------------------------------------------------------

def create_channel_inbound_handler(consumer):
    """Factory: returns the channel.inbound handler."""

    async def handle_channel_inbound(envelope: Dict[str, Any]) -> None:
        request_id = envelope["request_id"]
        payload = envelope["payload"]

        if "channel.inbound" not in consumer.capabilities:
            await consumer._send_error(request_id, ERROR_PERMISSION_DENIED, "capability not allowed")
            return
        if consumer.role != "channel":
            await consumer._send_error(request_id, ERROR_PERMISSION_DENIED, "role not allowed")
            return

        try:
            data = ChannelInboundMessage(**payload)
        except ValidationError as exc:
            await consumer._send_error(request_id, ERROR_SCHEMA_INVALID, str(exc))
            return

        if data.type != envelope["type"]:
            await consumer._send_error(request_id, ERROR_SCHEMA_INVALID, "payload type mismatch")
            return

        if not data.organization_id:
            await consumer._send_error(request_id, ERROR_SCHEMA_INVALID, "missing organization_id in payload")
            return
        if not consumer.organization_ctx.is_member(data.organization_id):
            await consumer._send_error(request_id, ERROR_PERMISSION_DENIED, "organization mismatch")
            return

        event_id = new_event_id()
        event = build_envelope(
            "channel.inbound",
            event_id,
            data.model_dump(),
            event_id=event_id,
            organization_id=data.organization_id,
            session_id=data.session_id,
            thread_id=data.thread_id,
        )
        await publish_ws_event_async("channel.inbound", event)

        async def _process_inbound() -> None:
            try:
                await asyncio.to_thread(ChannelInboundService().handle_inbound, data)
            except Exception as exc:
                logger.warning("[WS] channel inbound process failed: %s", exc, exc_info=True)

        consumer._track_task(asyncio.create_task(_process_inbound()))

        response = build_envelope(
            "channel.inbound.ok",
            request_id,
            {"status": "ok"},
            organization_id=data.organization_id,
        )
        await consumer._send_envelope(response)

    return handle_channel_inbound


# ---------------------------------------------------------------------------
# channel.status
# ---------------------------------------------------------------------------

def create_channel_status_handler(consumer):
    """Factory: returns the channel.status handler."""

    async def handle_channel_status(envelope: Dict[str, Any]) -> None:
        request_id = envelope["request_id"]
        payload = envelope["payload"]

        if "channel.status" not in consumer.capabilities:
            await consumer._send_error(request_id, ERROR_PERMISSION_DENIED, "capability not allowed")
            return
        if consumer.role != "channel":
            await consumer._send_error(request_id, ERROR_PERMISSION_DENIED, "role not allowed")
            return

        try:
            data = ChannelStatusMessage(**payload)
        except ValidationError as exc:
            await consumer._send_error(request_id, ERROR_SCHEMA_INVALID, str(exc))
            return

        if data.type != envelope["type"]:
            await consumer._send_error(request_id, ERROR_SCHEMA_INVALID, "payload type mismatch")
            return

        if not data.organization_id:
            await consumer._send_error(request_id, ERROR_SCHEMA_INVALID, "missing organization_id in payload")
            return
        if not consumer.organization_ctx.is_member(data.organization_id):
            await consumer._send_error(request_id, ERROR_PERMISSION_DENIED, "organization mismatch")
            return

        event_id = new_event_id()
        event = build_envelope(
            "channel.status",
            event_id,
            data.model_dump(),
            event_id=event_id,
            organization_id=data.organization_id,
        )
        await publish_ws_event_async("channel.status", event)

        async def _persist_status() -> None:
            try:
                await asyncio.to_thread(ChannelRuntimeStatusService().upsert_from_status, data)
            except Exception as exc:
                logger.warning("[WS] channel status persist failed: %s", exc, exc_info=True)

        consumer._track_task(asyncio.create_task(_persist_status()))

        response = build_envelope(
            "channel.status.ok",
            request_id,
            {"status": "ok"},
            organization_id=data.organization_id,
        )
        await consumer._send_envelope(response)

    return handle_channel_status


# ---------------------------------------------------------------------------
# channel.outbound.ack
# ---------------------------------------------------------------------------

def create_channel_outbound_ack_handler(consumer):
    """Factory: returns the channel.outbound.ack handler."""

    async def handle_channel_outbound_ack(envelope: Dict[str, Any]) -> None:
        request_id = envelope["request_id"]
        payload = envelope["payload"]

        if "channel.outbound" not in consumer.capabilities:
            await consumer._send_error(request_id, ERROR_PERMISSION_DENIED, "capability not allowed")
            return
        if consumer.role != "channel":
            await consumer._send_error(request_id, ERROR_PERMISSION_DENIED, "role not allowed")
            return

        try:
            data = ChannelOutboundAckMessage(**payload)
        except ValidationError as exc:
            await consumer._send_error(request_id, ERROR_SCHEMA_INVALID, str(exc))
            return

        if data.type != envelope["type"]:
            await consumer._send_error(request_id, ERROR_SCHEMA_INVALID, "payload type mismatch")
            return

        if not data.organization_id:
            await consumer._send_error(request_id, ERROR_SCHEMA_INVALID, "missing organization_id in payload")
            return
        if not consumer.organization_ctx.is_member(data.organization_id):
            await consumer._send_error(request_id, ERROR_PERMISSION_DENIED, "organization mismatch")
            return

        try:
            record = await asyncio.to_thread(ChannelOutboundService().ack, data)
        except Exception as exc:
            logger.warning("[WS] channel.outbound.ack failed: %s", exc)
            await consumer._send_error(request_id, "OUTBOUND_ACK_ERROR", str(exc))
            return
        if not record:
            await consumer._send_error(request_id, ERROR_NOT_FOUND, "outbox record not found")
            return

        response = build_envelope(
            "channel.outbound.ack.ok",
            request_id,
            {"status": "ok", "outbox_id": str(record.id), "record_status": record.status},
            organization_id=data.organization_id,
        )
        await consumer._send_envelope(response)

    return handle_channel_outbound_ack
