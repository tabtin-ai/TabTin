"""
SpaceMembership 幂等创建工具（：个人域挂 Workspace）。

用户与 Agent 是两种独立成员身份。用户成员关系直接写
``SpaceMembership.user_id``，不再创建 human Agent 代理行。

0108 起 ``SpaceMembership.space`` 已 Drop，事实源为 ``workspace``。
调用方仍可传入个人 Space / Workspace（id-reuse：Workspace.id == 源 Space.id）。

团队宿主（Project）成员关系走 ``ProjectMembership``；双宿主查询见
``user_is_host_member`` / ``get_host_member_role``。
"""

from typing import Optional

from django.db import IntegrityError

from apps.tabtinspace.models import ProjectMembership, SpaceMembership

ORGANIZATION_ROLE_TO_SPACE_ROLE = {
    'owner': 'owner',
    'admin': 'admin',
    'editor': 'editor',
    'viewer': 'viewer',
}


def organization_role_to_space_role(role: str) -> str:
    return ORGANIZATION_ROLE_TO_SPACE_ROLE.get(role, 'viewer')


def _workspace_id_from_host(host) -> str:
    """从 Space / Workspace / UUID 解析个人 Workspace.id（id-reuse）。"""
    if host is None:
        raise ValueError('ensure_user_membership 需要 Workspace / Space / id')
    return str(getattr(host, 'id', host))


def ensure_user_membership(space, user_id, role: str) -> SpaceMembership:
    """幂等确保用户直接持有 Workspace membership。

    参数名 ``space`` 保留以兼容既有调用方；写入 ``SpaceMembership.workspace``。
    """
    workspace_id = _workspace_id_from_host(space)
    try:
        membership, _ = SpaceMembership.objects.get_or_create(
            workspace_id=workspace_id,
            user_id=user_id,
            defaults={'role': role, 'is_active': True},
        )
    except IntegrityError:
        membership = SpaceMembership.objects.get(
            workspace_id=workspace_id, user_id=user_id,
        )
    if role == 'owner' and (membership.role != 'owner' or not membership.is_active):
        membership.role = 'owner'
        membership.is_active = True
        membership.save(update_fields=['role', 'is_active', 'updated_at'])
    elif not membership.is_active:
        membership.is_active = True
        membership.save(update_fields=['is_active', 'updated_at'])
    return membership


def get_host_member_role(host_id, user_id) -> Optional[str]:
    """返回用户在宿主上的活跃角色；个人走 SpaceMembership，团队走 ProjectMembership。"""
    from apps.tabtinspace.services.host_resolver import host_type

    ht = host_type(host_id)
    if ht == 'workspace':
        return (
            SpaceMembership.objects.filter(
                workspace_id=host_id, user_id=user_id, is_active=True,
            )
            .values_list('role', flat=True)
            .first()
        )
    if ht == 'team_space':
        return (
            ProjectMembership.objects.filter(
                project_id=host_id,
                user_id=user_id,
                is_active=True,
                status=ProjectMembership.Status.ACTIVE,
            )
            .values_list('role', flat=True)
            .first()
        )
    return None


def user_is_host_member(host_id, user_id) -> bool:
    """用户是否为宿主的活跃成员（Workspace / Project）。"""
    return get_host_member_role(host_id, user_id) is not None
