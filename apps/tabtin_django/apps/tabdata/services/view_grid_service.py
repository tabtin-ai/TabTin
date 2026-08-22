"""
Grid 视图数据服务

从 view_data_service.py 提取的 Grid 视图相关数据查询方法。
"""
from typing import Dict, Any, Optional, List, Set, Tuple, Literal
from uuid import UUID
from datetime import date, datetime, timezone as datetime_timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
import re
from django.db import connections, DatabaseError, transaction
from django.utils import timezone

from apps.tabdata.constants import TABDATA_DB_ALIAS
from apps.tabdata.models import TableView, TableRecord, TableField
from apps.tabdata.utils.record_serializers import (
    serialize_records,
    serialize_native_rows,
    filter_native_record_fields,
)
from apps.tabdata.utils.record_data_access import read_data
from .view_filter_service import (
    normalize_filter_operator,
    normalize_filter_value,
    is_boolean_field,
    is_nested_filter,
    parse_checkbox_state,
    resolve_effective_filter,
    apply_view_filters,
    resolve_date_comparison_range,
)
from .view_statistics_service import (
    is_cell_value_empty,
    parse_numeric_value,
)
from .view_group_sort_service import (
    build_group_metadata,
    build_group_metadata_native,
    merge_group_and_user_sorts,
)
from .view_sub_record_tree_service import (
    apply_sub_record_tree_order,
)
from .view_version_sync import (
    is_monotonic_version_token,
    decode_monotonic_version_token,
    encode_monotonic_version_token,
    get_latest_version_state,
    get_table_record_version_state,
    has_changes_since_version,
    requires_full_reload_since_version,
)
from . import view_constants as _vc

import logging

_logger = logging.getLogger('tabdata.view_grid_service')

_ORM_FALLBACK_MAX_RECORDS = 10_000

_FILTER_NEGATIVE_OPERATOR_MAP = _vc.FILTER_NEGATIVE_OPERATOR_MAP
_DATE_FILTER_FIELD_TYPES = frozenset({
    'date', 'created_time', 'last_modified_time',
})


def _get_field_timezone(field_meta: Optional[TableField], expected: Any = None) -> ZoneInfo:
    config = field_meta.config if field_meta and isinstance(field_meta.config, dict) else {}
    formatting = config.get('formatting')
    tz_name = (
        expected.get('timeZone')
        if isinstance(expected, dict)
        else None
    ) or (
        formatting.get('timeZone')
        if isinstance(formatting, dict)
        else None
    ) or 'UTC'
    try:
        return ZoneInfo(tz_name)
    except (KeyError, ZoneInfoNotFoundError):
        return ZoneInfo('UTC')


def _parse_date_like_timestamp_ms(value: Any, field_tz: ZoneInfo) -> Optional[int]:
    if isinstance(value, datetime):
        dt = value if value.tzinfo is not None else value.replace(tzinfo=field_tz)
        return int(dt.astimezone(datetime_timezone.utc).timestamp() * 1000)
    if isinstance(value, date):
        dt = datetime.combine(value, datetime.min.time(), tzinfo=field_tz)
        return int(dt.astimezone(datetime_timezone.utc).timestamp() * 1000)
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if not value == value:  # NaN guard
            return None
        normalized = float(value)
        if abs(normalized) < 1e11:
            normalized *= 1000
        try:
            dt = datetime.fromtimestamp(normalized / 1000, tz=datetime_timezone.utc)
            return int(dt.timestamp() * 1000)
        except (OverflowError, OSError, ValueError):
            return None
    if not isinstance(value, str):
        return None

    trimmed = value.strip()
    if not trimmed:
        return None
    if re.fullmatch(r'\d{4}-\d{2}-\d{2}', trimmed[:10]):
        try:
            dt = datetime.combine(date.fromisoformat(trimmed[:10]), datetime.min.time(), tzinfo=field_tz)
            return int(dt.astimezone(datetime_timezone.utc).timestamp() * 1000)
        except ValueError:
            return None
    try:
        dt = datetime.fromisoformat(trimmed.replace('Z', '+00:00'))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=field_tz)
    else:
        dt = dt.astimezone(datetime_timezone.utc)
    return int(dt.astimezone(datetime_timezone.utc).timestamp() * 1000)


