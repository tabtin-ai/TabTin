"""
XML fence 转义工具，防止用户/RAG 内容中的 XML 闭合标签破坏 system prompt 结构。

白名单模式：仅转义与系统 XML fence 完全匹配的标签，避免误伤 JSX 等代码内容。
"""

_SYSTEM_XML_FENCES = (
    "context",
    "conversation_summary",
    "composer_preset",
    "deferred_tools",
    "identity",
    "safety",
    "execution",
    "custom_rules",
    "app_strategy",
    "planning",
    "cli_capabilities",
    "ask_user_tools_usage",
    "user_query",
    "note",
)


def sanitize_xml_fences(text: str) -> str:
    """转义文本中可能破坏系统 XML fence 结构的标签。

    仅转义闭合标签 (</tag>) 和开放标签 (<tag>/<tag ...>)，
    针对系统使用的白名单标签列表。
    """
    if not text or not isinstance(text, str):
        return text or ""
    for tag in _SYSTEM_XML_FENCES:
        text = text.replace(f"</{tag}>", f"[/{tag}]")
        text = text.replace(f"<{tag}>", f"[{tag}]")
        text = text.replace(f"<{tag} ", f"[{tag} ")
    return text
