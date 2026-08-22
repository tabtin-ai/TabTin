"""
视图过滤器服务

从 view_data_service.py 提取的过滤器相关逻辑，
提供模块级函数供 ViewDataService 和其他模块调用。
"""
import re
from typing import Dict, Any, Optional, List, Set, Tuple, Iterable
from datetime import date, datetime, time, timedelta
from calendar import monthrange
from functools import reduce
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from django.db.models import Q, QuerySet
from django.utils import timezone

from apps.tabdata.constants import TABDATA_DB_ALIAS
from apps.tabdata.models import TableView, TableField

import logging

from .view_constants import (
    MODEL_FIELDS,
    CHECKBOX_TRUE_VALUES,
    CHECKBOX_FALSE_VALUES,
    CHECKBOX_TRUE_STORAGE_STRINGS,
    CHECKBOX_FALSE_STORAGE_STRINGS,
    FILTER_OPERATOR_ALIASES,
    FILTER_NEGATIVE_OPERATOR_MAP,
)

_logger = logging.getLogger('tabdata.view_filter_service')

DATE_FILTER_FIELD_TYPES = frozenset({
    'date', 'created_time', 'last_modified_time',
})
DATE_FILTER_RANGE_MODES = frozenset({
    'today', 'yesterday', 'tomorrow',
    'thisWeek', 'lastWeek', 'nextWeek',
    'thisMonth', 'lastMonth', 'nextMonth',
    'thisYear', 'lastYear', 'nextYear',
    'pastDays', 'nextDays',
    'exactDate', 'dateRange',
})
DATE_FILTER_MODE_ALIASES = {mode.lower(): mode for mode in DATE_FILTER_RANGE_MODES}
DATE_FILTER_MODE_ALIASES.update({
    'this_week': 'thisWeek',
    'last_week': 'lastWeek',
    'next_week': 'nextWeek',
    'this_month': 'thisMonth',
    'last_month': 'lastMonth',
    'next_month': 'nextMonth',
    'this_year': 'thisYear',
    'last_year': 'lastYear',
    'next_year': 'nextYear',
    'past_days': 'pastDays',
    'next_days': 'nextDays',
    'exact_date': 'exactDate',
    'date_range': 'dateRange',
})
DATE_COMPARISON_OPERATORS = frozenset({
    'equals', 'not_equals', 'greater_than', 'greater_than_or_equals',
    'less_than', 'less_than_or_equals',
})


# ---------------------------------------------------------------------------
# 辅助函数
# ---------------------------------------------------------------------------

def parse_checkbox_state(value: Any) -> Optional[bool]:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if value == 1:
            return True
        if value == 0:
            return False
        return None
    if isinstance(value, str):
        normalized = value.strip().lower()
        if not normalized:
            return None
        if normalized in CHECKBOX_TRUE_VALUES:
            return True
        if normalized in CHECKBOX_FALSE_VALUES:
            return False
        return None
    if isinstance(value, list):
        if not value:
            return None
        states = [parse_checkbox_state(item) for item in value]
        bool_states = [state for state in states if state is not None]
        if True in bool_states:
            return True
        if bool_states:
            return False
        return None
    return None


def normalize_filter_operator(operator: Any) -> str:
    if not isinstance(operator, str):
        return ''
    normalized = operator.strip()
    if not normalized:
        return ''

    compact = normalized.replace('-', '_').replace(' ', '_').lower()
    direct = FILTER_OPERATOR_ALIASES.get(compact)
    if direct:
        return direct

    compact_no_underscore = compact.replace('_', '')
    direct = FILTER_OPERATOR_ALIASES.get(compact_no_underscore)
    if direct:
        return direct

    return compact


def get_field_maps(view: TableView) -> Tuple[Dict[str, TableField], Dict[str, TableField]]:
    fields = TableField.objects.using(TABDATA_DB_ALIAS).filter(
        table_id=view.table_id,
        is_deleted=False
    )
    id_map = {str(field.id): field for field in fields}
    name_map = {field.name: field for field in fields}
    return id_map, name_map


def _normalize_date_filter_value(field_meta: Optional[TableField], value: Any) -> Any:
    time_zone = resolve_field_time_zone_name(field_meta, value)
    if isinstance(value, dict):
        normalized = dict(value)
        normalized.setdefault('timeZone', time_zone)
        mode = normalized.get('mode')
        if isinstance(mode, str):
            normalized_mode = DATE_FILTER_MODE_ALIASES.get(mode.strip().lower())
            if normalized_mode:
                normalized['mode'] = normalized_mode
        for key in ('exactDate', 'exactDateEnd'):
            raw_date = normalized.get(key)
            if isinstance(raw_date, str):
                trimmed = raw_date.strip()
                if re.fullmatch(r'\d{4}-\d{2}-\d{2}', trimmed[:10]):
                    normalized[key] = trimmed[:10]
        return normalized

    if not isinstance(value, str):
        return value

    trimmed = value.strip()
    if not trimmed:
        return value

    preset_mode = DATE_FILTER_MODE_ALIASES.get(trimmed.lower())
    if preset_mode:
        if preset_mode in {'exactDate', 'dateRange'}:
            return {'mode': preset_mode, 'timeZone': time_zone}
        return {'mode': preset_mode, 'timeZone': time_zone}

    if re.fullmatch(r'\d{4}-\d{2}-\d{2}', trimmed[:10]):
        return {
            'mode': 'exactDate',
            'exactDate': trimmed[:10],
            'timeZone': time_zone,
        }

    try:
        parsed = datetime.fromisoformat(trimmed.replace('Z', '+00:00'))
    except ValueError:
        return value

    if parsed.tzinfo is None:
        try:
            field_tz = ZoneInfo(time_zone)
        except (KeyError, ZoneInfoNotFoundError):
            field_tz = ZoneInfo('UTC')
        parsed = parsed.replace(tzinfo=field_tz)
    else:
        parsed = parsed.astimezone(ZoneInfo(time_zone))

    return {
        'mode': 'exactDate',
        'exactDate': parsed.date().isoformat(),
        'timeZone': time_zone,
    }


