"""Project 执行解析：Project + 当前用户 → 该用户自己的伴生 Workspace（ 终态）。

分层模型（正典见 principle/workspace-project.md）：

- Project 是团队协作房间（真表 :class:`Project`），本身不执行。
- 每个成员在 Project 里发起的任务，落到**成员各自的 Workspace / 设备 / 本地目录**，
  由 :class:`ProjectMemberWorkspace` 显式关联。
- 解析只取该成员在此 Project 下的**私有 Workspace**；未供给时返回 ``None``，由调用方
  提示成员先在电脑端接受邀请并完成本地执行环境绑定。

本模块是纯读解析 + 幂等供给，不做跨设备派发、不远控他人现场。
"""
from __future__ import annotations

from typing import Any, Optional
from uuid import UUID


def resolve_project_execution_workspace(*, project: Any, user: Any) -> Optional[Any]:
    """Project + 用户 → 该用户在此 Project 的私有 :class:`Workspace`。

    终态：只取显式登记在 :class:`ProjectMemberWorkspace` 上的伴生 Workspace；
    普通个人 Workspace 即使属于当前用户，也不能被 Project 任务静默借用，否则
    任务归属、目录边界和结果回流都会变得不透明。
    """
    if project is None or user is None:
        return None

    from apps.tabtinspace.models import ProjectMemberWorkspace

    organization_id = getattr(project, 'organization_id', None)
    user_id = getattr(user, 'id', None)
    if user_id is None or not organization_id:
        return None

    linked = (
        ProjectMemberWorkspace.objects
        .select_related('workspace', 'workspace__device')
        .filter(
            project=project,
            user_id=user_id,
            workspace__organization_id=organization_id,
            workspace__created_by_id=user_id,
        )
        .first()
    )
    return linked.workspace if linked else None


def _resolve_user_default_workspace(*, user: Any, organization_id: Any) -> Optional[Any]:
    """回退：找该用户在指定团队的个人 :class:`Workspace`。"""
    if user is None or not organization_id:
        return None

    from apps.tabtinspace.models import Workspace
    return (
        Workspace.objects
        .filter(
            organization_id=organization_id,
            created_by_id=user.id,
        )
        .order_by('kind', '-created_at')
        .first()
    )


def ensure_project_workspace(
    *,
    project: Any,
    user: Any,
    device_id: UUID,
    working_dir: str,
    working_dir_type: str = '',
) -> Any:
    """幂等供给：确保 (project, user) 恰好有一个伴生 :class:`Workspace`，返回该 Workspace。

    已存在则直接返回（不改目录/设备）；不存在则原地创建 Workspace + 登记
    :class:`ProjectMemberWorkspace`。不再借道 ``SpaceService.create_space``（个人 Space
    壳已停产），因此本函数是 Project → Workspace 落地的唯一入口。

    调用方需保证 ``user`` 已是 project 所属 Organization 的成员。
    """
    if project is None:
        raise ValueError('ensure_project_workspace: project 不能为空')
    if user is None:
        raise ValueError('ensure_project_workspace: user 不能为空')
    if not device_id:
        raise ValueError('ensure_project_workspace: device_id 不能为空')
    if not (working_dir or '').strip():
        raise ValueError('ensure_project_workspace: working_dir 不能为空')

    from django.utils import timezone
    from apps.tabtinspace.models import Device, ProjectMemberWorkspace, Workspace
    from apps.tabtinspace.services.membership_utils import ensure_user_membership
    from apps.tabtinspace.services.space_service import SpaceService

    existing = resolve_project_execution_workspace(project=project, user=user)
    if existing is not None:
        ProjectMemberWorkspace.objects.get_or_create(
            project=project,
            user=user,
            defaults={'workspace': existing},
        )
        # ：伴生现场同样以 SpaceMembership 为权限真源；复用时自愈。
        ensure_user_membership(existing, user.id, 'owner')
        return existing

    device = Device.objects.filter(id=device_id, user=user, role='control').first()
    if device is None:
        raise ValueError('ensure_project_workspace: 设备不存在或不属于当前用户')
    normalized = SpaceService._canonical_working_dir(working_dir)
    # ：仅新建写 system_project；复用已有用户 Workspace 时保留来源。
    workspace, _ = Workspace.objects.get_or_create(
        organization_id=project.organization_id,
        created_by=user,
        device=device,
        normalized_working_dir=normalized,
        defaults={
            'name': f'{project.name} 项目的默认 Workspace',
            'working_dir': normalized,
            'working_dir_type': (working_dir_type or '').strip(),
            'kind': Workspace.Kind.STANDARD,
            'provisioning_source': Workspace.ProvisioningSource.SYSTEM_PROJECT,
            'trust_status': Workspace.TrustStatus.TRUSTED,
            'trust_source': Workspace.TrustSource.USER_CONFIRMED,
            'trusted_at': timezone.now(),
        },
    )
    ensure_user_membership(workspace, user.id, 'owner')
    ProjectMemberWorkspace.objects.create(
        project=project,
        user=user,
        workspace=workspace,
    )
    return workspace


def resolve_project_collaboration_space(space: Any) -> Optional[Any]:
    """兼容旧签名（ 过渡期）：给一个 :class:`Space` 或 :class:`Project`，返回对应的
    :class:`Project` 或 ``None``。

    历史 team_space Space 与新 :class:`Project` 已 id-reuse，映射按 id 精确匹配即可。
    workspace 型 Space 无 Project 归属（个人现场），直接返回 ``None``；调用方后续会
    通过 :class:`ProjectTaskRun.chat_session` 等真语义路径解析会话与 Project 的关系。
    """
    if space is None:
        return None

    from apps.tabtinspace.models import Project

    # 已经是 Project：直接返回。
    if space.__class__.__name__ == 'Project':
        return space

    space_id = getattr(space, 'id', None)
    if space_id is None:
        return None
    return Project.objects.filter(id=space_id).first()


__all__ = [
    'resolve_project_execution_workspace',
    'resolve_project_collaboration_space',
    'ensure_project_workspace',
]
