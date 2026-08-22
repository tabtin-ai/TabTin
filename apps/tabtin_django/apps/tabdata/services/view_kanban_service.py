"""
看板视图数据服务

从 view_data_service.py 提取的看板视图相关数据查询方法。
"""
from typing import Dict, Any, Optional, List, Set, Tuple, Literal

from django.db import connections, DatabaseError, transaction

from apps.tabdata.constants import TABDATA_DB_ALIAS
from apps.tabdata.models import TableView, TableRecord, TableField
from apps.tabdata.utils.record_serializers import serialize_records, serialize_native_rows
from .view_grid_service import filter_native_record_fields
from apps.tabdata.utils.record_data_access import read_data
from .view_filter_service import apply_view_filters, resolve_effective_filter
from .view_grid_service import build_native_search_where, merge_native_where_clauses
from .view_version_sync import (
    get_latest_version_state,
    has_changes_since_version,
    requires_full_reload_since_version,
)

import logging

_logger = logging.getLogger('tabdata.view_kanban_service')

_ORM_FALLBACK_MAX_RECORDS = 50_000


_DEFAULT_PER_GROUP_LIMIT = 50


def _is_empty_group_value(value: Any) -> bool:
    if value is None:
        return True
    if isinstance(value, str):
        return value.strip() == ''
    if isinstance(value, (list, tuple, set)):
        return len(value) == 0
    return False


def _resolve_select_option(option: Any) -> Optional[Tuple[Any, Any, Optional[str]]]:
    if isinstance(option, dict):
        option_value = None
        for key in ('value', 'id', 'name'):
            if key not in option:
                continue
            candidate = option.get(key)
            if _is_empty_group_value(candidate):
                return None
            option_value = candidate
            break
        if _is_empty_group_value(option_value):
            return None
        option_label = option_value
        option_color = option.get('color') if isinstance(option.get('color'), str) else None
        return option_value, option_label, option_color

    if _is_empty_group_value(option):
        return None
    return option, option, None


