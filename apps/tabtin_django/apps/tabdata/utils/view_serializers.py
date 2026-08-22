"""视图序列化与 columnMeta 兼容辅助函数。"""
from __future__ import annotations

import math
from typing import Any, Dict, Iterable, List, Optional

from apps.tabdata.constants import TABDATA_DB_ALIAS
from apps.tabdata.models import TableField, TableView

_COLUMN_META_EXTENSION_CONFIG_KEY = 'column_meta_ext'
_COLUMN_META_CORE_KEYS = {'order', 'hidden', 'visible', 'width'}

_VISIBLE_SEMANTIC_VIEW_TYPES = {'kanban', 'gallery', 'calendar', 'form'}
_HIDDEN_SEMANTIC_VIEW_TYPES = {'grid', 'list', 'plugin'}


def _resolve_visibility_mode(view_type: Optional[str]) -> Optional[str]:
    normalized = str(view_type or '').strip().lower()
    if not normalized:
        return None
    if normalized in _VISIBLE_SEMANTIC_VIEW_TYPES:
        return 'visible'
    if normalized in _HIDDEN_SEMANTIC_VIEW_TYPES:
        return 'hidden'
    return None


def _normalize_field_ids(
    raw_values: Iterable[Any],
    *,
    id_to_name: Dict[str, str],
    name_to_id: Dict[str, str],
) -> List[str]:
    normalized: List[str] = []
    seen: set[str] = set()

    for raw in raw_values:
        key = str(raw)
        if not key:
            continue

        field_id = key if key in id_to_name else name_to_id.get(key)
        if not field_id or field_id in seen:
            continue

        seen.add(field_id)
        normalized.append(field_id)

    return normalized


def _normalize_meta_map(
    raw_meta_map: Optional[Dict[str, Any]],
    *,
    id_to_name: Dict[str, str],
    name_to_id: Dict[str, str],
) -> Dict[str, Dict[str, Any]]:
    if not isinstance(raw_meta_map, dict):
        return {}

    normalized: Dict[str, Dict[str, Any]] = {}
    for raw_key, raw_meta in raw_meta_map.items():
        key = str(raw_key or '')
        if not key:
            continue
        field_id = key if key in id_to_name else name_to_id.get(key)
        if not field_id:
            continue
        if raw_meta is None:
            normalized[field_id] = {}
            continue
        if isinstance(raw_meta, dict):
            normalized[field_id] = dict(raw_meta)
    return normalized


def _normalize_order(value: Any, fallback: float) -> float:
    if isinstance(value, bool):
        return fallback
    if isinstance(value, (int, float)) and math.isfinite(float(value)):
        return float(value)
    return fallback


def _normalize_width(value: Any) -> Optional[int]:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)) and math.isfinite(float(value)):
        width = int(value)
        if width > 0:
            return width
    return None


def _resolve_visible_by_meta(
    meta: Dict[str, Any],
    *,
    use_visible: bool,
    use_hidden: bool,
) -> bool:
    if use_visible:
        if "visible" in meta:
            return bool(meta.get("visible"))
        if "hidden" in meta:
            return not bool(meta.get("hidden"))
        return True
    if use_hidden:
        if "hidden" in meta:
            return not bool(meta.get("hidden", False))
        if "visible" in meta:
            return bool(meta.get("visible"))
        return True
    return True


def get_visible_field_ids_from_column_meta(
    column_meta: Dict[str, Dict[str, Any]],
    valid_field_ids: Optional[set] = None,
) -> set:
    """从 column_meta 中提取可见字段 ID 集合。"""
    visible = set()
    for field_id, meta in column_meta.items():
        if valid_field_ids and field_id not in valid_field_ids:
            continue
        is_visible_flag = meta.get('visible')
        if is_visible_flag is not None:
            if is_visible_flag:
                visible.add(field_id)
        elif not meta.get('hidden', False):
            visible.add(field_id)
    return visible