def normalize_filter_value(field_meta: Optional[TableField], value: Any) -> Any:
    if value is None:
        return None

    if field_meta:
        field_type = field_meta.field_type
        if field_type in DATE_FILTER_FIELD_TYPES:
            return _normalize_date_filter_value(field_meta, value)
        if field_type in ['checkbox', 'boolean']:
            if isinstance(value, bool):
                return value
            if isinstance(value, str):
                return value.strip().lower() in ('true', '1', 'yes', 'y')
        if field_type in ('number', 'percent', 'currency', 'rating'):
            # UI 筛选输入常为字符串；rating 单元格存 int，需归一否则 JSON equals 失败
            as_int = field_type == 'rating'
            if isinstance(value, bool):
                pass
            elif isinstance(value, (int, float)):
                return int(value) if as_int else value
            elif isinstance(value, str):
                try:
                    parsed = float(value)
                    return int(parsed) if as_int else parsed
                except ValueError:
                    return value
        if field_type == 'multi_select':
            if isinstance(value, str):
                items = [item.strip() for item in value.split(',') if item.strip()]
                return items
            if isinstance(value, list):
                normalized = []
                for item in value:
                    if isinstance(item, dict):
                        normalized.append(item.get('value') or item.get('label') or item.get('name') or str(item))
                    else:
                        normalized.append(str(item))
                return normalized
        if field_type in ['select', 'single_select']:
            if isinstance(value, dict):
                return value.get('value') or value.get('label') or value.get('name') or str(value)

    if isinstance(value, list):
        normalized = []
        for item in value:
            if isinstance(item, dict):
                normalized.append(item.get('value') or item.get('label') or item.get('name') or str(item))
            else:
                normalized.append(item)
        return normalized

    return value


def normalize_filters(view: TableView, filters: Optional[List[Dict[str, Any]]]) -> List[Dict[str, Any]]:
    if not filters:
        return []

    id_map, name_map = get_field_maps(view)
    normalized: List[Dict[str, Any]] = []

    for rule in filters:
        if not isinstance(rule, dict):
            continue
        if rule.get('enabled') is False:
            continue

        field_ref = rule.get('field_id') or rule.get('field')
        operator = normalize_filter_operator(rule.get('operator'))
        if not field_ref or not operator:
            continue

        field_key = str(field_ref)
        field_meta = id_map.get(field_key) or name_map.get(field_key)
        if field_meta:
            field_names = [str(field_meta.id), field_meta.name]
        else:
            field_names = [field_key]
        normalized.append({
            'field_names': list(dict.fromkeys(field_names)),
            'field_meta': field_meta,
            'operator': operator,
            'value': normalize_filter_value(field_meta, rule.get('value')),
        })

    return normalized


def split_field_path(field_name: str) -> Tuple[str, str, str]:
    parts = field_name.split('.')
    data_lookup = 'data__' + '__'.join(parts)
    if len(parts) == 1:
        return data_lookup, 'data', parts[0]
    parent_lookup = 'data__' + '__'.join(parts[:-1])
    return data_lookup, parent_lookup, parts[-1]


def is_boolean_field(field_meta: Optional[TableField]) -> bool:
    return bool(field_meta and field_meta.field_type in {'checkbox', 'boolean'})


def is_boolean_unchecked_filter(operator: str, value: Any, field_meta: Optional[TableField]) -> bool:
    if operator != 'equals' or not is_boolean_field(field_meta):
        return False
    if value is None:
        return True
    return parse_checkbox_state(value) is False


