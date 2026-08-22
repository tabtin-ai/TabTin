"""
relay_message_writer — relay_events 关键事件的同步写入器（W3 重组器接管版）。

M2.5 持久化策略：关键消息事件（user/assistant/tool/state_snapshot/done 等）
同步写 DB 后才 ACK，保证 Django 是数据权威。写入成功后返回 server_id 映射，
供客户端替换 temp-id。

== W3 改造（ContentBlockReassembler 接管 assistant 落库） ==

历史链路（Wave 1-2）：daemon emit `agent.stream.assistant(phase='final')` →
relay 直接消费 payload.content + payload.blocks_json → 落库 chat_message。

W3 链路（新）：daemon emit Anthropic 6 件套（`message_*` + `content_block_*`）
→ relay reassembler 重组成 ContentBlock[] → message_stop 触发落库 →
chat_message.content_blocks_json 写入。

W3 兼容期（LITE_COLLECTOR_ENABLED=true，默认）：daemon 端两路并发——既
emit 6 件套又 inject `agent.stream.assistant(phase='final')`。Django 这边
两条路径都进 _write_chat_messages，通过 (session_id, client_event_id)
UniqueConstraint 去重——先到先赢，后到的 IntegrityError 被 catch。

W3 完成后切（LITE_COLLECTOR_ENABLED=false）：daemon 不再 inject，只 emit
6 件套。Django 这边 6 件套唯一路径，由 reassembler 接管落库。

分层写入目标：
  - user 消息 → MySQL ChatMessage（幂等 upsert by client_event_id）
  - assistant 消息（双源）：
    - lite-collector inject 的 `agent.stream.assistant(phase='final')`：走老
      路径 _write_chat_messages（兼容期）
    - daemon 6 件套（message_stop）：走新路径 _write_chat_message_from_reassembler
  - state_snapshot → PG ConversationState（upsert by thread_id）
  - tool/lifecycle/done/approval_requested/approval_resolved/
    ask_choice_required/ask_form_required/request_approval_required
    → PG TraceEvent（与现有 relay_trace_writer 相同管道）
  - lifecycle phase=end/error/cancelled → 触发 reassembler 兜底 finalize（兜底
    路径，partial=True 落库残留 message）

写入失败语义：
  - DB 异常 → 返回 NAK，客户端应重试
  - schema 无效 → 返回 ACK + error_details，客户端丢弃
"""

from __future__ import annotations

import logging
import uuid as uuid_mod
from dataclasses import dataclass, field
from typing import Any

from channels.db import database_sync_to_async
from django.db import IntegrityError, transaction
from django.db.models import F, Q
from django.utils import timezone

from apps.services.common.agent_protocol.constants import AgentStreamEvent
from apps.chat.conversation.services.message_role_policy import (
    persisted_role_for_user_event,
)

# tool_result 合并 / 终态 supersede 的纯逻辑已下沉到 conversation 域的中立模块
# （channels-free），写路径（本模块）与读路径（messages.list 的 _heal_missing_tool_results）
# 共享同一份「幂等合并 + 终态原地替换 + PTY session_id 防串台」实现。这里 re-import
# 让本模块内既有调用点与外部测试 import（`from relay_message_writer import
# _merge_tool_result_block_into_message` 等）保持不变。
from apps.chat.conversation.tool_result_merge import (  # noqa: F401
    _extract_terminal_session_id,
    _is_terminal_tool_result_update,
    _merge_tool_result_block_into_message,
)

logger = logging.getLogger(__name__)


class _StaleForkReplay(Exception):
    """An old client replayed a source message beyond the fork boundary."""


def _resolve_fork_replay_target(
    session_id: str,
    source_message_id: uuid_mod.UUID,
) -> tuple[uuid_mod.UUID | None, bool]:
    """Resolve an old client's source message id inside a direct fork.

    Returns ``(target_message_id, stale_after_fork_boundary)``.  A mapping is
    accepted only when the colliding row belongs to the fork's direct source
    and exactly one copied target row matches its conversation identity.
    """
    from apps.chat.conversation.models import ChatMessage, ChatSession
    from apps.chat.conversation.services.conversation_time import conversation_point

    fork = (
        ChatSession.objects.filter(id=session_id)
        .values("forked_from_id", "fork_point_message_id")
        .first()
    )
    if not fork or not fork.get("forked_from_id"):
        return None, False

    source_message = (
        ChatMessage.objects.filter(
            id=source_message_id,
            session_id=fork["forked_from_id"],
        )
        .only(
            "id",
            "session_id",
            "role",
            "message_kind",
            "arrival_seq",
            "created_at",
            "text_summary",
        )
        .first()
    )
    if source_message is None:
        return None, False

    copied = ChatMessage.objects.filter(
        session_id=session_id,
        role=source_message.role,
        message_kind=source_message.message_kind,
    )
    if source_message.arrival_seq is not None:
        copied = copied.filter(arrival_seq=source_message.arrival_seq)
    else:
        copied = copied.filter(
            created_at=source_message.created_at,
            text_summary=source_message.text_summary,
        )
    candidate_ids = list(copied.values_list("id", flat=True)[:2])
    if len(candidate_ids) == 1:
        return candidate_ids[0], False

    fork_point_message_id = fork.get("fork_point_message_id")
    if not fork_point_message_id:
        return None, False
    fork_point = (
        ChatMessage.objects.filter(
            id=fork_point_message_id,
            session_id=fork["forked_from_id"],
        )
        .only("id", "arrival_seq", "created_at")
        .first()
    )
    if fork_point is None:
        return None, False

    source_key = (*conversation_point(source_message), str(source_message.id))
    fork_key = (*conversation_point(fork_point), str(fork_point.id))
    return None, source_key > fork_key


def _update_or_create_fork_aware_message(
    *,
    chat_message_model,
    session_id: str,
    message_id: uuid_mod.UUID,
    defaults: dict[str, Any],
) -> tuple[Any | None, uuid_mod.UUID | None]:
    """Persist a message, remapping only proven direct-fork replay collisions."""
    try:
        with transaction.atomic():
            message, _ = chat_message_model.objects.update_or_create(
                id=message_id,
                session_id=session_id,
                defaults=defaults,
            )
        return message, message_id
    except IntegrityError:
        fork_target_id, stale_after_boundary = _resolve_fork_replay_target(
            session_id,
            message_id,
        )
        if stale_after_boundary:
            return None, None
        if fork_target_id is None:
            raise
        with transaction.atomic():
            message, _ = chat_message_model.objects.update_or_create(
                id=fork_target_id,
                session_id=session_id,
                defaults=defaults,
            )
        return message, fork_target_id

def _publish_team_space_assets_for_message(message_id: uuid_mod.UUID) -> None:
    """Best-effort publish of explicit Team Space deliverables.

    The service is deliberately conservative: it only creates cloud asset records
    for final assistant answers or content blocks that already carry a FileRecord
    ID. Local paths, terminal logs, screenshots and debug output are ignored.
    """
    try:
        from apps.tabtinspace.services.tabfiles_service import TabFilesService

        TabFilesService.publish_message_assets(message_id)
    except Exception:
        logger.warning(
            "[RelayMessageWriter] publish team space assets failed: message=%s",
            message_id,
            exc_info=True,
        )


# ── Silent drop 告警 logger（运维 ELK / Sentry 按 logger name grouping + alert）──
#
# 业务背景：本模块有 6 处守门式 skip 路径（缺 trace_id / 非法 client_event_id /
# 非法 message_id），原实现仅 ``logger.warning`` 被淹没在普通日志流——2026-05-23
# dogfood 复盘发现 daemon `EnvelopeEmitter.emitDetachedMiniMessage` 默认
# message_id 带 `msg_inline_` 前缀（非法 UUID），导致**所有** widget /
# search_results / cli_output mini-message 自 W1a（2026-05-18）以来一直在
# silently skip 落库——用户重启 Electron 后历史回放看不到任何富内容卡片，
# 但日志层面完全没有红色信号让人察觉。
#
# 修复策略（与 ``apps/services/common/manifest_opens.py:_emit_fallback_alert`` /
# ``apps/services/common/app_registry_check.py:_report_warnings_to_sentry`` 同款）：
# 双管齐下 —— 命名 logger ``relay_message_writer.silent_drop_alert`` (ERROR) +
# sentry_sdk capture_message + tags 便于聚合定位。
_alert_logger = logging.getLogger("relay_message_writer.silent_drop_alert")


