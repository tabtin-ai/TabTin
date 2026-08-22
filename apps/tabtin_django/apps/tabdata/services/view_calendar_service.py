"""
日历视图数据服务

负责把 TableRecord 投射成"日历视图"的 occurrence wrapper。

输出契约（每个 wrapper 表示「某条记录在某一天上的一个 occurrence」）：

    {
        'date': 'YYYY-MM-DD',           # 该 occurrence 落在哪一天（按 settings.TIME_ZONE）
        'record': <serialized record>,  # 完整的序列化 TableRecord
        'is_start': bool,               # 是否为该事件的开始日
        'is_end': bool,                 # 是否为该事件的结束日
        'span_total_days': int,         # 事件实际渲染的总跨度（含起止；超 _MAX_OCCURRENCE_SPAN_DAYS 时为截断后的值）
        'occurrence_index': int,        # 当前 occurrence 在该事件中的序号（从 0 起）
        'dirty': bool,                  # 该事件是否为 end<start 的脏数据（按单点处理）
        'truncated': bool,              # 该事件是否因超过 _MAX_OCCURRENCE_SPAN_DAYS 被截断（前端可展示提示）
    }

时区约定：
- 后端按 `django.conf.settings.TIME_ZONE` 给出"本地日期"，前端无需再做时区换算
- TIMESTAMPTZ 列：SQL 用 `AT TIME ZONE settings.TIME_ZONE` 截取本地日期，与 Python
  端 `_parse_iso_date` 的时区感知解析对齐
- DATE 列：直接 ::date，无时区语义

设计要点：
- 未配置 `end_date_field`：所有事件退化为单点（start==end，span=1，dirty=False，truncated=False）
- 已配置 `end_date_field`：
    - end 为空 → 按单点处理（dirty=False）
    - end<start → 按单点处理（dirty=True，前端可显示 warning icon）
    - end>=start → 展开 [start..end] ∩ [query_start..query_end] 范围内每天一个 occurrence
    - end-start+1 > `_MAX_OCCURRENCE_SPAN_DAYS` → 按上限截断，wrapper.truncated=True
- `end_date_field` 配置了但字段已删除 → 按未配置处理（不阻断查询）
- SQL 层范围重叠查询：`local(start) <= query_end AND COALESCE(local(end), local(start)) >= query_start`
  → 保证横跨整个查询窗口的事件（start<query_start 且 end>query_end）也会被查到
"""
from typing import Dict, Any, Optional, List, Set, Tuple, Literal
from datetime import datetime, date, timedelta
from zoneinfo import ZoneInfo

from django.conf import settings
from django.db import DatabaseError, transaction

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

_logger = logging.getLogger('tabdata.view_calendar_service')

_ORM_FALLBACK_MAX_RECORDS = 50_000

# 单条事件展开的最大天数。
# 跨度超过该值时按上限截断，避免极端脏数据（如误填 9999-12-31）撑爆响应体。
# 1 年完全够覆盖年度项目，超过这个长度的事件本身已属"非典型日历用法"。
_MAX_OCCURRENCE_SPAN_DAYS = 366


def _resolve_end_date_field(view, config) -> Optional[TableField]:
    """读取 `end_date_field` 配置并 fetch 对应的 TableField。

    宽容处理：
    - 未配置 → None
    - 配置了但字段已删除/不存在 → None（按未配置处理，不阻断查询）
    - 配置了但属于其他 table → None（防御性）
    """
    end_date_field_id = config.get('end_date_field')
    if not end_date_field_id:
        return None
    try:
        field = TableField.objects.using(TABDATA_DB_ALIAS).get(
            id=end_date_field_id, is_deleted=False,
        )
    except (ValueError, TypeError, TableField.DoesNotExist):
        _logger.info(
            "Calendar end_date_field %s not found or deleted, falling back to single-point",
            end_date_field_id,
        )
        return None
    if field.table_id != view.table_id:
        _logger.warning(
            "Calendar end_date_field %s belongs to a different table, ignoring",
            end_date_field_id,
        )
        return None
    return field


def _local_zoneinfo() -> ZoneInfo:
    """取 settings.TIME_ZONE 对应的 ZoneInfo（每次新建避免 process-level 缓存陷阱）。"""
    return ZoneInfo(settings.TIME_ZONE)