def resolve_date_filter_range(value: dict) -> Tuple[datetime, datetime]:
    """
    将前端 DateFilterValue 解析为 UTC 时间区间 [start, end]。

    value 结构：
    {
        "mode": "today" | "yesterday" | "tomorrow" |
                "thisWeek" | "lastWeek" | "nextWeek" |
                "thisMonth" | "lastMonth" | "nextMonth" |
                "thisYear" | "lastYear" | "nextYear" |
                "pastDays" | "nextDays" |
                "exactDate" | "dateRange",
        "numberOfDays": int,          // pastDays / nextDays 专用
        "exactDate": str,             // ISO 格式日期
        "exactDateEnd": str,          // ISO 格式日期（dateRange 专用）
        "timeZone": str               // 如 "Asia/Shanghai"
    }

    周的起始日为周一，边界精确到微秒（23:59:59.999999）。
    """
    mode = value.get('mode')
    if not mode:
        raise ValueError("DateFilterValue 缺少 mode 字段")

    tz_name = value.get('timeZone') or 'UTC'
    try:
        tz = ZoneInfo(tz_name)
    except (KeyError, ZoneInfoNotFoundError):
        tz = ZoneInfo('UTC')

    now_local = datetime.now(tz)
    today = now_local.date()

    end_of_day = time(23, 59, 59, 999999)

    def _day_range(d):
        start = datetime.combine(d, time.min, tzinfo=tz)
        end = datetime.combine(d, end_of_day, tzinfo=tz)
        return start.astimezone(ZoneInfo('UTC')), end.astimezone(ZoneInfo('UTC'))

    if mode == 'today':
        return _day_range(today)

    if mode == 'yesterday':
        return _day_range(today - timedelta(days=1))

    if mode == 'tomorrow':
        return _day_range(today + timedelta(days=1))

    if mode == 'thisWeek':
        monday = today - timedelta(days=today.weekday())
        sunday = monday + timedelta(days=6)
        return (
            datetime.combine(monday, time.min, tzinfo=tz).astimezone(ZoneInfo('UTC')),
            datetime.combine(sunday, end_of_day, tzinfo=tz).astimezone(ZoneInfo('UTC')),
        )

    if mode == 'lastWeek':
        monday = today - timedelta(days=today.weekday() + 7)
        sunday = monday + timedelta(days=6)
        return (
            datetime.combine(monday, time.min, tzinfo=tz).astimezone(ZoneInfo('UTC')),
            datetime.combine(sunday, end_of_day, tzinfo=tz).astimezone(ZoneInfo('UTC')),
        )

    if mode == 'nextWeek':
        monday = today + timedelta(days=(7 - today.weekday()))
        sunday = monday + timedelta(days=6)
        return (
            datetime.combine(monday, time.min, tzinfo=tz).astimezone(ZoneInfo('UTC')),
            datetime.combine(sunday, end_of_day, tzinfo=tz).astimezone(ZoneInfo('UTC')),
        )

    if mode == 'thisMonth':
        first = today.replace(day=1)
        _, last_day = monthrange(today.year, today.month)
        last = today.replace(day=last_day)
        return (
            datetime.combine(first, time.min, tzinfo=tz).astimezone(ZoneInfo('UTC')),
            datetime.combine(last, end_of_day, tzinfo=tz).astimezone(ZoneInfo('UTC')),
        )

    if mode == 'lastMonth':
        first_this = today.replace(day=1)
        last_prev = first_this - timedelta(days=1)
        first_prev = last_prev.replace(day=1)
        return (
            datetime.combine(first_prev, time.min, tzinfo=tz).astimezone(ZoneInfo('UTC')),
            datetime.combine(last_prev, end_of_day, tzinfo=tz).astimezone(ZoneInfo('UTC')),
        )

    if mode == 'nextMonth':
        _, last_day = monthrange(today.year, today.month)
        first_next_month = today.replace(day=last_day) + timedelta(days=1)
        _, next_last_day = monthrange(first_next_month.year, first_next_month.month)
        last_next = first_next_month.replace(day=next_last_day)
        return (
            datetime.combine(first_next_month, time.min, tzinfo=tz).astimezone(ZoneInfo('UTC')),
            datetime.combine(last_next, end_of_day, tzinfo=tz).astimezone(ZoneInfo('UTC')),
        )

    if mode == 'thisYear':
        from datetime import date as _date
        first = _date(today.year, 1, 1)
        last = _date(today.year, 12, 31)
        return (
            datetime.combine(first, time.min, tzinfo=tz).astimezone(ZoneInfo('UTC')),
            datetime.combine(last, end_of_day, tzinfo=tz).astimezone(ZoneInfo('UTC')),
        )

    if mode == 'lastYear':
        from datetime import date as _date
        first = _date(today.year - 1, 1, 1)
        last = _date(today.year - 1, 12, 31)
        return (
            datetime.combine(first, time.min, tzinfo=tz).astimezone(ZoneInfo('UTC')),
            datetime.combine(last, end_of_day, tzinfo=tz).astimezone(ZoneInfo('UTC')),
        )

    if mode == 'nextYear':
        from datetime import date as _date
        first = _date(today.year + 1, 1, 1)
        last = _date(today.year + 1, 12, 31)
        return (
            datetime.combine(first, time.min, tzinfo=tz).astimezone(ZoneInfo('UTC')),
            datetime.combine(last, end_of_day, tzinfo=tz).astimezone(ZoneInfo('UTC')),
        )

    if mode == 'pastDays':
        raw_n = value.get('numberOfDays')
        if not isinstance(raw_n, (int, float, str)):
            raw_n = 1
        try:
            n = min(max(1, int(raw_n) if raw_n else 1), 365)
        except (ValueError, TypeError):
            n = 1
        start_date = today - timedelta(days=n)
        return (
            datetime.combine(start_date, time.min, tzinfo=tz).astimezone(ZoneInfo('UTC')),
            datetime.combine(today, end_of_day, tzinfo=tz).astimezone(ZoneInfo('UTC')),
        )

    if mode == 'nextDays':
        raw_n = value.get('numberOfDays')
        if not isinstance(raw_n, (int, float, str)):
            raw_n = 1
        try:
            n = min(max(1, int(raw_n) if raw_n else 1), 365)
        except (ValueError, TypeError):
            n = 1
        end_date = today + timedelta(days=n)
        return (
            datetime.combine(today, time.min, tzinfo=tz).astimezone(ZoneInfo('UTC')),
            datetime.combine(end_date, end_of_day, tzinfo=tz).astimezone(ZoneInfo('UTC')),
        )

    _date_re = re.compile(r'^\d{4}-\d{2}-\d{2}')

    if mode == 'exactDate':
        from datetime import date as _date
        raw = value.get('exactDate')
        if not raw:
            raise ValueError("exactDate mode 需要 exactDate 字段")
        if not _date_re.match(str(raw)):
            raise ValueError(f"exactDate 格式无效: {raw!r}，需要 YYYY-MM-DD")
        try:
            d = _date.fromisoformat(str(raw)[:10])
        except ValueError as exc:
            raise ValueError(f"日期格式无效: {str(raw)[:10]}，需要合法的 YYYY-MM-DD 日期") from exc
        return _day_range(d)

    if mode == 'dateRange':
        from datetime import date as _date
        raw_start = value.get('exactDate')
        raw_end = value.get('exactDateEnd')
        if not raw_start or not raw_end:
            raise ValueError("dateRange mode 需要 exactDate 和 exactDateEnd 字段")
        for label, raw in [('exactDate', raw_start), ('exactDateEnd', raw_end)]:
            if not _date_re.match(str(raw)):
                raise ValueError(f"{label} 格式无效: {raw!r}，需要 YYYY-MM-DD")
        try:
            d_start = _date.fromisoformat(str(raw_start)[:10])
            d_end = _date.fromisoformat(str(raw_end)[:10])
        except ValueError as exc:
            raise ValueError(f"日期范围包含无效日期: {str(raw_start)[:10]} ~ {str(raw_end)[:10]}") from exc
        if d_end < d_start:
            d_start, d_end = d_end, d_start
        return (
            datetime.combine(d_start, time.min, tzinfo=tz).astimezone(ZoneInfo('UTC')),
            datetime.combine(d_end, end_of_day, tzinfo=tz).astimezone(ZoneInfo('UTC')),
        )

    raise ValueError(f"不支持的 DateFilterValue mode: {mode}")


