"""TabData 字段默认值的统一校验与解析。"""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
from typing import Any, Iterable, Mapping, MutableMapping, Optional
from uuid import UUID
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from apps.tabdata.utils.field_types import format_field_value, validate_field_value


LITERAL_FIELD_TYPES = frozenset({
    "text", "long_text", "number",
    "select", "multi_select", "checkbox", "date", "user",
})
LEGACY_IGNORED_LITERAL_FIELD_TYPES = frozenset({"percent", "currency"})
TIME_FIELD_TYPES = frozenset({"date"})


def get_effective_default_value(
    field_type: str,
    default_value: Any,
) -> Any:
    """Return the runtime default after applying retired-field compatibility."""
    if (
        field_type in LEGACY_IGNORED_LITERAL_FIELD_TYPES
        and isinstance(default_value, Mapping)
        and default_value.get("mode") == "literal"
    ):
        return None
    return deepcopy(default_value)


def _dynamic_time_value(field: Any, now: datetime) -> str:
    """Return a dynamic time default in the field's storage shape."""
    if getattr(field, "field_type", None) != "date":
        return now.isoformat()

    config = getattr(field, "config", None) or {}
    formatting = config.get("formatting") if isinstance(config, Mapping) else None
    formatting = formatting if isinstance(formatting, Mapping) else {}
    time_format = formatting.get("time")
    if isinstance(time_format, str) and time_format != "None":
        return now.isoformat()

    time_zone = formatting.get("timeZone") or "UTC"
    try:
        target_zone = ZoneInfo(str(time_zone))
    except (ZoneInfoNotFoundError, ValueError):
        target_zone = timezone.utc
    aware_now = now if now.tzinfo is not None else now.replace(tzinfo=timezone.utc)
    return aware_now.astimezone(target_zone).date().isoformat()


def validate_default_value(
    field_type: str,
    default_value: Optional[Mapping[str, Any]],
    options: Optional[Mapping[str, Any]] = None,
) -> Optional[dict[str, Any]]:
    """校验并复制字段默认值配置；``None`` 表示未配置。"""
    if default_value is None:
        return None
    if not isinstance(default_value, Mapping):
        raise ValueError("默认值必须是对象或 null")

    mode = default_value.get("mode")
    if mode == "literal":
        if "value" not in default_value:
            raise ValueError("固定默认值缺少 value")
        # Older clients may still send numeric defaults for these field types.
        # Accept the legacy request shape, but normalize it away so the removed
        # product capability cannot be persisted or applied to new records.
        if field_type in LEGACY_IGNORED_LITERAL_FIELD_TYPES:
            return None
        if field_type not in LITERAL_FIELD_TYPES:
            raise ValueError(f"{field_type} 字段不支持固定默认值")
        value = default_value["value"]
        if not validate_field_value(field_type, value, dict(options or {})):
            raise ValueError("默认值与字段类型或字段选项不兼容")
        if field_type == "user":
            values = value if isinstance(value, list) else [value]
            user_ids = [item.get("id") if isinstance(item, Mapping) else item for item in values]
            try:
                normalized_ids = {str(UUID(str(user_id))) for user_id in user_ids}
            except (TypeError, ValueError, AttributeError) as exc:
                raise ValueError("人员默认值必须保存真实用户 ID") from exc
            from django.contrib.auth import get_user_model
            existing_ids = {
                str(item)
                for item in get_user_model().objects.filter(id__in=normalized_ids).values_list("id", flat=True)
            }
            if existing_ids != normalized_ids:
                raise ValueError("人员默认值包含不存在的用户")
        return {"mode": "literal", "value": deepcopy(value)}

    if mode in {"created_time", "last_modified_time"}:
        if field_type not in TIME_FIELD_TYPES:
            raise ValueError("动态时间默认值仅支持日期或日期时间字段")
        return {"mode": mode}

    if mode == "creator":
        if field_type != "user":
            raise ValueError("创建者默认值仅支持人员字段")
        return {"mode": "creator"}

    raise ValueError("不支持的默认值模式")


def apply_record_defaults(
    data: MutableMapping[str, Any],
    fields: Iterable[Any],
    *,
    is_create: bool,
    actor_id: Optional[str] = None,
    now: Optional[datetime] = None,
) -> MutableMapping[str, Any]:
    """对已规范化为字段 ID key 的数据注入默认值。

    普通默认值只补缺省字段；显式空值不会被覆盖。最后更新时间是唯一例外，
    创建和更新都会覆盖用户输入。写入 key 延续记录链路当前的 UUID hex 约定。
    """
    current_time = now or datetime.now(timezone.utc)
    for field in fields:
        spec = get_effective_default_value(
            field.field_type,
            getattr(field, "default_value", None),
        )
        if not isinstance(spec, Mapping):
            continue
        mode = spec.get("mode")
        time_value = _dynamic_time_value(field, current_time)
        dashed_key = str(field.id)
        hex_key = getattr(field.id, "hex", dashed_key.replace("-", ""))
        present = dashed_key in data or hex_key in data

        if mode == "last_modified_time":
            data.pop(dashed_key, None)
            data[hex_key] = time_value
        elif is_create and not present and mode == "created_time":
            data[hex_key] = time_value
        elif is_create and not present and mode == "creator" and actor_id:
            config = getattr(field, "config", None) or {}
            multiple = bool(
                getattr(field, "is_multiple_cell_value", False)
                or config.get("multiple")
            )
            data[hex_key] = [actor_id] if multiple else actor_id
        elif (
            is_create
            and not present
            and mode == "literal"
            and field.field_type in LITERAL_FIELD_TYPES
            and "value" in spec
        ):
            data[hex_key] = format_field_value(
                field.field_type,
                deepcopy(spec["value"]),
                getattr(field, "config", None),
            )
    return data


def reconcile_select_default(
    default_value: Optional[Mapping[str, Any]],
    old_choices: Iterable[Any],
    new_choices: Iterable[Any],
    *,
    multiple: bool,
) -> Optional[dict[str, Any]]:
    """选项重命名或删除后同步固定默认值。"""
    if not isinstance(default_value, Mapping) or default_value.get("mode") != "literal":
        return deepcopy(default_value) if default_value is not None else None
    from apps.tabdata.utils.choice_utils import build_select_choice_value_renames

    renames = build_select_choice_value_renames(old_choices, new_choices)
    allowed = {
        item.get("value") if isinstance(item, Mapping) else item
        for item in new_choices
    }
    raw = default_value.get("value")
    if multiple:
        values = raw if isinstance(raw, list) else []
        reconciled = [renames.get(value, value) for value in values]
        return {"mode": "literal", "value": [v for v in reconciled if v in allowed]}
    value = renames.get(raw, raw)
    return {"mode": "literal", "value": value} if value in allowed else None
