"""
relay_trace_writer — 把本地 Runtime 的 relay event 写入 ExecutionTrace / TraceEvent。

H2-A FR-10：让 AdminDash `/agent-debug` 能看到本地 Runtime 完整 trace。

设计要点（与 `trace_recorder.py` 区别）：
  - `trace_recorder.TraceRecorder.start_trace` 走 ContextVar 上下文（适配 ReactAgent
    的同步执行模型）；relay 是 channels async handler，单 batch 处理多条 event，
    没法套 contextvar.run，必须用直接 ORM API。
  - `_next_seq` 每条 event 一次 UPDATE 的开销在 500-event batch 下不可忽略；
    我们一次性 SELECT FOR UPDATE + 批量分配 seq 范围 + `bulk_create` 单次插入。
  - 写表错误**永不冒泡**，由 caller try/except 兜底——relay 的首要责任是
    `ChatStreamPublisher.publish_ws` 实时广播，trace 写表是次要可观测性。

graph_type 与云端 TinAgent 区分：
  - 云端 TinAgent：`graph_type='tin'`（agent_engine.middleware.trace 默认值）
  - 云端 scheduler：`graph_type='scheduler'`
  - **本地 Runtime**：`graph_type='local-runtime'` + `metadata.runtime='local'`
  - **本地子 Agent (LH2-A1)**：`graph_type='local-runtime-subagent'` +
    `metadata.runtime='local'` + `metadata.parent_trace_id=<父 trace UUID>` +
    `metadata.subagent_run_id=<父 SUBAGENT_STARTED.subagent_run_id>`。
    AdminDash trace-detail 在父 trace 的 SUBAGENT_* 节点提供"展开子 trace"
    入口，依靠 `child_trace_id` 字段直接跳转。
  AdminDash trace-list 可按 graph_type 过滤区分本地父 / 子 / 云端。

WS 双通道说明（H2-A 关键）：
  - `agent.stream.{thread_id}` ← `ChatStreamPublisher.publish_ws`（移动端 / 实时 chat UI）
  - `trace.stream.{trace_id}` ← 本模块新增（AdminDash `/agent-debug` 实时刷新）
  两个频道**必须双推**：移动端订阅前者拿到对话流；AdminDash useTraceStream 订阅
  后者拿到 trace event 流。两通道的 envelope.type 也不同——
  publish_ws 用 `agent.stream.{event}`，trace.stream 用 `trace.stream.event`。
"""

from __future__ import annotations

import logging
import uuid
from typing import Any

from channels.db import database_sync_to_async
from django.db import connections, transaction

from apps.services.agent_engine.models import ExecutionTrace, TraceEvent
from apps.services.common.observability.trace_formatters import (
    build_record_event_ws_payload,
    build_trace_end_ws_payload,
    sanitize_serializable,
)
from apps.services.common.ws.bus import publish_ws_event
from apps.services.common.ws.protocol import build_envelope, new_event_id

logger = logging.getLogger(__name__)

# H2-A FR-10：本地 Runtime trace 的 graph_type 标识。
# AdminDash trace-list 按此值过滤，与云端 TinAgent (`tin`) / scheduler 区分。
LOCAL_RUNTIME_GRAPH_TYPE = "local-runtime"

# LH2-A1（H3-C）：本地子 Agent trace 的 graph_type 标识。
# 用独立 graph_type 与父 trace 区分，AdminDash trace-list 默认可只显示父
# trace（避免子 trace 把列表 N×膨胀），用户在父 trace-detail 嵌套展开看
# 子 trace。建库时仍写入 ExecutionTrace 表（与父同表，靠 metadata.parent_trace_id
# 关联），SQL 查询不需要新表。
LOCAL_RUNTIME_SUBAGENT_GRAPH_TYPE = "local-runtime-subagent"

# H2-A FR-10：WS envelope.type 与 trace_recorder._publish_event 一致，
# 让 AdminDash useTraceStream 既能识别本地 Runtime 也能识别云端 trace 流。
TRACE_STREAM_EVENT_TYPE = "trace.stream.event"


def _short_name_from_stream_type(stream_type: str) -> str:
    """从 `agent.stream.xxx` 提取 short name（去前缀）。"""
    prefix = "agent.stream."
    if stream_type.startswith(prefix):
        return stream_type[len(prefix):]
    return stream_type


