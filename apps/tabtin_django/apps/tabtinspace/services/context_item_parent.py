"""#7160：ContextItem.parent 校验与回收站上提。

层级正典 = ContextItem.parent 自引用。父节点须为同宿主、未进回收站的
tabdoc/tabdata；防环 + 最大深度；进回收站时子节点上提到祖父。
"""
from __future__ import annotations

import logging
from typing import Optional
from uuid import UUID

from django.db import transaction
from django.utils.translation import gettext_lazy as _

from apps.services.common.db_router import postgres_app_db_alias
from apps.tabtinspace.models import ContextItem

logger = logging.getLogger(__name__)

TREE_PARENT_ITEM_TYPES = ContextItem.TREE_PARENT_ITEM_TYPES
MAX_PARENT_DEPTH = ContextItem.MAX_PARENT_DEPTH


class ContextItemParentError(ValueError):
    """父节点校验失败（可直接映射到 API 400）。"""


def _same_host(child_like: ContextItem, parent: ContextItem) -> bool:
    return (
        child_like.organization_id == parent.organization_id
        and child_like.workspace_id == parent.workspace_id
        and child_like.project_id == parent.project_id
    )


def resolve_parent_item(parent_item_id: Optional[UUID | str]) -> Optional[ContextItem]:
    if parent_item_id in (None, ""):
        return None
    try:
        return ContextItem.objects.get(id=parent_item_id)
    except (ContextItem.DoesNotExist, ValueError, TypeError) as exc:
        raise ContextItemParentError(_("tabtinspace.parent_item_not_found")) from exc


def validate_parent_for_item(
    *,
    item: Optional[ContextItem],
    parent: Optional[ContextItem],
    host_item: Optional[ContextItem] = None,
) -> None:
    """校验 ``item``（或新建时的 ``host_item`` 宿主占位）能否挂到 ``parent``。

    - ``parent is None``：落根，始终合法
    - 父类型必须 ∈ {tabdoc, tabdata}
    - 父未进回收站
    - 同宿主（organization / workspace / project 三者对齐）
    - 防自环 / 祖先环
    - 挂入后深度 < MAX_PARENT_DEPTH（父深度 + 1 < 上限 → 父深度最大为 MAX-1）
    """
    if parent is None:
        return

    if parent.item_type not in TREE_PARENT_ITEM_TYPES:
        raise ContextItemParentError(_("tabtinspace.parent_item_invalid_type"))

    if parent.trashed_at is not None or parent.status == "trashed":
        raise ContextItemParentError(_("tabtinspace.parent_item_trashed"))

    host = item or host_item
    if host is not None and not _same_host(host, parent):
        raise ContextItemParentError(_("tabtinspace.parent_item_cross_host"))

    if item is not None and parent.id == item.id:
        raise ContextItemParentError(_("tabtinspace.parent_item_cycle"))

    if item is not None:
        # 防环：沿 parent 链向上，不能碰到 item
        cursor = parent
        seen = {item.id}
        while cursor is not None:
            if cursor.id in seen:
                raise ContextItemParentError(_("tabtinspace.parent_item_cycle"))
            seen.add(cursor.id)
            if cursor.parent_id is None:
                break
            try:
                cursor = ContextItem.objects.only(
                    "id", "parent_id",
                ).get(id=cursor.parent_id)
            except ContextItem.DoesNotExist:
                break

    parent_depth = parent.get_parent_depth()
    if parent_depth + 1 >= MAX_PARENT_DEPTH:
        raise ContextItemParentError(_("tabtinspace.parent_item_max_depth"))


def assign_parent(
    item: ContextItem,
    parent_item_id: Optional[UUID | str],
    *,
    save: bool = True,
) -> ContextItem:
    """设置 item.parent（含校验）。``parent_item_id=""`` / None 表示移到根。"""
    if parent_item_id == "":
        parent = None
    else:
        parent = resolve_parent_item(parent_item_id)
    validate_parent_for_item(item=item, parent=parent)
    item.parent = parent
    if save:
        item.save(update_fields=["parent", "updated_at"])
    return item


def promote_children_on_trash(item: ContextItem) -> int:
    """节点进回收站时：直接子节点上提到祖父（item.parent），避免子树随父消失。

    返回被上提的子节点数。
    """
    grandparent_id = item.parent_id
    updated = (
        ContextItem.objects.filter(parent_id=item.id, trashed_at__isnull=True)
        .exclude(status="trashed")
        .update(parent_id=grandparent_id)
    )
    if updated:
        logger.info(
            "[ContextItemParent] promote_children_on_trash item=%s count=%s grandparent=%s",
            item.id,
            updated,
            grandparent_id,
        )
    return updated


def sanitize_parent_on_restore(item: ContextItem) -> bool:
    """恢复时：若原 parent 已不存在/已回收，则落根。返回是否改写了 parent。"""
    if item.parent_id is None:
        return False
    try:
        parent = ContextItem.objects.only(
            "id", "trashed_at", "status", "item_type",
            "organization_id", "workspace_id", "project_id",
            "parent_id",
        ).get(id=item.parent_id)
    except ContextItem.DoesNotExist:
        item.parent = None
        item.save(update_fields=["parent", "updated_at"])
        return True

    try:
        validate_parent_for_item(item=item, parent=parent)
    except ContextItemParentError:
        item.parent = None
        item.save(update_fields=["parent", "updated_at"])
        return True
    return False


@transaction.atomic(using=postgres_app_db_alias())
def set_parent_for_new_item(
    item: ContextItem,
    parent_item_id: Optional[UUID | str],
) -> ContextItem:
    """新建 ContextItem 后挂父（供 ResourceBridge / 迁移命令调用）。"""
    return assign_parent(item, parent_item_id, save=True)
