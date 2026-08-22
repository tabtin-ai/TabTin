"""Shared utilities for ChatSession resolution."""

from __future__ import annotations

from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:
    from apps.chat.conversation.models import ChatSession

CHAT_SESSION_PREFIX = "chat-session-"


def resolve_chat_session(thread_id: str) -> Optional[ChatSession]:
    """Resolve ChatSession by thread_id, falling back to id lookup.

    Backfills thread_id on the session if it was found by id but had no thread_id set.

    v0.1 宪法 §5.1 后 current_model / default_model 是软引用 UUIDField，不再用
    prefetch_related。调用方如需访问 LLMModel 实例（``session.current_model.xxx``），
    应主动调
    :func:`apps.chat.conversation.services.llm_model_loader.attach_llm_models_to_sessions`
    预加载，否则 property 会单点 fallback fetch。
    """
    from apps.chat.conversation.models import ChatSession

    qs = ChatSession.objects
    session = qs.filter(thread_id=thread_id).first()
    if not session:
        session_id = thread_id.replace(CHAT_SESSION_PREFIX, "", 1)
        session = qs.filter(id=session_id).first()
        if session and not session.thread_id:
            session.thread_id = thread_id
            session.save(update_fields=["thread_id"])
    return session
