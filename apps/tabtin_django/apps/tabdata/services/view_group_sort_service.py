"""
视图分组与排序服务

从 view_data_service.py 提取的分组元数据构建和排序逻辑，
提供模块级函数供 ViewDataService 和其他模块调用。
"""
from __future__ import annotations

import json
import logging
import math
import re
import unicodedata
from datetime import datetime, timezone
from functools import cmp_to_key
from typing import Any, Dict, List, Optional, Set, Tuple
from uuid import UUID

from django.db.models import Count, QuerySet
from django.db.models.expressions import RawSQL

from apps.tabdata.models import TableField, TableView

from .view_constants import MODEL_FIELDS
from .view_filter_service import get_field_maps as _get_field_maps_fn

_logger = logging.getLogger('tabdata.view_group_sort_service')

# 与 packages/table-engine groupValueContract 对齐的用户类字段
_USER_FIELD_TYPES = frozenset({'user', 'created_by', 'last_modified_by'})
_USER_ID_KEYS = ('id', 'user_id', 'open_id', 'union_id')
_USER_NAME_KEYS = ('name', 'display_name', 'nickname', 'en_name')
_USER_AVATAR_KEYS = ('avatar_url', 'avatarUrl', 'avatar')
# TabTin 组织成员 / 系统用户 id 为 UUID；飞书导入常见 ou_ / open_id 走展示名归桶
_USER_UUID_RE = re.compile(
    r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
    re.I,
)


def _get_choice_value(option: Dict[str, Any]) -> Optional[Any]:
    for key in ('value', 'id', 'name', 'label'):
        value = option.get(key)
        if value is not None:
            return value
    return None


def _get_choice_candidates(field_meta: Optional[TableField]) -> Optional[List[Any]]:
    if not field_meta or not isinstance(field_meta.config, dict):
        return None
    candidates = field_meta.config.get('options') or field_meta.config.get('choices')
    return candidates if isinstance(candidates, list) else None


def _get_choice_values(field_meta: Optional[TableField]) -> List[str]:
    candidates = _get_choice_candidates(field_meta)
    if not candidates:
        return []
    values: List[str] = []
    for choice in candidates:
        if isinstance(choice, dict):
            choice_value = _get_choice_value(choice)
            if choice_value is not None:
                values.append(str(choice_value))
        else:
            values.append(str(choice))
    return values


def _order_raw_sql(
    sql: str,
    params: List[Any],
    direction: str,
    *,
    always_nulls_last: bool = False,
):
    expression = RawSQL(sql, params)
    if direction == 'desc':
        return expression.desc(nulls_last=always_nulls_last, nulls_first=not always_nulls_last)
    return expression.asc(nulls_last=True)


def _is_user_field(field_meta: Optional[TableField]) -> bool:
    if not field_meta:
        return False
    field_type = getattr(field_meta, 'field_type', None)
    return str(field_type or '') in _USER_FIELD_TYPES


def _read_first_text(record: Dict[str, Any], keys: Tuple[str, ...]) -> Optional[str]:
    for key in keys:
        candidate = record.get(key)
        if isinstance(candidate, str) and candidate.strip():
            return candidate.strip()
    return None


def _looks_like_member_id(identity: str) -> bool:
    """TabTin 组织成员 id 为 UUID；飞书 ou_ / open_id 等不算成员匹配。"""
    return bool(_USER_UUID_RE.match(identity))


def _resolve_user_group_token(
    value: Any,
    known_member_ids: Optional[Set[str]] = None,
) -> Tuple[str, str]:
    """
    返回 (token, label)。
    - 匹配组织成员（已知成员集或 UUID 形态）→ token=成员 id
    - 否则（导入未匹配）→ token=name:展示名，与成员同名也拆成另一组
    """
    if isinstance(value, dict):
        identity = _read_first_text(value, _USER_ID_KEYS)
        name = _read_first_text(value, _USER_NAME_KEYS)
        is_member = False
        if identity:
            if known_member_ids is not None:
                is_member = identity in known_member_ids
            else:
                is_member = _looks_like_member_id(identity)
        if is_member and identity:
            return identity, name or identity
        label = name or identity or json.dumps(
            value, ensure_ascii=False, separators=(',', ':'), default=str
        )
        return f'name:{label}', label

    text = str(value)
    if known_member_ids is not None:
        is_member = text in known_member_ids
    else:
        is_member = _looks_like_member_id(text)
    if is_member:
        return text, text
    return f'name:{text}', text


