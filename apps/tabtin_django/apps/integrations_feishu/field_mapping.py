"""飞书多维表字段 → TabData 字段映射（纯函数，无 I/O）。"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

# 飞书字段类型
FEISHU_TYPE_TEXT = 1
FEISHU_TYPE_NUMBER = 2
FEISHU_TYPE_SINGLE_SELECT = 3
FEISHU_TYPE_MULTI_SELECT = 4
FEISHU_TYPE_DATETIME = 5
FEISHU_TYPE_CHECKBOX = 7
FEISHU_TYPE_USER = 11
FEISHU_TYPE_PHONE = 13
FEISHU_TYPE_URL = 15
FEISHU_TYPE_ATTACHMENT = 17
FEISHU_TYPE_SINGLE_LINK = 18
FEISHU_TYPE_DUPLEX_LINK = 21
FEISHU_TYPE_CREATED_TIME = 1001
FEISHU_TYPE_MODIFIED_TIME = 1002
FEISHU_TYPE_CREATED_USER = 1003
FEISHU_TYPE_MODIFIED_USER = 1004
FEISHU_TYPE_AUTO_NUMBER = 1005

# 飞书 field type → TabData field_type（Phase A 可直接建的普通字段）
_TYPE_MAP = {
    FEISHU_TYPE_TEXT: "text",
    FEISHU_TYPE_NUMBER: "number",
    FEISHU_TYPE_SINGLE_SELECT: "select",
    FEISHU_TYPE_MULTI_SELECT: "multi_select",
    FEISHU_TYPE_DATETIME: "date",
    FEISHU_TYPE_CHECKBOX: "checkbox",
    FEISHU_TYPE_USER: "user",
    FEISHU_TYPE_PHONE: "phone",
    FEISHU_TYPE_URL: "url",
    FEISHU_TYPE_ATTACHMENT: "attachment",
    # 源表系统时间/人员字段按普通字段迁移，避免错误绑定到目标表自身的
    # 创建/修改元数据按普通字段迁移。飞书自动编号的规则（前缀、日期、流水段等）
    # 目前无法无损翻译为 TabData 自动编号规则，因此先按文本迁移已有值，避免重写业务编号。
    FEISHU_TYPE_CREATED_TIME: "date",
    FEISHU_TYPE_MODIFIED_TIME: "date",
    FEISHU_TYPE_CREATED_USER: "user",
    FEISHU_TYPE_MODIFIED_USER: "user",
    FEISHU_TYPE_AUTO_NUMBER: "text",
}

# 飞书同一个 ``type`` 会用 ``ui_type`` 区分真实字段语义。例如 Email 与
# Text 都是 type=1，Rating / Progress / Currency 与 Number 都是 type=2。
# 必须先看 ui_type，否则这些 TabData 已原生支持的字段会被错误降级。
_UI_TYPE_MAP = {
    "email": "email",
    "rating": "rating",
    "progress": "percent",
    "currency": "currency",
}


def feishu_type_int(field: Dict[str, Any]) -> Optional[int]:
    try:
        return int(field.get("type")) if field.get("type") is not None else None
    except (TypeError, ValueError):
        return None


def is_link_type(ftype: Optional[int]) -> bool:
    return ftype in (FEISHU_TYPE_SINGLE_LINK, FEISHU_TYPE_DUPLEX_LINK)


def is_attachment_type(ftype: Optional[int]) -> bool:
    return ftype == FEISHU_TYPE_ATTACHMENT


def map_feishu_field_to_tabdata(
    field: Dict[str, Any],
    *,
    defer_link: bool = True,
) -> Optional[Dict[str, Any]]:
    """将飞书字段描述映射为 TabData ``bulk_create_fields`` 入参。

    返回 ``{name, field_type, options?}``。
    - ``defer_link=True``（默认）：Link 字段返回 None（Phase B 再建）
    - 未识别类型降级为 text
    """
    name = (field.get("field_name") or field.get("name") or "未命名字段").strip() or "未命名字段"
    ftype_int = feishu_type_int(field)

    if defer_link and is_link_type(ftype_int):
        return None

    if is_link_type(ftype_int):
        # 需调用方填入 foreignTableId
        return {
            "name": name,
            "field_type": "link",
            "options": {
                "relationship": "ManyMany",
                "isOneWay": ftype_int == FEISHU_TYPE_SINGLE_LINK,
            },
            "_feishu_link": True,
            "_duplex": ftype_int == FEISHU_TYPE_DUPLEX_LINK,
        }

    ui_type = str(field.get("ui_type") or field.get("uiType") or "").strip().lower()
    field_type = _UI_TYPE_MAP.get(ui_type)
    if field_type is None:
        field_type = _TYPE_MAP.get(ftype_int, "text") if ftype_int is not None else "text"
    property_ = field.get("property") or {}
    if ftype_int == FEISHU_TYPE_DATETIME:
        field_type = "date"
    result: Dict[str, Any] = {"name": name, "field_type": field_type}

    if field_type in ("select", "multi_select"):
        choices = _extract_select_choices(property_)
        if choices:
            result["options"] = {"choices": choices}
    elif ftype_int in (
        FEISHU_TYPE_DATETIME,
        FEISHU_TYPE_CREATED_TIME,
        FEISHU_TYPE_MODIFIED_TIME,
    ):
        date_format = str(property_.get("date_formatter") or "").strip()
        result["options"] = {
            "include_time": (
                ftype_int in (FEISHU_TYPE_CREATED_TIME, FEISHU_TYPE_MODIFIED_TIME)
                or "H" in date_format
                or "h" in date_format
            )
        }
        if date_format:
            result["options"]["format"] = date_format
    elif field_type == "rating":
        rating = property_.get("rating") or {}
        options = {}
        if property_.get("max") is not None:
            options["max"] = property_["max"]
        if isinstance(rating, dict) and rating.get("symbol"):
            options["icon"] = rating["symbol"]
        if options:
            result["options"] = options
    elif field_type == "user":
        default_multiple = ftype_int == FEISHU_TYPE_USER
        result["options"] = {
            "multiple": bool(property_.get("multiple", default_multiple))
        }
    elif field_type == "currency":
        options: Dict[str, Any] = {}
        currency_code = str(property_.get("currency_code") or "").strip().upper()
        if currency_code:
            options["symbol"] = _currency_symbol(currency_code)
        precision = _precision_from_formatter(property_.get("formatter"))
        if precision is not None:
            options["precision"] = precision
        if options:
            result["options"] = options

    return result


def _currency_symbol(currency_code: str) -> str:
    """把常见 ISO 币种映射为展示符号；未知币种保留代码，避免误显示为人民币。"""
    return {
        "CNY": "¥",
        "RMB": "¥",
        "USD": "$",
        "EUR": "€",
        "GBP": "£",
        "JPY": "¥",
        "HKD": "HK$",
        "KRW": "₩",
    }.get(currency_code, currency_code)


def _precision_from_formatter(formatter: Any) -> Optional[int]:
    """从飞书数字格式（如 ``#,##0.00``）提取小数位数。"""
    if formatter is None:
        return None
    normalized = str(formatter).strip().rstrip("%")
    if not normalized:
        return None
    if "." not in normalized:
        return 0
    fraction = normalized.rsplit(".", 1)[1]
    return min(sum(char in ("0", "#") for char in fraction), 8)


