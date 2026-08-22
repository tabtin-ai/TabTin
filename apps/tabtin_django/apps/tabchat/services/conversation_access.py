"""TabChat 会话访问判定的唯一入口。"""

from __future__ import annotations

from dataclasses import dataclass

from apps.tabchat.constants import MemberRole
from apps.tabchat.models import Conversation, ConversationMember
from apps.tabchat.utils import get_conversation_team_space, is_organization_member


@dataclass(frozen=True)
class ResolvedAccess:
    can_view: bool
    can_view_history: bool
    can_subscribe: bool
    can_send: bool
    can_manage: bool
    explicit_member: ConversationMember | None
    space_membership: object | None


class ConversationAccessResolver:
    """统一 ConversationMember 与 Team Space ProjectMembership 权限。"""

    @staticmethod
    def resolve(conversation: Conversation, user_id: str) -> ResolvedAccess:
        explicit_member = (
            ConversationMember.objects
            .filter(conversation=conversation, user_id=user_id)
            .first()
        )

        space_membership = None
        team_space = get_conversation_team_space(conversation)
        if team_space is not None:
            from apps.tabtinspace.models import ProjectMembership

            # get_conversation_team_space 返回 Project；成员在 ProjectMembership。
            space_membership = (
                ProjectMembership.objects
                .filter(
                    project=team_space,
                    user_id=user_id,
                    is_active=True,
                    status=ProjectMembership.Status.ACTIVE,
                )
                .first()
            )

        organization_access = is_organization_member(
            str(conversation.organization_id),
            str(user_id),
        )
        if conversation.is_external:
            is_active_member = bool(
                explicit_member
                and explicit_member.status == ConversationMember.Status.ACTIVE
            )
            has_history = bool(
                explicit_member
                and explicit_member.visibility_windows.exists()
            )
            can_view_history = is_active_member or has_history
            can_manage = bool(
                is_active_member
                and explicit_member
                and explicit_member.role in (MemberRole.OWNER, MemberRole.ADMIN)
            )
            return ResolvedAccess(
                can_view=can_view_history,
                can_view_history=can_view_history,
                can_subscribe=is_active_member,
                can_send=is_active_member,
                can_manage=can_manage,
                explicit_member=explicit_member,
                space_membership=None,
            )

        # Team Space 会话的人类访问权以当前 ProjectMembership 为准。
        # ConversationMember 可能是订阅/展示所需的物化快照，成员退出 Project 后会陈旧，
        # 不能反向延长其访问权；普通 DM/GROUP 则以显式成员为准。
        can_view = organization_access and bool(
            space_membership if team_space is not None else explicit_member
        )
        can_manage = False
        if can_view and explicit_member is not None:
            can_manage = explicit_member.role in (MemberRole.OWNER, MemberRole.ADMIN)
        if can_view and space_membership is not None:
            can_manage = space_membership.role in ("owner", "admin")

        return ResolvedAccess(
            can_view=can_view,
            can_view_history=can_view,
            can_subscribe=can_view,
            can_send=can_view,
            can_manage=can_manage,
            explicit_member=explicit_member,
            space_membership=space_membership,
        )

    @staticmethod
    def can_agent_send(conversation: Conversation, agent_id: str) -> bool:
        if conversation.is_external:
            return False
        team_space = get_conversation_team_space(conversation)
        if team_space is not None:
            from apps.tabchat.utils import get_team_space_execution_agent_id

            # Team Space 频道中的 ConversationMember 是物化快照，不能在执行
            # Agent 解绑后继续授予发送权；实时 execution binding 才是权限源。
            return get_team_space_execution_agent_id(team_space) == str(agent_id)

        return ConversationMember.objects.filter(
            conversation=conversation,
            agent_id=agent_id,
        ).exists()

    @staticmethod
    def human_user_ids(conversation: Conversation) -> list[str]:
        team_space = get_conversation_team_space(conversation)
        if team_space is not None:
            from apps.tabtinspace.models import ProjectMembership

            # get_conversation_team_space 返回 Project；成员在 ProjectMembership。
            user_ids = set(
                ProjectMembership.objects
                .filter(
                    project=team_space,
                    is_active=True,
                    status=ProjectMembership.Status.ACTIVE,
                )
                .values_list("user_id", flat=True)
            )
        else:
            member_query = ConversationMember.objects.filter(
                conversation=conversation,
                user_id__isnull=False,
            )
            if conversation.is_external:
                member_query = member_query.filter(
                    status=ConversationMember.Status.ACTIVE,
                )
            user_ids = set(member_query.values_list("user_id", flat=True))

        if conversation.is_external:
            return sorted(str(user_id) for user_id in user_ids if user_id)

        from apps.tabtinspace.models import Organization, OrganizationMember

        organization_user_ids = {
            str(user_id)
            for user_id in OrganizationMember.objects.filter(
                organization_id=conversation.organization_id,
                user_id__isnull=False,
            ).values_list("user_id", flat=True)
        }
        owner_id = (
            Organization.objects.filter(id=conversation.organization_id)
            .values_list("owner_id", flat=True)
            .first()
        )
        if owner_id:
            organization_user_ids.add(str(owner_id))

        return sorted(
            str(user_id)
            for user_id in user_ids
            if user_id and str(user_id) in organization_user_ids
        )