def _canonicalize_user_group_value(value: Any) -> Any:
    """规范化用户字段 group_value：保留名字与可选头像，便于组头展示。"""
    if value is None or value == '' or value == []:
        return None
    items = value if isinstance(value, list) else [value]
    if not items:
        return None
    canonical: List[Any] = []
    for item in items:
        if isinstance(item, dict):
            name = _read_first_text(item, _USER_NAME_KEYS)
            identity = _read_first_text(item, _USER_ID_KEYS)
            avatar = _read_first_text(item, _USER_AVATAR_KEYS)
            entry: Dict[str, str] = {}
            if identity:
                entry['id'] = identity
            if name:
                entry['name'] = name
            if avatar:
                entry['avatar_url'] = avatar
            canonical.append(entry if entry else item)
        else:
            canonical.append(str(item))
    return canonical


def _prefer_richer_user_value(existing: Any, incoming: Any) -> Any:
    """同桶合并时优先保留带 name / avatar 的外形。"""
    if incoming is None:
        return existing
    if existing is None:
        return incoming
    ex_items = existing if isinstance(existing, list) else [existing]
    in_items = incoming if isinstance(incoming, list) else [incoming]
    if len(ex_items) == 1 and len(in_items) == 1 and isinstance(ex_items[0], dict) and isinstance(in_items[0], dict):
        out = dict(ex_items[0])
        if not _read_first_text(out, _USER_NAME_KEYS):
            name = _read_first_text(in_items[0], _USER_NAME_KEYS)
            if name:
                out['name'] = name
        if not _read_first_text(out, _USER_AVATAR_KEYS):
            avatar = _read_first_text(in_items[0], _USER_AVATAR_KEYS)
            if avatar:
                out['avatar_url'] = avatar
        return [out]
    if _user_group_label(existing) in ('', '未分组') and _user_group_label(incoming) not in (
        '',
        '未分组',
    ):
        return incoming
    return existing


def normalize_group_key(
    value: Any,
    field_meta: Optional[TableField] = None,
    known_member_ids: Optional[Set[str]] = None,
) -> str:
    """分组树聚合键。成员按 id，未匹配导入按 name:展示名（同名可拆两组）。"""
    if value is None or value == '':
        return '__empty__'

    if _is_user_field(field_meta):
        if isinstance(value, list) and len(value) == 0:
            return '__empty__'
        tokens = [
            _resolve_user_group_token(item, known_member_ids)[0]
            for item in (value if isinstance(value, list) else [value])
        ]
        tokens = sorted({token for token in tokens if token}, key=_canonical_text_key)
        if not tokens:
            return '__empty__'
        return f'user:{json.dumps(tokens, ensure_ascii=False, separators=(",", ":"))}'

    if isinstance(value, list):
        if len(value) == 0:
            return '__empty__'
        items = [str(item) for item in value]
        if str(getattr(field_meta, 'field_type', '') or '') == 'multi_select':
            items = sorted({_choice_key(item) for item in value}, key=_canonical_text_key)
        return '|'.join(items)
    if isinstance(value, dict):
        return json.dumps(
            value,
            ensure_ascii=False,
            separators=(',', ':'),
            sort_keys=True,
            default=str,
        )
    return str(value)


def _user_group_label(value: Any) -> str:
    if value is None or value == '' or value == []:
        return '未分组'
    items = value if isinstance(value, list) else [value]
    if not items:
        return '未分组'
    member_by_token = {
        token: label
        for token, label in (_resolve_user_group_token(item) for item in items)
    }
    labels = [
        label
        for _, label in sorted(
            member_by_token.items(),
            key=lambda item: (_canonical_text_key(item[1]), _canonical_text_key(item[0])),
        )
    ]
    return ', '.join(labels) if labels else '未分组'


