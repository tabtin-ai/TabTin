"""WorkspaceService — 执行现场的创建 / 供给（ PR2）。

Workspace = (设备, 规范化目录) 的本地执行现场（终态两概念之一）。
创建不再隐式建 Agent（旧 create_agent_workspace 组合链已 deprecated）：
「谁干」与「在哪干」是两个自由度，分别供给、会话时自由组合。

主场（kind='home'）供给走 ``ensure_home_workspace`` 幂等原语
（home-workspace-p1 §3.4）：客户端首跑解析 ``~/TabTin/Home`` 后调用，
幂等键 (organization, device, user, kind='home')，DB partial unique 兜底并发。
"""

import logging
import ntpath
import posixpath
import re
from typing import Optional, Tuple
from uuid import UUID

from django.conf import settings
from django.db import IntegrityError, transaction
from django.db.models import Q
from django.utils import timezone

from apps.services.common.db_router import postgres_app_db_alias
from apps.services.common.device_capability_registry import is_user_level_device
from apps.tabtinspace.models import Device, Organization, Workspace
from .base import BaseService, ServiceError

logger = logging.getLogger(__name__)

_WINDOWS_ABSOLUTE_PATH = re.compile(r'^[A-Za-z]:[\\/]\S')


def canonical_remote_working_dir(value: str) -> str:
    """规范化远程执行设备绝对目录；空字符串表示相对路径或根目录。"""
    path = str(value or '').strip()
    if not path or '\x00' in path or len(path) > 4096:
        return ''
    if path.startswith('/'):
        normalized = posixpath.normpath(path)
        return '' if normalized in ('/', '//') else normalized
    if _WINDOWS_ABSOLUTE_PATH.match(path):
        normalized = ntpath.normpath(path)
        _, tail = ntpath.splitdrive(normalized)
        return normalized if tail not in ('', '\\', '/') else ''
    if path.startswith('\\\\'):
        normalized = ntpath.normpath(path)
        drive, tail = ntpath.splitdrive(normalized)
        return normalized if drive and tail not in ('', '\\', '/') else ''
    return ''


def canonical_working_dir(value: Optional[str]) -> str:
    """规范化工作目录：去空白与末尾分隔符，供 device+dir 唯一约束比对。

    与 ``SpaceService._canonical_working_dir`` 语义一致；#3266 Space 退役
    过渡期 SpaceService 保留同名代理，逐步切到本函数。
    """
    if value is None:
        return ''
    stripped = str(value).strip()
    if not stripped:
        return ''
    return stripped.rstrip('/').rstrip('\\') or stripped[0]


def _project_ids_for_workspaces(workspace_ids) -> dict:
    """Workspace → 任一关联 Project（伴生现场标记，供侧栏默认隐藏）。

    同一 Workspace 可被成员复用于多个 Project；侧栏只需知道「非独立个人现场」，
    因此每个 workspace 取一条 project_id 即可（按 created_at 最早）。
    """
    if not workspace_ids:
        return {}
    from apps.tabtinspace.models import ProjectMemberWorkspace

    mapping: dict = {}
    rows = (
        ProjectMemberWorkspace.objects
        .filter(workspace_id__in=workspace_ids)
        .order_by('created_at')
        .values_list('workspace_id', 'project_id')
    )
    for workspace_id, project_id in rows:
        mapping.setdefault(workspace_id, project_id)
    return mapping


