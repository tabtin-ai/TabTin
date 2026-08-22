"""
HITL Approval handler — agent.action.approval_request / agent.action.approval_response.

Daemon sends approval_request when a command requires user approval.
Backend forwards it to the user's connected clients (Electron/Mobile).
User approves/denies, and the response is forwarded back to the Daemon.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Dict

from asgiref.sync import sync_to_async

from apps.services.common.agent_protocol.constants import AgentActionEvent as AAE
from apps.services.common.agent_protocol.namespace import has_action_capability, stream_topic
from apps.services.common.chat_stream_publisher import (
    _resolve_thread_organization_cached,
)
from apps.services.agent_engine.services.pending_interaction_service import (
    runtime_can_open_interaction,
    upsert_action_approval_interaction,
)
from apps.services.common.ws.bus import (
    publish_to_user_async,
    publish_ws_event_async,
)

from ..protocol import (
    ERROR_INTERNAL,
    ERROR_PERMISSION_DENIED,
    ERROR_SCHEMA_INVALID,
    build_envelope,
    new_event_id,
)
from ..async_io import run_sync_io

logger = logging.getLogger(__name__)

# G-039: 使用 threading.local 替代模块级全局单例，
# 避免多 ASGI worker 线程间共享同一实例导致 Redis 连接交叉污染。
import threading as _threading

_action_service_local = _threading.local()

APPROVAL_BUFFER_PREFIX = "agent:approval_buffer:"
APPROVAL_BUFFER_TTL = 150  # 需大于 daemon 侧 120s 审批超时 + 30s 缓冲余量

# PRD 05 v0.4 §7.2.2：用户在 ApprovalDialog 选择的"以后允许"档位
# 由前端以 `scope` 字段上报。legacy 入口会把它放进共享 HITL batch decision；
# 执行端据此处理"总是允许 / 本对话内允许"，不能由网关层吞掉。
#
# 白名单与 daemon.ts 的解析保持一致；非法 / 缺失值归为 'once' 表示仅本次允许，
# 不写入任何持久化白名单（fail-safe，宁可下次再问也不要错误地"总是允许"）。
ALLOWED_APPROVAL_SCOPES = frozenset({"once", "thread", "always"})


def _normalize_approval_scope(raw: Any) -> str:
    """规范化前端上报的 scope；非法或缺失时返回 'once'（最小授权 fail-safe）。

    严格字面量匹配（不做 lower / strip）——前端发什么后端收什么，避免某天有人
    "好心地"加一层宽容把 'ALWAYS'、' always ' 也接受，反而扩大攻击面。
    fallback 时记 warning 便于线上诊断"用户说总是允许没生效"的真实工单。
    """
    if isinstance(raw, str) and raw in ALLOWED_APPROVAL_SCOPES:
        return raw
    if raw is not None:
        logger.warning(
            "[Approval] Unknown approval scope %r (type=%s), normalized to 'once'",
            raw, type(raw).__name__,
        )
    return "once"


def _get_action_service():
    svc = getattr(_action_service_local, 'instance', None)
    if svc is None:
        from apps.services.agent_engine.services.frontend_action_service import FrontendActionService
        svc = FrontendActionService()
        _action_service_local.instance = svc
    return svc


def _is_project_thread(thread_id: str) -> bool:
    """判断旧 action approval 是否指向 Project 会话。

    v0.4 的 Project 审批必须走 ``agent.stream.approval_requested``，该路径会携带
    execution owner 元数据并在 ``localrt.user_response`` 做决议门控。旧
    ``agent.action.approval_*`` 既不脱敏也不校验 Project execution owner，因此
    只保留给个人会话兼容。查不到会话时维持旧行为，避免破坏非 ChatSession 的
    历史个人 runtime thread。若已进入会话查询但数据库异常，则按 Project
    风险处理并拒绝旧协议，避免故障窗口退化成越权通道。
    """
    try:
        from apps.chat.conversation.api._common import resolve_session_id_for_thread
        from apps.chat.conversation.models import ChatSession

        session_id = resolve_session_id_for_thread(thread_id)
        if not session_id:
            return False
        row = (
            ChatSession.objects
            .filter(id=session_id)
            .values_list("project_id")
            .first()
        )
        return bool(row and row[0])
    except Exception:
        logger.warning(
            "[Approval] project thread lookup failed: thread=%s",
            thread_id,
            exc_info=True,
        )
        return True


async def _is_project_thread_async(thread_id: str) -> bool:
    return await sync_to_async(_is_project_thread, thread_sensitive=False)(thread_id)


def _buffer_approval_response(device_fp: str, envelope: Dict[str, Any]) -> None:
    """Runtime 设备短暂掉线时缓冲 approval_response 到 Redis，重连后由 drain 拉取。"""
    try:
        svc = _get_action_service()
        key = f"{APPROVAL_BUFFER_PREFIX}{device_fp}"
        svc.redis_client.rpush(key, json.dumps(envelope))
        svc.redis_client.expire(key, APPROVAL_BUFFER_TTL)
        logger.info("[Approval] Buffered approval_response for offline runtime device: %s", device_fp)
    except Exception as exc:
        logger.debug("[Approval] Buffer failed: %s", exc)


def drain_buffered_approval_responses(device_fp: str) -> list:
    """Runtime 设备重连时拉取所有缓冲的 approval_response。"""
    try:
        svc = _get_action_service()
        key = f"{APPROVAL_BUFFER_PREFIX}{device_fp}"
        items = []
        while True:
            raw = svc.redis_client.lpop(key)
            if raw is None:
                break
            items.append(json.loads(raw))
        return items
    except Exception as exc:
        logger.debug("[Approval] Drain failed: %s", exc)
        return []


def create_approval_request_handler(consumer):
    """Handle approval_request from runtime device: forward to user's App/Electron."""

    async def handle_approval_request(envelope: Dict[str, Any]) -> None:
        request_id = envelope["request_id"]
        payload = dict(envelope["payload"])

        if not has_action_capability(consumer.capabilities):
            await consumer._send_error(request_id, ERROR_PERMISSION_DENIED, "capability not allowed")
            return
        if consumer.role not in ("daemon", "device_runtime"):
            await consumer._send_error(request_id, ERROR_PERMISSION_DENIED, "only runtime devices can request approval")
            return

        thread_id = envelope.get("thread_id") or payload.get("thread_id")
        approval_id = payload.get("approval_id")
        command = payload.get("command", "")

        if not thread_id or not approval_id:
            await consumer._send_error(request_id, ERROR_SCHEMA_INVALID, "missing thread_id or approval_id")
            return

        if await _is_project_thread_async(thread_id):
            logger.warning(
                "[Approval] rejected legacy approval_request for Project thread=%s",
                thread_id,
            )
            await consumer._send_error(
                request_id,
                ERROR_PERMISSION_DENIED,
                "legacy approval protocol is disabled for Project sessions",
            )
            return

        source_authorized = await sync_to_async(
            runtime_can_open_interaction,
            thread_sensitive=False,
        )(
            thread_id=thread_id,
            user_id=str(consumer.user_id or ""),
            source_device_fingerprint=str(consumer.device_fingerprint or ""),
        )
        if not source_authorized:
            await consumer._send_error(
                request_id,
                ERROR_PERMISSION_DENIED,
                "runtime is not authorized for this session",
            )
            return

        if consumer.device_fingerprint:
            await run_sync_io(
                lambda: _get_action_service().bind_action_device(
                    thread_id,
                    consumer.device_fingerprint,
                )
            )

        # Wave 5（P0 修）：approval envelope 必须携带 organization_id，否则前端
        # `useGlobalTaskMonitorStore.envelopeToTaskRecord` 强制要求 organization_id
        # 否则丢弃 → 跨 organization 审批通知整体不工作（PRD §4.6 第三行）。
        # 通过 thread → ChatSession.organization_id 反查（与 RunService 同模式）。
        # 找不到时回退到 consumer.organization_id，仍找不到则不带（前端会因为缺
        # organization_id 而无法落入跨 organization 任务记录，但 stream topic 的设备
        # 内通讯仍工作，主路径无影响）。
        resolved_organization_id = (
            await sync_to_async(_resolve_thread_organization_cached, thread_sensitive=False)(thread_id)
            or consumer.organization_id
        )
        approval_payload = {
            "approval_id": approval_id,
            "task_id": payload.get("task_id"),
            "command": command,
            "policy": payload.get("policy", {}),
        }
        if resolved_organization_id:
            approval_payload["organization_id"] = resolved_organization_id

        approval_event = build_envelope(
            AAE.APPROVAL_REQUEST,
            new_event_id(),
            approval_payload,
            thread_id=thread_id,
            organization_id=resolved_organization_id,
        )

        try:
            pending_interaction = await sync_to_async(upsert_action_approval_interaction, thread_sensitive=False)(
                thread_id=thread_id,
                approval_id=str(approval_id),
                payload={
                    **approval_payload,
                    "thread_id": thread_id,
                    "event_type": AAE.APPROVAL_REQUEST,
                },
                organization_id=resolved_organization_id,
                user_id=str(consumer.user_id or ""),
                source_device_fingerprint=consumer.device_fingerprint,
                publish=True,
            )
        except Exception:
            logger.warning(
                "[Approval] pending interaction upsert failed: thread=%s approval=%s",
                thread_id, approval_id, exc_info=True,
            )
            await consumer._send_error(
                request_id,
                ERROR_INTERNAL,
                "approval pending interaction unavailable",
            )
            return

        if pending_interaction is None:
            logger.warning(
                "[Approval] skip approval_request without pending interaction: thread=%s approval=%s",
                thread_id, approval_id,
            )
            await consumer._send_error(
                request_id,
                ERROR_INTERNAL,
                "approval pending interaction unavailable",
            )
            return

        if getattr(pending_interaction, "status", None) != "pending":
            logger.info(
                "[Approval] skip stale approval_request with terminal pending: thread=%s approval=%s status=%s",
                thread_id, approval_id, getattr(pending_interaction, "status", None),
            )
            response = build_envelope(
                AAE.APPROVAL_REQUEST_OK,
                request_id,
                {"status": "ok", "skipped": "terminal_pending"},
                thread_id=thread_id,
            )
            await consumer._send_envelope(response)
            return

        from apps.services.common.agent_protocol.namespace import action_topic
        topic = action_topic(thread_id)
        published = await publish_ws_event_async(topic, approval_event)
        stream_published = await publish_ws_event_async(
            stream_topic(thread_id),
            approval_event,
        )
        user_published = await publish_to_user_async(
            str(consumer.user_id or ""),
            approval_event,
        )

        logger.info(
            "[Approval] Forwarded approval request: approval_id=%s command=%s published=%s stream_published=%s user_published=%s",
            approval_id, command[:80], published, stream_published, user_published,
        )

        response = build_envelope(
            AAE.APPROVAL_REQUEST_OK,
            request_id,
            {"status": "ok"},
            thread_id=thread_id,
        )
        await consumer._send_envelope(response)

    return handle_approval_request