def _canonical_text_key(value: Any) -> Tuple[Any, ...]:
    """与 table-engine compareCanonicalText 对齐的固定自然序。"""
    normalized = unicodedata.normalize('NFKC', str(value)).lower()
    parts: List[Tuple[Any, ...]] = []
    for part in re.split(r'(\d+)', normalized):
        if not part:
            continue
        if part.isdigit():
            parts.append((0, int(part), len(part)))
        else:
            parts.append((1, tuple(ord(char) for char in part)))
    # NFKC/case-insensitive values still need an exact tie-breaker so arrival
    # order can never decide the final group order.
    return tuple(parts), tuple(ord(char) for char in str(value))


def _choice_key(value: Any) -> str:
    if isinstance(value, dict):
        choice = _get_choice_value(value)
        if choice is not None:
            return str(choice)
    return str(value)


def _choice_ranks(value: Any, field_meta: Optional[TableField]) -> Tuple[int, ...]:
    candidates = _get_choice_candidates(field_meta) or []
    rank_by_key: Dict[str, int] = {}
    for index, option in enumerate(candidates):
        if isinstance(option, dict):
            for key in ('value', 'id', 'name', 'label'):
                candidate = option.get(key)
                if candidate is not None:
                    rank_by_key.setdefault(str(candidate), index)
        elif option is not None:
            rank_by_key.setdefault(str(option), index)
    values = value if isinstance(value, list) else [value]
    if str(getattr(field_meta, 'field_type', '') or '') == 'multi_select':
        values = list({_choice_key(item): item for item in values}.values())
    return tuple(
        sorted(rank_by_key.get(_choice_key(item), 10**9) for item in values)
    )


def _group_value_label(value: Any, field_meta: Optional[TableField]) -> str:
    if _is_user_field(field_meta):
        return _user_group_label(value)
    if isinstance(value, list):
        items = [_choice_key(item) for item in value]
        if str(getattr(field_meta, 'field_type', '') or '') == 'multi_select':
            items = sorted(set(items), key=_canonical_text_key)
        return ', '.join(items)
    return _choice_key(value)


def compare_group_values(
    left: Any,
    right: Any,
    field_meta: Optional[TableField],
    direction: str = 'asc',
) -> int:
    """分组 canonical comparator；空组在升降序中都固定置底。"""
    left_empty = left is None or left == '' or left == []
    right_empty = right is None or right == '' or right == []
    if left_empty or right_empty:
        if left_empty == right_empty:
            return 0
        return 1 if left_empty else -1

    result = 0
    candidates = _get_choice_candidates(field_meta)
    field_type = str(getattr(field_meta, 'field_type', '') or '')
    if candidates:
        left_rank = _choice_ranks(left, field_meta)
        right_rank = _choice_ranks(right, field_meta)
        result = (left_rank > right_rank) - (left_rank < right_rank)
    elif field_type in {
        'number', 'currency', 'percent', 'rating', 'duration'
    }:
        try:
            left_number = float(left)
            left_invalid = not math.isfinite(left_number)
        except (TypeError, ValueError):
            left_invalid = True
            left_number = 0.0
        try:
            right_number = float(right)
            right_invalid = not math.isfinite(right_number)
        except (TypeError, ValueError):
            right_invalid = True
            right_number = 0.0
        if left_invalid or right_invalid:
            result = 0 if left_invalid == right_invalid else (1 if left_invalid else -1)
        else:
            result = (left_number > right_number) - (left_number < right_number)
    elif field_type in {'date', 'created_time', 'last_modified_time'}:
        try:
            left_time = datetime.fromisoformat(str(left).replace('Z', '+00:00'))
            if left_time.tzinfo is None:
                left_time = left_time.replace(tzinfo=timezone.utc)
            left_invalid = False
        except (TypeError, ValueError):
            left_invalid = True
            left_time = None
        try:
            right_time = datetime.fromisoformat(str(right).replace('Z', '+00:00'))
            if right_time.tzinfo is None:
                right_time = right_time.replace(tzinfo=timezone.utc)
        except (TypeError, ValueError):
            right_invalid = True
            right_time = None
        else:
            right_invalid = False
        if left_invalid or right_invalid:
            result = 0 if left_invalid == right_invalid else (1 if left_invalid else -1)
        else:
            try:
                result = (left_time > right_time) - (left_time < right_time)
            except TypeError:
                result = 0

    if result == 0:
        left_label = _canonical_text_key(_group_value_label(left, field_meta))
        right_label = _canonical_text_key(_group_value_label(right, field_meta))
        result = (left_label > right_label) - (left_label < right_label)
    if result == 0:
        left_key = _canonical_text_key(normalize_group_key(left, field_meta))
        right_key = _canonical_text_key(normalize_group_key(right, field_meta))
        result = (left_key > right_key) - (left_key < right_key)
    return -result if direction == 'desc' else result


