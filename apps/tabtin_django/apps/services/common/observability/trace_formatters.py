"""
Trace 序列化 / 脱敏 / WS 载荷构造等纯函数与静态数据。

与 TraceRecorder、补偿队列等生命周期代码解耦，便于单测与复用。
从 agent_engine/middleware/trace_formatters.py 迁出。原位置保留 re-export stub。
"""

from __future__ import annotations

__all__ = [
    "mask_sensitive_text",
    "sanitize_for_trace",
    "ensure_json_serializable",
    "extract_trace_fields_from_initial_state",
    "sanitize_serializable",
    "build_trace_end_ws_payload",
    "build_event_start_ws_payload",
    "build_event_end_ws_payload",
    "build_record_event_ws_payload",
    "build_external_record_ws_payload",
    "PENDING_TABLE",
    "PENDING_MAX_ATTEMPTS",
    "PENDING_BATCH_SIZE",
    "PENDING_MAX_AGE_SECONDS",
    "pending_trace_publish_ddl_statements",
    "pending_enqueue_sql_with_uuid_conflict",
    "pending_enqueue_sql_plain",
    "pending_delete_by_event_uuid_sql",
    "pending_delete_expired_sql",
    "pending_select_for_flush_sql",
    "pending_delete_success_ids_sql",
    "pending_update_attempts_sql",
    "normalize_pending_row_payload",
    "stable_ws_event_id",
]

import json
import re
import uuid
from datetime import datetime
from typing import Any, Dict, Optional

# ── 敏感信息脱敏 ─────────────────────────────────────────────────────────

_SENSITIVE_PATTERNS = re.compile(
    r"(?i)"
    r"(?:"
    r'"(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|authorization|credential)'
    r'"\s*:\s*"[^"]{3,}"'
    r"|"
    r"(?:Bearer|Basic)\s+[A-Za-z0-9_.\-/+=]{8,}"
    r"|"
    r"(?:sk-|ttn_|ghp_|gho_|xoxb-|xoxp-)[A-Za-z0-9_.\-]{8,}"
    r")"
)


def mask_sensitive_text(text: str) -> str:
    """对文本中的敏感信息做脱敏。"""
    if not text or not isinstance(text, str):
        return text
    return _SENSITIVE_PATTERNS.sub(lambda m: m.group()[:8] + "***MASKED***", text)


def sanitize_for_trace(data: Any) -> Any:
    """对 trace 事件的 input/output 数据做敏感信息脱敏。

    dict → json.dumps → 脱敏 → json.loads；str → 直接脱敏；其他类型原样返回。
    """
    if data is None:
        return None
    if isinstance(data, str):
        return mask_sensitive_text(data)
    if isinstance(data, dict):
        text = json.dumps(data, default=str)
        masked = mask_sensitive_text(text)
        try:
            return json.loads(masked)
        except (json.JSONDecodeError, ValueError):
            return masked
    return data


