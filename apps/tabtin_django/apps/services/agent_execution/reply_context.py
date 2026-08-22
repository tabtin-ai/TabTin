"""Helpers for carrying chat reply context through Django remote paths."""

from __future__ import annotations

from typing import Any, Dict, Optional


def extract_reply_context_from_app_context(app_context: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    if not isinstance(app_context, dict):
        return {}
    message_id = app_context.get("reply_to_message_id")
    preview = app_context.get("reply_to_preview")
    display_message = app_context.get("display_message")
    return {
        "reply_to_message_id": message_id if isinstance(message_id, str) and message_id else None,
        "reply_to_preview": preview if isinstance(preview, dict) else None,
        "display_message": display_message if isinstance(display_message, str) else None,
    }


def extract_persist_reply_kwargs_from_app_context(
    app_context: Optional[Dict[str, Any]],
) -> Dict[str, Any]:
    """Reply kwargs safe for ``persist_user_messages`` (no display-only fields)."""
    kwargs = extract_reply_context_from_app_context(app_context)
    kwargs.pop("display_message", None)
    return kwargs


def append_quoted_message_context(
    message: str,
    *,
    client_message_id: Optional[str],
    reply_to_message_id: Optional[str],
    reply_to_preview: Optional[Dict[str, Any]],
) -> str:
    if not client_message_id or not reply_to_message_id or not isinstance(reply_to_preview, dict):
        return message
    text = str(reply_to_preview.get("text") or "")
    if not text.strip():
        return message
    role = str(reply_to_preview.get("role") or "user")
    author = str(reply_to_preview.get("author") or "").strip()
    quoted_author = f"{author}（{role}）" if author else role
    body = f"用户引用回复了以下消息：\n{quoted_author}: {text}"
    from apps.services.agent_execution.user_context_wrapper import build_user_context_wrapper
    wrapper = build_user_context_wrapper(
        "quoted-message",
        body,
        {"stale_after_turn": client_message_id},
    )
    return f"{message.strip()}\n\n{wrapper}" if message.strip() else wrapper
