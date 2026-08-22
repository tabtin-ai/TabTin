"""
原生 SQL 查询构建器

将多维表格的筛选 / 排序 / 聚合条件转换为标准 PostgreSQL SQL，
替代 view_data_service.py 中基于 JSONField 的查询 hack。

核心改进：
- equals → 标准 "col" = %s（不再 data->>'field_id' = %s）
- number 排序 → 列本身就是 DOUBLE PRECISION（不再 ::numeric cast）
- select 排序 → ARRAY_POSITION 直接引用列
- 聚合 → SQL SUM/AVG/COUNT/MIN/MAX（不再 Python 遍历）
"""

import logging
from typing import Any, Dict, List, Optional, Tuple
from uuid import UUID

from .ddl_manager import DDLManager
from .pg_type_map import FIELD_TYPE_TO_PG_TYPE, SYSTEM_COLUMN_NAMES, is_system_field, get_system_column_name, get_pg_type

logger = logging.getLogger('tabdata.native.query_builder')


# ── 安全白名单 ──────────────────────────────
# 操作符白名单：仅允许已知的过滤操作符
ALLOWED_FILTER_OPERATORS = frozenset({
    'equals', 'not_equals',
    'contains', 'not_contains',
    'like', 'ilike',
    'is_empty', 'isempty', 'empty',
    'is_not_empty', 'isnotempty', 'not_empty',
    'greater_than', 'gt', '>',
    'greater_than_or_equals', 'gte', '>=',
    'less_than', 'lt', '<',
    'less_than_or_equals', 'lte', '<=',
    'is_within', 'iswithin',
    'in', 'is_any_of', 'isanyof',
    'not_in', 'is_none_of', 'isnoneof',
    'has_any_of', 'hasanyof',
    'has_all_of', 'hasallof',
    'has_none_of', 'hasnoneof',
    'is_exactly', 'isexactly',
    'is_not_exactly', 'isnotexactly',
})

# 聚合函数白名单
ALLOWED_AGG_FUNCTIONS = frozenset({
    'count', 'count_distinct', 'count_empty', 'count_not_empty',
    'sum', 'average', 'avg', 'min', 'max',
    'percent_empty', 'percent_not_empty', 'percent_unique',
})


def _escape_like(value: str) -> str:
    """转义 LIKE/ILIKE 通配符，防止用户输入中的 % 和 _ 被当作通配符"""
    return value.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_')


