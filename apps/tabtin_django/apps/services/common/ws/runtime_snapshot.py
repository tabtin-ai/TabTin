from __future__ import annotations

import json
import re
import socket
import time
from typing import Any

from django.conf import settings
from django.utils import timezone

CONNECTION_TTL_SECONDS = 180
EVENT_STREAM_MAXLEN = 100_000

CONNECTION_KEY_PREFIX = "ops:ws:conn:"
GLOBAL_INDEX_KEY = "ops:ws:index:connections"
USER_INDEX_PREFIX = "ops:ws:index:user:"
DEVICE_INDEX_PREFIX = "ops:ws:index:device:"
EVENT_STREAM_KEY = "ops:ws:events"

EVENT_TYPES = {
    "connected",
    "disconnected",
    "heartbeat_timeout",
    "auth_failed",
    "reconnect",
    "send_failed",
}

EVENT_FIELD_ALLOWLIST = {
    "connection_id",
    "user_id",
    "device_id",
    "daemon_id",
    "instance_id",
    "client_type",
    "client_version",
    "subscriptions_count",
    "close_reason",
    "abnormal_reason",
    "ip",
}

SENSITIVE_EVENT_KEY_RE = re.compile(r"(token|secret|authorization|auth|payload|header)", re.IGNORECASE)


def snapshot_enabled() -> bool:
    return bool(getattr(settings, "WS_RUNTIME_SNAPSHOT_ENABLED", False))


def event_sample_enabled() -> bool:
    return snapshot_enabled() and bool(getattr(settings, "WS_EVENT_SAMPLE_ENABLED", False))


def _redis():
    from django_redis import get_redis_connection

    return get_redis_connection("default")


def _now_iso() -> str:
    return timezone.now().isoformat()


def mask_ip(ip: str | None) -> str:
    value = str(ip or "")
    if not value:
        return ""
    if ":" in value:
        parts = value.split(":")
        return ":".join(parts[:2] + ["****"])
    chunks = value.split(".")
    if len(chunks) == 4:
        return ".".join(chunks[:2] + ["*", "*"])
    return value[:3] + "***"


def _connection_key(connection_id: str) -> str:
    return f"{CONNECTION_KEY_PREFIX}{connection_id}"


def _user_index_key(user_id: str) -> str:
    return f"{USER_INDEX_PREFIX}{user_id}"


def _device_index_key(device_id: str) -> str:
    return f"{DEVICE_INDEX_PREFIX}{device_id}"


def connection_id_for_channel(channel_name: str) -> str:
    return str(channel_name or "").replace("!", ".")


def _safe_json(data: dict[str, Any]) -> str:
    return json.dumps(data, ensure_ascii=False, separators=(",", ":"))


def _load_json(raw: Any) -> dict[str, Any]:
    if raw is None:
        return {}
    if isinstance(raw, bytes):
        raw = raw.decode("utf-8", errors="replace")
    try:
        parsed = json.loads(str(raw))
        return parsed if isinstance(parsed, dict) else {}
    except Exception:
        return {}


def _base_snapshot(
    *,
    connection_id: str,
    user_id: str = "",
    device_id: str = "",
    daemon_id: str = "",
    instance_id: str = "",
    client_type: str = "",
    client_version: str = "",
    subscriptions_count: int = 0,
    status: str = "connected",
    close_reason: str = "",
    abnormal_reason: str = "",
) -> dict[str, Any]:
    now = _now_iso()
    return {
        "connection_id": connection_id,
        "user_id": user_id,
        "device_id": device_id,
        "daemon_id": daemon_id,
        "instance_id": instance_id or socket.gethostname(),
        "client_type": client_type,
        "client_version": client_version,
        "connected_at": now,
        "last_seen_at": now,
        "subscriptions_count": max(0, int(subscriptions_count or 0)),
        "status": status,
        "close_reason": close_reason,
        "abnormal_reason": abnormal_reason,
    }


def record_event(event_type: str, *, connection_id: str = "", **fields: Any) -> None:
    if not event_sample_enabled() or event_type not in EVENT_TYPES:
        return
    safe_fields = {
        key: str(value)
        for key, value in fields.items()
        if value is not None
        and key in EVENT_FIELD_ALLOWLIST
        and not SENSITIVE_EVENT_KEY_RE.search(key)
    }
    safe_fields["event_type"] = event_type
    safe_fields["connection_id"] = str(connection_id or "")
    safe_fields["created_at"] = _now_iso()
    if "ip" in safe_fields:
        safe_fields["ip_masked"] = mask_ip(safe_fields.pop("ip"))
    client = _redis()
    client.xadd(EVENT_STREAM_KEY, safe_fields, maxlen=EVENT_STREAM_MAXLEN, approximate=True)