def _emit_silent_drop_alert(
    *,
    metric: str,
    reason: str,
    message_id: str,
    session_id: str | None = None,
    role: str | None = None,
    message_kind: str | None = None,
    run_id: str | None = None,
    cid_str: str | None = None,
) -> None:
    """守门式 skip 路径的主动告警上报。

    metric 命名约定（按发生位置 + 错误类型，便于 Sentry / ELK grouping）：
      - ``relay.silent_drop.invalid_message_id``：非法 message_id（已知 P0：
        ``msg_inline_*`` 前缀让 mini-message 永久丢库）
      - ``relay.silent_drop.invalid_client_event_id``：非法 client_event_id
      - ``relay.silent_drop.missing_trace_id``：缺 trace_id 推算 cid
      - 上述三个 metric 各自的 ``.lifecycle_fallback`` 后缀变体——区分主路径
        vs lifecycle phase=end/error/cancelled 兜底路径

    设计纪律（与 manifest_opens._emit_fallback_alert 保持一致）：
      - **不抛异常**：caller 已在 skip 路径上，告警自身故障不能反过来阻断业务
      - **logger / sentry 各自 try/except 静默吞**：avoid 一边失败让另一边也漏告警
      - **不引入新 telemetry 表**：复用现有 logger + Sentry 通道
      - 即便 sentry_sdk 未安装也能正常工作（命名 logger 仍上报）
    """
    # 命名 logger 路径——ERROR level（不是 WARNING，让 ELK alert rule 能命中）
    try:
        _alert_logger.error(
            "[RelayMessageWriter] silent drop: %s reason=%s msg_id=%s "
            "session=%s role=%s kind=%s run=%s",
            metric, reason, message_id, session_id, role, message_kind, run_id,
            extra={
                "metric": metric,
                "tags": {
                    "reason": reason,
                    "message_id": message_id,
                    "session_id": session_id,
                    "role": role,
                    "message_kind": message_kind,
                    "run_id": run_id,
                    "cid_str": cid_str,
                },
            },
        )
    except Exception:
        # 告警 logger 自身故障：吞（不能影响业务路径）
        pass

    try:
        import sentry_sdk
        # 用 push_scope + set_extra 形态聚合上报（与 app_registry_check 同款）——
        # 让 Sentry 同 metric 的多次告警归到一个 issue，避免每条 silent drop
        # 都生成新事件刷屏（dogfood 实测每秒可能上百条 widget skip）。
        with sentry_sdk.push_scope() as scope:
            scope.set_tag("relay.silent_drop.metric", metric)
            scope.set_tag("relay.silent_drop.reason", reason)
            if message_kind:
                scope.set_tag("relay.silent_drop.message_kind", message_kind)
            if role:
                scope.set_tag("relay.silent_drop.role", role)
            scope.set_extra("message_id", message_id)
            scope.set_extra("session_id", session_id)
            scope.set_extra("run_id", run_id)
            scope.set_extra("cid_str", cid_str)
            sentry_sdk.capture_message(
                f"[RelayMessageWriter] silent drop: {metric} ({reason})",
                level="error",
            )
    except Exception:
        # sentry_sdk 未安装 / 未初始化 / capture 失败 → 静默吞（命名 logger 已兜底）
        pass


CRITICAL_EVENT_TYPES: frozenset[str] = frozenset({
    "user",
    "assistant",
    "tool",
    "state_snapshot",
    "done",
    "lifecycle",
    # PRD 05 §7.4 / §7.5：统一审批事件（v0.4 W1.5 一刀切，旧 review_required
    # 已删除，runtime / Django 都不再产生）
    "approval_requested",
    "approval_resolved",
    "ask_choice_required",
    "ask_user_required",
    "ask_form_required",
    "request_approval_required",
    "billing",
    #  A1：消息级持久化——assistant 落库唯一权威通道，critical 同步 upsert。
    # daemon 在「消息完整」边界发整条 ContentBlock[]（含 co-locate 的 tool_result），
    # 单次幂等 update_or_create。6 件套（message_*/content_block_*）不在此集合——
    # 它们是纯转发的流式过程事件（见 constants.EXCLUDED_FROM_TRACE），只 publish
    # 给 observer、不参与落库，避免上万条 delta 堵塞 persist_message 的同步 ACK。
    "persist_message",
})

MESSAGE_EVENT_TYPES: frozenset[str] = frozenset({"user", "assistant"})


def _is_persistable_message(evt: dict) -> bool:
    """user 事件由 _write_chat_messages 老路径落库（保留——daemon 真发 user 事件）。

    assistant 不再走这里——assistant 落库唯一权威是 `persist_message`（，
    整条 ContentBlock[] 权威 upsert）。6 件套已降 transient 纯转发，服务端不再
    从 delta 重建 assistant，本函数只识别 user 短名。
    """
    short = _short_name(evt)
    return short == "user"


@dataclass
class SyncWriteResult:
    """关键事件同步写入的结果。"""
    success: bool = True
    message_ids: list[dict[str, str]] = field(default_factory=list)
    events_written: int = 0
    error: str | None = None
    error_details: list[str] = field(default_factory=list)


def _publish_message_committed(
    *,
    thread_id: str,
    message_id: str,
    server_id: str,
    state_dict: dict[str, Any],
    partial: bool = False,
) -> None:
    """广播 ChatMessage 已落库事实。

    `message_stop` 是 runtime 层"这条 message 说完了"；本事件是后端 DB
    层"历史接口现在可以读到这条 message"。客户端据此做按 message_id 的
    history reconcile，避免在 stop 后抢跑拉到旧页再覆盖实时流。
    """
    try:
        from apps.services.common.chat_stream_publisher import ChatStreamPublisher

        payload: dict[str, Any] = {
            "thread_id": thread_id,
            "message_id": message_id,
            "server_id": server_id,
            "role": state_dict.get("role", "assistant"),
            "message_kind": state_dict.get("message_kind", "llm"),
            "client_event_id": _resolve_client_event_id_for_reassembler(
                message_id=message_id,
                state_dict=state_dict,
            ),
            "partial": bool(partial or state_dict.get("partial")),
            #  去来源：给 Django 自发事件补稳定 event_id（确定性 = server_id），
            # 让客户端 Router 跨源去重收敛 WS resume 重放，无需按来源仲裁。
            "event_id": f"committed:{server_id}",
        }
        run_id = state_dict.get("run_id")
        if run_id:
            payload["run_id"] = run_id
        trace_id = state_dict.get("trace_id")
        if trace_id:
            payload["trace_id"] = trace_id

        ChatStreamPublisher.publish_ws(
            thread_id,
            AgentStreamEvent.MESSAGE_COMMITTED,
            payload,
        )
    except Exception:
        logger.warning(
            "[Reassembler] message_committed 发布失败（不影响已落库消息）: thread=%s msg=%s",
            thread_id, message_id, exc_info=True,
        )


