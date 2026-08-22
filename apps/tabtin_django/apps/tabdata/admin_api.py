"""
TabData Admin 管理 API

说明：
- 仅后台 staff 用户可访问读接口
- 仅后台 superuser 可执行批量治理写操作
"""

from __future__ import annotations

import csv
from datetime import datetime
import io
import logging
from uuid import UUID

from django.contrib.auth import get_user_model
from django.db import transaction
from django.db.models import Case, Count, IntegerField, Q, Value, When

from apps.tabdata.constants import TABDATA_DB_ALIAS
from django.http import HttpResponse
from django.utils import timezone
from ninja import Query, Router
from ninja.errors import HttpError

from apps.tabdata.models import Table, TableAdminActionLog, TableField, TableRecord
from apps.tabdata.native.query_builder import NativeQueryBuilder
from apps.tabdata.native.record_io import NativeRecordIO
from apps.tabdata.services.table_service import TableService
from apps.tabdata.services.schema_version_token import bump_table_schema_version_token
from apps.tabdata.utils.record_serializers import serialize_native_rows
from apps.tabtinspace.services.resource_bridge import ResourceBridge
from apps.tabtinspace.models import Space, Organization
from apps.users.auth.admin_audit import record_admin_sensitive_action
from apps.users.auth.permissions import AdminPermissionAuth, StaffAuth
from apps.users.membership.services.quota_service import QuotaService

from .admin_schemas import (
    AdminTableAuditExportRequestSchema,
    AdminTableBatchMutationRequestSchema,
    AdminTableBatchMutationResponseSchema,
    AdminTableBatchSkipItemSchema,
    AdminTableDetailResponseSchema,
    AdminTableFieldSummarySchema,
    AdminTableFieldTypeStatSchema,
    AdminTableListItemSchema,
    AdminTableListResponseSchema,
    AdminTableOperationItemSchema,
    AdminTableOperationListResponseSchema,
    AdminTableOperationSummarySchema,
    AdminTablePaginationSchema,
    AdminTablePreviewFieldSchema,
    AdminTablePreviewRowSchema,
    AdminTableRecordPreviewSchema,
    AdminTableSensitiveActionRequestSchema,
    AdminTableSummarySchema,
)

User = get_user_model()
router = Router(auth=StaffAuth())
logger = logging.getLogger(__name__)

VALID_VISIBILITY = {'normal', 'system', 'hidden'}
VALID_ARCHIVED = {'all', 'active', 'archived', 'trashed'}
VALID_OPERATION_ACTION_TYPES = {item[0] for item in TableAdminActionLog.ACTION_TYPE_CHOICES}


def _ensure_sensitive_reason(*, dry_run: bool, reason: str) -> None:
    if dry_run:
        return
    if not reason.strip():
        raise HttpError(400, 'reason 不能为空')


def _build_table_sensitive_snapshots(tables: list[Table]) -> list[dict]:
    return [
        {
            'table_id': str(table.id),
            'name': table.name,
            'is_archived': bool(table.is_archived),
            'is_trashed': bool(getattr(table, 'trashed_at', None)),
            'trashed_at': table.trashed_at.isoformat() if getattr(table, 'trashed_at', None) else None,
            'previous_status': getattr(table, 'previous_status', '') or '',
            'organization_id': str(table.organization_id) if table.organization_id else None,
            'space_id': str(table.space_id) if table.space_id else None,
            'visibility': table.visibility,
        }
        for table in tables
    ]


def _record_table_sensitive_action(
    *,
    request,
    permission_code: str,
    action: str,
    target_ids: list[str],
    reason: str,
    ticket_id: str,
    affected_count: int,
    before_preview: list[dict],
    after_preview: list[dict],
) -> None:
    if not target_ids:
        return

    before_json: dict = {
        'total_target_count': len(target_ids),
        'target_ids_preview': target_ids[:20],
        'affected_count': affected_count,
        'tables_preview': before_preview[:20],
    }
    if not before_preview:
        before_json = {'unavailable': True, 'reason': '未能采集目标表格快照'}

    after_json = {
        'total_target_count': len(target_ids),
        'target_ids_preview': target_ids[:20],
        'affected_count': affected_count,
        'tables_preview': after_preview[:20],
    }
    record_admin_sensitive_action(
        request,
        permission_code=permission_code,
        action=action,
        target_type='table',
        target_id=target_ids[0] if len(target_ids) == 1 else 'batch',
        reason=reason,
        ticket_id=ticket_id,
        before_json=before_json,
        after_json=after_json,
    )

def _parse_uuid_or_none(raw: str | None) -> UUID | None:
    if not raw:
        return None
    value = raw.strip()
    if not value:
        return None
    try:
        return UUID(value)
    except ValueError as exc:
        raise HttpError(400, f'无效 UUID: {raw}') from exc

def _try_parse_uuid(raw: str) -> UUID | None:
    value = raw.strip()
    if not value:
        return None
    try:
        return UUID(value)
    except ValueError:
        return None

def _extract_owner_display_name(user_obj) -> str:
    display_fn = getattr(user_obj, 'get_display_name', None)
    if callable(display_fn):
        return display_fn()
    return user_obj.username or user_obj.email or user_obj.phone or str(user_obj.id)

def _build_table_item(
    table: Table,
    *,
    organization_name_map: dict[str, str],
    space_name_map: dict[str, str],
    owner_name_map: dict[str, str],
) -> AdminTableListItemSchema:
    table_id = str(table.id)
    organization_id = str(table.organization_id)
    space_id = str(table.space_id) if table.space_id else None
    owner_id = str(table.owner_id) if table.owner_id else None

    return AdminTableListItemSchema(
        id=table_id,
        name=table.name,
        description=table.description or '',
        organization_id=organization_id,
        organization_name=organization_name_map.get(organization_id),
        space_id=space_id,
        space_name=space_name_map.get(space_id),
        owner_id=owner_id,
        owner_name=owner_name_map.get(owner_id) if owner_id else None,
        visibility=table.visibility,
        is_archived=table.is_archived,
        is_trashed=bool(getattr(table, 'trashed_at', None)),
        trashed_at=table.trashed_at,
        previous_status=getattr(table, 'previous_status', '') or '',
        row_count=table.row_count,
        field_count=table.field_count,
        created_at=table.created_at,
        updated_at=table.updated_at,
    )

def _build_name_maps(tables: list[Table]) -> tuple[dict[str, str], dict[str, str], dict[str, str]]:
    organization_ids = {str(table.organization_id) for table in tables if table.organization_id}
    space_ids = {str(table.space_id) for table in tables if table.space_id}
    owner_ids = {str(table.owner_id) for table in tables if table.owner_id}

    organization_name_map = {
        str(item.id): item.name
        for item in Organization.objects.filter(id__in=organization_ids)
    }
    from apps.tabtinspace.services.host_resolver import host_name_map
    space_name_map = host_name_map(space_ids)
    owner_name_map = {
        str(item.id): _extract_owner_display_name(item)
        for item in User.objects.filter(id__in=owner_ids)
    }

    return organization_name_map, space_name_map, owner_name_map

def _normalize_table_ids(raw_ids: list[str]) -> list[str]:
    normalized: list[str] = []
    seen: set[str] = set()
    for raw in raw_ids:
        value = str(raw).strip()
        if not value or value in seen:
            continue
        seen.add(value)
        normalized.append(value)
    return normalized