def get_kanban_data(
    view: TableView,
    page: int,
    page_size: int,
    fields: Optional[Set[str]] = None,
    *,
    field_key_type: Literal['id', 'name', 'dbFieldName'] = 'name',
    since_version: Optional[int] = None,
    filters: Optional[List[Dict[str, Any]]] = None,
    filter_logic: Optional[str] = None,
    groups: Optional[List[Dict[str, Any]]] = None,
    sorts: Optional[List[Dict[str, Any]]] = None,
    serialized_view: Dict[str, Any],
    per_group_limit: Optional[int] = None,
    group_offsets: Optional[Dict[str, int]] = None,
    search: Optional[str] = None,
    search_field_ids: Optional[List[str]] = None,
    search_hide_not_match_rows: bool = False,
    all_fields: Optional[List[TableField]] = None,
    rls_context=None,
) -> Dict[str, Any]:
    """获取看板视图数据

    Args:
        per_group_limit: 每个分组返回的最大记录数（默认 50），替代全局 page/page_size。
        group_offsets: 按分组值指定偏移量，用于「加载更多」场景。
                       key 为 group_value 的字符串表示（未分组为 ``"__ungrouped__"``），
                       value 为偏移量。未指定的分组从 0 开始。
    """
    config = view.config
    group_by_field_id = config.get('group_by_field')

    if groups:
        group_rule = groups[0] if isinstance(groups, list) and groups else None
        if isinstance(group_rule, dict):
            group_by_field_id = group_rule.get('field_id') or group_rule.get('field') or group_by_field_id

    if not group_by_field_id:
        return {
            'view': {
                'id': str(view.id),
                'name': view.name,
                'view_type': view.view_type,
                'config': config,
            },
            'records': [],
            'columns': [],
            'total': 0,
            'page': page,
            'page_size': page_size,
            'latest_version': 0,
            'has_changes': True,
            'metadata': {
                'needs_configuration': True,
                'missing_fields': ['group_by_field'],
            },
        }

    try:
        group_field = TableField.objects.using(TABDATA_DB_ALIAS).get(id=group_by_field_id)
    except (ValueError, TableField.DoesNotExist):
        group_field = TableField.objects.using(TABDATA_DB_ALIAS).get(
            table=view.table,
            name=str(group_by_field_id),
            is_deleted=False
        )
    group_field_id_str = str(group_field.id)
    group_field_keys = [group_field_id_str]
    if group_field.name and group_field.name != group_field_id_str:
        group_field_keys.append(group_field.name)
    options = group_field.config.get('options') or group_field.config.get('choices') or []

    queryset = TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
        table=view.table,
        is_deleted=False
    )
    queryset = apply_view_filters(view, queryset, filters, filter_logic)

    # ── RLS 行级安全策略注入（ORM 基础 queryset）──
    if rls_context is not None:
        from .rls_service import apply_rls_to_orm_queryset
        queryset = apply_rls_to_orm_queryset(queryset, view.table_id, rls_context)

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

    kanban_groups: List[Dict[str, Any]] = []
    total_count = 0
    is_select_field = group_field.field_type == 'select'

    resolved_limit = per_group_limit if per_group_limit and per_group_limit > 0 else _DEFAULT_PER_GROUP_LIMIT
    resolved_offsets = group_offsets or {}

    _kanban_data_source = 'native'

    try:
        with transaction.atomic(using=TABDATA_DB_ALIAS):
            kanban_groups, total_count = get_kanban_groups_native(
                view, queryset, group_field, group_field_keys, options,
                is_select_field,
                fields=fields, field_key_type=field_key_type,
                filters=filters, filter_logic=filter_logic, sorts=sorts,
                per_group_limit=resolved_limit,
                group_offsets=resolved_offsets,
                search=search,
                search_field_ids=search_field_ids,
                search_hide_not_match_rows=search_hide_not_match_rows,
                all_fields=all_fields,
                rls_context=rls_context,
            )
    except (DatabaseError, KeyError, TypeError, ValueError) as exc:
        _logger.warning("Kanban native query failed, falling back to ORM: %s", exc)
        _kanban_data_source = 'orm_fallback'
        kanban_groups, total_count = get_kanban_groups_orm(
            queryset, group_field, group_field_keys, options,
            is_select_field,
            fields=fields, field_key_type=field_key_type, sorts=sorts, view=view,
            per_group_limit=resolved_limit,
            group_offsets=resolved_offsets,
        )

    kanban_meta: Dict[str, Any] = {
        'view_type': 'kanban',
        'group_by_field': str(group_by_field_id),
        'groups': kanban_groups,
    }
    if _kanban_data_source != 'native':
        kanban_meta['data_source'] = _kanban_data_source

    return {
        'view': serialized_view,
        'total': total_count,
        'matched_total': total_count,
        'page': page,
        'page_size': page_size,
        'metadata': kanban_meta,
        'latest_version': int(latest_version),
        'has_changes': has_changes,
        'requires_full_reload': requires_full_reload,
    }


