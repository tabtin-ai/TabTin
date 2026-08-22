"""
Python ↔ PostgreSQL 值转换

负责在写入原生列时将 Python 值转换为 PostgreSQL 兼容格式，
以及从原生列读取时将 PostgreSQL 值转换回 API 兼容的 Python 格式。

复用 utils/field_types.py 的验证/格式化逻辑，确保行为一致。
"""

import json
import logging
import math
from datetime import date, datetime
from decimal import Decimal
from typing import Any, Dict, List, Optional
from uuid import UUID

logger = logging.getLogger('tabdata.native.value_converter')

MAX_TEXT_LENGTH = 100 * 1024       # 100KB
MAX_JSONB_SIZE = 1 * 1024 * 1024   # 1MB


def _date_config_preserves_time(config: Optional[Dict] = None) -> bool:
    if not isinstance(config, dict):
        return False
    formatting = config.get('formatting')
    if not isinstance(formatting, dict):
        return False
    time_format = formatting.get('time')
    return isinstance(time_format, str) and time_format != 'None'


# ── 写入转换：Python → PostgreSQL ──

def python_to_pg(value: Any, field_type: str, config: Optional[Dict] = None) -> Any:
    """
    将 Python / JSON 值转换为 PostgreSQL 列的兼容值。

    适用于 INSERT / UPDATE 语句的参数绑定。

    Args:
        value: 从 record.data[field_id] 读取的原始值
        field_type: 字段类型
        config: 字段配置

    Returns:
        PostgreSQL 兼容值（可直接用于 psycopg2 参数绑定）
    """
    if value is None:
        return None

    converter = _PG_WRITE_CONVERTERS.get(field_type)
    if converter:
        return converter(value, config)

    # 默认：原样传递
    return value


def _convert_text(value: Any, config: Optional[Dict] = None) -> Optional[str]:
    """文本类型：确保为字符串，并限制长度不超过 100KB"""
    if value is None or value == '':
        return None if value is None else ''
    text = str(value)
    if len(text) > MAX_TEXT_LENGTH:
        raise ValueError(
            f"文本值长度 {len(text)} 超过上限 {MAX_TEXT_LENGTH} 字节"
        )
    return text


def _convert_number(value: Any, config: Optional[Dict] = None) -> Optional[float]:
    """数字类型：确保为有限 float（拒绝 NaN/Infinity）"""
    if value is None:
        return None
    try:
        v = float(value)
        if not math.isfinite(v):
            return None
        return v
    except (ValueError, TypeError):
        return None


def _convert_rating(value: Any, config: Optional[Dict] = None) -> Optional[int]:
    """评分类型：确保为 int"""
    if value is None:
        return None
    try:
        return int(value)
    except (ValueError, TypeError):
        return None


def _convert_checkbox(value: Any, config: Optional[Dict] = None) -> Optional[bool]:
    """复选框：确保为 bool"""
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.lower() in ('true', '1', 'yes', 'on')
    return bool(value)


def _convert_date(value: Any, config: Optional[Dict] = None) -> Optional[str]:
    """日期：确保为 YYYY-MM-DD 字符串"""
    if value is None:
        return None
    if _date_config_preserves_time(config):
        return _convert_datetime(value, config)
    if isinstance(value, date) and not isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, str):
        # 尝试解析并标准化
        return value[:10] if len(value) >= 10 else value
    return str(value)


def _convert_datetime(value: Any, config: Optional[Dict] = None) -> Optional[str]:
    """日期时间：确保为 ISO 字符串（带时区）"""
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, str):
        # 标准化 Z 后缀
        return value.replace('Z', '+00:00') if value.endswith('Z') else value
    return str(value)


def _check_jsonb_size(value: Any) -> None:
    """校验 JSONB 值序列化后不超过 1MB"""
    serialized = json.dumps(value, ensure_ascii=False) if not isinstance(value, str) else value
    encoded = serialized.encode('utf-8')
    if len(encoded) > MAX_JSONB_SIZE:
        raise ValueError(
            f"JSONB 值大小 {len(encoded)} 字节超过上限 {MAX_JSONB_SIZE} 字节"
        )


