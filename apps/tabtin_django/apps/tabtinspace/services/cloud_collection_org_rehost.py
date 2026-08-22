"""#7140：把因云资产引用而"该属于组织"的历史 Collection 树收敛到 organization。

背景：Collection 新增了 organization-only 归属态（ migrations 0126/0127），
但历史 workspace/project 文件夹树里可能已经存在被 tabdoc/tabdata/tabfiles
等云资产通过 ``collection_id`` 引用的文件夹——这些文件夹应该整体收敛为
org-only，否则云资产列表在 organization 维度看不到自己的文件夹结构。

候选发现规则：
1. 找到被云资产（tabdoc/tabdata/tabfiles）通过 ``collection_id`` 引用、且仍
   挂 workspace/project 的 Collection。
2. 沿 ``parent`` 链向上收集祖先，直到根节点；若链上任意节点带
   ``system_key``（规划夹，模型 docstring 约定永远只挂 Space），整条链跳过。
3. 对每个候选根节点，收敛其整棵子树（含未被直接引用的子文件夹），保持树内
   父子关系一致；子树内若出现 ``system_key`` 节点，该节点及其子树保留在
   原宿主，不随迁移（属已知边界，详见函数 docstring）。

宿主迁移：UPDATE ``organization_id``，清空 ``workspace_id`` / ``project_id``
（保留 ``id`` / ``parent_id``）；根节点如与目标 organization 下已有的根级
同名文件夹冲突，追加 `` (migrated)`` 或 `` (2)`` 等后缀去重。

随后把这些 Collection 树内仍挂 workspace/project 的云资产 ContextItem
（tabdoc/tabdata/tabfiles）一并收敛到 organization（复用
``_resolve_created_by_id`` 做 created_by 回填 + 同资源去重逻辑的简化版，
范围仅限这些 collection 树内的条目，不动树外的历史云资产）。

不放宽  默认私有 ACL，只做宿主迁移。
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Optional
from uuid import UUID

from django.db.models import Q

from apps.tabtinspace.services.cloud_org_host_rehost import _resolve_created_by_id
from apps.tabtinspace.services.cloud_resource_acl import CLOUD_ITEM_TYPES

logger = logging.getLogger(__name__)


@dataclass
class CollectionRehostStats:
    scanned: int = 0
    rehosted: int = 0
    renamed: int = 0
    items_rehosted: int = 0
    items_deduped_deleted: int = 0
    created_by_filled: int = 0
    skipped_no_org: int = 0
    audit_rows: list[dict] = field(default_factory=list)


def _resolve_host_organization_id(collection) -> Optional[str]:
    """按 Collection 当前 workspace/project 宿主解析 organization_id。"""
    if collection.organization_id:
        return str(collection.organization_id)
    if collection.workspace_id:
        from apps.tabtinspace.models import Workspace

        oid = (
            Workspace.objects.filter(id=collection.workspace_id)
            .values_list("organization_id", flat=True)
            .first()
        )
        if oid:
            return str(oid)
    if collection.project_id:
        from apps.tabtinspace.models import Project

        oid = (
            Project.objects.filter(id=collection.project_id)
            .values_list("organization_id", flat=True)
            .first()
        )
        if oid:
            return str(oid)
    return None


def _resolve_root_and_chain(collection):
    """沿 ``parent`` 链向上找根节点，返回 ``(chain, root)``；chain 为 leaf→root，含环保护。"""
    from apps.tabtinspace.models import Collection as CollectionModel

    chain = [collection]
    seen = {collection.id}
    current = collection
    while current.parent_id is not None:
        if current.parent_id in seen:
            break
        parent = CollectionModel.objects.filter(id=current.parent_id).first()
        if parent is None:
            break
        seen.add(parent.id)
        chain.append(parent)
        current = parent
    return chain, chain[-1]


def _collect_subtree_ids(root_id) -> set:
    """BFS 收集 root 及其所有后代 Collection id；``system_key`` 节点及其子树被剪掉不迁移。"""
    from apps.tabtinspace.models import Collection as CollectionModel

    result: set = set()
    queue = [root_id]
    while queue:
        cid = queue.pop(0)
        node = CollectionModel.objects.filter(id=cid).only("id", "system_key").first()
        if node is None:
            continue
        if node.system_key:
            continue
        result.add(cid)
        children = list(
            CollectionModel.objects.filter(parent_id=cid).values_list("id", flat=True)
        )
        queue.extend(children)
    return result


def _find_candidate_root_ids(*, organization_id: Optional[str] = None) -> set:
    """找出被云资产（tabdoc/tabdata/tabfiles）通过 collection_id 引用、
    仍挂 workspace/project 的 Collection 所在树的根节点 id 集合。"""
    from apps.tabtinspace.models import Collection as CollectionModel, ContextItem

    qs = ContextItem.objects.filter(
        item_type__in=CLOUD_ITEM_TYPES,
        collection_id__isnull=False,
    ).filter(
        Q(collection__workspace__isnull=False) | Q(collection__project__isnull=False)
    )
    if organization_id:
        qs = qs.filter(
            Q(collection__workspace__organization_id=organization_id)
            | Q(collection__project__organization_id=organization_id)
        )
    leaf_ids = set(qs.values_list("collection_id", flat=True).distinct())

    root_ids: set = set()
    for leaf_id in leaf_ids:
        leaf = CollectionModel.objects.filter(id=leaf_id).first()
        if leaf is None or leaf.system_key:
            continue
        chain, root = _resolve_root_and_chain(leaf)
        if any(node.system_key for node in chain):
            continue
        root_ids.add(root.id)
    return root_ids


def _resolve_conflict_free_name(organization_id: str, name: str) -> str:
    """org 根级文件夹名冲突时追加 `` (migrated)`` / `` (2)`` 等后缀去重。"""
    from apps.tabtinspace.models import Collection as CollectionModel

    def _taken(candidate: str) -> bool:
        return CollectionModel.objects.filter(
            organization_id=organization_id, parent__isnull=True, name=candidate,
        ).exists()

    if not _taken(name):
        return name
    candidate = f"{name} (migrated)"
    if not _taken(candidate):
        return candidate
    suffix = 2
    while _taken(f"{candidate} ({suffix})"):
        suffix += 1
    return f"{candidate} ({suffix})"


def _rehost_items_in_collections(
    collection_ids: set,
    target_org: str,
    *,
    dry_run: bool,
    batch_log,
) -> tuple[int, int, int]:
    """把 collection_ids 树内仍挂 workspace/project 的云资产 ContextItem 收敛到 organization。

    简化版  逻辑：范围限定在传入的 collection_ids（不扫描树外的历史云资产）。
    """
    from apps.tabtinspace.models import ContextItem

    rehosted = 0
    deduped_deleted = 0
    created_by_filled = 0

    items = list(
        ContextItem.objects.filter(
            collection_id__in=collection_ids,
            item_type__in=CLOUD_ITEM_TYPES,
            organization_id__isnull=True,
        ).filter(Q(workspace_id__isnull=False) | Q(project_id__isnull=False))
    )
    for item in items:
        rid = str(item.resource_id or "").strip()
        if not rid:
            continue
        created_by_id = _resolve_created_by_id(item)
        existing = (
            ContextItem.objects.filter(
                item_type=item.item_type,
                resource_id=rid,
                organization_id=target_org,
            )
            .exclude(id=item.id)
            .first()
        )
        if existing is not None:
            batch_log(
                f"    dedupe item legacy={item.id} keep={existing.id} "
                f"type={item.item_type} resource={rid}"
            )
            if not dry_run:
                update_fields = []
                if not existing.created_by_id and created_by_id:
                    existing.created_by_id = created_by_id
                    existing.updated_by_id = created_by_id
                    update_fields.extend(["created_by_id", "updated_by_id"])
                    created_by_filled += 1
                if existing.collection_id is None and item.collection_id is not None:
                    existing.collection_id = item.collection_id
                    update_fields.append("collection_id")
                if update_fields:
                    update_fields.append("updated_at")
                    existing.save(update_fields=update_fields)
                ContextItem.objects.filter(id=item.id).delete()
            deduped_deleted += 1
            continue

        batch_log(
            f"    rehost item={item.id} type={item.item_type} resource={rid} org={target_org}"
        )
        if not dry_run:
            update_kwargs = {
                "organization_id": target_org,
                "workspace_id": None,
                "project_id": None,
            }
            if created_by_id and not item.created_by_id:
                update_kwargs["created_by_id"] = created_by_id
                update_kwargs["updated_by_id"] = created_by_id
                created_by_filled += 1
            ContextItem.objects.filter(id=item.id).update(**update_kwargs)
        elif created_by_id and not item.created_by_id:
            created_by_filled += 1
        rehosted += 1

    return rehosted, deduped_deleted, created_by_filled


def rehost_cloud_collections_to_organization(
    *,
    organization_id: Optional[str | UUID] = None,
    dry_run: bool = False,
    batch_log=None,
) -> CollectionRehostStats:
    """#7140：把因云资产引用而需要 org 化的 Collection 树整体收敛到 organization。

    - ``dry_run=True``：只统计 / 审计，不写库
    - ``organization_id``：只处理该 organization 下的候选树
    """
    from apps.tabtinspace.models import Collection as CollectionModel

    org_filter = str(organization_id) if organization_id else None
    stats = CollectionRehostStats()
    log = batch_log or (lambda msg: None)

    root_ids = _find_candidate_root_ids(organization_id=org_filter)
    stats.scanned = len(root_ids)

    for root_id in sorted(root_ids, key=str):
        root = CollectionModel.objects.filter(id=root_id).first()
        if root is None:
            continue

        target_org = _resolve_host_organization_id(root)
        if not target_org:
            stats.skipped_no_org += 1
            stats.audit_rows.append({
                "collection_id": str(root.id),
                "name": root.name,
                "organization_id": "",
                "reason": "cannot_resolve_organization_id",
            })
            continue
        if org_filter and target_org != org_filter:
            continue

        subtree_ids = _collect_subtree_ids(root.id)
        if root.id not in subtree_ids:
            # 防御性分支：root 本身带 system_key（_find_candidate_root_ids 已排除，正常不会命中）。
            continue

        final_name = _resolve_conflict_free_name(target_org, root.name)
        if final_name != root.name:
            stats.renamed += 1
            log(
                f"  rename root={root.id} '{root.name}' -> '{final_name}' "
                f"(name conflict in org={target_org})"
            )

        log(
            f"  rehost collection tree root={root.id} name={final_name} "
            f"nodes={len(subtree_ids)} org={target_org}"
        )
        if not dry_run:
            CollectionModel.objects.filter(id=root.id).update(
                organization_id=target_org,
                workspace_id=None,
                project_id=None,
                name=final_name,
            )
            other_ids = subtree_ids - {root.id}
            if other_ids:
                CollectionModel.objects.filter(id__in=other_ids).update(
                    organization_id=target_org,
                    workspace_id=None,
                    project_id=None,
                )
        stats.rehosted += 1

        items_rehosted, items_deduped, created_by_filled = _rehost_items_in_collections(
            subtree_ids, target_org, dry_run=dry_run, batch_log=log,
        )
        stats.items_rehosted += items_rehosted
        stats.items_deduped_deleted += items_deduped
        stats.created_by_filled += created_by_filled

    return stats
