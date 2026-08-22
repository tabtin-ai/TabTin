"""
Action result handler — agent.action.result.

Extracted from GatewayConsumer._handle_action_result.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any, Dict, Optional

from asgiref.sync import sync_to_async

from apps.services.agent_engine.api.action_api import ActionResultSchema
from apps.services.common.agent_protocol.constants import AgentActionEvent as AAE
from apps.services.common.observability.trace import resolve_trace_for_external_event
from apps.services.common.agent_protocol.namespace import has_action_capability
from apps.services.agent_engine.utils.common.thread_id import (
    ACTION_RESULT_THREAD_PREFIXES,
    validate_thread_id_prefix,
)

from ..protocol import (
    ERROR_CONFLICT,
    ERROR_NOT_FOUND,
    ERROR_PERMISSION_DENIED,
    ERROR_SCHEMA_INVALID,
    build_envelope,
)
from ..async_io import run_sync_io

if TYPE_CHECKING:
    from ..protocol import GatewayConsumerProtocol

logger = logging.getLogger(__name__)

# G-039: 使用 threading.local 替代模块级全局单例，
# 避免多 ASGI worker 线程间共享同一实例导致 Redis 连接交叉污染。
import threading as _threading

_action_service_local = _threading.local()


def _get_action_service():
    svc = getattr(_action_service_local, 'instance', None)
    if svc is None:
        from apps.services.agent_engine.services.frontend_action_service import FrontendActionService
        svc = FrontendActionService()
        _action_service_local.instance = svc
    return svc


def _check_and_touch_action_device_sync(thread_id: str, fingerprint: str) -> Optional[str]:
    action_service = _get_action_service()
    bound_device = action_service.get_action_device(thread_id)
    if bound_device and bound_device != fingerprint:
        return bound_device
    action_service.touch_action_device(thread_id, fingerprint)
    return None


def _get_frozen_action_device_sync(thread_id: str) -> Optional[str]:
    from apps.services.agent_engine.services.prompt_forward_service import (
        PromptForwardService,
    )

    return PromptForwardService._get_frozen_target_device(thread_id)


def _check_task_dedup_sync(task_id: str) -> bool:
    from apps.services.agent_engine.services.action_transport_service import ActionTransportService

    return ActionTransportService().check_task_dedup(task_id)


def _clear_task_dedup_sync(task_id: str) -> None:
    from apps.services.agent_engine.services.action_transport_service import ActionTransportService

    ActionTransportService().clear_task_dedup(task_id)


def _store_result_sync(thread_id: str, task_id: str, result_data: Dict[str, Any]) -> None:
    _get_action_service().store_result(thread_id, task_id, result_data)


def create_action_result_handler(consumer: GatewayConsumerProtocol):
    """Factory: returns the action result handler."""

    async def handle_action_result(envelope: Dict[str, Any]) -> None:
        request_id = envelope["request_id"]
        payload = dict(envelope["payload"])

        if not has_action_capability(consumer.capabilities):
            await consumer._send_error(request_id, ERROR_PERMISSION_DENIED, "capability not allowed")
            return
        if consumer.role not in ("electron", "daemon", "device_runtime"):
            await consumer._send_error(request_id, ERROR_PERMISSION_DENIED, "role not allowed")
            return
        if not getattr(consumer, "device_identity_verified", False):
            await consumer._send_error(
                request_id,
                ERROR_PERMISSION_DENIED,
                "device identity is not verified",
            )
            return

        thread_id = envelope.get("thread_id") or payload.get("thread_id")
        if not thread_id:
            await consumer._send_error(request_id, ERROR_SCHEMA_INVALID, "missing thread_id")
            return

        thread_id_error = validate_thread_id_prefix(
            thread_id,
            allowed_prefixes=ACTION_RESULT_THREAD_PREFIXES,
        )
        if thread_id_error:
            await consumer._send_error(request_id, ERROR_SCHEMA_INVALID, thread_id_error)
            return

        task_id = payload.get("task_id")
        if not isinstance(task_id, str) or not task_id:
            await consumer._send_error(request_id, ERROR_SCHEMA_INVALID, "missing task_id")
            return

        if consumer.device_fingerprint:
            try:
                frozen_device = await run_sync_io(
                    _get_frozen_action_device_sync,
                    thread_id,
                )
            except Exception:
                logger.warning(
                    "[ActionResult] frozen target lookup failed: thread=%s",
                    thread_id,
                    exc_info=True,
                )
                await consumer._send_error(
                    request_id,
                    ERROR_PERMISSION_DENIED,
                    "unable to verify target device",
                )
                return

            mismatched_device = (
                frozen_device
                if frozen_device and frozen_device != consumer.device_fingerprint
                else None
            )
            if not frozen_device:
                mismatched_device = await run_sync_io(
                    _check_and_touch_action_device_sync,
                    thread_id,
                    consumer.device_fingerprint,
                )
            if mismatched_device:
                await consumer._send_error(request_id, ERROR_PERMISSION_DENIED, "device mismatch")
                return

        if not await run_sync_io(_check_task_dedup_sync, task_id):
            logger.warning(
                "[ActionResult] duplicate result suppressed: thread=%s task=%s fp=%s",
                thread_id, task_id, consumer.device_fingerprint,
            )
            response = build_envelope(
                AAE.RESULT_OK,
                request_id,
                {"status": "ok", "message": "duplicate result ignored"},
                thread_id=thread_id,
            )
            await consumer._send_envelope(response)
            return

        result_payload = {k: v for k, v in payload.items() if k not in {"task_id", "thread_id"}}
        try:
            data = ActionResultSchema(**result_payload)
        except Exception as exc:
            await consumer._send_error(request_id, ERROR_SCHEMA_INVALID, str(exc))
            return

        result_data = {
            'success': data.success,
            'error': data.error or None,
            'error_code': data.error_code or None,
        }

        # TRP-013: 浏览器专有字段仅在有实际值时写入，避免污染 Android 设备结果
        if data.clean_html:
            result_data['clean_html'] = data.clean_html
        if data.skeleton_html:
            result_data['skeleton_html'] = data.skeleton_html
        if data.title:
            result_data['title'] = data.title
        if data.url:
            result_data['url'] = data.url
        if data.content_length is not None:
            result_data['content_length'] = data.content_length

        if hasattr(data, 'data') and data.data is not None:
            result_data['data'] = data.data

        if data.executed_actions is not None:
            result_data['executed_actions'] = data.executed_actions
        if data.frontend_execution_time_ms is not None:
            result_data['frontend_execution_time_ms'] = data.frontend_execution_time_ms
        if data.page_url is not None:
            result_data['page_url'] = data.page_url
        if data.page_title is not None:
            result_data['page_title'] = data.page_title
        if data.snapshot is not None:
            result_data['snapshot'] = data.snapshot
        if data.diff is not None:
            result_data['diff'] = data.diff
        if data.screenshot_base64 is not None:
            result_data['screenshot_base64'] = data.screenshot_base64
        if data.observed_elements is not None:
            result_data['observed_elements'] = data.observed_elements
        if data.truncated is not None:
            result_data['_truncated'] = data.truncated

        try:
            await run_sync_io(_store_result_sync, thread_id, task_id, result_data)
        except Exception as exc:
            await run_sync_io(_clear_task_dedup_sync, task_id)
            logger.error(
                "[ActionResult] store_result failed: thread=%s task=%s error=%s",
                thread_id, task_id, exc, exc_info=True,
            )
            await consumer._send_error(request_id, ERROR_CONFLICT, f"store_result failed: {exc}")
            return

        try:
            _, resolve_error = await sync_to_async(resolve_trace_for_external_event)(
                thread_id=thread_id,
                trace_id=data.trace_id,
            )
            if resolve_error:
                if data.trace_id:
                    if resolve_error == "trace_not_found":
                        await consumer._send_error(request_id, ERROR_NOT_FOUND, "trace_id not found")
                        return
                    if resolve_error == "trace_thread_mismatch":
                        await consumer._send_error(request_id, ERROR_CONFLICT, "trace_id does not belong to thread_id")
                        return
                if resolve_error == "multiple_running_traces":
                    await consumer._send_error(request_id, ERROR_CONFLICT, "multiple running traces, trace_id required")
                    return
                if resolve_error == "no_running_trace":
                    await consumer._send_error(request_id, ERROR_CONFLICT, "no running trace for thread_id")
                    return
        except Exception:
            logger.warning(
                "[ActionResult] resolve_trace_for_external_event failed: thread=%s trace=%s",
                thread_id, data.trace_id, exc_info=True,
            )

        logger.debug(
            "[ActionResult] WS 收到前端结果  thread=%s  task=%s  success=%s  fe_time=%sms",
            thread_id, task_id, data.success,
            data.frontend_execution_time_ms,
        )

        response = build_envelope(
            AAE.RESULT_OK,
            request_id,
            {"status": "ok", "message": "结果已接收"},
            thread_id=thread_id,
            trace_id=data.trace_id,
        )
        await consumer._send_envelope(response)

    return handle_action_result
