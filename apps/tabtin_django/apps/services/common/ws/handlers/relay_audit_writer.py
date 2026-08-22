"""
relay_audit_writer — relay_events 中 approval_* 事件的审计写入器。

W2-轮 1（PRD 05 v0.4 §7.4.3 + §7.7）：

* ``agent.stream.approval_requested`` →
    - 写 ``ConversationState.interrupt_state.pending_approvals[]`` 加新条目
      （schema 字段齐备；W3 crash resume 时 runtime 按此回灌）
    - **不写** PermissionAudit（审批未决议；写 audit 在 resolved 时）
* ``agent.stream.approval_resolved`` →
    - 按 ``payload.batch_id`` 找 ``pending_approvals`` 中匹配条目，更新
      ``status='resolved'`` + ``outcome``
    - **每条 ActionRequest 写 1 行 PermissionAudit**（共享 batch_id；单工具
      N=1 也写 1 行）
    - 字段映射：从 ``approval_requested`` payload 回查 tool_name /
      tool_input_preview / decision_reason / runtime_mode / skill_context
      （cache 在 interrupt_state 里），从 ``approval_resolved`` 拿 outcome
      / scope / approver_identity / rejection_message

异步写策略（参考 ``relay_trace_writer.py``）：
    - 用 asyncio.create_task fire-and-forget；写失败 warn 不抛
    - 不阻塞 relay_events 主路径 ACK；丢失 audit 行可接受（监控告警 +
      Celery beat 后续补偿；本期范围内不做补偿）

session/agent/organization ID 反查：
    - thread_id → ChatSession（session_id 主路径）→ organization_id + session.agent_id
    - workspace_id 同样直读 ChatSession，避免从兼容 Space 壳推断执行现场
    - 反查失败（异常 thread_id / Agent 已删等）→ skip audit 行 + warn
    - 进程级 LRU 缓存（thread_id → tenant tuple），与 chat_stream_publisher
      的 _resolve_thread_organization_cached 对称
"""

from __future__ import annotations

import asyncio
import logging
import threading
import time
import uuid
from collections import OrderedDict
from typing import Any, Dict, Optional, Tuple

from channels.db import database_sync_to_async
from django.db import DatabaseError

logger = logging.getLogger(__name__)


_TENANT_CACHE_MAX = 1024
_TENANT_CACHE_TTL_S = 600.0
_tenant_cache: "OrderedDict[str, Tuple[Optional[Tuple[str, str, str, str]], float]]" = OrderedDict()
_tenant_cache_lock = threading.Lock()

_PENDING_APPROVALS_KEY = "pending_approvals"

# 摘要长度上限（与 runtime LocalPermissionHandler.SUMMARY_MAX 对齐 = 2000）
_INPUT_PREVIEW_MAX = 2000


def _is_row_lock_busy(exc: BaseException) -> bool:
    message = str(exc).lower()
    return (
        "could not obtain lock on row" in message
        or "lock timeout" in message
        or "nowait" in message
    )


def _truncate_input_preview(value: Any) -> str:
    """input → string 摘要，最多 2000 字符。"""
    try:
        if isinstance(value, str):
            text = value
        else:
            import json
            text = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    except Exception:
        text = str(value)
    if len(text) > _INPUT_PREVIEW_MAX:
        return text[:_INPUT_PREVIEW_MAX] + "…"
    return text


def _uuid_or_none(value: Any):
    if value in (None, ""):
        return None
    try:
        return uuid.UUID(str(value))
    except (TypeError, ValueError):
        return None


