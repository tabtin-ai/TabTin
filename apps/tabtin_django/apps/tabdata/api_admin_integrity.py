"""W3.4 / D2 Schema Integrity V2 + C1 字段回收站 Admin API。

设计来源
--------

- PRD §D2 Schema Integrity V2
- PRD §C1 兜底字段回收站后端
- Harness 笔记 W3.4

端点
----

=========================================================================  ====================  ===========
路径                                                                        权限                   用途
=========================================================================  ====================  ===========
POST /tabdata/tables/{table_id}/schema-check                                StaffAuth              检查漂移
POST /tabdata/tables/{table_id}/schema-repair                               StaffAuth              SSE 流修复
GET  /tabdata/tables/{table_id}/deleted-fields                              StaffAuth              回收站列表
POST /tabdata/tables/{table_id}/deleted-fields/{field_id}/restore           StaffAuth              恢复字段
=========================================================================  ====================  ===========
"""
from __future__ import annotations

import json
import logging
from typing import Any, Dict, Optional
from uuid import UUID

from django.conf import settings
from django.http import HttpResponse, StreamingHttpResponse
from django.utils import timezone
from ninja import Router, Schema
from ninja.errors import HttpError

from apps.i18n import get_text as _
from apps.tabdata.constants import TABDATA_DB_ALIAS
from apps.tabdata.models import Table, TableField
from apps.tabdata.services.integrity_v2_service import IntegrityV2Service
from apps.users.auth.permissions import StaffAuth

logger = logging.getLogger(__name__)

router = Router(auth=StaffAuth(), tags=["Admin Schema Integrity"])

FIELD_RECYCLE_BIN_TTL_DAYS = getattr(
    settings, 'TABDATA_FIELD_RECYCLE_BIN_TTL_DAYS', 30
)


# ── Schemas ──────────────────────────────────────────────────


class DriftItemSchema(Schema):
    type: str
    field_id: Optional[str] = None
    field_name: Optional[str] = None
    expected: Optional[str] = None
    actual: Optional[str] = None
    auto_fixable: bool = False
    detail: Optional[str] = None


class SchemaCheckResponseSchema(Schema):
    table_id: str
    table_name: str
    drift_items: list[DriftItemSchema] = []
    checked_fields: int = 0
    checked_refs: int = 0
    orm_row_count: int = 0
    native_row_count: int = 0
    error: Optional[str] = None


class DeletedFieldSchema(Schema):
    id: str
    name: str
    field_type: str
    is_deleted: bool
    deleted_at: Optional[str] = None
    days_remaining: Optional[int] = None
    config: Dict[str, Any] = {}


class DeletedFieldListResponseSchema(Schema):
    table_id: str
    fields: list[DeletedFieldSchema] = []
    ttl_days: int = 30


class RestoreFieldResponseSchema(Schema):
    success: bool
    field_id: str
    message: str = ''


# ── Schema Check ─────────────────────────────────────────────


@router.post(
    "/tabdata/tables/{table_id}/schema-check",
    response=SchemaCheckResponseSchema,
    summary="Schema Integrity V2 — check drift",
)
def schema_check(request, table_id: UUID):
    """对指定表执行完整 schema 一致性检查。

    返回所有漂移项（``drift_items``），每项标注 ``auto_fixable``。
    """
    _verify_table_access(table_id)

    svc = IntegrityV2Service()
    report = svc.check(table_id)
    return report.to_dict()


# ── Schema Repair (SSE) ──────────────────────────────────────


@router.post(
    "/tabdata/tables/{table_id}/schema-repair",
    summary="Schema Integrity V2 — repair (SSE stream)",
)
def schema_repair(request, table_id: UUID):
    """对指定表执行 schema 修复，SSE 流式返回每步进度。

    Response: ``text/event-stream``
    """
    _verify_table_access(table_id)

    svc = IntegrityV2Service()

    def event_stream():
        for evt in svc.repair_stream(table_id):
            data = json.dumps(evt.to_dict(), ensure_ascii=False)
            yield f"data: {data}\n\n"
        yield "data: [DONE]\n\n"

    response = StreamingHttpResponse(
        event_stream(),
        content_type='text/event-stream',
    )
    response['Cache-Control'] = 'no-cache'
    response['X-Accel-Buffering'] = 'no'
    return response


# ── Deleted Fields (Recycle Bin) ──────────────────────────────


@router.get(
    "/tabdata/tables/{table_id}/deleted-fields",
    response=DeletedFieldListResponseSchema,
    summary="List soft-deleted fields (recycle bin)",
)
def list_deleted_fields(request, table_id: UUID):
    """列出指定表的软删除字段（保留期内）。"""
    _verify_table_access(table_id)

    now = timezone.now()
    ttl_days = FIELD_RECYCLE_BIN_TTL_DAYS

    deleted_fields = list(
        TableField.objects.using(TABDATA_DB_ALIAS)
        .filter(table_id=table_id, is_deleted=True)
        .order_by('-updated_at')
    )

    items = []
    for f in deleted_fields:
        deleted_at = f.updated_at
        days_elapsed = (now - deleted_at).days if deleted_at else 0
        days_remaining = max(0, ttl_days - days_elapsed)

        if days_remaining <= 0:
            continue

        items.append(DeletedFieldSchema(
            id=str(f.id),
            name=f.name,
            field_type=f.field_type,
            is_deleted=f.is_deleted,
            deleted_at=deleted_at.isoformat() if deleted_at else None,
            days_remaining=days_remaining,
            config=f.config or {},
        ))

    return DeletedFieldListResponseSchema(
        table_id=str(table_id),
        fields=items,
        ttl_days=ttl_days,
    )


# ── Restore Deleted Field ────────────────────────────────────


@router.post(
    "/tabdata/tables/{table_id}/deleted-fields/{field_id}/restore",
    response=RestoreFieldResponseSchema,
    summary="Restore a soft-deleted field (recycle bin)",
)
def restore_deleted_field(request, table_id: UUID, field_id: UUID):
    """从回收站恢复一个软删除字段。

    走 C1 restore_field 全链路（ORM 恢复 + native 列重建 + 依赖图 + 事件发布）。
    """
    _verify_table_access(table_id)

    try:
        field_obj = TableField.objects.using(TABDATA_DB_ALIAS).get(
            id=field_id, table_id=table_id, is_deleted=True,
        )
    except TableField.DoesNotExist:
        raise HttpError(
            404,
            _('tabdata.admin_integrity.field_not_found',
              'Deleted field not found or already restored'),
        )

    from apps.tabdata.services.undo_redo_field_restore import restore_field

    try:
        success, message = restore_field(
            table_id=table_id,
            field_id=field_id,
            user_id=getattr(request.auth, 'id', None),
        )
    except Exception as exc:
        logger.exception(
            'Failed to restore field %s in table %s', field_id, table_id,
        )
        return RestoreFieldResponseSchema(
            success=False,
            field_id=str(field_id),
            message=str(exc),
        )

    return RestoreFieldResponseSchema(
        success=success,
        field_id=str(field_id),
        message=message or ('Restored' if success else 'Restore failed'),
    )


# ── Helpers ──────────────────────────────────────────────────


def _verify_table_access(table_id: UUID) -> Table:
    """校验表存在且未归档。"""
    try:
        table = Table.objects.using(TABDATA_DB_ALIAS).get(id=table_id)
    except Table.DoesNotExist:
        raise HttpError(404, _('tabdata.admin_integrity.table_not_found', 'Table not found'))
    return table
