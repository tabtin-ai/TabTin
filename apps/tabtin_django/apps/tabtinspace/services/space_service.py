"""
SpaceService - Space 服务
"""
import copy
import logging
from typing import List, Optional, Dict, Any, Tuple
from uuid import UUID
from django.conf import settings
from django.db import IntegrityError, transaction
from django.db.models import Count, Q, Sum
from django.utils import timezone

from apps.services.common.db_router import postgres_app_db_alias
from apps.services.oss.services.public_assets import normalize_public_asset_ref
from apps.tabtinspace.models import (
    Space,
    Workspace,
    Device,
    Organization,
    SpaceAppSettings,
    Agent,
    SpaceActivityEvent,
    SpaceMembership,
    Collection,
    ContextItem,
    SpacePermission,
    SpaceAdminActionLog,
    Project,
)
from apps.tabdata.models import Table
from apps.services.common.constants import VALID_SPACE_STATUSES
from apps.services.common.device_capability_registry import is_user_level_device
from .base import BaseService, ServiceError
from apps.tabtinspace.services.space_activity_service import record_team_space_activity
from apps.tabtinspace.services.space_sync import publish_space_list_change

_logger = logging.getLogger(__name__)


class SpaceService(BaseService):
    """Space 服务类"""

    @staticmethod
    def _raise_space_shell_retired(action: str = "该操作"):
        raise ServiceError(
            "SPACE_SHELL_RETIRED",
            f"{action}已随 Space 表退役；请改用 WorkspaceService / ProjectService",
            410,
        )

    def _record_space_activity_on_commit(
        self,
        space: Space,
        event_type: str,
        *,
        target_type: str = '',
        target_id: str = '',
        target_name: str = '',
        metadata: Optional[Dict[str, Any]] = None,
    ) -> None:
        """团队 Space 变更留痕（提交后 best-effort 写动态流，非 team_space 自动跳过）。"""
        actor_user = self.user
        event_metadata = dict(metadata or {})

        def _record():
            record_team_space_activity(
                space,
                event_type,
                actor_user=actor_user,
                target_type=target_type,
                target_id=target_id,
                target_name=target_name,
                metadata=event_metadata,
            )

        transaction.on_commit(_record, using=postgres_app_db_alias())

    @staticmethod
    def _canonical_working_dir(value: Optional[str]) -> str:
        """#3266：单实现落在 workspace_service.canonical_working_dir。"""
        from apps.tabtinspace.services.workspace_service import canonical_working_dir
        return canonical_working_dir(value)

    @staticmethod
    def _active_workspaces() -> Q:
        return Q(type=Space.SpaceType.WORKSPACE, is_archived=False, trashed_at__isnull=True)

    @classmethod
    def _execution_scope_filter(cls, space: Space) -> Q:
        return (
            Q(organization_id=space.organization_id)
            & cls._active_workspaces()
            & Q(control_device_id=space.control_device_id)
        )

    @classmethod
    def _assert_working_dir_available(
        cls,
        *,
        organization_id: UUID,
        created_by_id: UUID,
        device_id: UUID,
        normalized_working_dir: str,
        exclude_space_id: Optional[UUID] = None,
    ) -> None:
        if not normalized_working_dir:
            return
        existing = Workspace.objects.filter(
            organization_id=organization_id,
            created_by_id=created_by_id,
            device_id=device_id,
            normalized_working_dir=normalized_working_dir,
        )
        if exclude_space_id:
            existing = existing.exclude(id=exclude_space_id)
        if existing.exists():
            raise ServiceError(
                'WORKING_DIR_CONFLICT',
                '该工作目录已绑定到当前设备上的另一个 Workspace',
                409,
            )

    def _get_accessible_workspace_queryset(
        self,
        organization_id: Optional[UUID] = None,
    ):
        if not self.user:
            return Workspace.objects.none()

        from apps.tabtinspace.services.space_visibility import get_accessible_space_ids

        accessible_ids = get_accessible_space_ids(
            self.user,
            organization_id=organization_id,
        )
        if not accessible_ids:
            return Workspace.objects.none()

        queryset = Workspace.objects.filter(id__in=accessible_ids)
        if organization_id:
            queryset = queryset.filter(organization_id=organization_id)
        return queryset

    def list_spaces(
        self,
        organization_id: Optional[UUID] = None,
        device_id: Optional[UUID] = None,
        space_type: Optional[str] = None,
        status: Optional[str] = None,
        is_archived: Optional[bool] = None,
        page: int = 1,
        page_size: int = 100
    ) -> Tuple[List[Workspace], int]:
        """#3266：列表读 Workspace；team_space 类型改读 Project。"""
        effective_space_type = space_type or Space.SpaceType.WORKSPACE
        if effective_space_type not in (Space.SpaceType.WORKSPACE, Space.SpaceType.TEAM_SPACE):
            return [], 0
        if organization_id and not self.check_organization_permission(str(organization_id), 'viewer'):
            return [], 0

        if effective_space_type == Space.SpaceType.TEAM_SPACE:
            if not getattr(settings, 'TABTIN_ENABLE_PROJECTS', False):
                return [], 0
            from apps.tabtinspace.services.space_visibility import get_accessible_space_ids
            accessible_ids = get_accessible_space_ids(self.user, organization_id=organization_id)
            qs = Project.objects.filter(id__in=accessible_ids)
            if organization_id:
                qs = qs.filter(organization_id=organization_id)
            if is_archived is not None:
                qs = qs.filter(is_archived=is_archived)
            if status:
                qs = qs.filter(status=status)
            qs = qs.order_by('order', '-created_at', 'id')
            total = qs.count()
            offset = (page - 1) * page_size
            return list(qs[offset:offset + page_size]), total

        queryset = self._get_accessible_workspace_queryset(organization_id)
        if device_id:
            queryset = queryset.filter(device_id=device_id)
        if is_archived is True:
            return [], 0
        queryset = queryset.order_by('-created_at', 'id')
        total = queryset.count()
        offset = (page - 1) * page_size
        return list(queryset[offset:offset + page_size]), total

    def get_space(self, space_id: UUID) -> Optional[Workspace]:
        try:
            workspace = Workspace.objects.get(id=space_id)
            if not self.check_space_permission(str(workspace.id), 'viewer'):
                return None
            return workspace
        except Workspace.DoesNotExist:
            try:
                project = Project.objects.get(id=space_id)
            except Project.DoesNotExist:
                return None
            if not self.check_space_permission(str(project.id), 'viewer'):
                return None
            return project  # type: ignore[return-value]

    def get_space_app_settings(self, space_id: UUID) -> Optional[SpaceAppSettings]:
        if not self.user:
            return None
        space = self.get_space(space_id)
        if not space:
            return None
        settings_obj, _ = SpaceAppSettings.objects.get_or_create(
            workspace_id=space_id,
            user_id=self.user.id,
            defaults={"disabled_apps": []},
        )
        return settings_obj

    def update_space_app_settings(
        self,
        space_id: UUID,
        disabled_apps: List[str],
    ) -> Optional[SpaceAppSettings]:
        if not self.user:
            return None
        space = self.get_space(space_id)
        if not space:
            return None
        cleaned = []
        seen = set()
        for app_id in disabled_apps or []:
            if not isinstance(app_id, str):
                continue
            trimmed = app_id.strip()
            if not trimmed or trimmed in seen:
                continue
            seen.add(trimmed)
            cleaned.append(trimmed)
        settings_obj, _ = SpaceAppSettings.objects.get_or_create(
            workspace_id=space_id,
            user_id=self.user.id,
            defaults={"disabled_apps": cleaned},
        )
        if settings_obj.disabled_apps != cleaned:
            settings_obj.disabled_apps = cleaned
            settings_obj.save(update_fields=["disabled_apps", "updated_at"])
        return settings_obj

    def create_space(
        self,
        organization_id: UUID,
        name: str,
        description: Optional[str] = None,
        icon: Optional[str] = None,
        avatar: Optional[str] = None,
        color: Optional[str] = None,
        status: str = 'active',
        order: int = 0,
        agent_id: Optional[UUID] = None,
        space_type: str = Space.SpaceType.WORKSPACE,
        execution_space_id: Optional[UUID] = None,
        device_id: Optional[UUID] = None,
        working_dir: Optional[str] = None,
        working_dir_type: Optional[str] = None,
        custom_rules: Optional[str] = None,
        create_default_channels: bool = True,
    ) -> Space:
        """#3266 终态：Space 创建入口已退役。

        - team_space：走 ``ProjectService.create_project_with_my_workspace``。
        - workspace：走 ``WorkspaceService.create_workspace`` /
          ``ensure_home_workspace``；不再从服务层 Insert Space 壳。

        保留方法签名仅供旧调用点获取一致的 410 错误码，不再落任何库行。
        """
        if space_type == Space.SpaceType.TEAM_SPACE:
            raise ServiceError(
                'TEAM_SPACE_RETIRED',
                'team_space Space 已停产，团队协作请使用 ProjectService 创建 Project',
                410,
            )
        raise ServiceError(
            'SPACE_CREATE_RETIRED',
            (
                'SpaceService.create_space 已退役；'
                '个人执行现场请使用 WorkspaceService.create_workspace / ensure_home_workspace。'
            ),
            410,
        )

    # ``_create_team_space`` 已于  终态删除；团队协作走 ``ProjectService``
    # （创建 :class:`Project` 真表 + :class:`ProjectMembership`）。

    @transaction.atomic(using=postgres_app_db_alias())
    def ensure_execution_agent_for_space(
        self,
        space,
        *,
        custom_rules: Optional[str] = None,
    ) -> Optional[Agent]:
        """#6198：已退役——现场不再绑定 / 补建执行 Agent。

        保留方法签名以免旧调用方 AttributeError；恒返回 None。
        """
        _ = (space, custom_rules)
        _logger.warning(
            "ensure_execution_agent_for_space 已退役；请显式选择 Agent"
        )
        return None

    def bind_device(
        self,
        space_id: UUID,
        device_id: Optional[UUID],
        expected_version: Optional[int] = None,
        recover_offline_binding: bool = False,
    ) -> Optional[Space]:
        """兼容入口：通过 workspace 绑定执行设备到关联 Agent。"""
        return self.bind_agent_device(
            agent_id=space_id,
            device_id=device_id,
            expected_version=expected_version,
            recover_offline_binding=recover_offline_binding,
        )

    @staticmethod
    def _normalize_device_id_value(value: Any) -> Optional[str]:
        if value is None:
            return None
        if isinstance(value, UUID):
            return str(value)
        if isinstance(value, str):
            return value
        return None

    @classmethod
    def _existing_execution_device_id(cls, space: Space, agent: Optional[Agent]) -> Optional[str]:
        for value in (
            getattr(space, 'control_device_id', None),
            getattr(space, 'bound_device_id', None),
            getattr(agent, 'control_device_id', None) if agent is not None else None,
            getattr(agent, 'bound_device_id', None) if agent is not None else None,
        ):
            normalized = cls._normalize_device_id_value(value)
            if normalized:
                return normalized
        return None

    @transaction.atomic(using=postgres_app_db_alias())
    def bind_agent_device(
        self,
        agent_id: UUID,
        device_id: Optional[UUID],
        expected_version: Optional[int] = None,
        recover_offline_binding: bool = False,
    ) -> Optional[Space]:
        """绑定 bot Agent 的执行设备。

        已绑定时仅允许幂等提交。唯一例外是 Space owner 显式确认把离线历史
        绑定恢复到指定设备；该路径不允许接管仍在线的远程执行现场。
        """
        self._raise_space_shell_retired('bind_agent_device')

    @staticmethod
    def _invalidate_daemon_fp_cache(space_id: UUID) -> None:
        """设备绑定变更时清除关联 thread 的 daemon fingerprint + thread context 缓存。"""
        try:
            from apps.chat.conversation.models import ChatSession
            from apps.channel_gateway.models import ChannelBinding
            from apps.services.agent_engine.services.frontend_action_service import FrontendActionService
            from apps.services.agent_engine.services.device_dispatch_service import DeviceDispatchService
            session_thread_ids = [
                f"chat-session-{sid}"
                for sid in (
                    ChatSession.objects
                    .filter(workspace_id=space_id)
                    .values_list('id', flat=True)[:100]
                )
            ]
            channel_thread_ids = list(
                ChannelBinding.objects
                .filter(space_id=str(space_id))
                .exclude(thread_id__isnull=True)
                .exclude(thread_id="")
                .values_list('thread_id', flat=True)[:100]
            )
            for thread_id in dict.fromkeys([
                *session_thread_ids,
                *channel_thread_ids,
            ]):
                FrontendActionService.invalidate_daemon_fp_cache(thread_id)
                DeviceDispatchService.invalidate_thread_context_cache(thread_id)
        except Exception:
            pass

    @transaction.atomic(using=postgres_app_db_alias())
    def update_space(
        self,
        space_id: UUID,
        name: Optional[str] = None,
        description: Optional[str] = None,
        icon: Optional[str] = None,
        avatar: Optional[str] = None,
        color: Optional[str] = None,
        status: Optional[str] = None,
        order: Optional[int] = None,
        start_date: Optional[str] = None,
        end_date: Optional[str] = None,
        expected_version: Optional[int] = None,
    ) -> Optional[Space]:
        self._raise_space_shell_retired('update_space')

    @transaction.atomic(using=postgres_app_db_alias())
    def archive_space(self, space_id: UUID) -> bool:
        """归档 Project（Workspace 无归档语义）。"""
        from apps.tabtinspace.services.host_resolver import resolve_host

        host = resolve_host(space_id)
        if host is None:
            return False
        if not isinstance(host, Project):
            raise ServiceError(
                'WORKSPACE_NO_ARCHIVE',
                'Workspace 不支持归档；请改用删除 Workspace',
                400,
            )
        if not self.check_space_permission(str(host.id), 'editor'):
            return False
        if host.trashed_at is not None:
            return False
        host.is_archived = True
        if host.status != Project.Status.ARCHIVED:
            host.status = Project.Status.ARCHIVED
            host.save(update_fields=['is_archived', 'status', 'updated_at'])
        else:
            host.save(update_fields=['is_archived', 'updated_at'])
        return True

    @transaction.atomic(using=postgres_app_db_alias())
    def restore_space(self, space_id: UUID) -> bool:
        """从归档恢复 Project（非回收站恢复）。"""
        from apps.tabtinspace.services.host_resolver import resolve_host

        host = resolve_host(space_id)
        if host is None:
            return False
        if not isinstance(host, Project):
            raise ServiceError(
                'WORKSPACE_NO_ARCHIVE',
                'Workspace 不支持归档恢复；请改用 Workspace API',
                400,
            )
        if not self.check_space_permission(str(host.id), 'editor'):
            return False
        if host.trashed_at is not None:
            return False
        host.is_archived = False
        if host.status == Project.Status.ARCHIVED:
            host.status = Project.Status.ACTIVE
            host.save(update_fields=['is_archived', 'status', 'updated_at'])
        else:
            host.save(update_fields=['is_archived', 'updated_at'])
        return True

    def _migrate_backend_config(self, agent_backend: Dict[str, Any]) -> None:
        """Three-phase config management: version check → migrate → cleanup."""
        config_version = agent_backend.get('config_version', 1)

        if config_version < self.CURRENT_BACKEND_CONFIG_VERSION:
            _logger.info(
                "Migrating agent_backend config from v%d to v%d",
                config_version, self.CURRENT_BACKEND_CONFIG_VERSION,
            )

        for field in self._DEPRECATED_BACKEND_FIELDS:
            if field in agent_backend:
                _logger.info("Removing deprecated backend field: %s", field)
                del agent_backend[field]

        # ACP cleanup: drop legacy acp_config sub-dict if present in stored data
        if 'acp_config' in agent_backend:
            del agent_backend['acp_config']

        agent_backend['config_version'] = self.CURRENT_BACKEND_CONFIG_VERSION

    @transaction.atomic(using=postgres_app_db_alias())
    def update_space_status(
        self,
        space_id: UUID,
        status: str
    ) -> Optional[Space]:
        self._raise_space_shell_retired('update_space_status')

    def _trash_space_core(self, space: Project) -> bool:
        """将 Project 移入回收站的核心逻辑（不做权限检查），并级联 trash 子资源。

        ：可回收站宿主仅为 Project；Workspace 无 trash 字段。
        """
        if space.trashed_at is not None:
            return False

        from django.utils import timezone

        trashed_at = timezone.now()
        trashed_by = self.user.id if self.user else None
        space.previous_status = space.status or "active"
        space.status = Project.Status.TRASHED
        space.trashed_at = trashed_at
        space.trashed_by = trashed_by
        space.is_archived = True
        space.save(update_fields=[
            "status", "trashed_at", "trashed_by", "previous_status",
            "is_archived", "updated_at",
        ])

        self._cascade_trash_child_resources(space.id, trashed_at, trashed_by)

        wt_id = str(space.organization_id)
        sp_id = str(space.id)
        transaction.on_commit(
            lambda: publish_space_list_change(wt_id, 'trashed', sp_id),
            using=postgres_app_db_alias(),
        )
        return True

    @transaction.atomic(using=postgres_app_db_alias())
    def trash_space(self, space_id: UUID) -> bool:
        """将 Project 移入回收站。

        ：可回收站宿主仅为 Project；Workspace 请走 DELETE /workspaces/{id}。
        """
        from apps.tabtinspace.services.host_resolver import resolve_host

        host = resolve_host(space_id)
        if host is None:
            return False
        if not isinstance(host, Project):
            raise ServiceError(
                'WORKSPACE_NO_TRASH',
                'Workspace 不支持回收站，请改用删除 Workspace（DELETE /workspaces/{id}）',
                400,
            )
        if not self.check_space_permission(str(host.id), 'editor'):
            return False
        return self._trash_space_core(host)

    @classmethod
    @transaction.atomic(using=postgres_app_db_alias())
    def admin_trash_space(cls, space_id: UUID, *, actor=None) -> bool:
        """Admin 代操作：跳过组织成员权限，将 Project 移入回收站。"""
        from apps.tabtinspace.services.host_resolver import resolve_host

        host = resolve_host(space_id)
        if host is None or not isinstance(host, Project):
            return False
        return cls(user=actor)._trash_space_core(host)

    def _restore_space_from_trash_core(self, space: Project) -> bool:
        """从回收站恢复 Project 的核心逻辑（不做权限检查）。"""
        if space.trashed_at is None:
            return False

        as_trashed_at = space.trashed_at
        space_id = space.id

        target_status = space.previous_status or Project.Status.ACTIVE
        space.status = target_status
        space.trashed_at = None
        space.trashed_by = None
        space.previous_status = ""
        space.is_archived = (target_status == Project.Status.ARCHIVED)
        space.save(update_fields=[
            "status", "trashed_at", "trashed_by", "previous_status",
            "is_archived", "updated_at",
        ])

        self._cascade_restore_child_resources(space_id, as_trashed_at)

        wt_id = str(space.organization_id)
        sp_id = str(space.id)
        transaction.on_commit(
            lambda: publish_space_list_change(wt_id, 'restored', sp_id),
            using=postgres_app_db_alias(),
        )
        return True

    @transaction.atomic(using=postgres_app_db_alias())
    def restore_space_from_trash(self, space_id: UUID) -> bool:
        """从回收站恢复 Project，并级联恢复随 Project 一起被删除的子资源。

        ：可回收站宿主仅为 Project；Workspace 无 trash 字段。
        """
        from apps.tabtinspace.services.host_resolver import resolve_host

        host = resolve_host(space_id)
        if host is None:
            return False
        if not isinstance(host, Project):
            raise ServiceError(
                'WORKSPACE_NO_TRASH',
                'Workspace 不支持回收站恢复，请改用 Workspace API',
                400,
            )
        if not self.check_space_permission(str(host.id), 'editor'):
            return False
        return self._restore_space_from_trash_core(host)

    @classmethod
    @transaction.atomic(using=postgres_app_db_alias())
    def admin_restore_space_from_trash(cls, space_id: UUID, *, actor=None) -> bool:
        """Admin 代操作：跳过组织成员权限，从回收站恢复 Project。"""
        try:
            project = Project.objects.get(id=space_id)
        except Project.DoesNotExist:
            return False
        return cls(user=actor)._restore_space_from_trash_core(project)

    @classmethod
    def purge_trashed_spaces(cls, space_ids: list) -> int:
        """永久删除已在回收站中的 Project，与 Celery 过期清理共用同一路径。

        ：仅处理 ``trashed_at`` 非空的 Project；返回实际删除行数。
        """
        if not space_ids:
            return 0

        ids = list(
            Project.objects.filter(id__in=space_ids, trashed_at__isnull=False)
            .values_list('id', flat=True)
        )
        if not ids:
            return 0

        from apps.tabtinspace.services.organization_service import OrganizationService
        from apps.tabtinspace.services.trash_cleaner import TrashCleaner

        TrashCleaner.release_file_usages_for_spaces(ids)
        OrganizationService.delete_space_resources(ids)
        _detach_chat_sessions_from_spaces(ids)
        # Django delete()[0] 会把级联行算进总数；这里只返回 Project 条数。
        Project.objects.filter(id__in=ids).delete()
        return len(ids)

    @staticmethod
    def _assert_not_execution_binding_target(host_id: UUID) -> None:
        """Workspace 若仍被 Project 绑定为成员执行现场，禁止永久删除。

        ：旧 Space.execution_space 已退役，改查 ProjectMemberWorkspace。
        """
        from apps.tabtinspace.models import ProjectMemberWorkspace

        bound_names = list(
            ProjectMemberWorkspace.objects.filter(workspace_id=host_id)
            .values_list('project__name', flat=True)
        )
        if not bound_names:
            return
        if len(bound_names) == 1:
            detail = f'项目「{bound_names[0]}」'
        else:
            names = '、'.join(f'「{name}」' for name in bound_names[:3])
            if len(bound_names) > 3:
                names += f' 等 {len(bound_names)} 个'
            detail = f'项目 {names}'
        raise ServiceError(
            'EXECUTION_BINDING',
            f'该宿主正被{detail}用作执行绑定，请先更换执行现场后再删除',
            409,
        )

    @transaction.atomic(using=postgres_app_db_alias())
    def permanent_delete_space_from_trash(self, space_id: UUID) -> bool:
        """从回收站永久删除 Project。

        要求组织 owner；宿主必须已在回收站中。
        """
        try:
            project = Project.objects.get(id=space_id)
        except Project.DoesNotExist:
            return False

        if project.trashed_at is None:
            raise ServiceError(
                'SPACE_NOT_IN_TRASH',
                'Space 不在回收站中，无法永久删除',
                400,
            )

        if not self.check_organization_permission(str(project.organization_id), 'owner'):
            return False

        self._assert_not_execution_binding_target(space_id)

        space_name = project.name
        organization_id = project.organization_id
        deleted = self.purge_trashed_spaces([space_id])
        if deleted <= 0:
            return False

        from apps.tabtinspace.services.audit_service import AuditService
        AuditService.log(
            'space_permanent_delete',
            'space',
            space_id,
            organization_id=organization_id,
            space_id=space_id,
            operator=self.user,
            message='用户从回收站永久删除 Space',
            result_payload={'space_name': space_name},
        )

        wt_id = str(organization_id)
        sp_id = str(space_id)
        transaction.on_commit(
            lambda: publish_space_list_change(wt_id, 'permanently_deleted', sp_id),
            using=postgres_app_db_alias(),
        )
        return True

    def _cascade_trash_child_resources(self, space_id: UUID, trashed_at, trashed_by):
        """将 Space 下所有活跃子资源也移入回收站，与 _cascade_restore 对称。"""
        from apps.tabtinspace.models import ContextItem

        from apps.tabtinspace.services.asset_host import asset_host_q

        active_items = ContextItem.objects.filter(
            asset_host_q(space_id),
            trashed_at__isnull=True,
            is_archived=False,
        )

        for ci in active_items:
            try:
                self._trash_child_resource(ci, trashed_at, trashed_by)
            except Exception:
                _logger.warning(
                    "级联 trash 子资源失败: ci=%s, type=%s, resource=%s",
                    ci.id, ci.item_type, ci.resource_id,
                    exc_info=True,
                )

    def _trash_child_resource(self, context_item, trashed_at, trashed_by):
        """将单条子资源移入回收站，与 _restore_child_resource 对称。"""
        model_class = self._get_resource_model(context_item.item_type)
        if not model_class:
            return

        try:
            resource = model_class.objects.get(id=context_item.resource_id)
        except model_class.DoesNotExist:
            return

        if hasattr(resource, 'trash'):
            resource.trash(user_id=trashed_by, trashed_at=trashed_at)
        elif hasattr(resource, 'trashed_at') and resource.trashed_at is None:
            resource.trashed_at = trashed_at
            resource.trashed_by = trashed_by
            update_fields = ['trashed_at', 'trashed_by']
            if hasattr(resource, 'status'):
                resource.previous_status = resource.status or 'active'
                resource.status = 'trashed'
                update_fields += ['previous_status', 'status']
            if hasattr(resource, 'updated_at'):
                update_fields.append('updated_at')
            resource.save(update_fields=update_fields)

        context_item.trashed_at = trashed_at
        context_item.trashed_by = trashed_by
        if hasattr(context_item, 'previous_status'):
            context_item.previous_status = context_item.status or ''
        context_item.save(update_fields=['trashed_at', 'trashed_by', 'previous_status', 'updated_at'])

    def _cascade_restore_child_resources(self, space_id: UUID, as_trashed_at):
        """恢复随 Space 一起被删除的子资源（trashed_at >= Space.trashed_at）。"""
        from apps.tabtinspace.models import ContextItem
        from apps.tabtinspace.services.resource_bridge import ResourceBridge

        from apps.tabtinspace.services.asset_host import asset_host_q

        child_items = ContextItem.objects.filter(
            asset_host_q(space_id),
            trashed_at__isnull=False,
            trashed_at__gte=as_trashed_at,
        )

        for ci in child_items:
            try:
                self._restore_child_resource(ci)
            except Exception:
                _logger.warning(
                    "级联恢复子资源失败: ci=%s, type=%s, resource=%s",
                    ci.id, ci.item_type, ci.resource_id,
                    exc_info=True,
                )

    def _restore_child_resource(self, context_item):
        """恢复单条子资源，调用模型的 restore_from_trash()。"""
        item_type = context_item.item_type
        resource_id = context_item.resource_id

        model_class = self._get_resource_model(item_type)
        if not model_class:
            return

        try:
            resource = model_class.objects.get(id=resource_id)
        except model_class.DoesNotExist:
            context_item.delete()
            return

        from apps.tabtinspace.services.resource_bridge import ResourceBridge
        try:
            ResourceBridge.check_restore_quota(resource)
        except Exception as exc:
            _logger.warning(
                "子资源恢复配额不足，跳过: item_type=%s resource=%s err=%s",
                item_type, resource_id, exc,
            )
            return

        if hasattr(resource, 'restore_from_trash'):
            resource.restore_from_trash()
        elif hasattr(resource, 'status') and resource.status == 'trashed':
            resource.status = context_item.previous_status or 'active'
            resource.trashed_at = None
            resource.trashed_by = None
            resource.previous_status = ''
            resource.save()

        context_item.trashed_at = None
        context_item.trashed_by = None
        context_item.previous_status = ''
        context_item.save(update_fields=['trashed_at', 'trashed_by', 'previous_status', 'updated_at'])

    @staticmethod
    def _get_resource_model(item_type: str):
        """按 item_type（DB 规范名）返回对应的 Django 模型类。"""
        from apps.tabtinspace.resource_registry import get_resource_model
        return get_resource_model(item_type)

    @transaction.atomic(using=postgres_app_db_alias())
    def delete_space(
        self,
        space_id: UUID,
        acting_device_id: Optional[UUID] = None,
    ) -> bool:
        self._raise_space_shell_retired('delete_space')

    @staticmethod
    def _delete_space_relation_rows(space_id: UUID) -> None:
        """删除 Space 自身关系，不删除团队业务资源或本机目录。"""
        from apps.collab.models import SpaceCheckpoint

        ContextItem.objects.filter(
            Q(workspace_id=space_id) | Q(project_id=space_id)
        ).delete()
        Collection.objects.filter(
            Q(workspace_id=space_id) | Q(project_id=space_id)
        ).delete()
        SpaceAppSettings.objects.filter(workspace_id=space_id).delete()
        SpaceMembership.objects.filter(workspace_id=space_id).delete()
        SpacePermission.objects.filter(workspace_id=space_id).delete()
        SpaceAdminActionLog.objects.filter(space_id=space_id).delete()
        # Space 级检查点是工作现场运行态（非团队资源），随 Space 一起清理，
        # 避免留下指向已删 Space 的孤儿快照。
        SpaceCheckpoint.objects.filter(space_id=space_id).delete()

    def get_space_stats(self, space_id: UUID) -> Optional[Dict[str, Any]]:
        self._raise_space_shell_retired('get_space_stats')

    def search_spaces(
        self,
        organization_id: UUID,
        keyword: str,
        page: int = 1,
        page_size: int = 100
    ) -> Tuple[List[Workspace], int]:
        queryset = self._get_accessible_workspace_queryset(organization_id).filter(
            Q(name__icontains=keyword) |
            Q(agent__name__icontains=keyword) |
            Q(agent__custom_rules__icontains=keyword)
        )
        queryset = queryset.order_by('-created_at', 'id')
        total = queryset.count()
        offset = (page - 1) * page_size
        return list(queryset[offset:offset + page_size]), total

    def get_default_space(self, organization_id: UUID) -> Optional[Workspace]:
        queryset = self._get_accessible_workspace_queryset(organization_id)
        home = queryset.filter(kind=Workspace.Kind.HOME).order_by('created_at').first()
        if home:
            return home
        return queryset.order_by('created_at').first()