def _extract_request_meta(request) -> tuple[str | None, str]:
    from apps.users.auth.utils import get_client_ip
    client_ip = get_client_ip(request)
    meta = getattr(request, 'META', {}) or {}
    user_agent = str(meta.get('HTTP_USER_AGENT', '')).strip()
    return (client_ip or None), user_agent

def _extract_trace_id(request) -> str:
    headers = getattr(request, 'headers', None)
    trace_id = ''
    if headers is not None:
        trace_id = (
            str(headers.get('X-Trace-Id') or '')
            or str(headers.get('X-Request-Id') or '')
        ).strip()
    if trace_id:
        return trace_id[:128]

    meta = getattr(request, 'META', {}) or {}
    trace_id = (
        str(meta.get('HTTP_X_TRACE_ID') or '')
        or str(meta.get('HTTP_X_REQUEST_ID') or '')
    ).strip()
    return trace_id[:128]

def _serialize_operation_item(item: TableAdminActionLog) -> AdminTableOperationItemSchema:
    target_table_ids = item.target_table_ids if isinstance(item.target_table_ids, list) else []
    normalized_ids = [str(table_id).strip() for table_id in target_table_ids if str(table_id).strip()]

    return AdminTableOperationItemSchema(
        id=str(item.id),
        action_type=item.action_type,
        operator_id=str(item.operator_id) if item.operator_id else None,
        operator_name=item.operator_name or '',
        target_table_ids=normalized_ids,
        requested_count=item.requested_count,
        updated_count=item.updated_count,
        skipped_count=item.skipped_count,
        dry_run=item.dry_run,
        success=item.success,
        result_message=item.result_message or '',
        error_message=item.error_message or '',
        trace_id=item.trace_id or '',
        created_at=item.created_at,
    )

def _build_recent_operations(table_id: UUID, limit: int = 10) -> list[AdminTableOperationItemSchema]:
    table_token = f'|{table_id}|'
    items = list(
        TableAdminActionLog.objects.using(TABDATA_DB_ALIAS).filter(target_table_ids_text__icontains=table_token)
        .order_by('-created_at')[: max(1, min(limit, 50))]
    )
    return [_serialize_operation_item(item) for item in items]

def _record_table_admin_action(
    *,
    request,
    action_type: str,
    target_table_ids: list[str],
    requested_count: int,
    updated_count: int,
    skipped_count: int,
    dry_run: bool,
    success: bool,
    result_message: str = '',
    error_message: str = '',
    request_payload: dict | None = None,
    result_payload: dict | None = None,
) -> None:
    user = request.auth
    operator_id = None
    if user and getattr(user, 'id', None):
        try:
            operator_id = UUID(str(user.id))
        except (TypeError, ValueError):
            operator_id = None

    operator_name = ''
    if user:
        operator_name = _extract_owner_display_name(user)

    normalized_table_ids = _normalize_table_ids([str(item) for item in target_table_ids])
    target_table_ids_text = f"|{'|'.join(normalized_table_ids)}|" if normalized_table_ids else ''
    ip_address, user_agent = _extract_request_meta(request)

    try:
        TableAdminActionLog.objects.using(TABDATA_DB_ALIAS).create(
            action_type=action_type,
            operator_id=operator_id,
            operator_name=operator_name,
            target_table_ids=normalized_table_ids,
            target_table_ids_text=target_table_ids_text,
            requested_count=max(0, requested_count),
            updated_count=max(0, updated_count),
            skipped_count=max(0, skipped_count),
            dry_run=dry_run,
            success=success,
            result_message=result_message or '',
            error_message=error_message or '',
            request_payload=request_payload or {},
            result_payload=result_payload or {},
            trace_id=_extract_trace_id(request),
            ip_address=ip_address,
            user_agent=user_agent,
        )
    except Exception:
        logger.exception('写入表格治理日志失败')

def _build_field_summary(table_id: UUID) -> AdminTableFieldSummarySchema:
    fields = list(
        TableField.objects.using(TABDATA_DB_ALIAS).filter(table_id=table_id, is_deleted=False)
        .values('field_type')
        .annotate(count=Count('id'))
        .order_by('field_type')
    )

    field_type_stats = [
        AdminTableFieldTypeStatSchema(field_type=item['field_type'], count=item['count'])
        for item in fields
    ]

    base_qs = TableField.objects.using(TABDATA_DB_ALIAS).filter(table_id=table_id, is_deleted=False)
    return AdminTableFieldSummarySchema(
        total_fields=base_qs.count(),
        hidden_fields=base_qs.filter(is_hidden=True).count(),
        primary_fields=base_qs.filter(is_primary=True).count(),
        field_type_stats=field_type_stats,
    )

def _build_record_preview_from_orm(
    table_id: UUID,
    *,
    display_fields: list[TableField],
    limit: int,
) -> tuple[int, list[AdminTablePreviewRowSchema]]:
    total_rows = TableRecord.objects.using(TABDATA_DB_ALIAS).filter(table_id=table_id, is_deleted=False).count()
    records = list(
        TableRecord.objects.using(TABDATA_DB_ALIAS).filter(table_id=table_id, is_deleted=False)
        .order_by('-updated_at')[:limit]
    )

    rows: list[AdminTablePreviewRowSchema] = []
    for record in records:
        raw_data = record.__dict__.get('data') or {}
        values = {str(field.id): raw_data.get(str(field.id)) for field in display_fields}
        rows.append(
            AdminTablePreviewRowSchema(
                record_id=str(record.id),
                order=record.order,
                status=record.status,
                values=values,
                created_at=record.created_at,
                updated_at=record.updated_at,
            )
        )
    return total_rows, rows

def _build_record_preview_from_native(
    table: Table,
    *,
    all_fields: list[TableField],
    display_fields: list[TableField],
    limit: int,
) -> tuple[int, list[AdminTablePreviewRowSchema]]:
    from apps.tabdata.native.ddl_manager import resolve_schema_partition_id
    partition_id = resolve_schema_partition_id(table)
    query_builder = NativeQueryBuilder(
        space_id=partition_id,
        table_id=table.id,
        fields=all_fields,
    )
    native_io = NativeRecordIO(
        space_id=partition_id,
        table_id=table.id,
    )
    native_rows, total_rows = native_io.read_records(
        query_builder,
        order_by=('"__updated_at" DESC NULLS LAST, "__order" ASC', []),
        limit=limit,
        offset=0,
        field_ids=[str(field.id) for field in display_fields],
    )
    serialized_rows = serialize_native_rows(
        native_rows,
        table.id,
        display_fields,
        field_key_type='id',
    )

    rows: list[AdminTablePreviewRowSchema] = []
    for row in serialized_rows:
        row_fields = row.get('fields')
        row_values = row_fields if isinstance(row_fields, dict) else {}

        try:
            row_order = float(row.get('order', 0) or 0)
        except (TypeError, ValueError):
            row_order = 0

        rows.append(
            AdminTablePreviewRowSchema(
                record_id=str(row.get('id', '')),
                order=row_order,
                status=str(row.get('status') or 'active'),
                values={str(field.id): row_values.get(str(field.id)) for field in display_fields},
                created_at=row.get('created_at'),
                updated_at=row.get('updated_at'),
            )
        )
    return int(total_rows), rows

