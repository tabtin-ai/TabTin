"""
Result Finalizer — 流式执行结果收尾（持久化 + HITL 中断处理）。

从 ChatService 提取的 Stage 6 收尾逻辑：
- 正常路径：assistant 消息持久化 + WS 推送 + Daemon Checkpoint
- Trace 关联

历史云端编排 HITL 路径（``review_required`` / ``ask_user`` 中断收尾）
已随 Wave 11 ``/api/orchestration/agent/{invoke,review,answer}`` 端点下线一并清空：
本地 runtime HITL 走 Daemon → relay 的 ``approval_requested`` / ``ask_choice_required``
/ ``ask_form_required`` / ``request_approval_required`` 统一协议，不再经由本模块。

⚠️ 整模块状态登记（Wave 6 复核 2026-05-06）
-----------------------------------------
``grep`` 整 ``apps/tabtin_django`` 仓库 0 业务 caller —— ``finalize`` /
``persist_success_result`` / ``handle_execution_error`` / ``maybe_retry_pg_persist``
/ ``build_result_dict`` / ``build_model_fields`` 全部 export 都只在本文件内部
互相调用。现网持久化 assistant 消息走 ``relay_message_writer.py`` +
``relay_audit_writer.py``（runtime → Daemon → relay → Django 写 PG），不经过
Django 端 result_finalizer。

整文件实质上是 Wave 11 langgraph 下线后的"整模块死代码"，但本 Wave 6 不删
整文件而保留，理由：
1. 跨文件深度依赖链未清（``conversation_store.save_interrupt`` /
   ``state_types.__interrupt__`` / ``rule_engine.build_interrupt_payload`` /
   ``key_registry`` 登记），删整文件需要同步清理 5+ 文件 + langgraph state
   schema 改动；
2. 范围超出"路径权限治理 + ask_question 收敛"专项；
3. 保守原则——"宁可保守留 vestigial 模块，也不要误删活路径"。

后续单独立项 **L54 Wave 11 langgraph 残骸彻底清理** 时整组（result_finalizer
+ conversation_store.save_interrupt + state_types.__interrupt__ +
rule_engine.build_interrupt_payload）一并移除。
"""

from typing import Dict, Any, List, Optional

import hashlib
import logging
import time

from django.db import close_old_connections, DatabaseError

from apps.services.common.chat_stream_publisher import (
    ChatStreamPublisher as Publisher,
)
from apps.services.agent_engine.services.persistence_pipeline import (
    lookup_latest_trace_id,
    link_trace_to_messages,
)

logger = logging.getLogger(__name__)

__all__ = [
    "build_model_fields",
    "build_result_dict",
    "persist_success_result",
    "finalize",
    "handle_execution_error",
    "maybe_retry_pg_persist",
]


# ──────────────────────────────────────────────
#  辅助
# ──────────────────────────────────────────────

def build_model_fields(model_instance) -> Dict[str, Optional[str]]:
    """从 model_instance 提取 model_id / model_name 标准字段。"""
    return {
        "model_id": str(model_instance.id) if model_instance else None,
        "model_name": model_instance.model_name if model_instance else None,
    }


def build_result_dict(
    assistant_message,
    reply: str,
    model_instance,
    trace_id: Optional[str],
    **extra,
) -> Dict[str, Any]:
    """构建 _process_message_sync_core 标准返回值。"""
    result: Dict[str, Any] = {
        "message_id": str(assistant_message.id),
        "reply": reply,
        **build_model_fields(model_instance),
        "trace_id": str(trace_id) if trace_id else None,
    }
    result.update(extra)
    return result


# ──────────────────────────────────────────────
#  正常路径
# ──────────────────────────────────────────────

