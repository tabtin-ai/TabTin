"""
relay_events handler — 本地 Runtime → Django WS 总线的事件中继。

M2.5 改造：分流关键事件与细节事件。
Widget Wave 1 续作：新增「transient」第三态，支撑高频流式中间态事件。

三态分类（_classify_event）：

* **关键事件 critical**（同步写 DB，写完才 ACK）：
  - agent.stream.user / persist_message → ChatMessage（幂等 upsert）
  - agent.stream.state_snapshot → ConversationState
  - agent.stream.done → token / runtime result（通知在 ACK 后）
  - lifecycle / approval_* / ask_* / billing 等 → 进 critical 列表

* **细节事件 detail**（异步写 TraceEvent，不挡 ACK）

* **transient 事件**（只透传，绝不写库）：
  - tool_call_args_delta 等；进 EXCLUDED_FROM_TRACE

* **直播广播**：与 ACK **解耦**——critical 落库成功并发 ACK 后，
  再按 thread 串行 fire-and-forget publish。不再在 ACK 前逐条 await
  Redis/channel_layer，避免胖 detail 拖死 persist。

ACK payload 新增 message_ids 字段，返回 user/assistant 消息的
client_event_id → server_id 映射，供客户端替换 temp-id。
同步写失败返回 NAK（relay_events.nak），客户端应重试；NAK 时不补发广播。
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import time
import uuid
from collections import Counter
from typing import Any, Dict

from asgiref.sync import sync_to_async
from channels.db import database_sync_to_async
from django.conf import settings

from apps.services.common.agent_protocol.constants import (
    AgentStreamEvent,
    EXCLUDED_FROM_TRACE,
    RELAY_ALLOWED_SHORT_NAMES,
)

from ..protocol import ERROR_PERMISSION_DENIED, ERROR_SCHEMA_INVALID, build_envelope
from ..metrics import record_relay_batch_processed, record_relay_batch_received
from .relay_audit_writer import spawn_audit_writes
from .relay_llm_snapshot_writer import spawn_llm_snapshot_writes
from .relay_delta_coalesce import coalesce_deferred_publishes
from .relay_message_writer import (
    CRITICAL_EVENT_TYPES,
    sync_write_critical_events,
)
from .relay_trace_writer import persist_relay_events_to_trace
from .localrt_user_response import record_pending_owner
from apps.services.agent_engine.services.pending_interaction_service import (
    TEAM_SPACE_EXECUTION_REDACTION_REQUIRED_KEY,
    mark_single_hitl_resolved,
    mark_tool_approval_resolved_from_payload,
    redact_team_space_tool_approval_payload,
    resolve_current_interaction_run_id,
    runtime_can_open_interaction,
    upsert_single_hitl_interaction,
    upsert_tool_approval_interaction,
)

logger = logging.getLogger(__name__)

_BACKGROUND_TERMINAL_RUN_PREFIX = "bg-terminal-"


def _is_background_terminal_placeholder_run_id(value: object) -> bool:
    """Recognize the runtime's documented non-business run placeholder."""
    if not isinstance(value, str) or not value.startswith(
        _BACKGROUND_TERMINAL_RUN_PREFIX
    ):
        return False
    suffix = value[len(_BACKGROUND_TERMINAL_RUN_PREFIX):]
    try:
        parsed = uuid.UUID(suffix)
    except (TypeError, ValueError):
        return False
    return suffix == str(parsed)


def _normalize_chat_session_thread_id(thread_id: str | None) -> str | None:
    if not thread_id:
        return None
    candidate = (
        thread_id[len("chat-session-") :]
        if thread_id.startswith("chat-session-")
        else thread_id
    )
    try:
        return str(uuid.UUID(candidate))
    except (TypeError, ValueError):
        return None


def _should_project_run_state_event(
    *,
    relay_thread_id: str,
    payload: dict,
) -> bool:
    if payload.get("observer_only") is True or payload.get("trace_forwarded") is True:
        return False

    payload_thread_id = payload.get("thread_id")
    if isinstance(payload_thread_id, str) and payload_thread_id:
        relay_session_id = _normalize_chat_session_thread_id(relay_thread_id)
        payload_session_id = _normalize_chat_session_thread_id(payload_thread_id)
        if relay_session_id is None or payload_session_id != relay_session_id:
            return False

    return True