# ══════════════════════════════════════════════════════════════
# Grid 入口
# ══════════════════════════════════════════════════════════════

def get_grid_data(
    view: TableView,
    page: int,
    page_size: int,
    fields: Optional[Set[str]] = None,
    *,
    field_key_type: Literal['id', 'name', 'dbFieldName'] = 'name',
    since_version: Optional[int] = None,
    only_delta: bool = False,
    metadata_view_type: str = 'grid',
    filters: Optional[List[Dict[str, Any]]] = None,
    filter_logic: Optional[str] = None,
    groups: Optional[List[Dict[str, Any]]] = None,
    sorts: Optional[List[Dict[str, Any]]] = None,
    search: Optional[str] = None,
    search_field_ids: Optional[List[str]] = None,
    search_hide_not_match_rows: bool = False,
    serialized_view: Dict[str, Any],
    all_fields: Optional[List[TableField]] = None,
    rls_context=None,
) -> Dict[str, Any]:
    """
    获取表格视图数据（原生列优先，异常时降级到 ORM）
    """
    kwargs = dict(
        field_key_type=field_key_type,
        since_version=since_version,
        only_delta=only_delta,
        metadata_view_type=metadata_view_type,
        filters=filters,
        filter_logic=filter_logic,
        groups=groups,
        sorts=sorts,
        search=search,
        search_field_ids=search_field_ids,
        search_hide_not_match_rows=search_hide_not_match_rows,
        serialized_view=serialized_view,
        all_fields=all_fields,
        rls_context=rls_context,
    )
    try:
        with transaction.atomic(using=TABDATA_DB_ALIAS):
            return get_grid_data_native(view, page, page_size, fields, **kwargs)
    except (DatabaseError, KeyError, TypeError, ValueError) as exc:
        _logger.warning("Grid native query failed, falling back to ORM: %s", exc)
        result = get_grid_data_orm_compat(view, page, page_size, fields, **kwargs)
        result.setdefault('metadata', {})['data_source'] = 'orm_fallback'
        return result


# ══════════════════════════════════════════════════════════════
# ORM 兼容路径
# ══════════════════════════════════════════════════════════════

