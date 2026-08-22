"""
视图列统计服务

从 view_data_service.py 提取的列统计相关逻辑，
提供模块级函数供 ViewDataService 和其他模块调用。
"""
from typing import Dict, Any, Optional, List, Set, Tuple
from datetime import datetime, date
import math
import logging

from django.db.models import QuerySet

from apps.tabdata.constants import FILE_BASED_FIELD_TYPES, TABDATA_DB_ALIAS
from apps.tabdata.models import TableField
from apps.tabdata.utils.record_data_access import read_data
from .view_version_sync import get_latest_version
from .view_filter_service import (
    apply_view_filters,
    parse_checkbox_state,
    resolve_effective_filter,
)

from .view_constants import (
    STAT_FUNC_NONE,
    STAT_FUNC_COUNT,
    STAT_FUNC_EMPTY,
    STAT_FUNC_FILLED,
    STAT_FUNC_UNIQUE,
    STAT_FUNC_SUM,
    STAT_FUNC_AVERAGE,
    STAT_FUNC_MIN,
    STAT_FUNC_MAX,
    STAT_FUNC_CHECKED,
    STAT_FUNC_UNCHECKED,
    STAT_FUNC_PERCENT_EMPTY,
    STAT_FUNC_PERCENT_FILLED,
    STAT_FUNC_PERCENT_UNIQUE,
    STAT_FUNC_PERCENT_CHECKED,
    STAT_FUNC_PERCENT_UNCHECKED,
    STAT_FUNC_EARLIEST_DATE,
    STAT_FUNC_LATEST_DATE,
    STAT_FUNC_DATE_RANGE_DAYS,
    STAT_FUNC_DATE_RANGE_MONTHS,
    COLUMN_STATISTIC_FUNCS_CONFIG_KEY,
)

_logger = logging.getLogger('tabdata.view_statistics_service')

# ---------------------------------------------------------------------------
# 统计工具函数
# ---------------------------------------------------------------------------


def get_valid_stat_funcs(field_type: str) -> Set[str]:
    number_types = {'number', 'currency', 'percent', 'count', 'rating'}
    date_types = {'date', 'created_time', 'last_modified_time'}
    boolean_types = {'checkbox', 'boolean'}
    user_types = {'user', 'created_by', 'last_modified_by'}

    if field_type in number_types:
        return {
            STAT_FUNC_SUM,
            STAT_FUNC_AVERAGE,
            STAT_FUNC_MIN,
            STAT_FUNC_MAX,
            STAT_FUNC_COUNT,
            STAT_FUNC_EMPTY,
            STAT_FUNC_FILLED,
            STAT_FUNC_UNIQUE,
            STAT_FUNC_PERCENT_EMPTY,
            STAT_FUNC_PERCENT_FILLED,
            STAT_FUNC_PERCENT_UNIQUE,
        }

    if field_type in date_types:
        return {
            STAT_FUNC_COUNT,
            STAT_FUNC_EMPTY,
            STAT_FUNC_FILLED,
            STAT_FUNC_UNIQUE,
            STAT_FUNC_EARLIEST_DATE,
            STAT_FUNC_LATEST_DATE,
            STAT_FUNC_DATE_RANGE_DAYS,
            STAT_FUNC_DATE_RANGE_MONTHS,
            STAT_FUNC_PERCENT_EMPTY,
            STAT_FUNC_PERCENT_FILLED,
            STAT_FUNC_PERCENT_UNIQUE,
        }

    if field_type in boolean_types:
        return {
            STAT_FUNC_COUNT,
            STAT_FUNC_CHECKED,
            STAT_FUNC_UNCHECKED,
            STAT_FUNC_PERCENT_CHECKED,
            STAT_FUNC_PERCENT_UNCHECKED,
        }

    if field_type in user_types:
        return {
            STAT_FUNC_COUNT,
            STAT_FUNC_EMPTY,
            STAT_FUNC_FILLED,
            STAT_FUNC_PERCENT_EMPTY,
            STAT_FUNC_PERCENT_FILLED,
        }

    if field_type in FILE_BASED_FIELD_TYPES:
        return {
            STAT_FUNC_COUNT,
            STAT_FUNC_EMPTY,
            STAT_FUNC_FILLED,
            STAT_FUNC_PERCENT_EMPTY,
            STAT_FUNC_PERCENT_FILLED,
        }

    return {
        STAT_FUNC_COUNT,
        STAT_FUNC_EMPTY,
        STAT_FUNC_FILLED,
        STAT_FUNC_UNIQUE,
        STAT_FUNC_PERCENT_EMPTY,
        STAT_FUNC_PERCENT_FILLED,
        STAT_FUNC_PERCENT_UNIQUE,
    }