def _extract_select_choices(property_: Dict[str, Any]) -> List[str]:
    options = property_.get("options") or []
    choices: List[str] = []
    for opt in options:
        if isinstance(opt, dict):
            label = opt.get("name") or opt.get("text") or opt.get("value")
            if label:
                choices.append(str(label))
        elif opt is not None and opt != "":
            choices.append(str(opt))
    return choices


def extract_link_record_ids(value: Any) -> List[str]:
    """从飞书 Link 单元格提取目标 record_id 列表。

    飞书 OpenAPI 常见形态：
    - ``{"link_record_ids": ["recA", "recB"]}``（单向/双向关联主形态）
    - ``[{"record_id": "recA"}, ...]`` / ``["recA", ...]``
    """
    if value is None or value == "":
        return []
    if isinstance(value, list):
        out: List[str] = []
        for item in value:
            if isinstance(item, dict):
                nested = item.get("link_record_ids") or item.get("record_ids")
                if nested is not None:
                    out.extend(extract_link_record_ids(nested))
                    continue
                rid = item.get("record_id") or item.get("id")
                if rid:
                    out.append(str(rid))
            elif isinstance(item, str) and item:
                out.append(item)
        return out
    if isinstance(value, dict):
        nested = value.get("link_record_ids") or value.get("record_ids")
        if nested is not None:
            return extract_link_record_ids(nested)
        rid = value.get("record_id") or value.get("id")
        return [str(rid)] if rid else []
    if isinstance(value, str):
        return [value]
    return []


