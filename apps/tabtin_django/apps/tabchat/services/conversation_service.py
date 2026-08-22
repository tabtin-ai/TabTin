"""会话管理服务。

职责：会话 CRUD、DM 去重、成员管理。
"""

from __future__ import annotations

import logging
import re
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from django.db import IntegrityError, transaction
from django.db.models import Count, F, Q, IntegerField
from django.utils import timezone

from django.contrib.auth import get_user_model

from apps.tabchat.constants import (
    ConversationType,
    GROUP_MEMBER_LIMIT,
    IMEventType,
    MemberRole,
)
from apps.tabtinspace.models import Agent, Organization, OrganizationMember, Project, ProjectMembership, Space
from apps.tabchat.models import (
    Conversation,
    ConversationAgentWorkspace,
    ConversationMember,
    ConversationMembershipWindow,
    ConversationUserState,
)
from apps.tabchat.services.conversation_access import ConversationAccessResolver
from apps.tabchat.services.external_contact_service import (
    ExternalContactResolver,
    ResolvedExternalContact,
)
from apps.tabchat.services.external_group_errors import ExternalGroupCapabilityError
from apps.tabchat.services.centrifugo_service import get_centrifugo_service
from apps.tabchat.services.im_outbox_service import IMOutboxService
from apps.tabchat.services.label_service import LabelService
from apps.tabchat.utils import (
    get_conversation_team_space,
    get_team_space_execution_agent_id,
    is_conversation_user_active,
    is_organization_member,
)
from apps.tabtinspace.services.space_visibility import get_accessible_space_ids, user_can_access_space
from apps.services.common.db_router import postgres_app_db_alias
from apps.services.oss.services.public_assets import build_public_asset_url

User = get_user_model()

logger = logging.getLogger(__name__)

_MAX_SYSTEM_PREVIEW_LEN = 200
DEFAULT_TEAM_SPACE_CHANNEL_NAMES = ("#general", "#agent-updates")
_MAX_CHANNEL_NAME_LEN = 64


def _agent_identity_by_id(agent_ids: list[Any]) -> dict[str, dict[str, Any]]:
    """Agent 展示名 + 主人，供群成员 DTO 一次批查。"""
    normalized_ids = [agent_id for agent_id in agent_ids if agent_id]
    if not normalized_ids:
        return {}
    agents = list(
        Agent.objects.filter(id__in=normalized_ids).values("id", "name", "owner_user_id")
    )
    owner_ids = [
        agent["owner_user_id"]
        for agent in agents
        if agent.get("owner_user_id")
    ]
    owner_name_by_id = {
        str(user["id"]): (user.get("nickname") or user.get("username") or "")
        for user in User.objects.filter(id__in=owner_ids).values(
            "id", "nickname", "username"
        )
    }
    identities: dict[str, dict[str, Any]] = {}
    for agent in agents:
        agent_id = str(agent["id"])
        raw_owner_id = agent.get("owner_user_id")
        owner_user_id = str(raw_owner_id) if raw_owner_id else ""
        identities[agent_id] = {
            "name": agent.get("name") or "",
            "owner_user_id": owner_user_id or None,
            "owner_display_name": owner_name_by_id.get(owner_user_id, "") if owner_user_id else "",
        }
    return identities


def _agent_execution_online_by_id(
    conversation_id: str,
    agent_ids: list[str],
    identities: dict[str, dict[str, Any]],
) -> dict[str, bool]:
    from apps.tabchat.services.conversation_agent_workspace_service import (
        is_owner_execution_online,
    )

    online = {str(agent_id): False for agent_id in agent_ids}
    if not agent_ids:
        return online
    bindings = ConversationAgentWorkspace.objects.select_related(
        "workspace",
        "workspace__device",
    ).filter(
        conversation_id=conversation_id,
        agent_id__in=[str(agent_id) for agent_id in agent_ids],
    )
    for binding in bindings:
        agent_id = str(binding.agent_id)
        owner_user_id = str((identities.get(agent_id) or {}).get("owner_user_id") or "")
        online[agent_id] = is_owner_execution_online(binding.workspace, owner_user_id)
    return online


def _agent_member_payload(
    *,
    agent_id: str,
    identity: dict[str, Any] | None,
    role: int,
    joined_at: Any,
    fallback_name: str = "",
    is_execution_online: bool = False,
) -> dict[str, Any]:
    identity = identity or {}
    return {
        "member_type": "agent",
        "user_id": None,
        "agent_id": agent_id,
        "nickname": identity.get("name") or fallback_name,
        "username": "",
        "avatar": "",
        "role": role,
        "is_muted": False,
        "pinned": False,
        "joined_at": joined_at.isoformat() if joined_at else None,
        "owner_user_id": identity.get("owner_user_id"),
        "owner_display_name": identity.get("owner_display_name") or "",
        "is_execution_online": is_execution_online,
    }


def _enqueue_realtime_event(
    conversation: Conversation,
    event_type: str,
    channels: list[str],
    data: dict[str, Any],
) -> None:
    """把会话领域事件持久化到专用 IM Outbox。"""
    IMOutboxService.enqueue(
        organization_id=str(conversation.organization_id),
        event_type=event_type,
        target_channels=channels,
        data=data,
        conversation=conversation,
    )


def _enqueue_personal_conversation_new(
    conversation: Conversation,
    user_ids: list[str],
    data: dict[str, Any],
) -> None:
    """按接收者的参与组织投递目录事件。

    外部会话由发起方组织托管，但双方必须分别在自己的 Organization 目录看到它。
    personal 事件因此不能复用同一个 ``organization_id`` 充当目录过滤条件。
    """
    normalized_user_ids = list(dict.fromkeys(str(user_id) for user_id in user_ids if user_id))
    if not normalized_user_ids:
        return
    participant_scope_by_user = {
        str(user_id): str(participant_organization_id or conversation.organization_id)
        for user_id, participant_organization_id in ConversationMember.objects.filter(
            conversation=conversation,
            user_id__in=normalized_user_ids,
            status=ConversationMember.Status.ACTIVE,
        ).values_list("user_id", "participant_organization_id")
    }
    users_by_scope: dict[str, list[str]] = {}
    for user_id in normalized_user_ids:
        scope_id = participant_scope_by_user.get(user_id, str(conversation.organization_id))
        users_by_scope.setdefault(scope_id, []).append(user_id)
    for scope_id, scoped_user_ids in users_by_scope.items():
        _enqueue_realtime_event(
            conversation,
            IMEventType.CONVERSATION_NEW,
            [f"personal:{user_id}" for user_id in scoped_user_ids],
            {
                **data,
                "participant_organization_id": scope_id,
                "directory_scope_id": scope_id,
                "can_send": True,
            },
        )


def _record_channel_activity(
    team_space: Space,
    event_type: str,
    *,
    actor_user_id: str,
    conversation_id: str,
    channel_name: str,
    metadata: dict[str, Any] | None = None,
) -> None:
    """频道生命周期写入团队 Space 动态流（best-effort）。"""
    from apps.tabtinspace.models import Project, SpaceActivityEvent
    from apps.tabtinspace.services.space_activity_service import record_team_space_activity

    actor = User.objects.filter(id=actor_user_id).first()

    def _write() -> None:
        record_team_space_activity(
            team_space,
            event_type,
            actor_user=actor,
            target_type="channel",
            target_id=str(conversation_id),
            target_name=channel_name,
            metadata=metadata or {},
        )

    transaction.on_commit(_write, using=postgres_app_db_alias())


def _send_system_message(conversation_id: str, content: str) -> None:
    """群聊内写一条系统提示消息并广播（不计未读、不触发通知）。

    系统消息写 counts_as_unread=False，因此不影响成员未读数与桌面通知；
    消息历史 get_messages 直查 Message 表，系统消息仍会出现在聊天记录里。
    函数幂等：任何异常均被吃掉，只写日志，不影响调用方主逻辑。
    """
    try:
        from apps.tabchat.constants import MessageType
        from apps.tabchat.services.message_service import MessageService

        MessageService.send_message(
            conversation_id=conversation_id,
            sender_id="system",
            sender_type="system",
            content=content,
            message_type=MessageType.SYSTEM,
        )
    except Exception:
        logger.exception("[tabchat] _send_system_message failed conv=%s", conversation_id)


def _deactivate_external_member(
    member: ConversationMember,
    *,
    latest_message_seq: int,
    status: str,
    removed_by: str = "",
) -> None:
    """关闭外部群成员当前可见区间，并保留合法历史。"""
    now = timezone.now()
    open_window = member.visibility_windows.filter(
        visible_until_seq__isnull=True,
    ).first()
    if open_window is not None:
        if latest_message_seq < open_window.visible_from_seq:
            open_window.delete()
        else:
            open_window.visible_until_seq = latest_message_seq
            open_window.left_at = now
            open_window.save(update_fields=["visible_until_seq", "left_at"])
    member.status = status
    member.left_at = now
    member.removed_by = removed_by
    member.save(update_fields=["status", "left_at", "removed_by"])


def _versioned_conversation_avatar_url(conv) -> str:
    """群头像以 Conversation.updated_at 作为浏览器/CDN 缓存版本。"""
    if not conv.avatar_url:
        return ""
    # DM 头像由 User profile 的 avatar_version 管理；此版本只属于 Conversation 群头像。
    if conv.type == ConversationType.DM:
        return conv.avatar_url
    version = str(int(conv.updated_at.timestamp() * 1000)) if conv.updated_at else ""
    if not version:
        return conv.avatar_url
    parts = urlsplit(conv.avatar_url)
    query = dict(parse_qsl(parts.query, keep_blank_values=True))
    query["v"] = version
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment))