def _sort_group_tree_items(
    tree: Dict[str, Any],
    field_meta: Optional[TableField],
    direction: str,
) -> List[Tuple[str, Any]]:
    return sorted(
        tree.items(),
        key=cmp_to_key(
            lambda left, right: compare_group_values(
                left[1].get('value'),
                right[1].get('value'),
                field_meta,
                direction,
            )
        ),
    )


def _merge_group_tree_node(
    cursor: Dict[str, Any],
    key: str,
    raw_value: Any,
    count: int,
    field_meta: Optional[TableField],
) -> Dict[str, Any]:
    """按分组键合并节点；同桶不同外形累加 count。"""
    if key not in cursor:
        stored_value = (
            _canonicalize_user_group_value(raw_value)
            if _is_user_field(field_meta)
            else raw_value
        )
        cursor[key] = {
            'value': stored_value,
            'count': 0,
            'children': {},
        }
    elif _is_user_field(field_meta):
        existing = cursor[key].get('value')
        incoming = _canonicalize_user_group_value(raw_value)
        cursor[key]['value'] = _prefer_richer_user_value(existing, incoming)
    cursor[key]['count'] += count
    return cursor[key]['children']


def build_group_metadata(
    view: TableView,
    queryset: QuerySet,
    groups: Optional[List[Dict[str, Any]]],
) -> Optional[Dict[str, Any]]:
    """
    ORM 分组元数据构建（含分组树结构计算）。

    根据 groups 规则对 queryset 做 GROUP BY 并构建嵌套树结构。
    最多支持 3 层分组。
    """
    if not groups:
        return None

    id_map, name_map = _get_field_maps_fn(view)
    resolved_groups: List[Dict[str, Any]] = []

    for rule in groups[:3]:
        if not isinstance(rule, dict):
            continue
        field_ref = rule.get('field_id') or rule.get('field')
        if not field_ref:
            continue
        field_key = str(field_ref)
        field_meta = id_map.get(field_key) or name_map.get(field_key)
        field_name = field_meta.name if field_meta else field_key
        field_lookup = str(field_meta.id) if field_meta else field_key
        direction = rule.get('direction') or rule.get('order') or 'asc'
        resolved_groups.append({
            'field_id': str(field_meta.id) if field_meta else None,
            'field': field_name,
            'field_lookup': field_lookup,
            'direction': direction if direction in ['asc', 'desc'] else 'asc',
            'field_meta': field_meta,
        })

    if not resolved_groups:
        return None

    lookups: List[str] = []
    for group in resolved_groups:
        field_lookup = group['field_lookup']
        if field_lookup in MODEL_FIELDS:
            lookups.append(field_lookup)
        else:
            lookup = 'data__' + '__'.join(field_lookup.split('.'))
            lookups.append(lookup)

    rows = list(
        queryset.values(*lookups).annotate(count=Count('id'))
    )

    root: Dict[str, Any] = {}
    for row in rows:
        count = row.get('count', 0)
        cursor = root
        for index, lookup in enumerate(lookups):
            raw_value = row.get(lookup)
            field_meta = resolved_groups[index].get('field_meta')
            key = normalize_group_key(raw_value, field_meta)
            cursor = _merge_group_tree_node(cursor, key, raw_value, count, field_meta)

    def get_label(field_meta: Optional[TableField], value: Any) -> str:
        if value is None or value == '' or value == []:
            return '未分组'
        if _is_user_field(field_meta):
            return _user_group_label(value)
        candidates = _get_choice_candidates(field_meta)
        if candidates:
            for option in candidates:
                if isinstance(option, dict):
                    option_value = _get_choice_value(option)
                    if option_value == value:
                        return str(option_value)
                else:
                    if option == value:
                        return str(option)
        if isinstance(value, list):
            return ', '.join([str(item) for item in value])
        return str(value)

    def build_nodes(tree: Dict[str, Any], level: int) -> List[Dict[str, Any]]:
        group = resolved_groups[level]
        field_meta = group.get('field_meta')
        direction = group.get('direction', 'asc')
        items = _sort_group_tree_items(tree, field_meta, direction)

        nodes: List[Dict[str, Any]] = []
        for _, node in items:
            children = []
            if level + 1 < len(resolved_groups):
                children = build_nodes(node['children'], level + 1)
            nodes.append({
                'group_value': node.get('value'),
                'group_label': get_label(field_meta, node.get('value')),
                'count': node.get('count', 0),
                'children': children,
            })
        return nodes

    return {
        'fields': [
            {
                'field_id': group.get('field_id'),
                'field': group.get('field'),
                'direction': group.get('direction', 'asc'),
            }
            for group in resolved_groups
        ],
        'nodes': build_nodes(root, 0) if resolved_groups else [],
    }