def resolve_field_time_zone_name(
    field_meta: Optional[TableField],
    value: Any = None,
) -> str:
    config = field_meta.config if field_meta and isinstance(field_meta.config, dict) else {}
    formatting = config.get('formatting')
    time_zone = (
        value.get('timeZone')
        if isinstance(value, dict)
        else None
    ) or (
        formatting.get('timeZone')
        if isinstance(formatting, dict)
        else None
    ) or 'UTC'
    try:
        ZoneInfo(time_zone)
    except (KeyError, ZoneInfoNotFoundError):
        return 'UTC'
    return time_zone


def coerce_date_filter_range_value(
    value: Any,
    field_meta: Optional[TableField] = None,
) -> Optional[Dict[str, Any]]:
    time_zone = resolve_field_time_zone_name(field_meta, value)
    if isinstance(value, dict):
        filter_value = dict(value)
        filter_value.setdefault('timeZone', time_zone)
        return filter_value
    if isinstance(value, str):
        mode = DATE_FILTER_MODE_ALIASES.get(value.strip().lower())
        if mode and mode not in {'exactDate', 'dateRange'}:
            return {'mode': mode, 'timeZone': time_zone}
    return None


def resolve_date_comparison_range(
    value: Any,
    field_meta: Optional[TableField],
) -> Optional[Tuple[Optional[str], datetime, datetime]]:
    """把日期比较值归一为字段展示时区内的整日范围。

    兼容新客户端写入的语义日期对象，也兼容旧客户端写入的 ``YYYY-MM-DD``
    或字段格式 ISO 日期时间。返回值中的日期字符串用于兼容历史 JSON 日期值。
    """
    if not field_meta or field_meta.field_type not in DATE_FILTER_FIELD_TYPES:
        return None

    time_zone = resolve_field_time_zone_name(field_meta)
    try:
        field_tz = ZoneInfo(time_zone)
    except (KeyError, ZoneInfoNotFoundError):
        time_zone = 'UTC'
        field_tz = ZoneInfo('UTC')

    filter_value = coerce_date_filter_range_value(value, field_meta)
    if filter_value is not None:
        try:
            start, end = resolve_date_filter_range(filter_value)
        except ValueError:
            return None

        selected_date: Optional[str] = None
        mode = filter_value.get('mode')
        if mode == 'exactDate':
            raw_exact = filter_value.get('exactDate')
            if isinstance(raw_exact, str) and re.fullmatch(r'\d{4}-\d{2}-\d{2}', raw_exact[:10]):
                selected_date = raw_exact[:10]
        elif mode in ('today', 'yesterday', 'tomorrow'):
            selected_date = start.astimezone(field_tz).date().isoformat()
        return selected_date, start, end

    if not isinstance(value, str) or not value.strip():
        return None

    raw_value = value.strip()
    if re.fullmatch(r'\d{4}-\d{2}-\d{2}', raw_value):
        try:
            selected_date = date.fromisoformat(raw_value)
        except ValueError:
            return None
    else:
        try:
            selected_datetime = datetime.fromisoformat(
                raw_value.replace('Z', '+00:00')
            )
        except ValueError:
            return None
        if selected_datetime.tzinfo is None:
            selected_datetime = selected_datetime.replace(tzinfo=field_tz)
        else:
            selected_datetime = selected_datetime.astimezone(field_tz)
        selected_date = selected_datetime.date()

    start, end = resolve_date_filter_range({
        'mode': 'exactDate',
        'exactDate': selected_date.isoformat(),
        'timeZone': time_zone,
    })
    return selected_date.isoformat(), start, end


