"""Agent 内置头像稳定标识注册表。

``avatar_key`` 是跨端长期契约：已有 key 不得改义，新视觉只追加独立 key，
避免未主动选择的存量 Agent 被静默换脸。
"""

LEGACY_AGENT_AVATAR_KEYS = (
    "general-assistant",
    "code-engineer",
    "doc-writer",
    "data-analyst",
    "web-researcher",
    "slide-designer",
    "office-secretary",
)

FUNCTION_AGENT_AVATAR_KEYS = (
    "function-general-assistant",
    "function-code-engineer",
    "function-doc-writer",
    "function-data-analyst",
    "function-web-researcher",
    "function-slide-designer",
    "function-office-secretary",
)

BUILTIN_AGENT_AVATAR_KEYS = (
    *LEGACY_AGENT_AVATAR_KEYS,
    *FUNCTION_AGENT_AVATAR_KEYS,
)

_BUILTIN_AGENT_AVATAR_KEY_SET = frozenset(BUILTIN_AGENT_AVATAR_KEYS)


def is_builtin_agent_avatar_key(value: str) -> bool:
    """返回稳定标识是否属于随产品发布的头像预设。"""

    return value in _BUILTIN_AGENT_AVATAR_KEY_SET
