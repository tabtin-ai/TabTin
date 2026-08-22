"""#7657：Organization 云盘文件夹私有化数据清理。

覆盖两类历史脏数据（产品确认：删异常/无主夹，资源保留到云盘根）：

1. **无主**（``created_by_id IS NULL``）：资源脱离到根；其下仍有创建者的子夹
   上提到最近有主祖先（或根）；再删除无主夹树。
2. **跨创建者嵌套**（子夹 ``created_by`` ≠ 父夹）：整棵异常子树资源脱离后删除。

``cleanup_org_collection_privacy_7657`` 是发布门禁入口（migration / manage 命令共用）。
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Callable, Optional
from uuid import UUID

logger = logging.getLogger(__name__)


@dataclass
class MixedOwnerCleanupStats:
    """兼容旧字段名；同时承载无主清理统计。"""

    scanned_boundaries: int = 0
    topmost_roots: int = 0
    folders_deleted: int = 0
    items_detached: int = 0
    orphan_items_detached: int = 0
    skipped: int = 0
    null_owner_scanned: int = 0
    null_owner_folders_deleted: int = 0
    owned_reparented: int = 0
    audit_rows: list[dict] = field(default_factory=list)

    def merge(self, other: "MixedOwnerCleanupStats") -> None:
        self.scanned_boundaries += other.scanned_boundaries
        self.topmost_roots += other.topmost_roots
        self.folders_deleted += other.folders_deleted
        self.items_detached += other.items_detached
        self.orphan_items_detached += other.orphan_items_detached
        self.skipped += other.skipped
        self.null_owner_scanned += other.null_owner_scanned
        self.null_owner_folders_deleted += other.null_owner_folders_deleted
        self.owned_reparented += other.owned_reparented
        self.audit_rows.extend(other.audit_rows)


def _collect_subtree_ids(root_id: UUID) -> set[UUID]:
    from apps.tabtinspace.models import Collection

    result: set[UUID] = {root_id}
    queue = [root_id]
    while queue:
        parent_id = queue.pop(0)
        child_ids = list(
            Collection.objects.filter(parent_id=parent_id).values_list("id", flat=True)
        )
        for cid in child_ids:
            if cid not in result:
                result.add(cid)
                queue.append(cid)
    return result


def _has_ancestor_in(collection_id: UUID, ancestor_ids: set[UUID]) -> bool:
    from apps.tabtinspace.models import Collection

    current_id = collection_id
    seen: set[UUID] = set()
    while current_id is not None:
        if current_id in seen:
            break
        seen.add(current_id)
        parent_id = (
            Collection.objects.filter(id=current_id)
            .values_list("parent_id", flat=True)
            .first()
        )
        if parent_id is None:
            return False
        if parent_id in ancestor_ids:
            return True
        current_id = parent_id
    return False


def _nearest_owned_ancestor_id(
    start_parent_id: Optional[UUID],
    null_ids: set[UUID],
) -> Optional[UUID]:
    """沿父链上找第一个不在 null_ids 内的祖先；没有则返回 None（根）。"""
    from apps.tabtinspace.models import Collection

    current_id = start_parent_id
    seen: set[UUID] = set()
    while current_id is not None:
        if current_id in seen:
            break
        seen.add(current_id)
        if current_id not in null_ids:
            return current_id
        current_id = (
            Collection.objects.filter(id=current_id)
            .values_list("parent_id", flat=True)
            .first()
        )
    return None


def _resolve_reparent_name(coll, new_parent_id: Optional[UUID]) -> str:
    """同创建者 + 同级下避免撞名。

    追加 `` (N)`` 前按 ``Collection.name`` 字段上限截断 base，
    后缀位数增长时（如 `` (10)``）也始终保证候选名不超过 max_length。
    """
    from apps.tabtinspace.models import Collection

    max_len = Collection._meta.get_field("name").max_length
    base = coll.name[:max_len]
    candidate = base
    suffix = 1
    while True:
        qs = Collection.objects.filter(
            organization_id=coll.organization_id,
            created_by_id=coll.created_by_id,
            name=candidate,
        ).exclude(id=coll.id)
        if new_parent_id is None:
            qs = qs.filter(parent__isnull=True)
        else:
            qs = qs.filter(parent_id=new_parent_id)
        if not qs.exists():
            return candidate
        suffix += 1
        tag = f" ({suffix})"
        candidate = f"{base[: max_len - len(tag)]}{tag}"


def find_mixed_owner_topmost_roots(
    *,
    organization_id: Optional[str | UUID] = None,
) -> list:
    """返回跨创建者嵌套的顶层异常根（不含已被祖先覆盖的节点）。"""
    from apps.tabtinspace.models import Collection

    qs = (
        Collection.objects
        .filter(organization__isnull=False, parent__isnull=False)
        .select_related("parent")
        .only(
            "id", "name", "organization_id", "created_by_id",
            "parent_id", "parent__created_by_id",
        )
    )
    if organization_id:
        qs = qs.filter(organization_id=organization_id)

    boundaries = []
    for coll in qs.iterator():
        parent = coll.parent
        if parent is None:
            continue
        if parent.created_by_id != coll.created_by_id:
            boundaries.append(coll)

    boundary_ids = {c.id for c in boundaries}
    return [
        coll for coll in boundaries
        if not _has_ancestor_in(coll.id, boundary_ids - {coll.id})
    ]


def cleanup_null_owner_org_collections(
    *,
    organization_id: Optional[str | UUID] = None,
    dry_run: bool = False,
    batch_log: Optional[Callable[[str], None]] = None,
) -> MixedOwnerCleanupStats:
    """删除 ``created_by IS NULL`` 的 org Collection；资源脱离；有主子夹上提。"""
    from apps.tabtinspace.models import Collection, ContextItem

    log = batch_log or (lambda msg: None)
    stats = MixedOwnerCleanupStats()

    qs = Collection.objects.filter(
        organization__isnull=False,
        created_by__isnull=True,
    )
    if organization_id:
        qs = qs.filter(organization_id=organization_id)

    null_rows = list(
        qs.only("id", "name", "organization_id", "parent_id", "created_by_id")
    )
    null_ids = {row.id for row in null_rows}
    stats.null_owner_scanned = len(null_ids)
    if not null_ids:
        return stats

    # 顶层无主节点（父为空或不在无主集合）——用于审计
    topmost = [
        row for row in null_rows
        if row.parent_id is None or row.parent_id not in null_ids
    ]

    items = list(
        ContextItem.objects.filter(collection_id__in=null_ids)
        .only("id", "collection_id", "created_by_id")
    )
    owned_items = [i for i in items if i.created_by_id]
    orphan_items = [i for i in items if not i.created_by_id]

    owned_children = list(
        Collection.objects.filter(
            organization__isnull=False,
            parent_id__in=null_ids,
            created_by__isnull=False,
        ).only(
            "id", "name", "organization_id", "parent_id",
            "created_by_id", "updated_at",
        )
    )

    for root in topmost:
        subtree_null_ids = {
            cid for cid in _collect_subtree_ids(root.id) if cid in null_ids
        }
        stats.audit_rows.append({
            "collection_id": str(root.id),
            "name": root.name,
            "organization_id": str(root.organization_id or ""),
            "created_by_id": "",
            "parent_created_by_id": "",
            "subtree_folder_count": len(subtree_null_ids),
            "items_detached": sum(
                1 for i in owned_items if i.collection_id in subtree_null_ids
            ),
            "orphan_items_detached": sum(
                1 for i in orphan_items if i.collection_id in subtree_null_ids
            ),
            "reason": "null_owner_org_collection",
        })

    log(
        f"  cleanup null-owner org collections: scanned={len(null_ids)} "
        f"topmost={len(topmost)} items={len(items)} "
        f"owned_children_to_reparent={len(owned_children)}"
    )

    if dry_run:
        stats.null_owner_folders_deleted = len(null_ids)
        stats.folders_deleted = len(null_ids)
        stats.items_detached = len(owned_items)
        stats.orphan_items_detached = len(orphan_items)
        stats.owned_reparented = len(owned_children)
        return stats

    ContextItem.objects.filter(collection_id__in=null_ids).update(collection_id=None)
    stats.items_detached = len(owned_items)
    stats.orphan_items_detached = len(orphan_items)

    for coll in owned_children:
        new_parent_id = _nearest_owned_ancestor_id(coll.parent_id, null_ids)
        new_name = _resolve_reparent_name(coll, new_parent_id)
        update_fields = ["parent_id", "updated_at"]
        coll.parent_id = new_parent_id
        if new_name != coll.name:
            coll.name = new_name
            update_fields.append("name")
        coll.save(update_fields=update_fields)
        stats.owned_reparented += 1
        log(
            f"    reparent owned coll={coll.id} -> parent={new_parent_id} "
            f"name={coll.name!r}"
        )

    deleted_count, _ = Collection.objects.filter(id__in=null_ids).delete()
    stats.null_owner_folders_deleted = len(null_ids)
    stats.folders_deleted = len(null_ids)
    if deleted_count < len(null_ids):
        stats.skipped += 1
        log(f"    warn: null-owner delete expected>={len(null_ids)} got {deleted_count}")

    remaining = Collection.objects.filter(
        organization__isnull=False,
        created_by__isnull=True,
        **({"organization_id": organization_id} if organization_id else {}),
    ).count()
    if remaining:
        stats.skipped += remaining
        logger.error(
            "[#7657] null-owner cleanup left %s org collections with created_by NULL",
            remaining,
        )

    return stats


def cleanup_mixed_owner_org_collections(
    *,
    organization_id: Optional[str | UUID] = None,
    dry_run: bool = False,
    batch_log: Optional[Callable[[str], None]] = None,
) -> MixedOwnerCleanupStats:
    from apps.tabtinspace.models import Collection, ContextItem

    log = batch_log or (lambda msg: None)
    stats = MixedOwnerCleanupStats()

    topmost = find_mixed_owner_topmost_roots(organization_id=organization_id)
    stats.scanned_boundaries = len(topmost)
    stats.topmost_roots = len(topmost)

    for root in topmost:
        subtree_ids = _collect_subtree_ids(root.id)
        items = list(
            ContextItem.objects.filter(collection_id__in=subtree_ids)
            .only("id", "collection_id", "created_by_id", "title", "item_type")
        )
        owned_items = [i for i in items if i.created_by_id]
        orphan_items = [i for i in items if not i.created_by_id]

        log(
            f"  cleanup mixed-owner root={root.id} name={root.name!r} "
            f"org={root.organization_id} folders={len(subtree_ids)} "
            f"items={len(owned_items)} orphans={len(orphan_items)}"
        )
        stats.audit_rows.append({
            "collection_id": str(root.id),
            "name": root.name,
            "organization_id": str(root.organization_id or ""),
            "created_by_id": str(root.created_by_id or ""),
            "parent_created_by_id": str(
                getattr(root.parent, "created_by_id", None) or ""
            ),
            "subtree_folder_count": len(subtree_ids),
            "items_detached": len(owned_items),
            "orphan_items_detached": len(orphan_items),
            "reason": "mixed_owner_nested_folder",
        })

        if dry_run:
            stats.folders_deleted += len(subtree_ids)
            stats.items_detached += len(owned_items)
            stats.orphan_items_detached += len(orphan_items)
            continue

        detached = ContextItem.objects.filter(collection_id__in=subtree_ids).update(
            collection_id=None,
        )
        stats.items_detached += len(owned_items)
        stats.orphan_items_detached += len(orphan_items)
        if detached != len(items):
            logger.warning(
                "[#7657] detach count mismatch root=%s expected=%s actual=%s",
                root.id,
                len(items),
                detached,
            )

        deleted_count, _ = Collection.objects.filter(id__in=subtree_ids).delete()
        stats.folders_deleted += len(subtree_ids)
        if deleted_count < len(subtree_ids):
            stats.skipped += 1
            log(f"    warn: expected delete>={len(subtree_ids)} got {deleted_count}")

    return stats


def cleanup_org_collection_privacy_7657(
    *,
    organization_id: Optional[str | UUID] = None,
    dry_run: bool = False,
    batch_log: Optional[Callable[[str], None]] = None,
) -> MixedOwnerCleanupStats:
    """发布门禁：先清无主夹，再清跨创建者嵌套。"""
    log = batch_log or (lambda msg: None)
    stats = MixedOwnerCleanupStats()

    log("[#7657] phase1: null-owner org collections")
    null_stats = cleanup_null_owner_org_collections(
        organization_id=organization_id,
        dry_run=dry_run,
        batch_log=batch_log,
    )
    stats.merge(null_stats)

    log("[#7657] phase2: mixed-owner nested collections")
    mixed_stats = cleanup_mixed_owner_org_collections(
        organization_id=organization_id,
        dry_run=dry_run,
        batch_log=batch_log,
    )
    stats.merge(mixed_stats)

    return stats


def assert_no_null_owner_org_collections(
    *,
    organization_id: Optional[str | UUID] = None,
) -> int:
    """返回仍存在的无主 org Collection 数量（0 表示门禁通过）。"""
    from apps.tabtinspace.models import Collection

    qs = Collection.objects.filter(
        organization__isnull=False,
        created_by__isnull=True,
    )
    if organization_id:
        qs = qs.filter(organization_id=organization_id)
    return qs.count()