def normalize_stat_func(raw_func: Any) -> Optional[str]:
    if not isinstance(raw_func, str):
        return None
    normalized = raw_func.strip().lower()
    if not normalized:
        return None
    return normalized


def is_cell_value_empty(value: Any) -> bool:
    if value is None:
        return True
    if isinstance(value, str):
        return len(value.strip()) == 0
    if isinstance(value, list):
        return len(value) == 0
    return False


def normalize_statistic_value_key(value: Any) -> str:
    if value is None:
        return 'null'
    if isinstance(value, str):
        return f'string:{value}'
    if isinstance(value, bool):
        return f'bool:{str(value).lower()}'
    if isinstance(value, (int, float)):
        return f'number:{value}'
    if isinstance(value, (datetime, date)):
        return f'date:{value.isoformat()}'
    if isinstance(value, list):
        return f'list:{repr(value)}'
    if isinstance(value, dict):
        return f'dict:{repr(value)}'
    return f'other:{repr(value)}'


def parse_numeric_value(value: Any) -> Optional[float]:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        if math.isfinite(float(value)):
            return float(value)
        return None
    if not isinstance(value, str):
        return None
    trimmed = value.strip()
    if not trimmed:
        return None

    normalized = trimmed.replace(',', '')
    try:
        direct = float(normalized)
        if math.isfinite(direct):
            return direct
    except ValueError:
        pass

    sanitized = ''.join(ch for ch in normalized if ch.isdigit() or ch in '.+-')
    if not sanitized:
        return None
    try:
        fallback = float(sanitized)
    except ValueError:
        return None
    if not math.isfinite(fallback):
        return None
    return fallback


def collect_numeric_values(value: Any, target: List[float]) -> None:
    if isinstance(value, list):
        for item in value:
            collect_numeric_values(item, target)
        return
    numeric_value = parse_numeric_value(value)
    if numeric_value is None:
        return
    target.append(numeric_value)


def parse_timestamp(value: Any) -> Optional[float]:
    if isinstance(value, datetime):
        return value.timestamp() * 1000
    if isinstance(value, date):
        return datetime.combine(value, datetime.min.time()).timestamp() * 1000
    if isinstance(value, (int, float)):
        if not math.isfinite(float(value)):
            return None
        normalized = float(value)
        if abs(normalized) < 1e11:
            normalized *= 1000
        return normalized
    if not isinstance(value, str):
        return None
    trimmed = value.strip()
    if not trimmed:
        return None
    if trimmed.replace('.', '', 1).isdigit() or (
        trimmed.startswith('-') and trimmed[1:].replace('.', '', 1).isdigit()
    ):
        try:
            return parse_timestamp(float(trimmed))
        except ValueError:
            return None
    try:
        return datetime.fromisoformat(trimmed.replace('Z', '+00:00')).timestamp() * 1000
    except ValueError:
        return None


def collect_date_candidates(value: Any, target: List[Tuple[float, Any]]) -> None:
    if isinstance(value, list):
        for item in value:
            collect_date_candidates(item, target)
        return
    timestamp = parse_timestamp(value)
    if timestamp is None:
        return
    target.append((timestamp, value))


def calculate_month_diff(max_timestamp: float, min_timestamp: float) -> int:
    max_date = datetime.utcfromtimestamp(max_timestamp / 1000)
    min_date = datetime.utcfromtimestamp(min_timestamp / 1000)

    months = (max_date.year - min_date.year) * 12 + (max_date.month - min_date.month)
    is_partial_month = (
        max_date.day < min_date.day
        or (
            max_date.day == min_date.day
            and (
                max_date.hour < min_date.hour
                or (
                    max_date.hour == min_date.hour
                    and (
                        max_date.minute < min_date.minute
                        or (
                            max_date.minute == min_date.minute
                            and (
                                max_date.second < min_date.second
                                or (
                                    max_date.second == min_date.second
                                    and max_date.microsecond < min_date.microsecond
                                )
                            )
                        )
                    )
                )
            )
        )
    )
    if is_partial_month:
        months -= 1
    return max(0, months)


