"""Project 邀请-接受服务（ 终态：ProjectMembership 直挂 :class:`Project`）。

分层模型（正典见 principle/workspace-project.md）：Project 是团队协作房间，成员必须先是
所属 Organization 成员；被邀请者要在自己的 Electron 上**显式接受**，接受动作在同一事务
里「激活 Project 成员关系 + 当场供给该成员的伴生 Workspace」，不存在「接受了但没
Workspace」的中间态。

生命周期用 :class:`ProjectMembership` 的 ``status`` 表达：``pending`` → ``active``。
pending 成员天然被既有 ``is_active=True`` 查询排除，不会误当作生效成员。
"""
from __future__ import annotations

import logging
from typing import Any, Dict, List
from uuid import UUID

from django.contrib.auth import get_user_model
from django.db import IntegrityError, transaction
from django.utils import timezone

from apps.services.common.constants import ROLE_LEVELS
from apps.services.common.db_router import postgres_app_db_alias
from apps.tabtinspace.models import (
    Organization,
    OrganizationMember,
    Project,
    ProjectMembership,
    SpaceActivityEvent,
)
from apps.tabtinspace.services.base import (
    ASSIGNABLE_ROLES,
    BaseService,
    ServiceError,
)
from apps.tabtinspace.services.space_activity_service import (
    record_team_space_activity,
    resolve_user_display_name,
)

logger = logging.getLogger(__name__)

User = get_user_model()

NOTIFY_INVITATION = 'space.invitation'
NOTIFY_INVITATION_RESPONDED = 'space.invitation.responded'
NOTIFY_INVITATION_CANCELLED = 'space.invitation.cancelled'

MANAGEABLE_ROLES_BY_ROLE: Dict[str, set] = {
    'owner': {'admin', 'editor', 'viewer'},
    'admin': {'editor', 'viewer'},
    'editor': {'viewer'},
    'viewer': set(),
}