def build_date_comparison_q(
    lookup_base: str,
    operator: str,
    value: Any,
    field_meta: Optional[TableField],
) -> Optional[Q]:
    """构建面向人的日期比较：等于某日，而不是等于某一秒。"""
    if operator not in DATE_COMPARISON_OPERATORS:
        return None
    resolved = resolve_date_comparison_range(value, field_meta)
    if resolved is None:
        return None

    selected_date, start, end = resolved
    field_type = field_meta.field_type if field_meta else ''
    config = field_meta.config if field_meta and isinstance(field_meta.config, dict) else {}
    formatting = config.get('formatting')
    time_format = formatting.get('time') if isinstance(formatting, dict) else None
    stores_date_only = field_type == 'date' and time_format in (None, 'None')
    comparison_time_zone = (
        value.get('timeZone')
        if isinstance(value, dict)
        else None
    ) or (
        formatting.get('timeZone')
        if isinstance(formatting, dict)
        else None
    ) or 'UTC'
    try:
        comparison_tz = ZoneInfo(comparison_time_zone)
    except (KeyError, ZoneInfoNotFoundError):
        comparison_tz = ZoneInfo('UTC')
    start_date = start.astimezone(comparison_tz).date().isoformat()
    end_date = end.astimezone(comparison_tz).date().isoformat()

    if stores_date_only:
        if operator == 'equals':
            return (
                Q(**{f'{lookup_base}__gte': start_date}) &
                Q(**{f'{lookup_base}__lte': end_date})
            )
        if operator == 'not_equals':
            return (
                Q(**{f'{lookup_base}__lt': start_date}) |
                Q(**{f'{lookup_base}__gt': end_date}) |
                Q(**{f'{lookup_base}__isnull': True})
            )
        lookup = {
            'greater_than': f'{lookup_base}__gt',
            'greater_than_or_equals': f'{lookup_base}__gte',
            'less_than': f'{lookup_base}__lt',
            'less_than_or_equals': f'{lookup_base}__lte',
        }[operator]
        compare_value = {
            'greater_than': end_date,
            'greater_than_or_equals': start_date,
            'less_than': start_date,
            'less_than_or_equals': end_date,
        }[operator]
        return Q(**{lookup: compare_value})

    is_model_datetime = lookup_base in MODEL_FIELDS
    exact_date_q = Q(pk__in=[])
    if selected_date and not is_model_datetime:
        # date 字段在关闭时间显示时可能存 YYYY-MM-DD。
        exact_date_q = Q(**{lookup_base: selected_date})

    if is_model_datetime:
        range_start: Any = start
        range_end: Any = end
        range_end_lookup = 'lte'
        after_day_lookup = 'gt'
    else:
        # JSONField 参数必须是 JSON 可序列化值；统一用 UTC ISO 字符串，
        # 并采用半开区间避开毫秒/微秒精度差异。
        range_start = start.isoformat(timespec='microseconds').replace('+00:00', 'Z')
        range_end = (end + timedelta(microseconds=1)).isoformat(
            timespec='microseconds'
        ).replace('+00:00', 'Z')
        range_end_lookup = 'lt'
        after_day_lookup = 'gte'

    if operator == 'equals':
        return exact_date_q | (
            Q(**{f'{lookup_base}__gte': range_start}) &
            Q(**{f'{lookup_base}__{range_end_lookup}': range_end})
        )
    if operator == 'not_equals':
        return ~exact_date_q & (
            Q(**{f'{lookup_base}__lt': range_start}) |
            Q(**{f'{lookup_base}__{after_day_lookup}': range_end}) |
            Q(**{f'{lookup_base}__isnull': True})
        )
    if operator == 'greater_than':
        return Q(**{f'{lookup_base}__{after_day_lookup}': range_end})
    if operator == 'greater_than_or_equals':
        return exact_date_q | Q(**{f'{lookup_base}__gte': range_start})
    if operator == 'less_than':
        return ~exact_date_q & Q(**{f'{lookup_base}__lt': range_start})
    return exact_date_q | Q(**{f'{lookup_base}__{range_end_lookup}': range_end})


