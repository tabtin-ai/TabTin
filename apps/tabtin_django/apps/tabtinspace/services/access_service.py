"""
SpaceAccessService - Space membership and Organization Agent visibility.
"""
from typing import Dict, Iterable, Optional, Set, Union
from uuid import UUID
import logging

from django.contrib.auth import get_user_model
from django.db import transaction
from django.db.models import QuerySet

from apps.services.common.db_router import postgres_app_db_alias
from apps.tabtinspace.models import (
    Agent,
    Project,
    ProjectMembership,
    Space,  # 非 Model 导入壳（SpaceType）
    SpaceActivityEvent,
    SpaceMembership,
    Organization,
    OrganizationMember,
    Workspace,
)
from apps.tabtinspace.services.space_visibility import (
    is_bot_agent_space,
    sync_space_visibility_from_memberships,
)
from apps.tabtinspace.services.space_activity_service import (
    record_team_space_activity,
    resolve_user_display_name,
)
from .base import BaseService, ROLE_LEVELS, ASSIGNABLE_ROLES, ServiceError

logger = logging.getLogger(__name__)

HostMembership = Union[SpaceMembership, ProjectMembership]


class SpaceAccessService(BaseService):
    """Space member management.

    Space-level sharing and delegation were retired by SF-1. Resource-level
    sharing remains in TabDoc/TabData permission services.

     / ：个人宿主成员写 SpaceMembership(workspace_id)；
    团队宿主（Project）成员写 ProjectMembership(project_id)，禁止把 Project id
    写入 SpaceMembership.workspace。
    """

    MANAGEABLE_ROLES_BY_ROLE: Dict[str, Set[str]] = {
        'owner': {'admin', 'editor', 'viewer'},
        'admin': {'editor', 'viewer'},
        'editor': {'viewer'},
        'viewer': set(),
    }

    @staticmethod
    def _highest_sufficient_role(
        roles: Iterable[str],
        required_role: str,
    ) -> Optional[str]:
        required_level = ROLE_LEVELS.get(required_role, 0)
        best_role = None
        best_level = 0
        for role in roles:
            level = ROLE_LEVELS.get(role, 0)
            if level > best_level:
                best_level = level
                best_role = role
        if best_level < required_level:
            return None
        return best_role

    @staticmethod
    def _highest_sufficient_membership(
        memberships: Iterable[HostMembership],
        required_role: str,
    ) -> Optional[HostMembership]:
        required_level = ROLE_LEVELS.get(required_role, 0)
        best_membership = None
        best_level = 0
        for membership in memberships:
            level = ROLE_LEVELS.get(membership.role, 0)
            if level > best_level:
                best_level = level
                best_membership = membership
        if best_level < required_level:
            return None
        return best_membership

    def _get_current_host_role(
        self,
        space_id: UUID,
        required_role: str = 'editor',
    ) -> Optional[str]:
        """当前用户在 Workspace / Project 宿主上的活跃角色（满足 required_role 时）。"""
        if not self.user:
            return None

        workspace_roles = SpaceMembership.objects.filter(
            user_id=self.user.id,
            workspace_id=space_id,
            is_active=True,
        ).values_list('role', flat=True)
        role = self._highest_sufficient_role(workspace_roles, required_role)
        if role:
            return role

        project_roles = ProjectMembership.objects.filter(
            user_id=self.user.id,
            project_id=space_id,
            is_active=True,
            status=ProjectMembership.Status.ACTIVE,
        ).values_list('role', flat=True)
        return self._highest_sufficient_role(project_roles, required_role)

    def _get_current_space_membership(
        self,
        space_id: UUID,
        required_role: str = 'editor',
    ) -> Optional[HostMembership]:
        if not self.user:
            return None

        # ：SpaceMembership 挂 Workspace（id-reuse：workspace_id == 个人 Space.id）
        memberships = SpaceMembership.objects.filter(
            user_id=self.user.id,
            workspace_id=space_id,
            is_active=True,
        )
        best = self._highest_sufficient_membership(memberships, required_role)
        if best:
            return best

        # 团队宿主：ProjectMembership（禁止用 Project id 查 SpaceMembership.workspace）
        project_memberships = ProjectMembership.objects.filter(
            user_id=self.user.id,
            project_id=space_id,
            is_active=True,
            status=ProjectMembership.Status.ACTIVE,
        )
        return self._highest_sufficient_membership(project_memberships, required_role)

    def _get_space_membership(
        self,
        space_id: UUID,
        agent_id: UUID,
        required_role: str = 'editor',
    ) -> Optional[SpaceMembership]:
        membership = SpaceMembership.objects.filter(
            workspace_id=space_id,
            agent_id=agent_id,
            is_active=True,
        ).first()
        if not membership:
            return None
        if ROLE_LEVELS.get(membership.role, 0) < ROLE_LEVELS.get(required_role, 0):
            return None
        return membership

    def _can_manage_target_role(self, manager_role: str, target_role: str) -> bool:
        return target_role in self.MANAGEABLE_ROLES_BY_ROLE.get(manager_role, set())

    @staticmethod
    def _user_is_organization_member(organization: Organization, user_id: str) -> bool:
        return (
            str(organization.owner_id) == str(user_id)
            or OrganizationMember.objects.filter(
                organization_id=organization.id,
                user_id=user_id,
            ).exists()
        )

    @staticmethod
    def _membership_user_id(membership: SpaceMembership) -> Optional[str]:
        if membership.user_id:
            return str(membership.user_id)
        agent = getattr(membership, 'agent', None)
        if agent and agent.owner_user_id:
            return str(agent.owner_user_id)
        if membership.agent_id:
            user_id = (
                Agent.objects.filter(id=membership.agent_id)
                .values_list('owner_user_id', flat=True)
                .first()
            )
            return str(user_id) if user_id else None
        return None

    @staticmethod
    def _notify_space_permission_changed(
        *,
        user_id: Optional[str],
        organization_id: UUID,
        space_id: UUID,
    ) -> None:
        if not user_id:
            return
        changed_uid = str(user_id)
        changed_wt = str(organization_id)
        changed_sp = str(space_id)

        def _notify():
            BaseService.broadcast_permission_changed(
                changed_uid, changed_wt, space_id=changed_sp,
            )

        transaction.on_commit(_notify, using=postgres_app_db_alias())

    def _notify_team_space_member_added(self, space: Space, member_user) -> None:
        """邀请制 Team Space 直接添加成员后，给被添加者发用户级通知。"""
        if not member_user:
            return

        actor_name = resolve_user_display_name(self.user) or '有人'
        space_name = space.name or '团队 Space'
        organization_name = getattr(space.organization, 'name', '') or '组织'
        member_user_id = str(member_user.id)
        organization_id = str(space.organization_id)
        space_id = str(space.id)

        def _notify():
            try:
                from apps.services.notification.services.notification_service import NotificationService

                NotificationService.notify(
                    user_id=member_user_id,
                    type='team_space.member_added',
                    title=f'你已加入团队 Space「{space_name}」',
                    body=f'{actor_name} 将你添加到「{space_name}」，现在可以在「{organization_name}」中访问该项目房间。',
                    organization_id=organization_id,
                    metadata={
                        'action': 'member_added',
                        'space_id': space_id,
                        'space_name': space_name,
                        'organization_name': organization_name,
                        'actor_user_id': str(getattr(self.user, 'id', '') or ''),
                    },
                )
            except Exception:
                logger.warning(
                    "[TeamSpaceInvite] 通知发送失败: space=%s user=%s",
                    space_id, member_user_id, exc_info=True,
                )

        transaction.on_commit(_notify, using=postgres_app_db_alias())

    def _record_member_activity(
        self,
        space: Space,
        event_type: str,
        member_user,
        *,
        metadata: Optional[Dict] = None,
    ) -> None:
        """团队 Space 成员变更留痕（提交后 best-effort 写动态流）。

        放 on_commit：业务成功才留痕；留痕失败不回滚成员变更。
        """
        actor_user = self.user
        target_name = resolve_user_display_name(member_user)
        target_id = str(getattr(member_user, 'id', '') or '')
        event_metadata = dict(metadata or {})

        def _record():
            record_team_space_activity(
                space,
                event_type,
                actor_user=actor_user,
                target_type='member',
                target_id=target_id,
                target_name=target_name,
                metadata=event_metadata,
            )

        transaction.on_commit(_record, using=postgres_app_db_alias())

    def _assert_can_manage_team_space(self, manager_role: str) -> None:
        if manager_role != 'owner':
            raise ServiceError('PERMISSION_DENIED', '只有团队 Space 所有者可以管理成员', 403)

    def list_space_memberships(self, space_id: UUID) -> QuerySet:
        if Workspace.objects.filter(id=space_id).exists():
            if not self._get_current_host_role(space_id, 'viewer'):
                return SpaceMembership.objects.none()
            return SpaceMembership.objects.filter(
                workspace_id=space_id,
                is_active=True,
            ).select_related('agent', 'user').order_by('-joined_at')

        if Project.objects.filter(id=space_id).exists():
            # 团队宿主返回 ProjectMembership；HTTP 层经 SpaceMembershipOut
            # 的 host 强制（space_id / project_id）序列化。
            if not self._get_current_host_role(space_id, 'viewer'):
                return ProjectMembership.objects.none()
            return ProjectMembership.objects.filter(
                project_id=space_id,
                is_active=True,
                status=ProjectMembership.Status.ACTIVE,
            ).select_related('user').order_by('-joined_at')

        return SpaceMembership.objects.none()

    @transaction.atomic(using=postgres_app_db_alias())
    def add_space_membership(
        self,
        space_id: UUID,
        agent_id: Optional[UUID] = None,
        role: str = 'viewer',
        user_id: Optional[str] = None,
    ) -> HostMembership:
        if role not in ASSIGNABLE_ROLES:
            raise ServiceError('INVALID_ROLE', f'角色 {role} 不合法，可选: {", ".join(sorted(ASSIGNABLE_ROLES))}')
        if not agent_id and not user_id:
            raise ServiceError('IDENTITY_REQUIRED', '必须指定要加入 Space 的成员', 400)
        if agent_id and user_id:
            raise ServiceError('IDENTITY_CONFLICT', 'agent_id 与 user_id 只能二选一', 400)

        space = Workspace.objects.select_related('organization').filter(id=space_id).first()
        is_team = False
        if space is None:
            space = Project.objects.select_related('organization').filter(id=space_id).first()
            is_team = space is not None
        if space is None:
            raise ServiceError('SPACE_NOT_FOUND', 'Agent 空间不存在', 404)
        if not is_team and is_bot_agent_space(space):
            raise ServiceError('AGENT_PRIVATE_NOT_SHAREABLE', 'Agent 是用户私有资源，不能添加组织成员', 403)

        manager_role = self._get_current_host_role(space_id, 'editor')
        if not manager_role:
            raise ServiceError('PERMISSION_DENIED', '需要编辑者及以上权限', 403)

        # Project 不承载 Agent 成员行（ProjectMembership 仅 user）；勿写 SpaceMembership→project_id。
        if is_team and agent_id is not None:
            raise ServiceError(
                'PROJECT_AGENT_JOIN_DEFERRED',
                'MVP 暂不支持将 Agent 直接加入 Project；Agent 参与通过 Task selected_agent 表达',
                409,
            )

        if is_team:
            self._assert_can_manage_team_space(manager_role)
        if not self._can_manage_target_role(manager_role, role):
            raise ServiceError('ROLE_ESCALATION', '不能分配高于或等于自己级别的角色', 403)

        if is_team and user_id:
            User = get_user_model()
            target_user = User.objects.filter(id=user_id).first()
            if not target_user or not self._user_is_organization_member(space.organization, str(target_user.id)):
                raise ServiceError('ORGANIZATION_MEMBER_REQUIRED', '只能邀请当前 Organization 成员加入团队 Space', 403)

            membership = ProjectMembership.objects.filter(
                project_id=space_id,
                user_id=target_user.id,
            ).first()

            if membership:
                if membership.role == 'owner':
                    return membership
                if not self._can_manage_target_role(manager_role, membership.role):
                    raise ServiceError('PERMISSION_DENIED', '无权管理该成员', 403)

                old_role = membership.role
                was_inactive = (
                    not membership.is_active
                    or membership.status != ProjectMembership.Status.ACTIVE
                )
                membership.role = role
                membership.is_active = True
                membership.status = ProjectMembership.Status.ACTIVE
                membership.save(update_fields=['role', 'is_active', 'status', 'updated_at'])
                if old_role != role or was_inactive:
                    self._notify_space_permission_changed(
                        user_id=str(target_user.id),
                        organization_id=space.organization_id,
                        space_id=space_id,
                    )
                if was_inactive:
                    self._record_member_activity(
                        space, SpaceActivityEvent.EventType.MEMBER_JOINED, target_user,
                        metadata={'role': role},
                    )
                    self._notify_team_space_member_added(space, target_user)
                    from apps.tabchat.services.conversation_service import ConversationService
                    ConversationService.ensure_team_space_channels_memberships(
                        space, str(self.user.id),
                    )
                elif old_role != role:
                    self._record_member_activity(
                        space, SpaceActivityEvent.EventType.MEMBER_ROLE_CHANGED, target_user,
                        metadata={'old_role': old_role, 'new_role': role},
                    )
                sync_space_visibility_from_memberships(space_id)
                return membership

            membership = ProjectMembership.objects.create(
                project_id=space_id,
                user_id=target_user.id,
                role=role,
                is_active=True,
                status=ProjectMembership.Status.ACTIVE,
            )
            self._notify_space_permission_changed(
                user_id=str(target_user.id),
                organization_id=space.organization_id,
                space_id=space_id,
            )
            self._record_member_activity(
                space, SpaceActivityEvent.EventType.MEMBER_JOINED, target_user,
                metadata={'role': role},
            )
            self._notify_team_space_member_added(space, target_user)
            from apps.tabchat.services.conversation_service import ConversationService
            ConversationService.ensure_team_space_channels_memberships(
                space, str(self.user.id),
            )
            sync_space_visibility_from_memberships(space_id)
            return membership

        target_agent = Agent.objects.filter(
            id=agent_id,
            organization_id=space.organization_id,
            is_active=True,
        ).first()
        if not target_agent:
            raise ServiceError('AGENT_NOT_FOUND', '目标 Agent 不存在或不活跃', 404)
        if target_agent.type == 'bot' and not self.check_agent_owner(target_agent):
            raise ServiceError('PRIVATE_AGENT_FORBIDDEN', '不能将其他用户的私有 Bot Agent 加入 Space', 403)

        membership = SpaceMembership.objects.filter(
            workspace_id=space_id,
            agent_id=target_agent.id,
        ).first()

        if membership:
            if membership.role == 'owner':
                if manager_role != 'owner':
                    raise ServiceError('PERMISSION_DENIED', '无权操作所有者成员', 403)
                return membership

            if not self._can_manage_target_role(manager_role, membership.role):
                raise ServiceError('PERMISSION_DENIED', '无权管理该成员', 403)

            old_role = membership.role
            was_inactive = not membership.is_active
            membership.role = role
            membership.is_active = True
            membership.save(update_fields=['role', 'is_active', 'updated_at'])

            if (old_role != role or was_inactive) and target_agent.owner_user_id:
                self._notify_space_permission_changed(
                    user_id=str(target_agent.owner_user_id),
                    organization_id=space.organization_id,
                    space_id=space_id,
                )

            sync_space_visibility_from_memberships(space_id)
            return membership

        membership = SpaceMembership.objects.create(
            workspace_id=space_id,
            agent_id=target_agent.id,
            role=role,
            is_active=True,
        )
        if target_agent.owner_user_id:
            self._notify_space_permission_changed(
                user_id=str(target_agent.owner_user_id),
                organization_id=space.organization_id,
                space_id=space_id,
            )
        sync_space_visibility_from_memberships(space_id)
        return membership

    @transaction.atomic(using=postgres_app_db_alias())
    def remove_space_membership(self, space_id: UUID, membership_id: UUID) -> bool:
        space = Workspace.objects.filter(id=space_id).first()
        if space is None:
            space = Project.objects.filter(id=space_id).first()
        if space is None:
            raise ServiceError('SPACE_NOT_FOUND', 'Agent 空间不存在', 404)

        manager_role = self._get_current_host_role(space_id, 'editor')
        if not manager_role:
            raise ServiceError('PERMISSION_DENIED', '需要编辑者及以上权限', 403)
        if isinstance(space, Project):
            self._assert_can_manage_team_space(manager_role)
            raise ServiceError(
                'PROJECT_MEMBERSHIP_REMOVAL_DEFERRED',
                'MVP 暂不支持成员离开、移除成员或移出 Agent',
                409,
            )

        membership = SpaceMembership.objects.filter(
            id=membership_id,
            workspace_id=space_id,
            is_active=True,
        ).first()
        if not membership:
            raise ServiceError('MEMBERSHIP_NOT_FOUND', '成员记录不存在', 404)

        if membership.user_id == getattr(self.user, 'id', None):
            raise ServiceError('CANNOT_REMOVE_SELF', '不能移除自己', 400)

        if membership.role == 'owner':
            if manager_role != 'owner':
                raise ServiceError('PERMISSION_DENIED', '无权移除所有者', 403)
            owner_count = SpaceMembership.objects.filter(
                workspace_id=space_id,
                role='owner',
                is_active=True,
            ).count()
            if owner_count <= 1:
                raise ServiceError('LAST_OWNER', '不能移除唯一的所有者', 400)
        elif not self._can_manage_target_role(manager_role, membership.role):
            raise ServiceError('PERMISSION_DENIED', '无权管理该成员', 403)

        removed_user_id = self._membership_user_id(membership)
        membership.is_active = False
        membership.save(update_fields=['is_active', 'updated_at'])
        self._notify_space_permission_changed(
            user_id=removed_user_id,
            organization_id=space.organization_id,
            space_id=space_id,
        )
        sync_space_visibility_from_memberships(space_id)
        return True

    def list_organization_agents(self, organization_id: UUID) -> QuerySet:
        if not self.check_organization_permission(str(organization_id), 'viewer'):
            return Agent.objects.none()
        return (
            Agent.objects
            .filter(
                self.owned_agent_filter(),
                organization_id=organization_id,
                is_active=True,
            )
            .select_related('owner_user', 'organization')
            .order_by('created_at')
        )