def format_percent_value(value: float) -> str:
    safe_value = value if math.isfinite(value) else 0.0
    truncated = math.floor(safe_value * 100) / 100
    if float(truncated).is_integer():
        return f'{int(truncated)}%'
    text = f'{truncated:.2f}'.rstrip('0').rstrip('.')
    return f'{text}%'


def normalize_date_output_value(raw_value: Any) -> Any:
    if isinstance(raw_value, datetime):
        return raw_value.isoformat()
    if isinstance(raw_value, date):
        return raw_value.isoformat()
    return raw_value


def resolve_stat_value(stat_func: str, state: Dict[str, Any], total_rows: int) -> Any:
    denominator = max(total_rows, 1)
    filled_count = state['filled_count']
    empty_count = total_rows - filled_count
    checked_count = state['checked_count']
    unchecked_count = total_rows - checked_count

    if stat_func == STAT_FUNC_COUNT:
        return total_rows
    if stat_func == STAT_FUNC_EMPTY:
        return empty_count
    if stat_func == STAT_FUNC_FILLED:
        return filled_count
    if stat_func == STAT_FUNC_UNIQUE:
        return len(state['unique_values'])
    if stat_func == STAT_FUNC_SUM:
        return state['numeric_sum'] if state['numeric_count'] > 0 else 0
    if stat_func == STAT_FUNC_AVERAGE:
        if state['numeric_count'] <= 0:
            return None
        return state['numeric_sum'] / state['numeric_count']
    if stat_func == STAT_FUNC_MIN:
        return state['numeric_min']
    if stat_func == STAT_FUNC_MAX:
        return state['numeric_max']
    if stat_func == STAT_FUNC_CHECKED:
        return checked_count
    if stat_func == STAT_FUNC_UNCHECKED:
        return unchecked_count
    if stat_func == STAT_FUNC_PERCENT_EMPTY:
        return format_percent_value((empty_count / denominator) * 100)
    if stat_func == STAT_FUNC_PERCENT_FILLED:
        return format_percent_value((filled_count / denominator) * 100)
    if stat_func == STAT_FUNC_PERCENT_UNIQUE:
        return format_percent_value((len(state['unique_values']) / denominator) * 100)
    if stat_func == STAT_FUNC_PERCENT_CHECKED:
        return format_percent_value((checked_count / denominator) * 100)
    if stat_func == STAT_FUNC_PERCENT_UNCHECKED:
        return format_percent_value((unchecked_count / denominator) * 100)
    if stat_func == STAT_FUNC_EARLIEST_DATE:
        min_date = state['min_date']
        return normalize_date_output_value(min_date[1]) if min_date else None
    if stat_func == STAT_FUNC_LATEST_DATE:
        max_date = state['max_date']
        return normalize_date_output_value(max_date[1]) if max_date else None
    if stat_func == STAT_FUNC_DATE_RANGE_DAYS:
        min_date = state['min_date']
        max_date = state['max_date']
        if not min_date or not max_date:
            return 0
        diff = math.floor((max_date[0] - min_date[0]) / (24 * 60 * 60 * 1000))
        return max(0, int(diff))
    if stat_func == STAT_FUNC_DATE_RANGE_MONTHS:
        min_date = state['min_date']
        max_date = state['max_date']
        if not min_date or not max_date:
            return 0
        return calculate_month_diff(max_date[0], min_date[0])
    return None


# ---------------------------------------------------------------------------
# 字段值提取
# ---------------------------------------------------------------------------


def extract_field_value_for_stats(record_data: Any, field_meta: TableField) -> Any:
    if not isinstance(record_data, dict):
        return None

    field_id = str(field_meta.id)
    if field_id in record_data:
        return record_data.get(field_id)

    field_name = str(field_meta.name or '')
    if field_name and field_name in record_data:
        return record_data.get(field_name)

    config = field_meta.config if isinstance(field_meta.config, dict) else {}
    db_field_name = str(config.get('db_field_name') or '').strip()
    if db_field_name and db_field_name in record_data:
        return record_data.get(db_field_name)

    return None