def _build_record_preview(table_id: UUID, limit: int = 20, max_fields: int = 12) -> AdminTableRecordPreviewSchema:
    fields = list(
        TableField.objects.using(TABDATA_DB_ALIAS).filter(table_id=table_id, is_deleted=False)
        .order_by('order', 'created_at')
    )
    display_fields = [field for field in fields if not field.is_hidden]
    if not display_fields:
        display_fields = fields

    normalized_limit = max(1, min(limit, 100))
    display_fields = display_fields[: max(1, min(max_fields, 30))]
    preview_fields = [
        AdminTablePreviewFieldSchema(
            field_id=str(field.id),
            field_name=field.name,
            field_type=field.field_type,
            is_primary=field.is_primary,
            is_hidden=field.is_hidden,
        )
        for field in display_fields
    ]

    total_rows = 0
    rows: list[AdminTablePreviewRowSchema] = []
    table = Table.objects.using(TABDATA_DB_ALIAS).filter(id=table_id).only('id', 'space_id', 'row_count').first()

    if table is not None:
        try:
            total_rows, rows = _build_record_preview_from_native(
                table,
                all_fields=fields,
                display_fields=display_fields,
                limit=normalized_limit,
            )
        except Exception:
            logger.warning('原生记录预览读取失败，回退 ORM 查询: table_id=%s', table_id, exc_info=True)

    if total_rows == 0 and not rows:
        total_rows, rows = _build_record_preview_from_orm(
            table_id,
            display_fields=display_fields,
            limit=normalized_limit,
        )

    return AdminTableRecordPreviewSchema(
        total_rows=total_rows,
        returned_rows=len(rows),
        fields=preview_fields,
        rows=rows,
    )

def _safe_build_record_preview(table_id: UUID, limit: int = 20, max_fields: int = 12) -> AdminTableRecordPreviewSchema:
    try:
        return _build_record_preview(table_id, limit=limit, max_fields=max_fields)
    except Exception:
        logger.exception('构建表内容预览失败: table_id=%s', table_id)
        return AdminTableRecordPreviewSchema(
            total_rows=0,
            returned_rows=0,
            fields=[],
            rows=[],
        )

def _safe_build_field_summary(table_id: UUID) -> AdminTableFieldSummarySchema:
    try:
        return _build_field_summary(table_id)
    except Exception:
        logger.exception('构建表格字段摘要失败: table_id=%s', table_id)
        return AdminTableFieldSummarySchema(
            total_fields=0,
            hidden_fields=0,
            primary_fields=0,
            field_type_stats=[],
        )

def _safe_build_recent_operations(table_id: UUID, limit: int = 10) -> list[AdminTableOperationItemSchema]:
    try:
        return _build_recent_operations(table_id, limit=limit)
    except Exception:
        logger.exception('构建最近治理动作失败: table_id=%s', table_id)
        return []

def _build_operation_queryset(
    *,
    action_type: str = 'all',
    success: bool | None = None,
    keyword: str = '',
    table_id: str = '',
    operator_id: str = '',
    start_at=None,
    end_at=None,
):
    normalized_action_type = (action_type or 'all').strip().lower()
    if normalized_action_type not in {'all', *VALID_OPERATION_ACTION_TYPES}:
        raise HttpError(400, 'action_type 参数不合法')

    queryset = TableAdminActionLog.objects.using(TABDATA_DB_ALIAS).all()
    if normalized_action_type != 'all':
        queryset = queryset.filter(action_type=normalized_action_type)

    if success is not None:
        queryset = queryset.filter(success=success)

    table_uuid = _parse_uuid_or_none(table_id)
    if table_uuid:
        queryset = queryset.filter(target_table_ids_text__icontains=f'|{table_uuid}|')

    operator_uuid = _parse_uuid_or_none(operator_id)
    if operator_uuid:
        queryset = queryset.filter(operator_id=operator_uuid)

    if start_at is not None:
        queryset = queryset.filter(created_at__gte=start_at)
    if end_at is not None:
        queryset = queryset.filter(created_at__lte=end_at)

    normalized_keyword = keyword.strip()
    if normalized_keyword:
        keyword_filter = (
            Q(action_type__icontains=normalized_keyword)
            | Q(operator_name__icontains=normalized_keyword)
            | Q(result_message__icontains=normalized_keyword)
            | Q(error_message__icontains=normalized_keyword)
            | Q(target_table_ids_text__icontains=normalized_keyword)
            | Q(trace_id__icontains=normalized_keyword)
        )
        keyword_uuid = _try_parse_uuid(normalized_keyword)
        if keyword_uuid:
            keyword_filter |= Q(operator_id=keyword_uuid)
        queryset = queryset.filter(keyword_filter)

    return queryset

@router.get('/tables', response=AdminTableListResponseSchema, auth=StaffAuth(), tags=['后台表格管理'])
def list_admin_tables(
    request,
    keyword: str = '',
    visibility: str = 'all',
    archived: str = 'all',
    organization_id: str = '',
    organization_query: str = '',
    space_id: str = '',
    space_query: str = '',
    owner_id: str = '',
    owner_query: str = '',
    page: int = 1,
    page_size: int = 20,
):
    """后台全局表格列表"""

    visibility = visibility.strip().lower()
    archived = archived.strip().lower()

    if visibility not in {'all', *VALID_VISIBILITY}:
        raise HttpError(400, 'visibility 参数不合法')
    if archived not in VALID_ARCHIVED:
        raise HttpError(400, 'archived 参数不合法')

    page = max(page, 1)
    page_size = max(1, min(page_size, 100))

    queryset = Table.objects.using(TABDATA_DB_ALIAS).all()

    if visibility != 'all':
        queryset = queryset.filter(visibility=visibility)

    if archived == 'trashed':
        queryset = queryset.filter(trashed_at__isnull=False)
    else:
        queryset = queryset.filter(trashed_at__isnull=True)

    if archived == 'active':
        queryset = queryset.filter(is_archived=False)
    elif archived == 'archived':
        queryset = queryset.filter(is_archived=True)

    organization_uuid = _parse_uuid_or_none(organization_id)
    if organization_uuid:
        queryset = queryset.filter(organization_id=organization_uuid)

    normalized_organization_query = organization_query.strip()
    if normalized_organization_query:
        organization_filter = Q(name__icontains=normalized_organization_query)
        organization_uuid_from_query = _try_parse_uuid(normalized_organization_query)
        if organization_uuid_from_query:
            organization_filter |= Q(id=organization_uuid_from_query)

        organization_ids = set(
            Organization.objects.filter(organization_filter).values_list('id', flat=True)
        )
        if organization_uuid_from_query:
            organization_ids.add(organization_uuid_from_query)

        if not organization_ids:
            queryset = queryset.none()
        else:
            queryset = queryset.filter(organization_id__in=list(organization_ids))

    as_uuid = _parse_uuid_or_none(space_id)
    if as_uuid:
        queryset = queryset.filter(space_id=as_uuid)

    normalized_as_query = space_query.strip()
    if normalized_as_query:
        as_filter = Q(name__icontains=normalized_as_query)
        as_uuid_from_query = _try_parse_uuid(normalized_as_query)
        if as_uuid_from_query:
            as_filter |= Q(id=as_uuid_from_query)

        from apps.tabtinspace.models import Project, Workspace
        space_ids = set(
            list(Workspace.objects.using(TABDATA_DB_ALIAS).filter(as_filter).values_list('id', flat=True))
            + list(Project.objects.using(TABDATA_DB_ALIAS).filter(as_filter).values_list('id', flat=True))
        )
        if as_uuid_from_query:
            space_ids.add(as_uuid_from_query)

        if not space_ids:
            queryset = queryset.none()
        else:
            queryset = queryset.filter(space_id__in=list(space_ids))

    normalized_owner_id = owner_id.strip()
    if normalized_owner_id:
        queryset = queryset.filter(owner_id=normalized_owner_id)

    normalized_owner_query = owner_query.strip()
    if normalized_owner_query:
        owner_filter = (
            Q(username__icontains=normalized_owner_query)
            | Q(nickname__icontains=normalized_owner_query)
            | Q(email__icontains=normalized_owner_query)
            | Q(phone__icontains=normalized_owner_query)
            | Q(id=normalized_owner_query)
        )
        owner_uuid_from_query = _try_parse_uuid(normalized_owner_query)
        if owner_uuid_from_query:
            owner_filter |= Q(id=str(owner_uuid_from_query))

        owner_ids = set(
            str(item_id)
            for item_id in User.objects.filter(owner_filter).values_list('id', flat=True)
        )
        if owner_uuid_from_query:
            owner_ids.add(str(owner_uuid_from_query))

        if not owner_ids:
            queryset = queryset.none()
        else:
            queryset = queryset.filter(owner_id__in=list(owner_ids))

    normalized_keyword = keyword.strip()
    if normalized_keyword:
        keyword_filter = Q(name__icontains=normalized_keyword) | Q(description__icontains=normalized_keyword)
        keyword_uuid = _try_parse_uuid(normalized_keyword)
        if keyword_uuid:
            keyword_filter |= Q(id=keyword_uuid)
        queryset = queryset.filter(keyword_filter)

    queryset = queryset.order_by('-updated_at')

    total = queryset.count()
    total_pages = (total + page_size - 1) // page_size if total else 0
    if total_pages and page > total_pages:
        page = total_pages

    offset = (page - 1) * page_size
    tables = list(queryset[offset:offset + page_size])
    organization_name_map, space_name_map, owner_name_map = _build_name_maps(tables)

    items = [
        _build_table_item(
            table,
            organization_name_map=organization_name_map,
            space_name_map=space_name_map,
            owner_name_map=owner_name_map,
        )
        for table in tables
    ]

    agg = Table.objects.using(TABDATA_DB_ALIAS).aggregate(
        total_tables=Count('id'),
        active_tables=Count(Case(When(is_archived=False, trashed_at__isnull=True, then=Value(1)), output_field=IntegerField())),
        archived_tables=Count(Case(When(is_archived=True, trashed_at__isnull=True, then=Value(1)), output_field=IntegerField())),
        trashed_tables=Count(Case(When(trashed_at__isnull=False, then=Value(1)), output_field=IntegerField())),
        system_tables=Count(Case(When(visibility__in=['system', 'hidden'], then=Value(1)), output_field=IntegerField())),
    )
    summary = AdminTableSummarySchema(
        total_tables=agg['total_tables'],
        filtered_tables=total,
        active_tables=agg['active_tables'],
        archived_tables=agg['archived_tables'],
        trashed_tables=agg['trashed_tables'],
        system_tables=agg['system_tables'],
    )

    return AdminTableListResponseSchema(
        items=items,
        pagination=AdminTablePaginationSchema(
            total=total,
            page=page,
            page_size=page_size,
            total_pages=total_pages,
        ),
        summary=summary,
    )

