"""记忆系统共享工具函数。"""

from __future__ import annotations

import re
from typing import Any, Dict, List

_ERROR_HINT_RE = re.compile(
    r"(Error|Traceback|Exception|FAILED|Fatal|报错|异常|失败)",
    re.IGNORECASE,
)

_TOOL_CONTENT_MAX = 500
_TOOL_CONTENT_PREFIX = "[工具输出] "


def plaintext_for_memory_capture(content: Any) -> str:
    """从消息 content 抽出记忆蒸馏用纯文本。

    - ``str``：原样（去首尾空白）
    - ContentBlock 列表：只拼 ``type=text``（排除附件 / thinking / tool_use /
      tool_result 等非正文块），复用 ``derive_full_text_content``
    - 其它形态：空串
    """
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        from apps.services.common.ws.handlers.content_block_reassembler import (
            derive_full_text_content,
        )
        return derive_full_text_content(content).strip()
    return ""


def serialize_messages(messages: List[Dict[str, Any]], max_content_len: int = 5000) -> List[Dict[str, str]]:
    """将消息列表序列化为可 JSON 的格式（保留 role/content）。

    - user / assistant / system：content 为 ContentBlock[] 时只拼 text 块
      （排除附件、thinking、工具块）
    - 独立 ``role=tool`` 保留并截断（含错误关键词不截断），供 L4
      task_summary 踩坑——L2/L3 capture 在 ``_fetch_messages_from_db``
      只取 user/assistant，不会带上 tool 行
    """
    result: List[Dict[str, str]] = []
    for msg in messages:
        if not isinstance(msg, dict):
            continue
        role = msg.get("role", "")
        raw = msg.get("content", "")

        if role == "tool":
            content = (
                plaintext_for_memory_capture(raw)
                if isinstance(raw, list)
                else (raw if isinstance(raw, str) else "")
            )
            if not content:
                continue
            if not _ERROR_HINT_RE.search(content):
                if len(content) > _TOOL_CONTENT_MAX:
                    content = content[:_TOOL_CONTENT_MAX] + "...(truncated)"
            content = _TOOL_CONTENT_PREFIX + content
            result.append({"role": role, "content": content})
            continue

        if role not in ("user", "assistant", "system"):
            continue

        content = plaintext_for_memory_capture(raw)
        if not content:
            continue
        if len(content) > max_content_len:
            content = content[:max_content_len] + "...(truncated)"
        result.append({"role": role, "content": content})
    return result


def safe_llm_content(response: Any) -> str:
    """安全提取 LLM 响应文本内容，避免空 choices 导致 IndexError。"""
    choices = getattr(response, "choices", None)
    if not choices:
        return ""
    message = getattr(choices[0], "message", None)
    if not message:
        return ""
    return getattr(message, "content", "") or ""


def strip_code_fence(content: str) -> str:
    """去除 LLM 返回的 markdown code fence 包裹。"""
    content = content.strip()
    if content.startswith("```"):
        lines = content.split("\n")
        if len(lines) > 2:
            content = "\n".join(lines[1:-1])
    return content


def extract_user_query(messages: list, max_len: int = 500) -> str:
    """提取最新的用户消息作为搜索 query。"""
    for msg in reversed(messages):
        if isinstance(msg, dict) and msg.get("role") == "user":
            content = msg.get("content", "")
            if isinstance(content, str) and content.strip():
                return content.strip()[:max_len]
    return ""
