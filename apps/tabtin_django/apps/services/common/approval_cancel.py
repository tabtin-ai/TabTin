"""
approval_cancel — 审批批量取消的服务端权威接口（PRD 05 v0.4 §7.6.2 接口 A）。

# 业务场景

用户在 Solo 模式 Agent 长任务跑到一半时，从**另一个会话**对同一 agent 做 rollback
（譬如回滚 agent 昨天的某次操作）。此刻挂在 ``ConversationState.interrupt_state.
pending_approvals`` 里的待审批应该被批量取消——不是 deny（用户没主动拒绝）也不是
cancelled（用户没主动取消），而是 ``cancelled_by_rollback`` 让模型理解"这是回滚
导致的取消，不是用户拒绝"。

接口设计原则（PRD §7.6.2）：

* **服务端权威**：runtime 进程在 Solo 7 天 TTL 内大概率已退出，Django 找不到
  Promise 可 resolve；此接口直接清 PG 状态 + 写 audit + 广播，不依赖 runtime 存活。
* **原子事务**：清 ``interrupt_state.pending_approvals`` + 写 ``PermissionAudit``
  在同一事务内提交；任一步失败整体回滚，不留半完成状态。
* **幂等**：同一 ``rollback_event_id`` 多次调用返回相同 ``CancelPendingResult``——
  对已 resolved / 已被 cancel 的 ``request_id`` skip 不报错。
* **Side-effect: broadcast**：成功 commit 后**额外** publish 一条
  ``approval_resolved(outcome='cancelled_by_rollback')`` 给 thread topic，让所有
  镜像端（其它 Electron 窗口 / iOS / Android / 还活着的 runtime 进程）的
  ApprovalPanel 自动关闭。runtime 已死时广播自然丢失，重启后从 ``interrupt_state``
  拉到空 pending_approvals → 自然不会重新挂（因为清理已生效）。

# 与 07 PRD（Checkpoint & Rollback）的协作

本接口被 07 PRD rollback pipeline 调用：

1. 用户触发 rollback → 07 收口 cleanup → cleanup 完成（commit_message 等）
2. 调本接口 ``cancel_pending_approvals_by_thread(thread_id, reason='rollback_auto_cancel',
   rollback_event_id=<07 rollback id>)``
3. PermissionAudit 行 ``decision='cancelled_by_rollback' source='rollback'`` ＋
   ``reason.rollback_event_id`` 写入；07 PRD AdminDash 可按此回放

本期（W3-轮 1）只实装接口 + 单测；07 PRD 启动后再做实际 rollback pipeline 联调。

详
- `packages/agent-runtime/docs/prd/05-permissions-and-sandbox.md` §7.6.2 接口 A
- `packages/agent-runtime/docs/prd/07-checkpoint-and-rollback.md` §6 整合 Approval

# 错误兜底

- thread_id 不存在 / interrupt_state 缺失 → ``not_found=True``；不抛
- 写 audit 失败 / 写 interrupt_state 失败 → 整事务回滚 + 抛 RuntimeError 让
  调用方决定重试；广播只在事务成功后才发出（不会出现"audit 没写但广播已发"的
  silent 状态错位）
- 广播失败 → 仅 log warn，不影响接口返回值（事务已 commit）
"""

from __future__ import annotations

import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

from django.db import transaction

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Result types
# ---------------------------------------------------------------------------


@dataclass
class CancelPendingResult:
    """``cancel_pending_approvals_by_thread`` 的返回值（与 PRD §7.6.2 字段对齐）。

    * ``cancelled_ids``：本次新被 cancel 的 request_id 列表（之前 status='pending'，
      此次更新为 status='resolved' + outcome='cancelled_by_rollback'）。
    * ``already_resolved_ids``：已 resolved 不需要 cancel 的 request_id 列表
      （含 outcome ∈ {allow, deny, cancelled, expired} 的全部历史条目）；
      幂等重调时全部 ``cancelled_ids`` 的条目会落到这里。
    * ``not_found``：thread_id 没有 ConversationState row，或 interrupt_state 缺失。

    总 ID = ``cancelled_ids ∪ already_resolved_ids``——两个集合互斥但不必并起来等于
    PRD interrupt_state 全部条目（被丢弃的 entries 譬如格式 broken 不进任何一边）。
    """

    cancelled_ids: List[str] = field(default_factory=list)
    already_resolved_ids: List[str] = field(default_factory=list)
    not_found: bool = False


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_PENDING_APPROVALS_KEY = "pending_approvals"
_OUTCOME_CANCELLED_BY_ROLLBACK = "cancelled_by_rollback"
_AUDIT_SOURCE_ROLLBACK = "rollback"