def _apply_run_state_events(
    thread_id: str,
    events: list[tuple[str, dict]],
    user_id: str,
) -> bool:
    from apps.services.agent_engine.services.session_run_state_service import (
        SessionRunStateService,
    )

    terminal_states_confirmed = True
    for short_name, payload in events:
        if not _should_project_run_state_event(
            relay_thread_id=thread_id,
            payload=payload,
        ):
            continue
        run_id = payload.get("run_id")
        if not isinstance(run_id, str) or not run_id:
            if short_name == AgentStreamEvent.DONE:
                terminal_states_confirmed = False
                logger.error(
                    "[SessionRun] DONE missing run_id: thread_hash=%s",
                    _hash_log_id(thread_id),
                )
            continue
        event_revision = payload.get("arrival_seq")
        if not isinstance(event_revision, int) or isinstance(event_revision, bool):
            event_revision = None
        if short_name == AgentStreamEvent.LIFECYCLE:
            phase = payload.get("phase")
            if phase == "start":
                # Electron 本机 IPC 在离线/滚动升级期间可能没能先调用显式
                # accept-local 控制面。relay 已完成 session + organization 鉴权，
                # 因此在 lifecycle.start 这个受控事实入口幂等补登记；done 等终态
                # 绝不能凭空创建 run，避免迟到/伪造终态成为事实创建者。
                accepted = SessionRunStateService.accept_local_dispatch(
                    thread_id=thread_id,
                    run_id=run_id,
                    task_id=str(
                        payload.get("task_id")
                        or payload.get("client_event_id")
                        or run_id
                    ),
                    user_id=user_id,
                    runtime_source_prevalidated=True,
                )
                if accepted is None:
                    logger.warning(
                        "[SessionRun] rejected relay start fact creation: "
                        "thread_hash=%s run_hash=%s user_hash=%s",
                        _hash_log_id(thread_id),
                        _hash_log_id(run_id),
                        _hash_log_id(user_id),
                    )
                    continue
                SessionRunStateService.transition(
                    run_id=run_id,
                    status="running",
                    event_revision=event_revision,
                    expected_thread_id=thread_id,
                    allowed_from=frozenset({"queued", "running"}),
                )
            elif phase == "cancelling":
                SessionRunStateService.transition(
                    run_id=run_id,
                    status="cancelling",
                    event_revision=event_revision,
                    expected_thread_id=thread_id,
                )
            elif phase == "paused":
                # ：runtime 已停在安全边界，这时才把权威 run_state 标成 paused。
                SessionRunStateService.transition(
                    run_id=run_id,
                    status="paused",
                    event_revision=event_revision,
                    expected_thread_id=thread_id,
                    allowed_from=frozenset({"running", "paused", "waiting_user"}),
                )
            elif phase == "error":
                error_class = str(payload.get("error_class") or "runtime_error")
                stop_reason = str(payload.get("stop_reason") or "runtime_error")
                SessionRunStateService.transition(
                    run_id=run_id,
                    status=(
                        "interrupted"
                        if error_class == "ABORT" or stop_reason == "aborted"
                        else "failed"
                    ),
                    event_revision=event_revision,
                    expected_thread_id=thread_id,
                    stop_reason=stop_reason,
                    error_class=error_class,
                )
        elif short_name == AgentStreamEvent.DONE:
            error_class = str(payload.get("error_class") or "") or None
            stop_reason = str(payload.get("stop_reason") or "") or None
            error_message = str(payload.get("error_message") or "") or None
            setup_step = str(payload.get("setup_step") or "") or None
            if stop_reason == "cancelled":
                status = "cancelled"
            elif error_class == "ABORT" or stop_reason == "aborted":
                status = "interrupted"
            elif payload.get("error") is True:
                status = "failed"
            else:
                status = "completed"
            # HOST_SETUP_ERROR 等：把明文与 setup_step 写入 ExecutionRun，便于对照吞队。
            error_text = error_message
            if setup_step and error_text:
                error_text = f"[{setup_step}] {error_text}"
            elif setup_step and not error_text:
                error_text = f"[{setup_step}]"
            projection = SessionRunStateService.transition(
                run_id=run_id,
                status=status,
                event_revision=event_revision,
                expected_thread_id=thread_id,
                stop_reason=stop_reason,
                error_class=error_class,
                error=error_text,
            )
            if (
                projection is None
                and not SessionRunStateService.has_terminal_state(
                    run_id=run_id,
                    expected_thread_id=thread_id,
                )
            ):
                terminal_states_confirmed = False
                logger.error(
                    "[SessionRun] DONE terminal state not confirmed: "
                    "thread_hash=%s run_hash=%s",
                    _hash_log_id(thread_id),
                    _hash_log_id(run_id),
                )

    return terminal_states_confirmed


_async_apply_run_state_events = sync_to_async(
    _apply_run_state_events,
    thread_sensitive=True,
)


def _hash_log_id(value: Any) -> str:
    if value is None:
        return "-"
    text = str(value)
    if not text:
        return "-"
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:12]


def _to_ms(seconds: float) -> int:
    return max(0, int(seconds * 1000))


def _network_delay_ms(envelope: Dict[str, Any], server_received_at: float) -> int | None:
    client_ts = envelope.get("ts")
    if not isinstance(client_ts, int):
        return None
    return _to_ms(server_received_at - float(client_ts))


def _publish_ws_sync(
    thread_id: str,
    short_name: str,
    event_payload: dict,
    *,
    exclude_channel: str | None = None,
) -> None:
    from apps.services.common.chat_stream_publisher import ChatStreamPublisher
    ChatStreamPublisher.publish_ws(
        thread_id,
        short_name,
        event_payload,
        exclude_channel=exclude_channel,
    )


_async_publish_ws = sync_to_async(_publish_ws_sync, thread_sensitive=False)

# per-thread 串行 publish 链：跨 batch 保序，且不阻塞 relay_events ACK。
_THREAD_PUBLISH_TAILS: dict[str, asyncio.Task] = {}
_DEFERRED_PUBLISH_TASKS: set[asyncio.Task] = set()
_DEFERRED_NOTIFY_TASKS: set[asyncio.Task] = set()
_NON_REALTIME_DELIVERY_MODES = frozenset({"recover", "backfill"})
_RELAY_NOTIFICATION_MAX_AGE_SECONDS = int(
    getattr(settings, "WS_RELAY_NOTIFICATION_MAX_AGE_SECONDS", 30 * 60)
)


def _should_emit_realtime_done_notification(
    relay_payload: dict,
    done_payload: dict,
    *,
    server_received_at: float,
) -> bool:
    """判断单条 DONE 是否仍具备“实时提醒”语义。

    新客户端显式声明 live/recover/backfill；旧客户端缺少声明时，只对能从
    ``arrival_seq`` 判定为超过安全窗口的历史 DONE 抑制提醒。持久化、运行
    终态与广播不受此策略影响。
    """
    delivery_mode = relay_payload.get("delivery_mode")
    if delivery_mode in _NON_REALTIME_DELIVERY_MODES:
        return False
    if delivery_mode is not None:
        return True

    arrival_seq = done_payload.get("arrival_seq")
    if not isinstance(arrival_seq, int) or isinstance(arrival_seq, bool):
        return True
    event_created_at = arrival_seq / 1_000_000
    event_age_seconds = server_received_at - event_created_at
    return event_age_seconds <= _RELAY_NOTIFICATION_MAX_AGE_SECONDS


def _spawn_deferred_publishes(
    thread_id: str,
    items: list[tuple[str, dict]],
    *,
    exclude_channel: str | None = None,
) -> None:
    """ACK 后按序广播；同 thread 串到上一条 tail，失败只打日志不重抛。

    ``exclude_channel``：relay 发送方 ``channel_name``，广播时跳过该连接，
    避免同源事件回灌到已由 localStream 渲染的 Electron。
    """
    if not items:
        return

    prev = _THREAD_PUBLISH_TAILS.get(thread_id)

    async def _run() -> None:
        if prev is not None and not prev.done():
            try:
                await prev
            except Exception:
                pass
        for short_name, event_payload in items:
            try:
                await _async_publish_ws(
                    thread_id,
                    short_name,
                    event_payload,
                    exclude_channel=exclude_channel,
                )
            except Exception:
                logger.warning(
                    "[WS] deferred publish failed: thread_hash=%s event=%s",
                    _hash_log_id(thread_id),
                    short_name,
                    exc_info=True,
                )

    task = asyncio.create_task(
        _run(),
        name=f"relay_publish_{_hash_log_id(thread_id)}",
    )
    _THREAD_PUBLISH_TAILS[thread_id] = task
    _DEFERRED_PUBLISH_TASKS.add(task)

    def _cleanup(done: asyncio.Task) -> None:
        _DEFERRED_PUBLISH_TASKS.discard(done)
        if _THREAD_PUBLISH_TAILS.get(thread_id) is done:
            _THREAD_PUBLISH_TAILS.pop(thread_id, None)

    task.add_done_callback(_cleanup)