def _convert_jsonb(value: Any, config: Optional[Dict] = None) -> Any:
    """
    JSONB 类型：确保为 JSON 可序列化值，限制大小不超过 1MB。

    支持 psycopg3 (psycopg) 和 psycopg2 两种驱动。
    psycopg3 使用 Jsonb adapter，psycopg2 使用 Json adapter。
    """
    if value is None:
        return None

    def _wrap_json(obj):
        """使用当前环境可用的 JSON adapter 包装值"""
        try:
            from psycopg.types.json import Jsonb
            return Jsonb(obj)
        except ImportError:
            from psycopg2.extras import Json
            return Json(obj)

    if isinstance(value, (dict, list)):
        _check_jsonb_size(value)
        return _wrap_json(value)
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            _check_jsonb_size(parsed)
            return _wrap_json(parsed)
        except (json.JSONDecodeError, TypeError):
            _check_jsonb_size(value)
            return _wrap_json(value)
    _check_jsonb_size(value)
    return _wrap_json(value)


def _convert_uuid_ref(value: Any, config: Optional[Dict] = None) -> Optional[str]:
    """UUID 引用（created_by 等）：确保为 UUID 字符串"""
    if value is None:
        return None
    if isinstance(value, UUID):
        return str(value)
    if isinstance(value, dict):
        # user 对象格式 {id: ..., name: ...}
        return str(value.get('id', ''))
    return str(value)


# 写入转换器注册表
_PG_WRITE_CONVERTERS = {
    # 文本
    'text': _convert_text,
    'long_text': _convert_text,
    'url': _convert_text,
    'email': _convert_text,
    'phone': _convert_text,

    # 数值
    'number': _convert_number,
    'percent': _convert_number,
    'currency': _convert_number,
    'rating': _convert_rating,

    # 选择
    'select': _convert_text,
    'checkbox': _convert_checkbox,

    # 日期
    'date': _convert_date,

    # JSONB
    'multi_select': _convert_jsonb,
    'user': _convert_jsonb,
    'attachment': _convert_jsonb,
    'link': _convert_jsonb,
}


# ── 读取转换：PostgreSQL → Python ──

def pg_to_python(value: Any, field_type: str, config: Optional[Dict] = None) -> Any:
    """
    将 PostgreSQL 列值转换回 API 兼容的 Python 值。

    确保返回格式与 JSONField 读取时完全一致，
    保证前端无感（API 响应格式不变）。

    Args:
        value: 从 cursor.fetchone() 获取的原始值
        field_type: 字段类型
        config: 字段配置

    Returns:
        API 兼容的 Python 值
    """
    if value is None:
        return None

    converter = _PG_READ_CONVERTERS.get(field_type)
    if converter:
        return converter(value, config)

    return value


def _read_text(value: Any, config: Optional[Dict] = None) -> Optional[str]:
    """读取文本值"""
    if value is None:
        return None
    return str(value)


def _read_number(value: Any, config: Optional[Dict] = None) -> Optional[float]:
    """读取数字值：Decimal → float（拒绝历史脏数据中的 NaN/Infinity）"""
    if value is None:
        return None
    v = float(value)
    if not math.isfinite(v):
        return None
    return v


def _read_rating(value: Any, config: Optional[Dict] = None) -> Optional[int]:
    """读取评分值"""
    if value is None:
        return None
    return int(value)


def _read_checkbox(value: Any, config: Optional[Dict] = None) -> Optional[bool]:
    """读取布尔值：安全处理 JSONB 中字符串/整数/布尔等混合存储"""
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        return value.lower() in ('true', '1', 'yes', 'on')
    return False


def _read_date(value: Any, config: Optional[Dict] = None) -> Optional[str]:
    """读取日期值：date → ISO 字符串"""
    if value is None:
        return None
    if _date_config_preserves_time(config) and isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, date):
        return value.isoformat()
    return str(value)