def _derive_event_name(short_name: str, payload: dict) -> str:
    """根据 event 短名 + payload 推导 TraceEvent.name。

    便于 AdminDash 事件时间线一目了然（避免所有 tool event name 都叫 'tool'，
    点开才知道哪个工具）。
    """
    if short_name == "tool":
        return str(payload.get("tool_name") or "tool")
    if short_name == "step":
        return str(payload.get("step_type") or "step")
    if short_name == "system_notice":
        return str(payload.get("notice_type") or "notice")
    if short_name == "compaction":
        return str(payload.get("mode") or payload.get("phase") or "compaction")
    if short_name == "lifecycle":
        return str(payload.get("phase") or "lifecycle")
    if short_name == "assistant":
        return str(payload.get("phase") or "assistant")
    if short_name in ("subagent_started", "subagent_progress", "subagent_failed", "subagent_completed"):
        return short_name.replace("subagent_", "")
    return short_name


def _is_terminal_lifecycle(short_name: str, payload: dict) -> bool:
    """lifecycle phase 是否表示 trace 终止（→ end_trace）。"""
    if short_name != "lifecycle":
        return False
    phase = payload.get("phase")
    return phase in ("end", "error", "terminated", "session_interrupted")


def _is_done_event(short_name: str) -> bool:
    """DONE event → trace 终止 + 写 status/error。"""
    return short_name == "done"


def _resolve_done_status(payload: dict) -> tuple[str, str | None]:
    """从 done event payload 提取 trace status 和 error 字符串。"""
    if payload.get("error"):
        return "error", str(payload.get("error_message") or "")
    return "completed", None


def _resolve_lifecycle_status(payload: dict) -> tuple[str, str | None]:
    """lifecycle 终止 phase → trace status / error。"""
    phase = payload.get("phase")
    if phase == "error":
        return "error", str(payload.get("error_message") or "")
    if phase == "terminated":
        return "error", str(payload.get("detail") or "terminated")
    return "completed", None


# H2-A FR-10 P0 修复（技术 Review #1）：DONE 与 lifecycle.end 同批时的终结优先级。
# query.ts 大量错误路径是「先 yield DONE(error=true)，再走 finally 发 lifecycle.end」，
# 同一批 relay 事件里 DONE(error) + lifecycle(end) 两条共存。
# 不修则后写覆盖前写：lifecycle.end → status='completed' 把 DONE 的 error 状态洗掉，
# AdminDash 会把"失败 run 显示为成功结束"，误导排查。
#
# 优先级规则（由高到低）：
#   1. DONE event 是终结语义的权威来源（业务层最清楚是 error 还是 completed）
#   2. lifecycle.end 仅用于"无 DONE 时的兜底"
#   3. error 永远不被 completed 覆盖
def _merge_trace_finalize(
    current: tuple[str, str | None, str] | None,
    incoming: tuple[str, str | None, str],
) -> tuple[str, str | None, str]:
    """合并新的终结状态。返回 (status, error, source) 三元组。

    source ∈ {'done', 'lifecycle'} 标识写入来源。
    """
    if current is None:
        return incoming
    cur_status, _, cur_source = current
    inc_status, _, inc_source = incoming

    # DONE 是权威：lifecycle 不能覆盖
    if cur_source == "done" and inc_source == "lifecycle":
        return current
    # lifecycle 被 DONE 覆盖
    if cur_source == "lifecycle" and inc_source == "done":
        return incoming
    # 同 source：error 优先
    if cur_status == "error" and inc_status != "error":
        return current
    return incoming