@router.get('/tables/operations', response=AdminTableOperationListResponseSchema, auth=StaffAuth(), tags=['后台表格管理'])
def list_admin_table_operations(
    request,
    action_type: str = 'all',
    success: bool | None = Query(None),
    keyword: str = '',
    table_id: str = '',
    operator_id: str = '',
    start_at: datetime | None = Query(None),
    end_at: datetime | None = Query(None),
    page: int = 1,
    page_size: int = 20,
):
    """后台治理动作列表"""

    if start_at and end_at and start_at > end_at:
        raise HttpError(400, 'start_at 不能晚于 end_at')

    page = max(page, 1)
    page_size = max(1, min(page_size, 100))

    filtered_queryset = _build_operation_queryset(
        action_type=action_type,
        success=success,
        keyword=keyword,
        table_id=table_id,
        operator_id=operator_id,
        start_at=start_at,
        end_at=end_at,
    )
    total = filtered_queryset.count()
    total_pages = (total + page_size - 1) // page_size if total else 0
    if total_pages and page > total_pages:
        page = total_pages

    offset = (page - 1) * page_size
    rows = list(filtered_queryset.order_by('-created_at')[offset:offset + page_size])
    items = [_serialize_operation_item(item) for item in rows]

    summary = AdminTableOperationSummarySchema(
        total_operations=total,
        success_operations=filtered_queryset.filter(success=True).count(),
        failed_operations=filtered_queryset.filter(success=False).count(),
        dry_run_operations=filtered_queryset.filter(dry_run=True).count(),
    )

    return AdminTableOperationListResponseSchema(
        items=items,
        pagination=AdminTablePaginationSchema(
            total=total,
            page=page,
            page_size=page_size,
            total_pages=total_pages,
        ),
        summary=summary,
    )

@router.post('/tables/audit/export', auth=StaffAuth(), tags=['后台表格管理'])
def export_admin_table_audit_logs(request, payload: AdminTableAuditExportRequestSchema):
    """导出后台治理动作日志（CSV）"""

    limit = max(1, min(payload.limit, 20000))
    queryset = _build_operation_queryset(
        action_type=payload.action_type,
        success=payload.success,
        keyword=payload.keyword,
        table_id=payload.table_id,
        operator_id=payload.operator_id,
        start_at=payload.start_at,
        end_at=payload.end_at,
    )
    logs = list(queryset.order_by('-created_at')[:limit])

    stream = io.StringIO()
    writer = csv.writer(stream)
    writer.writerow(
        [
            'log_id',
            'created_at',
            'action_type',
            'operator_id',
            'operator_name',
            'target_table_ids',
            'requested_count',
            'updated_count',
            'skipped_count',
            'dry_run',
            'success',
            'result_message',
            'error_message',
            'trace_id',
            'ip_address',
            'user_agent',
        ]
    )

    for item in logs:
        target_table_ids = item.target_table_ids if isinstance(item.target_table_ids, list) else []
        writer.writerow(
            [
                str(item.id),
                timezone.localtime(item.created_at).strftime('%Y-%m-%d %H:%M:%S'),
                item.action_type,
                str(item.operator_id) if item.operator_id else '',
                item.operator_name or '',
                ';'.join([str(table_id) for table_id in target_table_ids]),
                item.requested_count,
                item.updated_count,
                item.skipped_count,
                'yes' if item.dry_run else 'no',
                'success' if item.success else 'failed',
                item.result_message or '',
                item.error_message or '',
                item.trace_id or '',
                item.ip_address or '',
                item.user_agent or '',
            ]
        )

    response = HttpResponse(
        '\ufeff' + stream.getvalue(),
        content_type='text/csv; charset=utf-8',
    )
    filename = f"table_audit_logs_{timezone.localtime().strftime('%Y%m%d_%H%M%S')}.csv"
    response['Content-Disposition'] = f'attachment; filename="{filename}"'
    return response

@router.get('/tables/{table_id}', response=AdminTableDetailResponseSchema, auth=StaffAuth(), tags=['后台表格管理'])
def get_admin_table_detail(request, table_id: str):
    """后台表格详情"""

    table_uuid = _try_parse_uuid(table_id)
    if table_uuid is None:
        raise HttpError(400, '无效 table_id')

    table = Table.objects.using(TABDATA_DB_ALIAS).filter(id=table_uuid).first()
    if table is None:
        raise HttpError(404, '表格不存在')

    organization_name_map, space_name_map, owner_name_map = _build_name_maps([table])
    item = _build_table_item(
        table,
        organization_name_map=organization_name_map,
        space_name_map=space_name_map,
        owner_name_map=owner_name_map,
    )

    return AdminTableDetailResponseSchema(
        table=item,
        field_summary=_safe_build_field_summary(table.id),
        record_preview=_safe_build_record_preview(table.id),
        recent_operations=_safe_build_recent_operations(table.id),
    )