def get_kanban_groups_native(
    view, queryset, group_field, group_field_keys, options,
    is_select_field,
    *,
    fields=None, field_key_type='name',
    filters=None, filter_logic=None,
    sorts: Optional[List[Dict[str, Any]]] = None,
    per_group_limit: int = _DEFAULT_PER_GROUP_LIMIT,
    group_offsets: Optional[Dict[str, int]] = None,
    search: Optional[str] = None,
    search_field_ids: Optional[List[str]] = None,
    search_hide_not_match_rows: bool = False,
    all_fields: Optional[List[TableField]] = None,
    rls_context=None,
) -> Tuple[List[Dict[str, Any]], int]:
    from apps.tabdata.native.query_builder import NativeQueryBuilder
    from apps.tabdata.native.record_io import NativeRecordIO
    from apps.tabdata.native.pg_type_map import is_system_field
    from apps.tabdata.native.ddl_manager import resolve_schema_partition_id

    table = view.table
    space_id = resolve_schema_partition_id(table)
    if all_fields is None:
        all_fields = list(TableField.objects.using(TABDATA_DB_ALIAS).filter(table_id=table.id, is_deleted=False))
    user_fields = [f for f in all_fields if not is_system_field(f.field_type)]
    qb = NativeQueryBuilder(space_id, table.id, all_fields)
    native_io = NativeRecordIO(space_id, table.id)

    effective_filter = resolve_effective_filter(view, filters, filter_logic)
    base_where = qb.build_where_clause(effective_filter)

    normalized_search = (search or '').strip()
    if search_hide_not_match_rows and normalized_search:
        search_where = build_native_search_where(
            qb=qb, all_fields=all_fields,
            search_value=normalized_search,
            search_field_ids=search_field_ids,
        )
        base_where = merge_native_where_clauses(base_where, search_where)

    # ── RLS 行级安全策略注入 ──
    if rls_context is not None:
        from .rls_service import build_rls_select_where
        base_where = build_rls_select_where(table, rls_context, qb, base_where)

    group_col_ref = qb._resolve_column_ref(str(group_field.id))
    effective_sorts = sorts if sorts is not None else (view.sorts if view.sorts else None)
    order_by = qb.build_order_clause(effective_sorts) if effective_sorts else ('"__order" ASC, "__created_at" DESC', [])

    offsets = group_offsets or {}

    if is_select_field:
        group_values = []
        seen_option_values = set()
        for option in options:
            resolved_option = _resolve_select_option(option)
            if resolved_option is None:
                continue
            option_value, option_label, option_color = resolved_option
            option_value_key = str(option_value)
            if option_value_key in seen_option_values:
                continue
            seen_option_values.add(option_value_key)
            group_values.append((option_value, option_label, option_color))
    else:
        with connections[TABDATA_DB_ALIAS].cursor() as cursor:
            base_sql, base_params = base_where
            cursor.execute(
                f"SELECT DISTINCT {group_col_ref} FROM {qb.qualified_name} "
                f"WHERE ({base_sql}) "
                f"AND {group_col_ref} IS NOT NULL AND {group_col_ref}::text != '' "
                f"ORDER BY {group_col_ref}",
                base_params,
            )
            distinct_values = [row[0] for row in cursor.fetchall()]
        group_values = [(v, str(v), None) for v in distinct_values]

    # Single GROUP BY query to get all group counts at once (eliminates N+1)
    base_sql, base_params = base_where
    with connections[TABDATA_DB_ALIAS].cursor() as cursor:
        count_sql = (
            f"SELECT COALESCE({group_col_ref}::text, ''), COUNT(*) "
            f"FROM {qb.qualified_name} "
            f"WHERE ({base_sql}) "
            f"GROUP BY COALESCE({group_col_ref}::text, '')"
        )
        cursor.execute(count_sql, base_params)
        group_counts_map = dict(cursor.fetchall())

    ungrouped_count = group_counts_map.pop('', 0)

    groups: List[Dict[str, Any]] = []
    total_count = 0

    # ── 批量读取：单次窗口查询替代 N 次分组查询 ──
    all_offsets_zero = all(offsets.get(str(gv), 0) == 0 for gv, _, _ in group_values) and offsets.get('__ungrouped__', 0) == 0
    max_per_group = per_group_limit  # ROW_NUMBER 截止值

    if all_offsets_zero and (len(group_values) + (1 if ungrouped_count > 0 else 0)) > 1:
        order_sql, order_params = order_by
        ranked_sql = (
            f'WITH ranked AS ('
            f'  SELECT *, ROW_NUMBER() OVER ('
            f'    PARTITION BY COALESCE({group_col_ref}::text, \'\')'
            f'    ORDER BY {order_sql}'
            f'  ) AS __rn'
            f'  FROM {qb.qualified_name}'
            f'  WHERE ({base_sql})'
            f') SELECT * FROM ranked WHERE __rn <= %s'
        )
        ranked_params = order_params + base_params + [max_per_group]
        with connections[TABDATA_DB_ALIAS].cursor() as cursor:
            cursor.execute(ranked_sql, ranked_params)
            col_names = [desc[0] for desc in cursor.description]
            raw_rows = cursor.fetchall()
        all_rows = [dict(zip(col_names, row)) for row in raw_rows]

        rows_by_group: Dict[str, List[Dict]] = {}
        for row in all_rows:
            row.pop('__rn', None)
            raw_gv = row.get(group_col_ref.strip('"'))
            gv_key = '' if raw_gv is None else str(raw_gv).strip()
            if gv_key == '':
                gv_key = '__ungrouped__'
            rows_by_group.setdefault(gv_key, []).append(row)
    else:
        rows_by_group = None

    def _fetch_group_rows(grp_where, grp_offset):
        """Fallback: 逐分组查询"""
        rows, _ = native_io.read_records(
            qb, where=grp_where, order_by=order_by,
            limit=per_group_limit, offset=grp_offset,
            include_count=False,
        )
        return rows

    known_group_value_strs: set = set()
    for group_value, group_label, group_color in group_values:
        known_group_value_strs.add(str(group_value))
        group_count = group_counts_map.get(str(group_value), 0)
        total_count += group_count

        grp_offset = offsets.get(str(group_value), 0)

        if rows_by_group is not None:
            rows = rows_by_group.get(str(group_value), [])
        else:
            grp_where_sql = f'({base_sql}) AND {group_col_ref} = %s'
            grp_where = (grp_where_sql, base_params + [group_value])
            rows = _fetch_group_rows(grp_where, grp_offset)

        serialized = serialize_native_rows(
            rows, table.id, user_fields,
            field_key_type=field_key_type,
        )
        if fields is not None:
            serialized = filter_native_record_fields(
                serialized, fields,
                all_fields=all_fields, field_key_type=field_key_type,
            )

        groups.append({
            'group_value': group_value,
            'group_label': group_label,
            'count': group_count,
            'records': serialized,
            'offset': grp_offset,
            'per_group_limit': per_group_limit,
            'has_more': (grp_offset + per_group_limit) < group_count,
            'color': group_color,
        })

    if is_select_field:
        for gv_str, gv_count in group_counts_map.items():
            if gv_str not in known_group_value_strs and gv_count > 0:
                total_count += gv_count
                grp_offset = offsets.get(gv_str, 0)

                if rows_by_group is not None:
                    rows = rows_by_group.get(gv_str, [])
                else:
                    grp_where_sql = f'({base_sql}) AND {group_col_ref} = %s'
                    grp_where = (grp_where_sql, base_params + [gv_str])
                    rows = _fetch_group_rows(grp_where, grp_offset)

                serialized = serialize_native_rows(
                    rows, table.id, user_fields,
                    field_key_type=field_key_type,
                )
                if fields is not None:
                    serialized = filter_native_record_fields(
                        serialized, fields,
                        all_fields=all_fields, field_key_type=field_key_type,
                    )
                groups.append({
                    'group_value': gv_str,
                    'group_label': gv_str,
                    'count': gv_count,
                    'records': serialized,
                    'offset': grp_offset,
                    'per_group_limit': per_group_limit,
                    'has_more': (grp_offset + per_group_limit) < gv_count,
                    'color': None,
                })

    if ungrouped_count > 0:
        total_count += ungrouped_count
        ug_offset = offsets.get('__ungrouped__', 0)

        if rows_by_group is not None:
            rows = rows_by_group.get('__ungrouped__', [])
        else:
            ungrouped_sql = (
                f'({base_sql}) AND ({group_col_ref} IS NULL OR {group_col_ref}::text = \'\')'
            )
            ungrouped_where = (ungrouped_sql, base_params)
            rows = _fetch_group_rows(ungrouped_where, ug_offset)

        serialized = serialize_native_rows(
            rows, table.id, user_fields,
            field_key_type=field_key_type,
        )
        if fields is not None:
            serialized = filter_native_record_fields(
                serialized, fields,
                all_fields=all_fields, field_key_type=field_key_type,
            )
        groups.append({
            'group_value': None,
            'group_label': '未分组',
            'count': ungrouped_count,
            'records': serialized,
            'offset': ug_offset,
            'per_group_limit': per_group_limit,
            'has_more': (ug_offset + per_group_limit) < ungrouped_count,
            'color': None,
        })

    return groups, total_count


