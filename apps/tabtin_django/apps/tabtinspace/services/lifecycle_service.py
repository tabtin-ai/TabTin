from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable

from django.db import transaction
from django.db.models import F, Value
from django.db.models.functions import Coalesce, Greatest
from django.utils import timezone

from apps.services.common.db_router import postgres_app_db_alias

import logging

_logger = logging.getLogger(__name__)
from apps.tabchat.models import Conversation
from apps.tabtinspace.models import Agent, Space, SpaceMembership, Organization


@dataclass(frozen=True)
class UserMembershipSpec:
    user_id: str
    role: str = "viewer"


@dataclass(frozen=True)
class AgentMembershipSpec:
    agent_id: str
    role: str = "participant"
    role_label: str = ""
    responsibility: str = ""
    persona_override: str = ""


class SpaceLifecycleService:
    """统一承接 Space 创建、成员同步和活跃度更新。

    TabChat DM/GROUP shadow Spaces are deprecated. The legacy IM helpers below
    are retained as no-ops so accidental callers cannot create new shadow rows.
    """

    @staticmethod
    def _normalize_name(name: str | None, fallback: str) -> str:
        value = (name or "").strip()
        return value or fallback

    @classmethod
    def _reserve_unique_name(
        cls,
        organization: Organization,
        preferred_name: str,
        fallback: str,
        *,
        exclude_space_id=None,
    ) -> str:
        base_name = cls._normalize_name(preferred_name, fallback)
        candidate = base_name
        suffix = 2
        while True:
            from apps.tabtinspace.models import Workspace
            queryset = Workspace.objects.filter(organization=organization, name=candidate)
            if exclude_space_id:
                queryset = queryset.exclude(id=exclude_space_id)
            if not queryset.exists():
                return candidate
            candidate = f"{base_name} ({suffix})"
            suffix += 1

    @staticmethod
    def _workspace_id_for_space(space: Space) -> str:
        """#3266：SpaceMembership 挂 Workspace；个人域 id-reuse。"""
        return str(space.id)

    @classmethod
    def _sync_user_memberships(
        cls,
        space: Space,
        members: Iterable[UserMembershipSpec],
        *,
        deactivate_missing: bool = False,
    ) -> None:
        workspace_id = cls._workspace_id_for_space(space)
        seen: set[str] = set()
        for member in members:
            if not member.user_id or member.user_id in seen:
                continue
            seen.add(member.user_id)
            existing = list(
                SpaceMembership.objects.filter(
                    workspace_id=workspace_id,
                    user_id=member.user_id,
                    agent__isnull=True,
                ).order_by("joined_at", "id")
            )
            if existing:
                primary = existing[0]
                update_fields: list[str] = []
                if primary.role != member.role:
                    primary.role = member.role
                    update_fields.append("role")
                if not primary.is_active:
                    primary.is_active = True
                    update_fields.append("is_active")
                if update_fields:
                    primary.save(update_fields=update_fields)
                if len(existing) > 1:
                    SpaceMembership.objects.filter(
                        id__in=[item.id for item in existing[1:]]
                    ).update(is_active=False)
            else:
                SpaceMembership.objects.create(
                    workspace_id=workspace_id,
                    user_id=member.user_id,
                    role=member.role,
                    is_active=True,
                )
        if deactivate_missing:
            queryset = SpaceMembership.objects.filter(
                workspace_id=workspace_id, user_id__isnull=False,
            )
            if seen:
                queryset = queryset.exclude(user_id__in=seen)
            queryset.update(is_active=False)

    @classmethod
    def _sync_agent_memberships(
        cls,
        space: Space,
        members: Iterable[AgentMembershipSpec],
        *,
        deactivate_missing: bool = False,
    ) -> None:
        workspace_id = cls._workspace_id_for_space(space)
        seen: set[str] = set()
        for member in members:
            if not member.agent_id or member.agent_id in seen:
                continue
            seen.add(member.agent_id)
            existing = list(
                SpaceMembership.objects.filter(
                    workspace_id=workspace_id,
                    agent_id=member.agent_id,
                    user__isnull=True,
                ).order_by("joined_at", "id")
            )
            if existing:
                primary = existing[0]
                update_fields: list[str] = []
                if primary.role != member.role:
                    primary.role = member.role
                    update_fields.append("role")
                if not primary.is_active:
                    primary.is_active = True
                    update_fields.append("is_active")
                if primary.role_label != member.role_label:
                    primary.role_label = member.role_label
                    update_fields.append("role_label")
                if primary.responsibility != member.responsibility:
                    primary.responsibility = member.responsibility
                    update_fields.append("responsibility")
                if primary.persona_override != member.persona_override:
                    primary.persona_override = member.persona_override
                    update_fields.append("persona_override")
                if update_fields:
                    primary.save(update_fields=update_fields)
                if len(existing) > 1:
                    SpaceMembership.objects.filter(
                        id__in=[item.id for item in existing[1:]]
                    ).update(is_active=False)
            else:
                SpaceMembership.objects.create(
                    workspace_id=workspace_id,
                    agent_id=member.agent_id,
                    role=member.role,
                    is_active=True,
                    role_label=member.role_label,
                    responsibility=member.responsibility,
                    persona_override=member.persona_override,
                )
        if deactivate_missing:
            queryset = SpaceMembership.objects.filter(
                workspace_id=workspace_id, agent__isnull=False,
            )
            if seen:
                queryset = queryset.exclude(agent_id__in=seen)
            queryset.update(is_active=False)

    @classmethod
    def sync_space_user_memberships(
        cls,
        space: Space,
        members: Iterable[UserMembershipSpec],
        *,
        deactivate_missing: bool = False,
    ) -> None:
        cls._sync_user_memberships(
            space,
            members,
            deactivate_missing=deactivate_missing,
        )

    @classmethod
    def sync_space_agent_memberships(
        cls,
        space: Space,
        members: Iterable[AgentMembershipSpec],
        *,
        deactivate_missing: bool = False,
    ) -> None:
        cls._sync_agent_memberships(
            space,
            members,
            deactivate_missing=deactivate_missing,
        )

    @classmethod
    def ensure_workspace_agent_identity(cls, workspace, agent_id=None) -> Agent | None:
        """#6198：现场不再拥有默认 Agent。

        仅当调用方显式传入 ``agent_id`` 时返回该 Agent；否则 None。
        """
        _ = workspace
        if not agent_id:
            return None
        return Agent.objects.filter(id=agent_id, is_active=True).first()

    @staticmethod
    def _group_member_role_to_space_role(role: str) -> str:
        return "admin" if role == "moderator" else "participant"

    @classmethod
    def sync_group_room_space_memberships(cls, room) -> "Space | None":
        """Deprecated: legacy group_chat rooms are sunset. No-op."""
        _logger.info("[SpaceLifecycle][DEPRECATED] sync_group_room_space_memberships called — no-op")
        return None

    @classmethod
    def sync_conversation_space_memberships(cls, conversation: Conversation) -> Space | None:
        """Deprecated: TabChat no longer syncs DM/GROUP members to Space."""
        _logger.warning(
            "[SpaceLifecycle][DEPRECATED] sync_conversation_space_memberships "
            "called for conversation=%s; no-op",
            getattr(conversation, "id", None),
        )
        return None

    @classmethod
    def reserve_space_name(
        cls,
        *,
        organization: Organization,
        preferred_name: str,
        fallback: str,
        exclude_space_id=None,
    ) -> str:
        return cls._reserve_unique_name(
            organization,
            preferred_name,
            fallback,
            exclude_space_id=exclude_space_id,
        )

    @classmethod
    @transaction.atomic(using=postgres_app_db_alias())
    def create_space_with_user_members(
        cls,
        *,
        organization: Organization,
        space_type: str,
        name: str,
        icon: str,
        user_members: Iterable[UserMembershipSpec],
        description: str = "",
        color: str = "",
        status: str = "active",
        last_activity_at=None,
    ) -> Space:
        raise RuntimeError(
            'SpaceLifecycleService.create_space_with_user_members 已退役；'
            '请改用 WorkspaceService / ProjectService'
        )

    @classmethod
    def ensure_group_space_for_room(cls, room) -> "Space | None":
        """Deprecated: legacy group_chat rooms are sunset. No-op."""
        _logger.info("[SpaceLifecycle][DEPRECATED] ensure_group_space_for_room called — no-op")
        return None

    @classmethod
    def ensure_dm_space_for_conversation(cls, conversation: Conversation) -> Space | None:
        """Deprecated: no new callers; TabChat DM conversations do not create Spaces."""
        _logger.warning(
            "[SpaceLifecycle][DEPRECATED] ensure_dm_space_for_conversation "
            "called for conversation=%s; no-op",
            getattr(conversation, "id", None),
        )
        return None

    @classmethod
    def ensure_group_space_for_conversation(cls, conversation: Conversation) -> Space | None:
        """Deprecated: no new callers; TabChat GROUP conversations do not create Spaces."""
        _logger.warning(
            "[SpaceLifecycle][DEPRECATED] ensure_group_space_for_conversation "
            "called for conversation=%s; no-op",
            getattr(conversation, "id", None),
        )
        return None

    @staticmethod
    def touch_space(space_id, occurred_at=None) -> None:
        if not space_id:
            return
        from apps.tabtinspace.models import Project
        next_activity = occurred_at or timezone.now()
        # ：仅 Project 仍有 last_activity_at；Workspace 无该字段。
        Project.objects.filter(id=space_id).update(
            last_activity_at=Coalesce(
                Greatest(F("last_activity_at"), Value(next_activity)),
                Value(next_activity),
            )
        )
