"""#8942：缓存命中的 native schema 仍需校验数据库侧权限。"""

from __future__ import annotations

import uuid
from contextlib import nullcontext
from unittest.mock import patch

from django.db import ProgrammingError
from django.test import SimpleTestCase

from apps.tabdata.native.ddl_manager import (
    DDLManager,
    SchemaPrivilegeError,
    _ENSURED_SCHEMAS,
)


class _PrivilegeDriftCursor:
    """最小 PostgreSQL cursor：权限修复前 CREATE TABLE 复现用户错误。"""

    def __init__(
        self,
        *,
        create_schema_error: bool = False,
        grant_error: bool = False,
    ) -> None:
        self.has_privileges = False
        self.create_schema_error = create_schema_error
        self.grant_error = grant_error
        self.executed: list[tuple[str, object]] = []

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def execute(self, sql, params=None):
        self.executed.append((sql, params))
        normalized = " ".join(sql.split()).upper()
        if normalized.startswith("CREATE SCHEMA") and self.create_schema_error:
            raise ProgrammingError("permission denied for database tabtin_single")
        if normalized.startswith("GRANT USAGE, CREATE ON SCHEMA"):
            if self.grant_error:
                raise ProgrammingError("must be owner of schema")
            self.has_privileges = True
        if normalized.startswith("CREATE TABLE") and not self.has_privileges:
            raise ProgrammingError(
                "permission denied for schema as_cached_organization"
            )

    def fetchone(self):
        return (self.has_privileges,)


class _Connection:
    def __init__(self, cursor: _PrivilegeDriftCursor) -> None:
        self._cursor = cursor

    def cursor(self):
        return self._cursor


class DDLManagerSchemaPrivilegeRegressionTests(SimpleTestCase):
    def setUp(self) -> None:
        self.on_commit_patcher = patch(
            "apps.tabdata.native.ddl_manager.transaction.on_commit",
            side_effect=lambda callback, using=None: callback(),
        )
        self.on_commit = self.on_commit_patcher.start()
        self.addCleanup(self.on_commit_patcher.stop)

    def tearDown(self) -> None:
        _ENSURED_SCHEMAS.clear()

    def test_existing_schema_grants_runtime_role_before_create_table(self):
        organization_id = uuid.uuid4()
        table_id = uuid.uuid4()
        cursor = _PrivilegeDriftCursor()

        with patch(
            "apps.tabdata.native.ddl_manager.connections",
            {"default": _Connection(cursor)},
        ), patch(
            "apps.tabdata.native.ddl_manager.transaction.atomic",
            return_value=nullcontext(),
        ):
            ddl = DDLManager(db_alias="default")
            ddl.ensure_schema(organization_id)
            ddl.create_native_table(organization_id, table_id)

        statements = [" ".join(sql.split()).upper() for sql, _ in cursor.executed]
        grant_index = next(
            i for i, sql in enumerate(statements)
            if sql.startswith("GRANT USAGE, CREATE ON SCHEMA")
        )
        create_table_index = next(
            i for i, sql in enumerate(statements)
            if sql.startswith("CREATE TABLE")
        )
        self.assertLess(grant_index, create_table_index, statements)

    def test_cached_schema_reconciles_privileges_before_create_table(self):
        organization_id = uuid.uuid4()
        table_id = uuid.uuid4()
        schema = DDLManager.schema_name(organization_id)
        cursor = _PrivilegeDriftCursor()
        _ENSURED_SCHEMAS.add(schema)

        with patch(
            "apps.tabdata.native.ddl_manager.connections",
            {"default": _Connection(cursor)},
        ), patch(
            "apps.tabdata.native.ddl_manager.transaction.atomic",
            return_value=nullcontext(),
        ):
            ddl = DDLManager(db_alias="default")
            ddl.ensure_schema(organization_id)
            ddl.create_native_table(organization_id, table_id)

        statements = [" ".join(sql.split()).upper() for sql, _ in cursor.executed]
        self.assertTrue(
            any(sql.startswith("SELECT HAS_SCHEMA_PRIVILEGE") for sql in statements),
            statements,
        )
        self.assertTrue(
            any(sql.startswith("GRANT USAGE, CREATE ON SCHEMA") for sql in statements),
            statements,
        )

    def test_cached_schema_with_valid_privileges_keeps_fast_path(self):
        organization_id = uuid.uuid4()
        schema = DDLManager.schema_name(organization_id)
        cursor = _PrivilegeDriftCursor()
        cursor.has_privileges = True
        _ENSURED_SCHEMAS.add(schema)

        with patch(
            "apps.tabdata.native.ddl_manager.connections",
            {"default": _Connection(cursor)},
        ):
            DDLManager(db_alias="default").ensure_schema(organization_id)

        statements = [" ".join(sql.split()).upper() for sql, _ in cursor.executed]
        self.assertEqual(len(statements), 1, statements)
        self.assertTrue(statements[0].startswith("SELECT HAS_SCHEMA_PRIVILEGE"))

    def test_standard_role_gets_actionable_error_when_repair_is_forbidden(self):
        organization_id = uuid.uuid4()
        cursor = _PrivilegeDriftCursor(grant_error=True)

        with patch(
            "apps.tabdata.native.ddl_manager.connections",
            {"default": _Connection(cursor)},
        ), patch(
            "apps.tabdata.native.ddl_manager.transaction.atomic",
            return_value=nullcontext(),
        ):
            with self.assertRaisesRegex(SchemaPrivilegeError, "RDS 高权限账号"):
                DDLManager(db_alias="default").ensure_schema(organization_id)

    def test_create_schema_permission_error_is_actionable_and_uses_selected_alias(self):
        organization_id = uuid.uuid4()
        cursor = _PrivilegeDriftCursor(create_schema_error=True)

        with patch(
            "apps.tabdata.native.ddl_manager.connections",
            {"custom": _Connection(cursor)},
        ), patch(
            "apps.tabdata.native.ddl_manager.transaction.atomic",
            return_value=nullcontext(),
        ) as atomic:
            with self.assertRaisesRegex(SchemaPrivilegeError, "RDS 高权限账号"):
                DDLManager(db_alias="custom").ensure_schema(organization_id)

        atomic.assert_called_once_with(using="custom")

    def test_schema_cache_is_registered_only_after_transaction_commit(self):
        organization_id = uuid.uuid4()
        schema = DDLManager.schema_name(organization_id)
        cursor = _PrivilegeDriftCursor()
        callbacks = []
        self.on_commit.side_effect = lambda callback, using=None: callbacks.append(
            (callback, using),
        )

        with patch(
            "apps.tabdata.native.ddl_manager.connections",
            {"default": _Connection(cursor)},
        ), patch(
            "apps.tabdata.native.ddl_manager.transaction.atomic",
            return_value=nullcontext(),
        ):
            DDLManager(db_alias="default").ensure_schema(organization_id)

        self.assertNotIn(schema, _ENSURED_SCHEMAS)
        self.assertEqual(len(callbacks), 1)
        callback, using = callbacks[0]
        self.assertEqual(using, "default")
        callback()
        self.assertIn(schema, _ENSURED_SCHEMAS)