def _build_view_column_meta_from_compat(
    *,
    view: TableView,
    fields: List[TableField],
    id_to_name: Dict[str, str],
    name_to_id: Dict[str, str],
) -> Dict[str, Dict[str, Any]]:
    all_field_ids = list(id_to_name.keys())

    visible_field_ids = _normalize_field_ids(
        view.visible_fields or [],
        id_to_name=id_to_name,
        name_to_id=name_to_id,
    )
    if not visible_field_ids:
        visible_field_ids = list(all_field_ids)
    visible_field_set = set(visible_field_ids)

    order_source = view.field_order or all_field_ids
    ordered_all_ids = _normalize_field_ids(
        order_source,
        id_to_name=id_to_name,
        name_to_id=name_to_id,
    )

    appended = set(ordered_all_ids)
    for field_id in all_field_ids:
        if field_id not in appended:
            ordered_all_ids.append(field_id)
            appended.add(field_id)

    widths: Dict[str, Any] = {}
    extension_meta_by_field_id: Dict[str, Dict[str, Any]] = {}
    if isinstance(view.config, dict):
        raw_widths = view.config.get('column_widths')
        if isinstance(raw_widths, dict):
            widths = raw_widths
        raw_extensions = view.config.get(_COLUMN_META_EXTENSION_CONFIG_KEY)
        if isinstance(raw_extensions, dict):
            for raw_key, raw_extension in raw_extensions.items():
                if not isinstance(raw_extension, dict):
                    continue
                field_id = str(raw_key)
                if field_id not in id_to_name:
                    field_id = name_to_id.get(field_id) or ''
                if not field_id:
                    continue
                extension_meta = {
                    str(meta_key): meta_value
                    for meta_key, meta_value in raw_extension.items()
                    if str(meta_key) not in _COLUMN_META_CORE_KEYS
                }
                if extension_meta:
                    extension_meta_by_field_id[field_id] = extension_meta

    visibility_mode = _resolve_visibility_mode(getattr(view, 'view_type', None))
    use_visible = visibility_mode == 'visible'
    use_hidden = visibility_mode == 'hidden'

    column_meta: Dict[str, Dict[str, Any]] = {}
    next_order = 0
    for field_id in ordered_all_ids:
        field_name = id_to_name.get(field_id)
        width_value = widths.get(field_id)
        if width_value is None and field_name:
            width_value = widths.get(field_name)

        meta: Dict[str, Any] = {"order": next_order}
        is_visible = field_id in visible_field_set

        if use_visible:
            meta["visible"] = is_visible
        elif use_hidden:
            if not is_visible:
                meta["hidden"] = True
        else:
            if is_visible:
                meta["visible"] = True
            else:
                meta["hidden"] = True

        width = _normalize_width(width_value)
        if width is not None:
            meta["width"] = width

        extension_meta = extension_meta_by_field_id.get(field_id)
        if extension_meta:
            meta.update(extension_meta)

        column_meta[field_id] = meta
        next_order += 1

    return column_meta