def _finalize_pending_revert_for_relay_user_message(
    session_id: str,
    message_events: list[dict[str, Any]],
) -> bool:
    """写入新用户轮次前，先清算未决的软回退态。作为写入的**原子前置条件**。

    架构迁移后 Electron / Daemon 发消息走本地 runtime → relay 回写，不再经过
    `ChatService._process_message_sync_core` → `_stage_prepare`，导致原本挂在
    `_stage_prepare` 的 `cleanup_reverted_messages` 永不触发：软回退后
    `revert_message_id` 一直残留，`_build_session_rollback_state` 的
    `revert_active` 永久为 true（前端「已回退到历史版本」横幅不消失，且被回退
    的消息从未被物理清理 / PG ConversationState 从未截断）。

    relay 收到真实用户输入消息 == 当前架构下「用户发下一条消息」的权威时刻，
    等价于原 `_stage_prepare` 的触发点。这里在写入新 user 消息**之前**清算，
    复用 Django 既有权威实现（删消息 + PG 截断 + revert_history 落 cleanup 条
    目），幂等（清完 `revert_message_id=None`，再次进入直接跳过）。

    仅对**真实用户输入**触发：排除系统注入的 user 消息——
    `environment_context`、`agent_profile_context`、
    `system_prompt_context`、
    `compaction_summary`，它们不是「用户发新消息」。

    返回值语义（ 根因修复）：
    - True  —— 无需清算（非回退态 / 无真实用户消息）或清算成功；可继续写入。
    - False —— 清算失败。**不再静默吞**：调用方据此 NAK 整批重投，避免把
      残留回退态和被回退的旧消息一起带进新轮次（旧「non-fatal 吞异常」是
      降级：会造成 revert 标记卡死 + 旧消息复活）。cleanup 幂等，重投安全。
    """
    has_real_user_message = any(
        _short_name(evt) == "user"
        and persisted_role_for_user_event(evt.get("payload") or {}) == "user"
        for evt in message_events
    )
    if not has_real_user_message:
        return True

    from apps.chat.conversation.models import ChatSession
    from apps.services.agent_engine.services.persistence_pipeline import (
        cleanup_reverted_messages,
    )

    session = ChatSession.objects.filter(id=session_id).first()
    if not (session and session.revert_message_id):
        return True

    try:
        cleanup_reverted_messages(session)
        return True
    except Exception:
        # fail-loud：清算失败不再吞。整批 NAK 重投（cleanup 幂等），宁可让这一
        # 轮消息稍后重投，也不带残留回退态写库导致横幅卡死 / 旧消息复活。
        logger.error(
            "[relay] finalize pending revert failed session=%s → NAK batch for retry",
            session_id, exc_info=True,
        )
        return False


def _sync_write_critical_events(
    session_id: str,
    thread_id: str,
    user_id: str | None,
    critical_events: list[dict[str, Any]],
) -> SyncWriteResult:
    """同步写入关键事件到 MySQL / PG（在 DB 线程中执行）。

    处理范围：
      - user → MySQL ChatMessage（幂等 upsert by client_event_id）
      - assistant：唯一权威 = `persist_message`（ A1）——daemon 在「消息完整」
        边界发整条 ContentBlock[]（含 co-locate 的 tool_result），单次幂等
        update_or_create（message_id == ChatMessage.id）。6 件套已降 transient
        纯转发（不进 critical、不喂服务端 reassembler 重建），故不再有「message_stop
        主落库 / lifecycle 兜底 finalize」路径。
      - state_snapshot → PG ConversationState（upsert by thread_id）
      - done → 从 DONE payload 提取 usage 原子累加到 ChatSession token 字段

    幂等：assistant 走 `(session, id)`（ChatMessage.id == message_id），user 走
    `(session, client_event_id)`——两路命名空间隔离，IntegrityError 静默兜底。
    """
    result = SyncWriteResult()

    # ── assistant 落库唯一权威 = persist_message（见下方 persist_message_events）──
    # 6 件套（message_*/content_block_*）已降为 transient 纯转发（constants.
    # EXCLUDED_FROM_TRACE），不再进 critical，也不再喂服务端 reassembler 重建落库。
    # 原「message_stop 主落库 / terminal message_delta 兜底 / lifecycle 兜底
    # finalize」三条从 6 件套重建的路径全部删除——它们曾让上万条 delta 占满
    # 同步 ACK 通道、把 persist_message 堵到超时。崩溃恢复由 persist_message 的
    # 本地 transcript 回补覆盖（agent-runtime relay-reconcile），无需服务端重建。

    # ── USER 事件独立路径：daemon emit `agent.stream.user`（带 client_event_id），
    # 在落库边界区分真人 user 与系统作者 system；仍依赖 client_event_id 作 dedup
    # key，与 assistant 的 message_id == ChatMessage.id 命名空间隔离）。
    message_events = [
        e for e in critical_events
        if _short_name(e) in MESSAGE_EVENT_TYPES
        and _is_persistable_message(e)
    ]
    state_events = [
        e for e in critical_events
        if _short_name(e) == "state_snapshot"
    ]
    done_events = [
        e for e in critical_events
        if _short_name(e) == "done"
    ]

    if message_events:
        # 软回退态下，本地 runtime relay 回传的首条真实用户消息 == 「用户发下一条
        # 消息」的权威时刻：在写入新 user 消息前先清算回退态（架构迁移后 _stage_prepare
        # 不再触发，否则 revert_message_id 永不清除）。清算是写入的**原子前置条件**——
        # 清算删的是回退点之后的旧消息，新 user 消息尚未落库不受影响；一旦清算失败
        # （返回 False），NAK 整批重投而不是带残留回退态写库（ 根因：旧路径静默
        # 吞异常，导致回退标记卡死、横幅不消失、旧消息复活）。cleanup 幂等，重投安全。
        if not _finalize_pending_revert_for_relay_user_message(session_id, message_events):
            result.success = False
            result.error_details.append(f"revert_finalize_failed:{session_id}")
            if not result.error:
                result.error = f"revert_finalize_failed for session {session_id}"
            return result
        _write_chat_messages(session_id, user_id, message_events, result)

    #  A1：消息级持久化——daemon 在「消息完整」边界发整条 ContentBlock[]
    # （含 co-locate 的 tool_result）。权威 update_or_create（按 message_id ==
    # ChatMessage.id）：即便 6 件套 reassembler 因 relay 乱序只落了部分块，这里
    # 也用完整块覆盖；reassembler 是 insert-only（冲突即返回），不会反向覆盖本行。
    persist_message_events = [
        e for e in critical_events
        if _short_name(e) == "persist_message"
    ]
    if persist_message_events:
        _write_persist_messages(session_id, user_id, persist_message_events, result)

    if state_events:
        _write_state_snapshots(thread_id, state_events, result)

    if done_events and result.success:
        _accumulate_session_tokens_from_done(session_id, done_events, result)
        # per-turn 计费 metadata（credits / charge_status / token 总计）归到本 run
        # 最后一条 assistant 消息，让重开历史对话也能回显「已消费 X 点券」+ 每条
        # 费用标注。与上面的 session token 累加正交：token 走 ChatSession（累加），
        # 上下文规模走 ChatMessage.usage_json（per-call），计费走 ChatMessage.metadata
        # （per-turn，幂等 SET 合并）。
        _attach_cost_metadata_from_done(session_id, done_events, result)

    return result


def _short_name(evt: dict) -> str:
    event_type = evt.get("type", "")
    prefix = "agent.stream."
    if event_type.startswith(prefix):
        return event_type[len(prefix):]
    return event_type