def _batch_update_archive_state(
    *,
    request,
    payload: AdminTableBatchMutationRequestSchema,
    target_archived: bool,
    permission_code: str,
    sensitive_action: str,
) -> AdminTableBatchMutationResponseSchema:
    action_type = 'batch_archive' if target_archived else 'batch_restore'

    _ensure_sensitive_reason(dry_run=payload.dry_run, reason=payload.reason)

    input_table_ids = _normalize_table_ids(payload.table_ids)
    if not input_table_ids:
        raise HttpError(400, '请至少选择 1 张表')
    if len(input_table_ids) > 500:
        raise HttpError(400, '单次批量操作最多 500 张表')

    skipped: list[AdminTableBatchSkipItemSchema] = []
    normalized_ids: list[str] = []
    valid_uuid_list: list[UUID] = []
    for raw_id in input_table_ids:
        table_uuid = _try_parse_uuid(raw_id)
        if table_uuid is None:
            skipped.append(AdminTableBatchSkipItemSchema(table_id=raw_id, reason='无效 UUID'))
            continue
        normalized = str(table_uuid)
        normalized_ids.append(normalized)
        valid_uuid_list.append(table_uuid)

    request_payload = {
        'table_ids': input_table_ids,
        'dry_run': payload.dry_run,
        'target_archived': target_archived,
    }
    table_map = {
        str(item.id): item
        for item in Table.objects.using(TABDATA_DB_ALIAS).filter(id__in=valid_uuid_list)
    }
    before_snapshots_by_id = {
        table_id: snapshot
        for table_id, snapshot in (
            (
                table_id,
                {
                    'table_id': str(table.id),
                    'name': table.name,
                    'is_archived': bool(table.is_archived),
                    'organization_id': str(table.organization_id) if table.organization_id else None,
                    'space_id': str(table.space_id) if table.space_id else None,
                    'visibility': table.visibility,
                },
            )
            for table_id, table in table_map.items()
        )
    }

    updated_tables: list[Table] = []
    result_payload: dict = {}

    try:
        with transaction.atomic(using=TABDATA_DB_ALIAS):
            for table_id in normalized_ids:
                table = table_map.get(table_id)
                if table is None:
                    skipped.append(AdminTableBatchSkipItemSchema(table_id=table_id, reason='表格不存在'))
                    continue

                if table.is_system_table:
                    skipped.append(AdminTableBatchSkipItemSchema(table_id=table_id, reason='系统表不允许此操作'))
                    continue

                if getattr(table, 'trashed_at', None):
                    skipped.append(AdminTableBatchSkipItemSchema(table_id=table_id, reason='表格在回收站中，请先使用回收站恢复'))
                    continue

                if table.is_archived == target_archived:
                    skipped.append(AdminTableBatchSkipItemSchema(table_id=table_id, reason='状态未变化'))
                    continue

                updated_tables.append(table)
                if payload.dry_run:
                    continue

                table.is_archived = target_archived
                table.save(update_fields=['is_archived', 'updated_at'])
                if target_archived:
                    ResourceBridge.on_archive(table, user=request.auth)
                else:
                    ResourceBridge.on_restore(table, user=request.auth)

        organization_name_map, space_name_map, owner_name_map = _build_name_maps(updated_tables)
        items = [
            _build_table_item(
                table,
                organization_name_map=organization_name_map,
                space_name_map=space_name_map,
                owner_name_map=owner_name_map,
            )
            for table in updated_tables
        ]

        action_name = '归档' if target_archived else '恢复'
        mode_prefix = '模拟' if payload.dry_run else '执行'
        response = AdminTableBatchMutationResponseSchema(
            success=True,
            message=f'{mode_prefix}{action_name}完成：成功 {len(items)}，跳过 {len(skipped)}',
            dry_run=payload.dry_run,
            requested_count=len(input_table_ids),
            processed_count=len(items),
            updated_count=len(items),
            skipped=skipped,
            items=items,
        )

        result_payload = {
            'updated_table_ids': [item.id for item in items],
            'skipped': [{'table_id': item.table_id, 'reason': item.reason} for item in skipped],
        }
        _record_table_admin_action(
            request=request,
            action_type=action_type,
            target_table_ids=normalized_ids,
            requested_count=len(input_table_ids),
            updated_count=response.updated_count,
            skipped_count=len(skipped),
            dry_run=payload.dry_run,
            success=True,
            result_message=response.message,
            request_payload=request_payload,
            result_payload=result_payload,
        )
        if not payload.dry_run:
            target_ids = normalized_ids
            _record_table_sensitive_action(
                request=request,
                permission_code=permission_code,
                action=sensitive_action,
                target_ids=target_ids,
                reason=payload.reason.strip(),
                ticket_id=(payload.ticket_id or '').strip(),
                affected_count=response.updated_count,
                before_preview=[
                    before_snapshots_by_id.get(item_id, {'table_id': item_id, 'unavailable': True})
                    for item_id in target_ids
                ],
                after_preview=_build_table_sensitive_snapshots(updated_tables),
            )
        return response
    except HttpError as exc:
        _record_table_admin_action(
            request=request,
            action_type=action_type,
            target_table_ids=normalized_ids,
            requested_count=len(input_table_ids),
            updated_count=len(updated_tables),
            skipped_count=len(skipped),
            dry_run=payload.dry_run,
            success=False,
            result_message='批量治理失败',
            error_message=getattr(exc, 'message', '') or str(exc),
            request_payload=request_payload,
            result_payload={
                'status_code': getattr(exc, 'status_code', None),
                'skipped': [{'table_id': item.table_id, 'reason': item.reason} for item in skipped],
                **result_payload,
            },
        )
        raise
    except Exception as exc:
        _record_table_admin_action(
            request=request,
            action_type=action_type,
            target_table_ids=normalized_ids,
            requested_count=len(input_table_ids),
            updated_count=len(updated_tables),
            skipped_count=len(skipped),
            dry_run=payload.dry_run,
            success=False,
            result_message='批量治理失败',
            error_message=str(exc),
            request_payload=request_payload,
            result_payload={
                'skipped': [{'table_id': item.table_id, 'reason': item.reason} for item in skipped],
                **result_payload,
            },
        )
        raise