def extract_attachment_items(value: Any) -> List[Dict[str, Any]]:
    """从飞书附件单元格提取结构化附件描述。"""
    if value is None or value == "":
        return []
    items = value if isinstance(value, list) else [value]
    out: List[Dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        token = item.get("file_token") or item.get("fileToken") or ""
        name = item.get("name") or item.get("file_name") or "attachment"
        if not token and not item.get("tmp_url") and not item.get("url"):
            continue
        out.append(
            {
                "file_token": str(token) if token else "",
                "name": str(name),
                "size": item.get("size") or 0,
                "type": item.get("type") or item.get("mime_type") or "application/octet-stream",
                "tmp_url": item.get("tmp_url") or item.get("url") or "",
            }
        )
    return out


def serialize_feishu_cell_value(value: Any, feishu_type: Optional[int] = None) -> Any:
    """将飞书单元格值转为 TabData 可写入的 Python 值。

    Link / Attachment 返回结构化 spill（不进 bulk 行）；调用方应跳过写入。
    """
    if value is None:
        return None

    if is_link_type(feishu_type):
        return {"__feishu_link_ids": extract_link_record_ids(value)}

    if is_attachment_type(feishu_type):
        return {"__feishu_attachments": extract_attachment_items(value)}

    if feishu_type == FEISHU_TYPE_NUMBER:
        if isinstance(value, (int, float)):
            return value
        try:
            return float(value)
        except (TypeError, ValueError):
            return str(value)

    if feishu_type == FEISHU_TYPE_SINGLE_SELECT:
        if isinstance(value, dict):
            return value.get("name") or value.get("text") or ""
        return str(value) if value != "" else None

    if feishu_type == FEISHU_TYPE_MULTI_SELECT:
        if isinstance(value, list):
            out = []
            for item in value:
                if isinstance(item, dict):
                    out.append(item.get("name") or item.get("text") or str(item))
                else:
                    out.append(str(item))
            return out
        if isinstance(value, dict):
            return [value.get("name") or value.get("text") or str(value)]
        return [str(value)]

    if feishu_type in (
        FEISHU_TYPE_DATETIME,
        FEISHU_TYPE_CREATED_TIME,
        FEISHU_TYPE_MODIFIED_TIME,
    ):
        return _datetime_to_iso(value)

    if feishu_type == FEISHU_TYPE_CHECKBOX:
        return bool(value)

    if feishu_type in (
        FEISHU_TYPE_USER,
        FEISHU_TYPE_CREATED_USER,
        FEISHU_TYPE_MODIFIED_USER,
    ):
        # TabData user 单元格支持带 id/name 的对象或对象列表。保留结构后，
        # 即使飞书 open_id 不是 TabTin 用户 UUID，也能稳定展示原始姓名，
        # 而不是先压成逗号文本、丢失身份信息。
        return value

    if feishu_type == FEISHU_TYPE_URL:
        if isinstance(value, dict):
            return value.get("link") or value.get("text") or ""
        if isinstance(value, list) and value:
            first = value[0]
            if isinstance(first, dict):
                return first.get("link") or first.get("text") or ""
            return str(first)
        return str(value) if value != "" else None

    # Text 及其他：人员等序列化为字符串
    return _coerce_to_text(value)


def link_target_table_ids(field: Dict[str, Any]) -> Tuple[List[str], bool]:
    """解析 Link 字段目标 table_id 与是否双向。"""
    ftype = feishu_type_int(field)
    if not is_link_type(ftype):
        return [], False
    prop = field.get("property") or {}
    targets: List[str] = []
    raw = prop.get("table_id") or prop.get("tableId")
    if isinstance(raw, str) and raw:
        targets.append(raw)
    for key in ("table_ids", "tableIdList", "table_id_list"):
        arr = prop.get(key)
        if isinstance(arr, list):
            for item in arr:
                if isinstance(item, str) and item and item not in targets:
                    targets.append(item)
    return targets, ftype == FEISHU_TYPE_DUPLEX_LINK


def _datetime_to_iso(value: Any) -> Optional[str]:
    if isinstance(value, str):
        return value
    try:
        ts = float(value)
    except (TypeError, ValueError):
        return str(value) if value is not None else None
    if ts > 1e12:
        ts = ts / 1000.0
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()


def _coerce_to_text(value: Any) -> Optional[str]:
    if value is None or value == "":
        return None
    if isinstance(value, str):
        return value
    if isinstance(value, (int, float, bool)):
        return str(value)
    if isinstance(value, list):
        parts = []
        for item in value:
            if isinstance(item, dict):
                text = item.get("text") or item.get("name") or item.get("link")
                if text is None and "id" in item:
                    text = item.get("name") or item.get("en_name") or item.get("id")
                parts.append(str(text) if text is not None else json.dumps(item, ensure_ascii=False))
            else:
                parts.append(str(item))
        return ", ".join(parts) if parts else None
    if isinstance(value, dict):
        for key in ("text", "name", "link", "value"):
            if key in value and value[key] is not None:
                return str(value[key])
        return json.dumps(value, ensure_ascii=False)
    return str(value)