def upsert_connection_snapshot(**kwargs: Any) -> None:
    if not snapshot_enabled():
        return
    connection_id = str(kwargs.get("connection_id") or "")
    if not connection_id:
        return
    key = _connection_key(connection_id)
    client = _redis()
    previous = _load_json(client.get(key))
    data = _base_snapshot(**kwargs)
    if previous.get("connected_at"):
        data["connected_at"] = previous["connected_at"]
    data["last_seen_at"] = _now_iso()
    now_score = time.time()
    pipe = client.pipeline()
    pipe.set(key, _safe_json(data), ex=CONNECTION_TTL_SECONDS)
    pipe.zadd(GLOBAL_INDEX_KEY, {connection_id: now_score})
    pipe.zremrangebyscore(GLOBAL_INDEX_KEY, "-inf", now_score - CONNECTION_TTL_SECONDS)
    pipe.expire(GLOBAL_INDEX_KEY, CONNECTION_TTL_SECONDS)
    if data.get("user_id"):
        user_key = _user_index_key(str(data["user_id"]))
        pipe.zadd(user_key, {connection_id: now_score})
        pipe.zremrangebyscore(user_key, "-inf", now_score - CONNECTION_TTL_SECONDS)
        pipe.expire(user_key, CONNECTION_TTL_SECONDS)
    if data.get("device_id"):
        device_key = _device_index_key(str(data["device_id"]))
        pipe.zadd(device_key, {connection_id: now_score})
        pipe.zremrangebyscore(device_key, "-inf", now_score - CONNECTION_TTL_SECONDS)
        pipe.expire(device_key, CONNECTION_TTL_SECONDS)
    pipe.execute()


def mark_connection_disconnected(
    *,
    connection_id: str,
    close_reason: str = "",
    abnormal_reason: str = "",
) -> None:
    if not snapshot_enabled() or not connection_id:
        return
    client = _redis()
    key = _connection_key(connection_id)
    data = _load_json(client.get(key))
    if not data:
        return
    data["status"] = "disconnected"
    data["last_seen_at"] = _now_iso()
    data["close_reason"] = close_reason
    data["abnormal_reason"] = abnormal_reason
    client.set(key, _safe_json(data), ex=CONNECTION_TTL_SECONDS)


def read_connection_snapshots(
    *,
    connection_id: str = "",
    user_id: str = "",
    device_id: str = "",
    limit: int = 100,
) -> list[dict[str, Any]]:
    if not snapshot_enabled():
        return []
    client = _redis()
    limit = max(1, min(int(limit or 100), 500))
    if connection_id:
        ids = [connection_id]
    elif user_id:
        user_key = _user_index_key(user_id)
        now_score = time.time()
        client.zremrangebyscore(user_key, "-inf", now_score - CONNECTION_TTL_SECONDS)
        ids = list(client.zrevrange(user_key, 0, limit - 1))
    elif device_id:
        device_key = _device_index_key(device_id)
        now_score = time.time()
        client.zremrangebyscore(device_key, "-inf", now_score - CONNECTION_TTL_SECONDS)
        ids = list(client.zrevrange(device_key, 0, limit - 1))
    else:
        now_score = time.time()
        client.zremrangebyscore(GLOBAL_INDEX_KEY, "-inf", now_score - CONNECTION_TTL_SECONDS)
        ids = list(client.zrevrange(GLOBAL_INDEX_KEY, 0, limit - 1))
    snapshots: list[dict[str, Any]] = []
    for raw_id in ids:
        cid = raw_id.decode("utf-8", errors="replace") if isinstance(raw_id, bytes) else str(raw_id)
        row = _load_json(client.get(_connection_key(cid)))
        if row:
            snapshots.append(row)
    return snapshots


def read_event_samples(*, limit: int = 100) -> list[dict[str, Any]]:
    if not event_sample_enabled():
        return []
    client = _redis()
    limit = max(1, min(int(limit or 100), 500))
    rows = client.xrevrange(EVENT_STREAM_KEY, count=limit)
    result: list[dict[str, Any]] = []
    for stream_id, values in rows:
        item = {
            key.decode("utf-8", errors="replace") if isinstance(key, bytes) else str(key):
            value.decode("utf-8", errors="replace") if isinstance(value, bytes) else str(value)
            for key, value in values.items()
        }
        item["stream_id"] = stream_id.decode("utf-8", errors="replace") if isinstance(stream_id, bytes) else str(stream_id)
        result.append(item)
    return result


def summarize_connections(rows: list[dict[str, Any]], events: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    events = events or []
    connected = [row for row in rows if row.get("status") == "connected"]
    abnormal = [row for row in rows if row.get("abnormal_reason")]
    return {
        "current_connections": len(connected),
        "user_count": len({row.get("user_id") for row in connected if row.get("user_id")}),
        "device_count": len({row.get("device_id") for row in connected if row.get("device_id")}),
        "abnormal_connections": len(abnormal),
        "auth_failed": sum(1 for event in events if event.get("event_type") == "auth_failed"),
        "heartbeat_timeout": sum(1 for event in events if event.get("event_type") == "heartbeat_timeout"),
    }
