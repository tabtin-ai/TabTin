"""Permission-safe location metadata for resources shared with another user.

The shared-with-me APIs expose a resource independently from its owner's
Workspace.  A resource permission does not imply permission to browse the
owner's folder tree, so callers must not serialize ``Collection`` names
without checking the collection host first.
"""
from __future__ import annotations

from collections.abc import Iterable
from typing import Any

from apps.tabtinspace.models import Collection, ContextItem
from apps.tabtinspace.services.base import BaseService


SharedLocation = dict[str, Any]


def _collection_host(collection: Collection) -> tuple[str, str] | None:
    if collection.organization_id:
        return "organization", str(collection.organization_id)
    if collection.workspace_id:
        return "space", str(collection.workspace_id)
    if collection.project_id:
        return "space", str(collection.project_id)
    return None


def _collection_organization_id(collection: Collection) -> str | None:
    if collection.organization_id:
        return str(collection.organization_id)
    if collection.workspace_id:
        return str(collection.workspace.organization_id)
    if collection.project_id:
        return str(collection.project.organization_id)
    return None


def _can_view_collection(
    collection: Collection,
    *,
    viewer,
    permission_service: BaseService,
) -> bool:
    """Mirror CollectionService's read contract without exposing its tree."""
    if collection.organization_id:
        # org-only collections are private to their creator .
        return bool(viewer and collection.created_by_id == viewer.id)
    host = _collection_host(collection)
    return bool(host and permission_service.check_space_permission(host[1], "viewer"))


def build_shared_resource_locations(
    viewer,
    items: Iterable[ContextItem],
) -> dict[str, SharedLocation]:
    """Return a permission-safe location for each supplied ContextItem.

    ``restricted`` deliberately contains no collection id or name.  Knowing a
    shared resource does not grant access to its owner's private folder tree.
    """
    item_list = list(items)
    locations: dict[str, SharedLocation] = {}
    collection_ids = {item.collection_id for item in item_list if item.collection_id}
    collections: dict[str, Collection] = {}

    pending_ids = set(collection_ids)
    for _ in range(Collection.MAX_NESTING_DEPTH + 1):
        if not pending_ids:
            break
        batch = list(
            Collection.objects.filter(id__in=pending_ids)
            .select_related("workspace", "project")
            .only(
                "id",
                "name",
                "parent_id",
                "workspace_id",
                "workspace__organization_id",
                "project_id",
                "project__organization_id",
                "organization_id",
                "created_by_id",
            )
        )
        pending_ids = set()
        for collection in batch:
            collections[str(collection.id)] = collection
            if collection.parent_id and str(collection.parent_id) not in collections:
                pending_ids.add(collection.parent_id)

    permission_service = BaseService(user=viewer)
    for item in item_list:
        item_id = str(item.id)
        if not item.collection_id:
            locations[item_id] = {"kind": "root"}
            continue

        leaf = collections.get(str(item.collection_id))
        if leaf is None:
            locations[item_id] = {"kind": "unavailable"}
            continue
        if item.organization_id and _collection_organization_id(leaf) != str(item.organization_id):
            locations[item_id] = {"kind": "unavailable"}
            continue
        if not _can_view_collection(
            leaf,
            viewer=viewer,
            permission_service=permission_service,
        ):
            locations[item_id] = {"kind": "restricted"}
            continue

        expected_host = _collection_host(leaf)
        path: list[dict[str, str]] = []
        seen: set[str] = set()
        current: Collection | None = leaf
        valid = True
        restricted = False
        while current is not None:
            current_id = str(current.id)
            if current_id in seen or _collection_host(current) != expected_host:
                valid = False
                break
            if not _can_view_collection(
                current,
                viewer=viewer,
                permission_service=permission_service,
            ):
                restricted = True
                break
            seen.add(current_id)
            path.append({"id": current_id, "name": current.name or ""})
            if not current.parent_id:
                break
            current = collections.get(str(current.parent_id))
            if current is None:
                valid = False
                break
            if len(path) > Collection.MAX_NESTING_DEPTH:
                valid = False
                break

        if restricted:
            locations[item_id] = {"kind": "restricted"}
            continue
        if not valid:
            locations[item_id] = {"kind": "unavailable"}
            continue
        path.reverse()
        locations[item_id] = {
            "kind": "folder",
            "path": path,
        }

    return locations


def enrich_shared_rows_with_locations(
    rows: list[dict],
    *,
    viewer,
    item_type: str,
    resource_id_key: str,
) -> None:
    """Add optional ``location`` to a legacy shared-with-me response in bulk."""
    if not rows:
        return
    resource_ids = {str(row.get(resource_id_key) or "") for row in rows}
    organization_ids = {str(row.get("organization_id") or "") for row in rows}
    resource_ids.discard("")
    organization_ids.discard("")
    if not resource_ids or not organization_ids:
        for row in rows:
            row["location"] = {"kind": "unavailable"}
        return

    context_items = list(
        ContextItem.objects.filter(
            item_type=item_type,
            resource_id__in=resource_ids,
            organization_id__in=organization_ids,
            is_archived=False,
            trashed_at__isnull=True,
        ).exclude(status="trashed")
    )
    locations = build_shared_resource_locations(viewer, context_items)
    by_resource = {
        (str(item.organization_id or ""), str(item.resource_id or "")): locations[str(item.id)]
        for item in context_items
    }
    for row in rows:
        row["location"] = by_resource.get(
            (str(row.get("organization_id") or ""), str(row.get(resource_id_key) or "")),
            {"kind": "unavailable"},
        )