def get_kanban_groups_orm(
    queryset, group_field, group_field_keys, options,
    is_select_field,
    *,
    fields=None, field_key_type='name',
    sorts: Optional[List[Dict[str, Any]]] = None,
    view: Optional[TableView] = None,
    per_group_limit: int = _DEFAULT_PER_GROUP_LIMIT,
    group_offsets: Optional[Dict[str, int]] = None,
) -> Tuple[List[Dict[str, Any]], int]:
    """ORM fallback: 用 Python 分组，当原生表查询失败时使用。"""
    effective_sorts = sorts if sorts is not None else (view.sorts if view and view.sorts else None)
    if effective_sorts and view:
        from .view_group_sort_service import apply_view_sorts
        queryset = apply_view_sorts(view, queryset, sorts_override=effective_sorts)
    else:
        queryset = queryset.order_by('order', '-created_at')
    all_records = list(queryset[:_ORM_FALLBACK_MAX_RECORDS])
    buckets: Dict[str, List] = {}
    ungrouped: List = []

    for record in all_records:
        data = read_data(record)
        val = None
        for key in group_field_keys:
            val = data.get(key)
            if val is not None:
                break
        if val is None or str(val).strip() == '':
            ungrouped.append(record)
        else:
            buckets.setdefault(str(val), []).append(record)

    offsets = group_offsets or {}

    if is_select_field:
        ordered_keys = []
        option_meta: Dict[str, Tuple[str, Optional[str]]] = {}
        for option in options:
            resolved_option = _resolve_select_option(option)
            if resolved_option is None:
                continue
            ov, ol, oc = resolved_option
            option_key = str(ov)
            if option_key in option_meta:
                continue
            ordered_keys.append(option_key)
            option_meta[option_key] = (ol, oc)
        for bk in sorted(buckets.keys()):
            if bk not in option_meta:
                ordered_keys.append(bk)
                option_meta[bk] = (bk, None)
    else:
        ordered_keys = sorted(buckets.keys())
        option_meta = {k: (k, None) for k in ordered_keys}

    groups: List[Dict[str, Any]] = []
    total_count = 0

    for key in ordered_keys:
        recs = buckets.get(key, [])
        label, color = option_meta.get(key, (key, None))
        group_count = len(recs)
        total_count += group_count
        grp_offset = offsets.get(key, 0)
        page_recs = recs[grp_offset:grp_offset + per_group_limit]

        groups.append({
            'group_value': key,
            'group_label': label,
            'count': group_count,
            'records': serialize_records(
                page_recs, fields=fields,
                field_key_type=field_key_type,
            ),
            'offset': grp_offset,
            'per_group_limit': per_group_limit,
            'has_more': (grp_offset + per_group_limit) < group_count,
            'color': color,
        })

    if ungrouped:
        total_count += len(ungrouped)
        ug_offset = offsets.get('__ungrouped__', 0)
        ug_page = ungrouped[ug_offset:ug_offset + per_group_limit]
        groups.append({
            'group_value': None,
            'group_label': '未分组',
            'count': len(ungrouped),
            'records': serialize_records(
                ug_page, fields=fields,
                field_key_type=field_key_type,
            ),
            'offset': ug_offset,
            'per_group_limit': per_group_limit,
            'has_more': (ug_offset + per_group_limit) < len(ungrouped),
            'color': None,
        })

    return groups, total_count
