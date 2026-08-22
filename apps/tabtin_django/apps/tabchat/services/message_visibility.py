"""TabChat 消息可见性规则的统一查询入口。"""

from __future__ import annotations

from django.db.models import Q

from apps.tabchat.models import Conversation, ConversationMembershipWindow


def apply_user_message_visibility(
    queryset,
    *,
    user_id: str,
    history_cleared_seq: int,
    conversation_ids: list[str] | set[str] | tuple[str, ...] | None = None,
):
    """同时应用个人隐藏/清空历史与外部群成员可见窗口。"""
    if history_cleared_seq > 0:
        queryset = queryset.filter(seq__gt=history_cleared_seq)
    queryset = queryset.exclude(user_states__user_id=user_id, user_states__hidden=True)
    if not conversation_ids:
        return queryset

    normalized_ids = [str(conversation_id) for conversation_id in conversation_ids]
    external_ids = {
        str(conversation_id)
        for conversation_id in Conversation.objects.filter(
            id__in=normalized_ids,
            is_external=True,
        ).values_list("id", flat=True)
    }
    if not external_ids:
        return queryset

    visibility = ~Q(conversation_id__in=external_ids)
    windows = ConversationMembershipWindow.objects.filter(
        conversation_member__conversation_id__in=external_ids,
        conversation_member__user_id=user_id,
    ).values(
        "conversation_member__conversation_id",
        "visible_from_seq",
        "visible_until_seq",
    )
    for window in windows:
        window_filter = Q(
            conversation_id=window["conversation_member__conversation_id"],
            seq__gte=window["visible_from_seq"],
        )
        if window["visible_until_seq"] is not None:
            window_filter &= Q(seq__lte=window["visible_until_seq"])
        visibility |= window_filter
    return queryset.filter(visibility)
