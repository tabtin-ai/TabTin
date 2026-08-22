"""Resolve Django IM conversations for TabChat features."""

from __future__ import annotations

from apps.tabchat.models import Conversation, ConversationMember
from apps.tabchat.services.conversation_access import ConversationAccessResolver


class IMConversationRouteUnavailable(RuntimeError):
    pass


def resolve_im_conversation(*, conversation_ref: str, user_id: str) -> dict:
    """Return the Django conversation detail visible to this user."""
    actor_id = str(user_id or "").strip()
    if not actor_id:
        raise PermissionError("缺少 IM 会话鉴权")

    conversation = Conversation.objects.filter(pk=conversation_ref).first()
    if conversation is None:
        raise ValueError("会话不存在")
    if not ConversationAccessResolver.resolve(conversation, actor_id).can_view:
        raise PermissionError("无权访问该会话")

    members: list[dict[str, str]] = []
    for member in ConversationMember.objects.filter(
        conversation=conversation,
        status=ConversationMember.Status.ACTIVE,
    ):
        if member.agent_id:
            members.append({
                "member_type": "agent",
                "agent_id": str(member.agent_id),
            })
            continue
        if member.user_id:
            members.append({
                "member_type": "user",
                "user_id": str(member.user_id),
            })

    return {
        "id": str(conversation.id),
        "conversation_id": str(conversation.id),
        "organization_id": str(conversation.organization_id),
        "type": int(conversation.type),
        "name": conversation.name or "",
        "space_id": str(conversation.space_id or ""),
        "members": members,
    }
