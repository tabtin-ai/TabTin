from __future__ import annotations

import hashlib
import json
import re
import socket
import time
import uuid
from collections import Counter, defaultdict
from typing import Any

from django.conf import settings
from django.utils import timezone

STREAM_KEY = "ops:centrifugo:publish_events"
STREAM_MAXLEN = 100_000

SAFE_ERROR_RE = re.compile(r"\s+")


def sample_enabled() -> bool:
    return bool(getattr(settings, "CENTRIFUGO_PUBLISH_EVENT_SAMPLE_ENABLED", False))


def _redis():
    from django_redis import get_redis_connection

    return get_redis_connection("default")


def _now_iso() -> str:
    return timezone.now().isoformat()


def infer_channel_type(channel: str) -> str:
    if channel.startswith("chat:"):
        return "chat"
    if channel.startswith("personal:"):
        return "personal"
    if channel.startswith("space:"):
        return "space"
    if channel.startswith("presence:"):
        return "presence"
    return "unknown"


def _channel_suffix(channel: str) -> str:
    return channel.split(":", 1)[1] if ":" in channel else ""


def error_signature(error: str) -> str:
    text = SAFE_ERROR_RE.sub(" ", str(error or "")).strip()
    if not text:
        return ""
    digest = hashlib.sha1(text.encode("utf-8")).hexdigest()[:10]
    return f"{text[:120]}#{digest}"


def build_publish_context(channel: str, data: dict[str, Any] | None = None) -> dict[str, Any]:
    safe_data = data if isinstance(data, dict) else {}
    nested = safe_data.get("data") if isinstance(safe_data.get("data"), dict) else {}
    channel_type = infer_channel_type(channel)
    suffix = _channel_suffix(channel)
    return {
        "event_id": uuid.uuid4().hex,
        "channel": channel,
        "channel_type": channel_type,
        "user_id": str(nested.get("user_id") or safe_data.get("user_id") or (suffix if channel_type == "personal" else "")),
        "room_id": str(nested.get("conversation_id") or safe_data.get("conversation_id") or (suffix if channel_type == "chat" else "")),
        "workteam_id": str(nested.get("workteam_id") or nested.get("organization_id") or safe_data.get("workteam_id") or safe_data.get("organization_id") or ""),
        "instance_id": str(getattr(settings, "CENTRIFUGO_PUBLISH_INSTANCE_ID", "") or socket.gethostname()),
    }


def _stream_fields(context: dict[str, Any], **flags: Any) -> dict[str, str]:
    fields = {
        "event_id": str(context.get("event_id") or uuid.uuid4().hex),
        "channel": str(context.get("channel") or ""),
        "channel_type": str(context.get("channel_type") or infer_channel_type(str(context.get("channel") or ""))),
        "user_id": str(context.get("user_id") or ""),
        "room_id": str(context.get("room_id") or ""),
        "workteam_id": str(context.get("workteam_id") or ""),
        "publish_attempted": "false",
        "publish_accepted": "false",
        "publish_failed": "false",
        "latency_ms": "",
        "error_type": "",
        "error_signature": "",
        "backpressure": "false",
        "circuit_open": "false",
        "created_at": _now_iso(),
        "instance_id": str(context.get("instance_id") or socket.gethostname()),
    }
    for key, value in flags.items():
        if isinstance(value, bool):
            fields[key] = "true" if value else "false"
        elif value is not None:
            fields[key] = str(value)
    return fields


def record_publish_event(context: dict[str, Any], **flags: Any) -> None:
    if not sample_enabled():
        return
    _redis().xadd(
        STREAM_KEY,
        _stream_fields(context, **flags),
        maxlen=STREAM_MAXLEN,
        approximate=True,
    )


def read_publish_events(*, limit: int = 100) -> list[dict[str, Any]]:
    if not sample_enabled():
        return []
    rows = _redis().xrevrange(STREAM_KEY, count=max(1, min(int(limit or 100), 500)))
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


def summarize_publish_events(events: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "publish_attempted": sum(1 for row in events if row.get("publish_attempted") == "true"),
        "publish_accepted": sum(1 for row in events if row.get("publish_accepted") == "true"),
        "publish_failed": sum(1 for row in events if row.get("publish_failed") == "true"),
        "backpressure": sum(1 for row in events if row.get("backpressure") == "true"),
        "circuit_open": sum(1 for row in events if row.get("circuit_open") == "true"),
    }


def summarize_channels(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[str, dict[str, Any]] = defaultdict(lambda: {
        "attempted": 0,
        "accepted": 0,
        "failed": 0,
        "latency_values": [],
        "error_signatures": Counter(),
        "created_at": "",
    })
    for row in events:
        channel = str(row.get("channel") or "")
        bucket = grouped[channel]
        bucket["channel"] = channel
        bucket["channel_type"] = row.get("channel_type") or infer_channel_type(channel)
        bucket["attempted"] += 1 if row.get("publish_attempted") == "true" else 0
        bucket["accepted"] += 1 if row.get("publish_accepted") == "true" else 0
        bucket["failed"] += 1 if row.get("publish_failed") == "true" else 0
        if row.get("latency_ms"):
            try:
                bucket["latency_values"].append(float(row["latency_ms"]))
            except (TypeError, ValueError):
                pass
        if row.get("error_signature"):
            bucket["error_signatures"][row["error_signature"]] += 1
        if row.get("created_at") and (not bucket["created_at"] or row["created_at"] > bucket["created_at"]):
            bucket["created_at"] = row["created_at"]
    result = []
    for bucket in grouped.values():
        values = bucket.pop("latency_values")
        signatures = bucket.pop("error_signatures")
        bucket["latency_ms"] = round(sum(values) / len(values), 2) if values else ""
        bucket["error_signature"] = signatures.most_common(1)[0][0] if signatures else ""
        result.append(bucket)
    return sorted(result, key=lambda row: row.get("created_at") or "", reverse=True)
