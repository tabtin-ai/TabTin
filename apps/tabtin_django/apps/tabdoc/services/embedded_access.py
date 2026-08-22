"""Inherited access to resources embedded in an accessible TabDoc."""

from __future__ import annotations

import logging
from typing import Any, Iterator

from django.core.cache import cache

from apps.tabdata.request_context import (
    get_current_parent_document_id,
    mark_embedded_access_verification_unavailable,
)

logger = logging.getLogger(__name__)


def _iter_pm_nodes(node: Any) -> Iterator[dict]:
    if not isinstance(node, dict):
        return
    yield node
    children = node.get("content")
    if not isinstance(children, list):
        return
    for child in children:
        yield from _iter_pm_nodes(child)


def _resource_references(pm_json: Any) -> dict[str, set[str]]:
    references: dict[str, set[str]] = {"table": set(), "document": set()}
    for node in _iter_pm_nodes(pm_json):
        node_type = node.get("type")
        attrs = node.get("attrs")
        if not isinstance(attrs, dict):
            continue

        if node_type == "tabdataBlock" and attrs.get("tableId"):
            references["table"].add(str(attrs["tableId"]))
        elif node_type == "tabdocBlock":
            document_id = attrs.get("documentId") or attrs.get("docId")
            if document_id:
                references["document"].add(str(document_id))
        elif node_type == "resourceBlock" and attrs.get("resourceType") in {
            "document",
            "tabdoc",
        }:
            if attrs.get("resourceId"):
                references["document"].add(str(attrs["resourceId"]))
    return references


def _authoritative_references(parent_document) -> dict[str, set[str]] | None:
    binary = getattr(parent_document, "description_binary", None)
    if not binary:
        return _resource_references(getattr(parent_document, "description_json", None))

    cache_key = (
        "tabdoc:embedded-references:v1:"
        f"{parent_document.id}:{getattr(parent_document, 'latest_version', 0)}"
    )
    cached = cache.get(cache_key)
    if isinstance(cached, dict):
        return {
            "table": set(cached.get("table", [])),
            "document": set(cached.get("document", [])),
        }

    from apps.tabdoc.services.exchange_service import DocumentExchangeService

    resolved = DocumentExchangeService._resolve_from_binary(binary, parent_document.id)
    if resolved is None:
        mark_embedded_access_verification_unavailable()
        return None

    references = _resource_references(resolved[0])
    cache.set(
        cache_key,
        {kind: sorted(ids) for kind, ids in references.items()},
        timeout=300,
    )
    return references


def document_references_resource(parent_document, resource_type: str, resource_id: str) -> bool:
    """Return whether the authoritative document content contains this resource."""
    target_id = str(resource_id)
    if resource_type == "document" and str(getattr(parent_document, "id", "")) == target_id:
        return False
    references = _authoritative_references(parent_document)
    return references is not None and target_id in references.get(resource_type, set())


def get_current_parent_document_resource_role(
    *,
    user,
    resource_type: str,
    resource,
) -> str | None:
    """Return the role inherited from the validated request-scoped parent.

    Embedded resources inherit the parent's effective read/edit capability, capped
    at ``editor`` because ownership and permission-management rights remain local to
    the child resource. Edit inheritance only crosses resources with the same owner;
    otherwise it is capped at ``viewer`` to prevent an editor from elevating access
    by embedding someone else's resource.
    """
    parent_document_id = get_current_parent_document_id()
    if not parent_document_id or not user or not getattr(user, "id", None):
        return None

    try:
        from apps.tabdoc.models import Document
        from apps.tabdoc.services.document_service import DocumentService

        parent = (
            Document.objects.select_related("parent")
            .prefetch_related("permissions")
            .filter(id=parent_document_id)
            .first()
        )
        if parent is None or getattr(parent, "trashed_at", None) is not None:
            return None
        if getattr(parent, "status", "active") == "trashed":
            return None

        parent_org_id = getattr(parent, "organization_id", None)
        resource_org_id = getattr(resource, "organization_id", None)
        if not parent_org_id or str(parent_org_id) != str(resource_org_id):
            return None

        parent_service = DocumentService(user=user)
        if parent_service.check_document_permission(
            parent,
            required_role="editor",
            allow_embedded_access=False,
        ):
            inherited_role = "editor"
        elif parent_service.check_document_permission(
            parent,
            required_role="viewer",
            allow_embedded_access=False,
        ):
            inherited_role = "viewer"
        else:
            return None

        if inherited_role == "editor":
            parent_owner_id = getattr(parent, "owner_id", None)
            resource_owner_id = getattr(resource, "owner_id", None)
            if (
                not parent_owner_id
                or not resource_owner_id
                or str(parent_owner_id) != str(resource_owner_id)
            ):
                inherited_role = "viewer"

        if resource_type == "document" and str(getattr(resource, "parent_id", "")) == str(parent.id):
            return inherited_role
        if document_references_resource(parent, resource_type, str(resource.id)):
            return inherited_role
        return None
    except (TypeError, ValueError):
        return None
    except Exception:
        logger.warning(
            "embedded access validation failed: parent=%s type=%s resource=%s",
            parent_document_id,
            resource_type,
            getattr(resource, "id", None),
            exc_info=True,
        )
        return None


def current_parent_document_allows_resource(
    *,
    user,
    resource_type: str,
    resource,
) -> bool:
    """Compatibility predicate for callers that only need read access."""
    return get_current_parent_document_resource_role(
        user=user,
        resource_type=resource_type,
        resource=resource,
    ) is not None