def _write_chat_messages(
    session_id: str,
    user_id: str | None,
    events: list[dict[str, Any]],
    result: SyncWriteResult,
) -> None:
    """幂等写入 USER 事件对应的 user/system ChatMessage。

    逐条处理，单条失败 continue 继续后续消息（非 return），
    确保批次内尽可能多写入。
    """
    from apps.chat.conversation.models import ChatMessage, ChatSession

    has_new_user_message = False

    for evt in events:
        payload = evt.get("payload") or {}
        short = _short_name(evt)
        client_event_id_str = payload.get("client_event_id")

        if not client_event_id_str:
            _emit_silent_drop_alert(
                metric="relay.silent_drop.missing_client_event_id.legacy",
                reason=f"{short} event 缺 client_event_id（老 assistant final 路径）",
                message_id=str(payload.get("message_id") or ""),
                session_id=session_id,
                role="user" if short == "user" else "assistant",
            )
            continue

        try:
            client_event_uuid = uuid_mod.UUID(client_event_id_str)
        except (ValueError, TypeError):
            _emit_silent_drop_alert(
                metric="relay.silent_drop.invalid_client_event_id.legacy",
                reason=f"{short} event 的 client_event_id 不是合法 UUID4（老 assistant final 路径）",
                message_id=str(payload.get("message_id") or ""),
                session_id=session_id,
                role="user" if short == "user" else "assistant",
                cid_str=client_event_id_str,
            )
            continue

        if short == "user":
            role = persisted_role_for_user_event(payload)
        else:
            role = "assistant"
        content = payload.get("content") or ""
        if isinstance(content, list):
            text_parts = []
            for block in content:
                if isinstance(block, dict) and block.get("type") == "text":
                    text_parts.append(block.get("text", ""))
                elif isinstance(block, str):
                    text_parts.append(block)
            content = "\n".join(text_parts) if text_parts else ""

        try:
            msg = _upsert_chat_message(
                session_id=session_id,
                client_event_uuid=client_event_uuid,
                role=role,
                content=content,
                payload=payload,
                user_id=user_id,
                client_event_id_str=client_event_id_str,
            )
            result.message_ids.append({
                "client_event_id": client_event_id_str,
                "server_id": str(msg),
            })
            result.events_written += 1
            if role == "user":
                has_new_user_message = True

        except _StaleForkReplay:
            logger.warning(
                "[RelayMessageWriter] 丢弃 fork 边界后的旧 user 重放: "
                "session=%s event=%s",
                session_id,
                client_event_id_str,
            )
            continue
        except Exception:
            logger.error(
                "[RelayMessageWriter] ChatMessage 写入失败: session=%s event=%s",
                session_id, client_event_id_str, exc_info=True,
            )
            result.success = False
            result.error_details.append(f"db_write_error:{client_event_id_str}")
            if not result.error:
                result.error = f"db_write_error for {client_event_id_str}"
            continue

    if has_new_user_message:
        try:
            ChatSession.objects.filter(id=session_id).update(
                last_message_at=_now(),
            )
        except Exception:
            logger.warning(
                "[RelayMessageWriter] update last_message_at failed: session=%s",
                session_id, exc_info=True,
            )


def _write_persist_messages(
    session_id: str,
    user_id: str | None,
    events: list[dict[str, Any]],
    result: SyncWriteResult,
) -> None:
    """#1454 A1：消息级持久化——assistant 落库唯一权威路径。

    daemon 在「消息完整」边界发整条 ContentBlock[]（text + tool_use + 本轮
    co-locate 的 tool_result），本函数走 `update_or_create`（按 `id == message_id`）
    一次性权威落库。6 件套已降 transient 纯转发，不再有服务端 reassembler 重建，
    tool_result 已在 blocks 内 co-locate，无需增量 merge。

    幂等：同 message_id 重发（daemon retry / WS replay / 本地 transcript 回补）
    只是再 update 一次同内容。
    """
    from apps.chat.conversation.models import ChatMessage, ChatSession
    from .content_block_reassembler import derive_text_summary

    session_agent_id = (
        ChatSession.objects.filter(id=session_id)
        .values_list('agent_id', flat=True)
        .first()
    )

    for evt in events:
        payload = evt.get("payload") or {}
        message_id_str = payload.get("message_id")
        blocks = payload.get("blocks_json")
        role = payload.get("role") or "assistant"
        if role == "user":
            role = persisted_role_for_user_event(payload)
        if not message_id_str or not isinstance(blocks, list):
            continue
        error_info = payload.get("error_info_json") or payload.get("error_info")
        if (
            role == "assistant"
            and not blocks
            and not isinstance(error_info, dict)
            and payload.get("message_kind") != "hitl_interaction"
        ):
            continue
        try:
            message_id_uuid = uuid_mod.UUID(str(message_id_str))
        except (ValueError, TypeError):
            logger.warning(
                "[RelayMessageWriter] persist_message message_id 非 UUID，跳过: session=%s msg=%s",
                session_id, message_id_str,
            )
            continue

        # 落库契约：runtime `blocks_json` 原样写入，禁止服务端改写块字段
        # （含用 persist 时刻 / 墙钟盖 arrival_seq、或从旧行回填 arrival 盖到新内容上）。
        # 块级 arrival 由 runtime 在 emit 时带齐；缺省保持缺省，前端时间线自有回落。
        metadata: dict[str, Any] = {
            "_persisted_via": "persist_message",
            # a1 标记：本行整条已含 co-locate 的 tool_result（历史下游据此识别
            # 消息级完整落库，无需增量 merge）。
            "a1_message_level": True,
        }
        if isinstance(payload.get("metadata"), dict):
            metadata.update(payload["metadata"])
        _merge_payload_metadata_string_fields(metadata, payload)
        if payload.get("partial"):
            metadata["partial"] = True

        # HITL transcript：runtime 发的 hitl_interaction persist 带**原始** payload
        # （runtime 不知观众身份）。ChatMessage 对全会话成员可见——team space 场景
        # tool_approval 的工具入参 / 命令细节只给 execution owner，故在此出站边界脱敏
        # （与 pending_interaction_service._sync 的 thread 广播口径一致）。owner 的完整
        # 明细仍走本机 IPC / owner user event 快路径（不经此 DB 行）。
        if payload.get("message_kind") == "hitl_interaction":
            hitl = metadata.get("hitl")
            if isinstance(hitl, dict) and hitl.get("kind") == "tool_approval":
                inner = hitl.get("payload")
                if isinstance(inner, dict):
                    from apps.services.agent_engine.services.pending_interaction_service import (
                        redact_team_space_tool_approval_payload,
                    )
                    hitl["payload"] = redact_team_space_tool_approval_payload(inner)

        defaults: dict[str, Any] = {
            "role": role,
            "content_blocks_json": blocks,
            "text_summary": derive_text_summary(blocks) or "",
            "stop_reason": payload.get("stop_reason") or "",
            "subagent_run_id": payload.get("subagent_run_id") or "",
            "message_kind": payload.get("message_kind") or "llm",
            "metadata": metadata,
        }
        if isinstance(error_info, dict):
            defaults["error_info_json"] = error_info
        # ：本轮实际模型（Codex 字面量 / BYOK·平台 UUID）。snapshot 始终可写；
        # model_id FK 仅「合法 UUID 且 LLMModel 存在」才写，避免非 UUID / 幽灵 UUID 炸 FK。
        model_id_str = payload.get("model_id")
        model_name_raw = payload.get("model_name") or payload.get("model_name_snapshot")
        if isinstance(model_name_raw, str) and model_name_raw.strip():
            defaults["model_name_snapshot"] = model_name_raw.strip()[:100]
        elif isinstance(model_id_str, str) and model_id_str.strip():
            defaults["model_name_snapshot"] = model_id_str.strip()[:100]
        if isinstance(model_id_str, str) and model_id_str.strip():
            try:
                model_uuid = uuid_mod.UUID(model_id_str.strip())
            except (ValueError, TypeError):
                model_uuid = None
            if model_uuid is not None:
                try:
                    from apps.services.llm.models import LLMModel

                    if LLMModel.objects.filter(id=model_uuid).exists():
                        defaults["model_id"] = model_uuid
                except Exception:
                    logger.debug(
                        "[RelayMessageWriter] skip model_id FK resolve: session=%s model=%s",
                        session_id,
                        model_id_str,
                        exc_info=True,
                    )
        # ：runtime PersistMessageEvent 领域字段 agent_run_id（与 lifecycle
        # run_id 同源、字段名即 ChatMessage 列契约）。权威落库必须透传——此前只
        # 在兼容路径 _upsert_chat_message 写过（ 双路径漂移），主路径漏写
        # 导致回退预览恒报「缺少 agent_run_id」。只读已正确命名的字段，不做
        # run_id → agent_run_id 改名映射。
        agent_run_id = payload.get("agent_run_id")
        if isinstance(agent_run_id, str) and agent_run_id.strip():
            defaults["agent_run_id"] = agent_run_id.strip()
        if role == 'assistant' or defaults["message_kind"] == 'tool_artifact':
            raw_agent_id = payload.get("agent_id") or session_agent_id
            if raw_agent_id:
                try:
                    defaults["agent_id"] = uuid_mod.UUID(str(raw_agent_id))
                except (ValueError, TypeError):
                    logger.warning(
                        "[RelayMessageWriter] persist_message agent_id 非 UUID，忽略: session=%s agent=%s",
                        session_id,
                        raw_agent_id,
                    )
        #  对话时间权威：persist_message 重投（RelayRetryQueue recover /
        # transcript 兜底重建）时 created_at 是补投时刻——arrival_seq 才是对话时间。
        from apps.chat.conversation.services.conversation_time import resolve_message_arrival_seq
        _persist_arrival = resolve_message_arrival_seq(payload, blocks)
        if _persist_arrival is not None:
            defaults["arrival_seq"] = _persist_arrival
        cid = payload.get("client_event_id")
        if cid:
            try:
                defaults["client_event_id"] = uuid_mod.UUID(str(cid))
            except (ValueError, TypeError):
                pass
        trace_id = payload.get("trace_id")
        if trace_id:
            try:
                defaults["trace_id"] = uuid_mod.UUID(str(trace_id))
            except (ValueError, TypeError):
                pass

        try:
            persisted_message, server_message_id = _update_or_create_fork_aware_message(
                chat_message_model=ChatMessage,
                session_id=session_id,
                message_id=message_id_uuid,
                defaults=defaults,
            )
            if persisted_message is None or server_message_id is None:
                logger.warning(
                    "[RelayMessageWriter] 丢弃 fork 边界后的旧会话重放: "
                    "session=%s source_msg=%s",
                    session_id,
                    message_id_str,
                )
                continue
            if role == 'assistant' and defaults['message_kind'] in {'llm', 'tool_artifact'}:
                try:
                    from apps.tabtinspace.services.project_task_runtime import (
                        refresh_latest_review_result_from_delivery,
                        refresh_review_result_from_delivery,
                    )

                    if defaults['message_kind'] == 'llm':
                        refresh_review_result_from_delivery(
                            session_id=session_id,
                            assistant_message_id=str(persisted_message.id),
                            summary=persisted_message.text_summary,
                        )
                    else:
                        # Relay 可乱序抵达：若交付气泡晚于最终回复落库，按 arrival_seq
                        # 回看该最终回复，避免 TaskRun 停留在旧候选。
                        refresh_latest_review_result_from_delivery(session_id=session_id)
                except Exception:
                    # 交付快照是 Task 会话的派生视图；绝不让它阻断聊天消息的权威落库。
                    logger.exception(
                        '[RelayMessageWriter] project task review result refresh failed: session=%s msg=%s',
                        session_id,
                        message_id_str,
                    )
            try:
                from apps.chat.conversation.services.workspace_file import (
                    index_message_workspace_file_refs,
                )

                index_message_workspace_file_refs(persisted_message)
            except Exception:
                # 共享预览索引是派生数据；绝不阻断权威消息落库。
                logger.exception(
                    '[RelayMessageWriter] workspace file ref index failed: session=%s msg=%s',
                    session_id,
                    message_id_str,
                )
            result.events_written += 1
            result.message_ids.append({
                "client_event_id": str(cid or message_id_str),
                "server_id": str(server_message_id),
            })
            # 落库事实广播：原在 reassembler `message_stop` 落库路径发；该路径随
            # 「6 件套降 transient」删除后，message_committed 搬迁到唯一权威落库点
            # （persist_message）。observer 端据此在流结束后从 DB reconcile 到权威
            # 落库版本（stop 后不抢跑拉旧页覆盖 live 流）。
            _publish_message_committed(
                thread_id=f"chat-session-{session_id}",
                message_id=str(server_message_id),
                server_id=str(server_message_id),
                state_dict={
                    "role": role,
                    "message_kind": payload.get("message_kind") or "llm",
                    "run_id": (
                        payload.get("agent_run_id")
                        or payload.get("run_id")
                        or payload.get("subagent_run_id")
                        or ""
                    ),
                    "trace_id": str(trace_id) if trace_id else None,
                    "partial": bool(payload.get("partial")),
                },
                partial=bool(payload.get("partial")),
            )
        except Exception:
            logger.error(
                "[RelayMessageWriter] persist_message 写入失败: session=%s msg=%s",
                session_id, message_id_str, exc_info=True,
            )
            result.success = False
            result.error_details.append(f"persist_message_write_error:{message_id_str}")
            if not result.error:
                result.error = f"persist_message_write_error for {message_id_str}"
            continue