def build_group_metadata_native(
    qb,
    native_io,
    all_fields: List[TableField],
    groups: List[Dict[str, Any]],
    where: Optional[Tuple[str, list]],
    table_id: UUID,
) -> Optional[Dict[str, Any]]:
    """
    使用原生查询构建分组元数据。

    对单层分组使用 SQL GROUP BY 查询，多层分组回退到 Python 聚合。
    """
    from apps.tabdata.native.pg_type_map import is_system_field as _is_sys_field
    from django.db import connections
    from apps.tabdata.constants import TABDATA_DB_ALIAS as DB_ALIAS

    id_map = {str(f.id): f for f in all_fields}
    name_map = {f.name: f for f in all_fields}

    resolved_groups: List[Dict[str, Any]] = []
    for rule in groups[:3]:
        if not isinstance(rule, dict):
            continue
        field_ref = rule.get('field_id') or rule.get('field')
        if not field_ref:
            continue
        field_key = str(field_ref)
        field_meta = id_map.get(field_key) or name_map.get(field_key)
        if not field_meta:
            continue
        field_name = field_meta.name
        direction = rule.get('direction') or rule.get('order') or 'asc'
        resolved_groups.append({
            'field_id': str(field_meta.id),
            'field': field_name,
            'direction': direction if direction in ['asc', 'desc'] else 'asc',
            'field_meta': field_meta,
        })

    if not resolved_groups:
        return None

    group_col_refs = []
    for g in resolved_groups:
        col_ref = qb._resolve_column_ref(g['field_id'])
        if col_ref:
            group_col_refs.append(col_ref)
        else:
            return None

    group_cols_str = ', '.join(group_col_refs)
    where_sql, where_params = where if where else ('TRUE', [])

    sql = (
        f'SELECT {group_cols_str}, COUNT(*) AS __cnt '
        f'FROM {qb.qualified_name} '
        f'WHERE {where_sql} '
        f'GROUP BY {group_cols_str}'
    )

    with connections[DB_ALIAS].cursor() as cursor:
        cursor.execute(sql, where_params)
        col_names = [desc[0] for desc in cursor.description]
        agg_rows = cursor.fetchall()

    from apps.tabdata.native.value_converter import pg_to_python

    root: Dict[str, Any] = {}
    for row_tuple in agg_rows:
        row = dict(zip(col_names, row_tuple))
        count = row.get('__cnt', 0)
        cursor_tree = root
        for i, g in enumerate(resolved_groups):
            col_ref_name = group_col_refs[i].strip('"')
            raw_value = row.get(col_ref_name)
            field_meta = g['field_meta']
            if raw_value is not None and not _is_sys_field(field_meta.field_type):
                raw_value = pg_to_python(raw_value, field_meta.field_type, field_meta.config)
            key = normalize_group_key(raw_value, field_meta)
            cursor_tree = _merge_group_tree_node(
                cursor_tree, key, raw_value, count, field_meta
            )

    def get_label(field_meta_obj, value):
        if value is None or value == '' or value == []:
            return '未分组'
        if _is_user_field(field_meta_obj):
            return _user_group_label(value)
        candidates = _get_choice_candidates(field_meta_obj)
        if candidates:
            for option in candidates:
                if isinstance(option, dict):
                    option_value = _get_choice_value(option)
                    if option_value == value:
                        return str(option_value)
                else:
                    if option == value:
                        return str(option)
        if isinstance(value, list):
            return ', '.join([str(item) for item in value])
        return str(value)

    def build_nodes(tree, level):
        group = resolved_groups[level]
        field_meta_obj = group.get('field_meta')
        direction = group.get('direction', 'asc')
        items = _sort_group_tree_items(tree, field_meta_obj, direction)

        nodes: List[Dict[str, Any]] = []
        for _, node in items:
            children = []
            if level + 1 < len(resolved_groups):
                children = build_nodes(node['children'], level + 1)
            nodes.append({
                'group_value': node.get('value'),
                'group_label': get_label(field_meta_obj, node.get('value')),
                'count': node.get('count', 0),
                'children': children,
            })
        return nodes

    return {
        'fields': [
            {
                'field_id': group.get('field_id'),
                'field': group.get('field'),
                'direction': group.get('direction', 'asc'),
            }
            for group in resolved_groups
        ],
        'nodes': build_nodes(root, 0) if resolved_groups else [],
    }