def persist_success_result(
    stream_result: Dict[str, Any],
    session,
    user,
    model_instance,
    effective_thread_id: str,
    resolved_agent_name: str,
    user_message_ids_list: list,
    tool_blocks: list,
) -> Dict[str, Any]:
    """成功路径：持久化 assistant 消息 + 推送 + Daemon Checkpoint。"""
    from apps.chat.conversation.models import ChatMessage
    from apps.services.agent_engine.services.daemon_checkpoint_service import DaemonCheckpointService

    final_answer = stream_result["final_answer"]
    run_id = stream_result["run_id"]
    _stream_error_category = stream_result.get("error_category")

    # v0.1 宪法 §5.1：ChatMessage.model 是软引用 UUIDField + property，写入用
    # ``model_id`` 而非 ``model=instance``。本文件 Wave 11 后是死代码（详见 module
    # docstring），保留正确字段名是为了 L54 整组清理重新启用时不再踩跨库 router 雷。
    create_kwargs_assistant: Dict[str, Any] = dict(
        session=session, role="assistant", content=final_answer,
        agent_type=resolved_agent_name,
        model_id=model_instance.id if model_instance else None,
        agent_run_id=run_id or '',
    )
    if _stream_error_category:
        create_kwargs_assistant["intent"] = "error"
    _rich = stream_result.get("rich_content_blocks", [])
    if tool_blocks or stream_result["pending_document_refs"] or _rich:
        create_kwargs_assistant["blocks_json"] = [
            {"type": "text", "text": final_answer},
            *tool_blocks,
            *_rich,
            *stream_result["pending_document_refs"],
        ]

    try:
        assistant_message = ChatMessage.objects.create(**create_kwargs_assistant)
    except DatabaseError as mysql_exc:
        logger.critical(
            "[result_finalizer] MySQL ChatMessage creation failed after PG state saved "
            "(thread=%s): %s — retrying with fresh connection",
            effective_thread_id, mysql_exc, exc_info=True,
        )
        try:
            close_old_connections()
            assistant_message = ChatMessage.objects.create(**create_kwargs_assistant)
        except Exception as retry_exc:
            logger.critical(
                "[result_finalizer] MySQL retry also failed, cross-DB inconsistency: "
                "thread=%s error=%s",
                effective_thread_id, retry_exc, exc_info=True,
            )
            return _handle_persist_failure(
                stream_result, session, model_instance,
                effective_thread_id, resolved_agent_name,
                final_answer, run_id, create_kwargs_assistant,
            )

    trace_id = stream_result.get("trace_id") or lookup_latest_trace_id(effective_thread_id)
    link_trace_to_messages(trace_id, user_message_ids_list, assistant_message)
    session.update_last_message_time()

    _done_metadata: Dict[str, Any] = {}
    if _stream_error_category:
        _done_metadata["error_category"] = _stream_error_category
    _tu_snap = stream_result.get("token_usage_snapshot") or {}
    _run_credits = _tu_snap.get("run_credits_consumed")
    if _run_credits is not None and _run_credits > 0:
        _done_metadata["credits_consumed"] = _run_credits
        _done_metadata["input_tokens"] = _tu_snap.get("run_input_tokens", 0)
        _done_metadata["output_tokens"] = _tu_snap.get("run_output_tokens", 0)
    try:
        Publisher.publish_stream_done(
            effective_thread_id, final_answer,
            message_id=str(assistant_message.id), run_id=run_id,
            metadata=_done_metadata or None,
        )
    except Exception as pub_exc:
        logger.error(
            "[result_finalizer] publish_stream_done failed "
            "(msg already persisted, client will sync): thread=%s err=%s",
            effective_thread_id, pub_exc,
        )

    if _done_metadata:
        try:
            from django.utils import timezone
            ChatMessage.objects.filter(id=assistant_message.id).update(
                metadata=_done_metadata,
                updated_at=timezone.now(),
            )
        except Exception as _meta_exc:
            logger.warning(
                "[result_finalizer] metadata 持久化失败（不影响主流程）: msg=%s err=%s",
                assistant_message.id, _meta_exc,
            )

    if run_id is None:
        run_id = Publisher._lookup_latest_run_id(effective_thread_id)
    Publisher.publish_assistant_event(
        effective_thread_id, "final", final_answer,
        message_id=str(assistant_message.id), run_id=run_id,
    )

    if _stream_error_category:
        _restored = DaemonCheckpointService.maybe_checkpoint_restore_on_error(
            # CO-1：error 自愈切 per-file rewind，anchor = 失败这轮顶层 run_id
            # （stream-error 路径 run_id 在 scope 且上面已兜底非 None）。
            effective_thread_id, user_id=str(user.id), anchor_run_id=run_id,
        )
        if not _restored:
            logger.warning(
                "[result_finalizer] Daemon checkpoint restore failed on stream-error path, "
                "files may be in modified state: thread=%s error_category=%s",
                effective_thread_id, _stream_error_category,
            )
    else:
        DaemonCheckpointService.maybe_checkpoint_commit(
            effective_thread_id, message_id=str(assistant_message.id),
        )

    return build_result_dict(
        assistant_message, final_answer, model_instance, trace_id,
        error_category=_stream_error_category,
    )


