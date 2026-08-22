"""Space 相关公共工具函数。"""

from __future__ import annotations

from typing import Iterable


def resolve_space_names(space_ids: Iterable) -> dict[str, str]:
    """批量查询 space_id -> space_name 映射。

    接受任意可迭代的 space_id（UUID/str），返回 {str(id): name}。
    对当前页面结果集的 space_id 做一次 IN 查询，不产生 N+1。
    """
    from apps.tabtinspace.models import Project, Workspace

    unique_ids = {sid for sid in space_ids if sid}
    if not unique_ids:
        return {}
    names = {
        str(sid): name
        for sid, name in Workspace.objects.filter(id__in=unique_ids).values_list("id", "name")
    }
    missing = [sid for sid in unique_ids if str(sid) not in names]
    if missing:
        names.update(
            {
                str(sid): name
                for sid, name in Project.objects.filter(id__in=missing).values_list("id", "name")
            }
        )
    return names
