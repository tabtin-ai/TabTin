"""
Git handlers — git.status.report / git.diff.request / git.diff.response.

Phase 2: Receives real-time git status from Daemon after tool execution.
Phase 4: Relays on-demand diff requests between frontend and Daemon.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any, Dict

from channels.db import database_sync_to_async
from channels.layers import get_channel_layer
from django.core.cache import cache as django_cache

from ..protocol import (
    ERROR_INTERNAL,
    ERROR_NOT_FOUND,
    ERROR_PERMISSION_DENIED,
    ERROR_SCHEMA_INVALID,
    build_envelope,
)
from ..async_io import run_sync_io

if TYPE_CHECKING:
    from ..protocol import GatewayConsumerProtocol

logger = logging.getLogger(__name__)


def create_git_status_report_handler(consumer: GatewayConsumerProtocol):
    """Factory: returns the git.status.report handler bound to *consumer*."""

    async def handle_git_status_report(envelope: Dict[str, Any]) -> None:
        request_id = envelope["request_id"]
        payload = envelope.get("payload", {})

        if consumer.role not in ("daemon", "device_runtime"):
            await consumer._send_error(
                request_id, ERROR_PERMISSION_DENIED, "only runtime device can report git status"
            )
            return

        if not consumer.device_fingerprint:
            await consumer._send_error(
                request_id, ERROR_SCHEMA_INVALID, "missing device_id"
            )
            return

        if not consumer.user_id:
            await consumer._send_error(
                request_id, ERROR_PERMISSION_DENIED, "user not authenticated"
            )
            return

        git_status = payload.get("git_status")
        if not git_status or not isinstance(git_status, dict):
            await consumer._send_error(
                request_id, ERROR_SCHEMA_INVALID, "missing or invalid git_status"
            )
            return

        device = await _lookup_device(consumer.device_fingerprint, consumer.user_id)
        if not device:
            await consumer._send_error(
                request_id, ERROR_NOT_FOUND, "device not found"
            )
            return

        try:
            await _sync_git_status(device, git_status)
        except Exception as exc:
            logger.warning("[git.status.report] sync failed (req=%s): %s", request_id, exc)

        response = build_envelope(
            "git.status.report.ok",
            request_id,
            {"status": "synced"},
        )
        await consumer._send_envelope(response)

    return handle_git_status_report


@database_sync_to_async
def _lookup_device(fingerprint: str, user_id: str):
    from apps.tabtinspace.models import Device
    try:
        return Device.objects.get(fingerprint=fingerprint, user_id=user_id)
    except Device.DoesNotExist:
        return None


@database_sync_to_async
def _sync_git_status(device, git_status: Dict[str, Any]) -> None:
    from apps.tabtinspace.services.device_service import DeviceService
    DeviceService()._sync_git_status_to_workspaces(device, git_status)


# ─── Phase 4: on-demand diff relay ───────────────────────────────────


_DIFF_RELAY_TTL = 25  # seconds — slightly above frontend's 20s request timeout


def create_git_diff_request_handler(consumer: GatewayConsumerProtocol):
    """Factory: handles git.diff.request from frontend → relays to Daemon."""

    async def handle_git_diff_request(envelope: Dict[str, Any]) -> None:
        request_id = envelope["request_id"]
        payload = envelope.get("payload", {})

        if consumer.role == "daemon":
            await consumer._send_error(
                request_id, ERROR_PERMISSION_DENIED, "daemon cannot request diff"
            )
            return

        space_id = payload.get("space_id")
        file_path = payload.get("file_path")
        staged = payload.get("staged", False)
        if not space_id or not file_path:
            await consumer._send_error(
                request_id, ERROR_SCHEMA_INVALID, "missing space_id or file_path"
            )
            return

        device_id = await _get_bound_device_fingerprint(space_id, consumer.organization_ctx)
        if not device_id:
            await consumer._send_error(
                request_id, ERROR_NOT_FOUND, "no online device bound to space"
            )
            return

        try:
            runtime_channel = await run_sync_io(
                lambda: (
                    django_cache.get(f"runtime_channel:{device_id}")
                    or django_cache.get(f"daemon_channel:{device_id}")
                )
            )
        except Exception as exc:
            logger.warning("[git.diff.request] cache read failed: %s", exc)
            await consumer._send_error(
                request_id, ERROR_INTERNAL, "relay service unavailable"
            )
            return

        if not runtime_channel:
            await consumer._send_error(
                request_id, ERROR_NOT_FOUND, "runtime device is not connected"
            )
            return

        try:
            await run_sync_io(
                django_cache.set,
                f"diff_relay:{request_id}",
                consumer.channel_name,
                timeout=_DIFF_RELAY_TTL,
            )
        except Exception as exc:
            logger.warning("[git.diff.request] cache write failed: %s", exc)
            await consumer._send_error(
                request_id, ERROR_INTERNAL, "relay service unavailable"
            )
            return

        relay_envelope = build_envelope(
            "git.diff.request",
            request_id,
            {"file_path": file_path, "staged": staged, "reply_to": request_id},
        )

        channel_layer = get_channel_layer()
        await channel_layer.send(runtime_channel, {
            "type": "relay.message",
            "message": relay_envelope,
        })

    return handle_git_diff_request


def create_git_diff_response_handler(consumer: GatewayConsumerProtocol):
    """Factory: handles git.diff.response from Daemon → relays to frontend."""

    async def handle_git_diff_response(envelope: Dict[str, Any]) -> None:
        request_id = envelope["request_id"]
        payload = envelope.get("payload", {})

        if consumer.role not in ("daemon", "device_runtime"):
            await consumer._send_error(
                request_id, ERROR_PERMISSION_DENIED, "only runtime device can respond with diff"
            )
            return

        reply_to = payload.get("reply_to")
        if not reply_to:
            logger.warning("[git.diff.response] missing reply_to in payload (req=%s)", request_id)
            return

        try:
            frontend_channel = await run_sync_io(django_cache.get, f"diff_relay:{reply_to}")
        except Exception as exc:
            logger.warning("[git.diff.response] cache read failed: %s", exc)
            return
        if not frontend_channel:
            logger.debug("[git.diff.response] no relay target for %s (expired?)", reply_to)
            return

        try:
            await run_sync_io(django_cache.delete, f"diff_relay:{reply_to}")
        except Exception:
            pass

        response_envelope = build_envelope(
            "git.diff.request.ok",
            reply_to,
            {
                "file_path": payload.get("file_path", ""),
                "diff": payload.get("diff", ""),
            },
        )

        channel_layer = get_channel_layer()
        await channel_layer.send(frontend_channel, {
            "type": "relay.message",
            "message": response_envelope,
        })

        ok_envelope = build_envelope("git.diff.response.ok", request_id, {"status": "relayed"})
        await consumer._send_envelope(ok_envelope)

    return handle_git_diff_response


@database_sync_to_async
def _get_bound_device_fingerprint(space_id: str, organization_ctx):
    from apps.tabtinspace.models import Workspace
    from apps.tabtinspace.services.execution_binding import resolve_control_device
    try:
        space = Workspace.objects.select_related(
            "device",
        ).filter(
            id=space_id,
        ).only(
            "id", "organization_id", "device__fingerprint", "device__status",
        ).first()
        if not space or not organization_ctx.is_member(space.organization_id):
            return None
        device = resolve_control_device(space=space)
        if device and getattr(device, "status", None) == "online":
            return getattr(device, "fingerprint", None)
    except Exception as exc:
        logger.debug("[git.diff] device lookup failed (space=%s): %s", space_id, exc)
    return None
