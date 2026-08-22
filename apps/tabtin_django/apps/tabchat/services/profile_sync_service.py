"""将 User profile 变更投递给受影响 IM 参与者。"""

from __future__ import annotations

from collections import defaultdict

from django.db.models import Q

from apps.services.oss.services.public_assets import build_public_asset_url
from apps.tabchat.constants import IMEventType
from apps.tabchat.models import Conversation, ConversationMember
from apps.tabchat.services.conversation_access import ConversationAccessResolver
from apps.tabchat.services.im_outbox_service import IMOutboxService


def avatar_version(profile_revision: int) -> str:
    """资料版本同时是头像缓存键；不能由可复用的 object key 推导。"""
    return str(profile_revision) if profile_revision else ""


def publish_user_profile_updated(user) -> None:
    """向当前仍有会话访问权的参与者推送最新 profile。"""
    user_id = str(user.id)
    conversation_ids = (
        ConversationMember.objects.filter(user_id=user_id)
        .filter(
            Q(conversation__is_external=False)
            | Q(status=ConversationMember.Status.ACTIVE)
        )
        .values_list("conversation_id", flat=True)
    )
    conversations = Conversation.objects.filter(id__in=conversation_ids)
    recipients_by_organization: dict[str, set[str]] = defaultdict(set)
    for conversation in conversations:
        # Team Space 的 ConversationMember 是陈旧快照；统一 resolver 会同时过滤
        # 当前 OrganizationMember 和 active SpaceMembership，避免退出后的资料泄露。
        recipients_by_organization[str(conversation.organization_id)].update(
            ConversationAccessResolver.human_user_ids(conversation)
        )

    if not recipients_by_organization:
        return

    revision = user.profile_revision
    profile = {
        "id": user_id,
        "nickname": user.nickname or "",
        "username": user.username or "",
        "avatar": build_public_asset_url(user.avatar or ""),
        "avatar_version": avatar_version(revision),
        "revision": revision,
    }
    for organization_id, recipient_ids in recipients_by_organization.items():
        if not recipient_ids:
            continue
        IMOutboxService.enqueue(
            organization_id=organization_id,
            event_type=IMEventType.USER_PROFILE_UPDATED,
            target_channels=[f"personal:{recipient_id}" for recipient_id in recipient_ids],
            data=profile,
        )