def _resolve_tenant_uncached(session_id: str) -> Optional[Tuple[str, str, str, str]]:
    """
    解析 session_id → (organization_id, agent_id, workspace_id, session_id_str)。
    任何失败/异常返回 None；调用方按 None 跳过 audit 写入。
    """
    if not session_id:
        return None
    try:
        from apps.chat.conversation.models import ChatSession
        sess = (
            ChatSession.objects
            .filter(id=session_id)
            .only("id", "organization_id", "agent_id", "workspace_id")
            .first()
        )
        if not sess:
            return None
        if not sess.agent_id or not sess.workspace_id:
            return None
        return (
            str(sess.organization_id),
            str(sess.agent_id),
            str(sess.workspace_id),
            str(sess.id),
        )
    except Exception:
        logger.debug(
            "[RelayAuditWriter] tenant lookup failed for session=%s",
            session_id, exc_info=True,
        )
        return None


def _resolve_tenant_cached(session_id: str) -> Optional[Tuple[str, str, str, str]]:
    """LRU 缓存包装（同 chat_stream_publisher._resolve_thread_organization_cached 模式）。"""
    if not session_id:
        return None
    now = time.monotonic()
    with _tenant_cache_lock:
        entry = _tenant_cache.get(session_id)
        if entry is not None:
            tenant, expires_at = entry
            if expires_at > now:
                _tenant_cache.move_to_end(session_id)
                return tenant
            _tenant_cache.pop(session_id, None)

    tenant = _resolve_tenant_uncached(session_id)

    with _tenant_cache_lock:
        _tenant_cache[session_id] = (tenant, now + _TENANT_CACHE_TTL_S)
        _tenant_cache.move_to_end(session_id)
        while len(_tenant_cache) > _TENANT_CACHE_MAX:
            _tenant_cache.popitem(last=False)
    return tenant


def _invalidate_tenant_cache(session_id: Optional[str] = None) -> None:
    """测试 / 异常恢复用：清缓存。"""
    with _tenant_cache_lock:
        if session_id is None:
            _tenant_cache.clear()
        else:
            _tenant_cache.pop(session_id, None)


# ── interrupt_state.pending_approvals 写入 ─────────────────────────


def _build_pending_entry(action_req: Dict[str, Any]) -> Dict[str, Any]:
    """从单条 wire ActionRequest 构造 pending_approvals[] 条目。

    schema（PRD §7.1 + §7.7 字段集合，W3 crash resume 时回灌使用）：
        {
            "request_id": str,
            "tool_call_id": str,
            "tool_name": str,
            "tool_namespace": str,
            "tool_input_preview": str (≤2000),
            "decision_reason": dict (DecisionReason),
            "skill_context": dict | None,
            "risk_level": str,
            "status": "pending" | "resolved",
            "outcome": str | None,
            "scope": str | None,
            "approver_user_id": str | None,
            "rejection_message": str,
            "resolved_at": int (unix_ms) | None,
        }
    """
    return {
        "request_id": str(action_req.get("request_id", "")),
        "tool_call_id": str(action_req.get("tool_call_id", "")),
        "tool_name": str(action_req.get("tool_name", "")),
        "tool_namespace": str(action_req.get("tool_namespace", "") or ""),
        "tool_input_preview": _truncate_input_preview(action_req.get("tool_input")),
        "decision_reason": action_req.get("decision_reason") or {},
        "skill_context": action_req.get("skill_context"),
        "risk_level": str(action_req.get("risk_level", "medium")),
        "status": "pending",
        "outcome": None,
        "scope": None,
        "approver_user_id": None,
        "rejection_message": "",
        "resolved_at": None,
    }