def _publish_trace_event_to_ws(
    trace_id_uuid: uuid.UUID,
    trace_event_obj: TraceEvent,
) -> None:
    """把单条 TraceEvent 推送到 `trace.stream.{trace_id}` 频道。

    AdminDash `useTraceStream` 订阅此频道做实时刷新（trace-detail 页 / 任何
    未来需要 trace 流的页面）。语义对齐 `trace_recorder._publish_event`：
    envelope.type = `trace.stream.event`，payload 用 `build_record_event_ws_payload`，
    SSETraceEvent shape 与服务端 trace 完全一致。

    失败永不冒泡——publish 是次要可观测性，写表已经成功，单条 publish 失败
    顶多让前端漏掉一条 onEvent 触发，下次定时拉取仍能恢复。`publish_ws_event`
    本身已 fire-and-forget + retry 内部处理，这里只做最外层兜底。

    设计 trade-off：
      - 全量推送（每条 event 1 个 envelope）vs 批量推送（1 batch 1 个 envelope）
        选了全量：与 trace_recorder 行为完全一致，前端 hook 无需特化处理本地
        来源；单 batch 500 条 publish 在 Redis 层 < 250ms（fire-and-forget）。
      - 不推 'start' 半事件（trace_recorder 才有），因为 relay 的 event 在 ORM
        创建时就是 'end' 状态（duration/output 已就位），没有"半完成"中间态。
    """
    try:
        channel = f"trace.stream.{trace_id_uuid}"
        ws_payload = build_record_event_ws_payload(
            event_uuid=trace_event_obj.event_uuid,
            trace_id=trace_id_uuid,
            event_type=trace_event_obj.event_type,
            name=trace_event_obj.name,
            seq=trace_event_obj.seq,
            started_at=trace_event_obj.started_at,
            ended_at=trace_event_obj.ended_at or trace_event_obj.started_at,
            duration_ms=trace_event_obj.duration_ms,
            parent_event_uuid=None,
            input_data=trace_event_obj.input,
            output_data=trace_event_obj.output,
            error=trace_event_obj.error,
            usage=trace_event_obj.usage,
        )
        event_id = new_event_id()
        envelope = build_envelope(
            TRACE_STREAM_EVENT_TYPE,
            event_id,
            ws_payload,
            event_id=event_id,
            trace_id=str(trace_id_uuid),
        )
        publish_ws_event(channel, envelope)
    except Exception:
        logger.warning(
            "[RelayTraceWriter] publish trace.stream event 失败（写表已成功，不影响数据完整性）: trace=%s event_uuid=%s",
            trace_id_uuid,
            trace_event_obj.event_uuid,
            exc_info=True,
        )


def _publish_trace_end_to_ws(
    trace_id_uuid: uuid.UUID,
    status: str,
    error: str | None,
    ended_at,
) -> None:
    """trace 终结时推 trace_end envelope，让 useTraceStream onTraceEnd 触发。

    关键作用：让 AdminDash trace-detail 页在 trace 终止时主动 client.close()，
    避免 WS 订阅长期占用。`trace_recorder.end_trace` 也走相同模式。
    """
    try:
        channel = f"trace.stream.{trace_id_uuid}"
        ws_payload = build_trace_end_ws_payload(trace_id_uuid, status, error, ended_at)
        event_id = new_event_id()
        envelope = build_envelope(
            TRACE_STREAM_EVENT_TYPE,
            event_id,
            ws_payload,
            event_id=event_id,
            trace_id=str(trace_id_uuid),
        )
        publish_ws_event(channel, envelope)
    except Exception:
        logger.warning(
            "[RelayTraceWriter] publish trace_end 失败（DB status 已更新，仅影响前端 onTraceEnd 触发）: trace=%s",
            trace_id_uuid,
            exc_info=True,
        )


def _extract_usage_from_done(payload: dict) -> dict | None:
    """从 DONE event payload 提取 usage 字段写入 TraceEvent.usage。

    PRD-04 Phase 4 T4.1：修复 relay 写 TraceEvent 时 usage 列常为 null 的问题（现状 D4）。
    """
    usage = payload.get("usage")
    if not isinstance(usage, dict):
        return None
    result = {}
    for key in (
        "input_tokens", "output_tokens", "cost_usd",
        "cache_read_input_tokens", "cache_creation_input_tokens",
        "reasoning_tokens", "compact_input_tokens", "compact_output_tokens",
        "charge_status", "by_model",
    ):
        val = usage.get(key)
        if val is not None:
            result[key] = val
    return result if result else None