_PAYLOAD_METADATA_STRING_FIELDS: tuple[str, ...] = (
    "tool_call_id",
    "triggered_by",
    # ：assistant 自身的 client_event_id / run_id 都不是来源 user 身份。
    # Host 在主轮事件顶层注入本字段，历史消息必须把它收进 metadata 才能让
    # 移动端重启后继续做精确对账。
    "source_client_event_id",
)


def _merge_payload_metadata_string_fields(
    metadata: dict[str, Any],
    payload: dict,
) -> dict[str, Any]:
    """把协议顶层稳定字符串字段白名单并入消息 metadata（不覆盖显式 metadata）。"""
    for field_name in _PAYLOAD_METADATA_STRING_FIELDS:
        if field_name in metadata:
            continue
        value = payload.get(field_name)
        if isinstance(value, str) and value:
            metadata[field_name] = value
    return metadata


def build_chat_message_metadata(
    payload: dict,
    client_event_id_str: str,
) -> dict[str, Any]:
    """为 ChatMessage.metadata 构造合并后的 dict。

    Wave 2h D-2：保留原始 `source` 标识（如 `skill_invoke`），不再无差别覆盖。

    背景：runtime `query.ts` 在 skill `newMessages` 注入时 yield 的
    `agent.stream.user` event 带有 `payload.source = 'skill_invoke'`（顶层），
    前端 streamMessageHandler 会把它写进 `ChatMessage.metadata.source`，供
    MessageBubble 渲染 "Skill 指令" 徽章（见 MessageBubble.tsx L103-L116）。

    但 session 刷新后前端从 Django 拉消息，如果这里把 `source` 硬覆盖成
    `relay_events`，徽章就消失——skill 来源信息永久丢失。

    策略：
      1. 保留 payload 里原有 metadata 的全部字段（skill_id / skill_version 等
         未来扩展也一并保留，不做字段白名单）；
      2. `source` 优先走业务语义：`metadata.source` > `payload.source` >
         `'relay_events'`（兜底）；
      3. 写 `_persisted_via = 'relay_events'` 系统标记，让排障时能明确"这条
         是 relay 管道写入"，不污染业务 `source`。

    纯函数：不调 DB，只做 dict 构造，方便单元测试。
    """
    metadata = dict(payload.get("metadata") or {})
    existing_meta_source = metadata.get("source")
    payload_source = payload.get("source")
    preserved_source = existing_meta_source or payload_source
    if preserved_source and preserved_source != "relay_events":
        metadata["source"] = preserved_source
    else:
        metadata["source"] = "relay_events"
    metadata["_persisted_via"] = "relay_events"
    metadata["client_event_id"] = client_event_id_str

    # W14 / push 通知 / ：顶层协议字段按白名单收进历史 metadata。
    return _merge_payload_metadata_string_fields(metadata, payload)


