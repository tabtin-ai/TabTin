"""
API 路由层共享工具函数

从 api.py 抽取的跨域复用函数，供各 api_*.py 子模块 import。
"""
import json
import hashlib
from typing import Optional, Any, Dict, List, Set, Tuple
from uuid import UUID

from apps.tabdata.constants import DEFAULT_PAGE, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, TABDATA_DB_ALIAS
from apps.tabdata.models import TableField, TableView
from apps.tabdata.utils.view_serializers import build_view_column_meta_payload


def parse_int_param(value: Optional[str]) -> Optional[int]:
    if value in (None, '', 'null', 'undefined'):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def normalize_filter_logic(value: Optional[str]) -> Optional[str]:
    if value in (None, '', 'null', 'undefined'):
        return None
    logic = str(value).strip().lower()
    if logic in ('and', 'or'):
        return logic
    return None


def normalize_record_field_key_type(value: Optional[str]) -> str:
    """
    统一记录字段 key 类型（兼容 snake_case / camelCase）。
    """
    if value in (None, '', 'null', 'undefined'):
        return 'name'

    normalized = str(value).strip()
    normalized_lower = normalized.lower()

    if normalized_lower == 'id':
        return 'id'
    if normalized_lower == 'name':
        return 'name'
    if normalized_lower in ('dbfieldname', 'db_field_name'):
        return 'dbFieldName'

    return 'name'


def parse_if_none_match_etag(value: Optional[str]) -> tuple[Optional[int], Optional[str]]:
    """
    解析 If-None-Match：
    - 兼容旧格式："<version>"
    - 新格式："<version>:<query_signature>"
    """
    if value in (None, '', 'null', 'undefined'):
        return None, None

    raw = str(value).strip()
    if raw.startswith('W/'):
        raw = raw[2:]
    raw = raw.strip().strip('"').strip("'")
    if not raw:
        return None, None

    if ':' in raw:
        version_raw, signature = raw.split(':', 1)
        return parse_int_param(version_raw), (signature or None)

    return parse_int_param(raw), None


def build_view_records_query_signature(payload: dict[str, Any]) -> str:
    canonical = json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(',', ':'),
        default=str,
    )
    return hashlib.sha256(canonical.encode('utf-8')).hexdigest()[:16]


def build_view_records_etag(latest_version: int, query_signature: str) -> str:
    return f'"{int(latest_version)}:{query_signature}"'


def sanitize_pagination_params(
    page_raw: Optional[str],
    page_size_raw: Optional[str],
) -> tuple[int, int]:
    page = parse_int_param(page_raw) or DEFAULT_PAGE
    page_size = parse_int_param(page_size_raw) or DEFAULT_PAGE_SIZE

    page = max(DEFAULT_PAGE, page)
    page_size = max(1, min(MAX_PAGE_SIZE, page_size))

    return page, page_size


def serialize_view_payload(view: TableView) -> dict[str, Any]:
    return {
        "id": str(view.id),
        "table_id": str(view.table.id),
        "name": view.name,
        "view_type": view.view_type,
        "description": view.description or "",
        "created_by_id": str(view.created_by.id) if view.created_by else "",
        "filter": view.filter,
        "filters": view.filters,
        "sorts": view.sorts,
        "groups": view.groups,
        "visible_fields": view.visible_fields,
        "field_order": view.field_order,
        **build_view_column_meta_payload(view),
        "config": view.config,
        "config_rev": getattr(view, "config_rev", 0) or 0,
        "is_shared": view.is_shared,
        "is_locked": view.is_locked,
        "order": view.order,
        "created_at": view.created_at.isoformat() if view.created_at else "",
        "updated_at": view.updated_at.isoformat() if view.updated_at else "",
    }


def _build_valid_field_keys(table_id: UUID) -> Set[str]:
    """加载表的所有有效字段，返回可接受的 key 集合（name / id / db_field_name）。"""
    fields = list(
        TableField.objects.using(TABDATA_DB_ALIAS)
        .filter(table_id=table_id, is_deleted=False)
    )
    keys: Set[str] = set()
    for f in fields:
        keys.add(f.name)
        keys.add(str(f.id))
        db_key = (f.config or {}).get('db_field_name')
        if db_key:
            keys.add(str(db_key))
    return keys


def strip_unknown_fields(
    fields_data: Dict[str, Any],
    valid_keys: Set[str],
) -> Tuple[Dict[str, Any], List[str]]:
    """
    过滤掉不在 valid_keys 中的字段 key。

    Returns:
        (cleaned_data, unknown_keys)
    """
    cleaned: Dict[str, Any] = {}
    unknown: List[str] = []
    for key, value in fields_data.items():
        if key in valid_keys:
            cleaned[key] = value
        else:
            unknown.append(key)
    return cleaned, unknown