def _parse_iso_date(value: Any) -> Optional[date]:
    """从 record_data 中读到的日期值解析为「按 settings.TIME_ZONE 落在哪一天」。

    支持 'YYYY-MM-DD'、ISO datetime 字符串（带或不带 TZ 后缀）、`date` / `datetime` 实例。

    时区处理：
    - 纯 'YYYY-MM-DD'（DATE 列回读）→ 原样返回
    - 带 TZ 的 ISO datetime（TIMESTAMPTZ 列回读，PG session=UTC 时会是 UTC 偏移）→
      按 settings.TIME_ZONE 转换后取 date，确保 4/9 +08 事件在 UTC session 下也落到 4/9
    - naive datetime → 视作已是本地时间，直接 .date()
    - 解析失败 → None
    """
    if value is None:
        return None
    if isinstance(value, datetime):
        if value.tzinfo is None:
            return value.date()
        return value.astimezone(_local_zoneinfo()).date()
    if isinstance(value, date):
        return value
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        # 纯日期串（DATE 列回读形态）：无时区语义，原样取
        if len(text) == 10:
            try:
                return date.fromisoformat(text)
            except ValueError:
                return None
        # ISO datetime 串：先把 'Z' 归一化成 '+00:00'（Python 3.11 fromisoformat 已支持 'Z'，
        # 但部分历史脏数据可能是大写 'z' 或缺秒，兜底归一化提高鲁棒性）
        normalized = text[:-1] + '+00:00' if text.endswith(('Z', 'z')) else text
        try:
            dt = datetime.fromisoformat(normalized)
        except ValueError:
            # 兜底：截 [:10] 当作日期；保留原行为以容忍极端脏数据
            try:
                return date.fromisoformat(text[:10])
            except ValueError:
                return None
        if dt.tzinfo is None:
            return dt.date()
        return dt.astimezone(_local_zoneinfo()).date()
    return None


def _read_record_field_value(record_data: Dict[str, Any], *keys: Optional[str]) -> Any:
    """从序列化 record 的 `data` 字典里按候选 key 顺序读取值。

    用于兼容 field_key_type 在 'name' / 'id' / 'dbFieldName' 之间的差异：
    `record_data['data']` 里同一字段可能用 name 或 id 当 key，这里依次尝试。
    """
    payload = record_data.get('data') or {}
    for key in keys:
        if key is None:
            continue
        if key in payload:
            value = payload[key]
            if value is not None:
                return value
    return None


def _parse_date_range(date_range: Optional[str]) -> Tuple[Optional[date], Optional[date]]:
    """解析 `'YYYY-MM-DD,YYYY-MM-DD'` 形式的查询区间（起止均闭）。"""
    if not date_range:
        return None, None
    start_str, end_str = date_range.split(',')
    start_d = datetime.strptime(start_str, '%Y-%m-%d').date()
    end_d = datetime.strptime(end_str, '%Y-%m-%d').date()
    return start_d, end_d


def _format_date_bounds(
    min_d: Optional[date],
    max_d: Optional[date],
) -> Optional[Dict[str, str]]:
    """把 MIN/MAX 本地日格式化为 metadata.date_bounds；全空则 None。"""
    if min_d is None or max_d is None:
        return None
    return {'min': min_d.isoformat(), 'max': max_d.isoformat()}


def _compute_date_bounds_orm(
    queryset,
    date_field_keys: List[str],
) -> Optional[Dict[str, str]]:
    """ORM 路径：扫描基准日期列非空值，取 MIN/MAX（不受 date_range 裁剪）。"""
    min_d: Optional[date] = None
    max_d: Optional[date] = None
    for record in queryset[:_ORM_FALLBACK_MAX_RECORDS]:
        data = read_data(record)
        raw = None
        for key in date_field_keys:
            raw = data.get(key)
            if raw is not None:
                break
        parsed = _parse_iso_date(raw)
        if parsed is None:
            continue
        if min_d is None or parsed < min_d:
            min_d = parsed
        if max_d is None or parsed > max_d:
            max_d = parsed
    return _format_date_bounds(min_d, max_d)


