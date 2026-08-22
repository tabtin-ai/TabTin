"""#3266：用 Workspace / Project 取代已 DROP 的 Space.objects 查询。"""

from __future__ import annotations

from typing import Any, Iterable, Optional, Set
from uuid import UUID


def resolve_host(host_id) -> Any:
    """先 Workspace 后 Project；都不存在返回 None。"""
    if not host_id:
        return None
    from apps.tabtinspace.models import Project, Workspace

    workspace = (
        Workspace.objects.filter(id=host_id).select_related("organization").first()
    )
    if workspace is not None:
        return workspace
    return Project.objects.filter(id=host_id).select_related("organization").first()


def host_type(host_id) -> Optional[str]:
    """返回 ``workspace`` | ``team_space`` | None（``team_space`` = Project）。"""
    if not host_id:
        return None
    from apps.tabtinspace.models import Project, Workspace

    if Workspace.objects.filter(id=host_id).exists():
        return "workspace"
    if Project.objects.filter(id=host_id).exists():
        return "team_space"
    return None


def host_organization_id(host_id) -> Optional[UUID]:
    host = resolve_host(host_id)
    if host is None:
        return None
    org_id = getattr(host, "organization_id", None)
    return org_id if org_id is None else UUID(str(org_id))


def is_workspace_host(host_id) -> bool:
    return host_type(host_id) == "workspace"


def host_exists(host_id) -> bool:
    return resolve_host(host_id) is not None


def existing_host_ids(host_ids: Iterable) -> Set[str]:
    """批量校验 host id 是否存在于 Workspace 或 Project。"""
    ids = [hid for hid in host_ids if hid]
    if not ids:
        return set()
    from apps.tabtinspace.models import Project, Workspace

    found = set(
        str(x) for x in Workspace.objects.filter(id__in=ids).values_list("id", flat=True)
    )
    missing = [hid for hid in ids if str(hid) not in found]
    if missing:
        found.update(
            str(x)
            for x in Project.objects.filter(id__in=missing).values_list("id", flat=True)
        )
    return found


def host_name_map(host_ids: Iterable) -> dict[str, str]:
    """id → name，合并 Workspace + Project。"""
    ids = [hid for hid in host_ids if hid]
    if not ids:
        return {}
    from apps.tabtinspace.models import Project, Workspace

    result = {
        str(row["id"]): row["name"] or ""
        for row in Workspace.objects.filter(id__in=ids).values("id", "name")
    }
    missing = [hid for hid in ids if str(hid) not in result]
    if missing:
        result.update(
            {
                str(row["id"]): row["name"] or ""
                for row in Project.objects.filter(id__in=missing).values("id", "name")
            }
        )
    return result


def organization_ids_for_hosts(host_ids: Iterable) -> Set[str]:
    ids = [hid for hid in host_ids if hid]
    if not ids:
        return set()
    from apps.tabtinspace.models import Project, Workspace

    org_ids = {
        str(x)
        for x in Workspace.objects.filter(id__in=ids).values_list(
            "organization_id", flat=True
        )
        if x
    }
    org_ids.update(
        str(x)
        for x in Project.objects.filter(id__in=ids).values_list(
            "organization_id", flat=True
        )
        if x
    )
    return org_ids


def lock_host_for_update(host_id, *, using: Optional[str] = None) -> Any:
    """select_for_update 锁定 Workspace 或 Project 行。"""
    if not host_id:
        return None
    from apps.tabtinspace.models import Project, Workspace

    ws_qs = Workspace.objects
    pj_qs = Project.objects
    if using:
        ws_qs = ws_qs.using(using)
        pj_qs = pj_qs.using(using)
    host = ws_qs.select_for_update().filter(id=host_id).first()
    if host is not None:
        return host
    return pj_qs.select_for_update().filter(id=host_id).first()
