"""PostgreSQL 迁移过程场景测试基类。

现有 ``makemigrations --check`` / ``check_migration_integrity`` 只验证
「最终模型是否一致」，看不到「迁移过程中某一步」对脏数据的破坏。

本基类在**临时 PostgreSQL 库**上用 ``MigrationExecutor`` 走真实升级路径：

1. migrate 到 ``migrate_from``
2. ``seed_before_migration`` 插入脏数据（孤儿 FK、非法 UUID、空串等）
3. migrate 到 ``migrate_to``
4. ``assert_after_migration`` 断言成功语义

禁止 SQLite：生产与 ACK 都是 PostgreSQL，SQLite 无法复现约束顺序问题。
"""

from __future__ import annotations

import os
import re
import uuid
from typing import Iterable, Sequence
from unittest import TestCase

from django.conf import settings
from django.db import connections
from django.db.migrations.executor import MigrationExecutor


MigrationTarget = tuple[str, str]


class PostgresMigrationScenarioTestCase(TestCase):
    """真实 PostgreSQL 迁移步骤测试。

    子类必须声明::

        app_label = "billing"
        migrate_from = "0038_auto_topup_yuan_fields"
        migrate_to = "0039_organization_fk_convergence_3832"

    或直接给完整 target::

        migrate_from = ("billing", "0038_auto_topup_yuan_fields")
        migrate_to = ("billing", "0039_organization_fk_convergence_3832")

    可选覆盖 ``extra_targets``，把其它 app 钉在特定叶子（默认只钉
    ``migrate_from`` / ``migrate_to`` 自身及其依赖图）。

    使用 ``unittest.TestCase``（不是 Django SimpleTestCase），避免：
    1. SimpleTestCase 默认禁 DB 连接；
    2. 被 Django test runner 建出已迁到 HEAD 的 test_tabtin_single（本类自管临时库）。

    子类需提供 ``test_*`` 并调用 ``run_migration_scenario()``；基类故意不放
    ``test_*``，以免被 discovery 当成可跑用例。
    """

    # 基类无 test_*；保留标记方便文档/工具识别。
    __test__ = False

    app_label: str = ""
    migrate_from: str | MigrationTarget = ""
    migrate_to: str | MigrationTarget = ""
    extra_targets: Sequence[MigrationTarget] = ()
    keep_database_on_failure: bool = False

    _db_name: str = ""
    _alias: str = "default"
    _original_names: dict[str, str] = {}

    @classmethod
    def setUpClass(cls) -> None:
        super().setUpClass()
        cls._assert_postgres_required()
        cls._db_name = cls._build_db_name()
        cls._create_database(cls._db_name)
        cls._original_names = {
            alias: connections.databases[alias]["NAME"]
            for alias in cls._managed_aliases()
        }
        cls._point_connections(cls._db_name)

    @classmethod
    def tearDownClass(cls) -> None:
        keep = cls.keep_database_on_failure and getattr(cls, "_failed", False)
        try:
            for alias in cls._managed_aliases():
                connections[alias].close()
            if cls._original_names:
                for alias, name in cls._original_names.items():
                    connections.databases[alias]["NAME"] = name
                for alias in cls._managed_aliases():
                    connections[alias].close()
            if not keep and cls._db_name:
                cls._drop_database(cls._db_name)
        finally:
            super().tearDownClass()

    def run(self, result=None):
        outcome = super().run(result)
        if result is not None and (result.failures or result.errors):
            type(self)._failed = True
        return outcome

    def run_migration_scenario(self) -> None:
        """执行 migrate_from → seed → migrate_to → assert。子类的 test_* 调用它。"""
        from_targets = self._resolve_targets(self.migrate_from, required=True)
        to_targets = self._resolve_targets(self.migrate_to, required=True)
        extras = list(self.extra_targets)

        connection = connections[self._alias]
        self._migrate(connection, [*extras, *from_targets])
        self.seed_before_migration(connection)
        try:
            self._migrate(connection, [*extras, *to_targets])
        except Exception as exc:  # noqa: BLE001 — 要带上 migration 上下文
            raise AssertionError(
                f"迁移失败: {[f'{a}.{n}' for a, n in to_targets]}；"
                f"临时库={self._db_name}；原始错误={exc}"
            ) from exc
        self.assert_after_migration(connection)

    def seed_before_migration(self, connection) -> None:
        """在 migrate_from 状态写入脏数据。子类必须实现。"""
        raise NotImplementedError

    def assert_after_migration(self, connection) -> None:
        """migrate_to 完成后的断言。子类必须实现。"""
        raise NotImplementedError

    # ── helpers ──────────────────────────────────────────────────────

    def execute(self, sql: str, params: Sequence | None = None) -> None:
        with connections[self._alias].cursor() as cursor:
            cursor.execute(sql, params)

    def fetchone(self, sql: str, params: Sequence | None = None):
        with connections[self._alias].cursor() as cursor:
            cursor.execute(sql, params)
            return cursor.fetchone()

    def fetchall(self, sql: str, params: Sequence | None = None):
        with connections[self._alias].cursor() as cursor:
            cursor.execute(sql, params)
            return cursor.fetchall()

    def column_nullable(self, table: str, column: str) -> bool:
        row = self.fetchone(
            """
            SELECT is_nullable
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = %s
              AND column_name = %s
            """,
            [table, column],
        )
        self.assertIsNotNone(row, f"列不存在: {table}.{column}")
        return row[0] == "YES"

    def column_udt_name(self, table: str, column: str) -> str:
        row = self.fetchone(
            """
            SELECT udt_name
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = %s
              AND column_name = %s
            """,
            [table, column],
        )
        self.assertIsNotNone(row, f"列不存在: {table}.{column}")
        return row[0]

    @classmethod
    def _assert_postgres_required(cls) -> None:
        if os.getenv("USE_SQLITE_FOR_TESTS", "0") == "1":
            raise AssertionError(
                "PostgresMigrationScenarioTestCase 禁止 SQLite。"
                "请用 USE_SQLITE_FOR_TESTS=0 跑真 PostgreSQL。"
            )
        engine = settings.DATABASES["default"]["ENGINE"]
        if "postgresql" not in engine:
            raise AssertionError(
                f"PostgresMigrationScenarioTestCase 需要 PostgreSQL，当前 ENGINE={engine}"
            )

    @classmethod
    def _managed_aliases(cls) -> list[str]:
        aliases = ["default"]
        if "postgresql" in connections.databases:
            aliases.append("postgresql")
        return aliases

    @classmethod
    def _build_db_name(cls) -> str:
        slug = re.sub(r"[^a-z0-9]+", "_", cls.__name__.lower()).strip("_")[:24]
        return f"migscen_{slug}_{uuid.uuid4().hex[:10]}"

    @classmethod
    def _admin_database_name(cls) -> str:
        # 连维护库创建/删除 ephemeral DB；勿连业务库以免锁住。
        return os.getenv("PG_MAINTENANCE_DB", "postgres")

    @classmethod
    def _create_database(cls, name: str) -> None:
        owner = settings.DATABASES["default"]["USER"]
        cls._run_admin_sql(f'CREATE DATABASE "{name}" OWNER "{owner}"')
        cls._run_on_database(
            name,
            "CREATE EXTENSION IF NOT EXISTS vector",
            ignore_errors=True,
        )

    @classmethod
    def _drop_database(cls, name: str) -> None:
        cls._run_admin_sql(
            f"""
            SELECT pg_terminate_backend(pid)
            FROM pg_stat_activity
            WHERE datname = '{name}' AND pid <> pg_backend_pid()
            """
        )
        cls._run_admin_sql(f'DROP DATABASE IF EXISTS "{name}"')

    @classmethod
    def _point_connections(cls, name: str) -> None:
        for alias in cls._managed_aliases():
            connections[alias].close()
            connections.databases[alias]["NAME"] = name
            connections[alias].ensure_connection()

    @classmethod
    def _run_admin_sql(cls, sql: str) -> None:
        cls._run_on_database(cls._admin_database_name(), sql, autocommit=True)

    @classmethod
    def _run_on_database(
        cls,
        database: str,
        sql: str,
        *,
        autocommit: bool = True,
        ignore_errors: bool = False,
    ) -> None:
        import psycopg2

        base = settings.DATABASES["default"]
        conn = psycopg2.connect(
            dbname=database,
            user=base["USER"],
            password=base["PASSWORD"],
            host=base.get("HOST") or "127.0.0.1",
            port=base.get("PORT") or "5432",
        )
        try:
            conn.autocommit = autocommit
            with conn.cursor() as cursor:
                try:
                    cursor.execute(sql)
                except Exception:
                    if not ignore_errors:
                        raise
        finally:
            conn.close()

    def _resolve_targets(
        self,
        value: str | MigrationTarget | Sequence[MigrationTarget],
        *,
        required: bool,
    ) -> list[MigrationTarget]:
        if not value:
            if required:
                raise AssertionError(f"{type(self).__name__} 必须设置 migrate target")
            return []
        if isinstance(value, tuple) and len(value) == 2 and isinstance(value[0], str):
            return [value]  # type: ignore[return-value]
        if isinstance(value, str):
            if not self.app_label:
                raise AssertionError(
                    f"{type(self).__name__} 使用短 migration 名时必须设置 app_label"
                )
            return [(self.app_label, value)]
        return list(value)  # type: ignore[arg-type]

    @staticmethod
    def _migrate(connection, targets: Iterable[MigrationTarget]) -> None:
        target_list = list(targets)
        executor = MigrationExecutor(connection)
        # 重新加载，避免上一次 migrate 后的 graph 缓存干扰。
        executor.loader.build_graph()
        plan = executor.migration_plan(target_list)
        executor.migrate(target_list, plan=plan)
