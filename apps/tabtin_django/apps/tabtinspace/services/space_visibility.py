"""Workspace / Project 可见性——列表 / 搜索的产品事实源。

邀请制口径：个人 Workspace 按显式 SpaceMembership / owner 访问；
Project 是项目房间，必须是 Organization 成员且有 active
ProjectMembership 才可见 / 可进入。

⚠️ 与 accessible_space_resolver 的分工（两套实现语义不同，勿混用）：

- 本模块 ``get_accessible_space_ids``：**列表 / 搜索口径**（SpaceService、
  TabChat 等）。个人域：owner membership 恒可见；非 owner 仅当该
  Workspace 上存在任一非 owner 的 active membership（即已共享）时可见。
  「stale membership + 未共享」不再单独靠 Space.visibility 字段——
  共享语义由非 owner membership 本身表达；失效请停用 membership。
- ``accessible_space_resolver.AccessibleSpaceResolver``：**资源列表 scope**
  （TabData/TabDoc/TabSlide/RAG 等）。不检查「是否已共享」，只看 membership。

#3266：Space 表已 DeleteModel；本模块只读 Workspace / Project。
"""
from __future__ import annotations

from typing import Iterable, Optional, Set
from uuid import UUID

from django.db.models import Count, Q

from apps.tabtinspace.models import (
    Organization,
    OrganizationMember,
    Project,
    ProjectMembership,
    SpaceMembership,
    Workspace,
)
from apps.services.common.constants import ROLE_LEVELS


class SpaceVisibility:
    """历史常量名保留；产品语义已迁到「是否存在非 owner membership」。"""

    PRIVATE = "private"
    SHARED = "shared"

    CHOICES = (
        (PRIVATE, "仅创建者"),
        (SHARED, "已共享"),
    )


def _organization_allows_space_access(organization_id: UUID) -> bool:
    """组织墓碑存在期间，所有面向用户的入口均视为不可访问。"""
    return (
        Organization.objects.filter(id=organization_id)
        .exclude(status=Organization.Status.DELETING)
        .exists()
    )


def is_bot_agent_space(host) -> bool:
    """#6198：Workspace 不再挂 Agent；恒 False（历史「bot 私有壳」语义退役）。"""
    _ = host
    return False


def _owner_membership_filter(user) -> Q:
    return Q(user_id=user.id, role="owner", is_active=True)


def _any_membership_filter(user) -> Q:
    return Q(user_id=user.id, is_active=True)


def _organization_role_for_user(user, organization_id: UUID) -> Optional[str]:
    """返回用户在 Organization 内的角色；非成员返回 None。"""
    if not user or not _organization_allows_space_access(organization_id):
        return None
    if Organization.objects.filter(id=organization_id, owner_id=user.id).exists():
        return "owner"
    return (
        OrganizationMember.objects.filter(
            organization_id=organization_id,
            user_id=user.id,
        )
        .values_list("role", flat=True)
        .first()
    )


def _personal_workspace_ids_for_user(user) -> Set[UUID]:
    return set(
        SpaceMembership.objects.filter(
            _any_membership_filter(user),
        ).values_list("workspace_id", flat=True)
    )


def _owner_workspace_ids_for_user(user) -> Set[UUID]:
    return set(
        SpaceMembership.objects.filter(
            _owner_membership_filter(user),
        ).values_list("workspace_id", flat=True)
    )


def _shared_workspace_ids(workspace_ids: Iterable[UUID]) -> Set[UUID]:
    """存在任一非 owner 的 active membership → 视为已共享。"""
    ids = list(workspace_ids)
    if not ids:
        return set()
    return set(
        SpaceMembership.objects.filter(
            workspace_id__in=ids,
            is_active=True,
        )
        .exclude(role="owner")
        .values_list("workspace_id", flat=True)
        .distinct()
    )


def _team_space_ids_for_space_member(
    user,
    organization_id: Optional[UUID],
) -> Set[UUID]:
    """团队房间：ProjectMembership → project_id。"""
    if not user:
        return set()

    memberships = ProjectMembership.objects.filter(
        user_id=user.id,
        is_active=True,
        status=ProjectMembership.Status.ACTIVE,
        project__status=Project.Status.ACTIVE,
    )

    if organization_id:
        if not _organization_role_for_user(user, organization_id):
            return set()
        memberships = memberships.filter(project__organization_id=organization_id)
    else:
        organization_ids = (
            Organization.objects.filter(
                Q(owner_id=user.id) | Q(members__user_id=user.id),
                type=Organization.OrganizationType.TEAM,
            )
            .exclude(status=Organization.Status.DELETING)
            .values_list("id", flat=True)
            .distinct()
        )
        memberships = memberships.filter(project__organization_id__in=organization_ids)

    return set(memberships.values_list("project_id", flat=True))