def _upsert_chat_message(
    *,
    session_id: str,
    client_event_uuid: uuid_mod.UUID,
    role: str,
    content: str,
    payload: dict,
    user_id: str | None,
    client_event_id_str: str,
) -> uuid_mod.UUID:
    """幂等创建 ChatMessage，返回 server_id（UUID）。

    W3 适配（兼容路径，处理 lite-collector inject 的 assistant.final）：
    - 老 `blocks_json` → 写入新字段 `content_blocks_json`（语义同 ContentBlock[]，
      lite-collector 桥已经在 daemon 端组装好）
    - 老 `content` → 写入新字段 `text_summary`（用入参 content；assistant
      路径 lite-collector 已累积好；user 路径直接是用户输入文本）
    - 老 `attachments_json` → 已下线，并入 content_blocks_json 的 image/document 块；
      此处不再单独写字段
    - 旧版本字段（agent_type / intent / intent_confidence）→ 已 drop，不再写

    策略：直接 try create + catch IntegrityError → 二次查询。
    避免 TOCTOU 竞态。
    """
    from apps.chat.conversation.models import ChatMessage

    metadata = build_chat_message_metadata(payload, client_event_id_str)
    if role == "assistant":
        try:
            from apps.services.agent_execution.team_space_execution import (
                resolve_message_execution_metadata,
            )

            metadata.update(
                resolve_message_execution_metadata(
                    session_id,
                    run_id=str(payload.get("run_id") or "") or None,
                )
            )
        except Exception:
            logger.debug(
                "[RelayMessageWriter] team-space execution metadata resolution failed: session=%s",
                session_id,
                exc_info=True,
            )

    create_kwargs: dict[str, Any] = {
        "session_id": session_id,
        "role": role,
        "client_event_id": client_event_uuid,
        "metadata": metadata,
        # W3：text_summary 兜底——content 是 lite-collector 桥拼好的纯文本
        "text_summary": (content or "")[:200] if content else "",
    }

    if role == "user" and user_id:
        create_kwargs["sender_user_id"] = user_id

    # 单一身份收口（ → ）：user 消息落库 id 与客户端身份对齐，
    # 消除 client_event_id≠server_id 的身份分裂——前端 live/乐观副本与落库副本
    # 从创建起就同一个 id，不需要 ACK 事后 remap，也不需要前端多套子集去重。
    #   - 合成 user（turn 内 push 通知）带合法 UUID message_id → 用它作 id，
    #     对齐 assistant「daemon message_id == ChatMessage.id」语义。
    #   - 普通用户输入不带 message_id，但带 client_event_id（= 前端乐观气泡的
    #     client_message_id）→ 用它作 id。client_event_uuid 恒为合法 UUID（调用前
    #     已校验），与 (session, client_event_id) 唯一约束天然对齐；幂等重投时
    #     撞 id PK / client_event_id 约束都由 IntegrityError 兜底复用同一行。
    if role in {"user", "system"}:
        message_id_str = payload.get("message_id")
        resolved_id: uuid_mod.UUID | None = None
        if message_id_str:
            try:
                resolved_id = uuid_mod.UUID(str(message_id_str))
            except (ValueError, TypeError):
                resolved_id = None
        if resolved_id is None:
            resolved_id = client_event_uuid
        create_kwargs["id"] = resolved_id

    # W3：blocks_json → content_blocks_json 字段重命名
    # lite-collector 桥在 daemon 端已经按 ContentBlock[] schema 组装（含 text /
    # tool_use / tool_result / thinking / tabtin_rich_content 等块类型），
    # 这里直接落到新字段
    blocks = payload.get("blocks_json")

    #  对话时间权威：落到 ChatMessage.arrival_seq 列（回退边界据此计算，
    # 免疫 relay 迟到重投导致的 created_at 乱序）。
    from apps.chat.conversation.services.conversation_time import resolve_message_arrival_seq
    message_arrival_seq = resolve_message_arrival_seq(payload, blocks)
    if message_arrival_seq is not None:
        create_kwargs["arrival_seq"] = message_arrival_seq

    # 落库契约：blocks 只认 runtime / daemon 下发的 `blocks_json`，服务端绝不合成
    # 或改写。缺 blocks 时保持空——调用方必须在 emit 侧带齐（见 runtime
    # `buildUserEventBlocks` / `emitMainUserEventPhase`）。
    if isinstance(blocks, list):
        create_kwargs["content_blocks_json"] = blocks
        from .content_block_reassembler import derive_text_summary
        create_kwargs["text_summary"] = derive_text_summary(blocks) or create_kwargs["text_summary"]

    #  引用回复：user 路径透传被引用消息。reply_to 是 self-FK（同 session），
    # 被引用消息可能已被回退删除 → 用 reply_to_id 直接赋值（不校验存在性；DB 层
    # SET_NULL 语义由删除时触发，写入时若指向已删消息会 IntegrityError，故先探测）。
    # reply_to_preview 是与被引用消息同源的展示快照，无论 FK 是否悬空都落库。
    if role == "user":
        reply_to_message_id = payload.get("reply_to_message_id")
        if reply_to_message_id:
            try:
                reply_to_uuid = uuid_mod.UUID(str(reply_to_message_id))
                # 仅当被引用消息仍存在于同 session 时挂 FK，避免 IntegrityError；
                # 已删除时只保留 preview 快照（气泡靠快照兜底显示）。
                if ChatMessage.objects.filter(
                    id=reply_to_uuid, session_id=session_id,
                ).exists():
                    create_kwargs["reply_to_id"] = reply_to_uuid
            except (ValueError, TypeError):
                pass
        reply_to_preview = payload.get("reply_to_preview")
        if isinstance(reply_to_preview, dict):
            create_kwargs["reply_to_preview"] = reply_to_preview

    #  /  /  / ：user 路径的 message_kind 透传。默认 'llm'；
    # 只接受 user 角色合法的内部 kind，避免误写：
    # - environment_context / agent_profile_context：注入消息（对 UI 隐藏，仍喂 LLM）
    # - system_prompt_context：审计落库（对 UI 隐藏；#8550 起不进 LLM 历史）
    # - compaction_summary：压缩检查点（UI 分隔 pill；禁止当普通用户气泡）
    payload_message_kind = payload.get("message_kind")
    if role in {"user", "system"} and payload_message_kind in {
        "environment_context",
        "agent_profile_context",
        "external_archive_context",
        "system_prompt_context",
        "compaction_summary",
    }:
        create_kwargs["message_kind"] = payload_message_kind

    agent_run_id = payload.get("agent_run_id")
    if agent_run_id:
        create_kwargs["agent_run_id"] = str(agent_run_id)

    trace_id = payload.get("trace_id")
    if trace_id:
        try:
            create_kwargs["trace_id"] = uuid_mod.UUID(trace_id)
        except (ValueError, TypeError):
            pass

    # W3 新字段：从 payload 透传（lite-collector 路径有些字段不会传——留空 default）
    for field_name in (
        "model_name_snapshot", "stop_reason", "subagent_run_id",
    ):
        v = payload.get(field_name)
        if v:
            create_kwargs[field_name] = v

    # model_id（UUID 软引用 LLMModel）—— 优先用 payload 透传的 model_id，否则
    # lite-collector 桥的 model_id 是 daemon 端的 backend model id（字符串非 UUID）
    # 此时不写入 model_id 字段，避免无效 UUID 写库
    model_id_str = payload.get("model_id")
    if model_id_str:
        try:
            create_kwargs["model_id"] = uuid_mod.UUID(model_id_str)
        except (ValueError, TypeError):
            # daemon backend model id（如 'tabtin-tool-runtime'）不是 UUID，跳过
            pass

    # usage_json / error_info_json（仅 assistant 路径需要）
    usage = payload.get("usage")
    if isinstance(usage, dict):
        create_kwargs["usage_json"] = usage
    error_info = payload.get("error_info_json") or payload.get("error_info")
    if isinstance(error_info, dict):
        create_kwargs["error_info_json"] = error_info

    try:
        with transaction.atomic():
            msg = ChatMessage.objects.create(**create_kwargs)
        _publish_team_space_assets_for_message(msg.id)
        return msg.id
    except IntegrityError:
        existing = ChatMessage.objects.filter(
            session_id=session_id,
            client_event_id=client_event_uuid,
        ).values_list("id", flat=True).first()
        if existing:
            _publish_team_space_assets_for_message(existing)
            return existing
        replayed_source_id = create_kwargs.get("id")
        if isinstance(replayed_source_id, uuid_mod.UUID):
            fork_target_id, stale_after_boundary = _resolve_fork_replay_target(
                session_id,
                replayed_source_id,
            )
            if fork_target_id is not None:
                _publish_team_space_assets_for_message(fork_target_id)
                return fork_target_id
            if stale_after_boundary:
                raise _StaleForkReplay from None
        raise