def _spawn_deferred_done_notify(
    *,
    session_id: str,
    done_payloads: list[dict],
    message_ids: list[dict[str, str]],
    fallback_user_id: str,
) -> None:
    """DONE 铃铛 / Tracker 通知移出 ACK 临界区。"""
    if not done_payloads:
        return

    async def _run() -> None:
        try:
            await _async_notify_agent_task_from_done(
                session_id=session_id,
                done_payloads=done_payloads,
                message_ids=message_ids,
                fallback_user_id=fallback_user_id,
            )
        except Exception:
            logger.warning(
                "[WS] deferred done notify failed: session_hash=%s",
                _hash_log_id(session_id),
                exc_info=True,
            )

    task = asyncio.create_task(
        _run(),
        name=f"relay_done_notify_{_hash_log_id(session_id)}",
    )
    _DEFERRED_NOTIFY_TASKS.add(task)
    task.add_done_callback(_DEFERRED_NOTIFY_TASKS.discard)


async def drain_deferred_relay_side_effects_for_tests() -> None:
    """测试辅助：排空 deferred publish / notify，兼容 ``asyncio.run`` 用例。"""
    pending = [t for t in (*_DEFERRED_PUBLISH_TASKS, *_DEFERRED_NOTIFY_TASKS) if not t.done()]
    if pending:
        await asyncio.gather(*pending, return_exceptions=True)


_async_upsert_tool_approval_interaction = sync_to_async(
    upsert_tool_approval_interaction, thread_sensitive=False,
)
_async_upsert_single_hitl_interaction = sync_to_async(
    upsert_single_hitl_interaction, thread_sensitive=False,
)
_async_mark_tool_approval_resolved_from_payload = sync_to_async(
    mark_tool_approval_resolved_from_payload, thread_sensitive=False,
)
_async_mark_single_hitl_resolved = sync_to_async(
    mark_single_hitl_resolved, thread_sensitive=False,
)


def _enrich_team_space_execution_payload(session_id: str, payload: dict) -> dict:
    if not isinstance(payload, dict):
        return payload

    # Runtime payload is untrusted. Approval ownership must come from the
    # server-side session context, never from a device-supplied user id.
    trusted_payload = {
        key: value
        for key, value in payload.items()
        if key not in {
            "team_space_execution",
            TEAM_SPACE_EXECUTION_REDACTION_REQUIRED_KEY,
        }
    }

    try:
        from apps.services.agent_execution.team_space_execution import (
            resolve_message_execution_metadata,
        )

        metadata = resolve_message_execution_metadata(
            session_id,
            run_id=str(payload.get("run_id") or "") or None,
        )
    except Exception:
        logger.debug(
            "[WS] team-space approval metadata resolve failed: session_hash=%s",
            _hash_log_id(session_id), exc_info=True,
        )
        return {
            **trusted_payload,
            TEAM_SPACE_EXECUTION_REDACTION_REQUIRED_KEY: True,
        }

    team_meta = metadata.get("team_space_execution") if isinstance(metadata, dict) else None
    if not isinstance(team_meta, dict):
        return trusted_payload

    return {
        **trusted_payload,
        "team_space_execution": team_meta,
    }


_async_enrich_team_space_execution_payload = sync_to_async(
    _enrich_team_space_execution_payload, thread_sensitive=False,
)


_BACKGROUND_TRACE_TASKS: set[asyncio.Task] = set()
_MAX_BACKGROUND_TASKS = 1000

_REJECTED_TASK_COUNTER: dict[str, int] = {"total": 0, "last_log_at_count": 0}
_REJECTED_LOG_INTERVAL = 50


def _spawn_background_trace_write(
    session_id: str, thread_id: str, events: list[dict],
) -> bool:
    """启动后台写 trace task，不 await。返回 True = 已启动。"""
    if len(_BACKGROUND_TRACE_TASKS) >= _MAX_BACKGROUND_TASKS:
        _REJECTED_TASK_COUNTER["total"] += 1
        total = _REJECTED_TASK_COUNTER["total"]
        if total - _REJECTED_TASK_COUNTER["last_log_at_count"] >= _REJECTED_LOG_INTERVAL:
            logger.error(
                "[WS] trace 写表 task 池满累计拒绝 %d 次（pool_size=%d, "
                "current_session_hash=%s）",
                total, _MAX_BACKGROUND_TASKS, _hash_log_id(session_id),
            )
            _REJECTED_TASK_COUNTER["last_log_at_count"] = total
        else:
            logger.warning(
                "[WS] trace 写表 task 池满（pool_size=%d，已累计拒绝 %d 次），"
                "跳过 session_hash=%s 的本批写表",
                _MAX_BACKGROUND_TASKS, total, _hash_log_id(session_id),
            )
        return False

    async def _run():
        try:
            await persist_relay_events_to_trace(
                session_id=session_id, thread_id=thread_id, events=events,
            )
        except Exception:
            logger.warning(
                "[WS] background trace 写表异常: session_hash=%s",
                _hash_log_id(session_id), exc_info=True,
            )

    task = asyncio.create_task(_run(), name=f"trace_write_{_hash_log_id(session_id)}")
    _BACKGROUND_TRACE_TASKS.add(task)
    task.add_done_callback(_BACKGROUND_TRACE_TASKS.discard)
    return True


def get_rejected_trace_write_count() -> int:
    return _REJECTED_TASK_COUNTER["total"]


def reset_rejected_trace_write_count() -> None:
    _REJECTED_TASK_COUNTER["total"] = 0
    _REJECTED_TASK_COUNTER["last_log_at_count"] = 0


_STREAM_PREFIX = "agent.stream."
_STREAM_PREFIX_LEN = len(_STREAM_PREFIX)


_MEMORY_TRIGGER_EVENTS = frozenset({"lifecycle", "compaction"})

_HITL_OWNER_EVENTS = frozenset({
    AgentStreamEvent.APPROVAL_REQUESTED,
    AgentStreamEvent.ASK_USER_REQUIRED,
    AgentStreamEvent.ASK_FORM_REQUIRED,
    AgentStreamEvent.REQUEST_APPROVAL_REQUIRED,
})

