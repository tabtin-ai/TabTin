"""
记录过滤工具 — 从 data_query.py 提取的纯函数。

用于在已加载的记录列表上做内存过滤（按字段 ID/名称/序号 + 运算符 + 值）。
依赖 TabData 字段模型做名称/序号→ID 解析。
"""

from __future__ import annotations

import logging
import uuid as _uuid
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# 字段解析
# ---------------------------------------------------------------------------

def _looks_like_uuid(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    try:
        _uuid.UUID(value)
        return True
    except ValueError:
        return False


def _resolve_field_info_by_index(
    table_id: Optional[str], index: Any
) -> Optional[Dict[str, str]]:
    if not table_id:
        return None
    try:
        idx = int(index)
    except (TypeError, ValueError):
        return None
    if idx <= 0:
        return None
    try:
        from apps.tabdata.models import TableField

        field_ids = list(
            TableField.objects.filter(table_id=table_id, is_deleted=False)
            .order_by("order", "created_at")
            .values_list("id", "name")
        )
        if idx <= len(field_ids):
            field_id, field_name = field_ids[idx - 1]
            return {"id": str(field_id), "name": field_name}
    except Exception as exc:
        logger.warning("[filter_utils] Field index parsing failed: %s", exc)
    return None


def _resolve_field_info_by_name(
    table_id: Optional[str], name: Any
) -> Optional[Dict[str, str]]:
    if not table_id or not isinstance(name, str) or not name.strip():
        return None
    try:
        from apps.tabdata.models import TableField

        field = (
            TableField.objects.filter(
                table_id=table_id, is_deleted=False, name=name.strip()
            )
            .order_by("order", "created_at")
            .first()
        )
        return {"id": str(field.id), "name": field.name} if field else None
    except Exception as exc:
        logger.warning("[filter_utils] Field name parsing failed: %s", exc)
    return None


def _resolve_field_id_by_index(
    table_id: Optional[str], index: Any
) -> Optional[str]:
    info = _resolve_field_info_by_index(table_id, index)
    return info["id"] if info else None


def _resolve_field_id_by_name(
    table_id: Optional[str], name: Any
) -> Optional[str]:
    info = _resolve_field_info_by_name(table_id, name)
    return info["id"] if info else None


# ---------------------------------------------------------------------------
# 过滤条件归一化
# ---------------------------------------------------------------------------

def normalize_filters(
    filters: Any, *, table_id: Optional[str] = None
) -> Tuple[List[Dict[str, Any]], Optional[Dict[str, Any]]]:
    """将多种过滤条件格式统一为 ``[{"field": id, "operator": op, "value": v}]``。

    支持格式：
    1. ``{"field_id": "value"}``
    2. ``{"column_id": "...", "operator": "=", "value": "..."}``
    3. ``{"field_index": 1, "operator": "=", "value": "..."}``
    4. ``[{"field": "...", "operator": "...", "value": "..."}]``

    Returns:
        (normalized_filters, error_info) — error_info 为 None 表示成功
    """
    if not filters:
        return [], None

    if isinstance(filters, list):
        return _normalize_list(filters, table_id)

    if isinstance(filters, dict):
        return _normalize_dict(filters, table_id)

    return [], {"code": "invalid_filters", "message": "Filter condition cannot be parsed"}


def _normalize_list(
    items: List[Any], table_id: Optional[str]
) -> Tuple[List[Dict[str, Any]], Optional[Dict[str, Any]]]:
    normalized: List[Dict[str, Any]] = []
    errors: List[Dict[str, Any]] = []

    for item in items:
        if not isinstance(item, dict):
            continue
        field_id = item.get("field_id") or item.get("column_id")
        field_name = item.get("field_name") or item.get("name")
        field_raw = item.get("field")
        if field_raw and not _looks_like_uuid(field_raw):
            field_name = field_raw
        elif field_raw:
            field_id = field_id or field_raw
        field_index = (
            item.get("field_index")
            or item.get("column_index")
            or item.get("index")
        )
        index_info = (
            _resolve_field_info_by_index(table_id, field_index)
            if field_index is not None
            else None
        )
        name_info = (
            _resolve_field_info_by_name(table_id, field_name)
            if field_name
            else None
        )
        if (
            field_index is not None
            and field_name
            and index_info
            and name_info
            and index_info["id"] != name_info["id"]
        ):
            errors.append(
                {
                    "field_index": field_index,
                    "field_name": field_name,
                    "index_field": index_info,
                    "name_field": name_info,
                }
            )
            continue
        if not field_id and name_info:
            field_id = name_info["id"]
        if not field_id and field_index is not None:
            field_id = index_info["id"] if index_info else None
        if isinstance(field_id, str) and field_id.isdigit():
            field_id = _resolve_field_id_by_index(table_id, field_id) or field_id
        if not field_id:
            continue
        normalized.append(
            {
                "field": field_id,
                "operator": item.get("operator") or "=",
                "value": item.get("value"),
            }
        )

    if errors:
        return [], {
            "code": "field_mismatch",
            "message": "Field index and field name conflict, please use one",
            "details": errors,
        }
    if not normalized:
        return [], {"code": "invalid_filters", "message": "Filter condition cannot be parsed"}
    return normalized, None


def _normalize_dict(
    filters: Dict[str, Any], table_id: Optional[str]
) -> Tuple[List[Dict[str, Any]], Optional[Dict[str, Any]]]:
    if any(
        k in filters
        for k in (
            "column_id", "field_id", "field_index",
            "field_name", "name", "field",
        )
    ):
        field_id = filters.get("column_id") or filters.get("field_id")
        field_name = filters.get("field_name") or filters.get("name")
        if filters.get("field") and not _looks_like_uuid(filters.get("field")):
            field_name = filters.get("field")
        elif filters.get("field"):
            field_id = field_id or filters.get("field")
        field_index = filters.get("field_index")
        index_info = (
            _resolve_field_info_by_index(table_id, field_index)
            if field_index is not None
            else None
        )
        name_info = (
            _resolve_field_info_by_name(table_id, field_name)
            if field_name
            else None
        )
        if (
            field_index is not None
            and field_name
            and index_info
            and name_info
            and index_info["id"] != name_info["id"]
        ):
            return [], {
                "code": "field_mismatch",
                "message": "Field index and field name conflict, please use one",
                "details": [
                    {
                        "field_index": field_index,
                        "field_name": field_name,
                        "index_field": index_info,
                        "name_field": name_info,
                    }
                ],
            }
        if not field_id and name_info:
            field_id = name_info["id"]
        if not field_id and field_index is not None:
            field_id = index_info["id"] if index_info else None
        if isinstance(field_id, str) and field_id.isdigit():
            field_id = _resolve_field_id_by_index(table_id, field_id) or field_id
        if not field_id:
            return [], {"code": "invalid_filters", "message": "Filter condition cannot be parsed"}
        return [
            {
                "field": field_id,
                "operator": filters.get("operator") or "=",
                "value": filters.get("value"),
            }
        ], None

    return [
        {"field": field_key, "operator": "=", "value": field_value}
        for field_key, field_value in filters.items()
    ], None


# ---------------------------------------------------------------------------
# 值比较
# ---------------------------------------------------------------------------

def compare_values(record_value: Any, target_value: Any, operator: str) -> bool:
    """按运算符比较两个值。"""
    operator = (operator or "=").lower()

    def _normalize(value: Any) -> Any:
        return value.strip() if isinstance(value, str) else value

    record_norm = _normalize(record_value)
    target_norm = _normalize(target_value)

    if operator in ("=", "==", "eq"):
        return record_norm == target_norm
    if operator in ("!=", "neq", "ne"):
        return record_norm != target_norm
    if operator in ("contains", "like", "includes"):
        if record_value is None:
            return False
        if isinstance(record_value, list):
            return any(str(target_norm) in str(_normalize(item)) for item in record_value)
        return str(target_norm) in str(record_norm)
    if operator in (">", ">=", "<", "<="):
        try:
            record_num = float(record_value)
            target_num = float(target_value)
        except (TypeError, ValueError):
            return False
        if operator == ">":
            return record_num > target_num
        if operator == ">=":
            return record_num >= target_num
        if operator == "<":
            return record_num < target_num
        if operator == "<=":
            return record_num <= target_num
    if operator == "in":
        if isinstance(target_value, (list, tuple, set)):
            return record_norm in target_value
        return False

    return record_norm == target_norm


# ---------------------------------------------------------------------------
# 公开入口
# ---------------------------------------------------------------------------

def apply_filters(
    records: List[Dict],
    filters: Any,
    *,
    table_id: Optional[str] = None,
) -> Tuple[List[Dict], Optional[Any]]:
    """对记录列表做内存过滤。

    Returns:
        (filtered_records, error_info) — error_info 为 None 表示成功
    """
    normalized, error_info = normalize_filters(filters, table_id=table_id)
    if error_info:
        return [], error_info
    if not normalized:
        return records, None

    filtered: List[Dict] = []
    for record in records:
        match = True
        for condition in normalized:
            field = condition.get("field")
            value = condition.get("value")
            operator = condition.get("operator", "=")
            if field is None:
                continue
            if not compare_values(record.get(field), value, operator):
                match = False
                break
        if match:
            filtered.append(record)

    return filtered, None


__all__ = [
    "apply_filters",
    "normalize_filters",
    "compare_values",
]