def ensure_json_serializable(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, dict):
        return {str(k): ensure_json_serializable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [ensure_json_serializable(v) for v in value]
    try:
        json.dumps(value)
        return value
    except TypeError:
        return str(value)


def extract_trace_fields_from_initial_state(initial_state: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    if not initial_state:
        return {}
    return {
        "user_id": initial_state.get("user_id"),
        "organization_id": initial_state.get("organization_id"),
        "session_id": initial_state.get("session_id"),
        "instance_id": initial_state.get("instance_id"),
    }


def sanitize_serializable(data: Any) -> Any:
    """ensure_json_serializable + sanitize_for_trace，用于写入 TraceEvent。"""
    return sanitize_for_trace(ensure_json_serializable(data))


# ── WS 载荷（phase 事件）──────────────────────────────────────────────────


def build_trace_end_ws_payload(
    trace_id: uuid.UUID,
    status: str,
    error: Optional[str],
    ended_at: datetime,
) -> Dict[str, Any]:
    return {
        "phase": "trace_end",
        "trace_id": str(trace_id),
        "status": status,
        "error": error,
        "ended_at": ended_at.isoformat(),
    }


def build_event_start_ws_payload(
    *,
    event_uuid: uuid.UUID,
    trace_id: uuid.UUID,
    event_type: str,
    name: str,
    seq: int,
    started_at: datetime,
    parent_event_uuid: Optional[str],
    input_data: Any,
) -> Dict[str, Any]:
    return {
        "phase": "start",
        "event_id": str(event_uuid),
        "trace_id": str(trace_id),
        "event_type": event_type,
        "name": name,
        "seq": seq,
        "started_at": started_at.isoformat(),
        "parent_event_id": parent_event_uuid,
        "input": input_data,
    }


def build_event_end_ws_payload(
    *,
    event_uuid: uuid.UUID,
    trace_id: uuid.UUID,
    event_type: str,
    name: str,
    seq: int,
    started_at: datetime,
    ended_at: datetime,
    duration_ms: Optional[int],
    parent_event_uuid: Optional[str],
    input_data: Any,
    output_data: Any,
    error: Optional[str],
    usage: Any,
) -> Dict[str, Any]:
    return {
        "phase": "end",
        "event_id": str(event_uuid),
        "trace_id": str(trace_id),
        "event_type": event_type,
        "name": name,
        "seq": seq,
        "started_at": started_at.isoformat(),
        "ended_at": ended_at.isoformat(),
        "duration_ms": duration_ms,
        "parent_event_id": parent_event_uuid,
        "input": input_data,
        "output": output_data,
        "error": error,
        "usage": usage,
    }


def build_record_event_ws_payload(
    *,
    event_uuid: uuid.UUID,
    trace_id: uuid.UUID,
    event_type: str,
    name: str,
    seq: int,
    started_at: datetime,
    ended_at: datetime,
    duration_ms: Optional[int],
    parent_event_uuid: Optional[str],
    input_data: Any,
    output_data: Any,
    error: Optional[str],
    usage: Any,
) -> Dict[str, Any]:
    return build_event_end_ws_payload(
        event_uuid=event_uuid,
        trace_id=trace_id,
        event_type=event_type,
        name=name,
        seq=seq,
        started_at=started_at,
        ended_at=ended_at,
        duration_ms=duration_ms,
        parent_event_uuid=parent_event_uuid,
        input_data=input_data,
        output_data=output_data,
        error=error,
        usage=usage,
    )


def build_external_record_ws_payload(
    *,
    event_uuid: uuid.UUID,
    trace_id: uuid.UUID,
    event_type: str,
    name: str,
    seq: int,
    started_at: datetime,
    ended_at: datetime,
    input_data: Any,
    output_data: Any,
    error: Optional[str],
) -> Dict[str, Any]:
    return {
        "phase": "end",
        "event_id": str(event_uuid),
        "trace_id": str(trace_id),
        "event_type": event_type,
        "name": name,
        "seq": seq,
        "started_at": started_at.isoformat(),
        "ended_at": ended_at.isoformat(),
        "duration_ms": None,
        "parent_event_id": None,
        "input": input_data,
        "output": output_data,
        "error": error,
    }


# ── pending_trace_publish 表（DDL 与 SQL 片段，供 trace 模块执行）────────

PENDING_TABLE = "pending_trace_publish"
PENDING_MAX_ATTEMPTS = 10
PENDING_BATCH_SIZE = 200
PENDING_MAX_AGE_SECONDS = 600


def pending_trace_publish_ddl_statements(table: str = PENDING_TABLE) -> tuple[str, ...]:
    """幂等建表 / 索引 SQL（按顺序执行）。"""
    return (
        f"CREATE TABLE IF NOT EXISTS {table} ("
        f"  id BIGSERIAL PRIMARY KEY,"
        f"  trace_id UUID NOT NULL,"
        f"  event_uuid TEXT,"
        f"  channel TEXT NOT NULL,"
        f"  payload JSONB NOT NULL,"
        f"  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),"
        f"  attempts INT NOT NULL DEFAULT 0"
        f")",
        f"CREATE INDEX IF NOT EXISTS idx_{table}_sweep ON {table} (attempts, created_at)",
        f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS event_uuid TEXT",
        f"CREATE UNIQUE INDEX IF NOT EXISTS idx_{table}_event_uuid ON {table} (event_uuid)",
    )


def pending_enqueue_sql_with_uuid_conflict(table: str = PENDING_TABLE) -> str:
    return (
        f"INSERT INTO {table} (trace_id, event_uuid, channel, payload) "
        f"VALUES (%s, %s, %s, %s) ON CONFLICT (event_uuid) DO NOTHING"
    )


def pending_enqueue_sql_plain(table: str = PENDING_TABLE) -> str:
    return f"INSERT INTO {table} (trace_id, channel, payload) VALUES (%s, %s, %s)"


def pending_delete_by_event_uuid_sql(table: str = PENDING_TABLE) -> str:
    return f"DELETE FROM {table} WHERE event_uuid = %s"


def pending_delete_expired_sql(table: str = PENDING_TABLE) -> str:
    return f"DELETE FROM {table} WHERE created_at < %s"


def pending_select_for_flush_sql(table: str = PENDING_TABLE) -> str:
    return (
        f"SELECT id, trace_id, channel, payload, attempts, event_uuid FROM {table} "
        f"WHERE attempts < %s ORDER BY created_at ASC LIMIT %s FOR UPDATE SKIP LOCKED"
    )


def pending_delete_success_ids_sql(table: str = PENDING_TABLE) -> str:
    return f"DELETE FROM {table} WHERE id = ANY(%s)"


def pending_update_attempts_sql(table: str = PENDING_TABLE) -> str:
    return f"UPDATE {table} SET attempts = %s WHERE id = %s"


def normalize_pending_row_payload(payload_data: Any) -> Any:
    """flush 任务中 JSONB 可能以 str 形式返回。"""
    if isinstance(payload_data, str):
        return json.loads(payload_data)
    return payload_data


def stable_ws_event_id(event_uuid: Optional[str], new_event_id: str) -> str:
    """与 _publish_event / flush 中 stable_id 规则一致。"""
    return f"evt_{event_uuid}" if event_uuid else new_event_id
