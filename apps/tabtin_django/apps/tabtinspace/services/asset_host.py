"""Collection / ContextItem 宿主解析。

个人资产挂 workspace，团队挂 project（id-reuse XOR）；
组织级云盘等 org-only 资产挂 organization（与 workspace/project 互斥）。
"""
from __future__ import annotations

from django.db.models import Q

from apps.tabtinspace.models import Project, Workspace


def asset_host_q(host_id=None, *, organization_id=None) -> Q:
    """按宿主匹配 ContextItem / Collection。

    - ``host_id``：匹配 workspace_id 或 project_id（ id-reuse）
    - ``organization_id``（且无 host_id）：匹配 org-only 行
    """
    if organization_id is not None and host_id is None:
        return Q(organization_id=organization_id)
    return Q(workspace_id=host_id) | Q(project_id=host_id)


def host_id_of(obj) -> str | None:
    """返回 workspace/project 宿主 id；org-only 行返回 None（无 Space 宿主）。

    权限路径请同时看 ``organization_id_of`` / ``check_organization_permission``，
    不要把 ``None`` 直接丢进 ``check_space_permission``。
    """
    hid = getattr(obj, "workspace_id", None) or getattr(obj, "project_id", None)
    return str(hid) if hid else None


def organization_id_of(obj) -> str | None:
    """返回 org-only 宿主 organization_id；非 org-only 返回 None。"""
    oid = getattr(obj, "organization_id", None)
    return str(oid) if oid else None


def create_host_kwargs(host_id=None, organization_id=None) -> dict:
    """创建 Collection / ContextItem 时写入正确的宿主 FK（三态互斥）。

    - 仅 ``organization_id`` → org-only
    - ``host_id`` → workspace 或 project（按存在性判定）
    """
    if organization_id is not None and host_id is None:
        return {"organization_id": organization_id}
    if host_id is None:
        raise ValueError("create_host_kwargs 需要 host_id 或 organization_id")
    if Workspace.objects.filter(id=host_id).exists():
        return {"workspace_id": host_id}
    if Project.objects.filter(id=host_id).exists():
        return {"project_id": host_id}
    return {"workspace_id": host_id}