def _serialize_conversation_summary(
    conv,
    *,
    prefs: dict[str, Any] | None = None,
    peer: dict[str, Any] | None = None,
    labels: list[dict[str, Any]] | None = None,
    team_space: Space | None = None,
    can_send: bool = True,
) -> dict[str, Any]:
    prefs = prefs or {}
    peer = peer or {}
    return {
        "id": str(conv.id),
        "organization_id": conv.organization_id,
        "space_id": str(conv.space_id) if getattr(conv, "space_id", None) else None,
        "space_name": team_space.name if team_space else "",
        "is_team_space_channel": bool(team_space),
        "is_external": bool(getattr(conv, "is_external", False)),
        "type": conv.type,
        "name": conv.name,
        "avatar_url": _versioned_conversation_avatar_url(conv),
        "member_count": conv.member_count,
        "is_archived": getattr(conv, "is_archived", False),
        "last_message_at": conv.last_message_at.isoformat() if conv.last_message_at else None,
        "last_message_preview": conv.last_message_preview,
        "last_message_id": (
            str(conv.latest_message_id)
            if getattr(conv, "latest_message_id", None)
            else None
        ),
        "unread_count": getattr(conv, "unread_count", 0) or 0,
        # 统计 unread_count 时会话已见的最高消息 seq 水位：移动端加载在途做 baseline/delta 合并用
        # （加载窗口内 seq > 水位 的 realtime 未读才计净增量，seq <= 水位 视为快照已含、不重复计数）。
        "last_message_seq": getattr(conv, "last_message_seq", 0) or 0,
        "created_at": conv.created_at.isoformat(),
        "dm_peer_user_id": peer.get("user_id") if peer else None,
        "dm_peer_organization_id": (
            peer.get("participant_organization_id") if peer else None
        ),
        "pinned": prefs.get("pinned", False),
        "is_muted": prefs.get("is_muted", False),
        "can_send": can_send,
        # TC-37：per-user 会话 label（含系统 @me）。None 兼容旧调用方。
        "labels": labels if labels is not None else [],
    }


def _serialize_conversation_detail(
    conv,
    *,
    unread_count: int,
    members: list[dict[str, Any]],
    labels: list[dict[str, Any]] | None = None,
    team_space: Space | None = None,
    can_send: bool = True,
) -> dict[str, Any]:
    return {
        "id": str(conv.id),
        "organization_id": conv.organization_id,
        "space_id": str(conv.space_id) if getattr(conv, "space_id", None) else None,
        "space_name": team_space.name if team_space else "",
        "is_team_space_channel": bool(team_space),
        "is_external": bool(getattr(conv, "is_external", False)),
        "type": conv.type,
        "name": conv.name,
        "avatar_url": _versioned_conversation_avatar_url(conv),
        "dm_hash": conv.dm_hash,
        "member_count": conv.member_count,
        "is_archived": getattr(conv, "is_archived", False),
        "last_message_at": conv.last_message_at.isoformat() if conv.last_message_at else None,
        "last_message_preview": conv.last_message_preview,
        "created_by": conv.created_by,
        "created_at": conv.created_at.isoformat(),
        "unread_count": unread_count,
        "members": members,
        # TC-37：per-user 会话 label（含系统 @me）。
        "labels": labels if labels is not None else [],
        "has_unread_mention": any(
            l.get("id") == "sys:mention" for l in (labels or [])
        ),
        "can_send": can_send,
    }


def normalize_team_space_channel_name(raw_name: str) -> str:
    """Return canonical display name for a Team Space discussion channel."""
    stripped = (raw_name or "").strip()
    while stripped.startswith("#"):
        stripped = stripped[1:].strip()
    collapsed = re.sub(r"\s+", "-", stripped)
    collapsed = collapsed.strip("-")
    if not collapsed:
        raise ValueError("频道名称不能为空")
    if len(collapsed) > _MAX_CHANNEL_NAME_LEN:
        raise ValueError(f"频道名称不能超过 {_MAX_CHANNEL_NAME_LEN} 个字符")
    if any(ch in collapsed for ch in ("/", "\\", ":", "\x00")):
        raise ValueError("频道名称包含不支持的字符")
    return f"#{collapsed}"


def _space_channel_member_rows(team_space: Project, creator_id: str) -> list[ConversationMember]:
    user_ids = {
        str(uid)
        for uid in ProjectMembership.objects.filter(
            project_id=team_space.id,
            is_active=True,
            status=ProjectMembership.Status.ACTIVE,
        ).values_list("user_id", flat=True)
        if uid
    }
    user_ids.add(str(creator_id))
    owner_ids = set(
        str(uid)
        for uid in ProjectMembership.objects.filter(
            project_id=team_space.id,
            is_active=True,
            status=ProjectMembership.Status.ACTIVE,
            role="owner",
        ).values_list("user_id", flat=True)
        if uid
    )
    rows = [
        ConversationMember(
            user_id=uid,
            role=MemberRole.OWNER if uid in owner_ids else MemberRole.MEMBER,
        )
        for uid in sorted(user_ids)
    ]
    execution_agent_id = get_team_space_execution_agent_id(team_space)
    if execution_agent_id:
        rows.append(
            ConversationMember(
                agent_id=execution_agent_id,
                role=MemberRole.MEMBER,
            )
        )
    return rows

def _serialize_team_space_members(team_space: Project) -> list[dict[str, Any]]:
    memberships = list(
        ProjectMembership.objects.filter(
            project_id=team_space.id,
            is_active=True,
            status=ProjectMembership.Status.ACTIVE,
        ).values("user_id", "role", "joined_at")
    )
    user_ids = [m["user_id"] for m in memberships if m["user_id"]]
    users = User.objects.filter(id__in=user_ids).values(
        "id", "nickname", "username", "avatar",
    )
    user_map = {u["id"]: u for u in users}
    member_items: list[dict[str, Any]] = []
    for membership in memberships:
        user_id = membership["user_id"]
        user = user_map.get(user_id, {})
        member_items.append({
            "member_type": "user",
            "user_id": user_id,
            "agent_id": None,
            "nickname": user.get("nickname") or "",
            "username": user.get("username") or "",
            "avatar": build_public_asset_url(user.get("avatar") or ""),
            "role": MemberRole.OWNER if membership["role"] == "owner" else MemberRole.MEMBER,
            "is_muted": False,
            "pinned": False,
            "joined_at": membership["joined_at"].isoformat() if membership["joined_at"] else None,
            "owner_user_id": None,
            "owner_display_name": "",
        })
    execution_agent_id = get_team_space_execution_agent_id(team_space)
    if execution_agent_id:
        executable = Agent.objects.filter(
            id=execution_agent_id,
            organization_id=team_space.organization_id,
            type="bot",
            is_active=True,
        ).exists()
        identities = _agent_identity_by_id([execution_agent_id]) if executable else {}
        identity = identities.get(str(execution_agent_id))
        if identity:
            from apps.tabchat.services.conversation_agent_workspace_service import (
                is_owner_execution_online,
            )
            from apps.tabtinspace.models import Workspace

            execution_space_id = getattr(team_space, "execution_space_id", None)
            execution_workspace = (
                Workspace.objects.select_related("device")
                .filter(id=execution_space_id)
                .first()
                if execution_space_id
                else None
            )
            member_items.append(
                _agent_member_payload(
                    agent_id=str(execution_agent_id),
                    identity=identity,
                    role=MemberRole.MEMBER,
                    joined_at=None,
                    fallback_name="AI",
                    is_execution_online=is_owner_execution_online(
                        execution_workspace,
                        str(identity.get("owner_user_id") or ""),
                    ),
                )
            )
    return member_items


def _is_team_space_owner(team_space: Project, user_id: str) -> bool:
    return ProjectMembership.objects.filter(
        project_id=team_space.id,
        user_id=user_id,
        role="owner",
        is_active=True,
        status=ProjectMembership.Status.ACTIVE,
    ).exists()


def _assert_team_space_channel_owner(conversation: Conversation, user_id: str) -> Project:
    team_space = get_conversation_team_space(conversation)
    if not team_space:
        raise ValueError("会话不是团队 Space 频道")
    if not _is_team_space_owner(team_space, user_id):
        raise PermissionError("只有团队 Space Owner 可以管理频道")
    return team_space


def _team_space_meta_map(conversations: list[Conversation]) -> dict[str, Space]:
    """Return Team Space metadata for channel conversations without per-row lookups."""
    space_ids = {
        conv.space_id
        for conv in conversations
        if getattr(conv, "space_id", None)
    }
    if not space_ids:
        return {}
    return {
        str(space.id): space
        for space in Project.objects.filter(
            id__in=space_ids,
        ).only("id", "name")
    }


