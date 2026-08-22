"""Relay 出站 delta 合并。

合并发生在 deferred publish 列表内、Redis Stream ID 分配前。服务端消息重组仍消费
原始事件，因此这里只减少 WebSocket live/replay 的事件数量，不改变最终落库内容。
"""

from __future__ import annotations

from copy import deepcopy
from typing import Any

DELTA_SHORT_NAME = "content_block_delta"
RELAY_DELTA_COALESCE_MAX_CHARS = 48 * 1024

_STRING_FIELD_BY_DELTA_TYPE = {
    "text_delta": "text",
    "thinking_delta": "thinking",
    "input_json_delta": "partial_json",
    "signature_delta": "signature",
    "connector_text_delta": "connector_text",
}


def _coalesce_key(short_name: str, payload: dict[str, Any]) -> tuple[str, int, str] | None:
    if short_name != DELTA_SHORT_NAME:
        return None
    message_id = payload.get("message_id")
    index = payload.get("index")
    delta = payload.get("delta")
    if not isinstance(message_id, str) or not message_id:
        return None
    if not isinstance(index, int) or isinstance(index, bool) or index < 0:
        return None
    if not isinstance(delta, dict):
        return None
    delta_type = delta.get("type")
    if delta_type not in _STRING_FIELD_BY_DELTA_TYPE:
        return None
    return message_id, index, str(delta_type)


def _try_merge(
    target: tuple[str, dict[str, Any]],
    incoming: tuple[str, dict[str, Any]],
    *,
    max_chars: int,
) -> bool:
    target_name, target_payload = target
    incoming_name, incoming_payload = incoming
    target_key = _coalesce_key(target_name, target_payload)
    incoming_key = _coalesce_key(incoming_name, incoming_payload)
    if target_key is None or target_key != incoming_key:
        return False

    field = _STRING_FIELD_BY_DELTA_TYPE[target_key[2]]
    target_delta = target_payload["delta"]
    incoming_delta = incoming_payload["delta"]
    previous = target_delta.get(field, "")
    following = incoming_delta.get(field, "")
    if not isinstance(previous, str) or not isinstance(following, str):
        return False
    if len(previous) + len(following) > max_chars:
        return False

    previous_count = target_payload.get("coalesced_count", 1)
    if (
        not isinstance(previous_count, int)
        or isinstance(previous_count, bool)
        or previous_count <= 0
    ):
        previous_count = 1
    incoming_count = incoming_payload.get("coalesced_count", 1)
    if (
        not isinstance(incoming_count, int)
        or isinstance(incoming_count, bool)
        or incoming_count <= 0
    ):
        incoming_count = 1
    target_payload.clear()
    target_payload.update(deepcopy(incoming_payload))
    target_payload["delta"][field] = previous + following
    target_payload["coalesced_count"] = previous_count + incoming_count
    return True


def coalesce_deferred_publishes(
    items: list[tuple[str, dict[str, Any]]],
    *,
    max_chars: int = RELAY_DELTA_COALESCE_MAX_CHARS,
) -> list[tuple[str, dict[str, Any]]]:
    """保序合并相邻同 message/block/type 的可追加 delta。"""
    output: list[tuple[str, dict[str, Any]]] = []
    for short_name, payload in items:
        incoming = (short_name, deepcopy(payload))
        if output and _try_merge(output[-1], incoming, max_chars=max_chars):
            continue
        output.append(incoming)
    return output


__all__ = ["RELAY_DELTA_COALESCE_MAX_CHARS", "coalesce_deferred_publishes"]
