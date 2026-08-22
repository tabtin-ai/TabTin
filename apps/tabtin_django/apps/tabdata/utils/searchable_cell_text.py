"""
单元格搜索展示文本抽取。

结构化字段（link / user / attachment）落库为带 id 的 JSON；
直接对 data->>'field_id' 做 LIKE 会把 UUID 十六进制数字当成命中。
搜索只应匹配用户可见文本。
"""

from __future__ import annotations

import re
from typing import Any, List, Sequence, Tuple

DISPLAY_KEYS = (
    'title',
    'name',
    'label',
    'filename',
    'file_name',
    'text',
    'displayName',
    'display_name',
)

SKIP_KEYS = frozenset({
    'id',
    'record_id',
    'recordId',
    'field_id',
    'fieldId',
    'user_id',
    'userId',
    'file_token',
    'fileToken',
    'token',
    'url',
    'path',
    'mime',
    'mime_type',
    'mimeType',
    'size',
    'width',
    'height',
    'type',
})

UUID_LIKE_RE = re.compile(
    r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
    re.IGNORECASE,
)

USER_SEARCH_FIELD_TYPES = frozenset({'user', 'created_by', 'last_modified_by'})


def extract_searchable_cell_text(value: Any) -> str:
    """抽取单元格可搜索展示文本（小写、空格拼接）。"""
    parts: List[str] = []
    _collect(value, parts)
    return ' '.join(parts)


def cell_text_matches_search_query(query: str, value: Any) -> bool:
    """查询是否命中单元格展示文本。"""
    q = (query or '').strip().lower()
    if not q:
        return True
    haystack = extract_searchable_cell_text(value)
    if not haystack:
        return False
    if q.isdigit() and UUID_LIKE_RE.match(haystack):
        return False
    return q in haystack


def extract_user_reference_ids(value: Any) -> List[str]:
    """从单选/多人用户字段的标量、对象或数组值中提取 user id。"""
    items = value if isinstance(value, list) else [value]
    result: List[str] = []
    for item in items:
        raw_id = None
        if isinstance(item, str):
            raw_id = item
        elif isinstance(item, (int, float)) and not isinstance(item, bool):
            raw_id = str(item)
        elif isinstance(item, dict):
            raw_id = item.get('id') or item.get('user_id') or item.get('userId')
        if raw_id is None:
            continue
        normalized = str(raw_id).strip()
        if normalized:
            result.append(normalized)
    return result


def user_cell_references_any_id(value: Any, user_ids: Sequence[str]) -> bool:
    """用户字段是否引用候选成员之一；不把 user id 当作展示文本。"""
    if not user_ids:
        return False
    candidates = {str(user_id) for user_id in user_ids}
    return any(user_id in candidates for user_id in extract_user_reference_ids(value))


def resolve_organization_user_ids_by_display_name(
    organization_id: Any,
    query: str,
) -> List[str]:
    """
    在单个 Organization 内按单元格展示名解析候选 user id。

    展示名优先级与客户端成员目录一致：nickname → username → user_id。
    """
    normalized = (query or '').strip()
    if not organization_id or not normalized:
        return []

    from django.db.models import Q
    from apps.tabtinspace.models import OrganizationMember

    nickname_blank = Q(user__nickname__isnull=True) | Q(user__nickname='')
    username_blank = Q(user__username__isnull=True) | Q(user__username='')
    display_name_match = (
        Q(user__nickname__icontains=normalized)
        | (nickname_blank & Q(user__username__icontains=normalized))
        | (nickname_blank & username_blank & Q(user__id__icontains=normalized))
    )
    return [
        str(user_id)
        for user_id in (
            OrganizationMember.objects
            .filter(organization_id=organization_id)
            .filter(display_name_match)
            .values_list('user_id', flat=True)
        )
    ]


def _push(parts: List[str], value: str) -> None:
    trimmed = value.strip()
    if trimmed:
        parts.append(trimmed.lower())


def _collect(value: Any, parts: List[str]) -> None:
    if value is None:
        return
    if isinstance(value, str):
        _push(parts, value)
        return
    if isinstance(value, bool):
        _push(parts, 'true' if value else 'false')
        return
    if isinstance(value, (int, float)):
        _push(parts, str(value))
        return
    if isinstance(value, list):
        for item in value:
            _collect(item, parts)
        return
    if isinstance(value, dict):
        used_display = False
        for key in DISPLAY_KEYS:
            candidate = value.get(key)
            if isinstance(candidate, str) and candidate.strip():
                _push(parts, candidate)
                used_display = True
        if used_display:
            return
        for key, child in value.items():
            if key in SKIP_KEYS:
                continue
            _collect(child, parts)