def _persist_approval_requested(
    thread_id: str,
    payload: Dict[str, Any],
) -> None:
    """同步写：append 新 batch 到 ConversationState.interrupt_state.pending_approvals。

    PG 行级锁；按 thread_id upsert（不存在则 create）。容错：写失败 warn 不抛。
    """
    from django.db import transaction
    from apps.services.agent_engine.models import ConversationState

    batch_id = payload.get("batch_id")
    action_requests = payload.get("action_requests") or []
    if not isinstance(action_requests, list) or not action_requests:
        return

    new_entries = [_build_pending_entry(ar) for ar in action_requests if isinstance(ar, dict)]
    if not new_entries:
        return

    runtime_mode = str(payload.get("runtime_mode", "interactive"))
    expires_at = payload.get("expires_at")
    batch_meta = {
        "batch_id": str(batch_id) if batch_id else None,
        "approval_type": str(payload.get("approval_type", "tool_permission")),
        "runtime_mode": runtime_mode,
        "expires_at": expires_at if isinstance(expires_at, (int, float)) else None,
        "schema_version": payload.get("schema_version", 1),
        "created_at": int(time.time() * 1000),
        "entries": new_entries,
    }
    team_meta = payload.get("team_space_execution")
    if isinstance(team_meta, dict):
        batch_meta["team_space_execution"] = team_meta

    db_alias = "postgresql"
    try:
        with transaction.atomic(using=db_alias):
            obj = (
                ConversationState.objects.using(db_alias)
                .select_for_update(nowait=True)
                .filter(thread_id=thread_id)
                .first()
            )
            if obj is None:
                # 没有 row 时 create 一条最小骨架（让 W3 crash resume 能找到）
                ConversationState.objects.using(db_alias).create(
                    thread_id=thread_id,
                    interrupt_state={
                        _PENDING_APPROVALS_KEY: [batch_meta],
                    },
                    version=1,
                )
                return

            interrupt_state = obj.interrupt_state if isinstance(obj.interrupt_state, dict) else {}
            pending = interrupt_state.get(_PENDING_APPROVALS_KEY)
            if not isinstance(pending, list):
                pending = []
            pending.append(batch_meta)
            interrupt_state[_PENDING_APPROVALS_KEY] = pending
            obj.interrupt_state = interrupt_state
            obj.save(update_fields=["interrupt_state", "version", "updated_at"])
    except DatabaseError as exc:
        if _is_row_lock_busy(exc):
            logger.warning(
                "[RelayAuditWriter] skip approval_requested due to busy ConversationState lock: thread=%s batch=%s",
                thread_id, batch_id,
            )
            return
        logger.warning(
            "[RelayAuditWriter] persist approval_requested failed: thread=%s batch=%s",
            thread_id, batch_id, exc_info=True,
        )
    except Exception:
        logger.warning(
            "[RelayAuditWriter] persist approval_requested failed: thread=%s batch=%s",
            thread_id, batch_id, exc_info=True,
        )


def _reason_type_to_audit_source(reason_type: Any) -> str:
    """DecisionReason.type → PermissionAudit.source（与 runtime mapDecisionReasonToAuditSource 对齐）。"""
    mapping = {
        "memo_allow": "memoization",
        "memo_deny": "memoization",
        "memoized_always": "memoization",
        "memoized_thread": "memoization",
        "plan_guard": "plan_guard",
        "plan_blocked": "plan_guard",
        "hardline_block": "hardline",
        "hardline_confirm": "hardline",
        "hardline_command": "hardline",
        "hardline_path": "hardline",
        "skill_not_approved": "skill_trust",
        "skill_trust_downgrade": "skill_trust",
        "classifier_low_confidence": "classifier",
        "classifier_decided": "classifier",
        "user_interactive": "user_interactive",
        "yolo_allow": "rule",
        "workspace_in": "rule",
        "object_default_allow": "rule",
        "fallback_preset": "rule",
        "rule_high_risk_allowlist_miss": "rule",
    }
    if isinstance(reason_type, str):
        return mapping.get(reason_type, "rule")
    return "rule"