# ---------------------------------------------------------------------------
# 列统计主方法
# ---------------------------------------------------------------------------


def _resolve_stat_items(
    column_statistic_funcs: Optional[Dict[str, Any]],
    view_config: Optional[Dict[str, Any]],
    all_fields: List[TableField],
) -> List[Dict[str, Any]]:
    """统一解析和校验统计项列表。"""
    id_map = {str(f.id): f for f in all_fields}
    name_map = {f.name: f for f in all_fields}

    source_map: Dict[str, Any]
    if isinstance(column_statistic_funcs, dict):
        source_map = column_statistic_funcs
    else:
        config_map = (view_config or {}).get(COLUMN_STATISTIC_FUNCS_CONFIG_KEY)
        source_map = config_map if isinstance(config_map, dict) else {}

    normalized_items: List[Dict[str, Any]] = []
    for raw_field_ref, raw_func in source_map.items():
        field_ref = str(raw_field_ref)
        field_meta = id_map.get(field_ref) or name_map.get(field_ref)
        if not field_meta:
            continue
        normalized_func = normalize_stat_func(raw_func)
        if not normalized_func or normalized_func == STAT_FUNC_NONE:
            continue
        valid_funcs = get_valid_stat_funcs((field_meta.field_type or '').strip().lower())
        if normalized_func not in valid_funcs:
            continue
        normalized_items.append({
            'field_id': str(field_meta.id),
            'field_name': field_meta.name,
            'agg_func': normalized_func,
            'field_meta': field_meta,
        })
    return normalized_items


def get_view_column_statistics_orm_compat(
    view,
    column_statistic_funcs: Optional[Dict[str, Any]],
    filters: Optional[List[Dict[str, Any]]],
    filter_logic: Optional[str],
    rls_context=None,
) -> Dict[str, Any]:
    """
    native 聚合不可用时的 ORM 兼容路径（保证统计接口可用）。
    """
    from apps.tabdata.models import TableRecord

    table_id = view.table_id

    all_fields = list(TableField.objects.using(TABDATA_DB_ALIAS).filter(
        table_id=table_id,
        is_deleted=False,
    ))
    if not all_fields:
        all_qs = TableRecord.objects.using(TABDATA_DB_ALIAS).filter(table_id=table_id, is_deleted=False)
        latest_version = get_latest_version(all_qs, table_id=table_id)
        return {
            'view_id': str(view.id),
            'latest_version': int(latest_version),
            'total_records': 0,
            'column_statistics': [],
        }

    normalized_items = _resolve_stat_items(column_statistic_funcs, view.config, all_fields)

    filtered_qs = TableRecord.objects.using(TABDATA_DB_ALIAS).filter(table_id=table_id, is_deleted=False)
    filtered_qs = apply_view_filters(view, filtered_qs, filters=filters, filter_logic=filter_logic)

    # ── RLS 行级安全策略注入（ORM 路径）──
    if rls_context is not None:
        from .rls_service import apply_rls_to_orm_queryset
        filtered_qs = apply_rls_to_orm_queryset(filtered_qs, table_id, rls_context)

    total_rows = filtered_qs.count()

    all_qs = TableRecord.objects.using(TABDATA_DB_ALIAS).filter(table_id=table_id, is_deleted=False)
    latest_version = get_latest_version(all_qs, table_id=table_id)

    if not normalized_items:
        return {
            'view_id': str(view.id),
            'latest_version': int(latest_version),
            'total_records': total_rows,
            'column_statistics': [],
        }

    records_data = list(filtered_qs.values_list('data', flat=True))
    column_statistics: List[Dict[str, Any]] = []
    for item in normalized_items:
        field_meta = item['field_meta']
        state: Dict[str, Any] = {
            'filled_count': 0,
            'unique_values': set(),
            'numeric_sum': 0.0,
            'numeric_count': 0,
            'numeric_min': None,
            'numeric_max': None,
            'checked_count': 0,
            'min_date': None,
            'max_date': None,
        }

        for payload in records_data:
            value = extract_field_value_for_stats(payload, field_meta)
            is_empty = is_cell_value_empty(value)
            if not is_empty:
                state['filled_count'] += 1
                state['unique_values'].add(normalize_statistic_value_key(value))

            numeric_values: List[float] = []
            collect_numeric_values(value, numeric_values)
            for number in numeric_values:
                state['numeric_sum'] += number
                state['numeric_count'] += 1
                if state['numeric_min'] is None or number < state['numeric_min']:
                    state['numeric_min'] = number
                if state['numeric_max'] is None or number > state['numeric_max']:
                    state['numeric_max'] = number

            checkbox_state = parse_checkbox_state(value)
            if checkbox_state is True:
                state['checked_count'] += 1

            date_candidates: List[Tuple[float, Any]] = []
            collect_date_candidates(value, date_candidates)
            for candidate in date_candidates:
                if state['min_date'] is None or candidate[0] < state['min_date'][0]:
                    state['min_date'] = candidate
                if state['max_date'] is None or candidate[0] > state['max_date'][0]:
                    state['max_date'] = candidate

        value = resolve_stat_value(item['agg_func'], state, total_rows)
        column_statistics.append({
            'field_id': item['field_id'],
            'field_name': item['field_name'],
            'agg_func': item['agg_func'],
            'value': value,
        })

    return {
        'view_id': str(view.id),
        'latest_version': int(latest_version),
        'total_records': total_rows,
        'column_statistics': column_statistics,
    }


