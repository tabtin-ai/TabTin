"""
字段类型 → PostgreSQL 列类型映射

将 TabTin 多维表格字段类型映射到对应的 PostgreSQL 原生列类型。

设计决策：
- select: TEXT 直存（非 JSONB）
- multi_select / attachment / user / link: JSONB
- created_time / last_modified_time / created_by / last_modified_by: 映射系统列
"""

from typing import Any, Dict, Optional, Tuple

from apps.tabdata.constants import FILE_BASED_FIELD_TYPES


# ── 字段类型 → PostgreSQL 列类型 ──


class UnknownNativeFieldTypeError(ValueError):
    """非系统字段缺少 native PostgreSQL 类型映射。"""

FIELD_TYPE_TO_PG_TYPE: Dict[str, str] = {
    # 基础文本
    'text': 'TEXT',
    'long_text': 'TEXT',

    # 数值
    'number': 'DOUBLE PRECISION',
    'percent': 'DOUBLE PRECISION',
    'currency': 'DOUBLE PRECISION',
    'rating': 'INTEGER',

    # 选择
    'select': 'TEXT',
    'multi_select': 'JSONB',
    'checkbox': 'BOOLEAN',

    # 日期时间
    'date': 'DATE',

    # 链接与联系方式
    'url': 'TEXT',
    'email': 'TEXT',
    'phone': 'TEXT',

    # 用户
    'user': 'JSONB',

    # 媒体
    'attachment': 'JSONB',

    'link': 'JSONB',

}


def _date_config_preserves_time(config: Optional[Dict] = None) -> bool:
    if not isinstance(config, dict):
        return False
    formatting = config.get('formatting')
    if not isinstance(formatting, dict):
        return False
    time_format = formatting.get('time')
    return isinstance(time_format, str) and time_format != 'None'

# 映射到系统列的字段类型（不需要创建用户列）
SYSTEM_COLUMN_FIELD_TYPES: Dict[str, str] = {
    'created_time': '__created_at',
    'last_modified_time': '__updated_at',
    'created_by': '__created_by',
    'last_modified_by': '__updated_by',
}

# 系统列定义（每张 native table 统一）
SYSTEM_COLUMNS: Dict[str, str] = {
    '__id': 'UUID PRIMARY KEY DEFAULT gen_random_uuid()',
    '__auto_number': 'SERIAL',
    '__order': 'DOUBLE PRECISION DEFAULT 0',
    '__version': 'INTEGER NOT NULL DEFAULT 1',
    '__created_at': 'TIMESTAMPTZ NOT NULL DEFAULT NOW()',
    '__updated_at': 'TIMESTAMPTZ',
    '__created_by': 'UUID',
    '__updated_by': 'UUID',
}

# 系统列名集合（快速查找）
SYSTEM_COLUMN_NAMES = frozenset(SYSTEM_COLUMNS.keys())


def is_system_field(field_type: str) -> bool:
    """判断字段类型是否映射到系统列（不需要创建用户列）"""
    return field_type in SYSTEM_COLUMN_FIELD_TYPES


def get_system_column_name(field_type: str) -> Optional[str]:
    """获取系统字段对应的系统列名"""
    return SYSTEM_COLUMN_FIELD_TYPES.get(field_type)


def get_pg_type(field_type: str, config: Optional[Dict] = None) -> Optional[str]:
    """
    获取字段类型对应的 PostgreSQL 列类型。

    Args:
        field_type: 多维表格字段类型（如 'text', 'number', 'multi_select'）
        config: 字段配置（预留，用于未来根据配置微调类型）

    Returns:
        PostgreSQL 列类型字符串（如 'TEXT', 'DOUBLE PRECISION', 'JSONB'）
        如果是系统字段类型，返回 None（应使用系统列）
    """
    if is_system_field(field_type):
        return None
    if field_type == 'date' and _date_config_preserves_time(config):
        return 'TIMESTAMPTZ'
    return FIELD_TYPE_TO_PG_TYPE.get(field_type)


def get_pg_default(field_type: str, config: Optional[Dict] = None) -> Optional[str]:
    """
    获取字段类型的 SQL DEFAULT 子句。

    Args:
        field_type: 字段类型
        config: 字段配置

    Returns:
        SQL DEFAULT 表达式（不含 DEFAULT 关键字），或 None 表示无默认值
    """
    config = config or {}

    if field_type == 'checkbox':
        return 'false'

    if field_type == 'multi_select':
        return "'[]'::jsonb"

    if field_type in FILE_BASED_FIELD_TYPES:
        return "'[]'::jsonb"

    # 其他类型默认 NULL（列默认就是 NULL）
    return None


def get_type_cast_using(
    old_field_type: str,
    new_field_type: str,
    field_id: str,
    old_config: Optional[Dict] = None,
    new_config: Optional[Dict] = None,
) -> Optional[str]:
    """
    获取字段类型转换时的 USING 表达式。

    用于 ALTER TABLE ALTER COLUMN "field_uuid" TYPE new_type USING expr。

    Args:
        old_field_type: 原字段类型
        new_field_type: 目标字段类型
        field_id: 字段 UUID（用于列引用）

    Returns:
        USING 表达式字符串，或 None 表示可直接转换（PostgreSQL 隐式）
    """
    old_pg = get_pg_type(old_field_type, old_config)
    new_pg = get_pg_type(new_field_type, new_config)

    return get_pg_type_cast_using(old_pg, new_pg, field_id, new_config)