def _handle_persist_failure(
    stream_result, session, model_instance,
    effective_thread_id, resolved_agent_name,
    final_answer, run_id, create_kwargs_assistant,
) -> Dict[str, Any]:
    """MySQL 持久化两次失败后的降级处理（Redis fallback）。"""
    _msg_fallback_saved = False
    try:
        from django_redis import get_redis_connection as _get_redis
        _redis = _get_redis("default")
        import json as _json
        _fallback_data = {
            "session_id": str(session.pk),
            "role": "assistant",
            "content": final_answer,
            "agent_type": resolved_agent_name,
            "model_id": str(model_instance.pk) if model_instance else None,
            "agent_run_id": run_id or "",
            "sender_user_id": create_kwargs_assistant.get("sender_user_id", ""),
        }
        if create_kwargs_assistant.get("intent"):
            _fallback_data["intent"] = create_kwargs_assistant["intent"]
        if create_kwargs_assistant.get("blocks_json"):
            _fallback_data["blocks_json"] = create_kwargs_assistant["blocks_json"]
        if create_kwargs_assistant.get("trace_id"):
            _fallback_data["trace_id"] = str(create_kwargs_assistant["trace_id"])
        _fallback_key = f"msg:fallback:{effective_thread_id}:{int(time.time())}"
        _redis.setex(
            _fallback_key, 86400,
            _json.dumps(_fallback_data, ensure_ascii=False).encode("utf-8"),
        )
        _msg_fallback_saved = True
        logger.info(
            "[result_finalizer] MySQL assistant message saved to Redis fallback: key=%s",
            _fallback_key,
        )
    except Exception as _redis_exc:
        logger.error(
            "[result_finalizer] Redis fallback for MySQL message also failed: %s",
            _redis_exc,
        )
    error_msg_id = "err-persist-{}".format(
        hashlib.sha1(
            "{}:{}:{}".format(
                effective_thread_id,
                run_id or "",
                int(time.time()),
            ).encode("utf-8")
        ).hexdigest()[:16]
    )
    Publisher.publish_stream_done(
        effective_thread_id, final_answer,
        message_id=error_msg_id,
        run_id=stream_result.get("run_id"),
        metadata={
            "error_category": "persist_error",
            "has_msg_fallback": _msg_fallback_saved,
        },
    )
    return {
        "message_id": error_msg_id,
        "reply": final_answer,
        **build_model_fields(model_instance),
        "trace_id": stream_result.get("trace_id"),
        "error_category": "persist_error",
    }


# ──────────────────────────────────────────────
#  统一入口
# ──────────────────────────────────────────────

def finalize(
    *,
    stream_result: Dict[str, Any],
    session,
    user,
    model_instance,
    effective_thread_id: str,
    resolved_agent_name: str,
    user_message_ids_list: list,
) -> Dict[str, Any]:
    """Stage 6 统一入口：把 stream_result 持久化为 assistant 消息。

    历史 ``has_interrupt`` / ``has_ask_user`` 分支已随 Wave 11 云端 langgraph 下线 +
    Wave 6 死代码清理一并删除——本地 runtime HITL 走 Daemon → relay 的
    ``approval_requested`` / ``ask_choice_required`` / ``ask_form_required`` /
    ``request_approval_required`` 统一协议，不会经过本入口。任何 stream_result
    携带的旧中断标记字段都会被忽略（fail-silent，避免反向兼容假设）。
    """
    tool_blocks = stream_result.get("_tool_call_blocks") or []
    return persist_success_result(
        stream_result, session, user, model_instance,
        effective_thread_id, resolved_agent_name,
        user_message_ids_list, tool_blocks,
    )


# ──────────────────────────────────────────────
#  Stage 5 错误恢复
# ──────────────────────────────────────────────