def _batch_compute_native_stats(
    normalized_items: List[Dict[str, Any]],
    qb,
    where_sql: str,
    where_params: list,
    total_rows: int,
) -> List[Dict[str, Any]]:
    """将所有列统计合并为一次 SQL 查询（替代逐列串行）。"""
    from django.db import connections
    from apps.tabdata.constants import TABDATA_DB_ALIAS as DB_ALIAS
    from apps.tabdata.native.pg_type_map import FIELD_TYPE_TO_PG_TYPE

    select_parts: List[str] = []
    plan: List[Dict[str, Any]] = []
    expr_idx = 0

    for item in normalized_items:
        field_meta = item['field_meta']
        agg_func = item['agg_func']
        col_ref = qb._resolve_column_ref(str(field_meta.id))
        if not col_ref:
            continue

        pg_type = FIELD_TYPE_TO_PG_TYPE.get(field_meta.field_type, 'TEXT')
        is_jsonb = pg_type == 'JSONB'
        is_text = pg_type == 'TEXT'

        if is_jsonb:
            empty_expr = f"COUNT(*) FILTER (WHERE {col_ref} IS NULL OR {col_ref} = '[]'::jsonb)"
            filled_expr = f"COUNT(*) FILTER (WHERE {col_ref} IS NOT NULL AND {col_ref} != '[]'::jsonb)"
        elif is_text:
            empty_expr = f"COUNT(*) FILTER (WHERE {col_ref} IS NULL OR {col_ref} = '')"
            filled_expr = f"COUNT(*) FILTER (WHERE {col_ref} IS NOT NULL AND {col_ref} != '')"
        else:
            empty_expr = f"COUNT(*) FILTER (WHERE {col_ref} IS NULL)"
            filled_expr = f"COUNT(*) FILTER (WHERE {col_ref} IS NOT NULL)"

        entry: Dict[str, Any] = {
            'item': item,
            'agg_func': agg_func,
            'start_idx': expr_idx,
            'num_exprs': 0,
        }

        SINGLE_EXPR_MAP = {
            STAT_FUNC_EMPTY: empty_expr,
            STAT_FUNC_FILLED: filled_expr,
            STAT_FUNC_UNIQUE: f"COUNT(DISTINCT {col_ref})",
            STAT_FUNC_SUM: f"SUM({col_ref})",
            STAT_FUNC_AVERAGE: f"AVG({col_ref})",
            STAT_FUNC_MIN: f"MIN({col_ref})",
            STAT_FUNC_MAX: f"MAX({col_ref})",
            STAT_FUNC_CHECKED: f"COUNT(*) FILTER (WHERE {col_ref} = TRUE)",
            STAT_FUNC_UNCHECKED: f"COUNT(*) FILTER (WHERE {col_ref} IS NULL OR {col_ref} = FALSE)",
            STAT_FUNC_PERCENT_EMPTY: empty_expr,
            STAT_FUNC_PERCENT_FILLED: filled_expr,
            STAT_FUNC_PERCENT_UNIQUE: f"COUNT(DISTINCT {col_ref})",
            STAT_FUNC_PERCENT_CHECKED: f"COUNT(*) FILTER (WHERE {col_ref} = TRUE)",
            STAT_FUNC_PERCENT_UNCHECKED: f"COUNT(*) FILTER (WHERE {col_ref} IS NULL OR {col_ref} = FALSE)",
            STAT_FUNC_EARLIEST_DATE: f"MIN({col_ref})",
            STAT_FUNC_LATEST_DATE: f"MAX({col_ref})",
            STAT_FUNC_DATE_RANGE_DAYS: f"EXTRACT(EPOCH FROM (MAX({col_ref}) - MIN({col_ref}))) / 86400",
        }

        if agg_func == STAT_FUNC_COUNT:
            plan.append(entry)
            continue

        if agg_func == STAT_FUNC_DATE_RANGE_MONTHS:
            select_parts.append(f"MIN({col_ref}) AS s{expr_idx}")
            select_parts.append(f"MAX({col_ref}) AS s{expr_idx + 1}")
            entry['num_exprs'] = 2
            expr_idx += 2
        elif agg_func in SINGLE_EXPR_MAP:
            select_parts.append(f"{SINGLE_EXPR_MAP[agg_func]} AS s{expr_idx}")
            entry['num_exprs'] = 1
            expr_idx += 1

        plan.append(entry)

    row_values: Optional[list] = None
    if select_parts:
        select_clause = ', '.join(select_parts)
        sql = f"SELECT {select_clause} FROM {qb.qualified_name} WHERE {where_sql}"
        with connections[DB_ALIAS].cursor() as cursor:
            cursor.execute(sql, where_params)
            row = cursor.fetchone()
        row_values = list(row) if row else [None] * len(select_parts)

    results: List[Dict[str, Any]] = []
    for entry in plan:
        item = entry['item']
        agg_func = entry['agg_func']
        si = entry['start_idx']
        val = row_values[si] if row_values and entry['num_exprs'] > 0 else None

        if agg_func == STAT_FUNC_COUNT:
            value = total_rows
        elif agg_func in (STAT_FUNC_EMPTY, STAT_FUNC_FILLED, STAT_FUNC_UNIQUE,
                          STAT_FUNC_CHECKED, STAT_FUNC_UNCHECKED):
            value = val
        elif agg_func == STAT_FUNC_SUM:
            value = float(val) if val is not None else 0
        elif agg_func in (STAT_FUNC_AVERAGE, STAT_FUNC_MIN, STAT_FUNC_MAX):
            value = float(val) if val is not None else None
        elif agg_func in (STAT_FUNC_PERCENT_EMPTY, STAT_FUNC_PERCENT_FILLED,
                          STAT_FUNC_PERCENT_UNIQUE, STAT_FUNC_PERCENT_CHECKED,
                          STAT_FUNC_PERCENT_UNCHECKED):
            value = round(val / total_rows, 4) if total_rows > 0 and val is not None else 0
        elif agg_func in (STAT_FUNC_EARLIEST_DATE, STAT_FUNC_LATEST_DATE):
            value = val.isoformat() if hasattr(val, 'isoformat') else val
        elif agg_func == STAT_FUNC_DATE_RANGE_DAYS:
            value = int(val) if val is not None else 0
        elif agg_func == STAT_FUNC_DATE_RANGE_MONTHS:
            min_val = row_values[si] if row_values else None
            max_val = row_values[si + 1] if row_values else None
            if (min_val and max_val
                    and hasattr(min_val, 'year') and hasattr(max_val, 'year')):
                months = ((max_val.year - min_val.year) * 12
                          + (max_val.month - min_val.month))
                if max_val.day < min_val.day:
                    months -= 1
                value = max(months, 0)
            else:
                value = 0
        else:
            value = None

        results.append({
            'field_id': item['field_id'],
            'field_name': item['field_name'],
            'agg_func': agg_func,
            'value': value,
        })

    return results


