"""#7160：Collection 文件夹 → 同名空 tabdoc 节点，夹内资源挂到 ContextItem.parent。

幂等：已带 ``metadata.migrated_from_collection_id`` 的 ContextItem 会被复用。
Collection 行本身保留（只读），云文档 UI 不再消费。
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional
from uuid import UUID

from django.db import transaction
from django.db.models import Q

from apps.services.common.db_router import postgres_app_db_alias
from apps.tabtinspace.models import Collection, ContextItem

logger = logging.getLogger(__name__)

MIGRATED_FROM_KEY = "migrated_from_collection_id"


@dataclass
class MigrateCollectionsStats:
    scanned_collections: int = 0
    created_docs: int = 0
    reused_docs: int = 0
    items_relinked: int = 0
    items_skipped: int = 0
    nested_parents_set: int = 0
    mapping: Dict[str, str] = field(default_factory=dict)  # collection_id → context_item_id


def _resolve_organization_id(coll: Collection) -> Optional[UUID]:
    if coll.organization_id:
        return coll.organization_id
    if coll.workspace_id:
        return getattr(coll.workspace, "organization_id", None) or (
            type(coll.workspace).objects.filter(id=coll.workspace_id)
            .values_list("organization_id", flat=True)
            .first()
        )
    if coll.project_id:
        return getattr(coll.project, "organization_id", None) or (
            type(coll.project).objects.filter(id=coll.project_id)
            .values_list("organization_id", flat=True)
            .first()
        )
    return None


def _find_existing_placeholder(collection_id: UUID) -> Optional[ContextItem]:
    return (
        ContextItem.objects.filter(
            item_type="tabdoc",
            metadata__contains={MIGRATED_FROM_KEY: str(collection_id)},
            trashed_at__isnull=True,
        )
        .exclude(status="trashed")
        .first()
    )


def _create_placeholder_doc(
    *,
    organization_id: UUID,
    title: str,
    icon: str,
    collection_id: UUID,
    dry_run: bool,
) -> Optional[ContextItem]:
    if dry_run:
        return None

    from apps.tabdoc.models import Document

    doc = Document.objects.create(
        organization_id=organization_id,
        space_id=None,
        title=(title or "未命名文件夹").strip() or "未命名文件夹",
        icon=icon or "📄",
        description_json={"type": "doc", "content": []},
        description_markdown="",
        description_plaintext="",
        latest_version=1,
    )
    item = ContextItem.objects.create(
        organization_id=organization_id,
        item_type="tabdoc",
        title=doc.title,
        resource_id=str(doc.id),
        metadata={
            MIGRATED_FROM_KEY: str(collection_id),
            "icon": icon or "📄",
            "migrated_from_collection": True,
        },
        order=0,
        is_archived=False,
    )
    return item


def migrate_collections_to_context_parent(
    *,
    organization_id: Optional[str | UUID] = None,
    dry_run: bool = False,
    batch_log: Optional[Callable[[str], None]] = None,
) -> MigrateCollectionsStats:
    """将 Collection 树映射为 ContextItem.parent 树。

    步骤：
    1. 每个 Collection → 同名空 tabdoc ContextItem（幂等）
    2. 嵌套文件夹 → 占位文档的 parent 指向父夹占位文档
    3. 夹内 ContextItem（含 tabfiles）``collection_id`` → ``parent_id``
    """
    log = batch_log or (lambda _msg: None)
    stats = MigrateCollectionsStats()
    alias = postgres_app_db_alias()

    qs = Collection.objects.select_related("workspace", "project").order_by("created_at")
    if organization_id:
        org_uuid = UUID(str(organization_id))
        qs = qs.filter(
            Q(organization_id=org_uuid)
            | Q(workspace__organization_id=org_uuid)
            | Q(project__organization_id=org_uuid)
        )

    collections = list(qs)
    stats.scanned_collections = len(collections)
    log(f"scanned collections={stats.scanned_collections}")

    # collection_id → ContextItem（占位文档）
    coll_to_item: Dict[str, ContextItem] = {}

    with transaction.atomic(using=alias):
        for coll in collections:
            org_id = _resolve_organization_id(coll)
            if not org_id:
                log(f"skip collection={coll.id} reason=no_organization")
                continue

            existing = _find_existing_placeholder(coll.id)
            if existing:
                coll_to_item[str(coll.id)] = existing
                stats.reused_docs += 1
                stats.mapping[str(coll.id)] = str(existing.id)
                continue

            item = _create_placeholder_doc(
                organization_id=org_id,
                title=coll.name or "",
                icon=coll.icon or "",
                collection_id=coll.id,
                dry_run=dry_run,
            )
            if dry_run:
                # dry-run：用假 id 占位，便于后续 relink 计数
                stats.created_docs += 1
                stats.mapping[str(coll.id)] = f"dry-run:{coll.id}"
                continue

            assert item is not None
            coll_to_item[str(coll.id)] = item
            stats.created_docs += 1
            stats.mapping[str(coll.id)] = str(item.id)

        # 嵌套：子夹占位文档挂到父夹占位文档下
        if not dry_run:
            for coll in collections:
                if not coll.parent_id:
                    continue
                child_item = coll_to_item.get(str(coll.id))
                parent_item = coll_to_item.get(str(coll.parent_id))
                if not child_item or not parent_item:
                    continue
                if child_item.parent_id == parent_item.id:
                    continue
                child_item.parent_id = parent_item.id
                child_item.save(update_fields=["parent", "updated_at"])
                stats.nested_parents_set += 1

        # 夹内资源 → parent_id
        for coll in collections:
            target_parent_id = None
            if dry_run:
                if str(coll.id) not in stats.mapping:
                    continue
            else:
                parent_item = coll_to_item.get(str(coll.id))
                if not parent_item:
                    continue
                target_parent_id = parent_item.id

            items = ContextItem.objects.filter(
                collection_id=coll.id,
                trashed_at__isnull=True,
            ).exclude(status="trashed")
            # 不把「本夹的占位文档」再挂到自己下面
            if not dry_run and target_parent_id:
                items = items.exclude(id=target_parent_id)

            for item in items.iterator():
                # 已是占位文档自身
                meta = item.metadata or {}
                if meta.get(MIGRATED_FROM_KEY) == str(coll.id):
                    stats.items_skipped += 1
                    continue
                if dry_run:
                    stats.items_relinked += 1
                    continue
                if item.parent_id == target_parent_id:
                    stats.items_skipped += 1
                    continue
                item.parent_id = target_parent_id
                item.save(update_fields=["parent", "updated_at"])
                stats.items_relinked += 1

        if dry_run:
            transaction.set_rollback(True, using=alias)

    log(
        f"done created={stats.created_docs} reused={stats.reused_docs} "
        f"relinked={stats.items_relinked} nested={stats.nested_parents_set}"
    )
    return stats
