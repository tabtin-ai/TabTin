"""thread_id 统一生成与解析工具。"""

from __future__ import annotations

import uuid
from typing import Optional, Tuple

ALLOWED_THREAD_PREFIXES: Tuple[str, ...] = (
    "chat-session-",
    "tin-",
    "browser-",
    "gc-ext-",
)

# ``agent.action.result`` handler accepts this narrower subset. Producers that
# synchronously wait on that handler must validate against the exact same set.
ACTION_RESULT_THREAD_PREFIXES: Tuple[str, ...] = (
    "chat-session-",
    "tin-",
    "gc-ext-",
)


def resolve_thread_id(
    thread_id: Optional[str],
    session_id: Optional[str],
    default_prefix: Optional[str] = None,
) -> Optional[str]:
    """
    统一 thread_id 解析规则（API 与节点必须复用此函数）。

    优先级：
    1) 显式传入的 thread_id
    2) session_id → chat-session-{session_id}
    3) default_prefix → {prefix}-{uuid}
    """
    if thread_id:
        return thread_id
    if session_id:
        return f"chat-session-{session_id}"
    if default_prefix:
        return f"{default_prefix}-{uuid.uuid4().hex[:12]}"
    return None


def _format_prefix_hint(prefixes: Tuple[str, ...]) -> str:
    return "/".join(prefix.rstrip("-") for prefix in prefixes)


def validate_thread_id_prefix(
    thread_id: Optional[str],
    allowed_prefixes: Optional[Tuple[str, ...]] = None,
    field_name: str = "thread_id",
) -> Optional[str]:
    """
    校验 thread_id 前缀是否合法，返回错误信息（不抛异常）。
    """
    if not thread_id:
        return f"{field_name} cannot be empty"
    prefixes = allowed_prefixes or ALLOWED_THREAD_PREFIXES
    if not any(thread_id.startswith(prefix) for prefix in prefixes):
        return f"{field_name} must use one of these prefixes: {_format_prefix_hint(prefixes)}"
    return None


__all__ = [
    "ALLOWED_THREAD_PREFIXES",
    "ACTION_RESULT_THREAD_PREFIXES",
    "resolve_thread_id",
    "validate_thread_id_prefix",
]
