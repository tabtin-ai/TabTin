"""TraceRecorder / TraceContext 与 DB+WS 持久化（与 trace_formatters 中的纯函数分离）。

从 agent_engine/middleware/trace_recorder.py 迁出。原位置保留 re-export stub。
"""

from __future__ import annotations

__all__ = [
    "TraceContext",
    "TraceRecorder",
]

import json
import logging
import threading
import time
import uuid
from typing import Any, Dict, Optional

from django.db import connection, connections, transaction
from django.utils import timezone

from apps.services.agent_engine.models import ExecutionTrace, TraceEvent
from apps.services.common.observability.trace_formatters import (
    PENDING_TABLE,
    build_event_end_ws_payload,
    build_event_start_ws_payload,
    build_external_record_ws_payload,
    build_record_event_ws_payload,
    build_trace_end_ws_payload,
    ensure_json_serializable,
    extract_trace_fields_from_initial_state,
    pending_delete_by_event_uuid_sql,
    pending_enqueue_sql_plain,
    pending_enqueue_sql_with_uuid_conflict,
    pending_trace_publish_ddl_statements,
    sanitize_serializable,
    stable_ws_event_id,
)
from apps.services.common.ws.bus import publish_ws_event
from apps.services.common.ws.protocol import build_envelope, new_event_id

logger = logging.getLogger(__name__)

_pending_table_lock = threading.Lock()
_pending_table_created = False


def _ensure_pending_table(db_alias: str = "postgresql"):
    global _pending_table_created
    if _pending_table_created:
        return
    with _pending_table_lock:
        if _pending_table_created:
            return
        try:
            conn = connections[db_alias]
            with conn.cursor() as cursor:
                for stmt in pending_trace_publish_ddl_statements(PENDING_TABLE):
                    cursor.execute(stmt)
            _pending_table_created = True
        except Exception as exc:
            logger.error("创建 %s 表失败: %s", PENDING_TABLE, exc, exc_info=True)


def _enqueue_pending_publish(
    trace_id: uuid.UUID,
    channel: str,
    payload: Dict[str, Any],
    db_alias: str = "postgresql",
    event_uuid: Optional[str] = None,
):
    try:
        _ensure_pending_table(db_alias)
        conn = connections[db_alias]
        with conn.cursor() as cursor:
            if event_uuid:
                cursor.execute(
                    pending_enqueue_sql_with_uuid_conflict(PENDING_TABLE),
                    [str(trace_id), event_uuid, channel, json.dumps(payload, default=str)],
                )
            else:
                cursor.execute(
                    pending_enqueue_sql_plain(PENDING_TABLE),
                    [str(trace_id), channel, json.dumps(payload, default=str)],
                )
    except Exception as exc:
        logger.error(
            "TraceRecorder 补偿队列写入失败: trace_id=%s error=%s",
            trace_id, exc, exc_info=True,
        )


def _delete_pending_by_event_uuid(event_uuid: str, db_alias: str = "postgresql"):
    try:
        conn = connections[db_alias]
        with conn.cursor() as cursor:
            cursor.execute(pending_delete_by_event_uuid_sql(PENDING_TABLE), [event_uuid])
    except Exception as exc:
        logger.warning(
            "[TraceRecorder] 删除 pending 补偿行失败（可能残留待重试记录）: %s", exc,
        )


def _publish_event(
    trace_id: uuid.UUID,
    payload: Dict[str, Any],
    db_alias: str = "postgresql",
    event_uuid: Optional[str] = None,
):
    channel = f"trace.stream.{trace_id}"
    stable_id = stable_ws_event_id(event_uuid, new_event_id())
    try:
        envelope = build_envelope(
            "trace.stream.event",
            stable_id,
            ensure_json_serializable(payload),
            event_id=stable_id,
            trace_id=str(trace_id),
        )
        if publish_ws_event(channel, envelope):
            if event_uuid:
                _delete_pending_by_event_uuid(event_uuid, db_alias)
            return
        logger.warning("TraceRecorder WS 推送失败，写入补偿队列: trace_id=%s", trace_id)
    except Exception as e:
        logger.warning("TraceRecorder _publish_event 异常: %s", e, exc_info=True)
    _enqueue_pending_publish(trace_id, channel, payload, db_alias, event_uuid=event_uuid)


def _next_seq(trace: ExecutionTrace) -> int:
    db_alias = trace._state.db or "default"
    table = ExecutionTrace._meta.db_table
    with transaction.atomic(using=db_alias):
        conn = connection if db_alias == "default" else connections[db_alias]
        with conn.cursor() as cursor:
            cursor.execute(
                f'UPDATE "{table}" SET last_event_seq = last_event_seq + 1 '
                f"WHERE id = %s RETURNING last_event_seq",
                [trace.id],
            )
            row = cursor.fetchone()
    return row[0]