def _make_trace_event(
    trace: ExecutionTrace,
    seq: int,
    short_name: str,
    payload: dict,
    started_at,
) -> TraceEvent:
    """构造一条 TraceEvent（不入库）。

    sanitize 通过 `sanitize_serializable` 复用 trace_formatters 已有的脱敏 +
    JSON 序列化保障，与服务端 trace 行为一致。
    """
    event_name = _derive_event_name(short_name, payload)

    is_error = bool(payload.get("error") or payload.get("is_error"))
    error_text = None
    if is_error:
        error_text = str(payload.get("error_message") or payload.get("error") or "")[:2000]

    usage_data = _extract_usage_from_done(payload) if short_name == "done" else None

    return TraceEvent(
        trace=trace,
        event_uuid=uuid.uuid4(),
        event_type=short_name,
        name=event_name,
        seq=seq,
        started_at=started_at,
        ended_at=started_at,
        duration_ms=None,
        input=sanitize_serializable(payload),
        output=None,
        error=error_text,
        usage=usage_data,
    )


def _persist_relay_events_to_trace_sync(
    session_id: str,
    thread_id: str,
    events: list[dict],
) -> dict[str, int]:
    """把 relay events 写入 ExecutionTrace / TraceEvent（同步实现 — 测试入口）。

    返回统计：{ traces_created, events_written, traces_finalized, skipped_no_trace_id }。

    永不抛出——上层 try/except 兜底。失败就返回当前进度统计。

    设计 trade-off：
      - 同 batch 内可能含多个 trace_id（用户极快连发多条对话）；按 trace_id
        分组后逐组处理。
      - "首次见的 trace_id" → 创建 ExecutionTrace（带 metadata.runtime='local' +
        graph_type='local-runtime'）。从 ChatSession 查 user_id/organization_id 用于
        权限校验和 user_traces 端点。
      - bulk_create + 单次 UPDATE 分配 seq 范围 → 500-event batch 只有 1 次 UPDATE
        和 1 次 INSERT，远比逐条 _next_seq 高效。

    生产入口请用 ``persist_relay_events_to_trace``（已被 ``database_sync_to_async``
    包装）。本同步函数仅供单元测试直接调用，避免为 mock 测试套一层 asyncio 跑环。
    """
    from django.utils import timezone
    from apps.chat.conversation.models import ChatSession

    db_alias = "postgresql"
    stats = {
        "traces_created": 0,
        "events_written": 0,
        "traces_finalized": 0,
        "skipped_no_trace_id": 0,
    }

    # 按 trace_id 分组
    by_trace: dict[str, list[dict]] = {}
    for evt in events:
        payload = evt.get("payload") if isinstance(evt, dict) else None
        if not isinstance(payload, dict):
            continue
        trace_id = payload.get("trace_id")
        if not trace_id or not isinstance(trace_id, str):
            stats["skipped_no_trace_id"] += 1
            continue
        by_trace.setdefault(trace_id, []).append(evt)

    if not by_trace:
        return stats

    # 一次查 ChatSession 拿 user/organization/space，多个 trace_id 复用
    session_user_id: str | None = None
    session_organization_id: str | None = None
    session_space_id: str | None = None
    session_title: str = ""
    try:
        sess = (
            ChatSession.objects.filter(id=session_id)
            .values("user_id", "organization_id", "workspace_id", "title")
            .first()
        )
        if sess:
            session_user_id = str(sess["user_id"]) if sess.get("user_id") else None
            session_organization_id = str(sess["organization_id"]) if sess.get("organization_id") else None
            session_space_id = str(sess["workspace_id"]) if sess.get("workspace_id") else None
            session_title = str(sess.get("title") or "")
    except Exception:
        logger.warning(
            "[RelayTraceWriter] 查 ChatSession 失败（写表降级，不阻塞 publish_ws）: session=%s",
            session_id,
            exc_info=True,
        )

    # 团队 Space 动态流：懒解析 + batch 内 memo——只有真的要记事件
    # （trace 创建 / 终结）时才查一次 Space；非 team_space 会话缓存 None。
    _activity_team_space_memo: dict[str, Any] = {}

    def _get_activity_team_space():
        if "value" not in _activity_team_space_memo:
            _activity_team_space_memo["value"] = _resolve_team_space_for_activity(session_space_id)
        return _activity_team_space_memo["value"]

    for trace_id_str, group_events in by_trace.items():
        try:
            try:
                trace_uuid = uuid.UUID(trace_id_str)
            except (ValueError, TypeError):
                logger.warning(
                    "[RelayTraceWriter] 跳过非法 trace_id 字符串: %s",
                    trace_id_str,
                )
                continue

            # LH2-A1：判断本组事件是否属于"子 Agent trace"——agent-tool 在转发
            # child raw events 时注入 `parent_trace_id` / `subagent_run_id`
            # 字段。任意一条 event 含此字段即视为子 trace。父 trace 的事件
            # 永远没有 parent_trace_id（query.ts yield 的 lifecycle 不写此字段），
            # 所以判定不会误伤父事件。
            is_subagent_trace = False
            parent_trace_id_str: str | None = None
            subagent_run_id_str: str | None = None
            for evt in group_events:
                p = evt.get("payload") or {}
                pid = p.get("parent_trace_id")
                if isinstance(pid, str) and pid:
                    is_subagent_trace = True
                    parent_trace_id_str = pid
                    sid = p.get("subagent_run_id")
                    if isinstance(sid, str) and sid:
                        subagent_run_id_str = sid
                    break

            trace_metadata: dict = {
                # H2-A FR-10：metadata.runtime 显式标记本地来源，与
                # graph_type='local-runtime[-subagent]' 双重保险，便于 AdminDash
                # trace-list 通过 metadata 过滤。
                "runtime": "local",
                "source": "agent-runtime",
            }
            if is_subagent_trace:
                # LH2-A1：把 parent_trace_id 写到 metadata，让 AdminDash 嵌套
                # 展示"从父 trace 节点跳转到子 trace"的路径成立。
                trace_metadata["parent_trace_id"] = parent_trace_id_str
                if subagent_run_id_str:
                    trace_metadata["subagent_run_id"] = subagent_run_id_str

            with transaction.atomic(using=db_alias):
                trace, created = ExecutionTrace.objects.using(db_alias).get_or_create(
                    trace_id=trace_uuid,
                    defaults={
                        "thread_id": thread_id,
                        "graph_type": (
                            LOCAL_RUNTIME_SUBAGENT_GRAPH_TYPE
                            if is_subagent_trace
                            else LOCAL_RUNTIME_GRAPH_TYPE
                        ),
                        "session_id": session_id,
                        "user_id": session_user_id,
                        "organization_id": session_organization_id,
                        "status": "running",
                        "metadata": trace_metadata,
                    },
                )
                if created:
                    stats["traces_created"] += 1
                # team_space 动态流用：本批处理前 trace 是否已终结（防重复记终态事件）
                prior_status = "running" if created else (trace.status or "")

                # SELECT FOR UPDATE 锁 row → 一次性分配 seq 范围
                # 用 raw SQL 避免 ORM update 的复杂性
                conn = connections[db_alias]
                table = ExecutionTrace._meta.db_table
                n = len(group_events)
                with conn.cursor() as cursor:
                    cursor.execute(
                        f'UPDATE "{table}" SET last_event_seq = last_event_seq + %s '
                        f"WHERE id = %s RETURNING last_event_seq",
                        [n, trace.id],
                    )
                    row = cursor.fetchone()
                    if not row:
                        logger.warning(
                            "[RelayTraceWriter] last_event_seq 更新失败: trace=%s",
                            trace_id_str,
                        )
                        continue
                    new_last_seq = row[0]
                # 分配 seq：[new_last_seq - n + 1, new_last_seq]
                start_seq = new_last_seq - n + 1

                now = timezone.now()
                trace_event_objs: list[TraceEvent] = []
                # H2-A P0 修复：终结状态用 (status, error, source) 三元组，
                # `_merge_trace_finalize` 决定 DONE / lifecycle 的优先级。
                trace_finalize: tuple[str, str | None, str] | None = None

                for i, evt in enumerate(group_events):
                    payload = evt.get("payload") or {}
                    event_type = evt.get("type") or ""
                    short_name = _short_name_from_stream_type(event_type)

                    trace_event_objs.append(
                        _make_trace_event(
                            trace=trace,
                            seq=start_seq + i,
                            short_name=short_name,
                            payload=payload,
                            started_at=now,
                        )
                    )

                    # 收集 trace 终止信号
                    # query.ts 多数错误路径是 "yield DONE(error) → break → finally yield lifecycle.end"，
                    # 一批里同时含 DONE(error) + lifecycle.end(=completed)。
                    # 后写覆盖会让 AdminDash 把失败显示为成功（技术 Review #1 P0 bug）。
                    if _is_done_event(short_name):
                        status, error = _resolve_done_status(payload)
                        trace_finalize = _merge_trace_finalize(
                            trace_finalize, (status, error, "done"),
                        )
                    elif _is_terminal_lifecycle(short_name, payload):
                        status, error = _resolve_lifecycle_status(payload)
                        trace_finalize = _merge_trace_finalize(
                            trace_finalize, (status, error, "lifecycle"),
                        )

                # 一次性插入 TraceEvent
                TraceEvent.objects.using(db_alias).bulk_create(trace_event_objs)
                stats["events_written"] += len(trace_event_objs)

                # 终结 trace（status → completed / error）
                if trace_finalize is not None:
                    status, error, _source = trace_finalize
                    ExecutionTrace.objects.using(db_alias).filter(trace_id=trace_uuid).update(
                        status=status,
                        error=error,
                        ended_at=now,
                    )
                    stats["traces_finalized"] += 1

            # H2-A FR-10：写表成功后向 `trace.stream.{trace_id}` 频道双推。
            # 关键背景：`ChatStreamPublisher.publish_ws` 推到 `agent.stream.{thread_id}`
            # （移动端 / chat UI 用），AdminDash `useTraceStream` 订阅的是
            # `trace.stream.{trace_id}` 频道——两个频道完全不同。如果不在这里
            # 双推，AdminDash trace-detail 页的"实时刷新"承诺对本地 Runtime
            # 完全失效（UI 显示"实时连接"但 events 永远不刷新——欺骗性 UI）。
            #
            # 放在 atomic 块外是有意：publish 失败不应让写表回滚——AdminDash 实时
            # 刷新是"次要可观测性"，DB 数据完整性是"主要"。两者通过 try/except
            # 各自独立。`publish_ws_event` 本身 fire-and-forget + 内部 retry。
            for trace_event_obj in trace_event_objs:
                _publish_trace_event_to_ws(trace_uuid, trace_event_obj)

            if trace_finalize is not None:
                _publish_trace_end_to_ws(trace_uuid, trace_finalize[0], trace_finalize[1], now)

            # 团队 Space 动态流：run 开始 / 终态留痕（best-effort，子 Agent trace
            # 不记，避免一次任务在动态流里 N 倍刷屏）。
            if not is_subagent_trace and (created or trace_finalize is not None):
                team_space = _get_activity_team_space()
                if team_space is not None:
                    _record_team_space_run_activity(
                        team_space,
                        actor_user_id=session_user_id,
                        session_id=session_id,
                        session_title=session_title,
                        trace_id=trace_id_str,
                        run_started=created,
                        finalize=(
                            trace_finalize
                            if trace_finalize is not None
                            and prior_status not in _TERMINAL_TRACE_STATUSES
                            else None
                        ),
                    )

        except Exception:
            logger.warning(
                "[RelayTraceWriter] trace_id=%s 写表失败（降级，不阻塞 publish_ws）",
                trace_id_str,
                exc_info=True,
            )
            # 继续处理下一个 trace_id 而不是整批失败
            continue

    return stats