# ---------------------------------------------------------------------------
# Q 对象构建
# ---------------------------------------------------------------------------

def build_boolean_checked_q(
    field_name: str,
    lookup_base: str,
) -> Q:
    if field_name in MODEL_FIELDS:
        return Q(**{field_name: True})
    return (
        Q(**{lookup_base: True}) |
        Q(**{lookup_base: 1}) |
        Q(**{f'{lookup_base}__in': list(CHECKBOX_TRUE_STORAGE_STRINGS)})
    )


def build_boolean_unchecked_q(
    field_name: str,
    lookup_base: str,
    data_lookup: str,
    parent_lookup: str,
    last_key: str,
) -> Q:
    if field_name in MODEL_FIELDS:
        return Q(**{f'{field_name}__isnull': True}) | Q(**{field_name: False})

    # JSON 显式 null 需要通过 contains 命中；仅靠 path = None 在 PostgreSQL 下不稳定。
    json_null_q = (
        Q(**{f'{parent_lookup}__contains': {last_key: None}})
        if parent_lookup == 'data'
        else Q(**{lookup_base: None})
    )

    return (
        Q(**{f'{data_lookup}__isnull': True}) |
        json_null_q |
        Q(**{lookup_base: False}) |
        Q(**{lookup_base: 0}) |
        Q(**{f'{lookup_base}__in': list(CHECKBOX_FALSE_STORAGE_STRINGS)}) |
        ~Q(**{f'{parent_lookup}__has_key': last_key})
    )


def build_alias_presence_q(field_name: str) -> Q:
    if field_name in MODEL_FIELDS:
        return Q()
    _, parent_lookup, last_key = split_field_path(field_name)
    return Q(**{f'{parent_lookup}__has_key': last_key})


def build_boolean_alias_fallback_q(
    field_names: List[str],
    operator: str,
    value: Any,
    field_meta: TableField,
) -> Optional[Q]:
    canonical_field_name = str(field_meta.id)
    if canonical_field_name not in field_names:
        return None

    primary_q = build_single_filter_q(
        canonical_field_name,
        operator,
        value,
        field_meta=field_meta
    )
    alias_names = [name for name in field_names if name != canonical_field_name]
    is_unchecked = is_boolean_unchecked_filter(operator, value, field_meta)
    alias_q_objects: List[Q] = []
    for alias_name in alias_names:
        alias_q = build_single_filter_q(alias_name, operator, value, field_meta=field_meta)
        if alias_q is not None:
            if alias_name in MODEL_FIELDS or is_unchecked:
                alias_q_objects.append(alias_q)
            else:
                alias_q_objects.append(build_alias_presence_q(alias_name) & alias_q)

    alias_q = reduce(lambda a, b: a | b, alias_q_objects) if alias_q_objects else Q(pk__in=[])
    if primary_q is None:
        return alias_q

    primary_has_key_q = build_alias_presence_q(canonical_field_name)
    return (primary_has_key_q & primary_q) | (~primary_has_key_q & alias_q)