def build_searchable_jsonb_sql_expr(json_expr: str) -> str:
    """
    构建 PostgreSQL 表达式：从 jsonb 值抽取展示文本（小写）。

    json_expr 须是安全的 jsonb 表达式，例如 ``data->'uuid'`` 或 ``to_jsonb("col")``。
    """
    object_expr = (
        f"COALESCE("
        f"NULLIF({json_expr}->>'title', ''), "
        f"NULLIF({json_expr}->>'name', ''), "
        f"NULLIF({json_expr}->>'label', ''), "
        f"NULLIF({json_expr}->>'filename', ''), "
        f"NULLIF({json_expr}->>'file_name', ''), "
        f"NULLIF({json_expr}->>'text', ''), "
        f"NULLIF({json_expr}->>'displayName', ''), "
        f"NULLIF({json_expr}->>'display_name', ''), "
        f"'')"
    )
    array_elem = (
        "CASE jsonb_typeof(elem) "
        "WHEN 'string' THEN elem#>>'{}' "
        "WHEN 'number' THEN elem#>>'{}' "
        "WHEN 'boolean' THEN elem#>>'{}' "
        "WHEN 'object' THEN COALESCE("
        "NULLIF(elem->>'title', ''), "
        "NULLIF(elem->>'name', ''), "
        "NULLIF(elem->>'label', ''), "
        "NULLIF(elem->>'filename', ''), "
        "NULLIF(elem->>'file_name', ''), "
        "NULLIF(elem->>'text', ''), "
        "NULLIF(elem->>'displayName', ''), "
        "NULLIF(elem->>'display_name', ''), "
        "'') "
        "ELSE '' END"
    )
    array_expr = (
        f"COALESCE(("
        f"SELECT string_agg(part, ' ') "
        f"FROM ("
        f"  SELECT {array_elem} AS part "
        f"  FROM jsonb_array_elements(COALESCE({json_expr}, '[]'::jsonb)) AS elem"
        f") AS extracted "
        f"WHERE part IS NOT NULL AND part <> ''"
        f"), '')"
    )
    return (
        f"LOWER(CASE jsonb_typeof({json_expr}) "
        f"WHEN 'string' THEN COALESCE({json_expr}#>>'{{}}', '') "
        f"WHEN 'number' THEN COALESCE({json_expr}#>>'{{}}', '') "
        f"WHEN 'boolean' THEN COALESCE({json_expr}#>>'{{}}', '') "
        f"WHEN 'object' THEN {object_expr} "
        f"WHEN 'array' THEN {array_expr} "
        f"ELSE COALESCE({json_expr}#>>'{{}}', '') "
        f"END)"
    )


def build_searchable_cell_sql_expr(field_id: str) -> str:
    """从 ``data->field_id`` 抽取展示文本。field_id 须已清洗。"""
    return build_searchable_jsonb_sql_expr(f"data->'{field_id}'")


def build_searchable_column_sql_expr(col_ref: str) -> str:
    """
    从原生列抽取展示文本。

    col_ref 须是已引用的安全列名（如 ``\"abcdef\"``）。
    用 ``to_jsonb(col)`` 统一标量与 jsonb 结构列。
    """
    return build_searchable_jsonb_sql_expr(f"to_jsonb({col_ref})")


def build_user_reference_match_sql(
    json_expr: str,
    user_ids: Sequence[str],
) -> Tuple[str, List[Any]]:
    """
    构建用户字段引用候选 user id 的 PostgreSQL 条件。

    ``json_expr`` 须是安全的 jsonb 表达式；支持字符串、对象及多人数组。
    """
    normalized_ids = [str(user_id) for user_id in user_ids if str(user_id).strip()]
    if not normalized_ids:
        return 'FALSE', []

    sql = (
        f"(CASE jsonb_typeof({json_expr}) "
        f"WHEN 'string' THEN ({json_expr}#>>'{{}}') = ANY(%s::text[]) "
        f"WHEN 'object' THEN COALESCE("
        f"{json_expr}->>'id', {json_expr}->>'user_id', {json_expr}->>'userId'"
        f") = ANY(%s::text[]) "
        f"WHEN 'array' THEN EXISTS ("
        f"  SELECT 1 "
        f"  FROM jsonb_array_elements({json_expr}) AS user_item "
        f"  WHERE (CASE jsonb_typeof(user_item) "
        f"    WHEN 'string' THEN user_item#>>'{{}}' "
        f"    WHEN 'object' THEN COALESCE("
        f"      user_item->>'id', user_item->>'user_id', user_item->>'userId'"
        f"    ) "
        f"    ELSE NULL END"
        f"  ) = ANY(%s::text[])"
        f") "
        f"ELSE FALSE END)"
    )
    return sql, [normalized_ids, normalized_ids, normalized_ids]