# ── 团队 Space 动态流（阶段3）────────────────────────────────────────────
# Agent 任务开始/终态的后端单点收口就在本模块（run 级 ExecutionTrace 的创建
# 与 finalize），因此动态流的 agent_run_* 事件在这里落。写入 best-effort，
# 与 trace 写表互不阻塞。

# 与 _resolve_done_status / _resolve_lifecycle_status 可能产出的终态对齐；
# prior_status 命中即视为「本 trace 已记过终态事件」，跳过重复留痕。
_TERMINAL_TRACE_STATUSES = {"completed", "error", "terminated", "cancelled"}


def _resolve_team_space_for_activity(space_id: str | None):
    """解析会话成果应回流到的 team_space Project（永不抛出）。

    Project 任务的 ChatSession 实际挂在当前成员自己的伴生 Workspace 上，
    因此除了直接属于 team_space 的历史会话，还要沿 ``Space.project`` 回指
    Project。普通个人 Workspace 没有 Project 归属，仍然返回 ``None``。
    """
    if not space_id:
        return None
    try:
        from apps.tabtinspace.services.host_resolver import resolve_host
        from apps.tabtinspace.services.project_execution import (
            resolve_project_collaboration_space,
        )

        space = resolve_host(space_id)
        return resolve_project_collaboration_space(space)
    except Exception:
        logger.warning(
            "[RelayTraceWriter] 解析 team_space 失败（跳过动态流留痕）: space=%s",
            space_id,
            exc_info=True,
        )
    return None


