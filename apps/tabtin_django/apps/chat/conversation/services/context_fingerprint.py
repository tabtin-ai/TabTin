"""Client-aligned context sync fingerprint for quick-start responses."""

from __future__ import annotations

import json
from typing import Any, Mapping


def stable_serialize(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, list):
        return "[" + ",".join(stable_serialize(item) for item in value) + "]"
    if isinstance(value, Mapping):
        keys = sorted(value.keys())
        parts = [
            f"{json.dumps(str(key), ensure_ascii=False)}:{stable_serialize(value[key])}"
            for key in keys
        ]
        return "{" + ",".join(parts) + "}"
    return json.dumps(str(value), ensure_ascii=False)


def build_context_sync_fingerprint(session_id: str, payload: Mapping[str, Any]) -> str:
    return f"{session_id}:{stable_serialize(payload)}"