def create_approval_response_handler(consumer):
    """Adapt legacy approval_response onto the durable localrt HITL channel."""

    async def handle_approval_response(envelope: Dict[str, Any]) -> None:
        request_id = envelope["request_id"]
        payload = dict(envelope["payload"])

        if consumer.role not in ("electron", "mobile", "admin"):
            await consumer._send_error(request_id, ERROR_PERMISSION_DENIED, "role not allowed")
            return

        thread_id = envelope.get("thread_id") or payload.get("thread_id")
        approval_id = payload.get("approval_id")
        approved = payload.get("approved") is True
        # 拒绝场景也保留 scope，保持 batch decision 形状一致（执行端 deny 分支会忽略）。
        scope = _normalize_approval_scope(payload.get("scope"))

        if not thread_id or not approval_id:
            await consumer._send_error(request_id, ERROR_SCHEMA_INVALID, "missing thread_id or approval_id")
            return

        if await _is_project_thread_async(thread_id):
            logger.warning(
                "[Approval] rejected legacy approval_response for Project thread=%s user=%s",
                thread_id,
                consumer.user_id,
            )
            await consumer._send_error(
                request_id,
                ERROR_PERMISSION_DENIED,
                "legacy approval protocol is disabled for Project sessions",
            )
            return

        from .localrt_user_response import (
            LOCALRT_EVENT_TYPE,
            create_localrt_user_response_handler,
        )

        legacy_batch_response = {
            "batch_id": str(approval_id),
            "decisions": [{
                "request_id": str(approval_id),
                "tool_call_id": str(approval_id),
                "outcome": "allow" if approved else "deny",
                "scope": scope,
            }],
            "schema_version": 1,
        }
        delivered = await create_localrt_user_response_handler(
            consumer,
            response_ok_type=AAE.APPROVAL_RESPONSE_OK,
            response_nak_type=AAE.APPROVAL_RESPONSE_NAK,
        )(build_envelope(
            LOCALRT_EVENT_TYPE,
            request_id,
            {
                "request_id": str(approval_id),
                "response": legacy_batch_response,
            },
            thread_id=thread_id,
        ))
        if delivered is not True:
            return

        resolved_organization_id = (
            await sync_to_async(_resolve_thread_organization_cached, thread_sensitive=False)(thread_id)
            or consumer.organization_id
        )
        resolved_payload = {
            "approval_id": approval_id,
            "approved": approved,
            "scope": scope,
        }
        if resolved_organization_id:
            resolved_payload["organization_id"] = resolved_organization_id
        await publish_to_user_async(
            str(consumer.user_id or ""),
            build_envelope(
                AAE.APPROVAL_RESOLVED,
                new_event_id(),
                resolved_payload,
                thread_id=thread_id,
                organization_id=resolved_organization_id,
            ),
        )

        logger.info(
            "[Approval] Forwarded approval response: approval_id=%s approved=%s scope=%s",
            approval_id, approved, scope,
        )

    return handle_approval_response


__all__ = ["create_approval_request_handler", "create_approval_response_handler"]