def _batch_update_trash_state(
    *,
    request,
    payload: AdminTableBatchMutationRequestSchema,
    target_trashed: bool,
    permission_code: str,
    sensitive_action: str,
) -> AdminTableBatchMutationResponseSchema:
    action_type = 'batch_trash' if target_trashed else 'batch_untrash'
    _ensure_sensitive_reason(dry_run=payload.dry_run, reason=payload.reason)

    input_table_ids = _normalize_table_ids(payload.table_ids)
    if not input_table_ids:
        raise HttpError(400, '请至少选择 1 张表')
    if len(input_table_ids) > 500:
        raise HttpError(400, '单次批量操作最多 500 张表')

    skipped: list[AdminTableBatchSkipItemSchema] = []
    normalized_ids: list[str] = []
    valid_uuid_list: list[UUID] = []
    for raw_id in input_table_ids:
        table_uuid = _try_parse_uuid(raw_id)
        if table_uuid is None:
            skipped.append(AdminTableBatchSkipItemSchema(table_id=raw_id, reason='无效 UUID'))
            continue
        normalized = str(table_uuid)
        normalized_ids.append(normalized)
        valid_uuid_list.append(table_uuid)

    request_payload = {
        'table_ids': input_table_ids,
        'dry_run': payload.dry_run,
        'target_trashed': target_trashed,
    }
    table_map = {
        str(item.id): item
        for item in Table.objects.using(TABDATA_DB_ALIAS).filter(id__in=valid_uuid_list)
    }
    before_snapshots_by_id = {
        table_id: snapshot
        for table_id, snapshot in (
            (
                table_id,
                {
                    'table_id': str(table.id),
                    'name': table.name,
                    'is_archived': bool(table.is_archived),
                    'is_trashed': bool(getattr(table, 'trashed_at', None)),
                    'trashed_at': table.trashed_at.isoformat() if getattr(table, 'trashed_at', None) else None,
                    'previous_status': getattr(table, 'previous_status', '') or '',
                    'organization_id': str(table.organization_id) if table.organization_id else None,
                    'space_id': str(table.space_id) if table.space_id else None,
                    'visibility': table.visibility,
                },
            )
            for table_id, table in table_map.items()
        )
    }

    updated_tables: list[Table] = []
    result_payload: dict = {}
    table_service = TableService(user=request.auth)

    try:
        with transaction.atomic(using=TABDATA_DB_ALIAS):
            for table_id in normalized_ids:
                table = table_map.get(table_id)
                if table is None:
                    skipped.append(AdminTableBatchSkipItemSchema(table_id=table_id, reason='表格不存在'))
                    continue

                if table.is_system_table:
                    skipped.append(AdminTableBatchSkipItemSchema(table_id=table_id, reason='系统表不允许此操作'))
                    continue

                is_trashed = bool(getattr(table, 'trashed_at', None))
                if is_trashed == target_trashed:
                    skipped.append(AdminTableBatchSkipItemSchema(table_id=table_id, reason='状态未变化'))
                    continue

                updated_tables.append(table)
                if payload.dry_run:
                    continue

                if target_trashed:
                    table.trash(user_id=getattr(request.auth, 'id', None))
                    bump_table_schema_version_token(table.id, reason="trash", user=request.auth)
                    ResourceBridge.on_trash(table, user=request.auth)
                else:
                    if table.space_id:
                        from apps.tabtinspace.services.host_resolver import lock_host_for_update
                        lock_host_for_update(table.space_id, using=TABDATA_DB_ALIAS)
                    QuotaService().check_quota(
                        quota_type='max_tables',
                        increment=1,
                        organization_id=str(table.organization_id) if table.organization_id else None,
                        actor=request.auth,
                    )
                    ResourceBridge.check_restore_quota(table)
                    table.restore_from_trash()
                    bump_table_schema_version_token(table.id, reason="restore", user=request.auth)
                    fields = list(TableField.objects.using(TABDATA_DB_ALIAS).filter(
                        table_id=table.id, is_deleted=False,
                    ))
                    from apps.tabdata.native.ddl_manager import resolve_schema_partition_id
                    table_service._native_ensure_table(
                        resolve_schema_partition_id(table), table.id, fields,
                    )
                    ResourceBridge.on_restore(table, user=request.auth)

        organization_name_map, space_name_map, owner_name_map = _build_name_maps(updated_tables)
        items = [
            _build_table_item(
                table,
                organization_name_map=organization_name_map,
                space_name_map=space_name_map,
                owner_name_map=owner_name_map,
            )
            for table in updated_tables
        ]

        action_name = '逻辑删除' if target_trashed else '回收站恢复'
        mode_prefix = '模拟' if payload.dry_run else '执行'
        response = AdminTableBatchMutationResponseSchema(
            success=True,
            message=f'{mode_prefix}{action_name}完成：成功 {len(items)}，跳过 {len(skipped)}',
            dry_run=payload.dry_run,
            requested_count=len(input_table_ids),
            processed_count=len(items),
            updated_count=len(items),
            skipped=skipped,
            items=items,
        )

        result_payload = {
            'updated_table_ids': [item.id for item in items],
            'skipped': [{'table_id': item.table_id, 'reason': item.reason} for item in skipped],
        }
        _record_table_admin_action(
            request=request,
            action_type=action_type,
            target_table_ids=normalized_ids,
            requested_count=len(input_table_ids),
            updated_count=response.updated_count,
            skipped_count=len(skipped),
            dry_run=payload.dry_run,
            success=True,
            result_message=response.message,
            request_payload=request_payload,
            result_payload=result_payload,
        )
        if not payload.dry_run:
            target_ids = normalized_ids
            _record_table_sensitive_action(
                request=request,
                permission_code=permission_code,
                action=sensitive_action,
                target_ids=target_ids,
                reason=payload.reason.strip(),
                ticket_id=(payload.ticket_id or '').strip(),
                affected_count=response.updated_count,
                before_preview=[
                    before_snapshots_by_id.get(item_id, {'table_id': item_id, 'unavailable': True})
                    for item_id in target_ids
                ],
                after_preview=_build_table_sensitive_snapshots(updated_tables),
            )
        return response
    except HttpError as exc:
        _record_table_admin_action(
            request=request,
            action_type=action_type,
            target_table_ids=normalized_ids,
            requested_count=len(input_table_ids),
            updated_count=len(updated_tables),
            skipped_count=len(skipped),
            dry_run=payload.dry_run,
            success=False,
            result_message='批量逻辑删除治理失败',
            error_message=getattr(exc, 'message', '') or str(exc),
            request_payload=request_payload,
            result_payload={
                'status_code': getattr(exc, 'status_code', None),
                'skipped': [{'table_id': item.table_id, 'reason': item.reason} for item in skipped],
                **result_payload,
            },
        )
        raise
    except Exception as exc:
        _record_table_admin_action(
            request=request,
            action_type=action_type,
            target_table_ids=normalized_ids,
            requested_count=len(input_table_ids),
            updated_count=len(updated_tables),
            skipped_count=len(skipped),
            dry_run=payload.dry_run,
            success=False,
            result_message='批量逻辑删除治理失败',
            error_message=str(exc),
            request_payload=request_payload,
            result_payload={
                'skipped': [{'table_id': item.table_id, 'reason': item.reason} for item in skipped],
                **result_payload,
            },
        )
        raise


