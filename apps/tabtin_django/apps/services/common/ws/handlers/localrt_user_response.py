"""
localrt.user_response handler — 本地 Runtime HITL 回传通道。

前端用户对 Daemon 本地 Runtime 发出的 ``approval_requested`` /
``ask_user_required`` / ``ask_form_required`` / ``request_approval_required``
做出决策后，通过此 handler 经 Django 转发到 Daemon（Wave 5 ask_question
拆三件套后统一替代旧 ``ask_user_required`` 命名）。

通道路径：
  Frontend (mobile/web) → WS localrt.user_response → Django → device topic → Runtime
  → localrt.user_response.delivery → Django → Frontend OK/NAK
  → 按协议形态分流（v0.4 W1.5 / W6）：
     - approval batch（response.batch_id 存在）→ DaemonAgentHost.handleSubmitHitlBatch
     - ask 单 request（ask_user / ask_form）    → DaemonAgentHost.handleSubmitAskUserResponse

设计上对齐 approval.py 的回传模式：
  - 先按 HITL request/batch owner 精准解析 runtime 设备 fingerprint
  - 发布到 device action topic
  - 等 runtime delivery ack 后才向前端返回 localrt.user_response.ok
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from typing import Any, Dict, Optional

from asgiref.sync import sync_to_async

from apps.services.common.agent_protocol.constants import AgentStreamEvent
from apps.services.common.agent_protocol.namespace import (
    has_action_capability,
    stream_event_type,
    stream_topic,
)
from apps.services.common.ws.bus import (
    publish_device_ws_event_exact,
    publish_ws_event,
    publish_ws_event_async,
    publish_ws_event_reliable,
)

from ..protocol import (
    ERROR_INTERNAL,
    ERROR_PERMISSION_DENIED,
    ERROR_SCHEMA_INVALID,
    build_envelope,
    new_event_id,
)
from ..async_io import run_sync_io

LOCALRT_RESPONSE_NAK = "localrt.user_response.nak"

logger = logging.getLogger(__name__)

LOCALRT_EVENT_TYPE = "localrt.user_response"
LOCALRT_RESPONSE_OK = "localrt.user_response.ok"
LOCALRT_DELIVERY_EVENT_TYPE = "localrt.user_response.delivery"
LOCALRT_DELIVERY_RESPONSE_OK = "localrt.user_response.delivery.ok"

LOCALRT_BUFFER_PREFIX = "localrt:user_response_buffer:"
LOCALRT_BUFFER_TTL = 400  # 大于 DaemonAgentHost 的 6min 超时 + 余量

LOCALRT_CONSUMED_PREFIX = "localrt:consumed:"
LOCALRT_CONSUMED_TTL = 600  # 10 分钟内防止重复提交
LOCALRT_INFLIGHT_PREFIX = "localrt:inflight:"
LOCALRT_INFLIGHT_TTL = 15

LOCALRT_PENDING_OWNER_PREFIX = "localrt:pending_owner:"
LOCALRT_PENDING_OWNER_TTL = 24 * 60 * 60 + 600

LOCALRT_DELIVERY_ACK_PREFIX = "localrt:delivery_ack:"
LOCALRT_DELIVERY_ACK_TTL = 60
LOCALRT_DELIVERY_WAIT_TIMEOUT_SECONDS = 8.0
LOCALRT_DELIVERY_WAIT_INTERVAL_SECONDS = 0.05

import threading as _threading

_action_service_local = _threading.local()


def _get_action_service():
    svc = getattr(_action_service_local, "instance", None)
    if svc is None:
        from apps.services.agent_engine.services.frontend_action_service import FrontendActionService
        svc = FrontendActionService()
        _action_service_local.instance = svc
    return svc


def _get_session_for_thread(thread_id: str):
    """thread_id → ChatSession（供 host / 执行主人解析共用）。"""
    try:
        from apps.chat.conversation.models import ChatSession

        if thread_id.startswith("chat-session-"):
            session_id = thread_id[len("chat-session-"):]
            try:
                uuid.UUID(session_id)
            except (TypeError, ValueError):
                return None
            return ChatSession.objects.filter(id=session_id).first()
        return ChatSession.objects.filter(thread_id=thread_id).first()
    except Exception:
        logger.debug("[LocalRT] _get_session_for_thread failed: thread=%s", thread_id, exc_info=True)
        return None


def _get_space_for_thread(thread_id: str):
    """thread_id → ChatSession → Space（与 FrontendActionService._query_daemon_info 同路径）。"""
    try:
        session = _get_session_for_thread(thread_id)
        host_id = getattr(session, "workspace_id", None)
        if session and host_id:
            from apps.tabtinspace.services.host_resolver import resolve_host
            return resolve_host(host_id)
    except Exception:
        logger.debug("[LocalRT] _get_space_for_thread failed: thread=%s", thread_id, exc_info=True)
    return None


def _get_frozen_runtime_device_fp(thread_id: str) -> Optional[str]:
    session = _get_session_for_thread(thread_id)
    target = getattr(session, "target_device_installation_id", "")
    return target.strip() if isinstance(target, str) and target.strip() else None


def _thread_binding_keys(thread_id: str) -> list[str]:
    value = str(thread_id or "").strip()
    if not value:
        return []
    if value.startswith("chat-session-"):
        raw = value[len("chat-session-"):]
        return [value, raw] if raw else [value]
    return [value, f"chat-session-{value}"]


def _resolve_runtime_device_fp(thread_id: str) -> Optional[str]:
    """解析 HITL 回传目标 runtime 设备 fingerprint。

    优先级对齐 ``PromptForwardService._route_to_device``：
      1. Redis 热绑定 ``get_action_device(thread_id)``
      2. thread → space → control/daemon device（``_resolve_daemon_fingerprint``）
      3. Agent 显式绑定的 online/busy Electron（``_resolve_electron_control_fingerprint``）

    ：不再回退到「同 organization 任意 online Electron」。
    """
    frozen = _get_frozen_runtime_device_fp(thread_id)
    if frozen:
        return frozen

    svc = _get_action_service()

    for binding_key in _thread_binding_keys(thread_id):
        bound = svc.get_action_device(binding_key)
        if bound:
            return bound

    daemon_fp = svc._resolve_daemon_fingerprint(thread_id)
    if daemon_fp:
        return daemon_fp

    space = _get_space_for_thread(thread_id)
    if space is not None:
        from apps.services.agent_engine.services.prompt_forward_service import PromptForwardService
        from apps.services.common.ws.bus import is_device_ws_connected

        agent_id = getattr(space, "agent_id", None)
        session = _get_session_for_thread(thread_id)
        owner_user_id = str(getattr(session, "user_id", "") or "") or None
        # Mirror PromptForwardService：显式 Electron + user+device 归属。
        electron_fp = PromptForwardService._resolve_electron_control_fingerprint(
            space,
            agent_id=agent_id,
            execution_owner_user_id=owner_user_id,
        )
        if electron_fp and is_device_ws_connected(electron_fp):
            logger.info(
                "[LocalRT] Resolved Electron control device for thread=%s fp=%s",
                thread_id, electron_fp,
            )
            return electron_fp

    return None


def _normalize_target_key(kind: str, target_id: str) -> str:
    prefix = "batch" if kind == "batch" else "request"
    return f"{prefix}:{target_id}"


def _pending_owner_key(kind: str, target_id: str) -> str:
    return f"{LOCALRT_PENDING_OWNER_PREFIX}{_normalize_target_key(kind, target_id)}"


def _normalize_thread_key(thread_id: Any) -> str:
    if not isinstance(thread_id, str):
        return ""
    value = thread_id.strip()
    if not value:
        return ""
    if value.startswith("chat-session-"):
        return value
    return f"chat-session-{value}"


def _delivery_ack_key(submit_id: str) -> str:
    return f"{LOCALRT_DELIVERY_ACK_PREFIX}{submit_id}"


def _loads_json_value(raw: Any) -> Optional[Dict[str, Any]]:
    if raw is None:
        return None
    if isinstance(raw, bytes):
        raw = raw.decode("utf-8", errors="replace")
    if not isinstance(raw, str):
        return None
    try:
        value = json.loads(raw)
    except Exception:
        return None
    return value if isinstance(value, dict) else None


def record_pending_owner(
    *,
    thread_id: str,
    target_id: str,
    device_fingerprint: str,
    kind: str,
    ttl: int = LOCALRT_PENDING_OWNER_TTL,
) -> None:
    """记录某个 HITL pending resolver 由哪个 runtime 设备持有。

    relay_events 是 runtime → Django 的源头；该连接上的 device_fingerprint
    就是后续用户提交时必须精准路由的目标。
    """
    if not thread_id or not target_id or not device_fingerprint:
        return
    normalized_kind = "batch" if kind == "batch" else "request"
    try:
        svc = _get_action_service()
        payload = {
            "thread_id": thread_id,
            "device_fingerprint": device_fingerprint,
            "kind": normalized_kind,
            "target_id": target_id,
        }
        svc.redis_client.set(
            _pending_owner_key(normalized_kind, target_id),
            json.dumps(payload),
            ex=ttl,
        )
        logger.info(
            "[LocalRT] Recorded pending owner: %s=%s thread=%s device=%s",
            normalized_kind, target_id, thread_id, device_fingerprint,
        )
    except Exception:
        logger.debug(
            "[LocalRT] record_pending_owner failed: kind=%s target=%s thread=%s",
            kind, target_id, thread_id, exc_info=True,
        )


def _get_pending_owner(kind: str, target_id: str) -> Optional[Dict[str, Any]]:
    try:
        svc = _get_action_service()
        return _loads_json_value(svc.redis_client.get(_pending_owner_key(kind, target_id)))
    except Exception:
        logger.debug("[LocalRT] get pending owner failed: kind=%s target=%s", kind, target_id, exc_info=True)
        return None


def _can_user_resolve_tool_approval(thread_id: str, batch_id: str, user_id: str) -> bool:
    from apps.services.agent_engine.services.pending_interaction_service import (
        can_resolve_pending_interaction,
    )

    return can_resolve_pending_interaction(
        thread_id=thread_id,
        request_key=batch_id,
        user_id=user_id,
        kinds=("tool_approval",),
    )


async def _can_user_resolve_tool_approval_async(thread_id: str, batch_id: str, user_id: str) -> bool:
    return await sync_to_async(_can_user_resolve_tool_approval, thread_sensitive=False)(
        thread_id,
        batch_id,
        user_id,
    )


def _can_user_resolve_single_hitl(thread_id: str, request_id: str, user_id: str) -> bool:
    from apps.services.agent_engine.services.pending_interaction_service import (
        SINGLE_HITL_INTERACTION_KINDS,
        can_resolve_pending_interaction,
    )

    return can_resolve_pending_interaction(
        thread_id=thread_id,
        request_key=request_id,
        user_id=user_id,
        kinds=SINGLE_HITL_INTERACTION_KINDS,
    )


async def _can_user_resolve_single_hitl_async(thread_id: str, request_id: str, user_id: str) -> bool:
    return await sync_to_async(_can_user_resolve_single_hitl, thread_sensitive=False)(
        thread_id,
        request_id,
        user_id,
    )


def _with_server_approver_identity(response_obj: Dict[str, Any], user_id: str) -> Dict[str, Any]:
    decisions = response_obj.get("decisions")
    if not isinstance(decisions, list):
        return response_obj

    approver_identity = {
        "user_id": str(user_id),
        "client_info": "Django WS localrt.user_response",
        "timestamp": int(time.time() * 1000),
    }
    return {
        **response_obj,
        "decisions": [
            {
                **decision,
                "approver_identity": approver_identity,
            } if isinstance(decision, dict) else decision
            for decision in decisions
        ],
    }


def _resolve_runtime_device_fp_for_hitl(
    thread_id: str,
    *,
    kind: str,
    target_id: str,
) -> Optional[str]:
    frozen = _get_frozen_runtime_device_fp(thread_id)
    owner = _get_pending_owner(kind, target_id)
    if owner:
        owner_thread = owner.get("thread_id")
        owner_fp = owner.get("device_fingerprint")
        if (
            _normalize_thread_key(owner_thread) == _normalize_thread_key(thread_id)
            and isinstance(owner_fp, str)
            and owner_fp
        ):
            if not frozen or owner_fp == frozen:
                return owner_fp
        logger.warning(
            "[LocalRT] Pending owner ignored due to mismatch: kind=%s target=%s "
            "submit_thread=%s owner_thread=%s owner_fp=%s",
            kind, target_id, thread_id, owner_thread, owner_fp,
        )

    if frozen:
        return frozen
    return _resolve_runtime_device_fp(thread_id)


async def _resolve_runtime_device_fp_for_hitl_async(
    thread_id: str,
    *,
    kind: str,
    target_id: str,
) -> Optional[str]:
    return await sync_to_async(_resolve_runtime_device_fp_for_hitl, thread_sensitive=False)(
        thread_id,
        kind=kind,
        target_id=target_id,
    )


async def _wait_for_delivery_ack(submit_id: str) -> Dict[str, Any]:
    deadline = asyncio.get_running_loop().time() + LOCALRT_DELIVERY_WAIT_TIMEOUT_SECONDS
    key = _delivery_ack_key(submit_id)

    def _poll_ack_once() -> Optional[Dict[str, Any]]:
        svc = _get_action_service()
        ack = _loads_json_value(svc.redis_client.get(key))
        if ack:
            try:
                svc.redis_client.delete(key)
            except Exception:
                pass
        return ack

    while True:
        ack = await run_sync_io(_poll_ack_once)
        if ack:
            return ack
        if asyncio.get_running_loop().time() >= deadline:
            return {
                "status": "delivery_timeout",
                "error_code": "delivery_timeout",
                "error_message": "Timed out waiting for runtime delivery acknowledgement",
                "retryable": True,
            }
        await asyncio.sleep(LOCALRT_DELIVERY_WAIT_INTERVAL_SECONDS)


def _build_nak(
    request_id: str,
    thread_id: str,
    *,
    error_code: str,
    error_message: str,
    retryable: bool,
    event_type: str = LOCALRT_RESPONSE_NAK,
) -> Dict[str, Any]:
    return build_envelope(
        event_type,
        request_id,
        {
            "error_code": error_code,
            "error_message": error_message,
            "retryable": retryable,
        },
        thread_id=thread_id,
    )


def _publish_approval_resolved_to_mirror(
    thread_id: str,
    response_obj: Dict[str, Any],
) -> None:
    """W2-轮 1（PRD §7.6.2 / §7.10）：approval batch 仲裁成功后给 thread topic
    publish 一条 ``approval_resolved``，让所有镜像端立即关闭 ApprovalPanel。

    走 reliable channel（与 chat_stream_publisher 一致）；接收方按 batch_id
    幂等处理"同事件可能到达两次"（一条来自本 publish + 一条来自 daemon →
    runtime → relay 转发）。

    payload 字段（与 wire ``ApprovalResolvedEvent.payload`` 对齐）：
        {
            "batch_id": str,
            "decisions": [...],
            "schema_version": 1
        }
    其中 ``decisions[].approver_identity`` 由客户端提交时携带，本服务原样透传。
    """
    batch_id = response_obj.get("batch_id")
    decisions = response_obj.get("decisions") or []
    if not batch_id or not isinstance(decisions, list) or not decisions:
        return

    payload: Dict[str, Any] = {
        "batch_id": str(batch_id),
        "decisions": decisions,
        "schema_version": int(response_obj.get("schema_version", 1) or 1),
    }

    try:
        from apps.services.agent_engine.services.pending_interaction_service import (
            mark_tool_approval_resolved_from_payload,
        )
        mark_tool_approval_resolved_from_payload(
            thread_id=thread_id,
            payload=payload,
            publish=True,
        )
    except Exception:
        logger.warning(
            "[LocalRT] pending interaction resolve failed: thread=%s batch=%s",
            thread_id, batch_id, exc_info=True,
        )

    full_event_type = stream_event_type(AgentStreamEvent.APPROVAL_RESOLVED)
    envelope = build_envelope(
        full_event_type,
        new_event_id(),
        payload,
        thread_id=thread_id,
    )
    topic = stream_topic(thread_id)

    # approval_resolved 是 _CRITICAL_EVENTS 之一（chat_stream_publisher.py:182），
    # 按对称语义走 reliable 通道。失败回落非 reliable。
    try:
        publish_ws_event_reliable(topic, envelope)
    except Exception:
        logger.warning(
            "[LocalRT] reliable publish approval_resolved failed, fallback non-reliable: thread=%s",
            thread_id, exc_info=True,
        )
        publish_ws_event(topic, envelope)


def _mark_single_hitl_pending_interaction(
    *,
    thread_id: str,
    request_id: str | None,
    response_obj: Dict[str, Any],
    status: str,
    reason: str | None = None,
) -> None:
    if not request_id:
        return
    result: Dict[str, Any] = {"request_id": request_id, "response": response_obj}
    if reason:
        result["reason"] = reason
    try:
        from apps.services.agent_engine.services.pending_interaction_service import (
            mark_single_hitl_resolved,
        )
        mark_single_hitl_resolved(
            thread_id=thread_id,
            request_id=request_id,
            result=result,
            status=status,
            publish=True,
        )
    except Exception:
        logger.warning(
            "[LocalRT] single HITL pending interaction %s failed: thread=%s request=%s",
            status, thread_id, request_id, exc_info=True,
        )


def _buffer_user_response(device_fp: str, envelope: Dict[str, Any]) -> None:
    """Daemon 短暂掉线时缓冲 user_response 到 Redis。"""
    try:
        svc = _get_action_service()
        key = f"{LOCALRT_BUFFER_PREFIX}{device_fp}"
        svc.redis_client.rpush(key, json.dumps(envelope))
        svc.redis_client.expire(key, LOCALRT_BUFFER_TTL)
        logger.info("[LocalRT] Buffered user_response for offline device: %s", device_fp)
    except Exception as exc:
        logger.debug("[LocalRT] Buffer failed: %s", exc)


def drain_buffered_user_responses(device_fp: str) -> list:
    """Daemon 重连时拉取所有缓冲的 user_response。"""
    try:
        svc = _get_action_service()
        key = f"{LOCALRT_BUFFER_PREFIX}{device_fp}"
        items = []
        while True:
            raw = svc.redis_client.lpop(key)
            if raw is None:
                break
            items.append(json.loads(raw))
        return items
    except Exception as exc:
        logger.debug("[LocalRT] Drain failed: %s", exc)
        return []


def _claim_user_response_delivery_sync(
    consumed_key: str,
    inflight_key: str,
    submit_id: str,
) -> str:
    svc = _get_action_service()
    if svc.redis_client.get(consumed_key):
        return "already_consumed"
    inflight_was_new = svc.redis_client.set(
        inflight_key,
        submit_id,
        nx=True,
        ex=LOCALRT_INFLIGHT_TTL,
    )
    return "ok" if inflight_was_new else "response_inflight"


def _delete_redis_key_sync(key: str) -> None:
    _get_action_service().redis_client.delete(key)


def _finalize_user_response_delivery_sync(consumed_key: str, inflight_key: str) -> None:
    svc = _get_action_service()
    svc.redis_client.set(consumed_key, "1", ex=LOCALRT_CONSUMED_TTL)
    svc.redis_client.delete(inflight_key)


def _persist_delivery_ack_sync(submit_id: str, ack_payload: Dict[str, Any]) -> None:
    _get_action_service().redis_client.set(
        _delivery_ack_key(submit_id),
        json.dumps(ack_payload),
        ex=LOCALRT_DELIVERY_ACK_TTL,
    )


def create_localrt_user_response_handler(
    consumer,
    *,
    response_ok_type: str = LOCALRT_RESPONSE_OK,
    response_nak_type: str = LOCALRT_RESPONSE_NAK,
):
    """
    Handle localrt.user_response from frontend: forward to Daemon.

    v0.4 W1.5（PRD §7.4 / §7.10）：按协议形态分流仲裁键——
      - approval batch（response.batch_id 存在）→ SETNX `localrt:consumed:batch:{batch_id}`
      - single ask_* request（ask_choice / ask_form 单条）→ SETNX `localrt:consumed:{request_id}`

    分流不是"兼容旧客户端"，而是 PRD 规定的两条独立协议路径（一条 batch、一条 single），
    各自在 Redis 上独立仲裁；任一端首发即生效（first-resolve），其它端收 NAK
    `already_consumed`（PRD §7.10.3）。
    """

    async def handle_localrt_user_response(envelope: Dict[str, Any]) -> Optional[bool]:
        request_id = envelope["request_id"]
        payload = dict(envelope["payload"])

        if consumer.role not in ("electron", "mobile", "admin", "web"):
            await consumer._send_error(
                request_id, ERROR_PERMISSION_DENIED, "role not allowed",
            )
            return

        thread_id = envelope.get("thread_id") or payload.get("thread_id")
        hitl_request_id = payload.get("request_id")
        user_response = payload.get("response")

        # v0.4 W1.5：按 protocol form 分流——approval batch 用 batch_id 作为 SETNX key，
        # single ask_* request（ask_choice / ask_form 单条）仍用 request_id。
        # 两条路径任一端先到即成功，其余端 NAK。
        response_obj = user_response if isinstance(user_response, dict) else {}
        batch_id = response_obj.get("batch_id") if isinstance(response_obj.get("batch_id"), str) else None

        if not thread_id:
            await consumer._send_error(
                request_id, ERROR_SCHEMA_INVALID,
                "missing thread_id in payload",
            )
            return

        if not batch_id and not hitl_request_id:
            await consumer._send_error(
                request_id, ERROR_SCHEMA_INVALID,
                "missing batch_id (approval batch) or request_id (single ask_* request) in payload",
            )
            return

        # 协议形态分流：approval batch 仲裁键带 `batch:` 前缀，与 single ask_* request 的
        # 仲裁键命名空间隔离（PRD §7.10.1）。
        if batch_id:
            target_kind = "batch"
            target_id = batch_id
            consumed_key = f"{LOCALRT_CONSUMED_PREFIX}batch:{batch_id}"
            inflight_key = f"{LOCALRT_INFLIGHT_PREFIX}batch:{batch_id}"
            consumed_log_id = f"batch={batch_id}"
            if not await _can_user_resolve_tool_approval_async(
                thread_id,
                batch_id,
                str(consumer.user_id),
            ):
                logger.warning(
                    "[LocalRT] Non-owner approval response rejected: thread=%s batch=%s user=%s",
                    thread_id, batch_id, consumer.user_id,
                )
                await consumer._send_error(
                    request_id,
                    ERROR_PERMISSION_DENIED,
                    "Only the execution owner can approve or reject this team Space action",
                )
                return
            response_obj = _with_server_approver_identity(response_obj, str(consumer.user_id))
            user_response = response_obj
        else:
            target_kind = "request"
            target_id = str(hitl_request_id)
            consumed_key = f"{LOCALRT_CONSUMED_PREFIX}{hitl_request_id}"
            inflight_key = f"{LOCALRT_INFLIGHT_PREFIX}{hitl_request_id}"
            consumed_log_id = f"request_id={hitl_request_id}"
            if not await _can_user_resolve_single_hitl_async(
                thread_id,
                str(hitl_request_id),
                str(consumer.user_id),
            ):
                logger.warning(
                    "[LocalRT] Non-owner single HITL response rejected: thread=%s request=%s user=%s",
                    thread_id, hitl_request_id, consumer.user_id,
                )
                await consumer._send_error(
                    request_id,
                    ERROR_PERMISSION_DENIED,
                    "Only the execution owner can respond to this team Space interaction",
                )
                return

        # forward_event 透传 response 给设备 topic；下游 runtime（DaemonAgentHost /
        # ElectronAgentHost）按 response.batch_id 是否存在自行分流到
        # handleSubmitHitlBatch / handleSubmitAskUserResponse。
        submit_id = new_event_id()
        forward_payload: Dict[str, Any] = {
            "response": user_response,
            "submit_id": submit_id,
        }
        if hitl_request_id:
            forward_payload["request_id"] = hitl_request_id
        forward_event = build_envelope(
            LOCALRT_EVENT_TYPE,
            new_event_id(),
            forward_payload,
            thread_id=thread_id,
        )

        # 先解析 runtime 设备再 SETNX——旧顺序（先 SETNX 再解析）在 Electron fallback
        # 缺失时会对 mobile 误 NAK device_offline，但 batch 已被 consumed，用户无法重试。
        runtime_fp = await _resolve_runtime_device_fp_for_hitl_async(
            thread_id,
            kind=target_kind,
            target_id=target_id,
        )
        if not runtime_fp:
            logger.warning(
                "[LocalRT] No runtime device resolved for thread=%s, "
                "returning NAK device_offline",
                thread_id,
            )
            nak = _build_nak(
                request_id,
                thread_id,
                error_code="device_offline",
                error_message="No runtime device online for this session",
                retryable=True,
                event_type=response_nak_type,
            )
            await consumer._send_envelope(nak)
            return

        try:
            claim_result = await run_sync_io(
                _claim_user_response_delivery_sync,
                consumed_key,
                inflight_key,
                submit_id,
            )
            if claim_result == "already_consumed":
                logger.warning(
                    "[LocalRT] Duplicate user_response rejected: %s",
                    consumed_log_id,
                )
                if not batch_id:
                    await sync_to_async(_mark_single_hitl_pending_interaction, thread_sensitive=False)(
                        thread_id=thread_id,
                        request_id=str(hitl_request_id) if hitl_request_id else None,
                        response_obj=response_obj,
                        status="resolved",
                        reason="already_consumed",
                    )
                nak = _build_nak(
                    request_id,
                    thread_id,
                    error_code="already_consumed",
                    error_message="已由其它设备处理",
                    retryable=False,
                    event_type=response_nak_type,
                )
                await consumer._send_envelope(nak)
                return

            if claim_result == "response_inflight":
                logger.warning("[LocalRT] Duplicate user_response in-flight rejected: %s", consumed_log_id)
                nak = _build_nak(
                    request_id,
                    thread_id,
                    error_code="response_inflight",
                    error_message="Response is already being delivered",
                    retryable=True,
                    event_type=response_nak_type,
                )
                await consumer._send_envelope(nak)
                return
        except Exception as exc:
            logger.warning("[LocalRT] Redis consumed/inflight check failed (proceeding): %s", exc)

        frozen_runtime_fp = await sync_to_async(
            _get_frozen_runtime_device_fp,
            thread_sensitive=False,
        )(thread_id)
        if frozen_runtime_fp:
            try:
                published = await sync_to_async(
                    publish_device_ws_event_exact,
                    thread_sensitive=False,
                )(runtime_fp, forward_event)
            except Exception:
                logger.warning(
                    "[LocalRT] Exact device publish failed for %s",
                    runtime_fp,
                    exc_info=True,
                )
                published = False
        else:
            from apps.services.common.agent_protocol.namespace import device_action_topic

            topic = device_action_topic(runtime_fp)
            published = await publish_ws_event_async(topic, forward_event)
        if not published:
            logger.warning(
                "[LocalRT] WS publish failed for device %s, returning retryable NAK",
                runtime_fp,
            )
            try:
                await run_sync_io(_delete_redis_key_sync, inflight_key)
            except Exception:
                pass
            nak = _build_nak(
                request_id,
                thread_id,
                error_code="device_offline",
                error_message="No runtime device online for this session",
                retryable=True,
                event_type=response_nak_type,
            )
            await consumer._send_envelope(nak)
            return

        delivery_ack = await _wait_for_delivery_ack(submit_id)
        delivery_status = delivery_ack.get("status")
        if delivery_status != "delivered":
            try:
                await run_sync_io(_delete_redis_key_sync, inflight_key)
            except Exception:
                pass
            error_code = str(delivery_ack.get("error_code") or delivery_status or "delivery_failed")
            retryable = bool(delivery_ack.get("retryable", error_code != "pending_not_found"))
            logger.warning(
                "[LocalRT] Runtime delivery failed: %s thread=%s device=%s status=%s code=%s",
                consumed_log_id, thread_id, runtime_fp, delivery_status, error_code,
            )
            if not batch_id and not retryable:
                await sync_to_async(_mark_single_hitl_pending_interaction, thread_sensitive=False)(
                    thread_id=thread_id,
                    request_id=str(hitl_request_id) if hitl_request_id else None,
                    response_obj=response_obj,
                    status="cancelled",
                    reason=error_code,
                )
            nak = _build_nak(
                request_id,
                thread_id,
                error_code=error_code,
                error_message=str(delivery_ack.get("error_message") or "Runtime did not accept the response"),
                retryable=retryable,
                event_type=response_nak_type,
            )
            await consumer._send_envelope(nak)
            return

        try:
            await run_sync_io(
                _finalize_user_response_delivery_sync,
                consumed_key,
                inflight_key,
            )
        except Exception as exc:
            logger.warning("[LocalRT] Redis consumed finalization failed (proceeding): %s", exc)

        # W2-轮 1：approval batch 镜像 dismiss 必须在 runtime delivery ack 后再发，
        # 避免「面板关了但 runtime 没收到决策、工具卡一直 running」。
        if batch_id:
            try:
                await sync_to_async(_publish_approval_resolved_to_mirror, thread_sensitive=False)(
                    thread_id,
                    response_obj,
                )
            except Exception:
                logger.warning(
                    "[LocalRT] mirror publish approval_resolved failed: thread=%s batch=%s",
                    thread_id, batch_id, exc_info=True,
                )
        else:
            await sync_to_async(_mark_single_hitl_pending_interaction, thread_sensitive=False)(
                thread_id=thread_id,
                request_id=str(hitl_request_id) if hitl_request_id else None,
                response_obj=response_obj,
                status="resolved",
            )

        logger.info(
            "[LocalRT] Delivered user_response: %s thread=%s device=%s submit=%s",
            consumed_log_id, thread_id, runtime_fp, submit_id,
        )

        response = build_envelope(
            response_ok_type,
            request_id,
            {"status": "ok", "buffered": False, "delivered": True},
            thread_id=thread_id,
        )
        await consumer._send_envelope(response)
        return True

    return handle_localrt_user_response


def create_localrt_user_response_delivery_handler(consumer):
    """Runtime → Django delivery ack for a forwarded HITL user response."""

    async def handle_localrt_user_response_delivery(envelope: Dict[str, Any]) -> None:
        request_id = envelope["request_id"]
        payload = envelope.get("payload") if isinstance(envelope.get("payload"), dict) else {}

        if consumer.role not in ("daemon", "device_runtime", "electron"):
            await consumer._send_error(
                request_id, ERROR_PERMISSION_DENIED, "role not allowed",
            )
            return
        if not getattr(consumer, "device_identity_verified", False):
            await consumer._send_error(
                request_id,
                ERROR_PERMISSION_DENIED,
                "device identity is not verified",
            )
            return

        submit_id = payload.get("submit_id")
        if not isinstance(submit_id, str) or not submit_id:
            await consumer._send_error(
                request_id, ERROR_SCHEMA_INVALID, "submit_id is required",
            )
            return

        status = payload.get("status")
        if not isinstance(status, str) or not status:
            await consumer._send_error(
                request_id, ERROR_SCHEMA_INVALID, "status is required",
            )
            return

        ack_payload = dict(payload)
        ack_payload["device_fingerprint"] = consumer.device_fingerprint
        try:
            await run_sync_io(_persist_delivery_ack_sync, submit_id, ack_payload)
        except Exception:
            logger.warning("[LocalRT] Failed to persist delivery ack: submit=%s", submit_id, exc_info=True)
            await consumer._send_error(
                request_id,
                ERROR_INTERNAL,
                "failed to persist delivery acknowledgement",
            )
            return

        await consumer._send_envelope(build_envelope(
            LOCALRT_DELIVERY_RESPONSE_OK,
            request_id,
            {"status": "ok"},
            thread_id=envelope.get("thread_id"),
        ))

    return handle_localrt_user_response_delivery


__all__ = [
    "LOCALRT_DELIVERY_EVENT_TYPE",
    "create_localrt_user_response_delivery_handler",
    "create_localrt_user_response_handler",
    "drain_buffered_user_responses",
    "record_pending_owner",
]