def get_view_column_statistics_native(
    view,
    column_statistic_funcs: Optional[Dict[str, Any]],
    filters: Optional[List[Dict[str, Any]]],
    filter_logic: Optional[str],
    rls_context=None,
) -> Dict[str, Any]:
    """
    使用原生 SQL 聚合计算列统计信息。

    Phase 3D: 唯一数据路径，错误直接抛出。
    """
    from django.db import connections
    from apps.tabdata.native.query_builder import NativeQueryBuilder
    from apps.tabdata.native.record_io import NativeRecordIO
    from apps.tabdata.native.ddl_manager import resolve_schema_partition_id
    from apps.tabdata.models import TableRecord

    if connections[TABDATA_DB_ALIAS].vendor != 'postgresql':
        return get_view_column_statistics_orm_compat(
            view, column_statistic_funcs, filters, filter_logic,
            rls_context=rls_context,
        )

    table = view.table
    table_id = table.id
    space_id = resolve_schema_partition_id(table)

    all_fields = list(TableField.objects.using(TABDATA_DB_ALIAS).filter(
        table_id=table_id,
        is_deleted=False,
    ))
    if not all_fields:
        orm_qs = TableRecord.objects.using(TABDATA_DB_ALIAS).filter(table_id=table_id, is_deleted=False)
        latest_version = get_latest_version(orm_qs, table_id=table_id)
        return {
            'view_id': str(view.id),
            'latest_version': int(latest_version),
            'total_records': 0,
            'column_statistics': [],
        }

    qb = NativeQueryBuilder(space_id, table_id, all_fields)
    native_io = NativeRecordIO(space_id, table_id)

    normalized_items = _resolve_stat_items(column_statistic_funcs, view.config, all_fields)

    effective_filter = resolve_effective_filter(view, filters, filter_logic)
    where = qb.build_where_clause(effective_filter)

    # ── RLS 行级安全策略注入 ──
    if rls_context is not None:
        from .rls_service import build_rls_select_where
        where = build_rls_select_where(table, rls_context, qb, where)

    where_sql, where_params = where if where else ('TRUE', [])

    total_rows = native_io.count_records(where=where)

    orm_qs = TableRecord.objects.using(TABDATA_DB_ALIAS).filter(table_id=table_id, is_deleted=False)
    latest_version = get_latest_version(orm_qs, table_id=table_id)

    if not normalized_items:
        return {
            'view_id': str(view.id),
            'latest_version': int(latest_version),
            'total_records': total_rows,
            'column_statistics': [],
        }

    column_statistics = _batch_compute_native_stats(
        normalized_items, qb, where_sql, where_params, total_rows,
    )

    return {
        'view_id': str(view.id),
        'latest_version': int(latest_version),
        'total_records': total_rows,
        'column_statistics': column_statistics,
    }