def _detach_chat_sessions_from_spaces(space_ids):
    """R1-22 / ：删除 Workspace（或 id 复用的旧 Space）前预清理 ChatSession 引用。

    `ChatSession.workspace` 是指向 `tabtinspace.Workspace` 的 FK（`on_delete=SET_NULL`）。
    删除 Workspace 前在业务库主动 `update(workspace=None)`，避免 collector 在
    删主行时被关联会话拖垮，并保证对话历史在现场删除后仍可保留。

    Args:
        space_ids: 待删 Workspace / 旧 Space UUID 列表（或单个 UUID 也支持；
            与 Workspace.id 复用源 Space.id 的历史口径对齐）

    Returns:
        受影响 ChatSession 行数（>=0）
    """
    if not space_ids:
        return 0
    # 标准化成列表（接受单个 UUID 或可迭代）
    if not isinstance(space_ids, (list, tuple, set)):
        space_ids = [space_ids]
    ids = [str(sid) for sid in space_ids if sid]
    if not ids:
        return 0
    try:
        from apps.chat.conversation.models import ChatSession
    except Exception:
        # ChatSession 模块不可用（极不应发生）→ swallow，让 ORM cascade 自行尝试
        _logger.warning(
            "[SpaceService] _detach_chat_sessions: ChatSession import failed; skip pre-detach",
            exc_info=True,
        )
        return 0
    try:
        affected = (
            ChatSession.objects
            .using('default')
            .filter(workspace_id__in=ids)
            .update(workspace=None)
        )
        if affected:
            _logger.info(
                "[SpaceService] _detach_chat_sessions: pre-cleared %d ChatSession rows for workspaces=%s",
                affected, ids,
            )
        return affected
    except Exception:
        _logger.exception(
            "[SpaceService] _detach_chat_sessions: pre-clear failed for spaces=%s; "
            "Space.delete() will likely raise ProgrammingError",
            ids,
        )
        return 0
