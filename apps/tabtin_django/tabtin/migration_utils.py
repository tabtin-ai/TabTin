"""
迁移工具：PostgreSQL 专有操作 wrapper。

用法：在迁移文件的 operations 列表中，用 PostgresOnlyOperation 包裹
SearchVectorField 的 AddField 和 GinIndex 的 AddIndex，使其在 SQLite 测试
环境下跳过 DDL 但保留 Django 状态。

重要：PostgresOnlyOperation 自动检测 CREATE INDEX CONCURRENTLY 等需要
autocommit 的 SQL，并切换到 autocommit 模式执行。Migration 类仍需设置
atomic = False，但不再需要手动处理 autocommit。
"""

import logging

from django.db import migrations

logger = logging.getLogger(__name__)


def _sql_has_concurrently(sql_value):
    """检查 RunSQL 的 sql/reverse_sql 是否包含 CONCURRENTLY 关键字。"""
    if sql_value is None or sql_value is migrations.RunSQL.noop:
        return False
    if isinstance(sql_value, str):
        return "CONCURRENTLY" in sql_value.upper()
    if isinstance(sql_value, (list, tuple)):
        for item in sql_value:
            s = item[0] if isinstance(item, (list, tuple)) else item
            if isinstance(s, str) and "CONCURRENTLY" in s.upper():
                return True
    return False


def _execute_sql_autocommit(connection, sql_value):
    """在 autocommit 模式下执行 SQL（支持 CONCURRENTLY）。

    核心矛盾：PostgreSQL 的 CREATE/DROP INDEX CONCURRENTLY 要求连接处于
    autocommit 模式（完全无事务），但 Django 的 schema_editor 即使在
    atomic=False 的迁移中仍通过 psycopg 的隐式事务运行 SQL。

    此函数绕过 Django schema_editor，直接操作底层 psycopg 连接的
    autocommit 标志，确保 CONCURRENTLY 语句能正确执行。
    """
    connection.ensure_connection()
    db_conn = connection.connection
    old_autocommit = db_conn.autocommit
    db_conn.autocommit = True
    try:
        if isinstance(sql_value, str):
            statements = [s.strip() for s in sql_value.split(";") if s.strip()]
            with db_conn.cursor() as cursor:
                for stmt in statements:
                    logger.debug("AUTOCOMMIT %s", stmt[:120])
                    cursor.execute(stmt)
        elif isinstance(sql_value, (list, tuple)):
            with db_conn.cursor() as cursor:
                for item in sql_value:
                    if isinstance(item, (list, tuple)):
                        cursor.execute(
                            item[0], item[1] if len(item) > 1 else None,
                        )
                    else:
                        cursor.execute(item)
    finally:
        db_conn.autocommit = old_autocommit


class PostgresOnlyOperation(migrations.operations.base.Operation):
    """仅在 PostgreSQL 上执行数据库变更，但始终更新 Django 迁移状态。

    适用于 SearchVectorField (tsvector)、GinIndex、VectorField HNSW 等
    PG 专有操作。SQLite 测试时跳过 DDL 但保留模型字段/索引状态。

    当包裹的 RunSQL 包含 CONCURRENTLY 关键字时，自动切换到 autocommit
    模式执行，避免 "cannot run inside a transaction block" 错误。
    """

    reduces_to_sql = False
    elidable = False

    def __init__(self, operation):
        self.operation = operation

    def state_forwards(self, app_label, state):
        self.operation.state_forwards(app_label, state)

    def _is_runsql_with_concurrently(self, direction="forward"):
        if not isinstance(self.operation, migrations.RunSQL):
            return False
        attr = "sql" if direction == "forward" else "reverse_sql"
        return _sql_has_concurrently(getattr(self.operation, attr, None))

    def database_forwards(self, app_label, schema_editor, from_state, to_state):
        if schema_editor.connection.vendor == "postgresql":
            if self._is_runsql_with_concurrently("forward"):
                _execute_sql_autocommit(
                    schema_editor.connection, self.operation.sql,
                )
            else:
                self.operation.database_forwards(
                    app_label, schema_editor, from_state, to_state,
                )
        elif isinstance(self.operation, migrations.AddField):
            from django.db import models
            fallback_field = models.TextField(null=True, blank=True)
            fallback_field.set_attributes_from_name(self.operation.name)
            fallback_op = migrations.AddField(
                model_name=self.operation.model_name,
                name=self.operation.name,
                field=fallback_field,
            )
            fallback_op.database_forwards(app_label, schema_editor, from_state, to_state)

    def database_backwards(self, app_label, schema_editor, from_state, to_state):
        if schema_editor.connection.vendor == "postgresql":
            if self._is_runsql_with_concurrently("backward"):
                _execute_sql_autocommit(
                    schema_editor.connection, self.operation.reverse_sql,
                )
            else:
                self.operation.database_backwards(
                    app_label, schema_editor, from_state, to_state,
                )
        elif isinstance(self.operation, migrations.AddField):
            remove_op = migrations.RemoveField(
                model_name=self.operation.model_name,
                name=self.operation.name,
            )
            remove_op.database_forwards(app_label, schema_editor, from_state, to_state)

    @property
    def reversible(self):
        return self.operation.reversible

    @property
    def migration_name_fragment(self):
        return getattr(self.operation, "migration_name_fragment", "pg_only")

    def describe(self):
        return f"[PostgreSQL only] {self.operation.describe()}"

    def references_model(self, name, app_label):
        return self.operation.references_model(name, app_label)

    def references_field(self, model_name, name, app_label):
        return self.operation.references_field(model_name, name, app_label)

    def deconstruct(self):
        return (
            "tabtin.migration_utils.PostgresOnlyOperation",
            [self.operation],
            {},
        )
