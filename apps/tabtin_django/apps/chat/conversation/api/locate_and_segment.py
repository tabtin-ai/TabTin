"""消息定位 & 对话片段查询 API

- locate-message: 查询消息是否存在及其时间戳，供前端做 keyset 分页加载
- conversation-segment: 按 around_message_id 前后取指定条数消息，供对话片段浮层预览
"""

from uuid import UUID

from django.db.models import Q

from ._common import (
    router,
    jwt_auth,
    logger,
    _get_session_with_shared_access,
    _visible_messages_queryset,
)
from apps.i18n import get_text as _
from ..models import ChatMessage


def _is_valid_uuid(val: str) -> bool:
    try:
        UUID(val)
        return True
    except (ValueError, AttributeError):
        return False


# ══════════════════════════════════════════════════════
# locate-message（PRD 4.3.5）
# ══════════════════════════════════════════════════════

@router.get(
    "/sessions/{session_id}/locate-message/{message_id}",
    auth=jwt_auth,
    response={200: dict, 400: dict, 404: dict},
    tags=["消息定位"],
)
def locate_message(request, session_id: str, message_id: str):
    """查询指定消息是否存在于会话中，返回 exists + created_at。

    前端用 created_at 做 keyset 分页窗口加载，避免 COUNT 全量消息的开销。
    """
    if not _is_valid_uuid(message_id):
        return 400, {"status": "error", "message": "Invalid message_id format"}

    session, _ = _get_session_with_shared_access(
        session_id, request.auth, include_session_share=True,
    )
    if not session:
        return 404, {"status": "error", "message": _("chat.session_not_found")}

    visible_msg = (
        _visible_messages_queryset(session)
        .filter(id=message_id)
        .values("id", "created_at")
        .first()
    )

    if not visible_msg:
        exists_in_session = ChatMessage.objects.filter(id=message_id, session_id=session.id).exists()
        return 200, {
            "status": "ok",
            "data": {
                "session_id": str(session.id),
                "message_id": message_id,
                "exists": False,
                "created_at": None,
                "is_reverted_out": bool(exists_in_session and session.revert_message_id),
                "revert_message_id": str(session.revert_message_id) if exists_in_session and session.revert_message_id else None,
            },
        }

    return 200, {
        "status": "ok",
        "data": {
            "session_id": str(session.id),
            "message_id": str(visible_msg["id"]),
            "exists": True,
            "created_at": visible_msg["created_at"].isoformat() if visible_msg["created_at"] else None,
            "is_reverted_out": False,
            "revert_message_id": str(session.revert_message_id) if session.revert_message_id else None,
        },
    }


# ══════════════════════════════════════════════════════
# conversation-segment（PRD 4.3.4）
# ══════════════════════════════════════════════════════

@router.get(
    "/sessions/{session_id}/conversation-segment",
    auth=jwt_auth,
    response={200: dict, 400: dict, 404: dict},
    tags=["对话片段"],
)
def get_conversation_segment(
    request,
    session_id: str,
    around_message_id: str = "",
    before: int = 3,
    after: int = 2,
):
    """获取指定消息前后的对话片段，用于浮层预览。

    按 around_message_id 定位目标消息，向前取 before 条、向后取 after 条。
    返回时间正序排列的消息列表 + has_more_before / has_more_after 标记。
    消息 content 截取前 2000 字符。
    """
    if not around_message_id:
        return 400, {"status": "error", "message": "around_message_id is required"}
    if not _is_valid_uuid(around_message_id):
        return 400, {"status": "error", "message": "Invalid around_message_id format"}

    session, _ = _get_session_with_shared_access(
        session_id, request.auth, include_session_share=True,
    )
    if not session:
        return 404, {"status": "error", "message": _("chat.session_not_found")}

    before = min(max(0, before), 20)
    after = min(max(0, after), 20)
    visible_messages = _visible_messages_queryset(session)

    # 一次查询获取 anchor 消息全部所需字段
    anchor_msg = (
        visible_messages
        .filter(id=around_message_id)
        .values("id", "role", "text_summary", "created_at")
        .first()
    )
    if not anchor_msg:
        exists_in_session = ChatMessage.objects.filter(id=around_message_id, session_id=session.id).exists()
        return 404, {
            "status": "error",
            "message": "Target message not found in this session",
            "data": {
                "is_reverted_out": bool(exists_in_session and session.revert_message_id),
                "revert_message_id": str(session.revert_message_id) if exists_in_session and session.revert_message_id else None,
            },
        }

    anchor_dt = anchor_msg["created_at"]
    anchor_id = anchor_msg["id"]

    _CONTENT_MAX_LEN = 2000

    # 向前取 before 条（不含 anchor，时间正序）
    before_msgs = []
    if before > 0:
        before_qs = (
            visible_messages
            .filter(
                Q(created_at__lt=anchor_dt)
                | Q(created_at=anchor_dt, id__lt=anchor_id)
            )
            .order_by("-created_at")
            .values("id", "role", "text_summary", "created_at")[: before + 1]
        )
        before_list = list(before_qs)
        has_more_before = len(before_list) > before
        before_msgs = before_list[:before]
        before_msgs.reverse()
    else:
        has_more_before = (
            visible_messages
            .filter(
                Q(created_at__lt=anchor_dt)
                | Q(created_at=anchor_dt, id__lt=anchor_id)
            )
            .exists()
        )

    # 向后取 after 条（不含 anchor，时间正序）
    after_msgs = []
    if after > 0:
        after_qs = (
            visible_messages
            .filter(
                Q(created_at__gt=anchor_dt)
                | Q(created_at=anchor_dt, id__gt=anchor_id)
            )
            .order_by("created_at")
            .values("id", "role", "text_summary", "created_at")[: after + 1]
        )
        after_list = list(after_qs)
        has_more_after = len(after_list) > after
        after_msgs = after_list[:after]
    else:
        has_more_after = (
            visible_messages
            .filter(
                Q(created_at__gt=anchor_dt)
                | Q(created_at=anchor_dt, id__gt=anchor_id)
            )
            .exists()
        )

    all_msgs = before_msgs + [anchor_msg] + after_msgs
    anchor_id_str = str(anchor_id)

    # W3 §3.3.1：上下文窗口预览取 text_summary（content 字段已 drop）
    messages = []
    for m in all_msgs:
        raw_content = m.get("text_summary") or m.get("content") or ""
        truncated = len(raw_content) > _CONTENT_MAX_LEN
        messages.append({
            "id": str(m["id"]),
            "role": m["role"],
            "content": raw_content[:_CONTENT_MAX_LEN],
            "created_at": m["created_at"].isoformat() if m["created_at"] else None,
            "is_anchor": str(m["id"]) == anchor_id_str,
            "content_truncated": truncated,
        })

    return 200, {
        "status": "ok",
        "data": {
            "messages": messages,
            "has_more_before": has_more_before,
            "has_more_after": has_more_after,
        },
    }