_SINGLE_HITL_INTERACTION_KIND_BY_EVENT = {
    AgentStreamEvent.ASK_USER_REQUIRED: "ask_choice",
    AgentStreamEvent.ASK_FORM_REQUIRED: "ask_form",
    AgentStreamEvent.REQUEST_APPROVAL_REQUIRED: "permission_request",
}


def _record_hitl_pending_owner(
    *,
    thread_id: str,
    short_name: str,
    event_payload: dict,
    device_fingerprint: str | None,
) -> None:
    if not device_fingerprint or short_name not in _HITL_OWNER_EVENTS:
        return

    if short_name == AgentStreamEvent.APPROVAL_REQUESTED:
        target_ids = [event_payload.get("batch_id")]
        kind = "batch"
    else:
        # The submit protocol keys single-request HITL by ``request_id``, while
        # historical/runtime payloads may also carry transport aliases such as
        # ``interrupt_id`` or ``message_id``. Record all equivalent ids so mobile
        # responses do not fall back to session-level device routing.
        target_ids = [
            event_payload.get("request_id"),
            event_payload.get("interrupt_id"),
            event_payload.get("ask_id"),
            event_payload.get("message_id"),
        ]
        kind = "request"

    seen: set[str] = set()
    for target_id in target_ids:
        if not isinstance(target_id, str) or not target_id or target_id in seen:
            continue
        seen.add(target_id)
        record_pending_owner(
            thread_id=thread_id,
            target_id=target_id,
            device_fingerprint=device_fingerprint,
            kind=kind,
        )


def _has_memory_trigger_events(accepted_events: list[dict]) -> bool:
    """快速判断事件批次中是否包含可能触发记忆抽取的事件类型。

    主线程内执行（零 IO），避免不必要的线程创建。
    """
    for evt in accepted_events:
        event_type = evt.get("type", "")
        if event_type.startswith(_STREAM_PREFIX):
            short = event_type[_STREAM_PREFIX_LEN:]
            if short in _MEMORY_TRIGGER_EVENTS:
                return True
    return False


def _spawn_memory_trigger(
    session_id: str,
    thread_id: str,
    user_id: str,
    accepted_events: list[dict],
) -> None:
    """Fire-and-forget: 检查记忆抽取触发条件并分发 Celery 任务。

    在独立线程中执行以避免阻塞 async event loop。
    全部异常被内部捕获，不影响 relay 主流程。
    """
    import threading

    def _run():
        try:
            from apps.services.agent_engine.tasks.memory.relay_memory_trigger import (
                dispatch_memory_trigger,
            )
            dispatch_memory_trigger(
                session_id=session_id,
                thread_id=thread_id,
                user_id=user_id,
                accepted_events=accepted_events,
            )
        except Exception:
            logger.debug(
                "[WS] memory trigger dispatch error (non-fatal): session_hash=%s",
                _hash_log_id(session_id), exc_info=True,
            )

    t = threading.Thread(target=_run, daemon=True, name=f"mem_trigger_{_hash_log_id(session_id)}")
    t.start()


@database_sync_to_async
def _verify_session_in_organizations(
    session_id: str,
    organization_ctx,
    consumer=None,
    run_ids: tuple[str | None, ...] | None = None,
) -> bool:
    try:
        from apps.chat.conversation.models import ChatSession

        if not getattr(consumer, "device_identity_verified", False):
            return False

        row = (
            ChatSession.objects.filter(id=session_id)
            .values_list("organization_id", flat=True)
            .first()
        )
        if row is None or not organization_ctx.is_member(row):
            return False
        if getattr(consumer, "role", None) not in {
            "electron",
            "daemon",
            "device_runtime",
        }:
            return False
        authorization_args = {
            "thread_id": f"chat-session-{session_id}",
            "user_id": str(getattr(consumer, "user_id", "") or ""),
            "source_device_fingerprint": str(
                getattr(consumer, "device_fingerprint", "") or ""
            ),
        }
        if run_ids:
            return all(
                runtime_can_open_interaction(
                    **authorization_args,
                    run_id=run_id,
                )
                for run_id in run_ids
            )
        return runtime_can_open_interaction(**authorization_args)
    except Exception:
        logger.warning(
            "DB error verifying session ownership for session_hash=%s",
            _hash_log_id(session_id), exc_info=True,
        )
        return False


def _classify_event(short_name: str) -> str:
    """返回 'critical' / 'detail' / 'transient'。

    - **critical**：同步写 ChatMessage / TraceEvent，写完才 ACK
    - **detail**：异步后台写 TraceEvent，立即 ACK（write_file 大文本片段等
      中等频率事件）
    - **transient**：Widget Wave 1（widget RFC §七 🔴 高严重度风险）—— 1000
      token/s 高频事件（``tool_call_args_delta`` 等），**只透传不写库**。
      `EXCLUDED_FROM_TRACE` 集合显式列出此类事件；进 `_spawn_background_trace_write`
      会瞬间压垮 PG TraceEvent 表。
    """
    if short_name in CRITICAL_EVENT_TYPES:
        return "critical"
    if short_name in EXCLUDED_FROM_TRACE:
        return "transient"
    return "detail"


def _write_runtime_result_from_relay_done(event_payload: dict) -> None:
    """兼容同步 remote_agent 等待路径：relay done 也写 runtime result key。"""
    task_id = event_payload.get("task_id")
    if not isinstance(task_id, str) or not task_id:
        return

    interrupted = (
        event_payload.get("stop_reason") == "aborted"
        or event_payload.get("error_class") == "ABORT"
    )
    result = {
        "content": str(event_payload.get("content", "") or ""),
        "error": bool(event_payload.get("error", False)),
        "error_message": str(event_payload.get("error_message", "") or ""),
        "error_category": (
            "cancelled"
            if interrupted
            else str(event_payload.get("error_category", "") or "")
        ),
        "agent_type": str(event_payload.get("agent_type", "local-runtime") or "local-runtime"),
    }

    try:
        from django.core.cache import cache
        cache.set(f"runtime:result:{task_id}", json.dumps(result), timeout=3600)
    except Exception:
        logger.warning(
            "[WS] relay done 写 runtime result key 失败: task_id=%s",
            task_id, exc_info=True,
        )

    try:
        from apps.tracker.services.tracker_executor import (
            complete_tracker_run_from_runtime_done,
        )
        complete_tracker_run_from_runtime_done(task_id, result)
    except Exception:
        logger.warning(
            "[WS] relay done reconcile TrackerRun failed: task_id=%s",
            task_id, exc_info=True,
        )


