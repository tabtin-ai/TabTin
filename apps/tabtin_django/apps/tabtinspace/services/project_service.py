"""Project 领域服务（ 终态：团队协作层从 Space 壳退役，真表宿主 :class:`Project`）。

分层模型（正典见 principle/workspace-project.md）：Project 是团队协作场景，物理上就是
一行 :class:`Project`（真表 ``tabtinspace_project``）。会话 / 频道 / 资产 / 动态 / Task 都挂
在它上面；成员通过 :class:`ProjectMembership` 加入。

创建 Project 时同时给创建者供给 Workspace；执行落到成员各自的 Workspace
（见 ``project_execution.py``）。
"""
from __future__ import annotations

import logging
from typing import Optional
from uuid import UUID

from django.db import transaction

from apps.services.common.db_router import postgres_app_db_alias
from apps.tabtinspace.models import (
    Project,
    ProjectMembership,
    ProjectMemberWorkspace,
    Workspace,
)
from apps.tabtinspace.services.base import BaseService, ServiceError

logger = logging.getLogger(__name__)


class ProjectService(BaseService):
    """Project 真表读取 + 成员/Agent 治理入口。"""

    # ── 权限 ──

    def _is_active_member(self, *, project: Project, user) -> bool:
        if not user:
            return False
        if project.organization.owner_id == user.id:
            return True
        return ProjectMembership.objects.filter(
            project=project,
            user_id=user.id,
            is_active=True,
            status=ProjectMembership.Status.ACTIVE,
        ).exists()

    def _can_manage(self, *, project_id: UUID, required_role: str = 'editor') -> bool:
        if not self.user:
            return False
        # Owner 隐式管理权
        project = Project.objects.filter(id=project_id).select_related('organization').first()
        if not project:
            return False
        if project.organization.owner_id == self.user.id:
            return True
        from apps.services.common.constants import ROLE_LEVELS
        membership = ProjectMembership.objects.filter(
            project_id=project_id,
            user_id=self.user.id,
            is_active=True,
            status=ProjectMembership.Status.ACTIVE,
        ).first()
        if not membership:
            return False
        return ROLE_LEVELS.get(membership.role, 0) >= ROLE_LEVELS.get(required_role, 0)

    # ── 序列化 ──

    def _serialize_project_workspace(
        self, workspace: Workspace, *, project: Optional[Project] = None,
    ) -> dict:
        link = None
        if project is not None:
            link = ProjectMemberWorkspace.objects.filter(
                project=project, workspace=workspace, user=self.user,
            ).first()
        project_id = getattr(project, 'id', None) if link is not None else None
        provisioning_source = getattr(
            workspace,
            'provisioning_source',
            Workspace.ProvisioningSource.USER,
        ) or Workspace.ProvisioningSource.USER
        return {
            'id': str(workspace.id),
            'organization_id': str(workspace.organization_id),
            'project_id': str(project_id) if project_id else None,
            'type': 'workspace',
            'name': workspace.name,
            'working_dir': workspace.working_dir,
            'normalized_working_dir': workspace.normalized_working_dir,
            'working_dir_type': workspace.working_dir_type,
            'agent_id': None,
            'execution_agent_id': None,
            'control_device_id': str(workspace.device_id),
            'bound_device_id': str(workspace.device_id),
            'control_device_status': workspace.device.status,
            'is_archived': False,
            # ：导航隐藏看供给来源，不看当前是否挂着 Project 关联。
            'provisioning_source': provisioning_source,
            'is_companion': provisioning_source in Workspace.SYSTEM_PROVISIONING_SOURCES,
        }

    # ── 读取 ──

    def list_projects(self, *, organization_id: UUID, page: int = 1, page_size: int = 100):
        if not self.user:
            return [], 0

        qs = Project.objects.filter(
            organization_id=organization_id,
            is_archived=False,
            trashed_at__isnull=True,
        )
        if not self.check_organization_permission(str(organization_id), 'owner'):
            member_project_ids = ProjectMembership.objects.filter(
                user=self.user,
                is_active=True,
                status=ProjectMembership.Status.ACTIVE,
                project__organization_id=organization_id,
            ).values_list('project_id', flat=True)
            qs = qs.filter(id__in=list(member_project_ids))

        total = qs.count()
        page = max(1, page)
        page_size = min(max(1, page_size), 200)
        start = (page - 1) * page_size
        items = list(qs.order_by('-last_activity_at', '-created_at')[start:start + page_size])
        return items, total

    def get_project(self, project_id: UUID) -> Optional[Project]:
        project = Project.objects.select_related('organization').filter(
            id=project_id, trashed_at__isnull=True,
        ).first()
        if not project:
            return None
        if not self._is_active_member(project=project, user=self.user):
            return None
        return project

    def member_count(self, project: Project) -> int:
        return ProjectMembership.objects.filter(
            project=project, is_active=True, status=ProjectMembership.Status.ACTIVE,
        ).count()

    def primary_agent_id(self, project: Project) -> Optional[UUID]:
        #  终态：Project 的主要 Agent 由 ProjectTask.selected_agent 语义承接，
        # 无独立 "primary agent" 概念，返回 None（后续可从最近 Task 推导）。
        _ = project
        return None

    # ── 写入 ──

    @transaction.atomic(using=postgres_app_db_alias())
    def set_primary_agent(self, *, project_id: UUID, agent_id: Optional[UUID]) -> Optional[UUID]:
        """#3266 终态：primary Agent 概念被 Task-level selected_agent 取代；接口保留为兼容点。"""
        _ = agent_id
        project = Project.objects.filter(id=project_id, trashed_at__isnull=True).first()
        if not project:
            raise ServiceError('PROJECT_NOT_FOUND', 'Project 不存在', 404)
        if not self._can_manage(project_id=project_id, required_role='editor'):
            raise ServiceError('PERMISSION_DENIED', '没有权限设置主要负责 Agent', 403)
        return None

    def resolve_member_workspace(self, *, project: Project, user) -> Optional[Workspace]:
        """成员在此 Project 的执行 Workspace（成员自己的现场）。"""
        from apps.tabtinspace.services.project_execution import resolve_project_execution_workspace
        return resolve_project_execution_workspace(project=project, user=user)

    @transaction.atomic(using=postgres_app_db_alias())
    def create_project_with_my_workspace(
        self,
        *,
        organization_id: UUID,
        name: str,
        description: str = '',
        device_id: UUID,
        working_dir: str,
        working_dir_type: str = '',
    ) -> tuple[Project, dict]:
        """一次性创建 Project 并供给创建者在该 Project 下的 Workspace。"""
        if not self.user:
            raise ServiceError('AUTH_REQUIRED', '需要登录', 401)
        if not (name or '').strip():
            raise ServiceError('PROJECT_NAME_REQUIRED', 'Project 名称不能为空', 400)
        if not device_id:
            raise ServiceError('DEVICE_REQUIRED', '创建 Project 需要执行设备', 400)
        if not (working_dir or '').strip():
            raise ServiceError('WORKING_DIR_REQUIRED', '创建 Project 需要本地目录', 400)
        if not self.check_organization_permission(str(organization_id), 'editor'):
            raise ServiceError('PERMISSION_DENIED', '无权在此组织创建 Project', 403)

        from apps.tabtinspace.models import Organization, SpaceActivityEvent
        from apps.tabtinspace.services.project_execution import ensure_project_workspace
        from apps.services.oss.services.public_assets import normalize_public_asset_ref
        from apps.tabtinspace.services.space_activity_service import record_team_space_activity

        try:
            organization = Organization.objects.get(id=organization_id)
        except Organization.DoesNotExist:
            raise ServiceError('ORGANIZATION_NOT_FOUND', '组织不存在', 404)
        self.assert_team_organization(organization)

        project = Project.objects.create(
            organization=organization,
            name=name.strip(),
            description=(description or '').strip(),
            avatar=normalize_public_asset_ref(''),
            status=Project.Status.ACTIVE,
            visibility=Project.Visibility.PRIVATE,
        )
        ProjectMembership.objects.create(
            project=project, user=self.user, role='owner',
            status=ProjectMembership.Status.ACTIVE, is_active=True,
        )

        workspace = ensure_project_workspace(
            project=project,
            user=self.user,
            device_id=device_id,
            working_dir=working_dir,
            working_dir_type=working_dir_type,
        )
        transaction.on_commit(
            lambda: record_team_space_activity(
                project,
                SpaceActivityEvent.EventType.SPACE_CREATED,
                actor_user=self.user,
                target_type='project',
                target_id=str(project.id),
                target_name=project.name,
            ),
            using=postgres_app_db_alias(),
        )
        return project, self._serialize_project_workspace(workspace, project=project)

    @transaction.atomic(using=postgres_app_db_alias())
    def ensure_my_workspace(
        self,
        *,
        project_id: UUID,
        device_id: UUID,
        working_dir: str,
        working_dir_type: str = '',
    ) -> dict:
        """幂等供给「当前用户在此 Project 的伴生 Workspace」。"""
        if not self.user:
            raise ServiceError('AUTH_REQUIRED', '需要登录', 401)
        if not device_id:
            raise ServiceError('DEVICE_REQUIRED', '供给伴生 Workspace 需要执行设备', 400)
        if not (working_dir or '').strip():
            raise ServiceError('WORKING_DIR_REQUIRED', '供给伴生 Workspace 需要本地目录', 400)

        project = Project.objects.select_for_update().select_related('organization').filter(
            id=project_id, trashed_at__isnull=True,
        ).first()
        if not project:
            raise ServiceError('PROJECT_NOT_FOUND', 'Project 不存在', 404)
        if not self._is_active_member(project=project, user=self.user):
            raise ServiceError('PERMISSION_DENIED', '只有 Project 成员可以供给执行 Workspace', 403)

        from apps.tabtinspace.services.project_execution import ensure_project_workspace
        workspace = ensure_project_workspace(
            project=project,
            user=self.user,
            device_id=device_id,
            working_dir=working_dir,
            working_dir_type=working_dir_type,
        )
        return self._serialize_project_workspace(workspace, project=project)

    def serialize_my_workspace(self, *, project: Project, user) -> Optional[dict]:
        workspace = self.resolve_member_workspace(project=project, user=user)
        if workspace is None or not ProjectMemberWorkspace.objects.filter(
            project=project, user=user, workspace=workspace,
        ).exists():
            return None
        return self._serialize_project_workspace(workspace, project=project)

    # BaseService.check_space_permission 仍面向 Space 语义；Project 权限见 _can_manage。
    def check_space_permission(self, space_id: str, required_role: str = 'viewer') -> bool:
        """兼容旧调用：等价于 Project 成员权限校验。"""
        try:
            return self._can_manage(project_id=UUID(str(space_id)), required_role=required_role)
        except (TypeError, ValueError):
            return False


__all__ = ['ProjectService']