def get_grid_data_orm_compat(
    view: TableView,
    page: int,
    page_size: int,
    fields: Optional[Set[str]] = None,
    *,
    field_key_type: Literal['id', 'name', 'dbFieldName'] = 'name',
    since_version: Optional[int] = None,
    only_delta: bool = False,
    metadata_view_type: str = 'grid',
    filters: Optional[List[Dict[str, Any]]] = None,
    filter_logic: Optional[str] = None,
    groups: Optional[List[Dict[str, Any]]] = None,
    sorts: Optional[List[Dict[str, Any]]] = None,
    search: Optional[str] = None,
    search_field_ids: Optional[List[str]] = None,
    search_hide_not_match_rows: bool = False,
    serialized_view: Dict[str, Any],
    all_fields: Optional[List[TableField]] = None,
    rls_context=None,
) -> Dict[str, Any]:
    """
    native 查询不可用时的 ORM 兼容路径（保证功能可用）。
    """
    table_id = view.table_id
    if all_fields is None:
        all_fields = list(TableField.objects.using(TABDATA_DB_ALIAS).filter(table_id=table_id, is_deleted=False))
    id_map = {str(field.id): field for field in all_fields}
    name_map = {field.name: field for field in all_fields}
    base_qs = TableRecord.objects.using(TABDATA_DB_ALIAS).filter(table_id=table_id, is_deleted=False)

    # ── RLS 行级安全策略注入（ORM 路径）──
    if rls_context is not None:
        from .rls_service import apply_rls_to_orm_queryset
        base_qs = apply_rls_to_orm_queryset(base_qs, table_id, rls_context)

    effective_groups = groups if groups is not None else view.groups
    effective_sorts = sorts if sorts is not None else view.sorts
    merged_sorts = merge_group_and_user_sorts(effective_groups, effective_sorts)
    effective_filter = resolve_effective_filter(view, filters, filter_logic)

    def _filter_set_has_date_filter(filter_set: Optional[Dict[str, Any]]) -> bool:
        if not filter_set:
            return False
        items = filter_set.get('filterSet')
        if not isinstance(items, list):
            return False
        for item in items:
            if not isinstance(item, dict):
                continue
            if is_nested_filter(item):
                if _filter_set_has_date_filter(item):
                    return True
                continue
            if item.get('enabled') is False:
                continue
            field_ref = item.get('field_id') or item.get('field')
            if not field_ref:
                continue
            field_key = str(field_ref)
            field_meta = id_map.get(field_key) or name_map.get(field_key)
            if (
                field_meta
                and field_meta.field_type in _DATE_FILTER_FIELD_TYPES
                and normalize_filter_operator(item.get('operator')) in {
                    'equals', 'is_within', 'greater_than', 'greater_than_or_equals', 'less_than', 'less_than_or_equals',
                }
            ):
                return True
        return False

    filtered_qs = base_qs
    orm_filter_applied = False
    if not _filter_set_has_date_filter(effective_filter):
        try:
            filtered_qs = apply_view_filters(view, base_qs, filters, filter_logic)
            if filtered_qs.query.where != base_qs.query.where:
                orm_filter_applied = True
                base_qs = filtered_qs
        except Exception:
            pass

    total_count = base_qs.count()
    if total_count > _ORM_FALLBACK_MAX_RECORDS:
        _logger.warning(
            "ORM fallback: table %s has %d records (cap=%d), results will be truncated",
            table_id, total_count, _ORM_FALLBACK_MAX_RECORDS,
        )
    if merged_sorts:
        from .view_group_sort_service import apply_view_sorts
        sorted_qs = apply_view_sorts(view, base_qs, sorts_override=merged_sorts)
    else:
        # Preserve creation order for duplicate order values; never reverse it
        # on fallback.
        sorted_qs = base_qs.order_by('order', 'created_at', 'id')
    all_records = list(
        sorted_qs.only('id', 'data', 'order', 'created_at', 'version', 'updated_at', 'updated_by', 'table_id')
        [:_ORM_FALLBACK_MAX_RECORDS].iterator(chunk_size=2000)
    )

    def _extract_record_value(record: TableRecord, field_meta: Optional[TableField], field_ref: str) -> Any:
        data = read_data(record)
        if field_meta:
            field_id = str(field_meta.id)
            if field_id in data:
                return data.get(field_id)
            if field_meta.name in data:
                return data.get(field_meta.name)
            config = field_meta.config if isinstance(field_meta.config, dict) else {}
            db_field_name = str(config.get('db_field_name') or '').strip()
            if db_field_name and db_field_name in data:
                return data.get(db_field_name)
            return None
        return data.get(field_ref)

    def _as_list(value: Any) -> List[Any]:
        if value is None:
            return []
        if isinstance(value, list):
            return value
        return [value]

    def _evaluate_operator(
        value: Any,
        operator: str,
        expected: Any,
        field_meta: Optional[TableField],
    ) -> bool:
        normalized_op = normalize_filter_operator(operator)
        negative = normalized_op in _FILTER_NEGATIVE_OPERATOR_MAP
        base_op = _FILTER_NEGATIVE_OPERATOR_MAP.get(normalized_op, normalized_op)

        if (
            field_meta
            and field_meta.field_type in _DATE_FILTER_FIELD_TYPES
            and base_op in {'equals', 'is_within', 'greater_than', 'greater_than_or_equals', 'less_than', 'less_than_or_equals'}
        ):
            resolved = resolve_date_comparison_range(expected, field_meta)
            if resolved is None:
                return False
            _, start, end = resolved
            field_tz = _get_field_timezone(field_meta, expected)
            value_ms = _parse_date_like_timestamp_ms(value, field_tz)
            if value_ms is None:
                return False
            start_ms = int(start.astimezone(datetime_timezone.utc).timestamp() * 1000)
            end_ms = int(end.astimezone(datetime_timezone.utc).timestamp() * 1000)

            if base_op in {'equals', 'is_within'}:
                matched = start_ms <= value_ms <= end_ms
            elif base_op == 'greater_than':
                matched = value_ms > end_ms
            elif base_op == 'greater_than_or_equals':
                matched = value_ms >= start_ms
            elif base_op == 'less_than':
                matched = value_ms < start_ms
            else:
                matched = value_ms <= end_ms

            return (not matched) if negative else matched

        if base_op == 'equals':
            if is_boolean_field(field_meta):
                expected_state = parse_checkbox_state(expected) if expected is not None else None
                value_state = parse_checkbox_state(value)
                if expected_state is True:
                    matched = value_state is True
                elif expected_state is False or expected is None:
                    matched = value_state in (False, None)
                else:
                    matched = value_state == expected_state
            else:
                matched = value == expected
        elif base_op == 'contains':
            if isinstance(value, list):
                if isinstance(expected, list):
                    matched = all(item in value for item in expected)
                else:
                    matched = expected in value
            elif isinstance(value, str):
                matched = str(expected) in value if expected is not None else False
            else:
                matched = str(expected) in str(value) if expected is not None and value is not None else False
        elif base_op == 'in':
            candidates = _as_list(expected)
            matched = value in candidates
        elif base_op == 'has_any_of':
            value_list = _as_list(value)
            expected_list = _as_list(expected)
            matched = any(item in value_list for item in expected_list)
        elif base_op == 'has_all_of':
            value_list = _as_list(value)
            expected_list = _as_list(expected)
            matched = all(item in value_list for item in expected_list)
        elif base_op == 'is_exactly':
            if isinstance(value, list) or isinstance(expected, list):
                matched = _as_list(value) == _as_list(expected)
            else:
                matched = value == expected
        elif base_op == 'is_empty':
            matched = is_cell_value_empty(value)
        elif base_op == 'is_not_empty':
            matched = not is_cell_value_empty(value)
        elif base_op in {'greater_than', 'greater_than_or_equals', 'less_than', 'less_than_or_equals'}:
            left_num = parse_numeric_value(value)
            right_num = parse_numeric_value(expected)
            if left_num is None or right_num is None:
                matched = False
            elif base_op == 'greater_than':
                matched = left_num > right_num
            elif base_op == 'greater_than_or_equals':
                matched = left_num >= right_num
            elif base_op == 'less_than':
                matched = left_num < right_num
            else:
                matched = left_num <= right_num
        else:
            matched = True

        return (not matched) if negative else matched

    def _record_matches_filter_set(record: TableRecord, filter_set: Optional[Dict[str, Any]]) -> bool:
        if not filter_set:
            return True
        conjunction = str(filter_set.get('conjunction') or 'and').strip().lower()
        items = filter_set.get('filterSet')
        if not isinstance(items, list) or not items:
            return True

        results: List[bool] = []
        for item in items:
            if not isinstance(item, dict):
                continue
            if is_nested_filter(item):
                results.append(_record_matches_filter_set(record, item))
                continue

            if item.get('enabled') is False:
                continue
            field_ref = item.get('field_id') or item.get('field')
            operator = normalize_filter_operator(item.get('operator'))
            if not field_ref or not operator:
                continue

            field_key = str(field_ref)
            field_meta = id_map.get(field_key) or name_map.get(field_key)
            expected = normalize_filter_value(field_meta, item.get('value'))
            value = _extract_record_value(record, field_meta, field_key)
            results.append(_evaluate_operator(value, operator, expected, field_meta))

        if not results:
            return True
        if conjunction == 'or':
            return any(results)
        return all(results)

    if orm_filter_applied:
        filtered_records = all_records
    else:
        filtered_records = [record for record in all_records if _record_matches_filter_set(record, effective_filter)]

    normalized_search = (search or '').strip()
    search_hide_mode = bool(search_hide_not_match_rows and normalized_search)
    if search_hide_mode:
        from apps.tabdata.utils.searchable_cell_text import (
            USER_SEARCH_FIELD_TYPES,
            cell_text_matches_search_query,
            resolve_organization_user_ids_by_display_name,
            user_cell_references_any_id,
        )

        candidates: List[TableField] = []
        if search_field_ids:
            for ref in search_field_ids:
                field = id_map.get(str(ref)) or name_map.get(str(ref))
                if field:
                    candidates.append(field)
        if not candidates:
            candidates = sorted(
                all_fields,
                key=lambda field: (
                    0 if field.is_primary else 1,
                    field.order if field.order is not None else 10**6,
                    str(field.id),
                ),
            )

        matching_user_ids = (
            resolve_organization_user_ids_by_display_name(
                view.table.organization_id,
                normalized_search,
            )
            if any(field.field_type in USER_SEARCH_FIELD_TYPES for field in candidates)
            else []
        )
        hit_records: List[TableRecord] = []
        for record in filtered_records:
            matched = False
            for field in candidates:
                value = _extract_record_value(record, field, str(field.id))
                if (
                    cell_text_matches_search_query(normalized_search, value)
                    or (
                        field.field_type in USER_SEARCH_FIELD_TYPES
                        and user_cell_references_any_id(value, matching_user_ids)
                    )
                ):
                    matched = True
                    break
            if matched:
                hit_records.append(record)
        filtered_records = hit_records

    total = len(filtered_records)
    groups_metadata = None
    if effective_groups and filtered_records:
        groups_metadata = build_group_metadata(
            view,
            TableRecord.objects.using(TABDATA_DB_ALIAS).filter(id__in=[record.id for record in filtered_records]),
            effective_groups,
        )

    version_state = get_latest_version_state(base_qs, table_id=view.table_id)
    latest_version = int(version_state['latest_version'])
    has_changes = has_changes_since_version(
        since_version=since_version,
        version_state=version_state,
    )
    requires_full_reload = bool(
        only_delta
        and since_version is not None
        and requires_full_reload_since_version(
            since_version=since_version,
            version_state=version_state,
        )
    )
    if requires_full_reload:
        has_changes = True

    matched_records: List[TableRecord] = []
    if has_changes and not requires_full_reload:
        matched_records = list(filtered_records)
        if only_delta and since_version is not None:
            try:
                since_value = int(since_version)
            except (TypeError, ValueError):
                since_value = None

            if since_value is not None:
                if is_monotonic_version_token(since_value):
                    threshold = decode_monotonic_version_token(since_value)
                    matched_records = [
                        record for record in matched_records
                        if int(record.version or 0) > threshold
                    ]
                else:
                    try:
                        since_datetime = datetime.fromtimestamp(
                            since_value / 1000,
                            tz=timezone.get_current_timezone(),
                        )
                    except (OSError, OverflowError, ValueError):
                        matched_records = []
                    else:
                        matched_records = [
                            record for record in matched_records
                            if record.updated_at and record.updated_at > since_datetime
                        ]

    delta_requested = bool(only_delta and since_version is not None)
    delta_total = len(matched_records) if has_changes else 0
    matched_total = total
    records_serialized: List[Dict[str, Any]] = []
    if has_changes and delta_total > 0:
        offset = max(0, (page - 1) * page_size)
        page_records = matched_records[offset:offset + page_size]
        records_serialized = serialize_records(
            page_records,
            fields=fields,
            field_key_type=field_key_type,
        )

    metadata: Dict[str, Any] = {
        'view_type': metadata_view_type,
        'delta': delta_requested,
    }
    if normalized_search:
        metadata['search'] = {
            'query': normalized_search,
            'hide_not_match_rows': bool(search_hide_not_match_rows),
            'matched_count': len(records_serialized),
            'hit_record_ids': [record.get('id') for record in records_serialized if record.get('id')],
        }
    if groups_metadata:
        metadata['groups'] = groups_metadata

    # ── 子记录树序排列（与 native 路径对齐） ──
    view_config = view.config or {}
    sub_record_parent_field_id = view_config.get('subRecordParentFieldId')
    if sub_record_parent_field_id and records_serialized:
        try:
            space_id = getattr(view, 'space_id', None) or getattr(view.table, 'space_id', None)
            context_ancestor_ids: Set[str] = set()
            sub_record_tree_data = apply_sub_record_tree_order(
                records_serialized,
                sub_record_parent_field_id,
                table_id,
                has_filter=(effective_filter is not None or search_hide_mode),
                space_id=space_id,
                all_fields=all_fields,
                field_key_type=field_key_type,
                requested_fields=fields,
                context_ancestor_ids=context_ancestor_ids,
                rls_context=rls_context,
            )
            if sub_record_tree_data is not None:
                metadata['sub_records'] = {
                    'parent_field_id': sub_record_parent_field_id,
                    'tree_data': sub_record_tree_data,
                }
                if context_ancestor_ids:
                    metadata['sub_records']['context_ancestor_ids'] = sorted(context_ancestor_ids)
        except Exception as exc:
            _logger.warning("ORM fallback: sub-record tree order failed: %s", exc)

    response = {
        'view': serialized_view,
        'records': records_serialized,
        'total': total,
        'matched_total': matched_total,
        'page': page,
        'page_size': page_size,
        'metadata': metadata,
        'latest_version': latest_version,
        'has_changes': has_changes,
        'requires_full_reload': requires_full_reload,
    }
    if delta_requested:
        response['delta_total'] = delta_total
    return response