def _repair_search_index_by_admin(
    *,
    table_id: UUID,
    user,
    dry_run: bool,
) -> dict:
    """
    后台索引修复（绕过业务权限，仅供 admin_api superuser 调用）。
    返回结构用于批量动作的结果聚合与审计。
    """
    from apps.tabdata.services.search_index_service import SearchIndexService

    service = SearchIndexService(user=user)
    connection = service._get_connection()
    if connection.vendor != 'postgresql':
        return {
            'status': 'unsupported',
            'reason': '当前数据库不支持搜索索引',
        }

    searchable_fields = service._list_searchable_fields(table_id)
    existing_indexes = service._fetch_existing_indexes(table_id)
    if not existing_indexes:
        return {
            'status': 'not_enabled',
            'reason': '索引未启用，跳过修复',
        }

    expected_indexes = service._build_expected_index_map(table_id, searchable_fields)
    abnormalities = service._collect_abnormal_indexes(expected_indexes, existing_indexes)
    abnormal_count = len(abnormalities)
    if abnormal_count == 0:
        return {
            'status': 'healthy',
            'reason': '索引健康，无需修复',
            'abnormal_count_before': 0,
            'abnormal_count_after': 0,
        }

    drop_names: set[str] = set()
    create_field_ids: set[UUID] = set()
    field_map = {str(field.id): field for field in searchable_fields}

    for item in abnormalities:
        issue = item.get('issue')
        index_name = item.get('index_name')
        field_id = item.get('field_id')

        if issue in {'redundant', 'definition_mismatch'} and isinstance(index_name, str):
            drop_names.add(index_name)

        if issue in {'missing', 'definition_mismatch'} and isinstance(field_id, str):
            field = field_map.get(field_id)
            if field:
                create_field_ids.add(field.id)

    if dry_run:
        return {
            'status': 'would_repair',
            'reason': f'将修复 {abnormal_count} 项索引异常',
            'abnormal_count_before': abnormal_count,
            'drop_count': len(drop_names),
            'create_count': len(create_field_ids),
        }

    if drop_names or create_field_ids:
        service._ensure_pg_trgm_extension()

    for index_name in drop_names:
        service._drop_index(index_name)
    for field_id in create_field_ids:
        service._create_single_index(table_id, field_id)

    abnormalities_after = service._collect_abnormal_indexes(
        expected_indexes,
        service._fetch_existing_indexes(table_id),
    )
    return {
        'status': 'repaired',
        'reason': f'修复前异常 {abnormal_count} 项，修复后 {len(abnormalities_after)} 项',
        'abnormal_count_before': abnormal_count,
        'abnormal_count_after': len(abnormalities_after),
        'drop_count': len(drop_names),
        'create_count': len(create_field_ids),
    }

def _batch_repair_search_index(
    *,
    request,
    payload: AdminTableBatchMutationRequestSchema,
    permission_code: str,
    sensitive_action: str,
) -> AdminTableBatchMutationResponseSchema:
    action_type = 'batch_search_index_repair'

    _ensure_sensitive_reason(dry_run=payload.dry_run, reason=payload.reason)

    input_table_ids = _normalize_table_ids(payload.table_ids)
    if not input_table_ids:
        raise HttpError(400, '请至少选择 1 张表')
    if len(input_table_ids) > 500:
        raise HttpError(400, '单次批量操作最多 500 张表')

    skipped: list[AdminTableBatchSkipItemSchema] = []
    normalized_ids: list[str] = []
    valid_uuid_list: list[UUID] = []
    for raw_id in input_table_ids:
        table_uuid = _try_parse_uuid(raw_id)
        if table_uuid is None:
            skipped.append(AdminTableBatchSkipItemSchema(table_id=raw_id, reason='无效 UUID'))
            continue
        normalized = str(table_uuid)
        normalized_ids.append(normalized)
        valid_uuid_list.append(table_uuid)

    request_payload = {
        'table_ids': input_table_ids,
        'dry_run': payload.dry_run,
        'action': action_type,
    }
    table_map = {
        str(item.id): item
        for item in Table.objects.using(TABDATA_DB_ALIAS).filter(id__in=valid_uuid_list)
    }
    before_snapshots_by_id = {
        table_id: snapshot
        for table_id, snapshot in (
            (
                table_id,
                {
                    'table_id': str(table.id),
                    'name': table.name,
                    'is_archived': bool(table.is_archived),
                    'organization_id': str(table.organization_id) if table.organization_id else None,
                    'space_id': str(table.space_id) if table.space_id else None,
                    'visibility': table.visibility,
                },
            )
            for table_id, table in table_map.items()
        )
    }

    processed_tables: list[Table] = []
    repair_details: dict[str, dict] = {}

    try:
        for table_id in normalized_ids:
            table = table_map.get(table_id)
            if table is None:
                skipped.append(AdminTableBatchSkipItemSchema(table_id=table_id, reason='表格不存在'))
                continue

            try:
                result = _repair_search_index_by_admin(
                    table_id=table.id,
                    user=request.auth,
                    dry_run=payload.dry_run,
                )
            except Exception as exc:
                skipped.append(AdminTableBatchSkipItemSchema(table_id=table_id, reason=f'索引修复失败: {exc}'))
                continue

            status = str(result.get('status') or '')
            reason = str(result.get('reason') or '跳过')
            if status in {'unsupported', 'not_enabled', 'healthy'}:
                skipped.append(AdminTableBatchSkipItemSchema(table_id=table_id, reason=reason))
                continue

            processed_tables.append(table)
            repair_details[table_id] = result

        organization_name_map, space_name_map, owner_name_map = _build_name_maps(processed_tables)
        items = [
            _build_table_item(
                table,
                organization_name_map=organization_name_map,
                space_name_map=space_name_map,
                owner_name_map=owner_name_map,
            )
            for table in processed_tables
        ]

        mode_prefix = '模拟' if payload.dry_run else '执行'
        response = AdminTableBatchMutationResponseSchema(
            success=True,
            message=f'{mode_prefix}索引修复完成：成功 {len(items)}，跳过 {len(skipped)}',
            dry_run=payload.dry_run,
            requested_count=len(input_table_ids),
            processed_count=len(items),
            updated_count=len(items),
            skipped=skipped,
            items=items,
        )

        _record_table_admin_action(
            request=request,
            action_type=action_type,
            target_table_ids=normalized_ids,
            requested_count=len(input_table_ids),
            updated_count=response.updated_count,
            skipped_count=len(skipped),
            dry_run=payload.dry_run,
            success=True,
            result_message=response.message,
            request_payload=request_payload,
            result_payload={
                'repair_details': repair_details,
                'skipped': [{'table_id': item.table_id, 'reason': item.reason} for item in skipped],
            },
        )
        if not payload.dry_run:
            target_ids = normalized_ids
            _record_table_sensitive_action(
                request=request,
                permission_code=permission_code,
                action=sensitive_action,
                target_ids=target_ids,
                reason=payload.reason.strip(),
                ticket_id=(payload.ticket_id or '').strip(),
                affected_count=response.updated_count,
                before_preview=[
                    before_snapshots_by_id.get(item_id, {'table_id': item_id, 'unavailable': True})
                    for item_id in target_ids
                ],
                after_preview=[
                    {
                        **snapshot,
                        'repair_result': repair_details.get(item_id, {}),
                    }
                    for item_id, snapshot in (
                        (item_id, before_snapshots_by_id.get(item_id, {'table_id': item_id}))
                        for item_id in target_ids
                    )
                ],
            )
        return response
    except HttpError as exc:
        _record_table_admin_action(
            request=request,
            action_type=action_type,
            target_table_ids=normalized_ids,
            requested_count=len(input_table_ids),
            updated_count=len(processed_tables),
            skipped_count=len(skipped),
            dry_run=payload.dry_run,
            success=False,
            result_message='批量索引修复失败',
            error_message=getattr(exc, 'message', '') or str(exc),
            request_payload=request_payload,
            result_payload={'repair_details': repair_details},
        )
        raise
    except Exception as exc:
        _record_table_admin_action(
            request=request,
            action_type=action_type,
            target_table_ids=normalized_ids,
            requested_count=len(input_table_ids),
            updated_count=len(processed_tables),
            skipped_count=len(skipped),
            dry_run=payload.dry_run,
            success=False,
            result_message='批量索引修复失败',
            error_message=str(exc),
            request_payload=request_payload,
            result_payload={'repair_details': repair_details},
        )
        raise