def get_accessible_space_ids(
    user,
    *,
    organization_id: Optional[UUID] = None,
) -> Set[UUID]:
    """返回当前用户可出现在列表/搜索中的 Workspace / Project id 集合。

    返回集合混有个人 Workspace.id 与 Project.id（历史 API 同形）。
    """
    if not user:
        return set()
    if organization_id and not _organization_allows_space_access(organization_id):
        return set()

    owner_ws_ids = _owner_workspace_ids_for_user(user)
    member_ws_ids = _personal_workspace_ids_for_user(user)
    shared_ws_ids = _shared_workspace_ids(member_ws_ids) & member_ws_ids
    # 非 owner 仅能看见已共享现场；owner 恒可见自己的现场。
    personal_ids = owner_ws_ids | shared_ws_ids

    team_space_ids = _team_space_ids_for_space_member(user, organization_id)
    accessible = personal_ids | team_space_ids

    workspaces = Workspace.objects.filter(id__in=accessible).exclude(
        organization__status=Organization.Status.DELETING,
    )
    if organization_id:
        workspaces = workspaces.filter(organization_id=organization_id)
    personal_ok = set(workspaces.values_list("id", flat=True))

    projects = Project.objects.filter(id__in=accessible).exclude(
        organization__status=Organization.Status.DELETING,
    )
    if organization_id:
        projects = projects.filter(organization_id=organization_id)
    project_ok = set(projects.values_list("id", flat=True))

    return personal_ok | project_ok


def resolve_user_space_role(
    user,
    host,
) -> int:
    """返回用户在 Workspace / Project 上的最高权限级别；无权限时返回 0。

    ``host`` 可为 Workspace 或 Project（历史调用方传 Space 壳，现已退役）。
    """
    if not user:
        return 0
    organization_id = getattr(host, "organization_id", None)
    if organization_id is None or not _organization_allows_space_access(organization_id):
        return 0

    host_id = getattr(host, "id", None)
    if host_id is None:
        return 0

    max_level = 0

    # Project 真表
    if isinstance(host, Project) or (
        not isinstance(host, Workspace)
        and Project.objects.filter(id=host_id).exists()
        and not Workspace.objects.filter(id=host_id).exists()
    ):
        membership = ProjectMembership.objects.filter(
            project_id=host_id,
            user_id=user.id,
            is_active=True,
        ).first()
        if membership:
            max_level = max(max_level, ROLE_LEVELS.get(membership.role, 0))
        organization_role = _organization_role_for_user(user, organization_id)
        if not organization_role:
            return 0
        return max_level

    user_membership = SpaceMembership.objects.filter(
        workspace_id=host_id,
        user_id=user.id,
        is_active=True,
    ).first()
    if user_membership:
        max_level = max(max_level, ROLE_LEVELS.get(user_membership.role, 0))

    # 未共享：仅 owner；已共享：任意 active membership。
    is_shared = SpaceMembership.objects.filter(
        workspace_id=host_id,
        is_active=True,
    ).exclude(role="owner").exists()
    if not is_shared:
        if max_level < ROLE_LEVELS["owner"]:
            return 0
        return max_level

    try:
        organization = Organization.objects.get(id=organization_id)
        if organization.owner_id == user.id:
            max_level = max(max_level, ROLE_LEVELS["admin"])
    except Organization.DoesNotExist:
        pass

    return max_level


def user_can_access_space(
    user,
    host,
    required_role: str = "viewer",
) -> bool:
    required_level = ROLE_LEVELS.get(required_role, 0)
    return resolve_user_space_role(user, host) >= required_level


def active_member_counts(space_ids: Iterable[UUID]) -> dict[UUID, int]:
    ids = list(space_ids)
    rows = (
        SpaceMembership.objects.filter(
            workspace_id__in=ids,
            is_active=True,
        )
        .values("workspace_id")
        .annotate(total=Count("id"))
    )
    counts = {row["workspace_id"]: row["total"] for row in rows}

    project_rows = (
        ProjectMembership.objects.filter(
            project_id__in=ids,
            is_active=True,
        )
        .values("project_id")
        .annotate(total=Count("id"))
    )
    for row in project_rows:
        counts[row["project_id"]] = counts.get(row["project_id"], 0) + row["total"]
    return counts


def sync_space_visibility_from_memberships(space_id: UUID) -> None:
    """#3266：Space.visibility 已随表退役；保留 no-op 兼容旧调用方。"""
    return