def _compute_date_bounds_native(
    view: TableView,
    date_field: TableField,
    *,
    filters: Optional[List[Dict[str, Any]]] = None,
    filter_logic: Optional[str] = None,
    search: Optional[str] = None,
    search_field_ids: Optional[List[str]] = None,
    search_hide_not_match_rows: bool = False,
    rls_context=None,
) -> Optional[Dict[str, str]]:
    """Native 路径：对 date_field 做 MIN/MAX 本地日聚合（不受 date_range 裁剪）。

    WHERE 与 get_calendar_events_native 的 base_where 对齐（视图筛选 / 搜索 / RLS），
    但不叠加月窗口，以便前端首次进入时能锚定到「全表最晚有值日」所在月。
    """
    from apps.tabdata.native.query_builder import NativeQueryBuilder
    from apps.tabdata.native.record_io import NativeRecordIO
    from apps.tabdata.native.ddl_manager import resolve_schema_partition_id
    from django.db import connections

    table = view.table
    space_id = resolve_schema_partition_id(table)
    all_fields = list(
        TableField.objects.using(TABDATA_DB_ALIAS).filter(table_id=table.id, is_deleted=False)
    )
    qb = NativeQueryBuilder(space_id, table.id, all_fields)
    native_io = NativeRecordIO(space_id, table.id)

    effective_filter = resolve_effective_filter(view, filters, filter_logic)
    base_where = qb.build_where_clause(effective_filter)

    normalized_search = (search or '').strip()
    if search_hide_not_match_rows and normalized_search:
        search_where = build_native_search_where(
            qb=qb,
            all_fields=all_fields,
            search_value=normalized_search,
            search_field_ids=search_field_ids,
        )
        base_where = merge_native_where_clauses(base_where, search_where)

    if rls_context is not None:
        from .rls_service import build_rls_select_where
        base_where = build_rls_select_where(table, rls_context, qb, base_where)

    date_col_ref = qb._resolve_column_ref(str(date_field.id))
    local_sql, local_params = _local_date_sql(date_col_ref, date_field)
    base_sql, base_params = base_where

    # 子查询先截本地日，再 MIN/MAX，避免 TIMESTAMPTZ 的 TZ 占位符在聚合表达式里重复交错。
    sql = (
        f'SELECT MIN(local_d), MAX(local_d) FROM ('
        f'  SELECT {local_sql} AS local_d'
        f'  FROM {native_io.qualified}'
        f'  WHERE ({base_sql}) AND {date_col_ref} IS NOT NULL'
        f') AS _cal_bounds'
    )
    params = local_params + base_params

    with connections[native_io.db_alias].cursor() as cursor:
        cursor.execute(sql, params)
        row = cursor.fetchone()

    if not row or (row[0] is None and row[1] is None):
        return None
    min_raw, max_raw = row[0], row[1]
    min_d = min_raw if isinstance(min_raw, date) else _parse_iso_date(min_raw)
    max_d = max_raw if isinstance(max_raw, date) else _parse_iso_date(max_raw)
    return _format_date_bounds(min_d, max_d)


def _expand_occurrences(
    record_data: Dict[str, Any],
    start_d: date,
    end_d: Optional[date],
    *,
    query_start: Optional[date],
    query_end: Optional[date],
) -> List[Dict[str, Any]]:
    """把单条 record 展开成它所有落在查询窗口内的 occurrence wrapper。

    Args:
        record_data: 已经序列化的 TableRecord（含 id/data/fields/...）
        start_d: 事件开始日期（settings.TIME_ZONE 本地日）
        end_d: 事件结束日期；None 表示单字段或缺数据 → 退化单点
        query_start, query_end: 查询窗口（闭区间），None 表示不裁剪

    特殊语义（前端可据 wrapper 标记区分）：
    - 脏数据：end_d < start_d → 按单点处理（end_d := start_d），dirty=True
    - 截断：(end_d-start_d+1) > `_MAX_OCCURRENCE_SPAN_DAYS` → 按上限截断 end_d，
      所有 wrapper 标 truncated=True；前端可显示"事件实际更长"提示
    """
    is_dirty = False
    is_truncated = False

    if end_d is None:
        end_d = start_d
    elif end_d < start_d:
        end_d = start_d
        is_dirty = True

    span_total = (end_d - start_d).days + 1
    if span_total > _MAX_OCCURRENCE_SPAN_DAYS:
        end_d = start_d + timedelta(days=_MAX_OCCURRENCE_SPAN_DAYS - 1)
        span_total = _MAX_OCCURRENCE_SPAN_DAYS
        is_truncated = True

    occurrence_start = max(start_d, query_start) if query_start else start_d
    occurrence_end = min(end_d, query_end) if query_end else end_d
    if occurrence_start > occurrence_end:
        return []

    leading_offset = (occurrence_start - start_d).days
    occurrences: List[Dict[str, Any]] = []
    cur = occurrence_start
    while cur <= occurrence_end:
        idx = leading_offset + (cur - occurrence_start).days
        occurrences.append({
            'date': cur.isoformat(),
            'record': record_data,
            'is_start': cur == start_d,
            'is_end': cur == end_d,
            'span_total_days': span_total,
            'occurrence_index': idx,
            'dirty': is_dirty,
            'truncated': is_truncated,
        })
        cur += timedelta(days=1)
    return occurrences


