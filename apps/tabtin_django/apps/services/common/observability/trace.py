"""
Agent Trace Recorder

统一记录 Agent 的节点/LLM/工具/前端事件，支持回放与实时推送。

从 agent_engine/middleware/trace.py 迁出。原位置保留 re-export stub。
"""

from __future__ import annotations

__all__ = [
    "trace_id_var",
    "thread_id_var",
    "graph_type_var",
    "user_id_var",
    "parent_event_id_var",
    "last_node_event_id_var",
    "resolve_trace_for_external_event",
    "get_current_parent_event_id",
    "set_current_parent_event_id",
    "reset_current_parent_event_id",
    "get_current_trace_id",
    "get_last_node_event_id",
    "set_last_node_event_id",
    "TraceContext",
    "TraceRecorder",
    "flush_pending_trace_publishes",
    "TRACE_PUBLISH_BEAT_SCHEDULE",
]

import logging
import uuid
from contextvars import ContextVar
from typing import Any, Optional

from datetime import timedelta

from celery import shared_task
from django.db import connections, transaction
from django.utils import timezone

from apps.services.agent_engine.models import ExecutionTrace
from apps.services.common.observability.trace_formatters import (
    PENDING_BATCH_SIZE,
    PENDING_MAX_AGE_SECONDS,
    PENDING_MAX_ATTEMPTS,
    PENDING_TABLE,
    ensure_json_serializable,
    normalize_pending_row_payload,
    pending_delete_expired_sql,
    pending_delete_success_ids_sql,
    pending_select_for_flush_sql,
    pending_update_attempts_sql,
    stable_ws_event_id,
)
from apps.services.common.ws.bus import publish_ws_event
from apps.services.common.ws.protocol import build_envelope, new_event_id

logger = logging.getLogger(__name__)

trace_id_var: ContextVar[Optional[uuid.UUID]] = ContextVar("trace_id", default=None)
thread_id_var: ContextVar[Optional[str]] = ContextVar("thread_id", default=None)
graph_type_var: ContextVar[Optional[str]] = ContextVar("graph_type", default=None)
user_id_var: ContextVar[Optional[str]] = ContextVar("user_id", default=None)
parent_event_id_var: ContextVar[Optional[int]] = ContextVar("parent_event_id", default=None)
last_node_event_id_var: ContextVar[Optional[int]] = ContextVar("last_node_event_id", default=None)


def resolve_trace_for_external_event(
    thread_id: str,
    trace_id: Optional[str] = None,
) -> tuple[Optional[ExecutionTrace], Optional[str]]:
    if trace_id:
        trace = ExecutionTrace.objects.filter(trace_id=trace_id).first()
        if not trace:
            return None, "trace_not_found"
        if trace.thread_id != thread_id:
            return None, "trace_thread_mismatch"
        return trace, None

    running_qs = ExecutionTrace.objects.filter(thread_id=thread_id, status="running")
    running_count = running_qs.count()
    if running_count == 1:
        return running_qs.first(), None
    if running_count > 1:
        return None, "multiple_running_traces"
    return None, "no_running_trace"


def get_current_parent_event_id() -> Optional[int]:
    return parent_event_id_var.get()


def set_current_parent_event_id(event_id: Optional[int]):
    return parent_event_id_var.set(event_id)


def reset_current_parent_event_id(token):
    parent_event_id_var.reset(token)


def get_current_trace_id() -> Optional[uuid.UUID]:
    return trace_id_var.get()


def get_last_node_event_id() -> Optional[int]:
    return last_node_event_id_var.get()


def set_last_node_event_id(event_id: Optional[int]):
    return last_node_event_id_var.set(event_id)


from apps.services.common.observability.trace_recorder import TraceContext, TraceRecorder  # noqa: E402


_FLUSH_LOCK_KEY = "flush_pending_trace_publishes:mutex"
_FLUSH_LOCK_TIMEOUT = 55