_async_write_runtime_result_from_relay_done = sync_to_async(
    _write_runtime_result_from_relay_done, thread_sensitive=False,
)


# DONE 虽带 error:true 但属「受控优雅终止」的 error_class——聊天内已有
# 语义化卡片表达 + 引导（errorClassMap 的「已达运行上限，已中止」，/#5228），
# 铃铛再落一条「Agent 任务出错」是重复打扰且泄内部英文日志。
# 注：runtime 把 credits 墙与 token 墙统一映射为 MAX_CREDITS_EXCEEDED
# （mapBudgetReasonToErrorClass），这里一并覆盖。
_GRACEFUL_TERMINATION_ERROR_CLASSES = frozenset({"MAX_CREDITS_EXCEEDED"})
_USER_CANCELLED_STOP_REASONS = frozenset(
    {"cancelled", "canceled", "user_cancelled", "user_canceled"}
)


def _notify_agent_task_from_done(
    *,
    session_id: str,
    done_payloads: list[dict],
    message_ids: list[dict[str, str]],
    fallback_user_id: str = "",
) -> None:
    """relay done 后落库 Agent 任务通知（失败不阻断 ACK）。"""
    if not done_payloads:
        return
    try:
        from apps.services.notification.services.agent_task_notification import (
            compact_agent_notification_summary,
            notify_agent_task_terminal,
        )
    except Exception:
        logger.debug("[WS] agent task notify import failed", exc_info=True)
        return

    for done_payload in done_payloads:
        if not isinstance(done_payload, dict):
            continue
        error_class = str(done_payload.get("error_class") or "")
        if error_class in _GRACEFUL_TERMINATION_ERROR_CLASSES:
            continue
        stop_reason = str(done_payload.get("stop_reason") or "").lower()
        if stop_reason in _USER_CANCELLED_STOP_REASONS:
            continue
        has_error = bool(done_payload.get("error", False))
        interrupted = (
            error_class == "ABORT"
            or stop_reason == "aborted"
        )
        phase = "interrupted" if interrupted else "error" if has_error else "end"
        # ：铃铛 typeLabel 已是「任务已完成/出错」，title 用一句话摘要；
        # body 留空，由 notify_agent_task_terminal 回退会话标题作次要行。
        # 勿再把 DONE.content 硬截 200 字塞进 body。
        raw_text = str(
            done_payload.get("error_message")
            or done_payload.get("content")
            or ""
        )
        summary = compact_agent_notification_summary(raw_text)
        if has_error:
            title = summary or "处理过程中发生错误"
        else:
            title = summary or "对话已完成处理"
        body = ""
        trace_id = str(
            done_payload.get("trace_id")
            or done_payload.get("run_id")
            or ""
        )
        task_id = str(done_payload.get("task_id") or "")
        try:
            notify_agent_task_terminal(
                session_id=session_id,
                phase=phase,
                title=title,
                body=body,
                user_ids=[fallback_user_id] if fallback_user_id else None,
                message_ids=message_ids,
                trace_id=trace_id,
                source_event_id=(
                    f"agent.task:{session_id}:{task_id or trace_id or 'done'}:{phase}"
                ),
            )
        except Exception:
            logger.warning(
                "[WS] agent task notify failed: session_hash=%s phase=%s",
                _hash_log_id(session_id),
                phase,
                exc_info=True,
            )


_async_notify_agent_task_from_done = sync_to_async(
    _notify_agent_task_from_done, thread_sensitive=False,
)


def _schedule_agent_done_push(session_id: str, done_payload: dict) -> None:
    """离线叫醒：turn 结束后异步发「干完活」移动端推送。

    尽力而为——推送未配置 / broker 故障不阻断 relay ACK；
    子 Agent 过滤、节流、在线抑制在 Celery task 侧统一处理。
    """
    try:
        from apps.services.notification.push.providers import is_push_enabled
        if not is_push_enabled():
            return
        from apps.services.notification.tasks import push_agent_done
        push_agent_done.delay(session_id, {
            "content": str(done_payload.get("content", "") or "")[:500],
            "error": bool(done_payload.get("error", False)),
            "error_message": str(done_payload.get("error_message", "") or "")[:200],
        })
    except Exception:
        logger.debug(
            "[WS] schedule agent done push failed: session=%s",
            session_id, exc_info=True,
        )


_async_schedule_agent_done_push = sync_to_async(
    _schedule_agent_done_push, thread_sensitive=False,
)