class ConversationService:
    """会话管理服务。"""

    @staticmethod
    def _get_team_space_for_channel(
        *,
        organization_id: str,
        space_id: str,
        user_id: str,
    ) -> Space:
        team_space = Project.objects.filter(
            id=space_id,
            organization_id=organization_id,
            is_archived=False,
            trashed_at__isnull=True,
        ).first()
        if not team_space:
            raise ValueError("团队 Space 不存在")
        user = User.objects.filter(id=user_id).first()
        if not user or not user_can_access_space(user, team_space, "viewer"):
            raise PermissionError("无权访问该团队 Space")
        return team_space

    @staticmethod
    def _create_team_space_channel(
        *,
        team_space: Space,
        creator_id: str,
        name: str,
        broadcast: bool = True,
    ) -> Conversation:
        normalized_name = normalize_team_space_channel_name(name)
        existing = Conversation.objects.filter(
            organization_id=str(team_space.organization_id),
            space_id=team_space.id,
            name=normalized_name,
            is_archived=False,
        ).first()
        if existing:
            ConversationService._ensure_team_space_channel_members(existing, team_space, creator_id)
            return existing

        members = _space_channel_member_rows(team_space, creator_id)
        conv = Conversation.objects.create(
            organization_id=str(team_space.organization_id),
            space_id=team_space.id,
            type=ConversationType.GROUP,
            name=normalized_name,
            created_by=creator_id,
            member_count=len(members),
        )
        for member in members:
            member.conversation = conv
        ConversationMember.objects.bulk_create(members)

        from apps.tabtinspace.models import Project, SpaceActivityEvent

        _record_channel_activity(
            team_space,
            SpaceActivityEvent.EventType.CHANNEL_CREATED,
            actor_user_id=creator_id,
            conversation_id=str(conv.id),
            channel_name=normalized_name,
        )

        if broadcast:
            conv_summary = _serialize_conversation_summary(
                conv,
                prefs={"pinned": False, "is_muted": False},
                team_space=team_space,
            )
            _enqueue_personal_conversation_new(
                conv,
                [str(member.user_id) for member in members if member.user_id],
                conv_summary,
            )
        return conv

    @staticmethod
    def _ensure_team_space_channel_members(
        conversation: Conversation,
        team_space: Space,
        creator_id: str,
    ) -> None:
        desired_members = _space_channel_member_rows(team_space, creator_id)
        existing_users = set(
            ConversationMember.objects.filter(
                conversation=conversation,
                user_id__isnull=False,
            ).values_list("user_id", flat=True)
        )
        existing_agents = set(
            ConversationMember.objects.filter(
                conversation=conversation,
                agent_id__isnull=False,
            ).values_list("agent_id", flat=True)
        )
        missing_members = []
        for member in desired_members:
            if member.user_id and member.user_id not in existing_users:
                member.conversation = conversation
                missing_members.append(member)
            elif member.agent_id and member.agent_id not in existing_agents:
                member.conversation = conversation
                missing_members.append(member)
        if missing_members:
            ConversationMember.objects.bulk_create(missing_members, ignore_conflicts=True)
        member_count = ConversationMember.objects.filter(conversation=conversation).count()
        if conversation.member_count != member_count:
            conversation.member_count = member_count
            conversation.save(update_fields=["member_count", "updated_at"])

    @staticmethod
    def ensure_team_space_channels_memberships(team_space: Project, actor_user_id: str) -> None:
        """把当前 Project 成员物化到全部 Team Space 频道 ConversationMember（幂等）。"""
        if not isinstance(team_space, Project):
            return
        channels = Conversation.objects.filter(
            organization_id=str(team_space.organization_id),
            space_id=team_space.id,
            is_archived=False,
        )
        for channel in channels:
            ConversationService._ensure_team_space_channel_members(
                channel, team_space, actor_user_id,
            )

    @staticmethod
    def ensure_default_team_space_channels(space: Project, creator_id: str) -> list[Conversation]:
        if not isinstance(space, Project):
            return []
        created_or_existing: list[Conversation] = []
        for channel_name in DEFAULT_TEAM_SPACE_CHANNEL_NAMES:
            created_or_existing.append(
                ConversationService._create_team_space_channel(
                    team_space=space,
                    creator_id=creator_id,
                    name=channel_name,
                    broadcast=False,
                )
            )
        return created_or_existing

    @staticmethod
    def create_space_channel(
        *,
        organization_id: str,
        space_id: str,
        creator_id: str,
        name: str,
    ) -> Conversation:
        team_space = ConversationService._get_team_space_for_channel(
            organization_id=organization_id,
            space_id=space_id,
            user_id=creator_id,
        )
        with transaction.atomic(using=postgres_app_db_alias()):
            return ConversationService._create_team_space_channel(
                team_space=team_space,
                creator_id=creator_id,
                name=name,
            )

    @staticmethod
    def rename_space_channel(
        space_id: str,
        conversation_id: str,
        user_id: str,
        name: str,
    ) -> Conversation | None:
        try:
            conv = Conversation.objects.get(pk=conversation_id, space_id=space_id)
        except Conversation.DoesNotExist:
            return None
        team_space = _assert_team_space_channel_owner(conv, user_id)
        normalized_name = normalize_team_space_channel_name(name)
        if conv.name == normalized_name:
            return conv
        if Conversation.objects.filter(
            organization_id=conv.organization_id,
            space_id=team_space.id,
            name=normalized_name,
            is_archived=False,
        ).exclude(pk=conv.pk).exists():
            raise ValueError("同名频道已存在")
        old_name = conv.name
        updated = ConversationService.update_conversation(
            conversation_id,
            user_id,
            name=normalized_name,
        )
        if updated is not None:
            from apps.tabtinspace.models import SpaceActivityEvent

            _record_channel_activity(
                team_space,
                SpaceActivityEvent.EventType.CHANNEL_RENAMED,
                actor_user_id=user_id,
                conversation_id=str(conv.id),
                channel_name=normalized_name,
                metadata={"old_name": old_name, "new_name": normalized_name},
            )
        return updated

    @staticmethod
    def archive_space_channel(space_id: str, conversation_id: str, user_id: str) -> bool:
        try:
            conv = Conversation.objects.get(pk=conversation_id, space_id=space_id)
        except Conversation.DoesNotExist:
            return False
        _assert_team_space_channel_owner(conv, user_id)
        if conv.is_archived:
            return True
        team_space = get_conversation_team_space(conv)
        with transaction.atomic(using=postgres_app_db_alias()):
            locked_conv = Conversation.objects.select_for_update().get(
                pk=conv.pk,
                space_id=space_id,
            )
            locked_conv.is_archived = True
            locked_conv.archived_at = timezone.now()
            locked_conv.archived_by = user_id
            locked_conv.save(update_fields=["is_archived", "archived_at", "archived_by", "updated_at"])
            if team_space is not None:
                from apps.tabtinspace.models import SpaceActivityEvent

                _record_channel_activity(
                    team_space,
                    SpaceActivityEvent.EventType.CHANNEL_ARCHIVED,
                    actor_user_id=user_id,
                    conversation_id=str(locked_conv.id),
                    channel_name=locked_conv.name or "",
                )
            _enqueue_realtime_event(
                locked_conv,
                IMEventType.CONVERSATION_UPDATED,
                [f"chat:{locked_conv.id}"],
                {
                    "conversation_id": str(locked_conv.id),
                    "is_archived": True,
                },
            )
        return True

    @staticmethod
    def _validate_organization_members(
        organization_id: str, user_ids: list[str]
    ) -> None:
        """校验 user_ids 全部属于指定 organization（含 owner），不满足则抛 ValueError。"""
        ws_member_ids = set(
            OrganizationMember.objects.filter(
                organization_id=organization_id, user_id__in=user_ids
            ).values_list("user_id", flat=True)
        )
        owner_id = Organization.objects.filter(id=organization_id).values_list(
            "owner_id", flat=True
        ).first()
        if owner_id:
            ws_member_ids.add(str(owner_id))
        invalid = [uid for uid in user_ids if uid not in ws_member_ids]
        if invalid:
            logger.warning(
                "organization_members validation failed: organization=%s invalid_ids=%s",
                organization_id, invalid,
            )
            raise ValueError("部分目标用户不属于该组织")

    @staticmethod
    def create_dm(
        organization_id: str, creator_id: str, other_user_id: str
    ) -> Conversation:
        """创建或获取已有的 DM 会话。"""
        if creator_id == other_user_id:
            raise ValueError("不能与自己创建私信")

        ConversationService._validate_organization_members(
            organization_id, [other_user_id]
        )

        dm_hash = Conversation.compute_dm_hash(creator_id, other_user_id)

        existing = Conversation.objects.filter(
            organization_id=organization_id, dm_hash=dm_hash
        ).first()
        if existing:
            with transaction.atomic(using=postgres_app_db_alias()):
                locked_existing = Conversation.objects.select_for_update().get(pk=existing.pk)
                existing_user_ids = set(
                    ConversationMember.objects.filter(conversation=locked_existing)
                    .values_list("user_id", flat=True)
                )
                missing_ids = [
                    uid for uid in (creator_id, other_user_id)
                    if uid not in existing_user_ids
                ]
                if missing_ids:
                    ConversationMember.objects.bulk_create([
                        ConversationMember(
                            conversation=locked_existing,
                            user_id=uid,
                            role=MemberRole.MEMBER,
                        )
                        for uid in missing_ids
                    ])
                    Conversation.objects.filter(pk=locked_existing.pk).update(
                        member_count=F("member_count") + len(missing_ids),
                    )
                    locked_existing.refresh_from_db(fields=["member_count"])
                return locked_existing

        try:
            with transaction.atomic(using=postgres_app_db_alias()):
                conv = Conversation.objects.create(
                    organization_id=organization_id,
                    type=ConversationType.DM,
                    dm_hash=dm_hash,
                    created_by=creator_id,
                    member_count=2,
                )
                ConversationMember.objects.bulk_create([
                    ConversationMember(
                        conversation=conv,
                        user_id=creator_id,
                        role=MemberRole.MEMBER,
                    ),
                    ConversationMember(
                        conversation=conv,
                        user_id=other_user_id,
                        role=MemberRole.MEMBER,
                    ),
                ])

                profiles = {
                    str(u["id"]): u
                    for u in User.objects.filter(
                        id__in=[creator_id, other_user_id]
                    ).values("id", "nickname", "username", "avatar")
                }

                def _dm_summary(peer_uid):
                    peer = profiles.get(peer_uid, {})
                    conv.name = peer.get("nickname") or peer.get("username") or peer_uid
                    conv.avatar_url = build_public_asset_url(peer.get("avatar") or "")
                    return _serialize_conversation_summary(
                        conv,
                        prefs={"pinned": False, "is_muted": False},
                        peer={"user_id": peer_uid},
                    )

                data_for_creator = _dm_summary(other_user_id)
                data_for_other = _dm_summary(creator_id)

                _enqueue_personal_conversation_new(
                    conv,
                    [creator_id],
                    data_for_creator,
                )
                _enqueue_personal_conversation_new(
                    conv,
                    [other_user_id],
                    data_for_other,
                )
        except IntegrityError:
            conv = Conversation.objects.filter(
                organization_id=organization_id, dm_hash=dm_hash
            ).first()
            if not conv:
                raise

        return conv

    @staticmethod
    def create_external_dm(
        organization_id: str,
        creator_id: str,
        external_contact_id: str,
    ) -> Conversation:
        """创建或复用一段跨 Organization 私信。"""
        resolved = ExternalContactResolver.resolve_for_group(
            creator_id,
            [external_contact_id],
        )[0]
        other_user_id = resolved.peer_user_id
        if creator_id == other_user_id:
            raise ValueError("不能与自己创建私信")
        dm_hash = Conversation.compute_dm_hash(creator_id, other_user_id)

        def activate_existing(existing: Conversation) -> Conversation:
            reactivated_user_ids: list[str] = []
            with transaction.atomic(using=postgres_app_db_alias()):
                locked = Conversation.objects.select_for_update().get(pk=existing.pk)
                participant_scopes = {
                    str(creator_id): str(organization_id),
                    str(other_user_id): str(resolved.peer_organization_id),
                }
                existing_members = {
                    str(member.user_id): member
                    for member in ConversationMember.objects.filter(
                        conversation=locked,
                        user_id__in=participant_scopes,
                    )
                }
                for user_id, participant_scope_id in participant_scopes.items():
                    member = existing_members.get(user_id)
                    if member is None:
                        member = ConversationMember.objects.create(
                            conversation=locked,
                            user_id=user_id,
                            role=MemberRole.MEMBER,
                            participant_organization_id=participant_scope_id,
                        )
                        reactivated_user_ids.append(user_id)
                    elif (
                        member.status != ConversationMember.Status.ACTIVE
                        or member.participant_organization_id != participant_scope_id
                    ):
                        member.status = ConversationMember.Status.ACTIVE
                        member.left_at = None
                        member.removed_by = ""
                        member.participant_organization_id = participant_scope_id
                        member.save(update_fields=[
                            "status",
                            "left_at",
                            "removed_by",
                            "participant_organization_id",
                        ])
                        reactivated_user_ids.append(user_id)
                    ConversationMembershipWindow.objects.get_or_create(
                        conversation_member=member,
                        visible_until_seq__isnull=True,
                        defaults={"visible_from_seq": locked.latest_message_seq + 1},
                    )
                locked.member_count = ConversationMember.objects.filter(
                    conversation=locked,
                    status=ConversationMember.Status.ACTIVE,
                ).count()
                locked.save(update_fields=["member_count", "updated_at"])
                if reactivated_user_ids:
                    summary = _serialize_conversation_summary(
                        locked,
                        prefs={"pinned": False, "is_muted": False},
                    )
                    _enqueue_personal_conversation_new(
                        locked,
                        reactivated_user_ids,
                        summary,
                    )
            return locked

        existing = Conversation.objects.filter(
            is_external=True,
            type=ConversationType.DM,
            dm_hash=dm_hash,
        ).first()
        if existing:
            return activate_existing(existing)

        try:
            with transaction.atomic(using=postgres_app_db_alias()):
                conv = Conversation.objects.create(
                    organization_id=organization_id,
                    type=ConversationType.DM,
                    dm_hash=dm_hash,
                    created_by=creator_id,
                    member_count=2,
                    is_external=True,
                )
                members = ConversationMember.objects.bulk_create([
                    ConversationMember(
                        conversation=conv,
                        user_id=creator_id,
                        role=MemberRole.MEMBER,
                        participant_organization_id=organization_id,
                    ),
                    ConversationMember(
                        conversation=conv,
                        user_id=other_user_id,
                        role=MemberRole.MEMBER,
                        participant_organization_id=resolved.peer_organization_id,
                    ),
                ])
                ConversationMembershipWindow.objects.bulk_create([
                    ConversationMembershipWindow(
                        conversation_member=member,
                        visible_from_seq=1,
                    )
                    for member in members
                ])
                profiles = {
                    str(user["id"]): user
                    for user in User.objects.filter(
                        id__in=[creator_id, other_user_id],
                    ).values("id", "nickname", "username", "avatar")
                }

                def dm_summary(peer_user_id: str) -> dict[str, Any]:
                    peer = profiles.get(peer_user_id, {})
                    conv.name = peer.get("nickname") or peer.get("username") or peer_user_id
                    conv.avatar_url = build_public_asset_url(peer.get("avatar") or "")
                    return _serialize_conversation_summary(
                        conv,
                        prefs={"pinned": False, "is_muted": False},
                        peer={"user_id": peer_user_id},
                    )

                _enqueue_personal_conversation_new(
                    conv,
                    [creator_id],
                    dm_summary(other_user_id),
                )
                _enqueue_personal_conversation_new(
                    conv,
                    [other_user_id],
                    dm_summary(creator_id),
                )
                return conv
        except IntegrityError:
            existing = Conversation.objects.filter(
                is_external=True,
                type=ConversationType.DM,
                dm_hash=dm_hash,
            ).first()
            if existing is None:
                raise
            return activate_existing(existing)

    @staticmethod
    def resolve_or_create_dm(
        organization_id: str,
        requester_id: str,
        other_user_id: str,
        conversation_id_hint: str | None = None,
    ) -> Conversation:
        """解析当前目录中的两人私聊；外部 DM 复用全局会话，内部 DM 按组织创建。"""
        expected_user_ids = {str(requester_id), str(other_user_id)}

        def is_usable(conversation: Conversation | None) -> bool:
            if conversation is None or conversation.type != ConversationType.DM:
                return False
            active_members = list(
                ConversationMember.objects.filter(
                    conversation=conversation,
                    user_id__in=expected_user_ids,
                    status=ConversationMember.Status.ACTIVE,
                )
            )
            if {str(member.user_id) for member in active_members} != expected_user_ids:
                return False
            requester = next(
                (member for member in active_members if str(member.user_id) == str(requester_id)),
                None,
            )
            if requester is None:
                return False
            directory_scope = str(
                requester.participant_organization_id or conversation.organization_id
            )
            return (
                directory_scope == str(organization_id)
                and ConversationAccessResolver.resolve(conversation, requester_id).can_send
            )

        hint = str(conversation_id_hint or "").strip()
        if hint:
            hinted = Conversation.objects.filter(pk=hint).first()
            if is_usable(hinted):
                return hinted

        external = Conversation.objects.filter(
            is_external=True,
            type=ConversationType.DM,
            dm_hash=Conversation.compute_dm_hash(requester_id, other_user_id),
        ).first()
        if is_usable(external):
            return external

        return ConversationService.create_dm(
            organization_id=organization_id,
            creator_id=requester_id,
            other_user_id=other_user_id,
        )

    @staticmethod
    def create_group(
        organization_id: str,
        creator_id: str,
        name: str,
        member_ids: list[str],
        avatar_url: str = "",
        space_id: str | None = None,
        external_contact_ids: list[str] | None = None,
        client_request_id: str = "",
    ) -> Conversation:
        """创建群聊会话。"""
        client_request_id = client_request_id.strip()
        if len(client_request_id) > 100:
            raise ValueError("client_request_id 过长")
        ConversationService._validate_organization_members(
            organization_id,
            [creator_id],
        )
        if client_request_id:
            existing = Conversation.objects.filter(
                organization_id=organization_id,
                created_by=creator_id,
                creation_request_id=client_request_id,
            ).first()
            if existing is not None:
                return existing
        external_contact_ids = external_contact_ids or []
        if space_id and external_contact_ids:
            raise ValueError("Project 频道不能包含外部联系人")

        resolved_external_contacts = ExternalContactResolver.resolve_for_group(
            creator_id,
            external_contact_ids,
        )
        external_user_organizations = {
            contact.peer_user_id: contact.peer_organization_id
            for contact in resolved_external_contacts
        }
        team_space = None
        if space_id:
            team_space = Project.objects.filter(
                id=space_id,
                organization_id=organization_id,
                is_archived=False,
                trashed_at__isnull=True,
            ).first()
            if not team_space:
                raise ValueError("团队 Space 不存在")
            creator = User.objects.filter(id=creator_id).first()
            if not creator or not user_can_access_space(creator, team_space, "viewer"):
                raise PermissionError("无权访问该团队 Space")

        internal_member_ids = list(dict.fromkeys([creator_id, *member_ids]))
        if team_space:
            team_space_user_ids = set(
                ProjectMembership.objects.filter(
                    project_id=team_space.id,
                    is_active=True,
                    status=ProjectMembership.Status.ACTIVE,
                ).values_list("user_id", flat=True)
            )
            internal_member_ids = list(team_space_user_ids | {creator_id})
        duplicated_external_users = set(internal_member_ids) & set(external_user_organizations)
        if duplicated_external_users:
            raise ValueError("群成员身份重复")
        all_member_ids = [*internal_member_ids, *external_user_organizations]
        if len(all_member_ids) > GROUP_MEMBER_LIMIT:
            raise ValueError(f"群聊人数不能超过 {GROUP_MEMBER_LIMIT} 人")

        non_creator_ids = [uid for uid in internal_member_ids if uid != creator_id]
        if non_creator_ids:
            ConversationService._validate_organization_members(
                organization_id, non_creator_ids
            )

        with transaction.atomic(using=postgres_app_db_alias()):
            from apps.services.billing.services.entitlement_limits_service import EntitlementLimitsService

            Organization.objects.using(postgres_app_db_alias()).select_for_update().get(id=organization_id)
            if client_request_id:
                existing = Conversation.objects.filter(
                    organization_id=organization_id,
                    created_by=creator_id,
                    creation_request_id=client_request_id,
                ).first()
                if existing is not None:
                    return existing
            EntitlementLimitsService.check_group_limit(
                organization_id,
                actor=creator_id,
            )
            conv = Conversation.objects.create(
                organization_id=organization_id,
                space_id=space_id if team_space else None,
                type=ConversationType.GROUP,
                name=name,
                avatar_url=avatar_url,
                created_by=creator_id,
                creation_request_id=client_request_id,
                member_count=len(all_member_ids),
                is_external=bool(resolved_external_contacts),
            )
            members = []
            for uid in all_member_ids:
                role = MemberRole.OWNER if uid == creator_id else MemberRole.MEMBER
                members.append(
                    ConversationMember(
                        conversation=conv,
                        user_id=uid,
                        role=role,
                        participant_organization_id=external_user_organizations.get(
                            uid,
                            organization_id,
                        ),
                    )
                )
            created_members = ConversationMember.objects.bulk_create(members)
            if conv.is_external:
                ConversationMembershipWindow.objects.bulk_create(
                    [
                        ConversationMembershipWindow(
                            conversation_member=member,
                            visible_from_seq=1,
                        )
                        for member in created_members
                    ],
                )

            conv_summary = {
                **_serialize_conversation_summary(
                    conv,
                    prefs={"pinned": False, "is_muted": False},
                ),
                "dm_peer_user_id": None,
            }

            _enqueue_personal_conversation_new(conv, all_member_ids, conv_summary)

        return conv

    @staticmethod
    def list_conversations(
        organization_id: str, user_id: str, *, label_ids: list[str] | None = None
    ) -> list[dict[str, Any]]:
        """获取用户的会话列表（含未读数、置顶、免打扰、label）。

        TC-37：label_ids 非空时按 label AND 筛选（含系统 label sys:mention）。
        """
        if not is_organization_member(organization_id, user_id):
            return []

        team_space_ids = list(Project.objects.filter(
            organization_id=organization_id,
        ).values_list("id", flat=True))
        internal_member_qs = ConversationMember.objects.filter(
            user_id=user_id,
            conversation__organization_id=organization_id,
            conversation__is_external=False,
        )
        external_member_qs = ConversationMember.objects.filter(
            user_id=user_id,
            conversation__is_external=True,
            visibility_windows__isnull=False,
        ).filter(
            Q(participant_organization_id=organization_id)
            | Q(
                participant_organization_id="",
                conversation__organization_id=organization_id,
            )
        ).distinct()
        external_member_rows = list(external_member_qs.values(
            "conversation_id",
            "participant_organization_id",
        ))
        external_directory_scope_by_conversation = {
            str(row["conversation_id"]): (
                row["participant_organization_id"] or organization_id
            )
            for row in external_member_rows
        }
        member_conv_ids = set(
            internal_member_qs.values_list("conversation_id", flat=True)
        )
        member_conv_ids.update(
            row["conversation_id"] for row in external_member_rows
        )
        member_conv_ids.difference_update(
            Conversation.objects.filter(
                organization_id=organization_id,
                space_id__in=team_space_ids,
            ).values_list("id", flat=True)
        )
        visible_conv_ids = set(member_conv_ids)
        current_member_status = {
            str(row["conversation_id"]): row["status"]
            for row in ConversationMember.objects.filter(
                user_id=user_id,
                conversation_id__in=visible_conv_ids,
            ).values("conversation_id", "status")
        }

        user = User.objects.filter(id=user_id).first()
        if user:
            accessible_space_ids = get_accessible_space_ids(user, organization_id=organization_id)
            team_spaces = list(Project.objects.filter(
                id__in=accessible_space_ids,
                organization_id=organization_id,
                is_archived=False,
                trashed_at__isnull=True,
            ))
            for team_space in team_spaces:
                ConversationService.ensure_team_space_channels_memberships(team_space, user_id)
            visible_conv_ids.update(
                Conversation.objects.filter(
                    organization_id=organization_id,
                    space_id__in=[str(s.id) for s in team_spaces],
                    is_archived=False,
                ).values_list("id", flat=True)
            )

        # 用户维度的 pinned / is_muted
        member_prefs: dict[str, dict[str, bool]] = {}
        for m in ConversationUserState.objects.filter(
            user_id=user_id,
            conversation_id__in=visible_conv_ids,
        ).values("conversation_id", "pinned", "muted"):
            member_prefs[str(m["conversation_id"])] = {
                "pinned": m["pinned"],
                "is_muted": m["muted"],
            }

        from apps.tabchat.services.message_service import MessageService

        # 一致快照未读：同时拿到 unread_count 与对应的 last_message_seq 水位（构造性同一水位）。
        unread_snapshots = MessageService.get_unread_snapshots(organization_id, user_id)
        conversations = (
            Conversation.objects.filter(id__in=visible_conv_ids, is_archived=False)
            .order_by("-last_message_at", "-created_at")
        )

        conversation_items = list(conversations)
        external_conv_ids = [
            str(conversation.id)
            for conversation in conversation_items
            if conversation.is_external
        ]
        external_summaries = MessageService.get_visible_conversation_summaries(
            user_id,
            external_conv_ids,
        )

        dm_convs = [c for c in conversation_items if c.type == ConversationType.DM]
        dm_peer_map: dict[str, dict] = {}
        if dm_convs:
            dm_conv_ids = [c.id for c in dm_convs]
            peer_members = ConversationMember.objects.filter(
                conversation_id__in=dm_conv_ids,
            ).exclude(user_id=user_id).values_list(
                "conversation_id",
                "user_id",
                "participant_organization_id",
            )
            peer_user_ids = set()
            conv_to_peer: dict[str, tuple[str, str]] = {}
            for cid, uid, participant_organization_id in peer_members:
                conv_to_peer[str(cid)] = (uid, participant_organization_id or "")
                peer_user_ids.add(uid)
            if peer_user_ids:
                users = User.objects.filter(id__in=peer_user_ids).values(
                    "id", "nickname", "username", "avatar"
                )
                user_map = {u["id"]: u for u in users}
                for cid, (uid, participant_organization_id) in conv_to_peer.items():
                    u = user_map.get(uid, {})
                    dm_peer_map[cid] = {
                        "nickname": u.get("nickname") or "",
                        "username": u.get("username") or "",
                        "avatar": build_public_asset_url(u.get("avatar") or ""),
                        "user_id": uid,
                        "participant_organization_id": participant_organization_id,
                    }

        # TC-37：批量计算 label（含系统 @me）
        all_conv_ids_str = [str(c.id) for c in conversation_items]
        labels_map = LabelService.compute_labels_for_conversations(
            organization_id, user_id, all_conv_ids_str
        )

        team_space_map = _team_space_meta_map(conversation_items)

        results = []
        for conv in conversation_items:
            conv_id = str(conv.id)
            snapshot = unread_snapshots.get(conv_id)
            conv.unread_count = snapshot[0] if snapshot else 0
            conv.last_message_seq = snapshot[1] if snapshot else 0
            if conv.is_external:
                visible_summary = external_summaries.get(conv_id, {})
                conv.latest_message_id = visible_summary.get("last_message_id")
                conv.last_message_seq = visible_summary.get(
                    "last_message_seq",
                    conv.last_message_seq,
                )
                conv.last_message_at = visible_summary.get("last_message_at")
                conv.last_message_preview = visible_summary.get(
                    "last_message_preview",
                    "",
                )
            name = conv.name
            avatar_url = conv.avatar_url
            peer = dm_peer_map.get(conv_id, {}) if conv.type == ConversationType.DM else {}
            # DM 顶层身份永远从对方 User profile 派生，不能让旧会话快照反向覆盖。
            if conv.type == ConversationType.DM:
                name = peer.get("nickname") or peer.get("username") or peer.get("user_id", "")
                avatar_url = peer.get("avatar") or ""
            prefs = member_prefs.get(conv_id, {})
            conv.name = name
            conv.avatar_url = avatar_url
            team_space = team_space_map.get(str(conv.space_id)) if conv.space_id else None
            item = _serialize_conversation_summary(
                conv,
                prefs=prefs,
                peer=peer,
                labels=labels_map.get(conv_id, []),
                team_space=team_space,
                can_send=(
                    not conv.is_external
                    or current_member_status.get(conv_id) == ConversationMember.Status.ACTIVE
                ),
            )
            directory_scope_id = (
                external_directory_scope_by_conversation.get(conv_id, organization_id)
                if conv.is_external
                else organization_id
            )
            item["participant_organization_id"] = directory_scope_id
            item["directory_scope_id"] = directory_scope_id
            results.append(item)

        # 置顶优先，同组内按最新消息时间降序
        pinned_items = [c for c in results if c["pinned"]]
        normal_items = [c for c in results if not c["pinned"]]
        pinned_items.sort(key=lambda c: c["last_message_at"] or c["created_at"], reverse=True)
        normal_items.sort(key=lambda c: c["last_message_at"] or c["created_at"], reverse=True)
        results = pinned_items + normal_items

        # TC-37：按 label AND 筛选（在排序后过滤可见集）
        if label_ids:
            filtered_ids = set(LabelService.filter_conversation_ids_by_labels(
                organization_id, user_id, [c["id"] for c in results], label_ids
            ))
            results = [c for c in results if c["id"] in filtered_ids]

        return results

    @staticmethod
    def get_conversation_detail(
        conversation_id: str, user_id: str
    ) -> dict[str, Any] | None:
        """获取会话详情（含成员列表）。"""
        try:
            conv = Conversation.objects.get(pk=conversation_id)
        except Conversation.DoesNotExist:
            return None

        access = ConversationAccessResolver.resolve(conv, user_id)
        if not access.can_view_history:
            return None

        from apps.tabchat.services.message_service import MessageService

        unread_count = MessageService.get_unread_counts(
            conv.organization_id,
            user_id,
        ).get(str(conv.id), 0)
        if conv.is_external:
            visible_summary = MessageService.get_visible_conversation_summaries(
                user_id,
                [str(conv.id)],
            ).get(str(conv.id), {})
            conv.last_message_at = visible_summary.get("last_message_at")
            conv.last_message_preview = visible_summary.get(
                "last_message_preview",
                "",
            )
        team_space = get_conversation_team_space(conv)
        if team_space:
            members = _serialize_team_space_members(team_space)
            conv.member_count = len(members)
            return _serialize_conversation_detail(
                conv,
                unread_count=unread_count,
                members=members,
                labels=LabelService.compute_labels_for_conversations(
                    conv.organization_id, user_id, [str(conv.id)]
                ).get(str(conv.id), []),
                team_space=team_space,
                can_send=access.can_send,
            )

        member_query = ConversationMember.objects.filter(conversation=conv)
        if conv.is_external:
            member_query = member_query.filter(status=ConversationMember.Status.ACTIVE)
        members = list(member_query.values(
            "user_id",
            "agent_id",
            "role",
            "joined_at",
            "participant_organization_id",
        ))
        member_user_ids = [m["user_id"] for m in members if m["user_id"]]
        member_agent_ids = [m["agent_id"] for m in members if m["agent_id"]]
        users = User.objects.filter(id__in=member_user_ids).values(
            "id", "nickname", "username", "avatar"
        )
        user_map = {u["id"]: u for u in users}
        participant_organization_ids = {
            m["participant_organization_id"]
            for m in members
            if m["participant_organization_id"]
        }
        organization_name_map = {
            str(organization_id): organization_name
            for organization_id, organization_name in Organization.objects.filter(
                id__in=participant_organization_ids,
            ).values_list("id", "name")
        }

        # AI Agent 成员只从 Agent 读取身份与主人；Workspace 不承载 Agent 头像。
        agent_identity_map = _agent_identity_by_id(member_agent_ids)
        agent_online_map = _agent_execution_online_by_id(
            str(conv.id),
            [str(agent_id) for agent_id in member_agent_ids],
            agent_identity_map,
        )

        member_items = []
        for m in members:
            if m["agent_id"]:
                aid = str(m["agent_id"])
                payload = _agent_member_payload(
                    agent_id=aid,
                    identity=agent_identity_map.get(aid),
                    role=m["role"],
                    joined_at=m["joined_at"],
                    is_execution_online=agent_online_map.get(aid, False),
                )
                payload.update({
                    "participant_organization_id": m["participant_organization_id"] or "",
                    "is_external": False,
                    "organization_name": organization_name_map.get(
                        str(m["participant_organization_id"]),
                        "",
                    ),
                })
                member_items.append(payload)
            else:
                u = user_map.get(m["user_id"], {})
                participant_organization_id = (
                    m["participant_organization_id"] or str(conv.organization_id)
                )
                member_items.append({
                    "member_type": "user",
                    "user_id": m["user_id"],
                    "agent_id": None,
                    "nickname": u.get("nickname") or "",
                    "username": u.get("username") or "",
                    "avatar": build_public_asset_url(u.get("avatar") or ""),
                    "role": m["role"],
                    "is_muted": False,
                    "pinned": False,
                    "joined_at": m["joined_at"].isoformat() if m["joined_at"] else None,
                    "owner_user_id": None,
                    "owner_display_name": "",
                    "participant_organization_id": participant_organization_id,
                    "is_external": bool(
                        conv.is_external
                        and participant_organization_id != str(conv.organization_id)
                    ),
                    "organization_name": organization_name_map.get(
                        participant_organization_id,
                        "",
                    ),
                })
        # DM 顶层 name/avatar 与 list_conversations 对齐：每次都由对方 User profile
        # 派生，旧 Conversation 快照不得成为身份数据源。
        if conv.type == ConversationType.DM:
            peer = next(
                (
                    m for m in member_items
                    if m["member_type"] == "user" and m["user_id"] != user_id
                ),
                None,
            )
            if peer:
                conv.name = peer["nickname"] or peer["username"] or peer["user_id"] or ""
                conv.avatar_url = peer["avatar"] or ""

        detail = _serialize_conversation_detail(
            conv,
            unread_count=unread_count,
            members=member_items,
            labels=LabelService.compute_labels_for_conversations(
                conv.organization_id, user_id, [str(conv.id)]
            ).get(str(conv.id), []),
            can_send=access.can_send,
        )
        participant_organization_id = (
            access.explicit_member.participant_organization_id
            if access.explicit_member
            and access.explicit_member.participant_organization_id
            else str(conv.organization_id)
        )
        detail["participant_organization_id"] = participant_organization_id
        detail["directory_scope_id"] = participant_organization_id
        if conv.type == ConversationType.DM:
            peer = next(
                (
                    member
                    for member in member_items
                    if member["member_type"] == "user"
                    and member["user_id"] != user_id
                ),
                None,
            )
            detail["dm_peer_user_id"] = peer["user_id"] if peer else None
            detail["dm_peer_organization_id"] = (
                peer["participant_organization_id"] if peer else None
            )
        return detail

    @staticmethod
    def update_conversation(
        conversation_id: str, user_id: str, **kwargs
    ) -> Conversation | None:
        """更新群聊信息（名称、头像）。仅 admin+ 可操作。"""
        try:
            conv = Conversation.objects.get(pk=conversation_id)
        except Conversation.DoesNotExist:
            return None

        if not ConversationAccessResolver.resolve(conv, user_id).can_manage:
            raise PermissionError("只有管理员可以修改群聊信息")

        allowed_fields = {"name", "avatar_url"}
        pending_updates = {
            field: value
            for field, value in kwargs.items()
            if field in allowed_fields and value is not None
        }
        renamed_to: str | None = None
        actor_name = ""
        if "name" in pending_updates and conv.type == ConversationType.GROUP:
            actor = User.objects.filter(id=user_id).values("nickname", "username").first()
            actor_name = (
                (actor.get("nickname") or actor.get("username") or str(user_id)[:8])
                if actor else str(user_id)[:8]
            )

        if pending_updates:
            with transaction.atomic(using=postgres_app_db_alias()):
                locked_conv = Conversation.objects.select_for_update().get(pk=conv.pk)

                update_fields = []
                for field, value in pending_updates.items():
                    if (
                        field == "name"
                        and locked_conv.type == ConversationType.GROUP
                        and value != locked_conv.name
                    ):
                        renamed_to = str(value)
                    setattr(locked_conv, field, value)
                    update_fields.append(field)

                update_fields.append("updated_at")
                locked_conv.save(update_fields=update_fields)
                conv = locked_conv

                _enqueue_realtime_event(
                    conv,
                    IMEventType.CONVERSATION_UPDATED,
                    [f"chat:{conv.id}"],
                    {
                        "conversation_id": str(conv.id),
                        **{
                            field: (_versioned_conversation_avatar_url(conv) if field == "avatar_url" else getattr(conv, field))
                            for field in pending_updates
                        },
                    },
                )

        if renamed_to is not None:
            _send_system_message(
                str(conv.id),
                f"{actor_name}将群名修改为{renamed_to}",
            )

        return conv

    @staticmethod
    def add_members(
        conversation_id: str,
        operator_id: str,
        member_ids: list[str],
        external_contacts: list[ResolvedExternalContact] | None = None,
    ) -> list[str]:
        """添加组织成员或已授权外部联系人。返回实际新增的 user_ids。

        任意可访问该群的成员均可邀请同组织同事；改名 / 踢人仍需 admin+。
        引入外部联系人会永久把群转成外部群，并从当前消息水位建立其可见窗口。
        """
        external_contacts = external_contacts or []
        external_scope_by_user = {
            str(contact.peer_user_id): str(contact.peer_organization_id)
            for contact in external_contacts
        }
        requested_member_ids = list(dict.fromkeys([
            *(str(user_id) for user_id in member_ids if user_id),
            *external_scope_by_user.keys(),
        ]))
        adding_external = bool(external_scope_by_user)
        try:
            conv = Conversation.objects.get(pk=conversation_id)
        except Conversation.DoesNotExist:
            raise ValueError("会话不存在")

        if conv.type == ConversationType.DM:
            raise ValueError("DM 不能添加成员")

        operator_access = ConversationAccessResolver.resolve(conv, operator_id)
        if conv.is_external or adding_external:
            if not operator_access.can_manage:
                raise PermissionError("只有管理员可以添加成员")
        elif not operator_access.can_view:
            raise PermissionError("只有群成员可以添加成员")

        if adding_external and ConversationMember.objects.filter(
            conversation=conv,
            agent_id__isnull=False,
            status=ConversationMember.Status.ACTIVE,
        ).exists():
            raise ValueError("添加外部联系人前请先移除 AI 助手")

        with transaction.atomic(using=postgres_app_db_alias()):
            locked_conv = Conversation.objects.select_for_update().get(pk=conv.pk)

            existing_members = {
                str(member.user_id): member
                for member in ConversationMember.objects.filter(
                    conversation=locked_conv,
                    user_id__in=requested_member_ids,
                )
            }
            active_user_ids = {
                user_id
                for user_id, member in existing_members.items()
                if member.status == ConversationMember.Status.ACTIVE
            }
            new_ids = [
                str(uid)
                for uid in requested_member_ids
                if str(uid) not in active_user_ids
            ]
            if not new_ids:
                return []

            new_internal_ids = [
                user_id
                for user_id in new_ids
                if user_id not in external_scope_by_user
            ]
            ConversationService._validate_organization_members(
                str(locked_conv.organization_id),
                new_internal_ids,
            )

            if locked_conv.member_count + len(new_ids) > GROUP_MEMBER_LIMIT:
                raise ValueError(f"群聊人数不能超过 {GROUP_MEMBER_LIMIT} 人")

            was_external = locked_conv.is_external
            if adding_external and not was_external:
                locked_conv.is_external = True
                locked_conv.save(update_fields=["is_external", "updated_at"])
                existing_active_members = ConversationMember.objects.filter(
                    conversation=locked_conv,
                    status=ConversationMember.Status.ACTIVE,
                )
                ConversationMembershipWindow.objects.bulk_create(
                    [
                        ConversationMembershipWindow(
                            conversation_member=member,
                            visible_from_seq=1,
                        )
                        for member in existing_active_members
                        if not member.visibility_windows.filter(
                            visible_until_seq__isnull=True,
                        ).exists()
                    ],
                    ignore_conflicts=True,
                )

            activated_members: list[ConversationMember] = []
            for user_id in new_ids:
                member = existing_members.get(user_id)
                participant_organization_id = external_scope_by_user.get(
                    user_id,
                    str(locked_conv.organization_id),
                )
                if member is None:
                    member = ConversationMember.objects.create(
                        conversation=locked_conv,
                        user_id=user_id,
                        role=MemberRole.MEMBER,
                        participant_organization_id=participant_organization_id,
                    )
                else:
                    member.status = ConversationMember.Status.ACTIVE
                    member.left_at = None
                    member.removed_by = ""
                    member.role = MemberRole.MEMBER
                    member.participant_organization_id = participant_organization_id
                    member.save(update_fields=[
                        "status",
                        "left_at",
                        "removed_by",
                        "role",
                        "participant_organization_id",
                    ])
                activated_members.append(member)

            if locked_conv.is_external:
                ConversationMembershipWindow.objects.bulk_create([
                    ConversationMembershipWindow(
                        conversation_member=member,
                        visible_from_seq=locked_conv.latest_message_seq + 1,
                    )
                    for member in activated_members
                ])
                new_count = ConversationMember.objects.filter(
                    conversation=locked_conv,
                    status=ConversationMember.Status.ACTIVE,
                ).count()
            else:
                new_count = ConversationMember.objects.filter(
                    conversation=locked_conv,
                ).count()
            Conversation.objects.filter(pk=locked_conv.pk).update(member_count=new_count)
            locked_conv.refresh_from_db(
                fields=[
                    "member_count",
                    "is_external",
                    "organization_id",
                    "name",
                    "avatar_url",
                    "last_message_at",
                    "last_message_preview",
                    "created_at",
                ]
            )

            conv_summary = _serialize_conversation_summary(
                locked_conv,
                prefs={"pinned": False, "is_muted": False},
            )
            if locked_conv.is_external:
                conv_summary["last_message_id"] = None
                conv_summary["last_message_at"] = None
                conv_summary["last_message_preview"] = ""

            if new_ids:
                _enqueue_personal_conversation_new(locked_conv, new_ids, conv_summary)
            locked_conv.member_count = new_count
            _enqueue_realtime_event(
                locked_conv,
                IMEventType.MEMBER_JOINED,
                [f"chat:{locked_conv.id}"],
                {
                    "conversation_id": str(locked_conv.id),
                    "user_ids": new_ids,
                    "member_count": new_count,
                },
            )

        if locked_conv.is_external and new_ids:
            joined_names = [
                user["nickname"] or user["username"] or str(user["id"])[:8]
                for user in User.objects.filter(id__in=new_ids).values(
                    "id",
                    "nickname",
                    "username",
                )
            ]
            if joined_names:
                _send_system_message(
                    str(conv.id),
                    f"{'、'.join(joined_names)} 加入群聊",
                )

        return new_ids

    @staticmethod
    def _validate_organization_agents(
        organization_id: str,
        agent_ids: list[str],
        *,
        operator_id: str,
    ) -> None:
        """校验 agent_ids 全部是操作者私有且可执行的 bot Agent，否则抛 ValueError。"""
        from apps.tabtinspace.models import Agent

        valid = {
            str(a)
            for a in Agent.objects.filter(
                organization_id=organization_id,
                id__in=agent_ids,
                type="bot",
                is_active=True,
            )
            .filter(owner_user_id=operator_id)
            .values_list("id", flat=True)
        }
        invalid = [aid for aid in agent_ids if aid not in valid]
        if invalid:
            logger.warning(
                "organization_agents validation failed: organization=%s invalid_ids=%s",
                organization_id, invalid,
            )
            raise ValueError("部分 AI 助手不属于当前用户")

    @staticmethod
    def add_agents(
        conversation_id: str,
        operator_id: str,
        agent_ids: list[str],
    ) -> list[str]:
        """把 AI Agent 加入群聊（TC-8）。返回实际新增的 agent_ids。

        仅群聊；任意可访问该群的成员可加自己的 bot。
        """
        try:
            conv = Conversation.objects.get(pk=conversation_id)
        except Conversation.DoesNotExist:
            raise ValueError("会话不存在")

        if conv.type == ConversationType.DM:
            raise ValueError("DM 不能添加成员")
        if conv.is_external:
            raise ExternalGroupCapabilityError("外部群不能添加 AI 助手")

        if get_conversation_team_space(conv) is not None:
            raise ValueError("项目群不支持添加 AI 助手")

        if not ConversationAccessResolver.resolve(conv, operator_id).can_view:
            raise PermissionError("只有群成员可以添加 AI 助手")

        with transaction.atomic(using=postgres_app_db_alias()):
            locked_conv = Conversation.objects.select_for_update().get(pk=conv.pk)

            existing_agent_ids = {
                str(a)
                for a in ConversationMember.objects.filter(
                    conversation=locked_conv, agent_id__isnull=False
                ).values_list("agent_id", flat=True)
            }
            seen_agent_ids: set[str] = set()
            new_ids = []
            for aid in agent_ids:
                aid_str = str(aid)
                if aid_str in existing_agent_ids or aid_str in seen_agent_ids:
                    continue
                seen_agent_ids.add(aid_str)
                new_ids.append(aid_str)
            if not new_ids:
                return []

            ConversationService._validate_organization_agents(
                str(locked_conv.organization_id),
                new_ids,
                operator_id=operator_id,
            )

            if locked_conv.member_count + len(new_ids) > GROUP_MEMBER_LIMIT:
                raise ValueError(f"群聊人数不能超过 {GROUP_MEMBER_LIMIT} 人")

            ConversationMember.objects.bulk_create([
                ConversationMember(
                    conversation=locked_conv, agent_id=aid, role=MemberRole.MEMBER
                )
                for aid in new_ids
            ])
            Conversation.objects.filter(pk=locked_conv.pk).update(
                member_count=F("member_count") + len(new_ids),
            )
            locked_conv.refresh_from_db(fields=["member_count"])
            new_count = locked_conv.member_count

            _enqueue_realtime_event(
                locked_conv,
                IMEventType.MEMBER_JOINED,
                [f"chat:{locked_conv.id}"],
                {
                    "conversation_id": str(locked_conv.id),
                    "agent_ids": new_ids,
                    "member_count": new_count,
                },
            )

        return new_ids

    @staticmethod
    def remove_agent(
        conversation_id: str,
        operator_id: str,
        agent_id: str,
    ) -> bool:
        """把 AI Agent 移出群聊（TC-8）。操作者需 admin+。"""
        try:
            conv = Conversation.objects.get(pk=conversation_id)
        except Conversation.DoesNotExist:
            raise ValueError("会话不存在")

        if conv.type == ConversationType.DM:
            raise ValueError("DM 不能移除成员")

        if not ConversationAccessResolver.resolve(conv, operator_id).can_manage:
            raise PermissionError("只有管理员可以移除成员")

        with transaction.atomic(using=postgres_app_db_alias()):
            locked_conv = Conversation.objects.select_for_update().get(pk=conv.pk)
            target = ConversationMember.objects.filter(
                conversation=locked_conv, agent_id=agent_id
            ).first()
            if not target:
                return False

            target.delete()
            from apps.tabchat.models import ConversationAgentWorkspace

            ConversationAgentWorkspace.objects.filter(
                conversation=locked_conv,
                agent_id=agent_id,
            ).delete()
            new_count = ConversationMember.objects.filter(conversation=locked_conv).count()
            Conversation.objects.filter(pk=locked_conv.pk).update(member_count=new_count)

            _enqueue_realtime_event(
                locked_conv,
                IMEventType.MEMBER_LEFT,
                [f"chat:{locked_conv.id}"],
                {
                    "conversation_id": str(locked_conv.id),
                    "agent_id": agent_id,
                    "member_count": new_count,
                },
            )

        return True

    @staticmethod
    def remove_member(
        conversation_id: str,
        operator_id: str,
        target_user_id: str,
    ) -> bool:
        """移除他人，或把自己退出接到 leave_conversation（含群主转让）。

        - 自己退出：走 leave_conversation，群主会自动转让
        - 移除他人：需要 admin+ 权限，且不能踢群主
        """
        try:
            conv = Conversation.objects.get(pk=conversation_id)
        except Conversation.DoesNotExist:
            raise ValueError("会话不存在")

        if conv.type == ConversationType.DM:
            raise ValueError("DM 不能移除成员")

        if operator_id == target_user_id:
            return ConversationService.leave_conversation(conversation_id, operator_id)

        access = ConversationAccessResolver.resolve(conv, operator_id)
        if not access.can_send:
            raise PermissionError("无权访问该会话")
        if not access.can_manage:
            raise PermissionError("只有管理员可以移除成员")

        # 事务前查姓名，用于事务后的系统消息（在事务外查避免锁升级）
        target_user = User.objects.filter(id=target_user_id).values("nickname", "username").first()
        target_name = (
            (target_user.get("nickname") or target_user.get("username") or str(target_user_id)[:8])
            if target_user else str(target_user_id)[:8]
        )

        with transaction.atomic(using=postgres_app_db_alias()):
            locked_conv = Conversation.objects.select_for_update().get(pk=conv.pk)

            target = ConversationMember.objects.filter(
                conversation=locked_conv,
                user_id=target_user_id,
                status=ConversationMember.Status.ACTIVE,
            ).first()
            if not target:
                return False

            if target.role == MemberRole.OWNER:
                raise PermissionError("不能移除群主")

            if locked_conv.is_external:
                _deactivate_external_member(
                    target,
                    latest_message_seq=locked_conv.latest_message_seq,
                    status=ConversationMember.Status.REMOVED,
                    removed_by=operator_id,
                )
                new_count = ConversationMember.objects.filter(
                    conversation=locked_conv,
                    status=ConversationMember.Status.ACTIVE,
                ).count()
            else:
                target.delete()
                new_count = ConversationMember.objects.filter(
                    conversation=locked_conv,
                ).count()
            Conversation.objects.filter(pk=locked_conv.pk).update(member_count=new_count)
            locked_conv.member_count = new_count
            conv_id_str = str(locked_conv.id)
            _enqueue_realtime_event(
                locked_conv,
                IMEventType.MEMBER_LEFT,
                [f"chat:{conv_id_str}"],
                {
                    "conversation_id": conv_id_str,
                    "user_id": target_user_id,
                    "member_count": new_count,
                },
            )
            centrifugo = get_centrifugo_service()
            transaction.on_commit(lambda: centrifugo.unsubscribe(
                target_user_id, f"chat:{conv_id_str}"
            ), using=postgres_app_db_alias())

        # 事务提交后写系统消息（被移除的人已不在群里，看不到这条提示）
        _send_system_message(str(conv.id), f"{target_name} 已被移出群聊")

        return True

    @staticmethod
    def toggle_pinned(
        conversation_id: str,
        user_id: str,
        pinned: bool | None = None,
    ) -> bool:
        """设置会话置顶；未给目标值时兼容旧客户端的切换语义。"""
        conversation = Conversation.objects.filter(pk=conversation_id).first()
        if conversation is None:
            raise ValueError("会话不存在")
        if not ConversationAccessResolver.resolve(conversation, user_id).can_view:
            raise PermissionError("不是该会话的成员")
        state, _ = ConversationUserState.objects.get_or_create(
            conversation=conversation,
            user_id=user_id,
        )
        target = not state.pinned if pinned is None else pinned
        if state.pinned != target:
            state.pinned = target
            state.save(update_fields=["pinned", "updated_at"])
        return state.pinned

    @staticmethod
    def toggle_muted(
        conversation_id: str,
        user_id: str,
        muted: bool | None = None,
    ) -> bool:
        """设置会话免打扰；未给目标值时兼容旧客户端的切换语义。"""
        conversation = Conversation.objects.filter(pk=conversation_id).first()
        if conversation is None:
            raise ValueError("会话不存在")
        if not ConversationAccessResolver.resolve(conversation, user_id).can_view:
            raise PermissionError("不是该会话的成员")
        state, _ = ConversationUserState.objects.get_or_create(
            conversation=conversation,
            user_id=user_id,
        )
        target = not state.muted if muted is None else muted
        if state.muted != target:
            state.muted = target
            state.notification_level = "none" if target else "all"
            state.save(update_fields=["muted", "notification_level", "updated_at"])
        return state.muted

    @staticmethod
    def clear_history(conversation_id: str, user_id: str) -> int:
        """清空聊天记录（只影响自己）。

        在 ConversationUserState 上记录当前会话序号水位，get_messages 据此过滤——
        其他成员的可见性完全不受影响，符合 IM 通用「清空只清自己侧」语义。
        """
        conversation = Conversation.objects.filter(pk=conversation_id).first()
        if conversation is None:
            raise ValueError("会话不存在")
        if not ConversationAccessResolver.resolve(conversation, user_id).can_view:
            raise PermissionError("不是该会话的成员")
        state, _ = ConversationUserState.objects.get_or_create(
            conversation=conversation,
            user_id=user_id,
        )
        state.history_cleared_seq = max(
            state.history_cleared_seq,
            conversation.latest_message_seq,
        )
        state.save(update_fields=["history_cleared_seq", "updated_at"])
        return state.history_cleared_seq

    @staticmethod
    def get_history_cleared_seq(conversation_id: str, user_id: str) -> int:
        """返回用户在该会话的个人历史清空水位。

        实时 `chat:{conversation}` 是共享通道，事件可能在客户端重开会话后延迟送达。
        客户端必须在订阅前取得这个水位，才能拒绝清空前的旧事件。
        """
        conversation = Conversation.objects.filter(pk=conversation_id).first()
        if conversation is None:
            raise ValueError("会话不存在")
        if not ConversationAccessResolver.resolve(conversation, user_id).can_view:
            raise PermissionError("不是该会话的成员")
        state = ConversationUserState.objects.filter(
            conversation=conversation,
            user_id=user_id,
        ).only("history_cleared_seq").first()
        return state.history_cleared_seq if state else 0

    @staticmethod
    def leave_conversation(conversation_id: str, user_id: str) -> bool:
        """退出群聊（自己主动离开）。

        - DM 没有「退出」概念，拒绝。
        - 群主退出时：若群内还有其他人类成员，自动把群主转让给「角色最高、
          加入最早」的成员；只剩自己则直接退出（群随之无人）。
        - 普通成员退出：直接移除自己。
        """
        try:
            conv = Conversation.objects.get(pk=conversation_id)
        except Conversation.DoesNotExist:
            raise ValueError("会话不存在")

        if conv.type == ConversationType.DM:
            raise ValueError("私聊不能退出")

        if not ConversationAccessResolver.resolve(conv, user_id).can_send:
            raise PermissionError("无权访问该会话")

        # 事务前查姓名，用于退出后的系统消息
        leaver = User.objects.filter(id=user_id).values("nickname", "username").first()
        leaver_name = (
            (leaver.get("nickname") or leaver.get("username") or str(user_id)[:8])
            if leaver else str(user_id)[:8]
        )

        with transaction.atomic(using=postgres_app_db_alias()):
            locked_conv = Conversation.objects.select_for_update().get(pk=conv.pk)

            me = ConversationMember.objects.filter(
                conversation=locked_conv,
                user_id=user_id,
                status=ConversationMember.Status.ACTIVE,
            ).first()
            if not me:
                return False

            if me.role == MemberRole.OWNER:
                successor = (
                    ConversationMember.objects.filter(
                        conversation=locked_conv,
                        user_id__isnull=False,
                        status=ConversationMember.Status.ACTIVE,
                    )
                    .exclude(user_id=user_id)
                    .order_by("-role", "joined_at")
                    .first()
                )
                if successor:
                    successor.role = MemberRole.OWNER
                    successor.save(update_fields=["role"])

            if locked_conv.is_external:
                _deactivate_external_member(
                    me,
                    latest_message_seq=locked_conv.latest_message_seq,
                    status=ConversationMember.Status.LEFT,
                )
                new_count = ConversationMember.objects.filter(
                    conversation=locked_conv,
                    status=ConversationMember.Status.ACTIVE,
                ).count()
            else:
                me.delete()
                new_count = ConversationMember.objects.filter(
                    conversation=locked_conv,
                ).count()
            Conversation.objects.filter(pk=locked_conv.pk).update(
                member_count=new_count
            )
            locked_conv.member_count = new_count
            conv_id_str = str(locked_conv.id)

            _enqueue_realtime_event(
                locked_conv,
                IMEventType.MEMBER_LEFT,
                [f"chat:{conv_id_str}"],
                {
                    "conversation_id": conv_id_str,
                    "user_id": user_id,
                    "member_count": new_count,
                },
            )
            centrifugo = get_centrifugo_service()
            transaction.on_commit(lambda: centrifugo.unsubscribe(
                user_id, f"chat:{conv_id_str}"
            ), using=postgres_app_db_alias())

        # 向剩余成员广播「xxx 已退出群聊」系统消息
        if new_count > 0:
            _send_system_message(str(conv.id), f"{leaver_name} 已退出群聊")

        return True

    @staticmethod
    def check_membership(conversation_id: str, user_id: str) -> bool:
        """检查用户是否是会话成员。"""
        return is_conversation_user_active(conversation_id, user_id)