def _resolve_audit_source(
    payload: Dict[str, Any],
    entry_meta: Dict[str, Any],
    decision: Dict[str, Any],
) -> str:
    """静默判决用 payload/ reason 映射 source；用户交互路径固定 user_interactive。

    bugbot 评审  medium：混源批次每条 decision 的 source 可能不同，必须逐条
    映射，不能用批次顶层 audit_source 覆盖全批。优先级：
      1. decision 级 audit_source（runtime 逐条下发）
      2. decision 级 decision_reason.type 映射
      3. 批次顶层 audit_source（兜底，仅当 decision 级都缺）
      4. rule
    """
    if payload.get("silent") is True:
        decision_explicit = decision.get("audit_source")
        if isinstance(decision_explicit, str) and decision_explicit.strip():
            return decision_explicit.strip()
        reason = decision.get("decision_reason")
        if not isinstance(reason, dict):
            reason = entry_meta.get("decision_reason") or {}
        if isinstance(reason, dict) and reason.get("type"):
            return _reason_type_to_audit_source(reason.get("type"))
        batch_explicit = payload.get("audit_source")
        if isinstance(batch_explicit, str) and batch_explicit.strip():
            return batch_explicit.strip()
        return "rule"
    return "user_interactive"


def _decision_tool_name(decision: Dict[str, Any], entry_meta: Dict[str, Any]) -> str:
    direct = decision.get("tool_name")
    if isinstance(direct, str) and direct:
        return direct
    return str(entry_meta.get("tool_name", "") or "")


def _decision_tool_namespace(decision: Dict[str, Any], entry_meta: Dict[str, Any]) -> str:
    direct = decision.get("tool_namespace")
    if isinstance(direct, str):
        return direct
    return str(entry_meta.get("tool_namespace", "") or "")


def _decision_tool_input_preview(decision: Dict[str, Any], entry_meta: Dict[str, Any]) -> str:
    direct = decision.get("tool_input_preview")
    if isinstance(direct, str):
        return direct
    return str(entry_meta.get("tool_input_preview", "") or "")


def _decision_reason(decision: Dict[str, Any], entry_meta: Dict[str, Any]) -> Dict[str, Any]:
    reason = decision.get("decision_reason")
    if isinstance(reason, dict):
        return reason
    meta_reason = entry_meta.get("decision_reason")
    if isinstance(meta_reason, dict):
        return meta_reason
    return {}


