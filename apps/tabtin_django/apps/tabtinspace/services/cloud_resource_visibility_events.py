"""云盘分享可见性事件——邀请 / 撤权后定向推送。"""
from __future__ import annotations

import logging
from typing import Optional, Sequence

from apps.tabtinspace.services.context_sync_publisher import (
    publish_resource_access_changed,
    publish_resource_access_granted,
    publish_resource_access_revoked,
)

logger = logging.getLogger(__name__)


def _lookup_context_item(resource_type: str, resource_id: str):
    try:
        from apps.tabtinspace.models import ContextItem

        return (
            ContextItem.objects.filter(
                item_type=resource_type,
                resource_id=str(resource_id),
            )
            .only(
                "id",
                "title",
                "metadata",
                "preview",
                "status",
                "collection_id",
                "workspace_id",
                "project_id",
                "organization_id",
            )
            .first()
        )
    except Exception:
        logger.debug(
            "[CloudVisibility] context item lookup failed type=%s id=%s",
            resource_type,
            resource_id,
            exc_info=True,
        )
        return None


def _space_id_of_item(item) -> Optional[str]:
    if item is None:
        return None
    for attr in ("workspace_id", "project_id"):
        value = getattr(item, attr, None)
        if value:
            return str(value)
    return None


def notify_cloud_resource_access_granted(
    *,
    resource_type: str,
    resource_id: str,
    organization_id: Optional[str],
    user_ids: Sequence[str],
    actor_user_id: Optional[str] = None,
    title: Optional[str] = None,
    space_id: Optional[str] = None,
) -> None:
    if not user_ids:
        return
    item = _lookup_context_item(resource_type, resource_id)
    publish_resource_access_granted(
        resource_type=resource_type,
        resource_id=str(resource_id),
        organization_id=str(organization_id) if organization_id else None,
        user_ids=list(user_ids),
        title=title or (getattr(item, "title", None) if item else None),
        space_id=space_id or _space_id_of_item(item),
        context_item_id=str(item.id) if item else None,
        metadata=getattr(item, "metadata", None) if item else None,
        preview=getattr(item, "preview", None) if item else None,
        status=getattr(item, "status", None) if item else None,
        collection_id=(
            str(item.collection_id) if item and getattr(item, "collection_id", None) else None
        ),
        actor_user_id=actor_user_id,
    )


def notify_cloud_resource_access_revoked(
    *,
    resource_type: str,
    resource_id: str,
    organization_id: Optional[str],
    user_ids: Sequence[str],
    actor_user_id: Optional[str] = None,
    space_id: Optional[str] = None,
) -> None:
    if not user_ids:
        return
    item = _lookup_context_item(resource_type, resource_id)
    publish_resource_access_revoked(
        resource_type=resource_type,
        resource_id=str(resource_id),
        organization_id=str(organization_id) if organization_id else None,
        user_ids=list(user_ids),
        space_id=space_id or _space_id_of_item(item),
        actor_user_id=actor_user_id,
    )


def notify_cloud_resource_access_changed(
    *,
    resource_type: str,
    resource_id: str,
    organization_id: Optional[str],
    user_ids: Sequence[str],
    actor_user_id: Optional[str] = None,
    space_id: Optional[str] = None,
    db_alias: Optional[str] = None,
) -> None:
    """协作者权限升降级后，通知其重新读取资源 ACL。"""
    if not user_ids:
        return
    publish_resource_access_changed(
        resource_type=resource_type,
        resource_id=str(resource_id),
        organization_id=str(organization_id) if organization_id else None,
        user_ids=list(user_ids),
        actor_user_id=actor_user_id,
        space_id=space_id,
        db_alias=db_alias,
    )
