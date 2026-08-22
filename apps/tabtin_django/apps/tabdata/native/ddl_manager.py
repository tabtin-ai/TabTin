"""
PostgreSQL DDL 管理器

负责原生列存储的 Schema / Table / Column DDL 操作。
通过格式校验 + 双引号转义确保标识符安全（标识符来源为 UUID hex，
仅允许小写字母、数字、下划线）。

所有操作均幂等（IF NOT EXISTS / IF EXISTS）。
"""

import logging
import re
from typing import Dict, List, Optional, Tuple
from uuid import UUID

from django.conf import settings
from django.db import DatabaseError, connections, transaction

from .pg_type_map import (
    SYSTEM_COLUMNS,
    get_column_definition,
    get_pg_type,
    get_pg_type_cast_using,
    is_system_field,
)

logger = logging.getLogger('tabdata.native.ddl')

# 数据库别名（统一引用 constants 中的常量）
from apps.tabdata.constants import DDL_STATEMENT_TIMEOUT_MS, TABDATA_DB_ALIAS
from .community_capabilities import (
    CommunityRecordIndexOperations,
    CommunitySchemaOperations,
    resolve_column_capability,
)

_SAFE_IDENTIFIER_RE = re.compile(r'^[a-z_][a-z0-9_]*$')
_UUID_HEX_RE = re.compile(r'^[0-9a-f]{32}$')

_INFORMATION_SCHEMA_TYPE_TO_PG_TYPE = {
    'text': 'TEXT',
    'double precision': 'DOUBLE PRECISION',
    'integer': 'INTEGER',
    'boolean': 'BOOLEAN',
    'date': 'DATE',
    'timestamp with time zone': 'TIMESTAMPTZ',
    'jsonb': 'JSONB',
    'uuid': 'UUID',
}

# 进程内已 ensure 过的 schema：命中时仍校验当前数据库身份的真实权限，
# 仅在权限未漂移时跳过 CREATE SCHEMA / GRANT / REVOKE。
# drop_schema 时会失效；外部 DDL / 角色轮换导致的 ACL 漂移由权限探针发现。
_ENSURED_SCHEMAS: set[str] = set()


class SchemaPrivilegeError(PermissionError):
    """运行账号无法对齐 TabData 原生 schema 权限。"""


def _assert_safe_identifier(name: str, label: str = 'identifier') -> None:
    """校验 DDL 标识符格式安全"""
    if not (_SAFE_IDENTIFIER_RE.match(name) or _UUID_HEX_RE.match(name)):
        raise ValueError(f"不安全的 {label}: {name!r}")


def resolve_schema_partition_id(table) -> UUID:
    """解析一张 Table 在原生列存储中实际归属的 schema 分区 ID。

    ：产品归属只认 Organization；新表 ``space_id`` 恒为 NULL，schema
    用 ``as_{organization_hex}``。

    仍保留 ``table.space_id or organization_id``：仅用于读取**历史**仍落在
    ``as_{space_hex}`` 的物理表。这不是产品所有权字段——迁库完成后应改为
    只返回 ``organization_id``。
    """
    return table.space_id or table.organization_id