def build_view_column_meta(
    view: TableView,
    table_fields: Optional[Iterable[TableField]] = None,
    *,
    prefer_persisted: bool = True,
) -> Dict[str, Dict[str, Any]]:
    """
    根据当前视图结构生成 columnMeta。

    - prefer_persisted=True: 以 view.column_meta 为真源，兼容回填缺失字段。
    - prefer_persisted=False: 强制按 visible_fields/field_order/config 重新生成。
    """
    if table_fields is None:
        fields = list(
            TableField.objects.using(TABDATA_DB_ALIAS).filter(
                table_id=view.table_id,
                is_deleted=False,
            )
            .only('id', 'name')
            .order_by('order')
        )
    else:
        fields = list(table_fields)

    if not fields:
        return {}

    id_to_name = {str(field.id): field.name for field in fields}
    name_to_id = {field.name: str(field.id) for field in fields}
    all_field_ids = list(id_to_name.keys())
    default_order_map = {field_id: index for index, field_id in enumerate(all_field_ids)}

    compat_column_meta = _build_view_column_meta_from_compat(
        view=view,
        fields=fields,
        id_to_name=id_to_name,
        name_to_id=name_to_id,
    )
    if not prefer_persisted:
        return compat_column_meta

    persisted_column_meta = _normalize_meta_map(
        getattr(view, 'column_meta', None),
        id_to_name=id_to_name,
        name_to_id=name_to_id,
    )
    if not persisted_column_meta:
        return compat_column_meta

    visibility_mode = _resolve_visibility_mode(getattr(view, 'view_type', None))
    if visibility_mode is None:
        use_visible = any("visible" in meta for meta in persisted_column_meta.values())
        use_hidden = any("hidden" in meta for meta in persisted_column_meta.values()) and not use_visible
    else:
        use_visible = visibility_mode == 'visible'
        use_hidden = visibility_mode == 'hidden'

    merged_meta: Dict[str, Dict[str, Any]] = {}
    for field_id in all_field_ids:
        base_meta = compat_column_meta.get(field_id, {})
        persisted_meta = persisted_column_meta.get(field_id, {})
        # 当 persisted 存在时，以 persisted 为准决定可见性；先清除 base 中的旧标记
        if persisted_meta:
            base_meta = {k: v for k, v in base_meta.items() if k not in ('hidden', 'visible')}
        raw_meta = {**base_meta, **persisted_meta}

        resolved_order = _normalize_order(
            raw_meta.get("order"),
            fallback=float(base_meta.get("order", default_order_map.get(field_id, 0))),
        )
        if resolved_order.is_integer():
            order_value: Any = int(resolved_order)
        else:
            order_value = resolved_order

        width_value = None
        if "width" in persisted_meta:
            width_value = _normalize_width(persisted_meta.get("width"))
        if width_value is None:
            width_value = _normalize_width(base_meta.get("width"))

        is_visible = _resolve_visible_by_meta(
            raw_meta,
            use_visible=use_visible,
            use_hidden=use_hidden,
        )

        canonical_meta: Dict[str, Any] = {"order": order_value}
        if use_visible:
            canonical_meta["visible"] = is_visible
        elif use_hidden:
            if not is_visible:
                canonical_meta["hidden"] = True
        else:
            if is_visible:
                canonical_meta["visible"] = True
            else:
                canonical_meta["hidden"] = True

        if width_value is not None:
            canonical_meta["width"] = width_value

        extension_meta = {
            str(meta_key): meta_value
            for meta_key, meta_value in raw_meta.items()
            if str(meta_key) not in _COLUMN_META_CORE_KEYS
        }
        if extension_meta:
            canonical_meta.update(extension_meta)

        merged_meta[field_id] = canonical_meta

    ordered_field_ids = sorted(
        all_field_ids,
        key=lambda field_id: (
            _normalize_order(merged_meta.get(field_id, {}).get("order"), float(default_order_map[field_id])),
            default_order_map[field_id],
        ),
    )

    return {field_id: merged_meta[field_id] for field_id in ordered_field_ids}


def build_view_column_meta_payload(
    view: TableView,
    table_fields: Optional[Iterable[TableField]] = None,
    *,
    include_legacy_alias: bool = True,
    prefer_persisted: bool = True,
) -> Dict[str, Dict[str, Any]]:
    """
    构建视图列元数据响应字段。

    内部统一以 `column_meta` 为主；`columnMeta` 仅在 API 边界兼容输出。
    """
    column_meta = build_view_column_meta(
        view,
        table_fields=table_fields,
        prefer_persisted=prefer_persisted,
    )
    payload: Dict[str, Dict[str, Any]] = {
        'column_meta': column_meta,
    }
    if include_legacy_alias:
        payload['columnMeta'] = column_meta
    return payload