# ══════════════════════════════════════════════════════════════
# 原生列查询路径 (Phase 2B)
# ══════════════════════════════════════════════════════════════

def get_grid_data_native(
    view: TableView,
    page: int,
    page_size: int,
    fields: Optional[Set[str]] = None,
    *,
    field_key_type: Literal['id', 'name', 'dbFieldName'] = 'name',
    since_version: Optional[int] = None,
    only_delta: bool = False,
    metadata_view_type: str = 'grid',
    filters: Optional[List[Dict[str, Any]]] = None,
    filter_logic: Optional[str] = None,
    groups: Optional[List[Dict[str, Any]]] = None,
    sorts: Optional[List[Dict[str, Any]]] = None,
    search: Optional[str] = None,
    search_field_ids: Optional[List[str]] = None,
    search_hide_not_match_rows: bool = False,
    serialized_view: Dict[str, Any],
    all_fields: Optional[List[TableField]] = None,
    rls_context=None,
) -> Optional[Dict[str, Any]]:
    """
    原生列查询路径的表格视图数据。

    使用 NativeQueryBuilder + NativeRecordIO 替代 JSONField 查询。
    返回格式与 get_grid_data() 完全一致。

    Returns:
        视图数据字典（Phase 3D: 唯一数据路径，错误直接抛出）。
    """
    if connections[TABDATA_DB_ALIAS].vendor != 'postgresql':
        return get_grid_data_orm_compat(
            view,
            page,
            page_size,
            fields,
            field_key_type=field_key_type,
            since_version=since_version,
            only_delta=only_delta,
            metadata_view_type=metadata_view_type,
            filters=filters,
            filter_logic=filter_logic,
            groups=groups,
            sorts=sorts,
            search=search,
            search_field_ids=search_field_ids,
            search_hide_not_match_rows=search_hide_not_match_rows,
            serialized_view=serialized_view,
            rls_context=rls_context,
        )

    from apps.tabdata.native.query_builder import NativeQueryBuilder
    from apps.tabdata.native.record_io import NativeRecordIO
    from apps.tabdata.native.ddl_manager import resolve_schema_partition_id

    table = view.table
    table_id = table.id
    space_id = resolve_schema_partition_id(table)
    delta_requested = bool(only_delta and since_version is not None)

    if all_fields is None:
        all_fields = list(TableField.objects.using(TABDATA_DB_ALIAS).filter(
            table_id=table_id,
            is_deleted=False,
        ))
    if not all_fields:
        response = {
            'view': serialized_view,
            'records': [],
            'total': 0,
            'matched_total': 0,
            'page': page,
            'page_size': page_size,
            'metadata': {'view_type': metadata_view_type, 'delta': delta_requested},
            'latest_version': 0,
            'has_changes': False,
        }
        if delta_requested:
            response['delta_total'] = 0
        return response

    qb = NativeQueryBuilder(space_id, table_id, all_fields)
    native_io = NativeRecordIO(space_id, table_id)

    # ── 构建筛选条件 ──
    effective_filter = resolve_effective_filter(view, filters, filter_logic)
    where = qb.build_where_clause(effective_filter)
    normalized_search = (search or '').strip()
    search_hide_mode = bool(search_hide_not_match_rows and normalized_search)
    if search_hide_mode:
        search_where = build_native_search_where(
            qb=qb,
            all_fields=all_fields,
            search_value=normalized_search,
            search_field_ids=search_field_ids,
            organization_id=table.organization_id,
        )
        where = merge_native_where_clauses(where, search_where)

    # ── RLS 行级安全策略注入 ──
    if rls_context is not None:
        from .rls_service import build_rls_select_where
        where = build_rls_select_where(table, rls_context, qb, where)

    # ── 构建排序 ──
    view_config = view.config or {}
    sub_record_parent_field_id = view_config.get('subRecordParentFieldId')
    effective_groups = groups if groups is not None else view.groups
    if sub_record_parent_field_id and effective_groups:
        from apps.tabdata.services.sub_record_service import SubRecordService

        SubRecordService.validate_grouping_policy(
            table_id=table_id,
            groups=effective_groups,
            sub_record_parent_field_id=sub_record_parent_field_id,
        )
    effective_sorts = sorts if sorts is not None else view.sorts
    merged_sorts = merge_group_and_user_sorts(effective_groups, effective_sorts)

    order_by = qb.build_order_clause(merged_sorts)

    # ── 查询总数 + 版本状态（单次 SQL）──
    total, max_version, max_updated_ms = native_io.count_and_version_state(filter_where=where)
    table_state = get_table_record_version_state(
        table_id=view.table_id,
        db_alias=TABDATA_DB_ALIAS,
    )
    max_version = max(max_version, table_state['latest_record_version'])
    if max_version > 0:
        latest_version = encode_monotonic_version_token(max_version)
    else:
        latest_version = max_updated_ms
    version_state = {
        'latest_version': int(latest_version),
        'latest_updated_ms': int(max_updated_ms),
        'latest_record_version': int(max_version),
        'latest_delete_version': table_state['latest_delete_version'],
    }

    has_changes = True
    if since_version is not None:
        has_changes = has_changes_since_version(
            since_version=since_version,
            version_state=version_state,
        )
    requires_full_reload = bool(
        only_delta
        and since_version is not None
        and requires_full_reload_since_version(
            since_version=since_version,
            version_state=version_state,
        )
    )
    if requires_full_reload:
        has_changes = True

    # ── 增量模式 ──
    working_where = where
    if since_version is not None and has_changes and only_delta and not requires_full_reload:
        delta_where: Optional[Tuple[str, list]] = None
        try:
            since_value = int(since_version)
        except (TypeError, ValueError):
            since_value = None

        if since_value is not None:
            if is_monotonic_version_token(since_value):
                delta_where = (
                    '"__version" > %s',
                    [decode_monotonic_version_token(since_value)],
                )
            else:
                try:
                    since_datetime = datetime.fromtimestamp(
                        since_value / 1000,
                        tz=timezone.get_current_timezone()
                    )
                    delta_where = ('"__updated_at" > %s', [since_datetime])
                except (OSError, OverflowError, ValueError):
                    delta_where = ('FALSE', [])

        if delta_where:
            working_where = merge_native_where_clauses(where, delta_where)

    delta_total = (
        native_io.count_records(where=working_where)
        if has_changes and not requires_full_reload
        else 0
    )
    matched_total = total

    # ── 查询数据 ──
    records_serialized: List[Dict[str, Any]] = []
    if has_changes and not requires_full_reload:
        offset = (page - 1) * page_size
        rows, _ = native_io.read_records(
            qb,
            where=working_where,
            order_by=order_by,
            limit=page_size,
            offset=offset,
            include_count=False,
        )
        records_serialized = serialize_native_rows(
            rows,
            table_id,
            all_fields,
            field_key_type=field_key_type,
        )
        if fields is not None:
            records_serialized = filter_native_record_fields(
                records_serialized, fields,
                all_fields=all_fields, field_key_type=field_key_type,
            )

    # ── 子记录树序排列 ──
    search_hit_record_ids: Optional[List[str]] = None
    if search_hide_mode and sub_record_parent_field_id and records_serialized:
        search_hit_record_ids = [
            rec.get('id') or rec.get('row_id')
            for rec in records_serialized
            if rec.get('id') or rec.get('row_id')
        ]

    sub_record_tree_data = None
    context_ancestor_ids: Set[str] = set()
    if sub_record_parent_field_id and records_serialized:
        sub_record_tree_data = apply_sub_record_tree_order(
            records_serialized, sub_record_parent_field_id, table_id,
            has_filter=(effective_filter is not None or search_hide_mode),
            space_id=space_id,
            all_fields=all_fields,
            field_key_type=field_key_type,
            requested_fields=fields,
            context_ancestor_ids=context_ancestor_ids,
            rls_context=rls_context,
        )

    # ── 分组元数据 ──
    groups_metadata = None
    if effective_groups:
        groups_metadata = build_group_metadata_native(
            qb, native_io, all_fields, effective_groups, where, table_id,
        )

    metadata: Dict[str, Any] = {
        'view_type': metadata_view_type,
        'delta': delta_requested,
    }
    if normalized_search:
        search_meta: Dict[str, Any] = {
            'query': normalized_search,
            'hide_not_match_rows': bool(search_hide_not_match_rows),
        }
        if search_hit_record_ids is not None:
            search_meta['matched_count'] = len(search_hit_record_ids)
            search_meta['hit_record_ids'] = search_hit_record_ids
        metadata['search'] = search_meta
    if groups_metadata:
        metadata['groups'] = groups_metadata
    if sub_record_tree_data is not None:
        metadata['sub_records'] = {
            'parent_field_id': sub_record_parent_field_id,
            'tree_data': sub_record_tree_data,
        }
        if context_ancestor_ids:
            metadata['sub_records']['context_ancestor_ids'] = sorted(context_ancestor_ids)

    response = {
        'view': serialized_view,
        'records': records_serialized,
        'total': total,
        'matched_total': matched_total,
        'page': page,
        'page_size': page_size,
        'metadata': metadata,
        'latest_version': int(latest_version),
        'has_changes': has_changes,
        'requires_full_reload': requires_full_reload,
    }
    if delta_requested:
        response['delta_total'] = delta_total
    return response