def apply_view_sorts(
    view: TableView,
    queryset: QuerySet,
    sorts_override: Optional[List[Dict[str, Any]]] = None,
) -> QuerySet:
    """
    应用视图的排序规则

    特性：
    - 每条排序规则仅生成一个 ORDER BY 列
    - Select 字段使用 ARRAY_POSITION 按选项定义顺序排序（非字母序）
    - 空值位置与 native 查询一致，保证降级前后分页顺序稳定
    - 始终追加 `order ASC` 作为兜底排序
    """
    effective_sorts = sorts_override if sorts_override is not None else view.sorts
    if not effective_sorts:
        return queryset.order_by('order', '-created_at')

    id_map, name_map = _get_field_maps_fn(view)

    order_clauses: list = []
    has_order_field = False

    for sort_rule in effective_sorts:
        if not isinstance(sort_rule, dict):
            continue

        field_ref = sort_rule.get('field_id') or sort_rule.get('field')
        direction = str(sort_rule.get('direction') or sort_rule.get('order') or 'asc').strip().lower()
        if direction not in ('asc', 'desc'):
            direction = 'asc'

        if not field_ref:
            continue

        field_key = str(field_ref)

        if field_key in ('created_at', 'updated_at', 'order'):
            if field_key == 'order':
                has_order_field = True
            order_clauses.append(f'-{field_key}' if direction == 'desc' else field_key)
            continue

        field_meta = id_map.get(field_key) or name_map.get(field_key)
        sort_key = str(field_meta.id) if field_meta else field_key
        if field_meta and field_meta.field_type == 'select':
            choice_values = _get_choice_values(field_meta)

            if choice_values:
                placeholders = ', '.join(['%s'] * len(choice_values))
                sql = (
                    f'ARRAY_POSITION(ARRAY[{placeholders}], '
                    f'"data"->>%s)'
                )
                order_clauses.append(
                    _order_raw_sql(
                        sql,
                        [*choice_values, sort_key],
                        direction,
                        always_nulls_last=True,
                    )
                )
            else:
                sql = '"data"->>%s'
                order_clauses.append(
                    _order_raw_sql(sql, [sort_key], direction, always_nulls_last=True)
                )

        elif field_meta and field_meta.field_type == 'multi_select':
            choice_values = _get_choice_values(field_meta)

            if choice_values:
                placeholders = ', '.join(['%s'] * len(choice_values))
                sql = (
                    f'ARRAY_POSITION(ARRAY[{placeholders}]::text[], '
                    f'("data"->%s->>0))'
                )
                order_clauses.append(_order_raw_sql(sql, [*choice_values, sort_key], direction))
            else:
                sql = (
                    'COALESCE(jsonb_array_length("data"->%s), 0)'
                )
                order_clauses.append(_order_raw_sql(sql, [sort_key], direction))

        elif field_meta and field_meta.field_type in ('number', 'percent', 'currency'):
            sql = '("data"->>%s)::numeric'
            order_clauses.append(_order_raw_sql(sql, [sort_key], direction))

        elif field_meta and field_meta.field_type == 'date':
            sql = '("data"->>%s)::timestamptz'
            order_clauses.append(_order_raw_sql(sql, [sort_key], direction))

        elif field_meta and field_meta.field_type == 'checkbox':
            sql = (
                f"CASE WHEN LOWER(\"data\"->>%s) IN ('true','1','yes','on') "
                f"THEN 1 ELSE 0 END"
            )
            order_clauses.append(_order_raw_sql(sql, [sort_key], direction))

        elif field_meta and field_meta.field_type == 'rating':
            sql = '("data"->>%s)::numeric'
            order_clauses.append(_order_raw_sql(sql, [sort_key], direction))

        elif field_meta and field_meta.field_type in ('created_time', 'last_modified_time'):
            _SYS_TIME_SORT_MAP = {
                'created_time': 'created_at',
                'last_modified_time': 'updated_at',
            }
            model_col = _SYS_TIME_SORT_MAP[field_meta.field_type]
            order_clauses.append(f'-{model_col}' if direction == 'desc' else model_col)

        else:
            sql = '"data"->>%s'
            order_clauses.append(_order_raw_sql(sql, [sort_key], direction))

    if not order_clauses:
        return queryset.order_by('order', '-created_at')

    if not has_order_field:
        order_clauses.append('order')

    return queryset.order_by(*order_clauses)


