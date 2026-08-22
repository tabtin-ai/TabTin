"""#7074：把历史云资产 ContextItem 从 workspace/project 宿主收敛到 organization。

不放宽  默认私有 ACL；只做宿主迁移 + 可选 created_by 回填。
遵守 ``ctx_item_host_exclusive_6603``：迁后仅保留 organization_id。
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Optional
from uuid import UUID

from django.contrib.auth import get_user_model
from django.db.models import Q

from apps.tabtinspace.services.cloud_resource_acl import CLOUD_ITEM_TYPES

logger = logging.getLogger(__name__)
User = get_user_model()


@dataclass
class RehostStats:
    scanned: int = 0
    rehosted: int = 0
    deduped_deleted: int = 0
    created_by_filled: int = 0
    skipped_no_org: int = 0
    skipped_no_resource_id: int = 0
    audit_rows: list[dict] = field(default_factory=list)


def _legacy_cloud_qs(*, organization_id: Optional[str] = None):
    from apps.tabtinspace.models import ContextItem

    qs = (
        ContextItem.objects.filter(
            item_type__in=CLOUD_ITEM_TYPES,
            organization_id__isnull=True,
        )
        .filter(Q(workspace_id__isnull=False) | Q(project_id__isnull=False))
        .select_related("workspace", "project")
        .order_by("created_at", "id")
    )
    if organization_id:
        qs = qs.filter(
            Q(workspace__organization_id=organization_id)
            | Q(project__organization_id=organization_id)
        )
    return qs


def _resolve_organization_id(item) -> Optional[str]:
    """解析目标 organization_id：资源自身 → workspace → project。"""
    resource_org = _resource_organization_id(item)
    if resource_org:
        return str(resource_org)

    workspace = getattr(item, "workspace", None)
    if workspace is not None and getattr(workspace, "organization_id", None):
        return str(workspace.organization_id)

    project = getattr(item, "project", None)
    if project is not None and getattr(project, "organization_id", None):
        return str(project.organization_id)

    # select_related 未命中时再查一次 FK
    if item.workspace_id:
        from apps.tabtinspace.models import Workspace

        oid = (
            Workspace.objects.filter(id=item.workspace_id)
            .values_list("organization_id", flat=True)
            .first()
        )
        if oid:
            return str(oid)
    if item.project_id:
        from apps.tabtinspace.models import Project

        oid = (
            Project.objects.filter(id=item.project_id)
            .values_list("organization_id", flat=True)
            .first()
        )
        if oid:
            return str(oid)
    return None


def _resource_organization_id(item) -> Optional[str]:
    rid = str(item.resource_id or "").strip()
    if not rid:
        return None
    try:
        if item.item_type == "tabdoc":
            from apps.tabdoc.models import Document

            return (
                Document.objects.filter(id=rid)
                .values_list("organization_id", flat=True)
                .first()
            )
        if item.item_type == "tabdata":
            from apps.tabdata.constants import TABDATA_DB_ALIAS
            from apps.tabdata.models import Table

            return (
                Table.objects.using(TABDATA_DB_ALIAS)
                .filter(id=rid)
                .values_list("organization_id", flat=True)
                .first()
            )
        if item.item_type == "tabfiles":
            from apps.services.oss.models import FileRecord

            return (
                FileRecord.objects.filter(id=rid)
                .values_list("organization_id", flat=True)
                .first()
            )
    except Exception as exc:
        logger.warning(
            "[7074-rehost] resolve resource org failed item=%s type=%s: %s",
            item.id,
            item.item_type,
            exc,
        )
    return None


def _resolve_created_by_id(item) -> Optional[str]:
    """在 ContextItem.created_by 为空时，从资源 owner / upload_user 回填。"""
    if item.created_by_id:
        return str(item.created_by_id)

    rid = str(item.resource_id or "").strip()
    if not rid:
        return None

    owner_id: Optional[str] = None
    try:
        if item.item_type == "tabdoc":
            from apps.tabdoc.models import Document, DocumentPermission

            owner_id = (
                Document.objects.filter(id=rid)
                .values_list("owner_id", flat=True)
                .first()
            )
            if not owner_id:
                owner_id = (
                    DocumentPermission.objects.filter(
                        document_id=rid,
                        subject_type="user",
                        permission="owner",
                        is_active=True,
                    )
                    .values_list("subject_id", flat=True)
                    .first()
                )
            if not owner_id:
                owner_id = (
                    Document.objects.filter(id=rid)
                    .values_list("created_by_id", flat=True)
                    .first()
                )
        elif item.item_type == "tabdata":
            from apps.tabdata.constants import TABDATA_DB_ALIAS
            from apps.tabdata.models import Table

            owner_id = (
                Table.objects.using(TABDATA_DB_ALIAS)
                .filter(id=rid)
                .values_list("owner_id", flat=True)
                .first()
            )
        elif item.item_type == "tabfiles":
            from apps.services.oss.models import FileRecord

            owner_id = (
                FileRecord.objects.filter(id=rid)
                .values_list("upload_user", flat=True)
                .first()
            )
    except Exception as exc:
        logger.warning(
            "[7074-rehost] resolve created_by failed item=%s type=%s: %s",
            item.id,
            item.item_type,
            exc,
        )
        return None

    owner_id = str(owner_id or "").strip()
    if not owner_id:
        return None
    if not User.objects.filter(id=owner_id).exists():
        return None
    return owner_id


def backfill_org_cloud_created_by(
    *,
    organization_id: Optional[str | UUID] = None,
    dry_run: bool = False,
    batch_log=None,
) -> int:
    """给已挂 organization 但缺 created_by 的云资产补所有者（不扩权）。"""
    from apps.tabtinspace.models import ContextItem

    log = batch_log or (lambda msg: None)
    qs = ContextItem.objects.filter(
        item_type__in=CLOUD_ITEM_TYPES,
        organization_id__isnull=False,
        created_by_id__isnull=True,
    )
    if organization_id:
        qs = qs.filter(organization_id=organization_id)

    filled = 0
    for item in qs.iterator(chunk_size=200):
        owner_id = _resolve_created_by_id(item)
        if not owner_id:
            continue
        log(f"  fill created_by item={item.id} type={item.item_type} <- {owner_id}")
        if not dry_run:
            ContextItem.objects.filter(id=item.id).update(
                created_by_id=owner_id,
                updated_by_id=owner_id,
            )
        filled += 1
    return filled


def rehost_legacy_cloud_context_items(
    *,
    organization_id: Optional[str | UUID] = None,
    dry_run: bool = False,
    batch_log=None,
) -> RehostStats:
    """扫描并收敛 legacy 云资产宿主。

    - dry_run=True：只统计 / 审计，不写库
    - 已存在同 type+resource 的 org-only 行时，删除 legacy（必要时把 created_by 补到保留行）
    """
    from apps.tabtinspace.models import ContextItem

    org_filter = str(organization_id) if organization_id else None
    stats = RehostStats()
    log = batch_log or (lambda msg: None)

    for item in _legacy_cloud_qs(organization_id=org_filter).iterator(chunk_size=200):
        stats.scanned += 1
        rid = str(item.resource_id or "").strip()
        if not rid:
            stats.skipped_no_resource_id += 1
            stats.audit_rows.append(
                {
                    "item_type": item.item_type,
                    "context_item_id": str(item.id),
                    "resource_id": "",
                    "organization_id": "",
                    "title": item.title or "",
                    "reason": "missing_resource_id",
                }
            )
            continue

        target_org = _resolve_organization_id(item)
        if not target_org:
            stats.skipped_no_org += 1
            stats.audit_rows.append(
                {
                    "item_type": item.item_type,
                    "context_item_id": str(item.id),
                    "resource_id": rid,
                    "organization_id": "",
                    "title": item.title or "",
                    "reason": "cannot_resolve_organization_id",
                }
            )
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
            log(
                f"  dedupe legacy={item.id} keep={existing.id} "
                f"type={item.item_type} resource={rid} org={target_org}"
            )
            if not dry_run:
                update_fields = []
                if not existing.created_by_id and created_by_id:
                    existing.created_by_id = created_by_id
                    existing.updated_by_id = created_by_id
                    update_fields.extend(["created_by_id", "updated_by_id"])
                    stats.created_by_filled += 1
                if (
                    existing.collection_id is None
                    and item.collection_id is not None
                ):
                    existing.collection_id = item.collection_id
                    update_fields.append("collection_id")
                if update_fields:
                    update_fields.append("updated_at")
                    existing.save(update_fields=update_fields)
                ContextItem.objects.filter(id=item.id).delete()
            stats.deduped_deleted += 1
            continue

        log(
            f"  rehost item={item.id} type={item.item_type} resource={rid} "
            f"org={target_org} created_by={created_by_id or '-'}"
        )
        final_created_by = str(item.created_by_id or created_by_id or "").strip()
        if not dry_run:
            update_kwargs = {
                "organization_id": target_org,
                "workspace_id": None,
                "project_id": None,
            }
            if created_by_id and not item.created_by_id:
                update_kwargs["created_by_id"] = created_by_id
                update_kwargs["updated_by_id"] = created_by_id
                stats.created_by_filled += 1
            ContextItem.objects.filter(id=item.id).update(**update_kwargs)
        elif created_by_id and not item.created_by_id:
            stats.created_by_filled += 1
        stats.rehosted += 1
        if not final_created_by:
            # tabfiles 列表依赖 created_by；迁完仍无主则对所有人不可见，记入审计
            stats.audit_rows.append(
                {
                    "item_type": item.item_type,
                    "context_item_id": str(item.id),
                    "resource_id": rid,
                    "organization_id": target_org,
                    "title": item.title or "",
                    "reason": "rehosted_but_still_no_owner",
                }
            )

    # 第二步：已是 org 宿主但缺 created_by 的历史行
    stats.created_by_filled += backfill_org_cloud_created_by(
        organization_id=org_filter,
        dry_run=dry_run,
        batch_log=log,
    )
    return stats