# ────────────────────────────────────────────────────────────────────────
# W3 主路径：ContentBlockReassembler 触发的 6 件套消费 → ChatMessage 落库
# ────────────────────────────────────────────────────────────────────────


def _resolve_client_event_id_for_reassembler(
    *,
    message_id: str,
    state_dict: dict[str, Any],
) -> str | None:
    """为 reassembler finalize 出的 message 解析 client_event_id（幂等去重键）。

    **三端单一 UUID 贯穿**（W4.5 §服务端 ID 命名空间统一）：daemon emit 的
    `message_id` 本身就是合法 UUID4——直接当 client_event_id 用，让
    `(session_id, client_event_id)` 唯一约束的语义对齐"daemon emit 的同一
    message 不重复落库"，daemon retry / WS replay 撞同一 message_id 时
    UniqueConstraint 真去重。

    优先级：
    1. `state_dict['client_event_id']`：保留位（未来 wire schema 升级若引入
       独立 cid 字段时切到此分支，行为向前兼容）
    2. `message_id` 本身——主路径，直接返回（daemon UUID4 单一来源）

    返回 None 仅当 message_id 缺失（envelope 异常，几乎不可能发生）。
    """
    cid = state_dict.get('client_event_id')
    if cid:
        return str(cid)
    if not message_id:
        return None
    return message_id


def _safe_token_int(v: Any) -> int:
    """从 usage dict 取出的值安全转 int，非正数返回 0。"""
    return int(v) if isinstance(v, (int, float)) and v > 0 else 0


def _accumulate_session_tokens_from_done(
    session_id: str,
    done_events: list[dict[str, Any]],
    result: SyncWriteResult,
) -> None:
    """从 DONE payload 提取 usage 并原子累加到 ChatSession token 字段。

    PRD-04 Phase 4 T4.2：修复本地 runtime 路径 ChatSession.input_tokens /
    output_tokens / total_tokens 无写入者的问题（现状 D6）。

    DONE 中的 usage 是 per-run 的（每次 runtime.query() 产生一个独立 EngineState），
    同一 session 内用户发多条消息 = 多次 run，因此用 F() 原子累加。
    遍历全部 done_events 而非只取最后一个，覆盖同批含多个 DONE 的极端场景。

    幂等保护（Wave 4 P0）：DONE 事件无 client_event_id，relay 重试会导致
    F() 双倍累加。用 cache.add (Redis SETNX) 按 (session_id, trace_id) 做
    原子幂等锁；DB 更新失败时释放锁允许下次重试。

    W3 §11.5 计费 metering 改造说明：
    chat_message.usage_json 字段已由 reassembler 主路径 + _upsert_chat_message
    兼容路径在落库时写入（来自 message_delta.usage 累积值，cumulative 语义）；
    后续 BillingUsageEvent / LLMUsageFact / 报表统计可直接 SQL 读
    chat_message.usage_json 字段而非旧 metadata.usage 子键。本函数继续从 DONE
    event payload 取 usage 累加 ChatSession token —— 因为 ChatSession 累计
    与 chat_message.usage_json 是不同维度（前者是 session 总和，后者是单条消息），
    避免引入"两源累加双计"风险。
    """
    from django.core.cache import cache
    from apps.chat.conversation.models import ChatSession

    deduped_events: list[dict[str, Any]] = []
    acquired_keys: list[str] = []
    for evt in done_events:
        payload = evt.get("payload") or {}
        trace_id = payload.get("trace_id")
        if isinstance(trace_id, str) and trace_id:
            cache_key = f"relay_done_dedup:{session_id}:{trace_id}"
            try:
                if not cache.add(cache_key, "1", timeout=3600):
                    logger.info(
                        "[RelayMessageWriter] DONE trace_id=%s 已处理，跳过 token 累加: session=%s",
                        trace_id, session_id,
                    )
                    continue
                acquired_keys.append(cache_key)
            except Exception:
                pass
        deduped_events.append(evt)

    if not deduped_events:
        return

    add_in = 0
    add_out = 0
    add_cache_read = 0
    add_cache_creation = 0
    for evt in deduped_events:
        payload = evt.get("payload") or {}
        usage = payload.get("usage")
        if not isinstance(usage, dict):
            continue
        # input_tokens 为「按输入计费」的非 cache 部分；cache 单价不同故单列累加，
        # 不并入 input_tokens / total_tokens。
        add_in += _safe_token_int(usage.get("input_tokens"))
        add_out += _safe_token_int(usage.get("output_tokens"))
        add_cache_read += _safe_token_int(usage.get("cache_read_input_tokens"))
        add_cache_creation += _safe_token_int(usage.get("cache_creation_input_tokens"))

    if add_in == 0 and add_out == 0 and add_cache_read == 0 and add_cache_creation == 0:
        return

    if len(deduped_events) > 1:
        logger.info(
            "[RelayMessageWriter] 同批含 %d 个 DONE event: session=%s",
            len(deduped_events), session_id,
        )

    update_kwargs: dict[str, Any] = {}
    if add_in:
        update_kwargs["input_tokens"] = F("input_tokens") + add_in
    if add_out:
        update_kwargs["output_tokens"] = F("output_tokens") + add_out
    if add_cache_read:
        update_kwargs["cache_read_input_tokens"] = F("cache_read_input_tokens") + add_cache_read
    if add_cache_creation:
        update_kwargs["cache_creation_input_tokens"] = F("cache_creation_input_tokens") + add_cache_creation
    update_kwargs["total_tokens"] = F("total_tokens") + add_in + add_out

    try:
        ChatSession.objects.filter(id=session_id).update(**update_kwargs)
    except Exception:
        for key in acquired_keys:
            try:
                cache.delete(key)
            except Exception:
                pass
        logger.error(
            "[RelayMessageWriter] ChatSession token 累加失败: session=%s",
            session_id, exc_info=True,
        )


#: DONE.usage 中可作为「计费 metadata」落库的 per-turn token 字段。
#: **不含** `last_*`（那是 per-call 上下文规模，归 ChatMessage.usage_json，由
#: reassembler 落库；前端上下文用量环优先读 usage_json，metadata 仅兜底）。
#: 与前端 `host/cost-metadata-builder.ts` extractCostMetadataFromUsage 的字段口径
#: 对齐（减去 last_*），保证活态 onDone 写入与服务端落库回灌后形态一致。
_BILLING_TOKEN_KEYS = (
    "input_tokens",
    "output_tokens",
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
    "reasoning_tokens",
    "compact_input_tokens",
    "compact_output_tokens",
)


def _extract_billing_metadata_from_usage(usage: dict[str, Any]) -> dict[str, Any]:
    """从 DONE.usage 提取「计费 metadata」子集（per-turn 维度）。

    输出字段与前端 `extractCostMetadataFromUsage`（减 last_*）一致：
      - `credits_consumed`：cost_usd > 0 时写入
      - `charge_failed` / `is_byok`：按 charge_status 派生
      - per-turn token 总计（_BILLING_TOKEN_KEYS）：供 MessageCostLabel tooltip /
        ring「会话累计」分项展示

    空输入或无可提取字段 → 返回空 dict（调用方据此判断是否落库）。
    """
    result: dict[str, Any] = {}
    if not isinstance(usage, dict):
        return result

    cost_usd = usage.get("cost_usd")
    if isinstance(cost_usd, (int, float)) and not isinstance(cost_usd, bool) and cost_usd > 0:
        result["credits_consumed"] = cost_usd

    charge_status = usage.get("charge_status")
    if charge_status == "failed":
        result["charge_failed"] = True
    elif charge_status == "byok_exempt":
        result["is_byok"] = True

    for key in _BILLING_TOKEN_KEYS:
        v = usage.get(key)
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            result[key] = v

    return result