def build_group_sort_prefix(
    groups: List[Dict[str, Any]],
) -> Tuple[List[Dict[str, Any]], set]:
    """从 groups 规则中构建排序前缀和 field_id 集合。"""
    prefix: List[Dict[str, Any]] = []
    ids: set = set()
    for grp in groups[:3]:
        if not isinstance(grp, dict):
            continue
        gfid = grp.get('field_id') or grp.get('field')
        if not gfid:
            continue
        gdir = grp.get('direction') or grp.get('order') or 'asc'
        prefix.append({'field_id': str(gfid), 'direction': gdir})
        ids.add(str(gfid))
    return prefix, ids


def merge_group_and_user_sorts(
    groups: Optional[List[Dict[str, Any]]],
    sorts: Optional[List[Dict[str, Any]]],
) -> Optional[List[Dict[str, Any]]]:
    """Put group ordering first, then retain non-duplicate user sorts."""
    user_sorts = list(sorts) if sorts else []
    if not groups:
        return user_sorts or None

    group_sort_prefix, grouped_field_ids = build_group_sort_prefix(groups)
    deduplicated_user_sorts = [
        sort
        for sort in user_sorts
        if str(sort.get('field_id') or sort.get('field') or '') not in grouped_field_ids
    ]
    return group_sort_prefix + deduplicated_user_sorts