def _persist_approval_resolved(
    session_id: str,
    thread_id: str,
    payload: Dict[str, Any],
) -> None:
    """同步写：
    1. 找 interrupt_state.pending_approvals 中匹配 batch_id 的条目，更新 status=resolved
    2. 每条 ActionRequest 写 1 行 PermissionAudit（共享 batch_id）

    容错：DB 异常 warn 不抛；不阻塞 relay 主路径。
    """
    from django.db import transaction
    from apps.services.agent_engine.models import ConversationState, PermissionAudit

    batch_id = payload.get("batch_id")
    decisions = payload.get("decisions") or []
    if not isinstance(decisions, list) or not decisions:
        return

    is_silent = payload.get("silent") is True
    payload_runtime_mode = str(payload.get("runtime_mode") or "")

    tenant = _resolve_tenant_cached(session_id)
    if tenant is None:
        logger.warning(
            "[RelayAuditWriter] tenant lookup miss for session=%s, skip audit write",
            session_id,
        )
        return
    organization_id, agent_id, workspace_id, session_id_str = tenant

    db_alias = "postgresql"

    # ── Step 1：更新 interrupt_state.pending_approvals 对应条目 + 回查 entry meta ──
    matched_entries: Dict[str, Dict[str, Any]] = {}
    batch_meta_runtime_mode = payload_runtime_mode or "interactive"
    batch_team_meta: Dict[str, Any] = {}
    if not is_silent:
        try:
            with transaction.atomic(using=db_alias):
                obj = (
                    ConversationState.objects.using(db_alias)
                    .select_for_update(nowait=True)
                    .filter(thread_id=thread_id)
                    .first()
                )
                if obj is not None and isinstance(obj.interrupt_state, dict):
                    interrupt_state = obj.interrupt_state
                    pending = interrupt_state.get(_PENDING_APPROVALS_KEY)
                    if isinstance(pending, list):
                        now_ms = int(time.time() * 1000)
                        target_batch_id = str(batch_id) if batch_id else None
                        for batch_meta in pending:
                            if not isinstance(batch_meta, dict):
                                continue
                            if str(batch_meta.get("batch_id") or "") != (target_batch_id or ""):
                                continue
                            batch_meta_runtime_mode = str(
                                batch_meta.get("runtime_mode") or "interactive"
                            )
                            maybe_team_meta = batch_meta.get("team_space_execution")
                            batch_team_meta = maybe_team_meta if isinstance(maybe_team_meta, dict) else {}
                            entries = batch_meta.get("entries")
                            if not isinstance(entries, list):
                                continue
                            # build request_id → entry index 映射
                            for entry in entries:
                                if not isinstance(entry, dict):
                                    continue
                                rid = str(entry.get("request_id", ""))
                                if rid:
                                    matched_entries[rid] = entry
                            # 更新 status / outcome
                            for d in decisions:
                                if not isinstance(d, dict):
                                    continue
                                d_rid = str(d.get("request_id", ""))
                                entry = matched_entries.get(d_rid)
                                if not entry:
                                    continue
                                entry["status"] = "resolved"
                                entry["outcome"] = str(d.get("outcome", ""))
                                entry["scope"] = str(d.get("scope", "") or "")
                                approver = d.get("approver_identity") or {}
                                if isinstance(approver, dict):
                                    entry["approver_user_id"] = str(
                                        approver.get("user_id", "") or ""
                                    ) or None
                                entry["rejection_message"] = str(d.get("rejection_message", "") or "")
                                entry["resolved_at"] = now_ms
                            break  # 找到目标 batch 后中断
                    interrupt_state[_PENDING_APPROVALS_KEY] = pending
                    obj.interrupt_state = interrupt_state
                    obj.save(update_fields=["interrupt_state", "version", "updated_at"])
        except DatabaseError as exc:
            if _is_row_lock_busy(exc):
                logger.warning(
                    "[RelayAuditWriter] skip approval_resolved pending update due to busy ConversationState lock: thread=%s batch=%s",
                    thread_id, batch_id,
                )
            else:
                logger.warning(
                    "[RelayAuditWriter] update pending_approvals failed: thread=%s batch=%s",
                    thread_id, batch_id, exc_info=True,
                )
        except Exception:
            logger.warning(
                "[RelayAuditWriter] update pending_approvals failed: thread=%s batch=%s",
                thread_id, batch_id, exc_info=True,
            )

    # ── Step 2：每条 ActionRequest 写 1 行 PermissionAudit ──
    audit_rows: list[PermissionAudit] = []
    for d in decisions:
        if not isinstance(d, dict):
            continue
        rid = str(d.get("request_id", ""))
        entry_meta = matched_entries.get(rid, {})

        approver = d.get("approver_identity") or {}
        approver_user_id = None
        approver_client_info = ""
        if isinstance(approver, dict):
            uid = approver.get("user_id")
            approver_user_id = str(uid) if uid else None
            approver_client_info = str(approver.get("client_info", "") or "")

        try:
            audit_source = _resolve_audit_source(payload, entry_meta, d)
            audit_rows.append(
                PermissionAudit(
                    organization_id=organization_id,
                    agent_id=agent_id,
                    workspace_id=workspace_id,
                    thread_id=thread_id,
                    session_id=session_id_str,
                    batch_id=str(batch_id) if batch_id else None,
                    request_id=rid,
                    tool_call_id=str(d.get("tool_call_id", "")),
                    tool_name=_decision_tool_name(d, entry_meta),
                    tool_namespace=_decision_tool_namespace(d, entry_meta),
                    tool_input_preview=_decision_tool_input_preview(d, entry_meta),
                    decision=str(d.get("outcome", "")),
                    source=audit_source,
                    reason=_decision_reason(d, entry_meta),
                    scope=str(d.get("scope", "") or ""),
                    initiator_user_id=_uuid_or_none(batch_team_meta.get("initiator_user_id")),
                    execution_owner_user_id=_uuid_or_none(batch_team_meta.get("execution_owner_user_id")),
                    approver_user_id=approver_user_id,
                    approver_client_info=approver_client_info,
                    runtime_mode=batch_meta_runtime_mode,
                    skill_context=entry_meta.get("skill_context"),
                    rejection_message=str(d.get("rejection_message", "") or ""),
                )
            )
        except Exception:
            logger.warning(
                "[RelayAuditWriter] PermissionAudit construct failed for decision=%s",
                d, exc_info=True,
            )

    if not audit_rows:
        return
    try:
        # ``ignore_conflicts=True`` 配合 model 上的 ``request_id`` UniqueConstraint，
        # 保证双广播（mirror publish + daemon→runtime→relay）触发 relay_handler
        # 二次落库时静默去重，不抛 IntegrityError 也不留双行。
        PermissionAudit.objects.using(db_alias).bulk_create(
            audit_rows, ignore_conflicts=True,
        )
    except Exception:
        logger.error(
            "[RelayAuditWriter][ALERT] PermissionAudit bulk_create failed: thread=%s batch=%s "
            "lost_rows=%d silent=%s",
            thread_id, batch_id, len(audit_rows), is_silent, exc_info=True,
        )


