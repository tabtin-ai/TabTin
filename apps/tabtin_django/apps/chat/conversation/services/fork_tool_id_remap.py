"""Fork 时把历史 tool_use / tool_result id 重写为 TabTin 权威 id。

契约与前端 ``ToolIdMapper`` / ``remapToolIdsInValue`` 对齐：
- 持久层只认 ``tu_<uuid>``
- 单次 fork 作业内，同一旧 id 字符串稳定映射到同一新 id（保配对）
- 已是 ``tu_`` 前缀的 id 保持不变
"""

from __future__ import annotations

import copy
import uuid
from typing import Any

TABTIN_TOOL_ID_PREFIX = "tu_"

# Anthropic content block + OpenAI tool_calls[].type=function（ConversationState）。
# 须与 TS `FORK_TOOL_USE_TYPES` / `FORK_TOOL_REF_KEYS` 同集（ 双端契约）。
TOOL_USE_TYPES = frozenset({
    "tool_use",
    "tool_call",
    "function_call",
    "function",
    "server_tool_use",
    "mcp_tool_use",
})
TOOL_REF_KEYS = frozenset({"tool_use_id", "tool_call_id", "toolCallId"})
# 兼容旧私有名
_TOOL_USE_TYPES = TOOL_USE_TYPES
_TOOL_REF_KEYS = TOOL_REF_KEYS


def is_tabtin_tool_use_id(value: str) -> bool:
    return isinstance(value, str) and value.startswith(TABTIN_TOOL_ID_PREFIX)


def allocate_tabtin_tool_use_id() -> str:
    return f"{TABTIN_TOOL_ID_PREFIX}{uuid.uuid4()}"


def _is_openai_tool_call_item(value: dict) -> bool:
    """ConversationState OpenAI 形态：{id, type:'function', function:{name,...}}。"""
    raw_id = value.get("id")
    if not isinstance(raw_id, str) or not raw_id:
        return False
    block_type = value.get("type") if isinstance(value.get("type"), str) else None
    if block_type in _TOOL_USE_TYPES:
        return True
    fn = value.get("function")
    # 缺 type 的存量：必须带可识别的 function.name，避免误改任意 {id, function} 对象
    if not isinstance(fn, dict):
        return False
    name = fn.get("name")
    return isinstance(name, str) and bool(name)


class ForkToolIdMapper:
    """单次 fork 作业内的旧 id → ``tu_*`` 映射表。"""

    def __init__(self) -> None:
        self._model_to_tabtin: dict[str, str] = {}

    def allocate(self, model_id: str | None) -> str:
        key = model_id.strip() if isinstance(model_id, str) else ""
        if not key:
            return allocate_tabtin_tool_use_id()
        if is_tabtin_tool_use_id(key):
            self._model_to_tabtin[key] = key
            return key
        existing = self._model_to_tabtin.get(key)
        if existing:
            return existing
        tabtin_id = allocate_tabtin_tool_use_id()
        self._model_to_tabtin[key] = tabtin_id
        return tabtin_id

    @property
    def size(self) -> int:
        return len(self._model_to_tabtin)

    def snapshot(self) -> dict[str, str]:
        """导出旧 id → tu_*，供本机 fork 共用同一张表。"""
        return dict(self._model_to_tabtin)

    def seed(self, mapping: dict[str, str] | None) -> None:
        """用已有映射预填（空值忽略）。"""
        if not mapping:
            return
        for old_id, new_id in mapping.items():
            if isinstance(old_id, str) and old_id and isinstance(new_id, str) and new_id:
                self._model_to_tabtin[old_id] = new_id


def remap_tool_ids_in_value(value: Any, mapper: ForkToolIdMapper) -> Any:
    """深度遍历 JSON，重写 tool_use.id / tool_result.tool_use_id 等字段。"""
    if value is None:
        return value
    if isinstance(value, list):
        return [remap_tool_ids_in_value(item, mapper) for item in value]
    if not isinstance(value, dict):
        return value

    out: dict[str, Any] = {}
    block_type = value.get("type") if isinstance(value.get("type"), str) else None
    remap_id = _is_openai_tool_call_item(value) or block_type in _TOOL_USE_TYPES

    for key, raw in value.items():
        if key == "id" and remap_id and isinstance(raw, str):
            out[key] = mapper.allocate(raw)
            continue
        if key in _TOOL_REF_KEYS and isinstance(raw, str) and raw:
            out[key] = mapper.allocate(raw)
            continue
        out[key] = remap_tool_ids_in_value(raw, mapper)
    return out


def remap_content_blocks_json(
    blocks: Any,
    mapper: ForkToolIdMapper,
) -> Any:
    """复制并 remap ``ChatMessage.content_blocks_json``。"""
    if blocks is None:
        return None
    return remap_tool_ids_in_value(copy.deepcopy(blocks), mapper)


def remap_messages_json(
    messages: list | None,
    mapper: ForkToolIdMapper,
    message_id_remap: dict[str, str] | None = None,
) -> list:
    """复制并 remap ``ConversationState.messages_json``。"""
    if not messages:
        return []
    from .fork_message_id_remap import remap_message_ids_in_value

    with_message_ids = remap_message_ids_in_value(messages, message_id_remap)
    return remap_tool_ids_in_value(with_message_ids, mapper)
