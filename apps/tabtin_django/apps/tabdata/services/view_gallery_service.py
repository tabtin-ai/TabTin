"""
画廊视图数据服务

从 view_data_service.py 提取的画廊视图相关数据查询方法。
"""
from typing import Dict, Any, Optional, List, Set, Tuple, Literal

from django.db import DatabaseError, transaction

from apps.tabdata.constants import TABDATA_DB_ALIAS
from apps.tabdata.models import TableView, TableRecord, TableField
from apps.tabdata.utils.record_serializers import serialize_records, serialize_native_rows
from .view_grid_service import filter_native_record_fields
from .view_filter_service import apply_view_filters, resolve_effective_filter
from .view_grid_service import build_native_search_where, merge_native_where_clauses
from .view_version_sync import (
    get_latest_version_state,
    has_changes_since_version,
    requires_full_reload_since_version,
)

import logging

_logger = logging.getLogger('tabdata.view_gallery_service')


def get_gallery_data(
    view: TableView,
    page: int,
    page_size: int,
    fields: Optional[Set[str]] = None,
    *,
    field_key_type: Literal['id', 'name', 'dbFieldName'] = 'name',
    since_version: Optional[int] = None,
    filters: Optional[List[Dict[str, Any]]] = None,
    filter_logic: Optional[str] = None,
    sorts: Optional[List[Dict[str, Any]]] = None,
    serialized_view: Dict[str, Any],
    search: Optional[str] = None,
    search_field_ids: Optional[List[str]] = None,
    search_hide_not_match_rows: bool = False,
    rls_context=None,
) -> Dict[str, Any]:
    """获取画廊视图数据"""
    queryset = TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
        table=view.table,
        is_deleted=False
    )
    queryset = apply_view_filters(view, queryset, filters, filter_logic)

    # ── RLS 行级安全策略注入（ORM 基础 queryset）──
    if rls_context is not None:
        from .rls_service import apply_rls_to_orm_queryset
        queryset = apply_rls_to_orm_queryset(queryset, view.table_id, rls_context)

    effective_sorts = sorts if sorts is not None else (view.sorts if view.sorts else None)
    if effective_sorts:
        from .view_group_sort_service import apply_view_sorts
        queryset = apply_view_sorts(view, queryset, sorts_override=effective_sorts)
    else:
        queryset = queryset.order_by('order', '-created_at')

    version_state = get_latest_version_state(queryset, table_id=view.table_id)
    latest_version = int(version_state['latest_version'])
    has_changes = has_changes_since_version(
        since_version=since_version,
        version_state=version_state,
    )
    requires_full_reload = requires_full_reload_since_version(
        since_version=since_version,
        version_state=version_state,
    )
    if requires_full_reload:
        has_changes = True

    serialized_records: List[Dict[str, Any]] = []
    total = 0
    _gallery_data_source = 'native'
    start = (page - 1) * page_size
    try:
        with transaction.atomic(using=TABDATA_DB_ALIAS):
            serialized_records, total = get_gallery_records_native(
                view, page, page_size, fields, field_key_type,
                filters, filter_logic, sorts=sorts,
                search=search,
                search_field_ids=search_field_ids,
                search_hide_not_match_rows=search_hide_not_match_rows,
                rls_context=rls_context,
            )
    except (DatabaseError, KeyError, TypeError, ValueError) as exc:
        _logger.warning("Gallery native query failed, falling back to ORM: %s", exc)
        _gallery_data_source = 'orm_fallback'
        total = queryset.count()
        end = start + page_size
        orm_records = list(queryset[start:end])
        serialized_records = serialize_records(
            orm_records, fields=fields,
            field_key_type=field_key_type,
        )

    matched_total = total
    cards_per_row = int((view.config or {}).get('cards_per_row', 4) or 4)
    cards_per_row = max(1, cards_per_row)
    card_size = (view.config or {}).get('card_size', 'medium')
    rows = (len(serialized_records) + cards_per_row - 1) // cards_per_row if serialized_records else 0

    gallery_meta: Dict[str, Any] = {
        'view_type': 'gallery',
        'card_size': card_size,
        'grid_layout': {
            'columns': cards_per_row,
            'rows': rows,
        },
    }
    if _gallery_data_source != 'native':
        gallery_meta['data_source'] = _gallery_data_source

    return {
        'view': serialized_view,
        'records': serialized_records,
        'total': total,
        'matched_total': matched_total,
        'page': page,
        'page_size': page_size,
        'metadata': gallery_meta,
        'latest_version': int(latest_version),
        'has_changes': has_changes,
        'requires_full_reload': requires_full_reload,
    }


def get_gallery_records_native(
    view, page, page_size, fields, field_key_type,
    filters, filter_logic,
    *, sorts: Optional[List[Dict[str, Any]]] = None,
    search: Optional[str] = None,
    search_field_ids: Optional[List[str]] = None,
    search_hide_not_match_rows: bool = False,
    rls_context=None,
) -> Tuple[List[Dict[str, Any]], int]:
    from apps.tabdata.native.query_builder import NativeQueryBuilder
    from apps.tabdata.native.record_io import NativeRecordIO
    from apps.tabdata.native.pg_type_map import is_system_field
    from apps.tabdata.native.ddl_manager import resolve_schema_partition_id

    table = view.table
    space_id = resolve_schema_partition_id(table)
    all_fields = list(TableField.objects.using(TABDATA_DB_ALIAS).filter(table_id=table.id, is_deleted=False))
    user_fields = [f for f in all_fields if not is_system_field(f.field_type)]
    qb = NativeQueryBuilder(space_id, table.id, all_fields)
    native_io = NativeRecordIO(space_id, table.id)

    effective_filter = resolve_effective_filter(view, filters, filter_logic)
    where = qb.build_where_clause(effective_filter)

    normalized_search = (search or '').strip()
    if search_hide_not_match_rows and normalized_search:
        search_where = build_native_search_where(
            qb=qb, all_fields=all_fields,
            search_value=normalized_search,
            search_field_ids=search_field_ids,
        )
        where = merge_native_where_clauses(where, search_where)

    # ── RLS 行级安全策略注入 ──
    if rls_context is not None:
        from .rls_service import build_rls_select_where
        where = build_rls_select_where(table, rls_context, qb, where)

    effective_sorts = sorts if sorts is not None else (view.sorts if view.sorts else None)
    order_by = qb.build_order_clause(effective_sorts) if effective_sorts else ('"__order" ASC, "__created_at" DESC', [])
    start_offset = max(0, (page - 1) * page_size)

    total = native_io.count_records(where=where)
    rows, _ = native_io.read_records(
        qb, where=where, order_by=order_by,
        limit=page_size, offset=start_offset,
    )
    serialized = serialize_native_rows(
        rows, table.id, user_fields, field_key_type=field_key_type,
    )
    if fields is not None:
        serialized = filter_native_record_fields(
            serialized, fields,
            all_fields=all_fields, field_key_type=field_key_type,
        )
    return serialized, total