# 数据库 alias（与 relay_audit_writer 对称）。
_DB_ALIAS_PG = "postgresql"


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def cancel_pending_approvals_by_thread(
    thread_id: str,
    reason: str,
    rollback_event_id: Optional[str] = None,
) -> CancelPendingResult:
    """服务端权威清理接口——把 thread 下所有 status='pending' 的审批批量 cancel。

    行为（原子事务，PG 上一次 transaction.atomic）：

    1. ``select_for_update`` 锁定 ``ConversationState`` row，按 thread_id 查；
    2. 遍历 ``interrupt_state.pending_approvals[]``（含嵌套 batches.entries）找
       所有 ``status='pending'`` 条目；
    3. 每条写一行 ``PermissionAudit``：``decision='cancelled_by_rollback'``，
       ``source='rollback'``，``reason={..., rollback_event_id, cancel_reason: reason}``；
    4. 更新 ``interrupt_state.pending_approvals`` 中匹配条目 ``status='resolved'``
       ``outcome='cancelled_by_rollback'`` ``resolved_at=now`` ``rejection_message=reason``
       （保留已 resolved 历史不动）；
    5. 提交事务；
    6. 成功后**额外** publish 一条 ``approval_resolved(outcome='cancelled_by_rollback')``
       给 ``agent.stream.{thread_id}`` topic（按 batch 聚合 N 条 decision，避免广播风暴）。

    幂等：对已 resolved 或不存在的 request_id 无副作用（直接 skip）。同一
    rollback_event_id 多次调用返回相同 ``CancelPendingResult``。

    Args:
        thread_id: 对话线程 id；必须非空。
        reason: 取消原因（写到 audit.reason.cancel_reason 与 entry.rejection_message）；
            建议传"rollback_auto_cancel" / "user_rollback_all" 等可枚举值。
        rollback_event_id: 关联 07 PRD rollback pipeline 的事件 id（可选）；写到
            audit.reason.rollback_event_id，方便回放定位。

    Returns:
        ``CancelPendingResult``（见类文档）。

    Raises:
        ValueError: thread_id 为空。
        其它 DB / model 异常：直接抛给调用方决定重试 —— 调用方一般是 07 PRD
        rollback pipeline，它有自己的整体重试策略；本接口的事务原子性保证"抛错时
        interrupt_state 与 PermissionAudit 全部回滚"。
    """
    if not isinstance(thread_id, str) or not thread_id:
        raise ValueError("thread_id required")
    if not isinstance(reason, str):
        reason = str(reason or "rollback_auto_cancel")

    # 延迟 import 避免循环依赖（apps.services.common 是基础设施层，
    # agent_engine.models 反向依赖会触发 Django app loading 顺序问题）。
    from apps.services.agent_engine.models import (  # type: ignore
        ConversationState,
        PermissionAudit,
    )

    result = CancelPendingResult()

    # ── 收集"将要广播"的 decisions（事务成功后才发；事务回滚时这一段被丢弃） ──
    pending_audits_for_broadcast: List[Tuple[str, List[Dict[str, Any]]]] = []
    # ↑ List[(batch_id, decisions[])]——按 batch 聚合，避免一条审批一条广播

    # ── 查 + 锁定 ConversationState（PG 行级锁） ──
    try:
        with transaction.atomic(using=_DB_ALIAS_PG):
            obj = (
                ConversationState.objects.using(_DB_ALIAS_PG)
                .select_for_update()
                .filter(thread_id=thread_id)
                .first()
            )
            if obj is None:
                result.not_found = True
                return result

            interrupt_state = obj.interrupt_state if isinstance(obj.interrupt_state, dict) else None
            if interrupt_state is None:
                result.not_found = True
                return result

            pending = interrupt_state.get(_PENDING_APPROVALS_KEY)
            if not isinstance(pending, list) or not pending:
                # interrupt_state 存在但 pending_approvals 缺失 / 空 → 没什么可 cancel
                # 不算 not_found（thread 客观存在），返回空列表
                return result

            # 反查 tenancy（agent_id / organization_id / session_id）一次，所有 audit 行共享。
            #
            # **失败语义（W3-轮 1 三视角 review 自修：tenant 缺失不能 silent 写状态**：
            # 反查 None / UUID 解析失败时直接 raise——事务自动回滚保证「audit 缺口
            # 时 interrupt_state 也回滚」，避免出现"PG 状态改了但 audit 没写"
            # 与模块头注释「每条写一行 PermissionAudit + 原子事务」描述脱节的
            # 半完成状态。
            tenant = _resolve_tenant_for_thread(thread_id)
            if tenant is None:
                raise RuntimeError(
                    f"[ApprovalCancel] tenant lookup returned None for thread={thread_id}; "
                    "cannot write PermissionAudit without (organization_id, agent_id, session_id) — "
                    "transaction rolled back to keep interrupt_state consistent with audit"
                )
            wt_str, ag_str, sid_str = tenant
            try:
                organization_id_uuid = uuid.UUID(wt_str)
                agent_id_uuid = uuid.UUID(ag_str)
                session_id_uuid = uuid.UUID(sid_str)
            except (ValueError, TypeError) as exc:
                raise RuntimeError(
                    f"[ApprovalCancel] tenant UUID parse failed for thread={thread_id}: "
                    f"organization={wt_str!r} agent={ag_str!r} session={sid_str!r} ({exc}); "
                    "transaction rolled back to keep interrupt_state consistent with audit"
                ) from exc

            now_ms = int(time.time() * 1000)
            audit_rows: List[PermissionAudit] = []
            # W3-轮 1 视角 3 review WARNING #5 修复：用 set 去重避免同一 request_id
            # 在多 batch / 重复 entries 边缘场景下被 append 多次（譬如 Django 端
            # interrupt_state 数据有 broken duplicate）。最终转回 list 保持
            # CancelPendingResult schema 不变。
            cancelled_ids_set: set[str] = set()
            already_resolved_ids_set: set[str] = set()

            for batch_meta in pending:
                if not isinstance(batch_meta, dict):
                    continue
                batch_id_str = str(batch_meta.get("batch_id") or "") or None
                runtime_mode = str(batch_meta.get("runtime_mode") or "interactive")
                entries = batch_meta.get("entries")
                if not isinstance(entries, list):
                    continue

                broadcast_decisions: List[Dict[str, Any]] = []

                for entry in entries:
                    if not isinstance(entry, dict):
                        continue
                    request_id = str(entry.get("request_id") or "")
                    if not request_id:
                        continue
                    status = str(entry.get("status") or "pending")

                    if status != "pending":
                        # 已 resolved / 已 cancelled / 已 expired —— 幂等：列入 already_resolved_ids 不动作
                        already_resolved_ids_set.add(request_id)
                        continue

                    # 命中目标：标记为 cancelled_by_rollback
                    entry["status"] = "resolved"
                    entry["outcome"] = _OUTCOME_CANCELLED_BY_ROLLBACK
                    entry["resolved_at"] = now_ms
                    entry["rejection_message"] = reason
                    if rollback_event_id:
                        entry["rollback_event_id"] = rollback_event_id

                    cancelled_ids_set.add(request_id)

                    # 构造 PermissionAudit 行——tenant 已在前置校验中保证非 None；
                    # 这里不再做 silent skip，build 失败 raise 让事务整体回滚保持
                    # interrupt_state ↔ audit 同步。
                    audit_rows.append(
                        build_cancel_audit_record(
                            organization_id=organization_id_uuid,
                            agent_id=agent_id_uuid,
                            thread_id=thread_id,
                            session_id=session_id_uuid,
                            batch_id=batch_id_str,
                            request_id=request_id,
                            tool_call_id=str(entry.get("tool_call_id") or ""),
                            tool_name=str(entry.get("tool_name") or ""),
                            tool_namespace=str(entry.get("tool_namespace") or ""),
                            tool_input_preview=str(entry.get("tool_input_preview") or ""),
                            decision_reason=entry.get("decision_reason") or {},
                            skill_context=entry.get("skill_context"),
                            runtime_mode=runtime_mode,
                            cancel_reason=reason,
                            rollback_event_id=rollback_event_id,
                        )
                    )

                    # 添加到广播 decisions 列表
                    broadcast_decisions.append({
                        "request_id": request_id,
                        "tool_call_id": str(entry.get("tool_call_id") or ""),
                        "outcome": _OUTCOME_CANCELLED_BY_ROLLBACK,
                        "rejection_message": reason,
                    })

                if broadcast_decisions and batch_id_str:
                    pending_audits_for_broadcast.append((batch_id_str, broadcast_decisions))

            # 把 entry 改动写回（嵌套 dict 直接 mutate 已经改了对象引用，但 Django 的
            # JSONField 序列化只在 save() 触发——必须写回 obj.interrupt_state 同时显式
            # save 让 JSONField 重新序列化）。
            interrupt_state[_PENDING_APPROVALS_KEY] = pending
            obj.interrupt_state = interrupt_state

            if audit_rows:
                # bulk_create + ignore_conflicts 让 request_id 唯一约束的幂等重调
                # 自然去重；失败抛 IntegrityError 直接进 except 路径回滚事务。
                PermissionAudit.objects.using(_DB_ALIAS_PG).bulk_create(
                    audit_rows, ignore_conflicts=True,
                )

            obj.save(
                using=_DB_ALIAS_PG,
                update_fields=["interrupt_state", "version", "updated_at"],
            )

            # WARNING #5 修复：把去重后的 ID 集合转回 list 写回 result
            # （也可能 cancelled / already_resolved 同一 ID 共现于 broken 数据中——
            # 让 cancelled 优先，从 already_resolved_ids 把已 cancel 的去掉）。
            already_resolved_ids_set -= cancelled_ids_set
            result.cancelled_ids = sorted(cancelled_ids_set)
            result.already_resolved_ids = sorted(already_resolved_ids_set)

    except Exception:
        # 事务已回滚（with transaction.atomic 抛错自动回滚）；不做 silent 广播。
        logger.warning(
            "[ApprovalCancel] cancel_pending_approvals_by_thread failed: thread=%s reason=%s",
            thread_id, reason, exc_info=True,
        )
        raise

    # ── 事务成功 → publish broadcasts（失败仅 warn 不抛） ──
    for batch_id, decisions in pending_audits_for_broadcast:
        try:
            _publish_cancelled_by_rollback(
                thread_id=thread_id,
                batch_id=batch_id,
                decisions=decisions,
                rollback_event_id=rollback_event_id,
            )
        except Exception:
            logger.warning(
                "[ApprovalCancel] publish approval_resolved failed: thread=%s batch=%s",
                thread_id, batch_id, exc_info=True,
            )

    return result