class ProjectInvitationService(BaseService):
    """Project 级邀请-接受（直挂 :class:`ProjectMembership`）。"""

    def _load_project(self, project_id: UUID, *, for_update: bool = False) -> Project:
        qs = Project.objects.select_related('organization')
        if for_update:
            qs = qs.select_for_update(of=('self',))
        try:
            project = qs.get(id=project_id, trashed_at__isnull=True)
        except Project.DoesNotExist:
            raise ServiceError('PROJECT_NOT_FOUND', 'Project 不存在', 404)
        return project

    def _current_manager_membership(self, project: Project) -> ProjectMembership | None:
        if not self.user:
            return None
        return ProjectMembership.objects.filter(
            project=project,
            user_id=self.user.id,
            is_active=True,
            status=ProjectMembership.Status.ACTIVE,
        ).first()

    @staticmethod
    def _is_organization_member(organization: Organization, user_id: str) -> bool:
        return (
            str(organization.owner_id) == str(user_id)
            or OrganizationMember.objects.filter(
                organization_id=organization.id, user_id=user_id,
            ).exists()
        )

    @staticmethod
    def _can_manage_target_role(manager_role: str, target_role: str) -> bool:
        return target_role in MANAGEABLE_ROLES_BY_ROLE.get(manager_role, set())

    @transaction.atomic(using=postgres_app_db_alias())
    def invite_member(
        self, *, project_id: UUID, target_user_id: str, role: str = 'editor',
    ) -> ProjectMembership:
        """Owner 邀请一个 Organization 成员加入本 Project（建 pending 成员 + 发通知）。"""
        if role not in ASSIGNABLE_ROLES or role == 'owner':
            raise ServiceError('INVALID_ROLE', f'角色 {role} 不合法', 400)

        project = self._load_project(project_id)
        manager = self._current_manager_membership(project)
        is_org_owner = project.organization.owner_id == getattr(self.user, 'id', None)
        if not manager and not is_org_owner:
            raise ServiceError('PERMISSION_DENIED', '需要项目成员权限', 403)
        manager_role = manager.role if manager else 'owner'
        if manager_role != 'owner':
            raise ServiceError('PERMISSION_DENIED', '只有项目所有者可以邀请成员', 403)
        if not self._can_manage_target_role(manager_role, role):
            raise ServiceError('ROLE_ESCALATION', '不能分配高于或等于自己级别的角色', 403)

        target_user = User.objects.filter(id=target_user_id).first()
        if not target_user:
            raise ServiceError('USER_NOT_FOUND', '目标用户不存在', 404)
        if not self._is_organization_member(project.organization, str(target_user.id)):
            raise ServiceError(
                'ORGANIZATION_MEMBER_REQUIRED',
                '只能邀请当前 Organization 成员加入 Project', 403,
            )

        existing = ProjectMembership.objects.filter(project=project, user_id=target_user.id).first()
        if existing:
            if existing.status == ProjectMembership.Status.ACTIVE and existing.is_active:
                raise ServiceError('ALREADY_MEMBER', '该用户已是 Project 成员', 409)
            existing.role = role
            existing.status = ProjectMembership.Status.PENDING
            existing.is_active = False
            existing.invited_by = getattr(self.user, 'id', None)
            existing.save(update_fields=['role', 'status', 'is_active', 'invited_by', 'updated_at'])
            membership = existing
        else:
            try:
                membership = ProjectMembership.objects.create(
                    project=project,
                    user_id=target_user.id,
                    role=role,
                    status=ProjectMembership.Status.PENDING,
                    is_active=False,
                    invited_by=getattr(self.user, 'id', None),
                )
            except IntegrityError:
                raise ServiceError('ALREADY_MEMBER', '该用户已是 Project 成员', 409)

        self._notify_project_invitation(project, target_user)
        return membership

    def list_project_pending_invitations(self, *, project_id: UUID) -> List[Dict[str, Any]]:
        """Owner / 生效成员查看本 Project 尚未接受的邀请。"""
        if not self.user:
            raise ServiceError('AUTH_REQUIRED', '需要登录', 401)

        project = self._load_project(project_id)
        manager = self._current_manager_membership(project)
        is_org_owner = project.organization.owner_id == getattr(self.user, 'id', None)
        if not manager and not is_org_owner:
            raise ServiceError('PERMISSION_DENIED', '需要项目成员权限', 403)

        memberships = list(
            ProjectMembership.objects.filter(
                project=project,
                status=ProjectMembership.Status.PENDING,
            ).select_related('user').order_by('-updated_at')
        )
        if not memberships:
            return []

        return [
            {
                'membership_id': str(m.id),
                'user_id': str(m.user_id),
                'user_name': resolve_user_display_name(m.user) or str(m.user_id)[:8],
                'role': m.role,
                'invited_at': m.updated_at.isoformat(),
                'invited_by': str(m.invited_by) if m.invited_by else None,
            }
            for m in memberships
        ]

    def list_my_pending_invitations(self) -> List[Dict[str, Any]]:
        if not self.user:
            raise ServiceError('AUTH_REQUIRED', '需要登录', 401)

        memberships = list(
            ProjectMembership.objects.filter(
                user_id=self.user.id,
                status=ProjectMembership.Status.PENDING,
                project__trashed_at__isnull=True,
            ).select_related('project', 'project__organization').order_by('-updated_at')
        )
        if not memberships:
            return []

        inviter_ids = list({m.invited_by for m in memberships if m.invited_by})
        inviter_map: Dict[str, str] = {}
        if inviter_ids:
            for u in User.objects.filter(id__in=inviter_ids).only('id', 'nickname', 'username'):
                inviter_map[str(u.id)] = u.nickname or u.username or str(u.id)[:8]

        return [
            {
                'membership': m,
                'project': m.project,
                'inviter_name': inviter_map.get(str(m.invited_by), ''),
            }
            for m in memberships
        ]

    @transaction.atomic(using=postgres_app_db_alias())
    def accept(
        self, *,
        project_id: UUID,
        device_id: UUID,
        working_dir: str,
        working_dir_type: str = '',
    ) -> Dict[str, Any]:
        if not self.user:
            raise ServiceError('AUTH_REQUIRED', '需要登录', 401)
        if not device_id:
            raise ServiceError('DEVICE_REQUIRED', '接受邀请需要在 Electron 客户端上进行', 400)
        if not (working_dir or '').strip():
            raise ServiceError('WORKING_DIR_REQUIRED', '接受邀请需要为伴生 Workspace 指定本地目录', 400)

        project = self._load_project(project_id, for_update=True)

        membership = (
            ProjectMembership.objects
            .select_for_update()
            .filter(project=project, user_id=self.user.id)
            .first()
        )
        if not membership or membership.status != ProjectMembership.Status.PENDING:
            raise ServiceError('INVITATION_NOT_FOUND', '没有待接受的 Project 邀请', 404)

        membership.status = ProjectMembership.Status.ACTIVE
        membership.is_active = True
        membership.save(update_fields=['status', 'is_active', 'updated_at'])

        from apps.tabtinspace.services.project_execution import ensure_project_workspace
        workspace = ensure_project_workspace(
            project=project,
            user=self.user,
            device_id=device_id,
            working_dir=working_dir,
            working_dir_type=working_dir_type,
        )

        transaction.on_commit(
            lambda: record_team_space_activity(
                project, SpaceActivityEvent.EventType.MEMBER_JOINED,
                actor_user=self.user,
                target_type='member',
                target_id=str(self.user.id),
                target_name=resolve_user_display_name(self.user),
                metadata={'role': membership.role, 'via': 'invitation_accept'},
            ),
            using=postgres_app_db_alias(),
        )
        self._notify_invitation_responded(project, membership, accepted=True)

        return {
            'project_id': str(project.id),
            'project_name': project.name,
            'role': membership.role,
            'workspace': {
                'id': str(workspace.id),
                'name': workspace.name,
                'working_dir': workspace.working_dir,
            },
        }

    @transaction.atomic(using=postgres_app_db_alias())
    def reject(self, *, project_id: UUID) -> bool:
        if not self.user:
            raise ServiceError('AUTH_REQUIRED', '需要登录', 401)

        project = self._load_project(project_id)
        membership = (
            ProjectMembership.objects
            .select_for_update()
            .filter(
                project=project,
                user_id=self.user.id,
                status=ProjectMembership.Status.PENDING,
            )
            .first()
        )
        if not membership:
            raise ServiceError('INVITATION_NOT_FOUND', '没有待接受的 Project 邀请', 404)

        self._notify_invitation_responded(project, membership, accepted=False)
        membership.delete()
        return True

    # ── 通知辅助 ──

    def _notify_project_invitation(self, project: Project, target_user) -> None:
        inviter_name = resolve_user_display_name(self.user) or '有人'
        project_name = project.name or '协作项目'
        organization_name = getattr(project.organization, 'name', '') or '组织'
        target_user_id = str(target_user.id)
        organization_id = str(project.organization_id)
        project_id = str(project.id)
        inviter_id = str(getattr(self.user, 'id', '') or '')

        def _notify():
            try:
                from apps.services.notification.services.notification_service import NotificationService
                NotificationService.notify(
                    user_id=target_user_id,
                    type=NOTIFY_INVITATION,
                    title=f'邀请加入项目「{project_name}」',
                    body=f'{inviter_name} 邀请你加入「{organization_name}」下的项目「{project_name}」，'
                         f'在你的设备上接受后将为你创建专属执行 Workspace。',
                    metadata={
                        'project_id': project_id,
                        'project_name': project_name,
                        'organization_name': organization_name,
                        'inviter_id': inviter_id,
                        'inviter_name': inviter_name,
                    },
                    organization_id=organization_id,
                )
            except Exception:
                logger.warning(
                    "[ProjectInvite] 邀请通知推送失败: project=%s user=%s",
                    project_id, target_user_id, exc_info=True,
                )

        transaction.on_commit(_notify, using=postgres_app_db_alias())

    def _notify_invitation_responded(
        self, project: Project, membership: ProjectMembership, *, accepted: bool,
    ) -> None:
        inviter_id = str(membership.invited_by) if membership.invited_by else ''
        if not inviter_id:
            return
        responder_name = resolve_user_display_name(self.user) or '有人'
        project_name = project.name or '协作项目'
        organization_id = str(project.organization_id)
        project_id = str(project.id)
        action = '接受' if accepted else '拒绝'

        def _notify():
            try:
                from apps.services.notification.services.notification_service import NotificationService
                NotificationService.notify(
                    user_id=inviter_id,
                    type=NOTIFY_INVITATION_RESPONDED,
                    title=f'{responder_name} {action}了项目邀请',
                    body=f'{responder_name} {action}了项目「{project_name}」的邀请',
                    metadata={
                        'project_id': project_id,
                        'project_name': project_name,
                        'accepted': accepted,
                    },
                    organization_id=organization_id,
                )
            except Exception:
                logger.warning(
                    "[ProjectInvite] 响应通知推送失败: project=%s inviter=%s",
                    project_id, inviter_id, exc_info=True,
                )

        transaction.on_commit(_notify, using=postgres_app_db_alias())


__all__ = ['ProjectInvitationService']