def _record_team_space_run_activity(
    team_space: Any,
    *,
    actor_user_id: str | None,
    session_id: str,
    session_title: str,
    trace_id: str,
    run_started: bool,
    finalize: tuple[str, str | None, str] | None,
) -> None:
    """向团队 Space 动态流记 agent_run_started / completed / failed（永不抛出）。"""
    if not run_started and finalize is None:
        return
    try:
        from apps.tabtinspace.models import SpaceActivityEvent
        from apps.tabtinspace.services.space_activity_service import (
            record_team_space_activity,
        )

        actor_user = None
        if actor_user_id:
            from django.contrib.auth import get_user_model

            actor_user = get_user_model().objects.filter(id=actor_user_id).first()

        target_name = session_title or "Agent 任务"
        base_metadata = {"trace_id": trace_id, "session_id": session_id}

        if run_started:
            record_team_space_activity(
                team_space,
                SpaceActivityEvent.EventType.AGENT_RUN_STARTED,
                actor_user=actor_user,
                target_type="agent_run",
                target_id=trace_id,
                target_name=target_name,
                metadata=base_metadata,
            )

        if finalize is not None:
            status, error, _source = finalize
            event_type = (
                SpaceActivityEvent.EventType.AGENT_RUN_COMPLETED
                if status == "completed"
                else SpaceActivityEvent.EventType.AGENT_RUN_FAILED
            )
            finalize_metadata = dict(base_metadata, status=status)
            if error:
                finalize_metadata["error"] = str(error)[:500]
            record_team_space_activity(
                team_space,
                event_type,
                actor_user=actor_user,
                target_type="agent_run",
                target_id=trace_id,
                target_name=target_name,
                metadata=finalize_metadata,
            )
            _post_team_space_agent_update(
                team_space,
                actor_user_id=actor_user_id,
                session_id=session_id,
                session_title=target_name,
                trace_id=trace_id,
                status=status,
                error=error,
            )
    except Exception:
        logger.warning(
            "[RelayTraceWriter] 团队 Space 动态流留痕失败（不影响 trace 写表）: trace=%s",
            trace_id,
            exc_info=True,
        )