def _resolve_event_uuid(db_alias: str, event_id: Optional[int]) -> Optional[str]:
    if not event_id:
        return None
    try:
        event_uuid = (
            TraceEvent.objects.using(db_alias)
            .values_list("event_uuid", flat=True)
            .get(id=event_id)
        )
        return str(event_uuid)
    except TraceEvent.DoesNotExist:
        return None


class TraceContext:
    """Trace 上下文句柄，用于清理 ContextVar。"""

    def __init__(
        self,
        tokens: Dict[str, Any],
        trace_id: uuid.UUID,
        tc_thread_id_token: Any = None,
    ):
        self._tokens = tokens
        self.trace_id = trace_id
        self._tc_thread_id_token = tc_thread_id_token

    def close(self):
        from apps.services.common.observability import trace as trace_mod

        for var_name, token in self._tokens.items():
            if var_name == "trace_id":
                trace_mod.trace_id_var.reset(token)
            elif var_name == "thread_id":
                trace_mod.thread_id_var.reset(token)
            elif var_name == "graph_type":
                trace_mod.graph_type_var.reset(token)
            elif var_name == "user_id":
                trace_mod.user_id_var.reset(token)
            elif var_name == "parent_event_id":
                trace_mod.parent_event_id_var.reset(token)
            elif var_name == "last_node_event_id":
                trace_mod.last_node_event_id_var.reset(token)
        if self._tc_thread_id_token is not None:
            try:
                from apps.services.common.thread_context import _thread_id_var
                _thread_id_var.reset(self._tc_thread_id_token)
            except Exception as exc:
                logger.debug("[TraceRecorder] TraceContext.close 重置 thread_context 失败: %s", exc)