def serialize_workspace(
    workspace: Workspace,
    *,
    agent_id_by_workspace: dict | None = None,
    project_id: UUID | None = None,
    project_id_by_workspace: dict | None = None,
) -> dict:
    """GET /workspaces 契约形状。

    ：Workspace 不再挂 Agent。保留 ``agent_id`` / ``execution_agent_id``
    键以免旧客户端解包失败，值恒为 null；身份由会话 / 显式选择决定。
    ``agent_id_by_workspace`` 参数保留签名兼容，已忽略。

    #  / ：下发 ``project_id``（执行关联）与 ``is_companion`` /
    # ``provisioning_source``（导航隐藏）。隐藏只看系统供给来源，不看是否
    # 关联了 Project（用户改绑已有 Workspace 后仍应出现在侧栏）。
    """
    from apps.services.common.device_capability_registry import (
        DEVICE_AVAILABLE_STATUSES,
    )

    _ = agent_id_by_workspace  # 兼容旧调用方，不再使用
    device = workspace.device

    resolved_project_id = project_id
    if resolved_project_id is None and project_id_by_workspace is not None:
        resolved_project_id = project_id_by_workspace.get(workspace.id)
    if resolved_project_id is None and project_id_by_workspace is None:
        resolved_project_id = _project_ids_for_workspaces([workspace.id]).get(workspace.id)

    project_id_str = str(resolved_project_id) if resolved_project_id else None
    provisioning_source = getattr(
        workspace,
        'provisioning_source',
        Workspace.ProvisioningSource.USER,
    ) or Workspace.ProvisioningSource.USER
    is_companion = provisioning_source in Workspace.SYSTEM_PROVISIONING_SOURCES

    return {
        "id": str(workspace.id),
        "organization_id": str(workspace.organization_id),
        "project_id": project_id_str,
        "provisioning_source": provisioning_source,
        "is_companion": is_companion,
        "name": workspace.name or "",
        "description": workspace.description or "",
        "working_dir": workspace.working_dir or "",
        "working_dir_type": workspace.working_dir_type or "",
        "device_id": str(workspace.device_id) if workspace.device_id else None,
        "device_online": bool(
            device is not None
            and getattr(device, "status", None) in DEVICE_AVAILABLE_STATUSES
        ),
        "is_home": workspace.kind == Workspace.Kind.HOME,
        # Workspace Trust（ W3）：目录自带规约/Skill 可注入的总开关。
        "trust_status": workspace.trust_status,
        "trust_source": workspace.trust_source,
        "trusted_at": (
            workspace.trusted_at.isoformat() if workspace.trusted_at else None
        ),
        "approval_grant": workspace.approval_grant,
        "approval_memo_generation": (
            workspace.approval_memo.get("generation", 0)
            if isinstance(workspace.approval_memo, dict)
            else 0
        ),
        # ：现场规则与执行限额（与 Agent 人设 / agent_config 解耦）
        "custom_rules": workspace.custom_rules or "",
        "execution_limits": (
            workspace.execution_limits
            if isinstance(workspace.execution_limits, dict)
            else {}
        ),
        "agent_id": None,
        "execution_agent_id": None,
    }


def serialize_workspaces(workspaces) -> list[dict]:
    """批量序列化，避免 list 接口对 ProjectMemberWorkspace 逐条查询。"""
    workspace_list = list(workspaces)
    project_id_by_workspace = _project_ids_for_workspaces(
        [workspace.id for workspace in workspace_list],
    )
    return [
        serialize_workspace(
            workspace,
            project_id_by_workspace=project_id_by_workspace,
        )
        for workspace in workspace_list
    ]


def _agent_ids_for_workspaces(workspace_ids) -> dict:
    """#6198：Workspace 不再关联 Agent；恒返回空映射。"""
    _ = workspace_ids
    return {}