@shared_task(
    bind=True,
    ignore_result=True,
    time_limit=60,
    soft_time_limit=50,
    name="apps.services.common.observability.trace.flush_pending_trace_publishes",
)
def flush_pending_trace_publishes(
    self,
    batch_size: int = PENDING_BATCH_SIZE,
    max_attempts: int = PENDING_MAX_ATTEMPTS,
):
    from apps.services.common.observability.trace_recorder import _ensure_pending_table

    redis_lock = None
    try:
        from django_redis import get_redis_connection
        rc = get_redis_connection("default")
        redis_lock = rc.lock(_FLUSH_LOCK_KEY, timeout=_FLUSH_LOCK_TIMEOUT)
        if not redis_lock.acquire(blocking=False):
            logger.debug("[TraceRecorder] flush_pending 跳过：另一 Worker 正在执行")
            return {"success": True, "skipped": "lock_held"}
    except Exception as exc:
        logger.warning("[TraceRecorder] Redis 锁获取失败，降级执行: %s", exc)
        redis_lock = None

    db_alias = "postgresql"
    try:
        _ensure_pending_table(db_alias)
    except Exception:
        _release_lock(redis_lock)
        return {"success": False, "error": "pending table creation failed"}

    conn = connections[db_alias]
    flushed = retried = expired = 0

    try:
        cutoff = timezone.now() - timedelta(seconds=PENDING_MAX_AGE_SECONDS)
        with conn.cursor() as cursor:
            cursor.execute(pending_delete_expired_sql(PENDING_TABLE), [cutoff])
            expired = cursor.rowcount

        with transaction.atomic(using=db_alias):
            with conn.cursor() as cursor:
                cursor.execute(
                    pending_select_for_flush_sql(PENDING_TABLE),
                    [max_attempts, batch_size],
                )
                rows = cursor.fetchall()

            if not rows and expired == 0:
                _release_lock(redis_lock)
                return {"success": True, "flushed": 0, "retried": 0, "expired": 0}

            success_ids: list[int] = []
            fail_updates: list[tuple[int, int]] = []

            for row_id, trace_id, channel, payload_data, attempts, evt_uuid in rows:
                try:
                    payload_obj = normalize_pending_row_payload(payload_data)
                    stable_id = stable_ws_event_id(evt_uuid, new_event_id())
                    envelope = build_envelope(
                        "trace.stream.event",
                        stable_id,
                        ensure_json_serializable(payload_obj),
                        event_id=stable_id,
                        trace_id=str(trace_id),
                    )
                    if publish_ws_event(channel, envelope):
                        success_ids.append(row_id)
                        flushed += 1
                    else:
                        fail_updates.append((row_id, attempts + 1))
                        retried += 1
                except Exception as exc:
                    logger.debug("flush_pending 单条重试异常 id=%s: %s", row_id, exc)
                    fail_updates.append((row_id, attempts + 1))
                    retried += 1

            with conn.cursor() as cursor:
                if success_ids:
                    cursor.execute(pending_delete_success_ids_sql(PENDING_TABLE), [success_ids])
                for row_id, new_attempts in fail_updates:
                    cursor.execute(pending_update_attempts_sql(PENDING_TABLE), [new_attempts, row_id])

        if flushed or retried or expired:
            logger.info(
                "[TraceRecorder] flush_pending: flushed=%d retried=%d expired=%d",
                flushed, retried, expired,
            )
        _release_lock(redis_lock)
        return {"success": True, "flushed": flushed, "retried": retried, "expired": expired}
    except Exception as exc:
        logger.error("[TraceRecorder] flush_pending 异常: %s", exc, exc_info=True)
        _release_lock(redis_lock)
        return {"success": False, "error": str(exc)}


def _release_lock(lock) -> None:
    if lock is None:
        return
    try:
        lock.release()
    except Exception as exc:
        logger.debug("[TraceRecorder] Redis 锁释放失败（可能已释放或过期）: %s", exc)


TRACE_PUBLISH_BEAT_SCHEDULE = {
    "flush-pending-trace-publishes": {
        "task": "apps.services.common.observability.trace.flush_pending_trace_publishes",
        "schedule": 30,
        "options": {"expires": 25},
    },
}
