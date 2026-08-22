"""#9614 未答轮次撤回：服务端权威物理删除 + 审计快照。

语义：「这轮从未问过」。仅在目标 user 之后尚无实质 assistant 输出时允许删除；
与 Electron/iOS/Android 的 substance 判定对齐（thinking / 空文本不算）。
"""

from __future__ import annotations

import logging
import uuid
from typing import Any

from django.db import transaction
from django.db.models import Q

from ..models import ChatMessage, ChatMessageWithdrawEvent, ChatSession
from .conversation_time import q_conversation_after

logger = logging.getLogger(__name__)

REASON_HAS_SUBSTANTIVE_OUTPUT = "has_substantive_output"
REASON_INVALID_CLIENT_MESSAGE_ID = "invalid_client_message_id"

_TEXT_SUMMARY_PLACEHOLDERS = frozenset({
    "[工具调用]",
    "[富内容]",
    "[思考中]",
})

_SUBSTANTIVE_BLOCK_TYPES = frozenset({
    "tool_use",
    "tool_call",
    "tool_result",
    "server_tool_use",
    "mcp_tool_use",
    "mcp_tool_result",
    "rich_content",
    "tabtin_rich_content",
    "image",
    "file",
    "attachment",
    "context_ref",
})


def _actor_user_id(actor: Any) -> str:
    if actor is None:
        return ""
    actor_id = getattr(actor, "id", None)
    if actor_id is not None:
        return str(actor_id)
    return str(actor)


def _is_substantive_assistant_block(block: Any) -> bool:
    """对齐 Android ``BlockItem.isSubstantiveAssistantBlock`` / iOS projector。"""
    if not isinstance(block, dict):
        return False
    block_type = block.get("type")
    if not block_type or not isinstance(block_type, str):
        return False
    if block_type == "thinking":
        return False
    if block_type == "text":
        body = (block.get("text") or block.get("content") or "")
        return bool(str(body).strip())
    if block_type in _SUBSTANTIVE_BLOCK_TYPES:
        return True
    if block.get("isRichContent") is True or block.get("is_rich_content") is True:
        return True
    return block_type.endswith("_tool_result")


def assistant_message_has_substantive_output(message: ChatMessage) -> bool:
    """单条 assistant 是否已有实质输出（thinking / 占位摘要不算）。"""
    if getattr(message, "role", None) != "assistant":
        return False
    blocks = message.content_blocks_json if isinstance(message.content_blocks_json, list) else []
    if any(_is_substantive_assistant_block(block) for block in blocks):
        return True
    summary = (message.text_summary or "").strip()
    if summary and summary not in _TEXT_SUMMARY_PLACEHOLDERS:
        return True
    return False


def session_has_substantive_assistant_output_after(session: ChatSession, target: ChatMessage) -> bool:
    """目标 user 之后是否已存在实质 assistant 输出。"""
    after_qs = session.messages.filter(
        q_conversation_after(target, include_target=False),
        role="assistant",
    ).only("id", "role", "text_summary", "content_blocks_json")
    return any(assistant_message_has_substantive_output(msg) for msg in after_qs)


def _serialize_message_snapshot(message: ChatMessage) -> dict[str, Any]:
    created_at = getattr(message, "created_at", None)
    return {
        "id": str(message.id),
        "role": message.role,
        "text_summary": message.text_summary or "",
        "content_blocks_json": (
            message.content_blocks_json
            if isinstance(message.content_blocks_json, list)
            else []
        ),
        "created_at": created_at.isoformat() if created_at is not None else None,
    }


def _result(
    *,
    withdraw_applied: bool,
    deleted_count: int = 0,
    reason: str | None = None,
    restored_title: str | None = None,
) -> dict[str, Any]:
    return {
        "withdraw_applied": withdraw_applied,
        "deleted_count": deleted_count,
        "reason": reason,
        "restored_title": restored_title,
    }


def withdraw_unanswered_messages(
    *,
    session: ChatSession,
    client_message_id: str,
    actor: Any,
    source: str,
) -> dict[str, Any]:
    """服务端权威删除未答轮次。

    Returns:
        dict: ``withdraw_applied`` / ``deleted_count`` / ``reason`` / ``restored_title``
    """
    raw_id = (client_message_id or "").strip()
    try:
        client_uuid = uuid.UUID(raw_id)
    except (ValueError, TypeError):
        return _result(
            withdraw_applied=False,
            reason=REASON_INVALID_CLIENT_MESSAGE_ID,
        )

    with transaction.atomic():
        locked = ChatSession.objects.select_for_update().filter(id=session.id).first()
        if not locked:
            # 会话在锁前被删：视为目标已不存在，幂等成功。
            return _result(withdraw_applied=True, deleted_count=0)

        target = locked.messages.filter(
            Q(id=client_uuid) | Q(client_event_id=client_uuid),
            role="user",
        ).first()

        if not target:
            # 幂等：此前已删视为成功；仍清 soft revert / 空会话标题（对齐旧 API）。
            restored_title = _clear_soft_revert_and_maybe_reset_title(locked)
            return _result(
                withdraw_applied=True,
                deleted_count=0,
                restored_title=restored_title,
            )

        if session_has_substantive_assistant_output_after(locked, target):
            return _result(
                withdraw_applied=False,
                reason=REASON_HAS_SUBSTANTIVE_OUTPUT,
            )

        to_delete = locked.messages.filter(q_conversation_after(target, include_target=True))
        snapshots = [
            _serialize_message_snapshot(msg)
            for msg in to_delete.only(
                "id", "role", "text_summary", "content_blocks_json", "created_at",
            )
        ]
        deleted_count, _deletion_details = to_delete.delete()

        ChatMessageWithdrawEvent.objects.create(
            session=locked,
            organization_id=str(locked.organization_id or ""),
            actor_user_id=_actor_user_id(actor),
            source=source or "",
            client_message_id=str(client_uuid),
            payload_json=snapshots,
            deleted_count=deleted_count,
        )

        restored_title = _clear_soft_revert_and_maybe_reset_title(locked)

        logger.info(
            "[withdraw-unanswered] session=%s client=%s deleted=%s source=%s title_reset=%s",
            locked.id, client_uuid, deleted_count, source, bool(restored_title),
        )
        return _result(
            withdraw_applied=True,
            deleted_count=deleted_count,
            restored_title=restored_title,
        )


def _clear_soft_revert_and_maybe_reset_title(session: ChatSession) -> str | None:
    """清 soft revert 态；若已无 user 消息则取消标题生成并复位默认标题。"""
    if session.revert_message_id or session.revert_at:
        session.revert_message_id = None
        session.revert_snapshot_hash = None
        session.revert_state_index = None
        session.revert_at = None
        session.revert_resource_state = None
        session.save(update_fields=[
            "revert_message_id",
            "revert_snapshot_hash",
            "revert_state_index",
            "revert_at",
            "revert_resource_state",
            "updated_at",
        ])

    from .title_generator import TitleGeneratorService
    return TitleGeneratorService.cancel_title_generation_for_empty_session(
        session,
        publish=True,
    )