class WorkspaceService(BaseService):
    """执行现场 CRUD / 供给。"""

    def _resolve_device(self, device_id: UUID, organization: Organization) -> Device:
        """校验设备属于当前用户且可归到目标组织（user-level 口径同 create_space）。"""
        try:
            candidate = Device.objects.get(
                id=device_id,
                user_id=self.user.id,
                role='control',
            )
        except Device.DoesNotExist:
            raise ServiceError('DEVICE_NOT_FOUND', '执行设备不存在或不可用', 404)
        if (
            not is_user_level_device(candidate.device_type)
            and str(candidate.organization_id) != str(organization.id)
        ):
            raise ServiceError('DEVICE_ORGANIZATION_MISMATCH', '执行设备不属于当前组织', 400)
        return candidate

    def _resolve_device_by_installation(
        self,
        installation_id: str,
        organization_id: UUID,
    ) -> Device:
        """校验账号设备后映射到 Django 现有执行设备投影。"""
        from apps.services.daemon_control.feature import (
            daemon_control_enabled_for_organization,
        )

        if not daemon_control_enabled_for_organization(
            user_id=str(self.user.id),
            organization_id=str(organization_id),
        ):
            raise ServiceError(
                'DAEMON_CONTROL_DISABLED', '当前组织尚未启用远程执行设备 Workspace', 400,
            )
        normalized = str(installation_id or '').strip()
        if not normalized:
            raise ServiceError('DEVICE_NOT_FOUND', '执行设备不存在或不可用', 404)

        from apps.services.daemon_control.client import (
            DaemonControlUnavailable,
            TargetDeviceUnavailable,
            resolve_device_by_installation,
        )

        try:
            resolved = resolve_device_by_installation(
                owner_user_id=str(self.user.id),
                installation_id=normalized,
            )
        except TargetDeviceUnavailable as exc:
            raise ServiceError(
                'TARGET_DEVICE_UNAVAILABLE', '目标设备当前不可接单', 409,
            ) from exc
        except DaemonControlUnavailable as exc:
            raise ServiceError(
                'DAEMON_CONTROL_UNAVAILABLE', '设备控制面暂时不可用', 503,
            ) from exc

        fingerprint = str(resolved.get('installation_id') or '')
        candidate = Device.objects.filter(
            fingerprint=fingerprint,
            user_id=self.user.id,
            role='control',
            device_type__in=('electron', 'daemon'),
            control_status='active',
        ).first()
        if candidate is None:
            raise ServiceError(
                'DEVICE_PROJECTION_NOT_READY',
                '设备尚未完成执行环境初始化，请登录或重新连接后重试',
                409,
            )
        return candidate

    @transaction.atomic(using=postgres_app_db_alias())
    def create_workspace(
        self,
        organization_id: UUID,
        device_id: Optional[UUID],
        working_dir: str,
        working_dir_type: str = '',
        name: str = '',
        device_installation_id: str = '',
    ) -> Workspace:
        """创建普通执行现场（kind='standard'）。

        不隐式创建 Agent——「在哪干」独立供给；目录由客户端解析后传入
        （后端不臆造路径）。用户主动开目录 = 隐式信任（trusted/user_confirmed）。
        """
        if not self.user:
            raise ServiceError('AUTH_REQUIRED', '用户未登录', 401)
        if not self.check_organization_permission(str(organization_id), 'editor'):
            raise ServiceError('PERMISSION_DENIED', '无权限在此组织创建 Workspace', 403)
        try:
            organization = Organization.objects.get(id=organization_id)
        except Organization.DoesNotExist:
            raise ServiceError('ORGANIZATION_NOT_FOUND', '组织不存在', 404)

        normalized = canonical_working_dir(working_dir)
        if not normalized:
            raise ServiceError('WORKING_DIR_REQUIRED', '创建 Workspace 必须指定工作目录', 400)
        has_device_id = device_id is not None
        has_installation_id = bool(str(device_installation_id or '').strip())
        if has_device_id == has_installation_id:
            raise ServiceError(
                'DEVICE_SELECTOR_INVALID',
                'device_id 与 device_installation_id 必须且只能传一个',
                400,
            )
        if has_installation_id:
            normalized = canonical_remote_working_dir(normalized)
            if not normalized:
                raise ServiceError(
                    'REMOTE_WORKING_DIR_INVALID',
                    '执行设备工作目录必须是非根绝对路径',
                    400,
                )
            device = self._resolve_device_by_installation(
                device_installation_id,
                organization.id,
            )
        else:
            device = self._resolve_device(device_id, organization)

        try:
            workspace = Workspace.objects.create(
                organization=organization,
                device=device,
                name=name or '',
                working_dir=normalized,
                normalized_working_dir=normalized,
                working_dir_type=working_dir_type or '',
                kind=Workspace.Kind.STANDARD,
                trust_status=Workspace.TrustStatus.TRUSTED,
                trust_source=Workspace.TrustSource.USER_CONFIRMED,
                trusted_at=timezone.now(),
                created_by=self.user,
            )
        except IntegrityError as exc:
            if 'ctx_ws_device_dir_unique' in str(exc).lower():
                raise ServiceError(
                    'WORKING_DIR_CONFLICT',
                    '该工作目录已绑定到当前设备上的另一个 Workspace',
                    409,
                )
            raise
        # ：权限真源是 SpaceMembership；created_by  alone 不能过
        # check_space_permission。创建即写 owner，与列表/写操作口径对齐。
        self._ensure_creator_owner_membership(workspace)
        return workspace

    def _ensure_creator_owner_membership(self, workspace: Workspace) -> None:
        """幂等确保当前用户持有该 Workspace 的 owner membership。"""
        if not self.user or workspace is None:
            return
        from apps.tabtinspace.services.membership_utils import ensure_user_membership

        ensure_user_membership(workspace, self.user.id, 'owner')

    def _heal_creator_owner_membership(self, workspace: Workspace) -> None:
        """ensure-home 复用路径：仅当调用者即 created_by 时自愈缺 membership。"""
        if not self.user or workspace is None or not workspace.created_by_id:
            return
        if str(workspace.created_by_id) != str(self.user.id):
            return
        self._ensure_creator_owner_membership(workspace)

    def _get_owned_workspace(self, workspace_id: UUID) -> Workspace:
        """按 owner membership + 组织成员资格取个人执行现场。"""
        if not self.user:
            raise ServiceError('AUTH_REQUIRED', '用户未登录', 401)
        try:
            workspace = Workspace.objects.get(id=workspace_id)
        except Workspace.DoesNotExist:
            raise ServiceError('WORKSPACE_NOT_FOUND', 'Workspace 不存在', 404)
        # ：历史缺口只写 created_by；创建者写路径先愈再校验。
        self._heal_creator_owner_membership(workspace)
        space_key = str(workspace.id)
        self._permission_cache = {
            key: value
            for key, value in self._permission_cache.items()
            if not key.startswith(f"{space_key}:")
        }
        if not self.check_space_permission(str(workspace.id), 'owner'):
            raise ServiceError(
                'PERMISSION_DENIED', '只有 owner 能管理此 Workspace', 403,
            )
        if not self.check_organization_permission(
            str(workspace.organization_id), 'viewer'
        ):
            raise ServiceError(
                'PERMISSION_DENIED', '当前不再拥有该 Organization 的访问权限', 403,
            )
        return workspace

    def get_workspace(self, workspace_id: UUID) -> Workspace:
        """读取当前用户拥有的执行现场。"""
        return self._get_owned_workspace(workspace_id)

    def list_workspaces(self, organization_id: Optional[UUID] = None):
        """列出当前用户按 SpaceMembership 可见的个人执行现场。

        与 ``check_space_permission`` / ``get_accessible_space_ids`` 同真源：
        owner membership 恒可见；非 owner 仅已共享现场可见。不再用
        ``created_by`` 单独撑列表。
        """
        if not self.user:
            raise ServiceError('AUTH_REQUIRED', '用户未登录', 401)

        from apps.users.auth.api_key_context import get_api_key_organization_constraint
        from apps.tabtinspace.services.space_visibility import get_accessible_space_ids

        accessible_ids = get_accessible_space_ids(
            self.user,
            organization_id=organization_id,
        )
        rows = (
            Workspace.objects.select_related('device')
            .filter(id__in=accessible_ids)
            # 仍要求当前是 Organization 成员（与历史 list 口径一致）；
            # membership 可见性不能绕过「已被移出组织」。
            .filter(
                Q(organization__owner_id=self.user.id)
                | Q(organization__members__user_id=self.user.id)
            )
            .order_by('kind', 'created_at')
            .distinct()
        )
        constraint_wt = get_api_key_organization_constraint()
        if constraint_wt:
            rows = rows.filter(organization_id=constraint_wt)
        return rows

    @transaction.atomic(using=postgres_app_db_alias())
    def bind_device(
        self,
        workspace_id: UUID,
        device_id: Optional[UUID],
        expected_version: Optional[int] = None,
        recover_offline_binding: bool = False,
    ) -> Workspace:
        """校验 Workspace 设备绑定（ 终态 Workspace 事实源）。

        Workspace 的 ``device`` 是事实源且创建后锁定；迁移到另一设备必须走
        显式现场迁移流程，不能通过兼容 Space 端点静默改绑。

        唯一例外是创建者显式确认把离线历史绑定恢复到当前在线设备
        （ →  Workspace 事实源）。

        注：Space 壳已退役，本方法不再触碰 Space；``expected_version`` 参数
        保留兼容签名，但版本冲突判定改由客户端幂等重试兜底（Workspace 表
        不再持有 config_version）。
        """
        # 先统一验证 owner 与当前 Organization 成员资格，再锁定行处理
        # 设备恢复，避免被移出团队的旧创建者继续改执行绑定。
        self._get_owned_workspace(workspace_id)
        workspace = (
            Workspace.objects.select_for_update()
            .select_related("device")
            .get(id=workspace_id)
        )

        if device_id is None or str(device_id) != str(workspace.device_id):
            if not recover_offline_binding:
                raise ServiceError(
                    "WORKSPACE_DEVICE_BINDING_LOCKED",
                    "Workspace 已绑定执行设备；迁移或解绑必须走显式现场迁移流程",
                    409,
                    data={"current_device_id": str(workspace.device_id)},
                )
            if device_id is None:
                raise ServiceError(
                    "SPACE_DEVICE_RECOVERY_TARGET_REQUIRED",
                    "请选择要恢复到的在线设备。",
                    400,
                )
            old_device = workspace.device
            if not old_device or old_device.status != "offline":
                raise ServiceError(
                    "SPACE_DEVICE_RECOVERY_NOT_ALLOWED",
                    "当前执行设备仍在线，不能恢复到另一台设备。",
                    409,
                )
            try:
                new_device = Device.objects.get(
                    id=device_id,
                    user_id=self.user.id,
                    role="control",
                )
            except Device.DoesNotExist as exc:
                raise ServiceError(
                    "DEVICE_NOT_FOUND",
                    "目标执行设备不存在或无权使用",
                    404,
                ) from exc
            if not is_user_level_device(new_device.device_type):
                if str(new_device.organization_id) != str(workspace.organization_id):
                    raise ServiceError(
                        "DEVICE_NOT_FOUND",
                        "目标执行设备不存在或无权使用",
                        404,
                    )
            if new_device.status not in ("online", "busy"):
                raise ServiceError(
                    "SPACE_DEVICE_RECOVERY_TARGET_OFFLINE",
                    "只能恢复到当前在线的执行设备。",
                    409,
                )
            workspace.device = new_device
            workspace.save(update_fields=["device", "updated_at"])

        return workspace

    def _resolve_request_device_id(self, device_fingerprint: Optional[str]) -> Optional[str]:
        """请求方设备 fingerprint → control 设备 id（口径同 AgentService，）。"""
        if not device_fingerprint or not self.user:
            return None
        device = Device.objects.filter(
            fingerprint=device_fingerprint,
            user_id=self.user.id,
            role='control',
        ).first()
        return str(device.id) if device else None

    @staticmethod
    def _normalize_execution_limits(raw) -> dict:
        """归一现场 execution_limits。

        ``None`` → 空 dict（：未启用）；非 dict / 非法键值 → ``ServiceError`` 400。
        支持 ``enabled`` 布尔开关；数值键语义不变。
        """
        if raw is None:
            return {}
        if not isinstance(raw, dict):
            raise ServiceError(
                'INVALID_EXECUTION_LIMITS',
                'execution_limits 必须是对象',
                400,
            )
        out: dict = {}
        if 'enabled' in raw:
            val = raw.get('enabled')
            if val is not None and not isinstance(val, bool):
                raise ServiceError(
                    'INVALID_EXECUTION_LIMITS',
                    'enabled 须为布尔或 null',
                    400,
                )
            if val is not None:
                out['enabled'] = val
        if 'max_iterations_per_run' in raw:
            val = raw.get('max_iterations_per_run')
            if val is not None and (not isinstance(val, int) or isinstance(val, bool) or val < 1):
                raise ServiceError(
                    'INVALID_EXECUTION_LIMITS',
                    'max_iterations_per_run 须为正整数或 null',
                    400,
                )
            out['max_iterations_per_run'] = val
        if 'max_credits_per_run' in raw:
            val = raw.get('max_credits_per_run')
            if val is not None:
                try:
                    if float(val) <= 0:
                        raise ValueError
                except (TypeError, ValueError):
                    raise ServiceError(
                        'INVALID_EXECUTION_LIMITS',
                        'max_credits_per_run 须为正数或 null',
                        400,
                    )
            out['max_credits_per_run'] = None if val is None else str(val)
        return out

    @transaction.atomic(using=postgres_app_db_alias())
    def update_workspace(
        self,
        workspace_id: UUID,
        name: Optional[str] = None,
        description: Optional[str] = None,
        working_dir: Optional[str] = None,
        working_dir_type: Optional[str] = None,
        device_fingerprint: Optional[str] = None,
        custom_rules: Optional[str] = None,
        execution_limits=None,
        *,
        execution_limits_provided: bool = False,
    ) -> Workspace:
        """更新执行现场（：壳消解后个人域改名/改目录的终态入口）。

        - 主场（kind='home'）系统托管：路径固定、展示名系统供给，一律拒改
          （目录自愈走客户端 ensure 编排，不经本方法）。
        - 目录变更只允许绑定设备本机发起（device_fingerprint 权威校验，
          口径同 update_agent 的  根因 3 兜底）；目录是 Workspace 的
          身份，不允许清空——不要目录请走删除。
        - 简介是 Workspace 的展示元数据，和目录身份、运行时策略无关。
        - ：``custom_rules`` / ``execution_limits`` 为现场自有配置。
        """
        workspace = self._get_owned_workspace(workspace_id)
        if workspace.kind == Workspace.Kind.HOME:
            # 主场允许改现场规则与执行限额；仍拒改名/改目录。
            if (
                working_dir is not None
                or working_dir_type is not None
                or (name is not None and name.strip() != (workspace.name or ''))
            ):
                raise ServiceError(
                    'HOME_WORKSPACE_MANAGED',
                    '主场由系统托管，不支持改名或更换目录',
                    400,
                )

        update_fields = []
        if name is not None and workspace.kind != Workspace.Kind.HOME:
            workspace.name = name.strip()
            update_fields.append('name')

        if description is not None:
            if len(description) > 500:
                raise ServiceError(
                    'DESCRIPTION_TOO_LONG',
                    'Workspace 简介不能超过 500 字',
                    400,
                )
            workspace.description = description.strip()
            update_fields.append('description')

        if custom_rules is not None:
            if len(custom_rules) > 5000:
                raise ServiceError(
                    'CUSTOM_RULES_TOO_LONG',
                    '现场自定义规则不能超过 5000 字',
                    400,
                )
            workspace.custom_rules = custom_rules
            update_fields.append('custom_rules')

        if execution_limits_provided:
            workspace.execution_limits = self._normalize_execution_limits(execution_limits)
            update_fields.append('execution_limits')

        if working_dir is not None or working_dir_type is not None:
            effective_dir = (
                working_dir if working_dir is not None else workspace.working_dir
            )
            normalized = canonical_working_dir(effective_dir)
            if not normalized:
                raise ServiceError(
                    'WORKING_DIR_REQUIRED',
                    '目录是 Workspace 的身份，不能清空；不再需要请直接删除',
                    400,
                )
            dir_mutating = normalized != workspace.normalized_working_dir
            if dir_mutating:
                request_device_id = self._resolve_request_device_id(device_fingerprint)
                if not request_device_id or request_device_id != str(workspace.device_id):
                    raise ServiceError(
                        'WORKSPACE_DEVICE_MISMATCH',
                        '只有绑定的执行设备本机可以修改该 Workspace 的工作目录',
                        403,
                    )
            workspace.working_dir = normalized
            workspace.normalized_working_dir = normalized
            if working_dir_type is not None:
                workspace.working_dir_type = working_dir_type
            update_fields.extend(
                ['working_dir', 'normalized_working_dir', 'working_dir_type'],
            )

        if not update_fields:
            return workspace

        try:
            workspace.save(update_fields=[*update_fields, 'updated_at'])
        except IntegrityError as exc:
            exc_str = str(exc).lower()
            if (
                'ctx_ws_device_dir_unique' in exc_str
                or 'ctx_space_device_dir_unique' in exc_str
            ):
                raise ServiceError(
                    'WORKING_DIR_CONFLICT',
                    '该工作目录已绑定到当前设备上的另一个 Workspace',
                    409,
                )
            raise
        logger.info(
            "[Workspace] updated: id=%s fields=%s by=%s",
            workspace.id, update_fields, self.user.id,
        )
        return workspace

    def delete_workspace(
        self,
        workspace_id: UUID,
        acting_device_id: Optional[UUID] = None,
    ) -> None:
        """删除执行现场（ 终态删除入口）。

        级联口径（ 契约）：只删现场记录，不碰磁盘目录；会话/
        Tracker 保留、workspace FK SET_NULL 落历史；现场级运行态
        （Collection/ContextItem 索引、SpaceCheckpoint 快照）随现场清理。

        - 主场（kind='home'）系统托管不可删（重启即幂等重供给，删除无意义）。
        - 只能在绑定设备本机发起（REMOTE_DELETE_FORBIDDEN，口径同旧
          delete_space 的 workspace-requirements §5.4 产品护栏）。
        -  终态：Space 壳已退役，不再委托 SpaceService.delete_space；
          现场级软引用运行态由本方法自行清理。
        """
        workspace = self._get_owned_workspace(workspace_id)
        if workspace.kind == Workspace.Kind.HOME:
            raise ServiceError(
                'HOME_WORKSPACE_MANAGED',
                '主场由系统托管，不支持删除',
                400,
            )
        if acting_device_id is None or str(acting_device_id) != str(workspace.device_id):
            raise ServiceError(
                'REMOTE_DELETE_FORBIDDEN',
                '远程控制端不能删除 Workspace，请回到绑定的执行设备本机操作',
                403,
            )

        from apps.collab.models import SpaceCheckpoint
        from apps.tabtinspace.models import Collection, ContextItem

        with transaction.atomic(using=postgres_app_db_alias()):
            # 现场级运行态：软引用语义 = workspace_id（ PR2b）。
            # SpaceCheckpoint 仍挂 space_id（与 Workspace 同 id；见 ）。
            ContextItem.objects.filter(workspace_id=workspace.id).delete()
            Collection.objects.filter(workspace_id=workspace.id).delete()
            SpaceCheckpoint.objects.filter(space_id=workspace.id).delete()

            # ChatSession.workspace / Tracker.workspace 均 SET_NULL——对话与
            # 任务历史保留，仅失去执行锚（ 级联契约）。
            workspace.delete()

        from apps.tabtinspace.services.audit_service import AuditService
        AuditService.log(
            'workspace_delete',
            'workspace',
            workspace_id,
            organization_id=workspace.organization_id,
            operator=self.user,
            message='用户删除 Workspace',
            result_payload={
                'workspace_name': workspace.name,
                'device_id': str(workspace.device_id) if workspace.device_id else None,
                'working_dir': workspace.working_dir or '',
            },
        )
        logger.info(
            "[Workspace] deleted: id=%s by=%s",
            workspace_id, self.user.id,
        )

    def set_trust_status(self, workspace_id: UUID, trust_status: str) -> Workspace:
        """更新 Workspace 信任状态（ W3 Trust 三件套）。

        口径：一个总开关不分项；信任记 (设备+路径) 行；只有创建者能改
        （Workspace 是个人执行现场，created_by 即 owner）。
        - trusted   → trust_source=user_confirmed + trusted_at=now
        - untrusted → 撤销：trust_source=none + trusted_at=None
        """
        if not self.user:
            raise ServiceError('AUTH_REQUIRED', '用户未登录', 401)
        if trust_status not in (
            Workspace.TrustStatus.TRUSTED, Workspace.TrustStatus.UNTRUSTED,
        ):
            raise ServiceError(
                'VALIDATION_ERROR',
                'trust_status 必须是 trusted 或 untrusted',
                400,
            )
        workspace = self._get_owned_workspace(workspace_id)

        if trust_status == Workspace.TrustStatus.TRUSTED:
            workspace.trust_status = Workspace.TrustStatus.TRUSTED
            workspace.trust_source = Workspace.TrustSource.USER_CONFIRMED
            workspace.trusted_at = timezone.now()
        else:
            workspace.trust_status = Workspace.TrustStatus.UNTRUSTED
            workspace.trust_source = Workspace.TrustSource.NONE
            workspace.trusted_at = None
        workspace.save(update_fields=['trust_status', 'trust_source', 'trusted_at'])
        logger.info(
            "[Workspace] trust updated: id=%s status=%s by=%s",
            workspace.id, trust_status, self.user.id,
        )
        return workspace

    def set_approval_grant(self, workspace_id: UUID, approval_grant: str) -> Workspace:
        workspace = self._get_owned_workspace(workspace_id)
        valid_grants = {choice for choice, _ in Workspace.ApprovalGrant.choices}
        if approval_grant not in valid_grants:
            raise ServiceError(
                'INVALID_APPROVAL_GRANT',
                'approval_grant 必须是 always_ask、auto 或 full_access',
                400,
            )
        workspace.approval_grant = approval_grant
        workspace.save(update_fields=['approval_grant', 'updated_at'])
        return workspace

    @transaction.atomic(using=postgres_app_db_alias())
    def ensure_home_workspace(
        self,
        organization_id: UUID,
        device_id: UUID,
        working_dir: str,
        working_dir_type: str = 'mixed',
        name: str = '',
    ) -> Tuple[Workspace, bool]:
        """幂等确保当前用户在指定设备的主场（home-workspace-p1 §3.4）。

        幂等键 (organization, device, user, kind='home')：已存在直接返回该行、不改目录
        不改信任（改目录另走更新入口）；DB partial unique
        （ctx_ws_org_dev_user_home_uniq）兜底并发首跑。Electron 是用户级设备，
        可以跨自有 Organization 使用，故 Organization 不可省略。系统自建默认受信：trusted + system_provisioned（M-3），
        首次进入不弹 Trust 确认。

        Returns:
            (workspace, created)
        """
        if not self.user:
            raise ServiceError('AUTH_REQUIRED', '用户未登录', 401)
        # Workspace 是成员私有的本地执行现场；有效成员首次进入组织时应能
        # 自动供给自己的主场。通用权限检查同时保留 deleting 状态与 API Key
        # 租户边界，不能由非成员借设备 ID 建入组织。
        if not self.check_organization_permission(str(organization_id), 'viewer'):
            raise ServiceError('PERMISSION_DENIED', '无权限在此组织供给主场', 403)
        try:
            organization = Organization.objects.get(id=organization_id)
        except Organization.DoesNotExist:
            raise ServiceError('ORGANIZATION_NOT_FOUND', '组织不存在', 404)

        normalized = canonical_working_dir(working_dir)
        if not normalized:
            raise ServiceError('WORKING_DIR_REQUIRED', '主场供给必须携带客户端解析的目录', 400)
        device = self._resolve_device(device_id, organization)

        existing = Workspace.objects.filter(
            organization=organization,
            device=device,
            created_by=self.user,
            kind=Workspace.Kind.HOME,
        ).first()
        if existing is not None:
            # ：历史 ensure-home 只写 created_by、未写 membership；复用时自愈。
            self._heal_creator_owner_membership(existing)
            return existing, False

        try:
            # 内层 savepoint：并发首跑撞 partial unique 时只回滚 INSERT 本身，
            # 外层事务保持可用（否则 TransactionManagementError——PG 在
            # 失败事务里拒绝后续查询，恢复路径的 SELECT 会炸）。
            with transaction.atomic(using=postgres_app_db_alias()):
                workspace = Workspace.objects.create(
                    organization=organization,
                    device=device,
                    name=name or '',
                    working_dir=normalized,
                    normalized_working_dir=normalized,
                    working_dir_type=working_dir_type or 'mixed',
                    kind=Workspace.Kind.HOME,
                    trust_status=Workspace.TrustStatus.TRUSTED,
                    trust_source=Workspace.TrustSource.SYSTEM_PROVISIONED,
                    trusted_at=timezone.now(),
                    created_by=self.user,
                )
            self._ensure_creator_owner_membership(workspace)
            return workspace, True
        except IntegrityError as exc:
            exc_str = str(exc).lower()
            if 'ctx_ws_org_dev_user_home_uniq' in exc_str:
                # 并发首跑：另一次 ensure 胜出，只返回当前用户的 home（幂等收敛）。
                existing = Workspace.objects.filter(
                    organization=organization,
                    device=device,
                    created_by=self.user,
                    kind=Workspace.Kind.HOME,
                ).first()
                if existing is not None:
                    self._heal_creator_owner_membership(existing)
                    return existing, False
            if 'ctx_ws_device_dir_unique' in exc_str:
                # 当前 Organization + 用户 + 设备下，~/TabTin/Home 被 standard
                # 现场占用：正常流程不该发生。记日志返回冲突，不自动改判 kind
                #（不静默篡改用户已有现场，home-workspace-p1 §3.4 错误分支）。
                logger.warning(
                    "[Workspace] ensure_home path conflict: device=%s dir=%s",
                    device.id, normalized,
                )
                raise ServiceError(
                    'WORKING_DIR_CONFLICT',
                    '主场目录已被该设备上的另一个 Workspace 占用',
                    409,
                )
            raise


__all__ = [
    "WorkspaceService",
    "serialize_workspace",
    "serialize_workspaces",
    "canonical_working_dir",
]