_async_persist_approval_requested = database_sync_to_async(
    _persist_approval_requested, thread_sensitive=False,
)
_async_persist_approval_resolved = database_sync_to_async(
    _persist_approval_resolved, thread_sensitive=False,
)


# ── 后台 task 池（与 relay_handler._BACKGROUND_TRACE_TASKS 模式对称） ──

_BACKGROUND_AUDIT_TASKS: set[asyncio.Task] = set()
_MAX_BACKGROUND_AUDIT_TASKS = 500


def spawn_audit_writes(
    session_id: str,
    thread_id: str,
    approval_events: list[Dict[str, Any]],
) -> int:
    """fire-and-forget 异步写一批 approval_* 事件的 audit + interrupt_state。

    Returns: 实际启动的 task 数（被池满拒绝的不计）。
    """
    started = 0
    for evt in approval_events:
        if not isinstance(evt, dict):
            continue
        event_type = evt.get("type", "")
        if not isinstance(event_type, str):
            continue
        payload = evt.get("payload") or {}
        if not isinstance(payload, dict):
            continue

        if event_type.endswith(".approval_requested"):
            coro = _async_persist_approval_requested(thread_id, payload)
            short = "approval_requested"
        elif event_type.endswith(".approval_resolved"):
            coro = _async_persist_approval_resolved(session_id, thread_id, payload)
            short = "approval_resolved"
        else:
            continue

        if len(_BACKGROUND_AUDIT_TASKS) >= _MAX_BACKGROUND_AUDIT_TASKS:
            logger.error(
                "[RelayAuditWriter][ALERT] audit task pool full: capacity=%d dropped_event=%s "
                "thread_id=%s lost_rows=1",
                _MAX_BACKGROUND_AUDIT_TASKS, short, thread_id,
            )
            continue

        async def _run(c=coro, sn=short, tid=thread_id):
            try:
                await c
            except Exception:
                logger.warning(
                    "[RelayAuditWriter] background %s persist exception: thread=%s",
                    sn, tid, exc_info=True,
                )

        task = asyncio.create_task(_run(), name=f"audit_{short}_{thread_id}")
        _BACKGROUND_AUDIT_TASKS.add(task)
        task.add_done_callback(_BACKGROUND_AUDIT_TASKS.discard)
        started += 1
    return started


__all__ = [
    "spawn_audit_writes",
    "_resolve_tenant_cached",
    "_invalidate_tenant_cache",
]
