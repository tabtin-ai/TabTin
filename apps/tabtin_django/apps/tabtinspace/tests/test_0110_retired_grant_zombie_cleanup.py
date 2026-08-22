"""#6443：0110 在 DROP Space 前幂等清理 SF-1 退役 grant 僵尸表。"""

from __future__ import annotations

import importlib
from types import SimpleNamespace

from django.db import connection
from django.test import TestCase


MIGRATION_MODULE = "apps.tabtinspace.migrations.0110_delete_space_model_3266"


class RetireGrantZombieCleanup0110Tests(TestCase):
    def _migration(self):
        return importlib.import_module(MIGRATION_MODULE)

    def _schema_editor(self):
        return SimpleNamespace(connection=connection)

    def _table_exists(self, table_name: str) -> bool:
        with connection.cursor() as cursor:
            return table_name in set(connection.introspection.table_names(cursor))

    def test_drop_retired_grant_zombies_removes_empty_space_share(self):
        migration = self._migration()
        with connection.cursor() as cursor:
            cursor.execute("DROP TABLE IF EXISTS tabtinspace_space_share")
            cursor.execute(
                """
                CREATE TABLE tabtinspace_space_share (
                    id uuid PRIMARY KEY,
                    space_id uuid NULL
                )
                """
            )
        self.assertTrue(self._table_exists("tabtinspace_space_share"))

        migration.forwards_drop_retired_grant_zombies(None, self._schema_editor())

        self.assertFalse(self._table_exists("tabtinspace_space_share"))

    def test_drop_retired_grant_zombies_is_idempotent_when_missing(self):
        migration = self._migration()
        with connection.cursor() as cursor:
            cursor.execute("DROP TABLE IF EXISTS tabtinspace_space_share")
            cursor.execute("DROP TABLE IF EXISTS tabtinspace_delegation_grant")

        migration.forwards_drop_retired_grant_zombies(None, self._schema_editor())
        migration.forwards_drop_retired_grant_zombies(None, self._schema_editor())

        self.assertFalse(self._table_exists("tabtinspace_space_share"))
        self.assertFalse(self._table_exists("tabtinspace_delegation_grant"))

    def test_assert_no_space_fks_fails_while_space_share_fk_exists(self):
        if connection.vendor != "postgresql":
            self.skipTest("pg_constraint 断言仅覆盖 PostgreSQL")

        migration = self._migration()
        created_space = False
        with connection.cursor() as cursor:
            cursor.execute("DROP TABLE IF EXISTS tabtinspace_space_share CASCADE")
            if not self._table_exists("tabtinspace_space"):
                cursor.execute(
                    """
                    CREATE TABLE tabtinspace_space (
                        id uuid PRIMARY KEY
                    )
                    """
                )
                created_space = True
            cursor.execute(
                """
                CREATE TABLE tabtinspace_space_share (
                    id uuid PRIMARY KEY,
                    space_id uuid NOT NULL
                        REFERENCES tabtinspace_space(id)
                )
                """
            )
            try:
                with self.assertRaises(RuntimeError) as ctx:
                    migration.forwards_assert_no_space_fks(None, self._schema_editor())
                self.assertIn("tabtinspace_space_share", str(ctx.exception))

                migration.forwards_drop_retired_grant_zombies(None, self._schema_editor())
                migration.forwards_assert_no_space_fks(None, self._schema_editor())
            finally:
                cursor.execute("DROP TABLE IF EXISTS tabtinspace_space_share CASCADE")
                if created_space:
                    cursor.execute("DROP TABLE IF EXISTS tabtinspace_space CASCADE")