class NativeQueryBuilder:
    """
    为原生列表构建 SQL 查询。

    使用参数化查询（%s 占位符）防止 SQL 注入。
    所有方法返回 (sql_fragment, params) 元组。
    """

    def __init__(
        self,
        space_id: UUID,
        table_id: UUID,
        fields: list,
    ):
        """
        Args:
            space_id: Space ID
            table_id: 表 ID
            fields: TableField 对象列表
        """
        self.space_id = space_id
        self.table_id = table_id
        self.qualified_name = self._build_qualified_name(space_id, table_id)
        # field_id (hex, no dashes) → field object
        self.field_map: Dict[str, Any] = {}
        # field_id (with dashes, str(uuid)) → field object
        self.field_uuid_map: Dict[str, Any] = {}
        # field_name → field object
        self.field_name_map: Dict[str, Any] = {}
        # api_name → field object
        self.field_api_name_map: Dict[str, Any] = {}

        for f in fields:
            fid_hex = f.id.hex if isinstance(f.id, UUID) else str(f.id).replace('-', '')
            fid_str = str(f.id)
            self.field_map[fid_hex] = f
            self.field_uuid_map[fid_str] = f
            self.field_name_map[f.name] = f
            api_name = getattr(f, 'api_name', '')
            if api_name:
                self.field_api_name_map[api_name] = f

    @staticmethod
    def _build_qualified_name(space_id: UUID, table_id: UUID) -> str:
        schema = DDLManager.schema_name(space_id)
        table = DDLManager.table_name(table_id)
        return f'"{schema}"."{table}"'

    def _resolve_column_ref(self, field_ref: str) -> Optional[str]:
        """
        将字段引用解析为列引用。

        支持：
        - field UUID (带或不带连字符)
        - field name
        - 系统列名 (__created_at 等)

        Returns:
            带引号的列引用（如 '"a1b2c3d4..."'）或 None
        """
        # 系统列直接引用
        if field_ref.startswith('__') and field_ref in SYSTEM_COLUMN_NAMES:
            return f'"{field_ref}"'

        # 尝试 UUID (with dashes)
        field = self.field_uuid_map.get(field_ref)
        if field:
            if is_system_field(field.field_type):
                sys_col = get_system_column_name(field.field_type)
                return f'"{sys_col}"' if sys_col else None
            return f'"{field.id.hex}"'

        # 尝试 UUID (hex, no dashes)
        clean = field_ref.replace('-', '')
        field = self.field_map.get(clean)
        if field:
            if is_system_field(field.field_type):
                sys_col = get_system_column_name(field.field_type)
                return f'"{sys_col}"' if sys_col else None
            return f'"{field.id.hex}"'

        # 尝试 field name
        field = self.field_name_map.get(field_ref)
        if field:
            if is_system_field(field.field_type):
                sys_col = get_system_column_name(field.field_type)
                return f'"{sys_col}"' if sys_col else None
            return f'"{field.id.hex}"'

        # 尝试 api_name
        field = self.field_api_name_map.get(field_ref)
        if field:
            if is_system_field(field.field_type):
                sys_col = get_system_column_name(field.field_type)
                return f'"{sys_col}"' if sys_col else None
            return f'"{field.id.hex}"'

        return None

    def _get_field_for_ref(self, field_ref: str) -> Optional[Any]:
        """获取字段引用对应的 TableField 对象"""
        field = self.field_uuid_map.get(field_ref)
        if field:
            return field
        clean = field_ref.replace('-', '')
        field = self.field_map.get(clean)
        if field:
            return field
        field = self.field_name_map.get(field_ref)
        if field:
            return field
        return self.field_api_name_map.get(field_ref)

    def _get_pg_type(self, field_ref: str) -> Optional[str]:
        """获取字段对应的 PG 类型"""
        field = self._get_field_for_ref(field_ref)
        if not field:
            return None
        return get_pg_type(field.field_type, field.config)

    # ──────────────────────────────────
    # Filter → WHERE
    # ──────────────────────────────────

    def build_where_clause(
        self,
        filter_set: Optional[Dict],
    ) -> Tuple[str, list]:
        """
        将嵌套 FilterSet 转换为 SQL WHERE 子句。

        FilterSet 格式：
        {
            "conjunction": "and" | "or",
            "filterSet": [
                {"field_id": "...", "operator": "equals", "value": "..."},
                {"conjunction": "and", "filterSet": [...]}  # 嵌套
            ]
        }

        Returns:
            (where_clause, params) — where_clause 不含 WHERE 关键字
        """
        if not filter_set:
            return ('TRUE', [])

        return self._build_filter_group(filter_set)

    def _build_filter_group(self, group: Dict) -> Tuple[str, list]:
        """递归构建筛选组"""
        conjunction = group.get('conjunction', 'and').upper()
        if conjunction not in ('AND', 'OR'):
            conjunction = 'AND'

        filter_items = group.get('filterSet', [])
        if not filter_items:
            return ('TRUE', [])

        conditions = []
        params = []

        for item in filter_items:
            if 'filterSet' in item:
                # 嵌套组
                sub_sql, sub_params = self._build_filter_group(item)
                if sub_sql and sub_sql != 'TRUE':
                    conditions.append(f'({sub_sql})')
                    params.extend(sub_params)
            else:
                # 单条件
                cond_sql, cond_params = self._build_single_condition(item)
                if cond_sql:
                    conditions.append(cond_sql)
                    params.extend(cond_params)

        if not conditions:
            return ('TRUE', [])

        joiner = f' {conjunction} '
        return (joiner.join(conditions), params)

    def _build_single_condition(self, rule: Dict) -> Tuple[Optional[str], list]:
        """
        构建单个筛选条件。

        Args:
            rule: {"field_id": "...", "operator": "equals", "value": ...}

        Returns:
            (sql_condition, params) 或 (None, [])
        """
        # 禁用的筛选条件（enabled=False）不参与 WHERE 构建，与 ORM
        # (build_filter_set_q) / 内存匹配两条路径保持一致；否则关掉开关后
        # 条件仍会拼进 SQL，导致 native 表筛选无法被禁用。
        if rule.get('enabled') is False:
            return (None, [])

        field_ref = rule.get('field_id') or rule.get('field')
        operator = rule.get('operator', '')
        value = rule.get('value')

        if not field_ref or not operator:
            return (None, [])

        col_ref = self._resolve_column_ref(field_ref)
        if not col_ref:
            logger.warning('Cannot resolve field ref for filter: %s', field_ref)
            return (None, [])

        field = self._get_field_for_ref(field_ref)
        pg_type = self._get_pg_type(field_ref) if field else None
        is_jsonb = pg_type == 'JSONB'

        # 标准化操作符
        op = operator.strip().lower().replace('-', '_').replace(' ', '_')

        # 白名单校验：拒绝未知操作符（防止 SQL 注入向量）
        if op not in ALLOWED_FILTER_OPERATORS:
            logger.warning('Rejected unknown filter operator: %s (original: %s), treating as FALSE', op, operator)
            return ('FALSE', [])

        return self._apply_operator(col_ref, op, value, is_jsonb, field)

    @staticmethod
    def _coerce_value_for_pg(value: Any, pg_type: Optional[str]) -> Any:
        """
        根据 PostgreSQL 列类型，将 Python 值强制转换为兼容的参数类型。

        避免 ``operator does not exist: text = boolean`` 等类型不匹配错误。
        """
        if value is None or pg_type is None:
            return value

        if pg_type == 'TEXT':
            # TEXT 列不接受 bool 参数
            if isinstance(value, bool):
                return 'true' if value else 'false'
            if not isinstance(value, str):
                return str(value)

        if pg_type in ('DOUBLE PRECISION', 'INTEGER'):
            # 数值列不接受 str 参数
            if isinstance(value, str):
                try:
                    return float(value) if pg_type == 'DOUBLE PRECISION' else int(value)
                except (ValueError, TypeError):
                    pass

        if pg_type == 'BOOLEAN':
            # BOOLEAN 列需要 bool 值
            if isinstance(value, str):
                return value.lower() in ('true', '1', 'yes')
            if isinstance(value, (int, float)):
                return bool(value)

        return value

    def _apply_operator(
        self,
        col: str,
        op: str,
        value: Any,
        is_jsonb: bool,
        field: Any = None,
    ) -> Tuple[Optional[str], list]:
        """根据操作符生成 SQL 条件"""

        # 获取 pg_type 用于值类型强制转换
        pg_type = None
        ft = ''
        if field:
            ft = getattr(field, 'field_type', '')
            pg_type = get_pg_type(ft, getattr(field, 'config', None))

        # user/created_by/last_modified_by 字段存储为 JSONB {id, name}，
        # 过滤时需要通过 JSONB 路径提取 id 进行比较
        _USER_FIELD_TYPES = ('user', 'created_by', 'last_modified_by')
        if ft in _USER_FIELD_TYPES and is_jsonb:
            return self._apply_user_field_operator(col, op, value)

        if ft in ('date', 'created_time', 'last_modified_time'):
            from apps.tabdata.services.view_filter_service import (
                coerce_date_filter_range_value,
                resolve_date_comparison_range,
                resolve_date_filter_range,
                resolve_field_time_zone_name,
            )

            if op in ('is_within', 'iswithin'):
                range_value = coerce_date_filter_range_value(value, field)
                if range_value is None:
                    return ('FALSE', [])
                try:
                    start, end = resolve_date_filter_range(range_value)
                except ValueError as exc:
                    logger.warning('Invalid native is_within value: %s', exc)
                    return ('FALSE', [])
                if pg_type == 'DATE':
                    tz_name = resolve_field_time_zone_name(field, range_value)
                    try:
                        from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
                        date_tz = ZoneInfo(tz_name)
                    except (KeyError, ZoneInfoNotFoundError):
                        date_tz = ZoneInfo('UTC')
                    return (
                        f'({col} >= %s AND {col} <= %s)',
                        [
                            start.astimezone(date_tz).date().isoformat(),
                            end.astimezone(date_tz).date().isoformat(),
                        ],
                    )
                return (f'({col} >= %s AND {col} <= %s)', [start, end])

            resolved_day = resolve_date_comparison_range(value, field)
            if resolved_day is not None:
                _selected_date, start, end = resolved_day
                if pg_type == 'DATE':
                    tz_name = resolve_field_time_zone_name(field, value)
                    try:
                        from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
                        date_tz = ZoneInfo(tz_name)
                    except (KeyError, ZoneInfoNotFoundError):
                        date_tz = ZoneInfo('UTC')
                    start_date = start.astimezone(date_tz).date().isoformat()
                    end_date = end.astimezone(date_tz).date().isoformat()
                    if op == 'equals':
                        return (
                            f'({col} >= %s AND {col} <= %s)',
                            [start_date, end_date],
                        )
                    if op == 'not_equals':
                        return (
                            f'({col} < %s OR {col} > %s OR {col} IS NULL)',
                            [start_date, end_date],
                        )
                    if op in ('greater_than', 'gt', '>'):
                        return (f'{col} > %s', [end_date])
                    if op in ('greater_than_or_equals', 'gte', '>='):
                        return (f'{col} >= %s', [start_date])
                    if op in ('less_than', 'lt', '<'):
                        return (f'{col} < %s', [start_date])
                    if op in ('less_than_or_equals', 'lte', '<='):
                        return (f'{col} <= %s', [end_date])

                if op == 'equals':
                    return (f'({col} >= %s AND {col} <= %s)', [start, end])
                if op == 'not_equals':
                    return (
                        f'({col} < %s OR {col} > %s OR {col} IS NULL)',
                        [start, end],
                    )
                if op in ('greater_than', 'gt', '>'):
                    return (f'{col} > %s', [end])
                if op in ('greater_than_or_equals', 'gte', '>='):
                    return (f'{col} >= %s', [start])
                if op in ('less_than', 'lt', '<'):
                    return (f'{col} < %s', [start])
                if op in ('less_than_or_equals', 'lte', '<='):
                    return (f'{col} <= %s', [end])

        # ── equals / not_equals ──
        if op == 'equals':
            if value is None:
                return (f'{col} IS NULL', [])
            return (f'{col} = %s', [self._coerce_value_for_pg(value, pg_type)])

        if op == 'not_equals':
            if value is None:
                return (f'{col} IS NOT NULL', [])
            return (f'({col} != %s OR {col} IS NULL)', [self._coerce_value_for_pg(value, pg_type)])

        # ── contains / not_contains ──
        if op == 'contains':
            if is_jsonb:
                # JSONB 数组包含
                return (f'{col} @> %s::jsonb', [f'["{value}"]' if isinstance(value, str) else str(value)])
            escaped = _escape_like(str(value))
            return (f'{col} ILIKE %s', [f'%{escaped}%'])

        if op == 'not_contains':
            if is_jsonb:
                return (f'NOT ({col} @> %s::jsonb)', [f'["{value}"]' if isinstance(value, str) else str(value)])
            escaped = _escape_like(str(value))
            return (f'({col} NOT ILIKE %s OR {col} IS NULL)', [f'%{escaped}%'])

        if op == 'like':
            logger.warning('Deprecated filter operator "like" received, auto-converting to escaped ILIKE (contains semantics)')
            escaped = _escape_like(str(value))
            return (f'{col} ILIKE %s', [f'%{escaped}%'])

        if op == 'ilike':
            logger.warning('Deprecated filter operator "ilike" received, auto-converting to escaped ILIKE (contains semantics)')
            escaped = _escape_like(str(value))
            return (f'{col} ILIKE %s', [f'%{escaped}%'])

        # ── is_empty / is_not_empty ──
        if op in ('is_empty', 'isempty', 'empty'):
            if is_jsonb:
                return (f"({col} IS NULL OR {col} = '[]'::jsonb OR {col} = 'null'::jsonb)", [])
            if pg_type_is_text(field):
                return (f"({col} IS NULL OR {col} = '')", [])
            return (f'{col} IS NULL', [])

        if op in ('is_not_empty', 'isnotempty', 'not_empty'):
            if is_jsonb:
                return (f"({col} IS NOT NULL AND {col} != '[]'::jsonb AND {col} != 'null'::jsonb)", [])
            if pg_type_is_text(field):
                return (f"({col} IS NOT NULL AND {col} != '')", [])
            return (f'{col} IS NOT NULL', [])

        # ── 比较操作符 ──
        if op in ('greater_than', 'gt', '>'):
            return (f'{col} > %s', [self._coerce_value_for_pg(value, pg_type)])

        if op in ('greater_than_or_equals', 'gte', '>='):
            return (f'{col} >= %s', [self._coerce_value_for_pg(value, pg_type)])

        if op in ('less_than', 'lt', '<'):
            return (f'{col} < %s', [self._coerce_value_for_pg(value, pg_type)])

        if op in ('less_than_or_equals', 'lte', '<='):
            return (f'{col} <= %s', [self._coerce_value_for_pg(value, pg_type)])

        # ── in / not_in ──
        if op in ('in', 'is_any_of', 'isanyof'):
            if not isinstance(value, (list, tuple)):
                value = [value]
            if not value:
                return ('FALSE', [])
            coerced = [self._coerce_value_for_pg(v, pg_type) for v in value]
            placeholders = ', '.join(['%s'] * len(coerced))
            return (f'{col} IN ({placeholders})', coerced)

        if op in ('not_in', 'is_none_of', 'isnoneof'):
            if not isinstance(value, (list, tuple)):
                value = [value]
            if not value:
                return ('TRUE', [])
            coerced = [self._coerce_value_for_pg(v, pg_type) for v in value]
            placeholders = ', '.join(['%s'] * len(coerced))
            return (f'({col} NOT IN ({placeholders}) OR {col} IS NULL)', coerced)

        # ── JSONB 数组操作符 ──
        if op in ('has_any_of', 'hasanyof'):
            if not isinstance(value, (list, tuple)):
                value = [value]
            if not value:
                return ('FALSE', [])
            # ?| 操作符：JSONB 包含任一元素
            return (f'{col} ?| %s', [list(value)])

        if op in ('has_all_of', 'hasallof'):
            if not isinstance(value, (list, tuple)):
                value = [value]
            if not value:
                return ('TRUE', [])
            # ?& 操作符：JSONB 包含所有元素
            return (f'{col} ?& %s', [list(value)])

        if op in ('has_none_of', 'hasnoneof'):
            if not isinstance(value, (list, tuple)):
                value = [value]
            if not value:
                return ('TRUE', [])
            return (f'NOT ({col} ?| %s)', [list(value)])

        if op in ('is_exactly', 'isexactly'):
            if not isinstance(value, (list, tuple)):
                value = [value]
            import json
            sorted_val = json.dumps(sorted(str(v) for v in value))
            return (
                f'(SELECT jsonb_agg(v ORDER BY v) FROM jsonb_array_elements_text({col}) AS v) = '
                f'(SELECT jsonb_agg(v ORDER BY v) FROM jsonb_array_elements_text(%s::jsonb) AS v)',
                [sorted_val],
            )

        if op in ('is_not_exactly', 'isnotexactly'):
            if not isinstance(value, (list, tuple)):
                value = [value]
            import json
            sorted_val = json.dumps(sorted(str(v) for v in value))
            return (
                f'({col} IS NULL OR '
                f'(SELECT jsonb_agg(v ORDER BY v) FROM jsonb_array_elements_text({col}) AS v) != '
                f'(SELECT jsonb_agg(v ORDER BY v) FROM jsonb_array_elements_text(%s::jsonb) AS v))',
                [sorted_val],
            )

        logger.warning('Unknown filter operator: %s, treating as FALSE (no match)', op)
        return ('FALSE', [])

    @staticmethod
    def _apply_user_field_operator(
        col: str, op: str, value: Any,
    ) -> Tuple[Optional[str], list]:
        """user/created_by/last_modified_by 字段专用过滤：通过 JSONB 路径提取 id 比较。

        兼容两种存储格式：
        - JSONB object {"id": "uuid", "name": "..."} → col->>'id'
        - JSONB text   "uuid"                        → col#>>'{}'
        """
        id_expr = f"COALESCE({col}->>'id', {col}#>>'{{}}')"
        if op == 'equals':
            if value is None:
                return (f'{col} IS NULL', [])
            uid = value.get('id') if isinstance(value, dict) else str(value)
            return (f"{id_expr} = %s", [uid])
        if op == 'not_equals':
            if value is None:
                return (f'{col} IS NOT NULL', [])
            uid = value.get('id') if isinstance(value, dict) else str(value)
            return (f"({id_expr} != %s OR {col} IS NULL)", [uid])
        if op in ('is_empty', 'isempty', 'empty'):
            return (f"({col} IS NULL OR {col} = 'null'::jsonb)", [])
        if op in ('is_not_empty', 'isnotempty', 'not_empty'):
            return (f"({col} IS NOT NULL AND {col} != 'null'::jsonb)", [])
        if op in ('in', 'is_any_of', 'isanyof'):
            if not isinstance(value, (list, tuple)):
                value = [value]
            uids = [v.get('id') if isinstance(v, dict) else str(v) for v in value]
            if not uids:
                return ('FALSE', [])
            placeholders = ', '.join(['%s'] * len(uids))
            return (f"{id_expr} IN ({placeholders})", uids)
        if op in ('not_in', 'is_none_of', 'isnoneof'):
            if not isinstance(value, (list, tuple)):
                value = [value]
            uids = [v.get('id') if isinstance(v, dict) else str(v) for v in value]
            if not uids:
                return ('TRUE', [])
            placeholders = ', '.join(['%s'] * len(uids))
            return (f"({id_expr} NOT IN ({placeholders}) OR {col} IS NULL)", uids)
        if op == 'contains':
            uid = value.get('id') if isinstance(value, dict) else str(value)
            return (f"{id_expr} = %s", [uid])
        if op == 'not_contains':
            uid = value.get('id') if isinstance(value, dict) else str(value)
            return (f"({id_expr} != %s OR {col} IS NULL)", [uid])
        logger.warning('Unsupported operator for user field: %s', op)
        return ('FALSE', [])

    # ──────────────────────────────────
    # Sort → ORDER BY
    # ──────────────────────────────────

    def build_order_clause(
        self,
        sorts: Optional[List[Dict]],
    ) -> Tuple[str, list]:
        """
        将排序规则转换为 SQL ORDER BY 子句（不含 ORDER BY 关键字）。

        Sort 格式：[{"field_id": "...", "order": "asc|desc"}, ...]

        select 字段使用 ARRAY_POSITION 保持选项顺序。
        NULLS LAST 确保空值排在最后。

        Returns:
            (order_clause, params) — select choices 通过 %s 参数化传入
        """
        if not sorts:
            return ('"__order" ASC, "__auto_number" ASC', [])

        clauses = []
        params = []
        for sort_rule in sorts:
            field_ref = sort_rule.get('field_id') or sort_rule.get('field')
            direction = (sort_rule.get('order') or sort_rule.get('direction') or 'asc').upper()
            if direction not in ('ASC', 'DESC'):
                direction = 'ASC'

            if not field_ref:
                continue

            col_ref = self._resolve_column_ref(field_ref)
            if not col_ref:
                continue

            field = self._get_field_for_ref(field_ref)

            # select 字段：使用 ARRAY_POSITION 按选项顺序排序
            # 选项值通过参数化传入，防止 SQL 注入
            if field and field.field_type == 'select':
                choices = self._get_select_choices(field)
                if choices:
                    placeholders = ', '.join(['%s'] * len(choices))
                    clause = f'ARRAY_POSITION(ARRAY[{placeholders}]::text[], {col_ref}) {direction} NULLS LAST'
                    clauses.append(clause)
                    params.extend(choices)
                    continue

            if field and field.field_type == 'multi_select':
                choices = self._get_select_choices(field)
                nulls = 'NULLS LAST' if direction == 'ASC' else 'NULLS FIRST'
                if choices:
                    placeholders = ', '.join(['%s'] * len(choices))
                    clause = (
                        f'ARRAY_POSITION(ARRAY[{placeholders}]::text[], '
                        f'({col_ref}->>0)) {direction} {nulls}'
                    )
                    clauses.append(clause)
                    params.extend(choices)
                else:
                    clauses.append(
                        f'COALESCE(jsonb_array_length({col_ref}), 0) {direction} {nulls}'
                    )
                continue

            # 默认排序
            nulls = 'NULLS LAST' if direction == 'ASC' else 'NULLS FIRST'
            clauses.append(f'{col_ref} {direction} {nulls}')

        # 始终追加兜底排序
        clauses.append('"__order" ASC')
        clauses.append('"__auto_number" ASC')

        return (', '.join(clauses), params)

    @staticmethod
    def _get_select_choices(field: Any) -> List[str]:
        """从 select 字段配置中提取选项列表"""
        config = getattr(field, 'config', None) or {}
        choices = config.get('options') or config.get('choices') or []
        if isinstance(choices, list):
            values = []
            for choice in choices:
                if isinstance(choice, dict):
                    for key in ('value', 'id', 'name', 'label'):
                        value = choice.get(key)
                        if value is not None:
                            values.append(str(value))
                            break
                elif choice:
                    values.append(str(choice))
            return values
        return []

    # ──────────────────────────────────
    # Aggregate → SQL 函数
    # ──────────────────────────────────

    def build_aggregate_sql(
        self,
        aggregations: Dict[str, str],
        *,
        where: Optional[Tuple[str, list]] = None,
    ) -> Tuple[str, list]:
        """
        构建聚合查询 SQL。

        Args:
            aggregations: {field_id: func_name, ...}
                func_name: count, sum, average, min, max, count_distinct,
                           count_empty, count_not_empty, percent_empty,
                           percent_not_empty, percent_unique
            where: 可选 (where_sql, where_params) 条件元组，
                直接拼入 SQL 的 WHERE 子句，避免调用方字符串拼接。

        Returns:
            (sql, params)
        """
        exprs = []
        params = []

        for field_ref, func_name in aggregations.items():
            if func_name not in ALLOWED_AGG_FUNCTIONS:
                logger.warning('Rejected unknown aggregation function: %s', func_name)
                continue

            if field_ref == '__count__' and func_name == 'count':
                exprs.append('COUNT(*) AS "total_count"')
                continue

            col_ref = self._resolve_column_ref(field_ref)
            if not col_ref:
                continue

            field = self._get_field_for_ref(field_ref)
            pg_type = self._get_pg_type(field_ref) if field else None
            is_jsonb = pg_type == 'JSONB'

            safe_ref = col_ref.strip('"')
            alias = f'"{safe_ref}__{func_name}"'
            expr = self._build_agg_expr(col_ref, func_name, is_jsonb, field)
            if expr:
                exprs.append(f'{expr} AS {alias}')

        if not exprs:
            return ('SELECT 1', [])

        select_clause = ', '.join(exprs)
        sql = f'SELECT {select_clause} FROM {self.qualified_name}'

        if where is not None:
            where_sql, where_params = where
            if where_sql:
                sql += f' WHERE {where_sql}'
                params.extend(where_params)

        return (sql, params)

    def _build_agg_expr(
        self,
        col: str,
        func_name: str,
        is_jsonb: bool,
        field: Any = None,
    ) -> Optional[str]:
        """构建单个聚合表达式"""

        if func_name == 'count':
            return f'COUNT(*)'

        if func_name == 'count_distinct':
            return f'COUNT(DISTINCT {col})'

        if func_name == 'count_empty':
            if is_jsonb:
                return f"COUNT(*) FILTER (WHERE {col} IS NULL OR {col} = '[]'::jsonb)"
            if pg_type_is_text(field):
                return f"COUNT(*) FILTER (WHERE {col} IS NULL OR {col} = '')"
            return f'COUNT(*) FILTER (WHERE {col} IS NULL)'

        if func_name == 'count_not_empty':
            if is_jsonb:
                return f"COUNT(*) FILTER (WHERE {col} IS NOT NULL AND {col} != '[]'::jsonb)"
            if pg_type_is_text(field):
                return f"COUNT(*) FILTER (WHERE {col} IS NOT NULL AND {col} != '')"
            return f'COUNT(*) FILTER (WHERE {col} IS NOT NULL)'

        if func_name == 'sum':
            return f'SUM({col})'

        if func_name in ('average', 'avg'):
            return f'AVG({col})'

        if func_name == 'min':
            return f'MIN({col})'

        if func_name == 'max':
            return f'MAX({col})'

        if func_name == 'percent_empty':
            if is_jsonb:
                return f"(COUNT(*) FILTER (WHERE {col} IS NULL OR {col} = '[]'::jsonb))::FLOAT / NULLIF(COUNT(*), 0)"
            if pg_type_is_text(field):
                return f"(COUNT(*) FILTER (WHERE {col} IS NULL OR {col} = ''))::FLOAT / NULLIF(COUNT(*), 0)"
            return f'(COUNT(*) FILTER (WHERE {col} IS NULL))::FLOAT / NULLIF(COUNT(*), 0)'

        if func_name == 'percent_not_empty':
            return f'(COUNT({col}))::FLOAT / NULLIF(COUNT(*), 0)'

        if func_name == 'percent_unique':
            return f'(COUNT(DISTINCT {col}))::FLOAT / NULLIF(COUNT(*), 0)'

        logger.warning('Unknown aggregation function: %s', func_name)
        return None

    # ──────────────────────────────────
    # 完整查询构建
    # ──────────────────────────────────

    def build_select_sql(
        self,
        *,
        field_ids: Optional[List[str]] = None,
        where: Optional[Tuple[str, list]] = None,
        order_by: Optional[Tuple[str, list]] = None,
        limit: int = 100,
        offset: int = 0,
        cursor_value: Optional[float] = None,
        cursor_id: Optional[str] = None,
    ) -> Tuple[str, list]:
        """
        构建完整的 SELECT 查询。

        Args:
            field_ids: 要选择的字段 ID 列表（None 表示所有字段）
            where: (where_clause, params) 元组
            order_by: (order_clause, params) 元组（由 build_order_clause 返回）
            limit: 最大返回行数
            offset: 偏移量
            cursor_value: keyset 分页游标 — 上一页最后一行的 __order 值。
                传入后忽略 offset，用 WHERE 条件替代 OFFSET 扫描。
            cursor_id: keyset 分页游标 — 上一页最后一行的 __id。
                与 cursor_value 配合使用，用于 __order 值相同时的精确去重。

        Returns:
            (sql, params)
        """
        # SELECT 列
        columns = self._build_select_columns(field_ids)
        select_clause = ', '.join(columns)

        # WHERE
        params = []
        where_parts = []

        if where:
            where_sql, where_params = where
            if where_sql and where_sql != 'TRUE':
                where_parts.append(where_sql)
                params.extend(where_params)

        # Keyset 分页：用 WHERE 替代 OFFSET，深页时从 O(offset+limit) 降至 O(limit)
        use_keyset = cursor_value is not None
        if use_keyset:
            if cursor_id:
                where_parts.append(
                    '("__order" > %s OR ("__order" = %s AND "__id"::text > %s))'
                )
                params.extend([cursor_value, cursor_value, cursor_id])
            else:
                where_parts.append('"__order" > %s')
                params.append(cursor_value)

        where_clause = ' AND '.join(where_parts) if where_parts else 'TRUE'

        # ORDER BY（仅接受 None 或 (clause, params) 元组）
        if order_by is None:
            order_clause = '"__order" ASC, "__auto_number" ASC'
        elif isinstance(order_by, tuple):
            order_clause, order_params = order_by
            params.extend(order_params)
        else:
            raise TypeError(
                f"order_by 必须是 None 或 (clause, params) 元组，"
                f"不接受纯字符串（收到 {type(order_by).__name__}）"
            )

        if use_keyset:
            sql = (
                f'SELECT {select_clause} '
                f'FROM {self.qualified_name} '
                f'WHERE {where_clause} '
                f'ORDER BY {order_clause} '
                f'LIMIT %s'
            )
            params.append(limit)
        else:
            sql = (
                f'SELECT {select_clause} '
                f'FROM {self.qualified_name} '
                f'WHERE {where_clause} '
                f'ORDER BY {order_clause} '
                f'LIMIT %s OFFSET %s'
            )
            params.extend([limit, offset])

        return (sql, params)

    def build_count_sql(
        self,
        where: Optional[Tuple[str, list]] = None,
    ) -> Tuple[str, list]:
        """构建 COUNT 查询"""
        params = []
        where_parts = []

        if where:
            where_sql, where_params = where
            if where_sql and where_sql != 'TRUE':
                where_parts.append(where_sql)
                params.extend(where_params)

        where_clause = ' AND '.join(where_parts) if where_parts else 'TRUE'

        sql = f'SELECT COUNT(*) FROM {self.qualified_name} WHERE {where_clause}'
        return (sql, params)

    def _build_select_columns(self, field_ids: Optional[List[str]] = None) -> List[str]:
        """构建 SELECT 列列表"""
        # 始终包含系统列
        columns = [
            '"__id"',
            '"__auto_number"',
            '"__order"',
            '"__version"',
            '"__created_at"',
            '"__updated_at"',
            '"__created_by"',
            '"__updated_by"',
        ]

        if field_ids is None:
            # 所有字段
            for fid_hex, field in self.field_map.items():
                if not is_system_field(field.field_type):
                    columns.append(f'"{fid_hex}"')
        else:
            for fid in field_ids:
                col_ref = self._resolve_column_ref(fid)
                if col_ref:
                    columns.append(col_ref)

        return columns


# ── 辅助函数 ──

def pg_type_is_text(field: Any) -> bool:
    """判断字段的 PG 类型是否为文本类型"""
    if not field:
        return False
    ft = getattr(field, 'field_type', '')
    return FIELD_TYPE_TO_PG_TYPE.get(ft) in ('TEXT',)


def merge_where(
    base_where: Optional[Tuple[str, list]],
    extra_where: Optional[Tuple[str, list]],
) -> Tuple[str, list]:
    """合并两个 WHERE 子句片段。"""
    if not base_where or base_where[0] in ('', 'TRUE'):
        return extra_where if extra_where else ('TRUE', [])
    if not extra_where or extra_where[0] in ('', 'TRUE'):
        return base_where
    base_sql, base_params = base_where
    extra_sql, extra_params = extra_where
    return (f'({base_sql}) AND ({extra_sql})', [*base_params, *extra_params])