def _post_team_space_agent_update(
    team_space: Any,
    *,
    actor_user_id: str | None,
    session_id: str,
    session_title: str,
    trace_id: str,
    status: str,
    error: str | None,
) -> None:
    """把 Agent 任务成功摘要写入 Team Space 的 #agent-updates 频道（best-effort）。"""
    if not actor_user_id or status != "completed":
        return
    try:
        from apps.tabchat.constants import MessageType
        from apps.tabchat.models import Conversation
        from apps.tabchat.services.message_service import MessageService

        channel = (
            Conversation.objects.filter(
                organization_id=str(team_space.organization_id),
                space_id=team_space.id,
                name="#agent-updates",
                is_archived=False,
            )
            .only("id")
            .first()
        )
        if channel is None:
            return

        title = (session_title or "Agent 任务").strip()
        content = f"Agent 任务已完成：{title}\n打开任务线程查看过程与最终产物。"

        MessageService.send_message(
            conversation_id=str(channel.id),
            sender_id=str(actor_user_id),
            content=content,
            message_type=MessageType.TEXT,
            metadata={
                "team_space_agent_update": True,
                "session_id": session_id,
                "trace_id": trace_id,
                "status": status,
                "title": title,
            },
        )
    except Exception:
        logger.warning(
            "[RelayTraceWriter] 写入 #agent-updates 失败（不影响 Agent 任务）: trace=%s",
            trace_id,
            exc_info=True,
        )


# H2-A FR-10：channels async handler 入口。
# `database_sync_to_async` 让同步 ORM 调用在 channels 的 thread pool 里跑，
# 不阻塞 ASGI event loop。生产代码在 relay_handler 中 await 这个版本。
persist_relay_events_to_trace = database_sync_to_async(
    _persist_relay_events_to_trace_sync,
)