def get_calendar_data(
    view: TableView,
    date_range: Optional[str],
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
    """获取日历视图数据"""
    config = view.config
    date_field_id = config.get('date_field')
    if not date_field_id:
        return {
            'view': {
                'id': str(view.id),
                'name': view.name,
                'view_type': view.view_type,
                'config': config,
            },
            'records': [],
            'total': 0,
            'page': page,
            'page_size': page_size,
            'latest_version': 0,
            'has_changes': True,
            'metadata': {
                'needs_configuration': True,
                'missing_fields': ['date_field'],
            },
        }

    try:
        date_field = TableField.objects.using(TABDATA_DB_ALIAS).get(id=date_field_id, is_deleted=False)
    except (ValueError, TypeError, TableField.DoesNotExist):
        return {
            'view': {
                'id': str(view.id),
                'name': view.name,
                'view_type': view.view_type,
                'config': config,
            },
            'records': [],
            'total': 0,
            'page': page,
            'page_size': page_size,
            'latest_version': 0,
            'has_changes': True,
            'metadata': {
                'needs_configuration': True,
                'missing_fields': ['date_field'],
                'error': f'日期字段 {date_field_id} 不存在或已删除',
            },
        }
    date_field_id_str = str(date_field.id)
    date_field_keys = [date_field_id_str]
    if date_field.name and date_field.name != date_field_id_str:
        date_field_keys.append(date_field.name)

    end_date_field = _resolve_end_date_field(view, config)
    end_date_field_id_str: Optional[str] = str(end_date_field.id) if end_date_field else None
    end_date_field_keys: List[str] = []
    if end_date_field:
        end_date_field_keys.append(end_date_field_id_str)
        if end_date_field.name and end_date_field.name != end_date_field_id_str:
            end_date_field_keys.append(end_date_field.name)

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

    events: List[Dict[str, Any]] = []
    total = 0
    _cal_data_source = 'native'

    try:
        with transaction.atomic(using=TABDATA_DB_ALIAS):
            events, total = get_calendar_events_native(
                view, date_field, date_field_id_str, date_range,
                page, page_size, fields, field_key_type, filters, filter_logic,
                sorts=sorts,
                search=search,
                search_field_ids=search_field_ids,
                search_hide_not_match_rows=search_hide_not_match_rows,
                rls_context=rls_context,
                end_date_field=end_date_field,
                end_date_field_id_str=end_date_field_id_str,
            )
    except (DatabaseError, KeyError, TypeError, ValueError) as exc:
        _logger.warning("Calendar native query failed, falling back to ORM: %s", exc)
        _cal_data_source = 'orm_fallback'
        events, total = get_calendar_events_orm(
            queryset, date_field, date_field_keys, date_range,
            page, page_size, fields, field_key_type,
            sorts=sorts, view=view,
            end_date_field=end_date_field,
            end_date_field_keys=end_date_field_keys,
            search=search,
            search_field_ids=search_field_ids,
            search_hide_not_match_rows=search_hide_not_match_rows,
        )

    # date_bounds 独立计算：失败时降级 ORM，不拖垮事件查询路径。
    # 必须包 atomic：PG 上裸 DatabaseError 会毒化当前事务，导致后续 ORM 也失败。
    date_bounds: Optional[Dict[str, str]] = None
    try:
        with transaction.atomic(using=TABDATA_DB_ALIAS):
            date_bounds = _compute_date_bounds_native(
                view,
                date_field,
                filters=filters,
                filter_logic=filter_logic,
                search=search,
                search_field_ids=search_field_ids,
                search_hide_not_match_rows=search_hide_not_match_rows,
                rls_context=rls_context,
            )
    except (DatabaseError, KeyError, TypeError, ValueError) as exc:
        _logger.warning("Calendar date_bounds native failed, falling back to ORM: %s", exc)
        date_bounds = _compute_date_bounds_orm(queryset, date_field_keys)

    metadata: Dict[str, Any] = {
        'view_type': 'calendar',
        'date_field': str(date_field_id),
        # ── 分页契约说明（让前端不踩坑）──
        # `total` / `matched_total` 计的是「落入查询窗口的 TableRecord 行数」，
        # 而 `records` 是把每行展开成多个日 occurrence 后的 wrapper 列表，
        # 所以 `len(records)` 通常 >= `total`。Wave 2 控制器按 record id 聚合
        # occurrence 时务必基于 `total` 判断有无下一页，而不是 `len(records)`。
        'pagination_unit': 'record',
        'occurrence_count': len(events),
        # 基准日期列在「视图筛选后、不受 date_range 裁剪」集合上的 MIN/MAX 本地日。
        # 前端首次进入日历用 max 锚定所在月；全空时为 null。
        'date_bounds': date_bounds,
    }
    if end_date_field_id_str:
        metadata['end_date_field'] = end_date_field_id_str
    if date_range:
        metadata['date_range'] = date_range
    if _cal_data_source != 'native':
        metadata['data_source'] = _cal_data_source

    return {
        'view': serialized_view,
        'total': total,
        'matched_total': total,
        'page': page,
        'page_size': page_size,
        'records': events,
        'metadata': metadata,
        'latest_version': int(latest_version),
        'has_changes': has_changes,
        'requires_full_reload': requires_full_reload,
    }


def _is_timestamptz_field(field: TableField) -> bool:
    """判断 field 对应的 native 列是否为 PG TIMESTAMPTZ。

    这决定了 `_local_date_sql` 是否需要先 `AT TIME ZONE` 再 ::date。覆盖：
    - 用户字段 `datetime` → 列类型 TIMESTAMPTZ（pg_type_map.FIELD_TYPE_TO_PG_TYPE）
    - 系统字段 `created_time` / `last_modified_time` → 映射到 `__created_at` / `__updated_at`，
      它们在 SYSTEM_COLUMNS 里都是 TIMESTAMPTZ
    其它（`date` 列、文本/数字等）一律返回 False；调用方按 DATE 列处理。
    """
    from apps.tabdata.native.pg_type_map import (
        FIELD_TYPE_TO_PG_TYPE, SYSTEM_COLUMN_FIELD_TYPES, SYSTEM_COLUMNS,
    )
    sys_col = SYSTEM_COLUMN_FIELD_TYPES.get(field.field_type)
    if sys_col:
        col_def = SYSTEM_COLUMNS.get(sys_col) or ''
        return 'TIMESTAMPTZ' in col_def.upper()
    return FIELD_TYPE_TO_PG_TYPE.get(field.field_type) == 'TIMESTAMPTZ'


def _local_date_sql(col_ref: str, field: TableField) -> Tuple[str, list]:
    """生成「将 native 列值截取为 settings.TIME_ZONE 本地日期」的 SQL 片段。

    - PG TIMESTAMPTZ 列（`datetime` 用户字段、`created_time` / `last_modified_time`
      系统字段）：必须 `AT TIME ZONE` 再 ::date，否则在 PG session=UTC 下会把
      4/9 +08 事件错算成 4/8。
    - 其它（PG DATE 列等）：直接 ::date 即可。

    返回 `(sql_fragment, params)`。⚠️ **TIMESTAMPTZ 分支返回值的 SQL 文本里
    内嵌了一个 `%s` 占位符（用于 TZ 名）**；当此片段被嵌入更大的 SQL 模板
    （例如 `f'{start_local_sql} <= %s'`），整段 SQL 的 `%s` 由「片段内嵌
    占位符」+「外层显式占位符」混合组成。调用方必须把 params 按**整段 SQL
    从左到右的 `%s` 出现顺序**严格交错拼接，**不能**先把外层显式参数堆到
    列表末尾——否则 TZ 字符串会被绑到日期/数值槽位，PG 会抛
    `time zone "..." not recognized` 或 `invalid input syntax for type date`。
    DATE 列分支的 params 为空，不会触发错位，但调用方仍要按片段出现位置
    交错（空块 `+ []` 占位）以保持模板可演进。
    """
    if _is_timestamptz_field(field):
        return f'({col_ref} AT TIME ZONE %s)::date', [settings.TIME_ZONE]
    return f'{col_ref}::date', []


def get_calendar_events_native(
    view, date_field, date_field_id_str, date_range,
    page, page_size, fields, field_key_type, filters, filter_logic,
    *, sorts: Optional[List[Dict[str, Any]]] = None,
    search: Optional[str] = None,
    search_field_ids: Optional[List[str]] = None,
    search_hide_not_match_rows: bool = False,
    rls_context=None,
    end_date_field: Optional[TableField] = None,
    end_date_field_id_str: Optional[str] = None,
) -> Tuple[List[Dict[str, Any]], int]:
    """走 PostgreSQL 原生列存储的日历查询路径。

    SQL 范围窗口（local_date(col) 表示「按 settings.TIME_ZONE 截取出的本地日期」）：
    - 未配 end_date_field：local_date(start) IN [query_start, query_end]
    - 已配 end_date_field：local_date(start) <= query_end
                           AND GREATEST(local_date(start), COALESCE(local_date(end), local_date(start))) >= query_start
      （COALESCE + GREATEST 同时覆盖 end 为 NULL 的单点退化和 end<start 的脏数据）

    时区：TIMESTAMPTZ 列用 `(col AT TIME ZONE settings.TIME_ZONE)::date`，
    DATE 列直接 `col::date`；详见 `_local_date_sql`。
    """
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

    date_col_ref = qb._resolve_column_ref(str(date_field.id))
    end_col_ref = qb._resolve_column_ref(str(end_date_field.id)) if end_date_field else None
    effective_sorts = sorts if sorts is not None else (view.sorts if view.sorts else None)
    order_by = qb.build_order_clause(effective_sorts) if effective_sorts else ('"__order" ASC, "__created_at" DESC', [])

    working_where = base_where
    query_start: Optional[date] = None
    query_end: Optional[date] = None
    if date_range:
        query_start, query_end = _parse_date_range(date_range)
        base_sql, base_params = base_where

        start_local_sql, start_local_params = _local_date_sql(date_col_ref, date_field)

        if end_col_ref and end_date_field is not None:
            end_local_sql, end_local_params = _local_date_sql(end_col_ref, end_date_field)
            # 关键点：用 GREATEST(start, end_or_start) 作为「事件实际占据的最后一天」，
            # 这样脏数据 end<start 也会被规范化为单点 start（与 _expand_occurrences
            # 的 Python 侧逻辑一致），不会漏掉只该当作 start 单点的脏数据。
            #
            # 时区：start_local_sql / end_local_sql 已按 settings.TIME_ZONE 截取本地日，
            # 与 query_start / query_end（来自 date_range，前端传的是本地日字符串）一致。
            range_sql = (
                f'({base_sql}) '
                f'AND {start_local_sql} <= %s '
                f'AND GREATEST('
                f'  {start_local_sql}, '
                f'  COALESCE({end_local_sql}, {start_local_sql})'
                f') >= %s'
            )
            # ⚠️ 参数顺序「严格交错」，与 SQL 模板里 %s 从左到右的出现顺序一一对应。
            # `_local_date_sql` 在 datetime/timestamptz 列上返回 `(col AT TIME ZONE %s)::date`，
            # 模板内嵌了 TZ 占位符；`date` 列上则返回 `col::date`、params 为空。
            # 改这段 SQL 时务必把所有 %s 按"从模板左到右"的顺序数清楚再拼参数，
            # 否则 query_end / query_start 会被绑到模板内嵌的 TZ 槽位，触发
            # `time zone "..." not recognized` 或 `invalid input syntax for date`。
            #
            # 模板占位符顺序：
            #   ① start_local_sql 内的 TZ          → start_local_params
            #   ② <= %s（query_end）              → [query_end.isoformat()]
            #   ③ GREATEST 第一项 start_local TZ  → start_local_params
            #   ④ COALESCE 第一参 end_local TZ    → end_local_params
            #   ⑤ COALESCE fallback start_local TZ → start_local_params
            #   ⑥ >= %s（query_start）            → [query_start.isoformat()]
            working_where = (
                range_sql,
                base_params
                + start_local_params                  # ①
                + [query_end.isoformat()]             # ②
                + start_local_params                  # ③
                + end_local_params                    # ④
                + start_local_params                  # ⑤
                + [query_start.isoformat()],          # ⑥
            )
        else:
            end_exclusive = query_end + timedelta(days=1)
            range_sql = (
                f'({base_sql}) '
                f'AND {start_local_sql} >= %s '
                f'AND {start_local_sql} < %s'
            )
            working_where = (
                range_sql,
                base_params
                + start_local_params
                + [query_start.isoformat()]
                + start_local_params
                + [end_exclusive.isoformat()],
            )

    total = native_io.count_records(where=working_where)
    start_offset = max(0, (page - 1) * page_size)

    rows, _ = native_io.read_records(
        qb, where=working_where, order_by=order_by,
        limit=page_size, offset=start_offset,
    )
    serialized_records = serialize_native_rows(
        rows, table.id, user_fields,
        field_key_type=field_key_type,
    )
    if fields is not None:
        serialized_records = filter_native_record_fields(
            serialized_records, fields,
            all_fields=all_fields, field_key_type=field_key_type,
        )

    events = _build_events_from_records(
        serialized_records,
        date_field_id_str=date_field_id_str,
        date_field_name=date_field.name,
        end_date_field_id_str=end_date_field_id_str,
        end_date_field_name=end_date_field.name if end_date_field else None,
        query_start=query_start,
        query_end=query_end,
    )

    return events, total


def _record_matches_search(
    record: TableRecord,
    candidate_fields: List[TableField],
    query_lower: str,
) -> bool:
    """ORM fallback 路径下检查单条 record 是否命中搜索词。

    与 native 路径 `build_native_search_where` 的语义保持一致：
    - 大小写不敏感的子串包含（native 用 `LIKE … ESCAPE '\\'` 把用户输入里的 % / _ 转义成
      字面量再前后包 `%`，与 Python `query in text` 按字面子串匹配等价）
    - 在 candidate_fields 中任一字段命中即视为匹配
    - 字段值按 `read_data(record)` 的 dict 取，候选 key 顺序与
      view_grid_service.get_grid_view_records_orm 的 `_extract_record_value` 对齐：
      field UUID → field.name → field.config['db_field_name']
    """
    data = read_data(record)
    for field in candidate_fields:
        value = None
        field_id = str(field.id)
        if field_id in data:
            value = data.get(field_id)
        elif field.name in data:
            value = data.get(field.name)
        else:
            config = field.config if isinstance(field.config, dict) else {}
            db_field_name = str(config.get('db_field_name') or '').strip()
            if db_field_name and db_field_name in data:
                value = data.get(db_field_name)
            else:
                continue
        from apps.tabdata.utils.searchable_cell_text import cell_text_matches_search_query

        # 与 native / search-index 一致：只匹配展示文本
        if cell_text_matches_search_query(query_lower, value):
            return True
    return False


def _resolve_search_candidate_fields(
    all_fields: List[TableField],
    search_field_ids: Optional[List[str]],
) -> Optional[List[TableField]]:
    """解析搜索目标字段集合，对齐 native `build_native_search_where` 的语义：

    - 显式 search_field_ids 全部都解析失败 → 返回 None，表示「无可用列」
      （native 在同条件下返回 SQL `FALSE`，等价于命中集合为空；ORM 调用方据此跳过整批 record）
    - 显式 search_field_ids 至少有一个有效 → 返回那批解析成功的字段（去重 + 保留顺序）
    - 未提供 search_field_ids → 返回全部字段，主键优先 + 按 order 升序 + UUID 兜底排序
    """
    if search_field_ids:
        id_map = {str(f.id): f for f in all_fields}
        name_map = {f.name: f for f in all_fields}
        resolved: List[TableField] = []
        seen_ids: Set[str] = set()
        for ref in search_field_ids:
            key = str(ref).strip()
            if not key:
                continue
            field = id_map.get(key) or name_map.get(key)
            if field and str(field.id) not in seen_ids:
                resolved.append(field)
                seen_ids.add(str(field.id))
        # 显式收窄但全无效：与 native 的 `('FALSE', [])` 对齐，命中集合为空
        return resolved or None
    return sorted(
        all_fields,
        key=lambda f: (
            0 if f.is_primary else 1,
            f.order if f.order is not None else 10 ** 6,
            str(f.id),
        ),
    )


def get_calendar_events_orm(
    queryset, date_field, date_field_keys, date_range,
    page, page_size, fields, field_key_type,
    *, sorts: Optional[List[Dict[str, Any]]] = None,
    view=None,
    end_date_field: Optional[TableField] = None,
    end_date_field_keys: Optional[List[str]] = None,
    search: Optional[str] = None,
    search_field_ids: Optional[List[str]] = None,
    search_hide_not_match_rows: bool = False,
) -> Tuple[List[Dict[str, Any]], int]:
    """ORM fallback：全量加载 + Python 范围重叠过滤。

    与 native 路径的 search 语义对齐：
    - 仅当 `search_hide_not_match_rows=True 且 search 非空白` 时执行过滤
    - 命中规则：在 search_field_ids（或全部字段）中任一字段子串匹配（大小写不敏感）
    - 过滤后的 total / 分页数与 native 行为保持一致，避免降级时搜索行为退化为全量
    """
    effective_sorts = sorts if sorts is not None else (view.sorts if view and view.sorts else None)
    if effective_sorts and view:
        from .view_group_sort_service import apply_view_sorts
        qs = apply_view_sorts(view, queryset, sorts_override=effective_sorts)
    else:
        qs = queryset.order_by('order', '-created_at')

    query_start, query_end = _parse_date_range(date_range)

    all_records = list(qs[:_ORM_FALLBACK_MAX_RECORDS])
    end_keys = end_date_field_keys or []

    normalized_search = (search or '').strip()
    search_active = bool(search_hide_not_match_rows and normalized_search)
    candidate_fields: List[TableField] = []
    query_lower = ''
    # search_active 但 search_field_ids 全无效时，candidate_fields 留空，
    # 下面的 record 循环会一刀切跳过——与 native FALSE WHERE 对齐
    candidates_empty = False
    if search_active:
        table_id = view.table_id if view else date_field.table_id
        all_table_fields = list(
            TableField.objects.using(TABDATA_DB_ALIAS).filter(
                table_id=table_id, is_deleted=False,
            )
        )
        resolved = _resolve_search_candidate_fields(
            all_table_fields, search_field_ids,
        )
        if resolved is None:
            candidates_empty = True
        else:
            candidate_fields = resolved
        query_lower = normalized_search.lower()

    filtered: List[TableRecord] = []

    for record in all_records:
        data = read_data(record)
        start_raw = None
        for key in date_field_keys:
            start_raw = data.get(key)
            if start_raw is not None:
                break
        start_d = _parse_iso_date(start_raw)
        if start_d is None:
            continue

        end_d: Optional[date] = None
        if end_date_field:
            end_raw = None
            for key in end_keys:
                end_raw = data.get(key)
                if end_raw is not None:
                    break
            end_d = _parse_iso_date(end_raw)

        # 脏数据 / 单点退化：用作范围过滤的「事件结束」取 max(end, start) 否则就是 start 本身
        effective_end = end_d if (end_d is not None and end_d >= start_d) else start_d

        if query_start and query_end:
            if start_d > query_end:
                continue
            if effective_end < query_start:
                continue

        if search_active:
            if candidates_empty:
                continue
            if not _record_matches_search(record, candidate_fields, query_lower):
                continue

        filtered.append(record)

    total = len(filtered)
    start_offset = max(0, (page - 1) * page_size)
    page_records = filtered[start_offset:start_offset + page_size]

    serialized = serialize_records(
        page_records, fields=fields,
        field_key_type=field_key_type,
    )
    events = _build_events_from_records(
        serialized,
        date_field_id_str=str(date_field.id),
        date_field_name=date_field.name,
        end_date_field_id_str=str(end_date_field.id) if end_date_field else None,
        end_date_field_name=end_date_field.name if end_date_field else None,
        query_start=query_start,
        query_end=query_end,
    )

    return events, total


def _build_events_from_records(
    serialized_records: List[Dict[str, Any]],
    *,
    date_field_id_str: str,
    date_field_name: Optional[str],
    end_date_field_id_str: Optional[str],
    end_date_field_name: Optional[str],
    query_start: Optional[date],
    query_end: Optional[date],
) -> List[Dict[str, Any]]:
    """把序列化好的 record 列表展开成 occurrence wrapper 列表。"""
    events: List[Dict[str, Any]] = []
    for record_data in serialized_records:
        start_raw = _read_record_field_value(
            record_data, date_field_id_str, date_field_name,
        )
        start_d = _parse_iso_date(start_raw)
        if start_d is None:
            continue

        end_d: Optional[date] = None
        if end_date_field_id_str:
            end_raw = _read_record_field_value(
                record_data, end_date_field_id_str, end_date_field_name,
            )
            end_d = _parse_iso_date(end_raw)

        events.extend(_expand_occurrences(
            record_data, start_d, end_d,
            query_start=query_start, query_end=query_end,
        ))
    return events