def build_single_filter_q(
    field_name: str,
    operator: str,
    value: Any,
    field_meta: Optional[TableField] = None
) -> Optional[Q]:
    op = normalize_filter_operator(operator)
    data_lookup, parent_lookup, last_key = split_field_path(field_name)
    lookup_base = field_name if field_name in MODEL_FIELDS else data_lookup

    _SYSTEM_TIME_TO_MODEL = {
        'created_time': 'created_at',
        'last_modified_time': 'updated_at',
    }
    _ft = getattr(field_meta, 'field_type', None) if field_meta else None
    _model_col = _SYSTEM_TIME_TO_MODEL.get(_ft) if _ft else None
    if _model_col:
        lookup_base = _model_col

    date_comparison_q = build_date_comparison_q(
        lookup_base,
        op,
        value,
        field_meta,
    )
    if date_comparison_q is not None:
        return date_comparison_q

    if op == 'equals':
        if is_boolean_field(field_meta):
            checkbox_state = parse_checkbox_state(value)
            if checkbox_state is True:
                return build_boolean_checked_q(field_name, lookup_base)
            if checkbox_state is False or value is None:
                return build_boolean_unchecked_q(
                    field_name=field_name,
                    lookup_base=lookup_base,
                    data_lookup=data_lookup,
                    parent_lookup=parent_lookup,
                    last_key=last_key,
                )
        if isinstance(value, list):
            return Q(**{f'{lookup_base}__contains': value})
        # Django JSONField: Q(field=None) 生成 "= NULL"（永远不匹配），
        # 必须使用 __isnull=True 才能正确匹配 NULL / 缺失值。
        if value is None:
            if field_name in MODEL_FIELDS or lookup_base in MODEL_FIELDS:
                _col = lookup_base if lookup_base in MODEL_FIELDS else field_name
                return Q(**{f'{_col}__isnull': True})
            return (
                Q(**{f'{data_lookup}__isnull': True}) |
                ~Q(**{f'{parent_lookup}__has_key': last_key})
            )
        return Q(**{lookup_base: value})

    if op == 'contains':
        if isinstance(value, dict):
            q = Q()
            for key, val in value.items():
                q &= Q(**{f'{data_lookup}__{key}': val})
            return q
        if isinstance(value, list):
            q = Q()
            for item in value:
                q |= Q(**{f'{lookup_base}__contains': [item]})
            return q
        if isinstance(value, str):
            return Q(**{f'{lookup_base}__icontains': value})
        return Q(**{lookup_base: value})

    if op == 'has_any_of':
        if isinstance(value, list) and value:
            q = Q()
            for item in value:
                q |= Q(**{f'{lookup_base}__contains': [item]})
            return q
        if value is None or value == '':
            return None
        return Q(**{f'{lookup_base}__contains': [value]})

    if op == 'has_all_of':
        if isinstance(value, list) and value:
            return Q(**{f'{lookup_base}__contains': value})
        if value is None or value == '':
            return None
        return Q(**{f'{lookup_base}__contains': [value]})

    if op == 'is_exactly':
        if isinstance(value, list):
            return (
                Q(**{f'{lookup_base}__contains': value}) &
                Q(**{f'{lookup_base}__contained_by': value})
            )
        return Q(**{lookup_base: value})

    if op == 'is_empty':
        if field_name in MODEL_FIELDS or lookup_base in MODEL_FIELDS:
            _col = lookup_base if lookup_base in MODEL_FIELDS else field_name
            return Q(**{f'{_col}__isnull': True}) | Q(**{_col: ''})

        return (
            Q(**{f'{data_lookup}__isnull': True}) |
            Q(**{f'{data_lookup}': ''}) |
            Q(**{f'{data_lookup}': []}) |
            ~Q(**{f'{parent_lookup}__has_key': last_key})
        )

    if op == 'is_not_empty':
        if field_name in MODEL_FIELDS or lookup_base in MODEL_FIELDS:
            _col = lookup_base if lookup_base in MODEL_FIELDS else field_name
            return ~Q(**{f'{_col}__isnull': True}) & ~Q(**{_col: ''})

        return (
            Q(**{f'{parent_lookup}__has_key': last_key}) &
            ~Q(**{f'{data_lookup}__isnull': True}) &
            ~Q(**{f'{data_lookup}': ''}) &
            ~Q(**{f'{data_lookup}': []})
        )

    if op == 'greater_than':
        return Q(**{f'{lookup_base}__gt': value})

    if op == 'greater_than_or_equals':
        return Q(**{f'{lookup_base}__gte': value})

    if op == 'less_than':
        return Q(**{f'{lookup_base}__lt': value})

    if op == 'less_than_or_equals':
        return Q(**{f'{lookup_base}__lte': value})

    if op == 'in':
        if isinstance(value, list) and value:
            q = Q()
            for item in value:
                q |= Q(**{lookup_base: item})
            return q
        return None

    if op == 'is_within':
        range_value = coerce_date_filter_range_value(value, field_meta)
        if range_value is None:
            return None
        try:
            start, end = resolve_date_filter_range(range_value)
        except ValueError as exc:
            field_id = getattr(field_meta, 'id', None) if field_meta else None
            field_name_dbg = getattr(field_meta, 'name', None) if field_meta else None
            mode = range_value.get('mode')
            _logger.warning(
                'is_within: 无法解析日期范围 field_id=%s field_name=%s mode=%s value=%s error=%s',
                field_id, field_name_dbg, mode, range_value, exc,
            )
            return None
        field_type = getattr(field_meta, 'field_type', None) if field_meta else None
        config = field_meta.config if field_meta and isinstance(field_meta.config, dict) else {}
        formatting = config.get('formatting')
        time_format = formatting.get('time') if isinstance(formatting, dict) else None
        if field_type == 'date' and time_format in (None, 'None'):
            tz_name = resolve_field_time_zone_name(field_meta, range_value)
            try:
                date_tz = ZoneInfo(tz_name)
            except (KeyError, ZoneInfoNotFoundError):
                date_tz = ZoneInfo('UTC')
            start_value: Any = start.astimezone(date_tz).date().isoformat()
            end_value: Any = end.astimezone(date_tz).date().isoformat()
            return (
                Q(**{f'{lookup_base}__gte': start_value}) &
                Q(**{f'{lookup_base}__lte': end_value})
            )
        if lookup_base in MODEL_FIELDS:
            return (
                Q(**{f'{lookup_base}__gte': start}) &
                Q(**{f'{lookup_base}__lte': end})
            )
        start_value = start.isoformat(timespec='microseconds').replace('+00:00', 'Z')
        end_value = (end + timedelta(microseconds=1)).isoformat(
            timespec='microseconds'
        ).replace('+00:00', 'Z')
        return (
            Q(**{f'{lookup_base}__gte': start_value}) &
            Q(**{f'{lookup_base}__lt': end_value})
        )

    return None