def create_relay_events_handler(consumer):
    """Factory: returns the ``relay_events`` handler bound to *consumer*."""

    async def handle_relay_events(envelope: Dict[str, Any]) -> None:
        processing_started_at = time.time()
        request_id = envelope["request_id"]
        payload = envelope["payload"]

        session_id = payload.get("session_id")
        events = payload.get("events")

        if not session_id or not isinstance(session_id, str):
            await consumer._send_error(
                request_id, ERROR_SCHEMA_INVALID, "session_id is required",
            )
            return

        if not isinstance(events, list) or not events:
            await consumer._send_error(
                request_id, ERROR_SCHEMA_INVALID, "events must be a non-empty list",
            )
            return

        if len(events) > 500:
            await consumer._send_error(
                request_id, ERROR_SCHEMA_INVALID, f"events batch too large ({len(events)}), max 500",
            )
            return

        server_received_at = float(envelope.get("_server_received_at") or processing_started_at)
        payload_bytes = int(envelope.get("_payload_bytes") or 0)
        protocol_version = str(envelope.get("v", "unknown"))
        client_network_delay_ms = _network_delay_ms(envelope, server_received_at)
        record_relay_batch_received(
            protocol_version=protocol_version,
            event_count=len(events),
            payload_bytes=payload_bytes,
            network_delay_ms=client_network_delay_ms,
        )

        if not consumer.organization_ctx:
            await consumer._send_error(
                request_id, ERROR_PERMISSION_DENIED, "organization not set",
            )
            return

        run_ids: list[str | None] = []
        has_event_without_run_id = False
        for event in events:
            event_payload = event.get("payload") if isinstance(event, dict) else None
            raw_run_id = (
                event_payload.get("run_id")
                if isinstance(event_payload, dict)
                else None
            )
            run_id = (
                raw_run_id
                if (
                    isinstance(raw_run_id, str)
                    and raw_run_id
                    and not _is_background_terminal_placeholder_run_id(raw_run_id)
                )
                else None
            )
            if run_id is not None and run_id not in run_ids:
                run_ids.append(run_id)
            if run_id is None:
                has_event_without_run_id = True
        if has_event_without_run_id:
            explicit_run_ids = [run_id for run_id in run_ids if run_id]
            attributed_run_id = (
                explicit_run_ids[0]
                if len(explicit_run_ids) == 1
                else await sync_to_async(
                    resolve_current_interaction_run_id,
                    thread_sensitive=False,
                )(f"chat-session-{session_id}")
            )
            if attributed_run_id:
                if attributed_run_id not in run_ids:
                    run_ids.append(attributed_run_id)
                # Legacy/out-of-turn events (notably platform HITL and
                # background terminal updates) may lack a business run_id or
                # carry the runtime's reserved placeholder. Attribute them
                # once at the trusted relay boundary so downstream HITL and
                # message persistence consume the same durable run fact.
                for event in events:
                    event_payload = (
                        event.get("payload") if isinstance(event, dict) else None
                    )
                    if (
                        isinstance(event_payload, dict)
                        and (
                            not event_payload.get("run_id")
                            or _is_background_terminal_placeholder_run_id(
                                event_payload.get("run_id")
                            )
                        )
                    ):
                        event_payload["run_id"] = attributed_run_id
            else:
                # Keep a no-run authorization check. Personal sessions retain
                # their legacy fallback; Project sessions use the bounded
                # member Workspace/action-device fallback only when the
                # daemon-control feature is disabled.
                run_ids.append(None)

        owns = await _verify_session_in_organizations(
            session_id,
            consumer.organization_ctx,
            consumer,
            run_ids=tuple(run_ids),
        )
        if not owns:
            await consumer._send_error(
                request_id, ERROR_PERMISSION_DENIED,
                f"session {session_id} not found in user's organizations",
            )
            return

        thread_id = f"chat-session-{session_id}"

        relayed = 0
        skipped = 0
        skipped_reasons: Counter[str] = Counter()
        accepted_events: list[dict] = []
        critical_events: list[dict] = []
        detail_events: list[dict] = []
        # W2-轮 1（PRD 05 §7.4.3 + §7.7）：approval_* 事件触发审计 + interrupt_state
        # 写入。批次内单独累积一份，事件分类后异步 fire-and-forget 写盘。
        approval_events: list[dict] = []
        # ：llm_snapshot 单独累积——在 EXCLUDED_FROM_TRACE 里（transient 分类，
        # 不进 critical / detail / TraceEvent），由独立 writer 异步写 chat_llm_snapshot。
        llm_snapshot_events: list[dict] = []
        # Widget Wave 1（widget RFC §七 🔴 高严重度风险）：
        # 高频 transient 事件（如 ``tool_call_args_delta``）只透传不写库，
        # 显式累计计数让运维 / 测试可观测——确认事件量符合预期但 0 写库。
        transient_count = 0
        done_event_payloads: list[dict] = []
        run_state_events: list[tuple[str, dict]] = []
        # ：ACK 前只收集广播项，落库成功后再 deferred 串行 publish
        deferred_publishes: list[tuple[str, dict]] = []

        for evt in events:
            if not isinstance(evt, dict):
                skipped += 1
                skipped_reasons["invalid_event"] += 1
                continue

            event_type = evt.get("type")
            event_payload = evt.get("payload")

            if not isinstance(event_type, str) or not event_type.startswith(_STREAM_PREFIX):
                skipped += 1
                skipped_reasons["invalid_type"] += 1
                continue

            short_name = event_type[_STREAM_PREFIX_LEN:]
            if short_name not in RELAY_ALLOWED_SHORT_NAMES:
                skipped += 1
                skipped_reasons["event_not_allowed"] += 1
                continue

            if not isinstance(event_payload, dict):
                event_payload = {}

            normalized = {"type": event_type, "payload": event_payload}

            if short_name == AgentStreamEvent.APPROVAL_REQUESTED:
                event_payload = await _async_enrich_team_space_execution_payload(
                    session_id,
                    event_payload,
                )
                normalized = {"type": event_type, "payload": event_payload}
                pending = await _async_upsert_tool_approval_interaction(
                    thread_id=thread_id,
                    payload=event_payload,
                    source="agent_stream",
                    source_device_fingerprint=consumer.device_fingerprint,
                    publish=True,
                )
                if pending is None or getattr(pending, "status", None) != "pending":
                    logger.warning(
                        "[WS] skip approval_requested without active pending fact: session_hash=%s status=%s payload_keys=%s",
                        _hash_log_id(session_id), getattr(pending, "status", None), sorted(event_payload.keys()),
                    )
                    skipped += 1
                    skipped_reasons["approval_no_pending"] += 1
                    continue
            elif short_name == AgentStreamEvent.APPROVAL_RESOLVED:
                # bugbot 评审  high：静默判决审计（payload.silent=True）复用
                # approval_resolved 事件形态只为走 spawn_audit_writes 落 PermissionAudit，
                # **不是**真实的用户审批决议。混批 HITL 场景下静默 resolved 可能与真实
                # approval_requested 并行到达；若对 silent 也调 mark_resolved，会把仍在
                # waitForUserInput 的真实 pending 交互误标为已 resolved 并广播，与 runtime /
                # 前端审批卡状态脱节。故 silent 事件跳过 pending 状态变更，只走审计落库。
                if event_payload.get("silent") is not True:
                    await _async_mark_tool_approval_resolved_from_payload(
                        thread_id=thread_id,
                        payload=event_payload,
                        publish=True,
                    )
            elif short_name in _SINGLE_HITL_INTERACTION_KIND_BY_EVENT:
                # ：ask_* 与 approval_requested 同样 enrich team_space_execution，
                # 否则 team space 场景成员端 fail-open 可自答、owner 侧待办路由 /
                # 可见性判断全部拿不到 execution_owner_user_id。
                event_payload = await _async_enrich_team_space_execution_payload(
                    session_id,
                    event_payload,
                )
                normalized = {"type": event_type, "payload": event_payload}
                pending = await _async_upsert_single_hitl_interaction(
                    kind=_SINGLE_HITL_INTERACTION_KIND_BY_EVENT[short_name],
                    thread_id=thread_id,
                    payload=event_payload,
                    source="agent_stream",
                    source_device_fingerprint=consumer.device_fingerprint,
                    publish=True,
                )
                if pending is None or getattr(pending, "status", None) != "pending":
                    logger.warning(
                        "[WS] skip %s without active pending fact: session_hash=%s status=%s payload_keys=%s",
                        short_name, _hash_log_id(session_id), getattr(pending, "status", None), sorted(event_payload.keys()),
                    )
                    skipped += 1
                    skipped_reasons["hitl_no_pending"] += 1
                    continue
            elif short_name == AgentStreamEvent.SINGLE_HITL_RESOLVED:
                # ：单 HITL 终态回流——与 *_required 的 upsert 对称的「resolved」分支。
                # 落 PG 终态 + 发 interaction_resolved user 事件（移动端 pending 列表 / 跨会话
                # 收敛）；下方统一 _async_publish_ws 再把本 stream 事件 reliable 重广播到 topic
                # （SINGLE_HITL_RESOLVED ∈ _CRITICAL_EVENTS），观察镜像 / 其它端据此关面板。
                # request_id 定位（mark_single_hitl_resolved kind 无关，按 request_id 遍历三 kind）；
                # outcome=expired → 状态 expired，answered/skipped → resolved。幂等：对已 resolved
                # 的 pending no-op（mark_interaction_resolved previous_status=='pending' 守卫）。
                req_id = event_payload.get("request_id") or event_payload.get("interrupt_id")
                if req_id:
                    resolved_status = (
                        "expired" if event_payload.get("outcome") == "expired" else "resolved"
                    )
                    await _async_mark_single_hitl_resolved(
                        thread_id=thread_id,
                        request_id=str(req_id),
                        result=event_payload,
                        status=resolved_status,
                        publish=True,
                    )

            #  A1：persist_message 是**持久化专用**事件，不广播给客户端
            # （实时显示走 6 件套；客户端收到也会忽略）。仍进 accepted_events →
            # critical 通道同步 upsert ChatMessage。
            # ：llm_snapshot 含内部 system prompt / 工具 schema，同样不广播。
            # ：audit_cap 是 runtime 审计面包屑，仍落 TraceEvent（detail），
            # 但不广播给客户端（Electron 已无 UI 消费方）。
            # 同步约束：LocalAgent IPC 侧同款排除见
            # packages/agent-host/.../client-broadcast-excluded.ts
            # （CLIENT_BROADCAST_EXCLUDED_STREAM_TYPES）；改一侧必查另一侧。
            # ：其余事件推迟到 ACK 后 publish，避免广播阻塞落库。
            if short_name not in ("persist_message", "llm_snapshot", "audit_cap"):
                publish_payload = (
                    redact_team_space_tool_approval_payload(event_payload)
                    if short_name == AgentStreamEvent.APPROVAL_REQUESTED
                    else event_payload
                )
                deferred_publishes.append((short_name, publish_payload))
            _record_hitl_pending_owner(
                thread_id=thread_id,
                short_name=short_name,
                event_payload=event_payload,
                device_fingerprint=consumer.device_fingerprint,
            )
            if short_name == "done":
                done_event_payloads.append(event_payload)
            if short_name in (AgentStreamEvent.LIFECYCLE, AgentStreamEvent.DONE):
                run_state_events.append((short_name, event_payload))
            accepted_events.append(normalized)
            relayed += 1

            classification = _classify_event(short_name)
            if classification == "critical":
                critical_events.append(normalized)
            elif classification == "transient":
                # 关键不变量（widget RFC §七 🔴 高严重度风险）：
                # transient 事件**绝不进** critical 同步写库，**绝不进**
                # detail 后台写盘。1000 token/s 时一秒会有几千条 partial args，
                # 写库会瞬间压垮 PG TraceEvent 表。
                transient_count += 1
            else:
                detail_events.append(normalized)

            # W2-轮 1：approval_* 事件单独累积一份用于审计 / interrupt_state
            # 写入（与 critical / detail 写库通道独立，避免互相污染语义）
            if short_name in ("approval_requested", "approval_resolved"):
                approval_events.append(normalized)

            # ：llm_snapshot 单独累积（transient 分类不进任何写库通道，
            # 由独立 writer 异步落 chat_llm_snapshot）
            if short_name == "llm_snapshot":
                llm_snapshot_events.append(normalized)

        message_ids: list[dict[str, str]] = []
        sync_write_ok = True
        sync_error_code: str | None = None

        if critical_events:
            try:
                write_result = await sync_write_critical_events(
                    session_id=session_id,
                    thread_id=thread_id,
                    user_id=consumer.user_id,
                    critical_events=critical_events,
                )
                message_ids = write_result.message_ids
                sync_write_ok = write_result.success
                sync_error_code = write_result.error

                if not sync_write_ok:
                    logger.error(
                        "[WS] relay_events 关键事件同步写入失败: session_hash=%s error=%s",
                        _hash_log_id(session_id), write_result.error,
                    )
            except Exception:
                sync_write_ok = False
                sync_error_code = "sync_write_exception"
                logger.error(
                    "[WS] relay_events 关键事件同步写入异常: session_hash=%s",
                    _hash_log_id(session_id), exc_info=True,
                )

        if sync_write_ok and run_state_events:
            try:
                terminal_states_confirmed = await _async_apply_run_state_events(
                    thread_id,
                    run_state_events,
                    consumer.user_id or "",
                )
            except Exception:
                terminal_states_confirmed = False
                logger.error(
                    "[WS] relay_events 运行终态收敛异常: session_hash=%s",
                    _hash_log_id(session_id),
                    exc_info=True,
                )
            if not terminal_states_confirmed:
                sync_write_ok = False
                sync_error_code = "run_state_terminal_not_confirmed"

        realtime_done_payloads = [
            done_payload
            for done_payload in done_event_payloads
            if _should_emit_realtime_done_notification(
                payload,
                done_payload,
                server_received_at=server_received_at,
            )
        ]

        if sync_write_ok and done_event_payloads:
            for done_payload in done_event_payloads:
                await _async_write_runtime_result_from_relay_done(done_payload)
                # 移动端远程推送叫醒（，后续提交会按产品口径收窄事件）。
                if done_payload in realtime_done_payloads:
                    await _async_schedule_agent_done_push(session_id, done_payload)
            # 铃铛 / Tracker 通知移到 ACK 后（见下方 _spawn_deferred_done_notify）

        # ── Widget Wave 1 + W3 §3.3 协议升级关键不变量 ──
        # **进入 _spawn_background_trace_write 的 events 列表都不能含
        # EXCLUDED_FROM_TRACE 中的事件类型** ——TraceEvent 表写库压垮风险。
        #
        # W3 改造（content_block_delta 双语义）：
        # - critical 通道：reassembler.consume 必须消费 6 件套（含
        #   content_block_delta）才能正确重组 ContentBlock —— 故 delta 进
        #   CRITICAL_EVENT_TYPES 让 _sync_write_critical_events 可以收到
        # - 不写 trace：content_block_delta 进了 EXCLUDED_FROM_TRACE，
        #   trace 写盘前必须显式 filter
        #
        # 实施方式：保留断言 detail_events 不含 EXCLUDED（detail 全异步写盘）；
        # critical_events 路径在调用 _spawn_background_trace_write 前先
        # filter 掉 EXCLUDED_FROM_TRACE 类型——既能让 reassembler 消费 delta，
        # 又不会把高频 delta 写进 PG TraceEvent 表。
        assert all(
            e.get("type", "")[_STREAM_PREFIX_LEN:] not in EXCLUDED_FROM_TRACE
            for e in detail_events
        ), "transient events must not enter detail_events (TraceEvent 写库压垮风险)"

        if detail_events:
            _spawn_background_trace_write(
                session_id=session_id,
                thread_id=thread_id,
                events=detail_events,
            )

        if critical_events:
            # W3 §3.3：critical_events 进 trace 前显式 filter 掉 EXCLUDED_FROM_TRACE
            # 类型（content_block_delta 等高频流式 delta），避免 PG TraceEvent 表压垮
            critical_events_for_trace = [
                e for e in critical_events
                if e.get("type", "")[_STREAM_PREFIX_LEN:] not in EXCLUDED_FROM_TRACE
            ]
            if critical_events_for_trace:
                _spawn_background_trace_write(
                    session_id=session_id,
                    thread_id=thread_id,
                    events=critical_events_for_trace,
                )

        # W2-轮 1（PRD 05 §7.4.3 + §7.7）：approval_* 事件审计 / interrupt_state
        # 写入也走异步 fire-and-forget；不阻塞 relay_events ACK。
        # - approval_requested → 写 interrupt_state.pending_approvals[]（W3 crash
        #   resume 前置；本期写 schema，restore 留 W3）
        # - approval_resolved → 更新对应条目 status='resolved' + 每条 ActionRequest
        #   写 1 行 PermissionAudit
        if approval_events:
            spawn_audit_writes(
                session_id=session_id,
                thread_id=thread_id,
                approval_events=approval_events,
            )

        # ：LLM 调用快照异步落 chat_llm_snapshot（fire-and-forget，
        # 失败不 NAK——观测数据，不影响对话正确性）。
        if llm_snapshot_events:
            spawn_llm_snapshot_writes(
                session_id=session_id,
                thread_id=thread_id,
                snapshot_events=llm_snapshot_events,
            )

        processed_at = time.time()
        server_queue_wait_ms = _to_ms(processing_started_at - server_received_at)
        processing_duration_ms = _to_ms(processed_at - processing_started_at)
        nak_code = None if sync_write_ok else (sync_error_code or "unknown")
        record_relay_batch_processed(
            server_queue_wait_ms=server_queue_wait_ms,
            processing_duration_ms=processing_duration_ms,
            sync_ok=sync_write_ok,
            sync_error_code=sync_error_code,
            skipped_reasons=dict(skipped_reasons),
            nak_code=nak_code,
        )

        logger.info(
            "event=relay_batch_received protocol_version=%s legacy_protocol=%s "
            "batch_id_hash=%s session_id_hash=%s request_id_hash=%s "
            "event_count=%d payload_bytes=%d client_created_at=%s "
            "server_received_at=%.3f network_delay_ms=%s server_queue_wait_ms=%d "
            "processing_duration_ms=%d sync_ok=%s skipped_count=%d skipped_reasons=%s "
            "nak_code=%s server_pod=%s client_version=%s "
            "critical=%d detail=%d transient=%d message_ids=%d user_id_hash=%s",
            protocol_version,
            bool(envelope.get("_legacy_protocol")),
            _hash_log_id(payload.get("batch_id")),
            _hash_log_id(session_id),
            _hash_log_id(request_id),
            len(events),
            payload_bytes,
            envelope.get("ts", "-"),
            server_received_at,
            client_network_delay_ms if client_network_delay_ms is not None else "-",
            server_queue_wait_ms,
            processing_duration_ms,
            sync_write_ok,
            skipped,
            dict(skipped_reasons),
            nak_code or "-",
            os.environ.get("HOSTNAME", "-"),
            getattr(consumer, "_ws_client_version", "") or "-",
            len(critical_events),
            len(detail_events),
            transient_count,
            len(message_ids),
            _hash_log_id(consumer.user_id),
        )

        if not sync_write_ok:
            nak_payload: dict[str, Any] = {
                "relayed": relayed,
                "skipped": skipped,
                "error": "sync_write_failed",
                "error_code": sync_error_code or "unknown",
                "retryable": True,
            }
            if message_ids:
                nak_payload["message_ids"] = message_ids
            await consumer._send_envelope(build_envelope(
                "relay_events.nak", request_id,
                nak_payload,
            ))
            # NAK：不广播、不发 DONE 通知——客户端会重试整批
            return

        ack_payload: dict[str, Any] = {
            "relayed": relayed,
            "skipped": skipped,
        }
        if message_ids:
            ack_payload["message_ids"] = message_ids

        await consumer._send_envelope(build_envelope(
            "relay_events.ok", request_id,
            ack_payload,
        ))

        # ACK 之后：直播广播 + DONE 通知（均不阻塞下一帧）
        # ：按连接排除发送方，抑制 relay 同源回环
        sender_channel = getattr(consumer, "channel_name", None) or None
        _spawn_deferred_publishes(
            thread_id,
            coalesce_deferred_publishes(deferred_publishes),
            exclude_channel=sender_channel if isinstance(sender_channel, str) else None,
        )
        if realtime_done_payloads:
            _spawn_deferred_done_notify(
                session_id=session_id,
                done_payloads=realtime_done_payloads,
                message_ids=message_ids,
                fallback_user_id=consumer.user_id or "",
            )

        if accepted_events and _has_memory_trigger_events(accepted_events):
            _spawn_memory_trigger(
                session_id=session_id,
                thread_id=thread_id,
                user_id=consumer.user_id or "",
                accepted_events=accepted_events,
            )

    return handle_relay_events