class DDLManager:
    """
    管理 PostgreSQL 原生表的 Schema / Table / Column DDL。

    命名约定：
    - Schema: as_{space_uuid_hex}
    - Table:  tbl_{table_uuid_hex}
    - Column: "{field_uuid_hex}" (UUID 直接作为列名)

    所有 DDL 方法都是幂等的，可安全重复调用。
    """

    def __init__(self, db_alias: str = TABDATA_DB_ALIAS):
        self.db_alias = db_alias

    def _community_operations(self) -> CommunitySchemaOperations | None:
        if getattr(settings, 'TABTIN_EDITION', 'saas') != 'community':
            return None
        return CommunitySchemaOperations(connections[self.db_alias])

    # ──────────────────────────────────
    # 命名辅助
    # ──────────────────────────────────

    @staticmethod
    def schema_name(space_id: UUID) -> str:
        """Space ID → Schema 名称"""
        name = f'as_{space_id.hex}'
        _assert_safe_identifier(name, 'schema')
        return name

    @staticmethod
    def table_name(table_id: UUID) -> str:
        """表 ID → 表名称（不含 schema）"""
        name = f'tbl_{table_id.hex}'
        _assert_safe_identifier(name, 'table')
        return name

    @classmethod
    def qualified_table_name(cls, space_id: UUID, table_id: UUID) -> str:
        """返回 schema.table 限定名"""
        return f'{cls.schema_name(space_id)}.{cls.table_name(table_id)}'

    @staticmethod
    def column_name(field_id: UUID) -> str:
        """字段 ID → 列名（UUID hex 字符串）"""
        name = field_id.hex
        _assert_safe_identifier(name, 'column')
        return name

    # ──────────────────────────────────
    # Schema 操作
    # ──────────────────────────────────

    def _has_schema_privileges(self, schema: str) -> bool:
        """当前数据库身份是否仍可读取并在 schema 内建表。"""
        with connections[self.db_alias].cursor() as cursor:
            cursor.execute(
                "SELECT has_schema_privilege(current_user, %s, 'USAGE') "
                "AND has_schema_privilege(current_user, %s, 'CREATE')",
                [schema, schema],
            )
            row = cursor.fetchone()
        return bool(row and row[0])

    def ensure_schema(self, space_id: UUID) -> str:
        """
        创建 Space schema（如果不存在）并撤销 public 访问权限。

        Returns:
            创建的 schema 名称
        """
        schema = self.schema_name(space_id)
        community_operations = self._community_operations()
        if community_operations is not None:
            community_operations.ensure_schema(space_id)
            return schema
        if schema in _ENSURED_SCHEMAS:
            if self._has_schema_privileges(schema):
                return schema
            _ENSURED_SCHEMAS.discard(schema)
            logger.warning(
                'Cached schema privileges drifted; reconciling: %s (space=%s)',
                schema, space_id,
            )
        with transaction.atomic(using=self.db_alias):
            with connections[self.db_alias].cursor() as cursor:
                try:
                    cursor.execute(
                        f'CREATE SCHEMA IF NOT EXISTS "{schema}"'
                    )
                    # 显式对齐 runtime role。正常 owner 路径为幂等 no-op；角色轮换
                    # 或 restore 后 ACL 漂移时，RDS 高权限账号可在请求内自愈。
                    cursor.execute(
                        f'GRANT USAGE, CREATE ON SCHEMA "{schema}" TO CURRENT_USER'
                    )
                    cursor.execute(
                        f'REVOKE ALL ON SCHEMA "{schema}" FROM PUBLIC'
                    )
                except DatabaseError as exc:
                    raise SchemaPrivilegeError(
                        f'数据库运行账号无法对齐 TabData schema 权限: {schema}；'
                        '请使用 schema owner 或 RDS 高权限账号授予 USAGE, CREATE'
                    ) from exc
        # 可能位于导入单表的外层事务中；只在最外层真正提交后登记缓存，
        # 避免后续写行回滚了 schema，但进程缓存仍误判为已初始化。
        transaction.on_commit(
            lambda: _ENSURED_SCHEMAS.add(schema),
            using=self.db_alias,
        )
        logger.info('Schema ensured: %s (space=%s)', schema, space_id)
        return schema

    def drop_schema(self, space_id: UUID) -> None:
        """删除 Space schema（级联删除所有表）"""
        schema = self.schema_name(space_id)
        with connections[self.db_alias].cursor() as cursor:
            cursor.execute(
                f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'
            )
        _ENSURED_SCHEMAS.discard(schema)
        logger.info('Schema dropped: %s (space=%s)', schema, space_id)

    def schema_exists(self, space_id: UUID) -> bool:
        """检查 schema 是否存在"""
        schema = self.schema_name(space_id)
        with connections[self.db_alias].cursor() as cursor:
            cursor.execute(
                "SELECT EXISTS (SELECT 1 FROM information_schema.schemata "
                "WHERE schema_name = %s)",
                [schema],
            )
            row = cursor.fetchone()
            return bool(row and row[0])

    # ──────────────────────────────────
    # Table 操作
    # ──────────────────────────────────

    def create_native_table(
        self,
        space_id: UUID,
        table_id: UUID,
        extra_fields: Optional[List] = None,
    ) -> str:
        """
        创建原生数据表（含系统列）。

        系统列：
        - __id: UUID PRIMARY KEY (对应 TableRecord.id)
        - __auto_number: SERIAL (自增序号)
        - __order: FLOAT8 (排序位置)
        - __version: INTEGER (版本号)
        - __created_at: TIMESTAMPTZ (创建时间)
        - __updated_at: TIMESTAMPTZ (更新时间)
        - __created_by: UUID (创建者)
        - __updated_by: UUID (最后修改者)

        Args:
            extra_fields: 可选用户字段列表（需有 id / field_type / config），
                并进首条 CREATE TABLE，避免随后逐列 ALTER。

        Returns:
            限定表名 (schema.table)
        """
        schema = self.schema_name(space_id)
        table = self.table_name(table_id)
        community_operations = self._community_operations()
        if community_operations is not None:
            field_specs = []
            for field in extra_fields or []:
                field_type = getattr(field, 'field_type', None)
                field_id = getattr(field, 'id', None)
                if not field_id or not field_type or is_system_field(field_type):
                    continue
                pg_type, default_kind = resolve_column_capability(
                    field_type,
                    getattr(field, 'config', None),
                )
                field_specs.append({
                    'field_id': str(field_id),
                    'pg_type': pg_type,
                    'default_kind': default_kind,
                })
            with transaction.atomic(using=self.db_alias):
                community_operations.create_table(space_id, table_id, field_specs)
            return f'{schema}.{table}'
        qualified = f'"{schema}"."{table}"'

        col_defs = []
        for col_name, col_type in SYSTEM_COLUMNS.items():
            col_defs.append(f'    "{col_name}" {col_type}')

        for field in extra_fields or []:
            field_type = getattr(field, 'field_type', None)
            field_id = getattr(field, 'id', None)
            if not field_id or not field_type or is_system_field(field_type):
                continue
            col_name_quoted, col_type_and_default = get_column_definition(
                field_id.hex,
                field_type,
                getattr(field, 'config', None),
            )
            col_defs.append(f'    {col_name_quoted} {col_type_and_default}')

        columns_sql = ',\n'.join(col_defs)
        create_sql = f'CREATE TABLE IF NOT EXISTS {qualified} (\n{columns_sql}\n)'

        with connections[self.db_alias].cursor() as cursor:
            cursor.execute(create_sql)

        logger.info(
            'Native table created: %s.%s (space=%s, table=%s, extra_fields=%d)',
            schema, table, space_id, table_id, len(extra_fields or []),
        )
        return f'{schema}.{table}'

    def ensure_native_table(self, space_id: UUID, table_id: UUID) -> str:
        """
        确保活跃 Table 对应的 schema 与物理 native table 都存在。

        这是 TabData 的结构不变量入口：只要上层准备读取或同步字段列，就必须先
        让物理表存在，避免元数据已存在但 ALTER/SELECT 命中 UndefinedTable。
        """
        self.ensure_schema(space_id)
        return self.create_native_table(space_id, table_id)

    def drop_native_table(self, space_id: UUID, table_id: UUID) -> None:
        """删除原生数据表"""
        schema = self.schema_name(space_id)
        table = self.table_name(table_id)
        qualified = f'"{schema}"."{table}"'

        community_operations = self._community_operations()
        if community_operations is not None:
            with transaction.atomic(using=self.db_alias):
                CommunityRecordIndexOperations(
                    connections[self.db_alias]
                ).drop_search_indexes(table_id)
                community_operations.drop_table(space_id, table_id)
            logger.info(
                'Native table dropped: %s.%s (space=%s, table=%s)',
                schema, table, space_id, table_id,
            )
            return

        with connections[self.db_alias].cursor() as cursor:
            cursor.execute(f'DROP TABLE IF EXISTS {qualified} CASCADE')

        logger.info(
            'Native table dropped: %s.%s (space=%s, table=%s)',
            schema, table, space_id, table_id,
        )

    def native_table_exists(self, space_id: UUID, table_id: UUID) -> bool:
        """检查原生表是否存在"""
        schema = self.schema_name(space_id)
        table = self.table_name(table_id)

        with connections[self.db_alias].cursor() as cursor:
            cursor.execute(
                "SELECT EXISTS ("
                "  SELECT 1 FROM information_schema.tables "
                "  WHERE table_schema = %s AND table_name = %s"
                ")",
                [schema, table],
            )
            row = cursor.fetchone()
            return bool(row and row[0])

    # ──────────────────────────────────
    # Column 操作
    # ──────────────────────────────────

    def add_column(
        self,
        space_id: UUID,
        table_id: UUID,
        field_id: UUID,
        field_type: str,
        config: Optional[Dict] = None,
    ) -> bool:
        """
        添加用户字段列。

        如果字段类型映射到系统列（如 created_time → __created_at），则跳过。
        如果列已存在，则跳过（幂等）。

        Returns:
            True 表示成功添加，False 表示跳过（系统列或已存在）
        """
        if is_system_field(field_type):
            logger.debug(
                'Skipping system field column: field_type=%s, field_id=%s',
                field_type, field_id,
            )
            return False

        community_operations = self._community_operations()
        if community_operations is not None:
            pg_type, default_kind = resolve_column_capability(field_type, config)
            return community_operations.add_column(
                space_id,
                table_id,
                field_id,
                pg_type=pg_type,
                default_kind=default_kind,
            )

        col_def = get_column_definition(field_id.hex, field_type, config)

        col_name_quoted, col_type_and_default = col_def
        schema = self.schema_name(space_id)
        table = self.table_name(table_id)
        qualified = f'"{schema}"."{table}"'

        sql = (
            f'ALTER TABLE {qualified} '
            f'ADD COLUMN IF NOT EXISTS {col_name_quoted} {col_type_and_default}'
        )

        with connections[self.db_alias].cursor() as cursor:
            cursor.execute(f"SET LOCAL statement_timeout = '{DDL_STATEMENT_TIMEOUT_MS}'")
            cursor.execute(sql)
            cursor.execute("SET LOCAL statement_timeout = '0'")

        logger.info(
            'Column added: %s.%s.%s (%s) [type=%s]',
            schema, table, field_id.hex, field_type, col_type_and_default,
        )
        return True

    def drop_column(
        self,
        space_id: UUID,
        table_id: UUID,
        field_id: UUID,
    ) -> bool:
        """
        删除用户字段列。

        Args:
            space_id: Space ID
            table_id: 表 ID
            field_id: 字段 ID

        Returns:
            True 表示成功删除，False 表示列不存在
        """
        col_name = self.column_name(field_id)
        community_operations = self._community_operations()
        if community_operations is not None:
            return community_operations.drop_column(space_id, table_id, field_id)
        schema = self.schema_name(space_id)
        table = self.table_name(table_id)
        qualified = f'"{schema}"."{table}"'

        sql = f'ALTER TABLE {qualified} DROP COLUMN IF EXISTS "{col_name}" CASCADE'

        with connections[self.db_alias].cursor() as cursor:
            cursor.execute(f"SET LOCAL statement_timeout = '{DDL_STATEMENT_TIMEOUT_MS}'")
            cursor.execute(sql)
            cursor.execute("SET LOCAL statement_timeout = '0'")

        logger.info(
            'Column dropped: %s.%s.%s',
            schema, table, col_name,
        )
        return True

    def alter_column_type(
        self,
        space_id: UUID,
        table_id: UUID,
        field_id: UUID,
        new_field_type: str,
        old_field_type: str,
        config: Optional[Dict] = None,
        old_config: Optional[Dict] = None,
    ) -> bool:
        """
        修改列的数据类型。

        会自动生成 USING 表达式进行类型转换。
        如果新旧类型的 PG 类型相同，则跳过。

        Returns:
            True 表示成功修改，False 表示跳过
        """
        new_pg_type = get_pg_type(new_field_type, config)
        configured_old_pg_type = get_pg_type(old_field_type, old_config)

        if not new_pg_type:
            logger.warning(
                'Cannot alter to system field type: %s', new_field_type,
            )
            return False

        community_operations = self._community_operations()
        if community_operations is not None:
            formatting = config.get('formatting') if isinstance(config, dict) else None
            timezone = formatting.get('timeZone') if isinstance(formatting, dict) else None
            return community_operations.alter_column_type(
                space_id,
                table_id,
                field_id,
                target_type=new_pg_type,
                timezone=timezone if isinstance(timezone, str) and timezone else None,
            )

        old_pg_type = self.get_column_pg_type(space_id, table_id, field_id)
        if old_pg_type is None:
            old_pg_type = configured_old_pg_type

        if new_pg_type == old_pg_type:
            logger.debug(
                'Same PG type, skipping alter: %s → %s (both %s)',
                old_field_type, new_field_type, new_pg_type,
            )
            return False

        col_name = self.column_name(field_id)
        schema = self.schema_name(space_id)
        table = self.table_name(table_id)
        qualified = f'"{schema}"."{table}"'

        using_expr = get_pg_type_cast_using(old_pg_type, new_pg_type, col_name, config)
        if using_expr:
            sql = (
                f'ALTER TABLE {qualified} '
                f'ALTER COLUMN "{col_name}" TYPE {new_pg_type} '
                f'USING {using_expr}'
            )
        else:
            sql = (
                f'ALTER TABLE {qualified} '
                f'ALTER COLUMN "{col_name}" TYPE {new_pg_type}'
            )

        with connections[self.db_alias].cursor() as cursor:
            cursor.execute(f"SET LOCAL statement_timeout = '{DDL_STATEMENT_TIMEOUT_MS}'")
            cursor.execute(sql)
            cursor.execute("SET LOCAL statement_timeout = '0'")

        logger.info(
            'Column type altered: %s.%s.%s (%s → %s, PG: %s → %s)',
            schema, table, col_name,
            old_field_type, new_field_type,
            old_pg_type, new_pg_type,
        )
        return True

    def column_exists(
        self,
        space_id: UUID,
        table_id: UUID,
        field_id: UUID,
    ) -> bool:
        """检查列是否存在"""
        schema = self.schema_name(space_id)
        table = self.table_name(table_id)
        col_name = field_id.hex

        with connections[self.db_alias].cursor() as cursor:
            cursor.execute(
                "SELECT EXISTS ("
                "  SELECT 1 FROM information_schema.columns "
                "  WHERE table_schema = %s AND table_name = %s AND column_name = %s"
                ")",
                [schema, table, col_name],
            )
            row = cursor.fetchone()
            return bool(row and row[0])

    def get_column_pg_type(
        self,
        space_id: UUID,
        table_id: UUID,
        field_id: UUID,
    ) -> Optional[str]:
        """Return the canonical PostgreSQL type of the physical field column."""
        schema = self.schema_name(space_id)
        table = self.table_name(table_id)
        col_name = self.column_name(field_id)

        with connections[self.db_alias].cursor() as cursor:
            cursor.execute(
                "SELECT data_type FROM information_schema.columns "
                "WHERE table_schema = %s AND table_name = %s AND column_name = %s",
                [schema, table, col_name],
            )
            row = cursor.fetchone()

        if not row:
            return None
        return _INFORMATION_SCHEMA_TYPE_TO_PG_TYPE.get(str(row[0]).lower(), str(row[0]).upper())

    def list_columns(
        self,
        space_id: UUID,
        table_id: UUID,
    ) -> List[Dict]:
        """
        列出表中所有列的信息。

        Returns:
            列信息列表 [{"name": str, "data_type": str, "is_nullable": bool}, ...]
        """
        schema = self.schema_name(space_id)
        table = self.table_name(table_id)

        with connections[self.db_alias].cursor() as cursor:
            cursor.execute(
                "SELECT column_name, data_type, is_nullable, column_default "
                "FROM information_schema.columns "
                "WHERE table_schema = %s AND table_name = %s "
                "ORDER BY ordinal_position",
                [schema, table],
            )
            rows = cursor.fetchall()

        return [
            {
                'name': row[0],
                'data_type': row[1],
                'is_nullable': row[2] == 'YES',
                'column_default': row[3],
            }
            for row in rows
        ]

    def ensure_columns_synced(
        self,
        space_id: UUID,
        table_id: UUID,
        fields: list,
    ) -> Tuple[int, int]:
        """
        确保所有活跃字段都有对应的原生列。

        对比字段列表与实际列，添加缺失的列。

        Args:
            space_id: Space ID
            table_id: 表 ID
            fields: TableField 对象列表

        Returns:
            (added_count, skipped_count)
        """
        if not self.native_table_exists(space_id, table_id):
            logger.warning(
                'Native table missing before column sync; recreating structure: space=%s table=%s',
                space_id, table_id,
            )
        self.ensure_native_table(space_id, table_id)

        existing_columns = {
            col['name'] for col in self.list_columns(space_id, table_id)
        }

        added = 0
        skipped = 0

        with transaction.atomic(using=TABDATA_DB_ALIAS):
            for field in fields:
                if is_system_field(field.field_type):
                    skipped += 1
                    continue

                col_name = field.id.hex
                if col_name in existing_columns:
                    skipped += 1
                    continue

                success = self.add_column(
                    space_id, table_id, field.id,
                    field.field_type, field.config,
                )
                if success:
                    added += 1
                    existing_columns.add(col_name)
                else:
                    skipped += 1

        logger.info(
            'Columns synced for %s.%s: added=%d, skipped=%d',
            self.schema_name(space_id), self.table_name(table_id),
            added, skipped,
        )
        return (added, skipped)