def handle_execution_error(
    exc: Exception,
    *,
    session,
    user,
    model_instance,
    effective_thread_id: str,
    resolved_agent_name: str,
    ws_id: str,
    user_message_ids_list: List,
) -> Dict[str, Any]:
    """Agent 执行异常后的统一恢复流程。

    配额退还 → 错误分类 → checkpoint 回滚 → 错误消息持久化 → WS 推送。
    """
    from apps.chat.conversation.models import ChatMessage
    from apps.services.agent_engine.services.daemon_checkpoint_service import DaemonCheckpointService
    from apps.services.agent_engine.observability.error_category import classify_agent_error

    logger.error(
        "[result_finalizer] Agent(%s) call failed: %s",
        resolved_agent_name, exc, exc_info=True,
    )

    _quota_refunded = False
    if ws_id:
        try:
            from apps.users.membership.services.quota_service import decrement_daily_conversation_count
            decrement_daily_conversation_count(ws_id)
            logger.info("[result_finalizer] QTA-24 counter decremented on agent failure: ws=%s", ws_id)
            _quota_refunded = True
        except Exception as decr_exc:
            logger.warning("[result_finalizer] QTA-24 counter decrement failed (non-blocking): %s", decr_exc)

    error_category = classify_agent_error(exc)

    if error_category != "cancelled":
        restored = DaemonCheckpointService.maybe_checkpoint_restore_on_error(
            # CO-1：error 自愈切 per-file rewind。exception 路径无 run_id 在 scope，
            # 用 _lookup_latest_run_id 取失败轮 run_id 作锚点（与下方 _error_run_id 同源）。
            #
            # 已知限制（批次1 复核 P2-2）：_lookup_latest_run_id 仅查 ExecutionRun，而
            # ExecutionRun 当前无落库链路（RunService.start_run 全仓无调用方）→ 此处大概率
            # 恒 None → maybe_checkpoint_restore_on_error 走「无锚点 → 跳过、绝不 reset」
            # 分支 → exception 路径自愈降为**安全 no-op**（不 reset 误伤手改/shell、不
            # over-revert，文件停在失败状态可手动回退）。这相比旧 shadow-git reset --hard
            # 是安全改进。若需 exception 路径真自愈，应在 §3.6 收口时让 ExecutionRun 落库、
            # 或从 agent 执行上下文透传失败轮 run_id——**不可**回退到「最近
            # ChatMessage.agent_run_id」：exception 路径失败轮 assistant 常未落库，会取到
            # 上一轮 → over-revert。
            effective_thread_id, user_id=str(user.id),
            anchor_run_id=Publisher._lookup_latest_run_id(effective_thread_id),
        )
        if not restored:
            logger.warning(
                "[result_finalizer] Daemon checkpoint restore failed on error path, "
                "files may be in modified state: thread=%s",
                effective_thread_id,
            )

    from apps.services.agent_engine.exceptions import RunCancelledError as _RCE
    partial_reply = exc.partial_reply if isinstance(exc, _RCE) else ""
    if partial_reply:
        error_reply = partial_reply
        error_intent = "cancelled_partial"
    else:
        from apps.services.common.i18n import error_generic
        error_reply = error_generic(error_category)
        error_intent = "error"

    # v0.1 宪法 §5.1：同 persist_success_result 改造说明，使用 ``model_id`` 写入。
    assistant_message = ChatMessage.objects.create(
        session=session, role="assistant", content=error_reply,
        agent_type=resolved_agent_name, intent=error_intent,
        model_id=model_instance.id if model_instance else None,
    )
    trace_id = lookup_latest_trace_id(effective_thread_id)
    link_trace_to_messages(trace_id, user_message_ids_list, assistant_message)
    session.update_last_message_time()

    _error_run_id = Publisher._lookup_latest_run_id(effective_thread_id)
    _done_err_metadata: dict = {"error_category": error_category}
    if _quota_refunded:
        _done_err_metadata["quota_refunded"] = True
    try:
        Publisher.publish_stream_done(
            effective_thread_id, error_reply,
            message_id=str(assistant_message.id),
            run_id=_error_run_id,
            metadata=_done_err_metadata,
        )
    except Exception as pub_exc:
        logger.error(
            "[result_finalizer] publish_stream_done failed in error handler "
            "(double-fault prevented): %s",
            pub_exc,
        )

    return build_result_dict(
        assistant_message, error_reply, model_instance, trace_id,
        error_category=error_category,
    )


def maybe_retry_pg_persist(stream_result: Dict[str, Any], effective_thread_id: str) -> None:
    """PG state 首次持久化失败后的补偿重试（原地修改 stream_result）。"""
    if not stream_result.get("pg_persist_failed") or not stream_result.get("pg_final_state"):
        return
    try:
        from apps.services.agent_engine.persistence.conversation_store import ConversationStore
        close_old_connections()
        pg_state = stream_result["pg_final_state"]
        interrupts = pg_state.get("__interrupt__")
        if interrupts:
            interrupt = interrupts[0] if isinstance(interrupts, list) else interrupts
            interrupt_payload = interrupt if isinstance(interrupt, dict) else {}
            ConversationStore.save_interrupt(effective_thread_id, pg_state, interrupt_payload)
        else:
            ConversationStore.save_state(effective_thread_id, pg_state)
        logger.info(
            "[result_finalizer] PG state re-persist succeeded (compensation): thread=%s",
            effective_thread_id,
        )
        stream_result["pg_persist_failed"] = False
    except Exception as pg_retry_exc:
        logger.critical(
            "[result_finalizer] PG state re-persist also failed, potential cross-DB "
            "inconsistency: thread=%s error=%s — MySQL write will proceed "
            "but Agent context may be stale on next turn",
            effective_thread_id, pg_retry_exc, exc_info=True,
        )
