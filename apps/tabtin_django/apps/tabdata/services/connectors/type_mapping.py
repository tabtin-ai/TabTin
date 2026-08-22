"""
外部数据库类型到 TabData 字段类型的映射

支持 PostgreSQL 和 MySQL 的常见数据类型转换。
"""
import re

# ── PostgreSQL 类型映射 ──

PG_TYPE_MAP: dict[str, str] = {
    # 整型
    'integer': 'number',
    'int4': 'number',
    'bigint': 'number',
    'int8': 'number',
    'smallint': 'number',
    'int2': 'number',
    'serial': 'number',
    'bigserial': 'number',
    # 浮点/精确
    'numeric': 'number',
    'decimal': 'number',
    'real': 'number',
    'float4': 'number',
    'double precision': 'number',
    'float8': 'number',
    # 文本
    'text': 'text',
    'varchar': 'text',
    'character varying': 'text',
    'char': 'text',
    'character': 'text',
    'bpchar': 'text',
    # 布尔
    'boolean': 'checkbox',
    'bool': 'checkbox',
    # 日期时间
    'date': 'date',
    'timestamp': 'text',
    'timestamp without time zone': 'text',
    'timestamp with time zone': 'text',
    'timestamptz': 'text',
    # JSON
    'json': 'text',
    'jsonb': 'text',
    # 其他
    'uuid': 'text',
    'inet': 'text',
    'cidr': 'text',
    'macaddr': 'text',
    'bytea': 'text',
}

# ── MySQL 类型映射 ──

MYSQL_TYPE_MAP: dict[str, str] = {
    # 整型（tinyint(1) 单独处理为 checkbox）
    'int': 'number',
    'integer': 'number',
    'bigint': 'number',
    'smallint': 'number',
    'mediumint': 'number',
    'tinyint': 'number',
    # 浮点/精确
    'decimal': 'number',
    'numeric': 'number',
    'float': 'number',
    'double': 'number',
    # 文本
    'varchar': 'text',
    'char': 'text',
    'text': 'text',
    'mediumtext': 'text',
    'longtext': 'text',
    'tinytext': 'text',
    # 日期时间
    'date': 'date',
    'datetime': 'text',
    'timestamp': 'text',
    # JSON
    'json': 'text',
    # 二进制
    'blob': 'text',
    'binary': 'text',
    'varbinary': 'text',
    # 枚举/集合
    'enum': 'select',
    'set': 'multi_select',
}


def pg_type_to_tabdata(pg_type: str) -> str:
    """将 PostgreSQL 数据类型映射到 TabData 字段类型。

    对于数组类型（如 _int4、integer[]）回退到 'text'。
    """
    normalized = pg_type.lower().strip()

    # 直接查找
    if normalized in PG_TYPE_MAP:
        return PG_TYPE_MAP[normalized]

    # 数组类型回退（PostgreSQL 用 _typename 或 typename[] 表示数组）
    if normalized.startswith('_') or normalized.endswith('[]'):
        return 'text'

    return 'text'


def mysql_type_to_tabdata(mysql_type: str) -> str:
    """将 MySQL 数据类型映射到 TabData 字段类型。

    特殊处理 tinyint(1) → checkbox。
    """
    normalized = mysql_type.lower().strip()

    # tinyint(1) 通常表示布尔值
    if re.match(r'^tinyint\s*\(\s*1\s*\)', normalized):
        return 'checkbox'

    # 去掉长度/精度修饰后查找，如 varchar(255) → varchar
    base_type = re.split(r'[\s(]', normalized, maxsplit=1)[0]
    if base_type in MYSQL_TYPE_MAP:
        return MYSQL_TYPE_MAP[base_type]

    return 'text'


def extract_enum_options(column_type_str: str) -> list[str]:
    """从 MySQL ENUM 类型定义中提取选项值。

    例如: "enum('a','b','c')" → ['a', 'b', 'c']
    """
    match = re.search(r"enum\s*\((.+)\)", column_type_str, re.IGNORECASE)
    if not match:
        return []
    inner = match.group(1)
    # 提取单引号包围的值
    return re.findall(r"'([^']*)'", inner)
