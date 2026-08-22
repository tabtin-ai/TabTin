"""
Monitor event handler — agent.monitor.*.

Handles Monitor device events pushed by Electron/Daemon:
- agent.monitor.event      → stdout line → MonitorService.push_event
- agent.monitor.heartbeat  → alive ping  → MonitorService.update_heartbeat
- agent.monitor.stream_ended → process exited → MonitorService.mark_stream_ended
- agent.monitor.failed     → start/crash error → MonitorService.mark_device_disconnected
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any, Dict

from asgiref.sync import sync_to_async

from apps.services.common.agent_protocol.namespace import has_action_capability

if TYPE_CHECKING:
    from ..protocol import GatewayConsumerProtocol

logger = logging.getLogger(__name__)

MONITOR_EVENT_TYPES = frozenset({
    "agent.monitor.event",
    "agent.monitor.heartbeat",
    "agent.monitor.stream_ended",
    "agent.monitor.failed",
})


def _get_monitor_service():
    from apps.services.agent_engine.services.monitor_service import get_monitor_service
    return get_monitor_service()


def create_monitor_event_handler(consumer: "GatewayConsumerProtocol"):
    """Factory: returns the handler for all agent.monitor.* events."""

    async def handle_monitor_event(envelope: Dict[str, Any]) -> None:
        if not has_action_capability(consumer.capabilities):
            return
        if consumer.role not in ("electron", "daemon", "device_runtime"):
            return
        if not getattr(consumer, "device_identity_verified", False):
            return

        payload = envelope.get("payload") or {}
        event_type = envelope.get("type") or payload.get("type", "")
        monitor_id = payload.get("monitor_id")

        if not monitor_id:
            logger.warning("[MonitorHandler] Missing monitor_id in %s", event_type)
            return

        svc = _get_monitor_service()

        try:
            if event_type == "agent.monitor.event":
                thread_id = payload.get("thread_id") or envelope.get("thread_id")
                if not thread_id:
                    task = await sync_to_async(svc.get_monitor)(monitor_id)
                    thread_id = task["thread_id"] if task else None
                if thread_id:
                    await sync_to_async(svc.push_event)(thread_id, payload)

            elif event_type == "agent.monitor.heartbeat":
                await sync_to_async(svc.update_heartbeat)(monitor_id)

            elif event_type == "agent.monitor.stream_ended":
                exit_code = payload.get("exit_code")
                await sync_to_async(svc.mark_stream_ended)(
                    monitor_id, exit_code=exit_code,
                )
                task = await sync_to_async(svc.get_monitor)(monitor_id)
                if task:
                    await sync_to_async(svc.push_event)(task["thread_id"], {
                        "type": "monitor_notification",
                        "monitor_id": monitor_id,
                        "description": task.get("description", ""),
                        "status": "stream_ended",
                        "exit_code": exit_code,
                        "last_output": payload.get("last_output", ""),
                    })

            elif event_type == "agent.monitor.failed":
                reason = payload.get("reason", "unknown")
                await sync_to_async(svc.mark_device_disconnected)(monitor_id)
                task = await sync_to_async(svc.get_monitor)(monitor_id)
                if task:
                    await sync_to_async(svc.push_event)(task["thread_id"], {
                        "type": "monitor_notification",
                        "monitor_id": monitor_id,
                        "description": task.get("description", ""),
                        "status": "failed",
                        "reason": reason,
                    })

            else:
                logger.debug("[MonitorHandler] Unknown event type: %s", event_type)

        except Exception as exc:
            logger.error(
                "[MonitorHandler] Error processing %s for monitor %s: %s",
                event_type, monitor_id, exc, exc_info=True,
            )

    return handle_monitor_event
