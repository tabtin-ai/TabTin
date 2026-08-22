"""Notion 式云文档知识库树 — 只读聚合服务。

#7160 / ：云文档树的唯一层级正典是 ``ContextItem.parent``。
云盘 Organization Collection / ``collection_id`` 是平行系统，本服务不得读取或投影。
"""
from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional, Set, Tuple
from uuid import UUID

from apps.tabtinspace.services.base import BaseService, ServiceError
from apps.tabtinspace.services.context_item_service import ContextItemService

logger = logging.getLogger(__name__)

MAX_TREE_DEPTH = 10  # ：与 ContextItem.MAX_PARENT_DEPTH 对齐
MAX_TREE_ITEMS = 5000
ORPHAN_POLICY = "promote_to_root"


class KnowledgeTreeService(BaseService):
    """组装云文档知识库树（仅 ContextItem.parent；与云盘 Collection 解耦）。"""

    def build_tree(
        self,
        *,
        organization_id: UUID,
        item_types: Optional[Set[str]] = None,
        depth: int = 2,
        owned_only: bool = False,
    ) -> Dict[str, Any]:
        if not self.check_organization_permission(str(organization_id), "viewer"):
            return self._empty_response(organization_id)

        allowed_types = item_types or {"tabdoc", "tabdata"}
        max_depth = max(1, min(int(depth), MAX_TREE_DEPTH))

        ctx_service = ContextItemService(user=self.user)
        items = ctx_service.list_all_visible_cloud_items_for_tree(
            organization_id=organization_id,
            item_types=allowed_types,
            limit=MAX_TREE_ITEMS,
            owned_only=owned_only,
        )

        roots, stats, warnings = self._assemble(
            items=items,
            max_depth=max_depth,
        )

        return {
            "organization_id": str(organization_id),
            "folder_scope": "none",
            "orphan_policy": ORPHAN_POLICY,
            "roots": roots,
            "stats": stats,
            "warnings": warnings,
        }

    def _empty_response(self, organization_id: UUID) -> Dict[str, Any]:
        return {
            "organization_id": str(organization_id),
            "folder_scope": "none",
            "orphan_policy": ORPHAN_POLICY,
            "roots": [],
            "stats": {"folder_count": 0, "doc_count": 0, "table_count": 0, "orphan_count": 0},
            "warnings": [],
        }

    def _assemble(
        self,
        *,
        items,
        max_depth: int,
    ) -> Tuple[List[Dict[str, Any]], Dict[str, int], List[str]]:
        warnings: List[str] = []
        item_by_id = {str(item.id): item for item in items}

        #  正典：仅按 ContextItem.parent 分组；collection_id 留给云盘，不进树
        by_parent_item: Dict[Optional[str], List] = {}
        orphan_count = 0

        for item in items:
            parent_item_id = str(item.parent_id) if getattr(item, "parent_id", None) else None
            if parent_item_id:
                if parent_item_id not in item_by_id:
                    orphan_count += 1
                    warnings.append(f"orphan_parent:{parent_item_id}:item:{item.id}")
                    by_parent_item.setdefault(None, []).append(item)
                else:
                    by_parent_item.setdefault(parent_item_id, []).append(item)
                continue
            # parent 为空 → 云文档根（即使仍挂着云盘 collection_id）
            by_parent_item.setdefault(None, []).append(item)

        def sort_items(rows: List) -> List:
            return sorted(
                rows,
                key=lambda r: (
                    0 if r.is_pinned else 1,
                    -(r.pinned_at.timestamp() if r.pinned_at else 0),
                    r.order if r.order is not None else 0,
                    -(r.updated_at.timestamp() if r.updated_at else 0),
                ),
            )

        def _children_for_item(item) -> List:
            return list(by_parent_item.get(str(item.id), []))

        def resource_node(item, *, depth: int, parent_node_id=None, parent_node_type=None) -> Dict[str, Any]:
            node_type = "tabdoc" if item.item_type == "tabdoc" else "tabdata"
            child_items_all = _children_for_item(item)
            child_count = len(child_items_all)
            children: List[Dict[str, Any]] = []
            if depth < max_depth:
                children = [
                    resource_node(
                        child,
                        depth=depth + 1,
                        parent_node_id=str(item.id),
                        parent_node_type=node_type,
                    )
                    for child in sort_items(child_items_all)
                ]

            return {
                "id": str(item.id),
                "node_type": node_type,
                "resource_id": item.resource_id,
                "context_item_id": str(item.id),
                "parent_node_id": parent_node_id or (
                    str(item.parent_id) if getattr(item, "parent_id", None) else None
                ),
                "parent_node_type": parent_node_type,
                # collection_id 仍透出供诊断；云文档 UI 不得用它建树
                "collection_id": str(item.collection_id) if item.collection_id else None,
                "parent_id": str(item.parent_id) if getattr(item, "parent_id", None) else None,
                "title": item.title or "",
                "icon": (item.metadata or {}).get("icon") if isinstance(item.metadata, dict) else None,
                "order": item.order or 0,
                "is_pinned": bool(item.is_pinned),
                "updated_at": item.updated_at.isoformat() if item.updated_at else None,
                "child_count": child_count,
                "children": children,
            }

        roots: List[Dict[str, Any]] = [
            resource_node(item, depth=1)
            for item in sort_items(by_parent_item.get(None, []))
        ]

        pinned_roots = [n for n in roots if n.get("is_pinned")]
        normal_roots = [n for n in roots if not n.get("is_pinned")]
        roots = pinned_roots + normal_roots

        stats = {
            "folder_count": 0,
            "doc_count": sum(1 for i in items if i.item_type == "tabdoc"),
            "table_count": sum(1 for i in items if i.item_type == "tabdata"),
            "orphan_count": orphan_count,
        }
        return roots, stats, warnings

    def list_node_children(
        self,
        *,
        organization_id: UUID,
        node_id: UUID,
        node_type: str,
        item_types: Optional[Set[str]] = None,
        owned_only: bool = False,
    ) -> List[Dict[str, Any]]:
        if not self.check_organization_permission(str(organization_id), "viewer"):
            return []

        # Collection/folder 节点已退役；仅 tabdoc / tabdata 可展开
        if node_type not in ("tabdoc", "tabdata"):
            return []

        allowed_types = item_types or {"tabdoc", "tabdata"}
        ctx_service = ContextItemService(user=self.user)
        items = ctx_service.list_all_visible_cloud_items_for_tree(
            organization_id=organization_id,
            item_types=allowed_types,
            limit=MAX_TREE_ITEMS,
            owned_only=owned_only,
        )

        by_parent_item: Dict[Optional[str], List] = {}
        for item in items:
            if getattr(item, "parent_id", None):
                by_parent_item.setdefault(str(item.parent_id), []).append(item)

        def sort_items(rows: List) -> List:
            return sorted(
                rows,
                key=lambda r: (
                    0 if r.is_pinned else 1,
                    -(r.pinned_at.timestamp() if r.pinned_at else 0),
                    r.order if r.order is not None else 0,
                    -(r.updated_at.timestamp() if r.updated_at else 0),
                ),
            )

        def resource_node(item, *, parent_node_id=None, parent_node_type=None) -> Dict[str, Any]:
            node_kind = "tabdoc" if item.item_type == "tabdoc" else "tabdata"
            child_count = len(by_parent_item.get(str(item.id), []))
            return {
                "id": str(item.id),
                "node_type": node_kind,
                "resource_id": item.resource_id,
                "context_item_id": str(item.id),
                "parent_node_id": parent_node_id,
                "parent_node_type": parent_node_type,
                "collection_id": str(item.collection_id) if item.collection_id else None,
                "parent_id": str(item.parent_id) if getattr(item, "parent_id", None) else None,
                "title": item.title or "",
                "icon": (item.metadata or {}).get("icon") if isinstance(item.metadata, dict) else None,
                "order": item.order or 0,
                "is_pinned": bool(item.is_pinned),
                "updated_at": item.updated_at.isoformat() if item.updated_at else None,
                "child_count": child_count,
                "children": [],
            }

        from apps.tabtinspace.models import ContextItem

        try:
            ctx_item = ContextItem.objects.get(id=node_id, organization_id=organization_id)
        except ContextItem.DoesNotExist:
            return []

        kids = list(by_parent_item.get(str(ctx_item.id), []))
        return [
            resource_node(
                item,
                parent_node_id=str(ctx_item.id),
                parent_node_type=node_type,
            )
            for item in sort_items(kids)
        ]

    def reorder_siblings(
        self,
        *,
        organization_id: UUID,
        parent_id: Optional[UUID],
        item_ids: List[UUID],
    ) -> int:
        """按 ContextItem.parent 同级重排 ``order``，不校验 / 不改写 collection_id。"""
        if not self.check_organization_permission(str(organization_id), "editor"):
            raise ServiceError("PERMISSION_DENIED", "没有权限重排知识树", status=403)
        if not item_ids:
            return 0

        from apps.tabtinspace.models import ContextItem
        from apps.tabtinspace.services.cloud_resource_acl import check_item_resource_permission

        if parent_id is not None:
            parent_ok = ContextItem.objects.filter(
                id=parent_id,
                organization_id=organization_id,
                item_type__in=("tabdoc", "tabdata"),
                trashed_at__isnull=True,
                is_archived=False,
            ).exists()
            if not parent_ok:
                raise ServiceError("PARENT_NOT_FOUND", "父节点不存在或不可用", status=404)

        updated = 0
        for idx, item_id in enumerate(item_ids):
            try:
                item = ContextItem.objects.get(
                    id=item_id,
                    organization_id=organization_id,
                    item_type__in=("tabdoc", "tabdata"),
                )
            except ContextItem.DoesNotExist:
                continue
            if item.parent_id != parent_id:
                continue
            if not check_item_resource_permission(self.user, item, "editor"):
                continue
            if item.order != idx:
                ContextItem.objects.filter(id=item.id).update(order=idx)
            updated += 1
        return updated