def build_cancel_audit_record(
    *,
    organization_id: uuid.UUID,
    agent_id: uuid.UUID,
    thread_id: str,
    session_id: uuid.UUID,
    batch_id: Optional[str],
    request_id: str,
    tool_call_id: str,
    tool_name: str,
    tool_namespace: str,
    tool_input_preview: str,
    decision_reason: Dict[str, Any],
    skill_context: Optional[Dict[str, Any]],
    runtime_mode: str,
    cancel_reason: str,
    rollback_event_id: Optional[str] = None,
):
    """构造一行 ``PermissionAudit`` for cancelled_by_rollback。

    独立函数方便单测：可以纯 schema 校验而不走真正的 ConversationState。

    audit.reason 字段嵌入 ``cancel_reason`` 与 ``rollback_event_id``——AdminDash
    回放时按 ``filter(decision='cancelled_by_rollback')`` 后从 ``reason`` 字段
    取出关联信息。

    返回未 save 的 PermissionAudit 实例（caller 负责 ``bulk_create`` 或 ``save``）。
    """
    from apps.services.agent_engine.models import PermissionAudit  # type: ignore

    reason_payload: Dict[str, Any] = dict(decision_reason or {})
    # 把 cancel-related metadata 注入 reason JSON（不破坏原 DecisionReason）。
    reason_payload["cancel_reason"] = cancel_reason
    if rollback_event_id:
        reason_payload["rollback_event_id"] = rollback_event_id

    return PermissionAudit(
        organization_id=organization_id,
        agent_id=agent_id,
        thread_id=thread_id,
        session_id=session_id,
        batch_id=batch_id,
        request_id=request_id,
        tool_call_id=tool_call_id,
        tool_name=tool_name,
        tool_namespace=tool_namespace,
        tool_input_preview=tool_input_preview,
        decision=_OUTCOME_CANCELLED_BY_ROLLBACK,
        source=_AUDIT_SOURCE_ROLLBACK,
        reason=reason_payload,
        scope="",
        approver_user_id=None,
        approver_client_info="",
        runtime_mode=runtime_mode or "interactive",
        skill_context=skill_context,
        rejection_message=cancel_reason,
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _resolve_tenant_for_thread(thread_id: str) -> Optional[Tuple[str, str, str]]:
    """复用 ``relay_audit_writer._resolve_tenant_uncached`` 的反查路径。

    返回 ``(organization_id, agent_id, session_id)`` 字符串元组；查不到返回 None。
    在事务内调用，避免事务结束后 stale 引用。
    """
    try:
        from apps.services.common.ws.handlers.relay_audit_writer import (  # type: ignore
            _resolve_tenant_uncached,
        )
        return _resolve_tenant_uncached(thread_id)
    except Exception:
        logger.warning(
            "[ApprovalCancel] tenant lookup failed for thread=%s",
            thread_id, exc_info=True,
        )
        return None


def _publish_cancelled_by_rollback(
    *,
    thread_id: str,
    batch_id: str,
    decisions: List[Dict[str, Any]],
    rollback_event_id: Optional[str],
) -> None:
    """publish 一条 ``approval_resolved(outcome='cancelled_by_rollback')`` 到 thread topic。

    走 reliable channel（与 chat_stream_publisher / localrt_user_response 对称）。
    payload 与 wire ``ApprovalResolvedPayloadSchema`` 对齐：
        {
            "batch_id": str,
            "decisions": [...],
            "rollback_event_id": str | None,
            "schema_version": 1
        }
    """
    if not decisions:
        return

    # 延迟 import 避免循环依赖（chat_stream_publisher 间接 import 本模块）。
    from apps.services.common.agent_protocol.constants import AgentStreamEvent  # type: ignore
    from apps.services.common.agent_protocol.namespace import (  # type: ignore
        stream_event_type,
        stream_topic,
    )
    from apps.services.common.ws.bus import (  # type: ignore
        publish_ws_event,
        publish_ws_event_reliable,
    )
    from apps.services.common.ws.protocol import (  # type: ignore
        build_envelope,
        new_event_id,
    )

    payload: Dict[str, Any] = {
        "batch_id": batch_id,
        "decisions": decisions,
        "schema_version": 1,
    }
    if rollback_event_id:
        payload["rollback_event_id"] = rollback_event_id

    full_event_type = stream_event_type(AgentStreamEvent.APPROVAL_RESOLVED)
    envelope = build_envelope(
        full_event_type,
        new_event_id(),
        payload,
        thread_id=thread_id,
    )
    topic = stream_topic(thread_id)

    try:
        publish_ws_event_reliable(topic, envelope)
    except Exception:
        logger.warning(
            "[ApprovalCancel] reliable publish failed, fallback non-reliable: thread=%s",
            thread_id, exc_info=True,
        )
        publish_ws_event(topic, envelope)