def _extract_per_call_usage_json_from_done(usage: dict[str, Any]) -> dict[str, Any]:
    """从 DONE.usage 的 per-call `last_*` 构建 usage_json（最后一次 LLM 调用的输入侧规模）。

    （ 失效模式复发， 仅在 `message_delta.usage` 到达时回填 usage_json）：本 turn
    最后一条 assistant 消息 ↔ 最后一次 LLM 调用 ↔ DONE.`last_*`。当该消息的
    `message_delta` 没带 usage（usage_json 落库为空，常见于最终 text 回复轮 / abort /
    provider 未回 usage chunk），前端上下文用量环会回退到 turn 累加的
    `metadata.input_tokens`——多工具调用 turn 里那是同段上下文被重复计 N 次的累加值，
    虚高数倍、误报「上下文占满」。用 DONE 的 per-call `last_*` 回填这条消息的 usage_json
    即可让前端走 `usage_json`（per-call 真实值）而非累加兜底。

    只取输入侧（ring 口径不含 output）；输入侧三项全 0 时返回空 dict。
    """
    if not isinstance(usage, dict):
        return {}
    last_input = usage.get("last_input_tokens")
    if not (isinstance(last_input, (int, float)) and not isinstance(last_input, bool) and last_input >= 0):
        return {}
    out: dict[str, Any] = {"input_tokens": int(last_input)}
    cache_read = usage.get("last_cache_read_input_tokens")
    if isinstance(cache_read, (int, float)) and not isinstance(cache_read, bool) and cache_read >= 0:
        out["cache_read_input_tokens"] = int(cache_read)
    cache_creation = usage.get("last_cache_creation_input_tokens")
    if isinstance(cache_creation, (int, float)) and not isinstance(cache_creation, bool) and cache_creation >= 0:
        out["cache_creation_input_tokens"] = int(cache_creation)
    input_side = sum(
        value
        for value in (
            out.get("input_tokens"),
            out.get("cache_read_input_tokens"),
            out.get("cache_creation_input_tokens"),
        )
        if isinstance(value, int)
    )
    if input_side <= 0:
        return {}
    return out


def _attach_cost_metadata_from_done(
    session_id: str,
    done_events: list[dict[str, Any]],
    result: SyncWriteResult,
) -> None:
    """把 DONE 的 per-turn 计费 metadata 合并进该 run 最后一条 assistant 消息的
    `ChatMessage.metadata`，让重开历史对话也能回显「已消费 X 点券」/ 每条费用标注。

    ## 为什么要这一步

    计费是 **per-turn**（每次 runtime.query() 的 cost_usd），只活在 DONE 事件里；
    而 reassembler 落库走 per-message 的 6 件套，metadata 只写 source / client_event_id
    等账务无关字段。历史上 cost 只在活态内存（renderer onDone）写过，从没落库 →
    重开对话后费用标注全部消失（ring tooltip 退化成「预估费用」）。这里把 cost
    在落库阶段补回 metadata，前端读取侧零改动。

    ## 归属：按 trace_id 定位本 run 最后一条 assistant 消息

    DONE.trace_id == 本 run 所有 ChatMessage.trace_id；一个 turn 的总 cost 归到
    **最后一条 assistant 消息**（用户看到总结 / 费用标注的那条）。前端对会话内所有
    assistant 消息的 credits 求和，所以「每 turn 恰好一条消息带 credits」= 求和正确。

    ## 幂等

    metadata 是 SET 合并（非累加），relay 重试重复写同值无副作用——因此**不需要**
    像 token 累加那样上 dedup 锁；重试反而能自愈（譬如首次落库时 message_stop 尚未
    到达的极端时序）。
    """
    from apps.chat.conversation.models import ChatMessage

    for evt in done_events:
        payload = evt.get("payload") or {}
        usage = payload.get("usage")
        if not isinstance(usage, dict):
            continue
        billing = _extract_billing_metadata_from_usage(usage)
        if not billing:
            continue

        trace_id = payload.get("trace_id")
        if not (isinstance(trace_id, str) and trace_id):
            logger.info(
                "[RelayMessageWriter] DONE 缺 trace_id，计费 metadata 无法归属: session=%s",
                session_id,
            )
            continue
        try:
            trace_uuid = uuid_mod.UUID(trace_id)
        except (ValueError, TypeError):
            continue

        try:
            msg = (
                ChatMessage.objects
                .filter(session_id=session_id, role="assistant", trace_id=trace_uuid)
                .order_by("-created_at")
                .first()
            )
            if msg is None:
                logger.info(
                    "[RelayMessageWriter] DONE 计费 metadata 无匹配 assistant 消息"
                    "（message_stop 可能尚未落库，等下次重试）: session=%s trace=%s",
                    session_id, trace_id,
                )
                continue
            merged = dict(msg.metadata or {})
            merged.update(billing)
            msg.metadata = merged
            update_fields = ["metadata", "updated_at"]

            # （ 复发）：最后一条 assistant 缺 per-call usage_json 时，用 DONE 的 last_*
            # 回填——它正是这条消息对应的最后一次 LLM 调用的真实输入侧规模。否则前端
            # 上下文环只能回退到 turn 累加 metadata.input_tokens，把同段上下文重复计
            # N 次（多工具调用 turn），虚高数倍误报「占满」。只在原 usage_json 输入侧
            # 为空时回填，不覆盖 reassembler 已落库的 per-call 真值。
            existing_usage = msg.usage_json if isinstance(msg.usage_json, dict) else None
            existing_input_side = 0.0
            if existing_usage:
                for key in ("input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"):
                    v = existing_usage.get(key)
                    if isinstance(v, (int, float)) and not isinstance(v, bool):
                        existing_input_side += v
            if existing_input_side <= 0:
                per_call = _extract_per_call_usage_json_from_done(usage)
                if per_call:
                    msg.usage_json = {**(existing_usage or {}), **per_call}
                    update_fields.append("usage_json")

            msg.save(update_fields=update_fields)
        except Exception:
            logger.error(
                "[RelayMessageWriter] DONE 计费 metadata 落库失败: session=%s trace=%s",
                session_id, trace_id, exc_info=True,
            )


def _write_state_snapshots(
    thread_id: str,
    events: list[dict[str, Any]],
    result: SyncWriteResult,
) -> None:
    """写入 state_snapshot 到 PG ConversationState。"""
    from apps.services.agent_engine.models import ConversationState

    db_alias = "postgresql"
    last_snapshot = events[-1]
    payload = last_snapshot.get("payload") or {}

    messages_json = payload.get("messages_json")
    state_json = payload.get("state_json")
    interrupt_state = payload.get("interrupt_state")

    if messages_json is None and state_json is None:
        return

    try:
        with transaction.atomic(using=db_alias):
            defaults: dict[str, Any] = {"version": F("version") + 1}
            if messages_json is not None:
                defaults["messages_json"] = messages_json
            if state_json is not None:
                defaults["state_json"] = state_json
            if interrupt_state is not None:
                defaults["interrupt_state"] = interrupt_state

            updated = ConversationState.objects.using(db_alias).filter(
                thread_id=thread_id,
            ).update(**defaults)

            if updated == 0:
                create_defaults: dict[str, Any] = {"thread_id": thread_id, "version": 1}
                if messages_json is not None:
                    create_defaults["messages_json"] = messages_json
                if state_json is not None:
                    create_defaults["state_json"] = state_json
                if interrupt_state is not None:
                    create_defaults["interrupt_state"] = interrupt_state
                ConversationState.objects.using(db_alias).create(**create_defaults)

            result.events_written += 1

    except Exception:
        logger.error(
            "[RelayMessageWriter] ConversationState 写入失败: thread=%s",
            thread_id, exc_info=True,
        )
        result.success = False
        result.error = f"state_snapshot_write_error for {thread_id}"


def _now():
    from django.utils import timezone
    return timezone.now()


sync_write_critical_events = database_sync_to_async(
    _sync_write_critical_events,
)
