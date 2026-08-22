"""
AccessibleSpaceResolver — 资源列表 scope 的「用户可访问 Space 集合」查询服务

所有需要 organization scope 的资源列表 API（SQL catalog、文档列表、TabSlide、RAG 等）
统一调用此 Resolver，不再各自重复实现权限逻辑。

用法：
    resolver = AccessibleSpaceResolver(user_id, organization_id)
    space_ids = resolver.resolve()

⚠️ 与 space_visibility 的分工（两套实现语义不同，勿混用）：

- 本 Resolver：**资源列表 scope**。对 workspace 只看 active SpaceMembership /
  bot owner，**不检查 Space.visibility**；team / Project 仍必须是 Organization
  成员且持有 active ProjectMembership。
- ``space_visibility.get_accessible_space_ids``：**Space 列表 / 搜索口径**。
  workspace 额外要求 visibility=shared（owner 除外），是用户「能看见哪些
  Space」的产品事实源。

改可见性规则（如 team_space 相关演进）时两处都要检查并同步回归两套测试。

#3266：SpaceMembership 挂 workspace_id；团队走 ProjectMembership.project_id。
"""

from __future__ import annotations

import logging
import threading
from typing import Optional, Set, Union
from uuid import UUID

logger = logging.getLogger(__name__)

_request_local = threading.local()


class AccessibleSpaceResolver:
    """解析用户在指定 Organization 内可访问的 Space ID 集合。

    用户身份只通过 ``SpaceMembership.user_id`` / ``ProjectMembership.user_id``
    获得权限。Agent 是独立成员身份；用户拥有或创建某个 Agent，不代表继承该
    Agent 的 Space 权限。
    """

    def __init__(
        self,
        user_id: Union[str, UUID],
        organization_id: Union[str, UUID],
    ):
        self._user_id = str(user_id)
        self._organization_id = organization_id if isinstance(organization_id, UUID) else UUID(str(organization_id))

    def resolve(self) -> Set[UUID]:
        from apps.tabtinspace.models import (
            Organization,
            OrganizationMember,
            ProjectMembership,
            SpaceMembership,
            Workspace,
        )

        organization = (
            Organization.objects.filter(id=self._organization_id)
            .exclude(status=Organization.Status.DELETING)
            .only("owner_id")
            .first()
        )
        if organization is None:
            return set()

        workspace_ids = set(
            SpaceMembership.objects.filter(
                user_id=self._user_id,
                is_active=True,
                workspace__organization_id=self._organization_id,
            ).values_list("workspace_id", flat=True)
        )
        direct_ids = set(
            Workspace.objects.filter(id__in=workspace_ids).values_list("id", flat=True)
        )

        is_organization_member = (
            str(organization.owner_id) == self._user_id
            or OrganizationMember.objects.filter(
                organization_id=self._organization_id,
                user_id=self._user_id,
            ).exists()
        )
        if is_organization_member:
            team_ids = set(
                ProjectMembership.objects.filter(
                    user_id=self._user_id,
                    project__organization_id=self._organization_id,
                    is_active=True,
                ).values_list("project_id", flat=True)
            )
            direct_ids |= team_ids

        return direct_ids


def get_accessible_space_ids(
    user_id: Optional[str],
    organization_id,
) -> Optional[Set[UUID]]:
    """便捷函数：返回用户可访问的 Space ID 集合。

    同一线程（Django 请求）内对相同 (user_id, organization_id) 的结果会被缓存，
    避免同一请求链路中多次重复查库。缓存随线程结束自动释放。
    """
    if not user_id:
        return None

    wt_str = str(organization_id)
    cache_key = f"{user_id}:{wt_str}"

    cache = getattr(_request_local, "accessible_spaces", None)
    if cache is None:
        cache = {}
        _request_local.accessible_spaces = cache

    if cache_key in cache:
        return cache[cache_key]

    result = AccessibleSpaceResolver(user_id, organization_id).resolve()
    cache[cache_key] = result
    return result


def clear_accessible_space_cache(**kwargs):
    """清除当前线程的 accessible space 缓存。

    由 request_finished signal 自动调用，确保线程池复用时不泄漏上一请求的缓存。
    也可手动调用。
    """
    _request_local.accessible_spaces = {}


def _connect_request_cleanup():
    from django.core.signals import request_finished
    request_finished.connect(clear_accessible_space_cache, dispatch_uid="clear_accessible_space_cache")


try:
    _connect_request_cleanup()
except Exception:
    pass