def build_filter_q(
    field_names: Iterable[str],
    operator: str,
    value: Any,
    field_meta: Optional[TableField] = None
) -> Optional[Q]:
    op = normalize_filter_operator(operator)
    if not op:
        return None
    negative_ops = set(FILTER_NEGATIVE_OPERATOR_MAP.keys())
    base_op = FILTER_NEGATIVE_OPERATOR_MAP.get(op, op)

    normalized_field_names: List[str] = []
    for name in field_names:
        if name is None:
            continue
        normalized_name = str(name)
        if not normalized_name:
            continue
        normalized_field_names.append(normalized_name)
    if (
        field_meta is not None and
        len(normalized_field_names) > 1 and
        str(field_meta.id) in normalized_field_names
    ):
        alias_fallback_q = build_boolean_alias_fallback_q(
            normalized_field_names,
            base_op,
            value,
            field_meta
        )
        if alias_fallback_q is not None:
            return ~alias_fallback_q if op in negative_ops else alias_fallback_q

    q_objects: List[Q] = []
    for field_name in normalized_field_names:
        q = build_single_filter_q(field_name, base_op, value, field_meta=field_meta)
        if q is not None:
            q_objects.append(q)

    if not q_objects:
        return None

    if base_op == 'is_empty' or is_boolean_unchecked_filter(base_op, value, field_meta):
        combined = reduce(lambda a, b: a & b, q_objects)
    else:
        combined = reduce(lambda a, b: a | b, q_objects)

    if op in negative_ops:
        return ~combined

    return combined


# ---------------------------------------------------------------------------
# 嵌套过滤器支持
# ---------------------------------------------------------------------------

def is_nested_filter(obj: Any) -> bool:
    """判断是否为嵌套 FilterSet 结构"""
    return isinstance(obj, dict) and 'conjunction' in obj and 'filterSet' in obj


def build_filter_set_q(
    view: TableView,
    filter_set: Dict[str, Any],
) -> Optional[Q]:
    """
    递归构建嵌套 FilterSet 的 Q 对象。

    filter_set 结构:
    {
        "conjunction": "and" | "or",
        "filterSet": [
            {"field_id": "...", "operator": "...", "value": ...},  # FilterItem
            {"conjunction": "...", "filterSet": [...]},            # 嵌套 FilterSet
        ]
    }
    """
    conjunction = (filter_set.get('conjunction') or 'and').strip().lower()
    items = filter_set.get('filterSet')
    if not isinstance(items, list) or not items:
        return None

    id_map, name_map = get_field_maps(view)
    q_objects: List[Q] = []

    for item in items:
        if not isinstance(item, dict):
            continue

        if is_nested_filter(item):
            sub_q = build_filter_set_q(view, item)
            if sub_q is not None:
                q_objects.append(sub_q)
        else:
            if item.get('enabled') is False:
                continue
            field_ref = item.get('field_id') or item.get('field')
            operator = normalize_filter_operator(item.get('operator'))
            if not field_ref or not operator:
                continue

            field_key = str(field_ref)
            field_meta = id_map.get(field_key) or name_map.get(field_key)
            if field_meta:
                field_names = [str(field_meta.id), field_meta.name]
            else:
                field_names = [field_key]
            field_names = list(dict.fromkeys(field_names))

            value = normalize_filter_value(field_meta, item.get('value'))
            q = build_filter_q(field_names, operator, value, field_meta=field_meta)
            if q is not None:
                q_objects.append(q)

    if not q_objects:
        return None

    use_or = conjunction == 'or'
    return reduce((lambda a, b: a | b) if use_or else (lambda a, b: a & b), q_objects)


def resolve_effective_filter(
    view: TableView,
    filters: Optional[Any],
    filter_logic: Optional[str],
) -> Optional[Dict]:
    """
    从 API 参数 + 视图配置中解析出有效的 FilterSet（嵌套格式）。

    与 apply_view_filters 逻辑一致但只返回 dict，不构建 Q 对象。
    """
    if filters is not None:
        if is_nested_filter(filters):
            return filters
        if isinstance(filters, list) and filters:
            logic = (filter_logic or 'and').strip().lower()
            return {'conjunction': logic, 'filterSet': filters}
    else:
        view_filter = getattr(view, 'filter', None) if hasattr(view, 'filter') else None
        if view_filter and is_nested_filter(view_filter):
            return view_filter
        if view.filters:
            logic = ((view.config or {}).get('filter_logic') or 'and').strip().lower()
            return {'conjunction': logic, 'filterSet': view.filters}

    return None


def apply_view_filters(
    view: TableView,
    queryset: QuerySet,
    filters: Optional[Any] = None,
    filter_logic: Optional[str] = None
) -> QuerySet:
    """
    应用视图的过滤条件。

    支持两种格式：
    1. 嵌套 FilterSet：{"conjunction": "and", "filterSet": [...]}
    2. 旧版扁平数组：[{field_id, operator, value, enabled}, ...]

    优先读取嵌套格式；扁平数组 + filter_logic 会被自动包装为 FilterSet。
    """
    effective_filter = resolve_effective_filter(view, filters, filter_logic)

    if not effective_filter:
        return queryset

    combined_q = build_filter_set_q(view, effective_filter)
    if combined_q is None:
        return queryset
    return queryset.filter(combined_q)