# ══════════════════════════════════════════════════════════════
# 辅助函数
# ══════════════════════════════════════════════════════════════

from apps.tabdata.native.query_builder import merge_where as merge_native_where_clauses


def escape_like_for_sql(value: str) -> str:
    """转义 SQL LIKE 通配符。"""
    return value.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_')


def build_native_search_where(
    qb,
    all_fields: List[TableField],
    search_value: str,
    search_field_ids: Optional[List[str]] = None,
    organization_id: Optional[UUID] = None,
) -> Optional[Tuple[str, list]]:
    """
    构建原生列表的搜索 where 子句。

    仅用于视图 records API 的 search_hide_not_match_rows 场景。
    匹配展示文本，避免结构化列 UUID id 被数字查询误命中。
    """
    from apps.tabdata.utils.searchable_cell_text import (
        USER_SEARCH_FIELD_TYPES,
        build_searchable_column_sql_expr,
        build_user_reference_match_sql,
        resolve_organization_user_ids_by_display_name,
    )

    normalized = (search_value or '').strip()
    if not normalized:
        return None

    field_refs: List[str]
    if search_field_ids:
        field_refs = [str(field_id).strip() for field_id in search_field_ids if str(field_id).strip()]
    else:
        field_refs = [str(field.id) for field in all_fields]

    conditions: List[str] = []
    params: List[Any] = []
    seen_columns: Set[str] = set()
    escaped = escape_like_for_sql(normalized.lower())
    like_pattern = f'%{escaped}%'
    matching_user_ids = (
        resolve_organization_user_ids_by_display_name(organization_id, normalized)
        if organization_id
        else []
    )

    for field_ref in field_refs:
        col_ref = qb._resolve_column_ref(field_ref)
        if not col_ref or col_ref in seen_columns:
            continue
        seen_columns.add(col_ref)
        field = qb._get_field_for_ref(field_ref)
        text_expr = build_searchable_column_sql_expr(col_ref)
        field_conditions = [f"{text_expr} LIKE %s ESCAPE '\\'"]
        field_params: List[Any] = [like_pattern]
        if (
            field
            and field.field_type in USER_SEARCH_FIELD_TYPES
            and matching_user_ids
        ):
            user_condition, user_params = build_user_reference_match_sql(
                f"to_jsonb({col_ref})",
                matching_user_ids,
            )
            field_conditions.append(user_condition)
            field_params.extend(user_params)
        conditions.append(f"({' OR '.join(field_conditions)})")
        params.extend(field_params)

    if not conditions:
        return ('FALSE', [])

    return (f"({' OR '.join(conditions)})", params)


# ``filter_native_record_fields`` 已抽到 utils/record_serializers（中性工具层，
# 无 service 依赖），供视图 service、单条 record API、record_service 共用，避免
#  同源「按 id 过滤清空 name-keyed data」在多个入口各自复发。上方 import 已把
# 同名符号引入本模块命名空间，兼容既有 ``from .view_grid_service import
# filter_native_record_fields``（kanban/gallery/calendar/data_service 均如此引用）。