class TraceRecorder:
    """Trace 记录器（DB + Redis 实时推送）。"""

    @staticmethod
    def start_trace(
        graph_type: str,
        thread_id: str,
        initial_state: Optional[Dict[str, Any]] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> TraceContext:
        from apps.services.common.observability import trace as trace_mod

        trace_fields = extract_trace_fields_from_initial_state(initial_state)
        trace = ExecutionTrace.objects.create(
            thread_id=thread_id,
            graph_type=graph_type,
            status="running",
            metadata=metadata or {},
            **trace_fields,
        )

        tc_thread_id_token = None
        try:
            from apps.services.common.thread_context import set_current_thread_id
            tc_thread_id_token = set_current_thread_id(thread_id)
        except Exception as exc:
            logger.warning("[TraceRecorder] start_trace 设置 thread_context 失败: %s", exc)

        tokens = {
            "trace_id": trace_mod.trace_id_var.set(trace.trace_id),
            "thread_id": trace_mod.thread_id_var.set(thread_id),
            "graph_type": trace_mod.graph_type_var.set(graph_type),
            "user_id": trace_mod.user_id_var.set(trace.user_id),
            "parent_event_id": trace_mod.parent_event_id_var.set(None),
            "last_node_event_id": trace_mod.last_node_event_id_var.set(None),
        }
        return TraceContext(tokens=tokens, trace_id=trace.trace_id, tc_thread_id_token=tc_thread_id_token)

    @staticmethod
    def end_trace(trace_id: uuid.UUID, status: str, error: Optional[str] = None):
        ended = timezone.now()
        ExecutionTrace.objects.filter(trace_id=trace_id).update(
            status=status,
            error=error,
            ended_at=ended,
        )
        _publish_event(
            trace_id,
            build_trace_end_ws_payload(trace_id, status, error, ended),
            event_uuid=f"{trace_id}:trace_end",
        )

    @staticmethod
    def start_event(
        event_type: str,
        name: str,
        input_data: Optional[Dict[str, Any]] = None,
        parent_event_id: Optional[int] = None,
        publish_start: bool = True,
    ) -> Optional[int]:
        from apps.services.common.observability import trace as trace_mod

        current_trace_id = trace_mod.trace_id_var.get()
        if not current_trace_id:
            return None
        trace = ExecutionTrace.objects.get(trace_id=current_trace_id)
        db_alias = trace._state.db or "default"
        seq = _next_seq(trace)
        event = TraceEvent.objects.using(db_alias).create(
            trace=trace,
            parent_event_id=parent_event_id,
            event_uuid=uuid.uuid4(),
            event_type=event_type,
            name=name,
            seq=seq,
            input=sanitize_serializable(input_data),
        )
        if publish_start:
            parent_event_uuid = _resolve_event_uuid(db_alias, parent_event_id)
            _publish_event(
                trace.trace_id,
                build_event_start_ws_payload(
                    event_uuid=event.event_uuid,
                    trace_id=trace.trace_id,
                    event_type=event.event_type,
                    name=event.name,
                    seq=event.seq,
                    started_at=event.started_at,
                    parent_event_uuid=parent_event_uuid,
                    input_data=event.input,
                ),
                db_alias=db_alias,
                event_uuid=f"{event.event_uuid}:start",
            )
        return event.id

    @staticmethod
    def end_event(
        event_id: Optional[int],
        output_data: Optional[Dict[str, Any]] = None,
        error: Optional[str] = None,
        usage: Optional[Dict[str, Any]] = None,
        started_monotonic: Optional[float] = None,
    ):
        if not event_id:
            return
        ended_at = timezone.now()
        duration_ms = None
        if started_monotonic is not None:
            duration_ms = int((time.monotonic() - started_monotonic) * 1000)

        safe_output = sanitize_serializable(output_data)
        safe_usage = ensure_json_serializable(usage)

        TraceEvent.objects.filter(id=event_id).update(
            ended_at=ended_at,
            duration_ms=duration_ms,
            output=safe_output,
            error=error,
            usage=safe_usage,
        )

        event = TraceEvent.objects.select_related("trace").get(id=event_id)
        db_alias = event._state.db or "default"
        parent_event_uuid = _resolve_event_uuid(db_alias, event.parent_event_id)
        _publish_event(
            event.trace.trace_id,
            build_event_end_ws_payload(
                event_uuid=event.event_uuid,
                trace_id=event.trace.trace_id,
                event_type=event.event_type,
                name=event.name,
                seq=event.seq,
                started_at=event.started_at,
                ended_at=ended_at,
                duration_ms=duration_ms,
                parent_event_uuid=parent_event_uuid,
                input_data=event.input,
                output_data=event.output,
                error=event.error,
                usage=event.usage,
            ),
            db_alias=db_alias,
            event_uuid=f"{event.event_uuid}:end",
        )

    @staticmethod
    def record_event(
        event_type: str,
        name: str,
        input_data: Optional[Dict[str, Any]] = None,
        output_data: Optional[Dict[str, Any]] = None,
        error: Optional[str] = None,
        usage: Optional[Dict[str, Any]] = None,
        duration_ms: Optional[int] = None,
        parent_event_id: Optional[int] = None,
    ) -> Optional[int]:
        from apps.services.common.observability import trace as trace_mod

        current_trace_id = trace_mod.trace_id_var.get()
        if not current_trace_id:
            return None
        trace = ExecutionTrace.objects.get(trace_id=current_trace_id)
        db_alias = trace._state.db or "default"
        seq = _next_seq(trace)
        started_at = timezone.now()
        ended_at = timezone.now()
        event = TraceEvent.objects.using(db_alias).create(
            trace=trace,
            parent_event_id=parent_event_id,
            event_uuid=uuid.uuid4(),
            event_type=event_type,
            name=name,
            seq=seq,
            started_at=started_at,
            ended_at=ended_at,
            duration_ms=duration_ms,
            input=sanitize_serializable(input_data),
            output=sanitize_serializable(output_data),
            error=error,
            usage=ensure_json_serializable(usage),
        )
        parent_event_uuid = _resolve_event_uuid(db_alias, parent_event_id)
        _publish_event(
            trace.trace_id,
            build_record_event_ws_payload(
                event_uuid=event.event_uuid,
                trace_id=trace.trace_id,
                event_type=event.event_type,
                name=event.name,
                seq=event.seq,
                started_at=started_at,
                ended_at=ended_at,
                duration_ms=duration_ms,
                parent_event_uuid=parent_event_uuid,
                input_data=event.input,
                output_data=event.output,
                error=event.error,
                usage=event.usage,
            ),
            db_alias=db_alias,
            event_uuid=str(event.event_uuid),
        )
        return event.id

    @staticmethod
    def record_external_event_by_thread(
        thread_id: str,
        event_type: str,
        name: str,
        input_data: Optional[Dict[str, Any]] = None,
        output_data: Optional[Dict[str, Any]] = None,
        error: Optional[str] = None,
        trace_id: Optional[str] = None,
    ) -> Optional[int]:
        from apps.services.common.observability import trace as trace_mod

        trace, _error = trace_mod.resolve_trace_for_external_event(thread_id=thread_id, trace_id=trace_id)
        if not trace:
            return None
        db_alias = trace._state.db or "default"
        seq = _next_seq(trace)
        started_at = timezone.now()
        ended_at = timezone.now()
        event = TraceEvent.objects.using(db_alias).create(
            trace=trace,
            event_type=event_type,
            name=name,
            seq=seq,
            started_at=started_at,
            ended_at=ended_at,
            event_uuid=uuid.uuid4(),
            input=sanitize_serializable(input_data),
            output=sanitize_serializable(output_data),
            error=error,
        )
        _publish_event(
            trace.trace_id,
            build_external_record_ws_payload(
                event_uuid=event.event_uuid,
                trace_id=trace.trace_id,
                event_type=event.event_type,
                name=event.name,
                seq=event.seq,
                started_at=started_at,
                ended_at=ended_at,
                input_data=event.input,
                output_data=event.output,
                error=event.error,
            ),
            db_alias=db_alias,
            event_uuid=str(event.event_uuid),
        )
        return event.id