def _read_jsonb(value: Any, config: Optional[Dict] = None) -> Any:
    """读取 JSONB 值：兼容 psycopg2/psycopg3 的返回类型差异。"""
    if value is None:
        return None
    if isinstance(value, str):
        # psycopg3 在部分配置下会返回 JSON 字符串，这里做兜底反序列化。
        try:
            return json.loads(value)
        except (json.JSONDecodeError, TypeError):
            return value
    return value


# 读取转换器注册表
_PG_READ_CONVERTERS = {
    # 文本
    'text': _read_text,
    'long_text': _read_text,
    'url': _read_text,
    'email': _read_text,
    'phone': _read_text,
    'select': _read_text,

    # 数值
    'number': _read_number,
    'percent': _read_number,
    'currency': _read_number,
    'rating': _read_rating,

    # 布尔
    'checkbox': _read_checkbox,

    # 日期
    'date': _read_date,

    # JSONB（psycopg2 自动反序列化）
    'multi_select': _read_jsonb,
    'user': _read_jsonb,
    'attachment': _read_jsonb,
    'link': _read_jsonb,
}


# ── 批量转换辅助 ──

def build_native_field_values(
    formatted_data: Dict[str, Any],
    fields: list,
) -> Dict[str, Any]:
    """将 formatted_data 转为 native 列写入格式（key=field_id.hex，值经 python_to_pg）。

    供 Create/UpdateRecordHandler 共用。key 同时接受 dashed UUID 与 32 位 hex；
    未知 key 原样保留（系统列等），避免静默丢字段。
    """
    field_by_key: Dict[str, Any] = {}
    for field in fields:
        field_id = field.id
        if isinstance(field_id, UUID):
            field_by_key[str(field_id)] = field
            field_by_key[field_id.hex] = field
        else:
            field_by_key[str(field_id)] = field
            clean = str(field_id).replace('-', '')
            field_by_key[clean] = field

    native_values: Dict[str, Any] = {}
    for raw_key, value in formatted_data.items():
        field = field_by_key.get(str(raw_key))
        if field is None:
            native_values[str(raw_key)] = value
            continue
        field_id = field.id
        hex_key = field_id.hex if isinstance(field_id, UUID) else str(field_id).replace('-', '')
        native_values[hex_key] = python_to_pg(
            value,
            field.field_type,
            getattr(field, 'config', None),
        )
    return native_values


def convert_record_for_insert(
    field_values: Dict[str, Any],
    fields: list,
) -> Dict[str, Any]:
    """
    将一条记录的字段值批量转换为原生列写入格式。

    Args:
        field_values: {field_id_hex: python_value, ...}
        fields: TableField 对象列表

    Returns:
        {field_id_hex: pg_value, ...}
    """
    # 与 Create/Update 共用同一套 key 归一 + python_to_pg，避免 link 等 JSONB
    # 字段把裸 dict/list 直接交给 psycopg（ProgrammingError: can't adapt type 'dict'）。
    known_hex = set()
    for field in fields:
        field_id = field.id
        if isinstance(field_id, UUID):
            known_hex.add(field_id.hex)
        else:
            known_hex.add(str(field_id).replace('-', ''))
    built = build_native_field_values(field_values, fields)
    return {key: value for key, value in built.items() if key in known_hex}


def convert_native_row_to_record_data(
    row: Dict[str, Any],
    fields: list,
) -> Dict[str, Any]:
    """
    将原生列查询结果转换为 record.data 格式（{field_uuid: python_value}）。

    确保输出与 JSONField 读取格式完全一致。

    Args:
        row: cursor 返回的行 dict（列名 → 值）
        fields: TableField 对象列表

    Returns:
        {field_uuid_str: api_value, ...} — 与 record.data 格式一致
    """
    field_map = {f.id.hex if isinstance(f.id, UUID) else str(f.id): f for f in fields}
    data = {}

    for field_id_hex, field in field_map.items():
        raw_value = row.get(field_id_hex)
        if raw_value is None:
            continue
        api_value = pg_to_python(raw_value, field.field_type, field.config)
        # 使用带连字符的 UUID 作为 key（与现有 JSONField 格式一致）
        uuid_str = str(field.id)
        data[uuid_str] = api_value

    return data