def compute_native_stat(
    qualified_table: str,
    col_ref: str,
    agg_func: str,
    where_sql: str,
    where_params: list,
    total_rows: int,
    field_meta: TableField,
) -> Any:
    """计算单个列统计值（原生 SQL）。"""
    from django.db import connections
    from apps.tabdata.constants import TABDATA_DB_ALIAS as DB_ALIAS
    from apps.tabdata.native.pg_type_map import FIELD_TYPE_TO_PG_TYPE

    pg_type = FIELD_TYPE_TO_PG_TYPE.get(field_meta.field_type, 'TEXT')
    is_jsonb = pg_type == 'JSONB'
    is_text = pg_type == 'TEXT'

    def _run(select_expr: str) -> Any:
        sql = f'SELECT {select_expr} FROM {qualified_table} WHERE {where_sql}'
        with connections[DB_ALIAS].cursor() as cursor:
            cursor.execute(sql, where_params)
            row = cursor.fetchone()
        return row[0] if row else None

    # ── 基础聚合 ──
    if agg_func == STAT_FUNC_COUNT:
        return total_rows

    if agg_func == STAT_FUNC_EMPTY:
        if is_jsonb:
            return _run(f"COUNT(*) FILTER (WHERE {col_ref} IS NULL OR {col_ref} = '[]'::jsonb)")
        if is_text:
            return _run(f"COUNT(*) FILTER (WHERE {col_ref} IS NULL OR {col_ref} = '')")
        return _run(f'COUNT(*) FILTER (WHERE {col_ref} IS NULL)')

    if agg_func == STAT_FUNC_FILLED:
        if is_jsonb:
            return _run(f"COUNT(*) FILTER (WHERE {col_ref} IS NOT NULL AND {col_ref} != '[]'::jsonb)")
        if is_text:
            return _run(f"COUNT(*) FILTER (WHERE {col_ref} IS NOT NULL AND {col_ref} != '')")
        return _run(f'COUNT(*) FILTER (WHERE {col_ref} IS NOT NULL)')

    if agg_func == STAT_FUNC_UNIQUE:
        return _run(f'COUNT(DISTINCT {col_ref})')

    if agg_func == STAT_FUNC_SUM:
        val = _run(f'SUM({col_ref})')
        return float(val) if val is not None else 0

    if agg_func == STAT_FUNC_AVERAGE:
        val = _run(f'AVG({col_ref})')
        return float(val) if val is not None else None

    if agg_func == STAT_FUNC_MIN:
        val = _run(f'MIN({col_ref})')
        return float(val) if val is not None else None

    if agg_func == STAT_FUNC_MAX:
        val = _run(f'MAX({col_ref})')
        return float(val) if val is not None else None

    # ── checkbox 统计 ──
    if agg_func == STAT_FUNC_CHECKED:
        return _run(f'COUNT(*) FILTER (WHERE {col_ref} = TRUE)')

    if agg_func == STAT_FUNC_UNCHECKED:
        return _run(f'COUNT(*) FILTER (WHERE {col_ref} IS NULL OR {col_ref} = FALSE)')

    # ── 百分比统计 ──
    if agg_func == STAT_FUNC_PERCENT_EMPTY:
        empty_count = compute_native_stat(
            qualified_table, col_ref, STAT_FUNC_EMPTY,
            where_sql, where_params, total_rows, field_meta,
        )
        return round(empty_count / total_rows, 4) if total_rows > 0 else 0

    if agg_func == STAT_FUNC_PERCENT_FILLED:
        filled_count = compute_native_stat(
            qualified_table, col_ref, STAT_FUNC_FILLED,
            where_sql, where_params, total_rows, field_meta,
        )
        return round(filled_count / total_rows, 4) if total_rows > 0 else 0

    if agg_func == STAT_FUNC_PERCENT_UNIQUE:
        unique_count = compute_native_stat(
            qualified_table, col_ref, STAT_FUNC_UNIQUE,
            where_sql, where_params, total_rows, field_meta,
        )
        return round(unique_count / total_rows, 4) if total_rows > 0 else 0

    if agg_func == STAT_FUNC_PERCENT_CHECKED:
        checked_count = compute_native_stat(
            qualified_table, col_ref, STAT_FUNC_CHECKED,
            where_sql, where_params, total_rows, field_meta,
        )
        return round(checked_count / total_rows, 4) if total_rows > 0 else 0

    if agg_func == STAT_FUNC_PERCENT_UNCHECKED:
        unchecked_count = compute_native_stat(
            qualified_table, col_ref, STAT_FUNC_UNCHECKED,
            where_sql, where_params, total_rows, field_meta,
        )
        return round(unchecked_count / total_rows, 4) if total_rows > 0 else 0

    # ── 日期统计 ──
    if agg_func == STAT_FUNC_EARLIEST_DATE:
        val = _run(f'MIN({col_ref})')
        return val.isoformat() if hasattr(val, 'isoformat') else val

    if agg_func == STAT_FUNC_LATEST_DATE:
        val = _run(f'MAX({col_ref})')
        return val.isoformat() if hasattr(val, 'isoformat') else val

    if agg_func == STAT_FUNC_DATE_RANGE_DAYS:
        val = _run(f'EXTRACT(EPOCH FROM (MAX({col_ref}) - MIN({col_ref}))) / 86400')
        return int(val) if val is not None else 0

    if agg_func == STAT_FUNC_DATE_RANGE_MONTHS:
        min_val = _run(f'MIN({col_ref})')
        max_val = _run(f'MAX({col_ref})')
        if min_val and max_val and hasattr(min_val, 'year') and hasattr(max_val, 'year'):
            months = (max_val.year - min_val.year) * 12 + (max_val.month - min_val.month)
            if max_val.day < min_val.day:
                months -= 1
            return max(months, 0)
        return 0

    return None
