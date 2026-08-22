"""TabChat 通用工具函数。"""

from __future__ import annotations


def get_conversation_team_space(conversation):
    """Return the bound Project for a conversation, if it is a Project conversation."""
    space_id = getattr(conversation, "space_id", None)
    if not space_id:
        return None

    from apps.tabtinspace.models import Project

    return (
        Project.objects
        .filter(
            id=space_id,
            organization_id=getattr(conversation, "organization_id", None),
            is_archived=False,
            trashed_at__isnull=True,
        )
        .first()
    )


def is_team_space_conversation_user_active(conversation, user_id: str) -> bool:
    """Team Space conversations inherit access from explicit Space membership."""
    team_space = get_conversation_team_space(conversation)
    if not team_space:
        return False

    from django.contrib.auth import get_user_model
    from apps.tabtinspace.services.space_visibility import user_can_access_space

    user = get_user_model().objects.filter(id=user_id).first()
    return bool(user and user_can_access_space(user, team_space, "viewer"))


def get_team_space_conversation_user_ids(conversation) -> list[str]:
    """Return active human members for a Team Space conversation."""
    team_space = get_conversation_team_space(conversation)
    if not team_space:
        return []

    from apps.tabtinspace.models import ProjectMembership

    # get_conversation_team_space 返回 Project；成员在 ProjectMembership。
    return list(
        ProjectMembership.objects
        .filter(project_id=team_space.id, is_active=True)
        .values_list("user_id", flat=True)
    )


def get_team_space_execution_agent_id(team_space) -> str:
    """Return the Agent identity exposed to Team Space channels for @Agent."""
    execution_space = getattr(team_space, "execution_space", None)
    if execution_space is not None and getattr(execution_space, "agent_id", None):
        return str(execution_space.agent_id)
    execution_space_id = getattr(team_space, "execution_space_id", None)
    if not execution_space_id:
        return ""
    from apps.tabtinspace.models import Workspace

    agent_id = (
        Workspace.objects.filter(id=execution_space_id)
        .values_list("agent_id", flat=True)
        .first()
    )
    return str(agent_id) if agent_id else ""


def is_organization_member(organization_id: str, user_id: str) -> bool:
    """检查用户是否为 organization 成员（含 owner）。

    统一所有场景的 organization 归属判定，避免不一致。
    """
    from apps.tabtinspace.models import Organization, OrganizationMember

    if Organization.objects.filter(id=organization_id, owner_id=user_id).exists():
        return True
    return OrganizationMember.objects.filter(
        organization_id=organization_id, user_id=user_id
    ).exists()


def is_conversation_user_active(conversation_id: str, user_id: str) -> bool:
    """兼容入口；实际权限统一由 ConversationAccessResolver 判定。"""
    from apps.tabchat.models import Conversation
    from apps.tabchat.services.conversation_access import ConversationAccessResolver

    conversation = Conversation.objects.filter(id=conversation_id).first()
    if not conversation:
        return False
    return ConversationAccessResolver.resolve(conversation, user_id).can_view