def parse_view_column_meta(
    column_meta: Optional[Dict[str, Any]],
    *,
    table_fields: Iterable[TableField],
    base_column_meta: Optional[Dict[str, Dict[str, Any]]] = None,
    view_type: Optional[str] = None,
) -> Dict[str, Any]:
    """
    将 columnMeta 反解为当前系统使用的视图配置字段：
    - visible_fields
    - field_order
    - config.column_widths
    """
    fields = list(table_fields)
    if not fields:
        return {
            "visible_fields": [],
            "field_order": [],
            "column_widths": {},
            "column_meta": {},
            _COLUMN_META_EXTENSION_CONFIG_KEY: {},
        }

    id_to_name = {str(field.id): field.name for field in fields}
    name_to_id = {field.name: str(field.id) for field in fields}
    all_field_ids = list(id_to_name.keys())
    default_order_map = {field_id: index for index, field_id in enumerate(all_field_ids)}

    merged_meta: Dict[str, Dict[str, Any]] = {
        field_id: {"order": index}
        for index, field_id in enumerate(all_field_ids)
    }

    base_map = _normalize_meta_map(
        base_column_meta,
        id_to_name=id_to_name,
        name_to_id=name_to_id,
    )
    for field_id, meta in base_map.items():
        merged_meta[field_id] = {**merged_meta.get(field_id, {}), **meta}

    incoming_map = _normalize_meta_map(
        column_meta,
        id_to_name=id_to_name,
        name_to_id=name_to_id,
    )
    for field_id, meta in incoming_map.items():
        existing = merged_meta.get(field_id, {})
        patch_has_visibility = 'hidden' in meta or 'visible' in meta
        if patch_has_visibility:
            existing.pop('hidden', None)
            existing.pop('visible', None)
        merged_meta[field_id] = {**existing, **meta}

    visibility_mode = _resolve_visibility_mode(view_type)
    if visibility_mode is None:
        use_visible = any("visible" in meta for meta in merged_meta.values())
        use_hidden = any("hidden" in meta for meta in merged_meta.values()) and not use_visible
    else:
        use_visible = visibility_mode == 'visible'
        use_hidden = visibility_mode == 'hidden'

    def _resolve_order(field_id: str) -> float:
        meta = merged_meta.get(field_id, {})
        raw_order = meta.get("order")
        return _normalize_order(raw_order, float(default_order_map[field_id]))

    ordered_field_ids = sorted(
        all_field_ids,
        key=lambda field_id: (_resolve_order(field_id), default_order_map[field_id]),
    )

    visible_field_ids: List[str] = []
    for field_id in ordered_field_ids:
        meta = merged_meta.get(field_id, {})
        is_visible = _resolve_visible_by_meta(
            meta,
            use_visible=use_visible,
            use_hidden=use_hidden,
        )
        if is_visible:
            visible_field_ids.append(field_id)
    visible_field_set = set(visible_field_ids)

    column_widths: Dict[str, int] = {}
    extension_meta_by_field_id: Dict[str, Dict[str, Any]] = {}
    normalized_column_meta: Dict[str, Dict[str, Any]] = {}

    visibility_mode = _resolve_visibility_mode(view_type)
    canonical_use_visible = visibility_mode == 'visible' or (visibility_mode is None and use_visible)
    canonical_use_hidden = visibility_mode == 'hidden' or (visibility_mode is None and use_hidden)

    order_map = {
        field_id: _resolve_order(field_id)
        for field_id in ordered_field_ids
    }
    for field_id, order in order_map.items():
        if order.is_integer():
            order_map[field_id] = int(order)

    for field_id, meta in merged_meta.items():
        width = _normalize_width(meta.get("width"))
        if width is not None:
            column_widths[field_id] = width

        extension_meta = {
            str(meta_key): meta_value
            for meta_key, meta_value in meta.items()
            if str(meta_key) not in _COLUMN_META_CORE_KEYS
        }
        if extension_meta:
            extension_meta_by_field_id[field_id] = extension_meta

    for field_id in ordered_field_ids:
        meta: Dict[str, Any] = {
            "order": order_map[field_id],
        }
        is_visible = field_id in visible_field_set

        if canonical_use_visible:
            meta["visible"] = is_visible
        elif canonical_use_hidden:
            if not is_visible:
                meta["hidden"] = True
        else:
            if is_visible:
                meta["visible"] = True
            else:
                meta["hidden"] = True

        width = column_widths.get(field_id)
        if width is not None:
            meta["width"] = width

        extension_meta = extension_meta_by_field_id.get(field_id)
        if extension_meta:
            meta.update(extension_meta)

        normalized_column_meta[field_id] = meta

    return {
        "visible_fields": visible_field_ids,
        "field_order": ordered_field_ids,
        "column_widths": column_widths,
        "column_meta": normalized_column_meta,
        _COLUMN_META_EXTENSION_CONFIG_KEY: extension_meta_by_field_id,
    }
