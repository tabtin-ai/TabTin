"""对话消息的持久化作者角色与 LLM 协议角色投影。

``ChatMessage.role`` 记录谁产生了消息；模型历史里的 role 只描述供应商协议。
系统生成的上下文、Skill 注入和后台通知因此以 ``system`` 持久化，但在进入
LLM 历史时仍投影为 ``user``，保持既有模型行为。
"""

from __future__ import annotations

from typing import Any, Mapping


SYSTEM_AUTHORED_MESSAGE_KINDS = frozenset({
    "environment_context",
    "agent_profile_context",
    "system_prompt_context",
    "compaction_summary",
    "hitl_interaction",
    "external_archive_context",
})

_SYSTEM_MESSAGE_SOURCES = frozenset({"skill_invoke", "tool_injected"})
_SYSTEM_MESSAGE_TRIGGERS = frozenset({"push-notification", "parent_midflight"})


def is_system_authored_message(
    *,
    message_kind: str | None,
    metadata: Mapping[str, Any] | None = None,
    source: str | None = None,
    triggered_by: str | None = None,
) -> bool:
    """返回消息是否由系统而非真人产生。

    同时接受协议顶层字段与已落库 metadata，供 relay 写入和历史恢复复用。
    """
    meta = metadata if isinstance(metadata, Mapping) else {}
    resolved_source = source or meta.get("source")
    resolved_trigger = triggered_by or meta.get("triggered_by")
    if message_kind in SYSTEM_AUTHORED_MESSAGE_KINDS:
        return True
    if resolved_source in _SYSTEM_MESSAGE_SOURCES:
        return True
    return resolved_trigger in _SYSTEM_MESSAGE_TRIGGERS


def persisted_role_for_user_event(payload: Mapping[str, Any]) -> str:
    """把 runtime USER 事件投影为真实持久化作者角色。"""
    return "system" if is_system_authored_message(
        message_kind=payload.get("message_kind"),
        metadata=payload.get("metadata"),
        source=payload.get("source"),
        triggered_by=payload.get("triggered_by"),
    ) else "user"


def llm_role_for_persisted_message(*, role: str, message_kind: str) -> str:
    """把可进入历史的持久化 system 行恢复为模型要求的 user 角色。"""
    if role == "system" and message_kind != "system_prompt_context":
        return "user"
    return role