def get_pg_type_cast_using(
    old_pg: Optional[str],
    new_pg: Optional[str],
    field_id: str,
    config: Optional[Dict] = None,
) -> Optional[str]:
    """Build a USING expression from the physical PostgreSQL column types."""

    if not old_pg or not new_pg:
        return None

    col = f'"{field_id}"'

    # 相同类型无需转换
    if old_pg == new_pg:
        return None

    # TEXT → DOUBLE PRECISION
    if old_pg == 'TEXT' and new_pg == 'DOUBLE PRECISION':
        return f'NULLIF(TRIM({col}), \'\')::DOUBLE PRECISION'

    # TEXT → INTEGER
    if old_pg == 'TEXT' and new_pg == 'INTEGER':
        return f'NULLIF(TRIM({col}), \'\')::INTEGER'

    # TEXT → BOOLEAN
    if old_pg == 'TEXT' and new_pg == 'BOOLEAN':
        return f'CASE LOWER(TRIM({col})) WHEN \'true\' THEN true WHEN \'1\' THEN true WHEN \'yes\' THEN true ELSE false END'

    # TEXT → DATE
    if old_pg == 'TEXT' and new_pg == 'DATE':
        return f'{col}::DATE'

    # TEXT → TIMESTAMPTZ
    if old_pg == 'TEXT' and new_pg == 'TIMESTAMPTZ':
        return f'{col}::TIMESTAMPTZ'

    # TEXT → JSONB
    if old_pg == 'TEXT' and new_pg == 'JSONB':
        return f'to_jsonb({col})'

    # DOUBLE PRECISION → TEXT
    if old_pg == 'DOUBLE PRECISION' and new_pg == 'TEXT':
        return f'{col}::TEXT'

    # DOUBLE PRECISION → INTEGER
    if old_pg == 'DOUBLE PRECISION' and new_pg == 'INTEGER':
        return f'{col}::INTEGER'

    # INTEGER → TEXT
    if old_pg == 'INTEGER' and new_pg == 'TEXT':
        return f'{col}::TEXT'

    # INTEGER → DOUBLE PRECISION
    if old_pg == 'INTEGER' and new_pg == 'DOUBLE PRECISION':
        return f'{col}::DOUBLE PRECISION'

    # BOOLEAN → TEXT
    if old_pg == 'BOOLEAN' and new_pg == 'TEXT':
        return f'CASE WHEN {col} THEN \'true\' ELSE \'false\' END'

    # DATE → TEXT
    if old_pg == 'DATE' and new_pg == 'TEXT':
        return f'{col}::TEXT'

    # DATE → TIMESTAMPTZ
    if old_pg == 'DATE' and new_pg == 'TIMESTAMPTZ':
        formatting = config.get('formatting') if isinstance(config, dict) else None
        time_zone = formatting.get('timeZone') if isinstance(formatting, dict) else None
        if isinstance(time_zone, str) and time_zone:
            escaped_time_zone = time_zone.replace("'", "''")
            return f"{col}::TIMESTAMP AT TIME ZONE '{escaped_time_zone}'"
        return f'{col}::TIMESTAMPTZ'

    # TIMESTAMPTZ → TEXT
    if old_pg == 'TIMESTAMPTZ' and new_pg == 'TEXT':
        return f'{col}::TEXT'

    # TIMESTAMPTZ → DATE
    if old_pg == 'TIMESTAMPTZ' and new_pg == 'DATE':
        formatting = config.get('formatting') if isinstance(config, dict) else None
        time_zone = formatting.get('timeZone') if isinstance(formatting, dict) else None
        if isinstance(time_zone, str) and time_zone:
            escaped_time_zone = time_zone.replace("'", "''")
            return f"({col} AT TIME ZONE '{escaped_time_zone}')::DATE"
        return f'{col}::DATE'

    # JSONB → TEXT
    if old_pg == 'JSONB' and new_pg == 'TEXT':
        return f'{col}::TEXT'

    # 默认：尝试直接 CAST（可能会失败）
    return f'{col}::{new_pg}'


def get_column_definition(
    field_id: str,
    field_type: str,
    config: Optional[Dict] = None,
) -> Optional[Tuple[str, str]]:
    """
    获取完整的列定义（列名 + 类型 + 默认值）。

    Args:
        field_id: 字段 UUID（作为列名）
        field_type: 字段类型
        config: 字段配置

    Returns:
        (column_name, column_definition) 元组，
        如 ('"a1b2c3d4..."', 'TEXT')
        或 ('"a1b2c3d4..."', "BOOLEAN DEFAULT false")
        如果是系统字段类型返回 None
    """
    if is_system_field(field_type):
        return None

    pg_type = get_pg_type(field_type, config)
    if pg_type is None:
        raise UnknownNativeFieldTypeError(
            f'Unknown native PostgreSQL type mapping for TabData field type: {field_type}'
        )

    default = get_pg_default(field_type, config)
    col_name = f'"{field_id}"'

    if default:
        col_def = f'{pg_type} DEFAULT {default}'
    else:
        col_def = pg_type

    return (col_name, col_def)


def get_all_field_types() -> list:
    """返回所有支持的字段类型名称列表"""
    all_types = list(FIELD_TYPE_TO_PG_TYPE.keys()) + list(SYSTEM_COLUMN_FIELD_TYPES.keys())
    return sorted(set(all_types))