@router.post(
    '/tables/batch/archive',
    response=AdminTableBatchMutationResponseSchema,
    auth=AdminPermissionAuth('table:delete'),
    tags=['后台表格管理'],
)
def batch_archive_tables(request, payload: AdminTableBatchMutationRequestSchema):
    """批量归档表格"""
    return _batch_update_archive_state(
        request=request,
        payload=payload,
        target_archived=True,
        permission_code='table:delete',
        sensitive_action='table.archive',
    )

@router.post(
    '/tables/batch/restore',
    response=AdminTableBatchMutationResponseSchema,
    auth=AdminPermissionAuth('table:restore'),
    tags=['后台表格管理'],
)
def batch_restore_tables(request, payload: AdminTableBatchMutationRequestSchema):
    """批量恢复表格"""
    return _batch_update_archive_state(
        request=request,
        payload=payload,
        target_archived=False,
        permission_code='table:restore',
        sensitive_action='table.restore',
    )


@router.post(
    '/tables/batch/trash',
    response=AdminTableBatchMutationResponseSchema,
    auth=AdminPermissionAuth('table:delete'),
    tags=['后台表格管理'],
)
def batch_trash_tables(request, payload: AdminTableBatchMutationRequestSchema):
    """批量逻辑删除表格：移入回收站。"""
    return _batch_update_trash_state(
        request=request,
        payload=payload,
        target_trashed=True,
        permission_code='table:delete',
        sensitive_action='table.trash',
    )


@router.post(
    '/tables/batch/untrash',
    response=AdminTableBatchMutationResponseSchema,
    auth=AdminPermissionAuth('table:restore'),
    tags=['后台表格管理'],
)
def batch_untrash_tables(request, payload: AdminTableBatchMutationRequestSchema):
    """批量从回收站恢复表格。"""
    return _batch_update_trash_state(
        request=request,
        payload=payload,
        target_trashed=False,
        permission_code='table:restore',
        sensitive_action='table.untrash',
    )


def _single_table_trash_state(
    *,
    request,
    table_id: str,
    payload: AdminTableSensitiveActionRequestSchema,
    target_trashed: bool,
    permission_code: str,
    sensitive_action: str,
) -> AdminTableBatchMutationResponseSchema:
    _ensure_sensitive_reason(dry_run=False, reason=payload.reason)
    table_uuid = _try_parse_uuid(table_id)
    if table_uuid is None:
        raise HttpError(400, '无效 UUID')

    table = Table.objects.using(TABDATA_DB_ALIAS).filter(id=table_uuid).first()
    if table is None:
        raise HttpError(404, '表格不存在')
    if table.is_system_table:
        raise HttpError(400, '系统表不允许此操作')

    before_snapshot = _build_table_sensitive_snapshots([table])
    is_trashed = bool(getattr(table, 'trashed_at', None))
    skipped: list[AdminTableBatchSkipItemSchema] = []
    updated_tables: list[Table] = []
    message = '状态未变化'

    if is_trashed == target_trashed:
        skipped.append(AdminTableBatchSkipItemSchema(table_id=str(table_uuid), reason='状态未变化'))
    else:
        table_service = TableService(user=request.auth)
        with transaction.atomic(using=TABDATA_DB_ALIAS):
            if target_trashed:
                table.trash(user_id=getattr(request.auth, 'id', None))
                bump_table_schema_version_token(table.id, reason="trash", user=request.auth)
                ResourceBridge.on_trash(table, user=request.auth)
                message = '执行逻辑删除完成：成功 1，跳过 0'
            else:
                if table.space_id:
                    from apps.tabtinspace.services.host_resolver import lock_host_for_update
                    lock_host_for_update(table.space_id, using=TABDATA_DB_ALIAS)
                QuotaService().check_quota(
                    quota_type='max_tables',
                    increment=1,
                    organization_id=str(table.organization_id) if table.organization_id else None,
                    actor=request.auth,
                )
                ResourceBridge.check_restore_quota(table)
                table.restore_from_trash()
                bump_table_schema_version_token(table.id, reason="restore", user=request.auth)
                fields = list(TableField.objects.using(TABDATA_DB_ALIAS).filter(
                    table_id=table.id,
                    is_deleted=False,
                ))
                from apps.tabdata.native.ddl_manager import resolve_schema_partition_id
                table_service._native_ensure_table(
                    resolve_schema_partition_id(table), table.id, fields,
                )
                ResourceBridge.on_restore(table, user=request.auth)
                message = '执行回收站恢复完成：成功 1，跳过 0'
        updated_tables.append(table)

    organization_name_map, space_name_map, owner_name_map = _build_name_maps(updated_tables)
    items = [
        _build_table_item(
            item,
            organization_name_map=organization_name_map,
            space_name_map=space_name_map,
            owner_name_map=owner_name_map,
        )
        for item in updated_tables
    ]
    if skipped:
        message = f"执行{'逻辑删除' if target_trashed else '回收站恢复'}完成：成功 0，跳过 1"

    action_type = 'single_trash' if target_trashed else 'single_untrash'
    _record_table_admin_action(
        request=request,
        action_type=action_type,
        target_table_ids=[str(table_uuid)],
        requested_count=1,
        updated_count=len(items),
        skipped_count=len(skipped),
        dry_run=False,
        success=True,
        result_message=message,
        request_payload={'table_id': str(table_uuid), 'target_trashed': target_trashed},
        result_payload={'skipped': [{'table_id': item.table_id, 'reason': item.reason} for item in skipped]},
    )
    _record_table_sensitive_action(
        request=request,
        permission_code=permission_code,
        action=sensitive_action,
        target_ids=[str(table_uuid)],
        reason=payload.reason.strip(),
        ticket_id=(payload.ticket_id or '').strip(),
        affected_count=len(items),
        before_preview=before_snapshot,
        after_preview=_build_table_sensitive_snapshots(updated_tables),
    )
    return AdminTableBatchMutationResponseSchema(
        success=True,
        message=message,
        dry_run=False,
        requested_count=1,
        processed_count=len(items),
        updated_count=len(items),
        skipped=skipped,
        items=items,
    )


@router.post(
    '/tables/{table_id}/trash',
    response=AdminTableBatchMutationResponseSchema,
    auth=AdminPermissionAuth('table:delete'),
    tags=['后台表格管理'],
)
def trash_admin_table(request, table_id: str, payload: AdminTableSensitiveActionRequestSchema):
    """单表逻辑删除：移入回收站。"""
    return _single_table_trash_state(
        request=request,
        table_id=table_id,
        payload=payload,
        target_trashed=True,
        permission_code='table:delete',
        sensitive_action='table.trash',
    )


@router.post(
    '/tables/{table_id}/untrash',
    response=AdminTableBatchMutationResponseSchema,
    auth=AdminPermissionAuth('table:restore'),
    tags=['后台表格管理'],
)
def untrash_admin_table(request, table_id: str, payload: AdminTableSensitiveActionRequestSchema):
    """单表从回收站恢复。"""
    return _single_table_trash_state(
        request=request,
        table_id=table_id,
        payload=payload,
        target_trashed=False,
        permission_code='table:restore',
        sensitive_action='table.untrash',
    )


@router.post(
    '/tables/batch/search-index/repair',
    response=AdminTableBatchMutationResponseSchema,
    auth=AdminPermissionAuth('table:repair'),
    tags=['后台表格管理'],
)
def batch_repair_table_search_index(request, payload: AdminTableBatchMutationRequestSchema):
    """批量修复搜索索引"""
    return _batch_repair_search_index(
        request=request,
        payload=payload,
        permission_code='table:repair',
        sensitive_action='table.search_index.repair',
    )
