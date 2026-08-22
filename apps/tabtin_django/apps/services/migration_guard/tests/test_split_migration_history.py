"""#6333 split_migration_history：旧单体半账补记逻辑。"""

from __future__ import annotations

from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import MagicMock, patch

from apps.services.migration_guard import split_migration_history as mod


class _FakeCursor:
    def __init__(self, *, index_rows=None, table_desc=None):
        self._index_rows = list(index_rows or [])
        self._table_desc = table_desc or []
        self._sql = ""

    def execute(self, sql, params=None):
        self._sql = sql

    def fetchone(self):
        if "pg_class" in self._sql:
            return self._index_rows[0] if self._index_rows else None
        return None

    def fetchall(self):
        return list(self._index_rows)


class _FakeIntrospection:
    def __init__(self, tables):
        self._tables = tables

    def table_names(self):
        return list(self._tables.keys())

    def get_table_description(self, cursor, table):
        return [
            SimpleNamespace(name=col) for col in self._tables.get(table, [])
        ]


class _FakeConnection:
    vendor = "postgresql"

    def __init__(self, tables, *, index_names=None):
        self.introspection = _FakeIntrospection(tables)
        self._index_names = set(index_names or [])

    def cursor(self):
        return _CursorCtx(_FakeCursorWithIndexes(self._index_names))


class _FakeCursorWithIndexes(_FakeCursor):
    def __init__(self, index_names):
        super().__init__()
        self._index_names = index_names
        self._params = None

    def execute(self, sql, params=None):
        self._sql = sql
        self._params = params

    def fetchone(self):
        if "pg_class" in self._sql and self._params:
            name = self._params[0]
            return (1,) if name in self._index_names else None
        return None


class _CursorCtx:
    def __init__(self, cursor):
        self._cursor = cursor

    def __enter__(self):
        return self._cursor

    def __exit__(self, *args):
        return False


def _loader(disk_keys):
    """disk_keys: iterable of migration names (tabtinspace) or (app, name) tuples."""
    loader = MagicMock()
    disk = {}
    for item in disk_keys:
        if isinstance(item, tuple):
            disk[item] = object()
        else:
            disk[(mod.TABTINSPACE, item)] = object()
    loader.disk_migrations = disk
    return loader


def _recorder(applied_keys):
    """applied_keys: migration names (tabtinspace) or (app, name) tuples."""
    recorder = MagicMock()
    applied = set()
    for item in applied_keys:
        if isinstance(item, tuple):
            applied.add(item)
        else:
            applied.add((mod.TABTINSPACE, item))
    recorder.applied_migrations.return_value = applied
    return recorder


def _space(name: str) -> tuple[str, str]:
    return (mod.TABTINSPACE, name)


class PlanFakeSplitMigrationsTests(TestCase):
    def test_noop_when_split_files_absent(self):
        conn = _FakeConnection(
            {mod.TABLE_CONTEXT_ITEM: [mod.COLUMN_WORKSPACE_ID]},
            index_names={mod.INDEX_0107B_MARKER},
        )
        planned = mod.plan_fake_split_migrations(
            conn,
            loader=_loader([mod.MIGRATION_0107, mod.MIGRATION_0108]),
            recorder=_recorder([mod.MIGRATION_0107, mod.MIGRATION_0108]),
        )
        self.assertEqual(planned, [])

    def test_test_like_half_ledger_fakes_0107_and_0108_splits(self):
        conn = _FakeConnection(
            {
                mod.TABLE_CONTEXT_ITEM: [mod.COLUMN_WORKSPACE_ID],
                mod.TABLE_SPACE_APP_SETTINGS: [mod.COLUMN_WORKSPACE_ID],
            },
            index_names={mod.INDEX_0107B_MARKER},
        )
        disk = [
            mod.MIGRATION_0107,
            mod.MIGRATION_0107A,
            mod.MIGRATION_0107B,
            mod.MIGRATION_0108,
            mod.MIGRATION_0108A,
            mod.MIGRATION_0108B,
        ]
        planned = mod.plan_fake_split_migrations(
            conn,
            loader=_loader(disk),
            recorder=_recorder([mod.MIGRATION_0107, mod.MIGRATION_0108]),
        )
        self.assertEqual(
            planned,
            [
                _space(mod.MIGRATION_0107A),
                _space(mod.MIGRATION_0107B),
                _space(mod.MIGRATION_0108A),
                _space(mod.MIGRATION_0108B),
            ],
        )

    def test_skip_0108_split_when_space_column_still_present(self):
        conn = _FakeConnection(
            {
                mod.TABLE_CONTEXT_ITEM: [
                    mod.COLUMN_WORKSPACE_ID,
                    mod.COLUMN_SPACE_ID,
                ],
                mod.TABLE_SPACE_APP_SETTINGS: [
                    mod.COLUMN_WORKSPACE_ID,
                    mod.COLUMN_SPACE_ID,
                ],
            },
            index_names={mod.INDEX_0107B_MARKER},
        )
        disk = [
            mod.MIGRATION_0107,
            mod.MIGRATION_0107A,
            mod.MIGRATION_0107B,
            mod.MIGRATION_0108,
            mod.MIGRATION_0108A,
            mod.MIGRATION_0108B,
        ]
        planned = mod.plan_fake_split_migrations(
            conn,
            loader=_loader(disk),
            recorder=_recorder([
                mod.MIGRATION_0107,
                mod.MIGRATION_0107A,
                mod.MIGRATION_0107B,
                mod.MIGRATION_0108,
            ]),
        )
        self.assertEqual(planned, [])

    def test_fake_0107_split_only_when_indexes_present_and_0108_not_applied(self):
        conn = _FakeConnection(
            {mod.TABLE_CONTEXT_ITEM: [mod.COLUMN_WORKSPACE_ID]},
            index_names={mod.INDEX_0107B_MARKER},
        )
        disk = [
            mod.MIGRATION_0107,
            mod.MIGRATION_0107A,
            mod.MIGRATION_0107B,
        ]
        planned = mod.plan_fake_split_migrations(
            conn,
            loader=_loader(disk),
            recorder=_recorder([mod.MIGRATION_0107]),
        )
        self.assertEqual(
            planned,
            [_space(mod.MIGRATION_0107A), _space(mod.MIGRATION_0107B)],
        )

    def test_noop_when_already_complete(self):
        conn = _FakeConnection(
            {
                mod.TABLE_CONTEXT_ITEM: [mod.COLUMN_WORKSPACE_ID],
                mod.TABLE_SPACE_APP_SETTINGS: [mod.COLUMN_WORKSPACE_ID],
            },
            index_names={mod.INDEX_0107B_MARKER},
        )
        disk = [
            mod.MIGRATION_0107,
            mod.MIGRATION_0107A,
            mod.MIGRATION_0107B,
            mod.MIGRATION_0108,
            mod.MIGRATION_0108A,
            mod.MIGRATION_0108B,
        ]
        planned = mod.plan_fake_split_migrations(
            conn,
            loader=_loader(disk),
            recorder=_recorder(disk),
        )
        self.assertEqual(planned, [])

    def test_fake_0105a_when_0106_applied_and_space_renamed_to_workspace(self):
        conn = _FakeConnection(
            {
                mod.TABLE_WORKSPACE: ["id", "kind"],
                mod.TABLE_CONTEXT_ITEM: ["id", "project_id"],
            },
        )
        disk = [
            mod.MIGRATION_0105,
            mod.MIGRATION_0105A,
            mod.MIGRATION_0106_CONTEXT,
        ]
        planned = mod.plan_fake_split_migrations(
            conn,
            loader=_loader(disk),
            recorder=_recorder([mod.MIGRATION_0105, mod.MIGRATION_0106_CONTEXT]),
        )
        self.assertEqual(planned, [_space(mod.MIGRATION_0105A)])

    def test_fake_agent_0004_split_when_0005_applied(self):
        conn = _FakeConnection(
            {"agents_agent": ["id", "is_default"]},
            index_names={mod.INDEX_AGENT_0004B_MARKER},
        )
        disk = [
            (mod.AGENT, mod.MIGRATION_AGENT_0004),
            (mod.AGENT, mod.MIGRATION_AGENT_0004A),
            (mod.AGENT, mod.MIGRATION_AGENT_0004B),
            (mod.AGENT, mod.MIGRATION_AGENT_0005),
        ]
        planned = mod.plan_fake_split_migrations(
            conn,
            loader=_loader(disk),
            recorder=_recorder([
                (mod.AGENT, mod.MIGRATION_AGENT_0004),
                (mod.AGENT, mod.MIGRATION_AGENT_0005),
            ]),
        )
        self.assertEqual(
            planned,
            [
                (mod.AGENT, mod.MIGRATION_AGENT_0004A),
                (mod.AGENT, mod.MIGRATION_AGENT_0004B),
            ],
        )


class ReconcileSplitMigrationHistoryTests(TestCase):
    def test_records_applied_in_order(self):
        conn = _FakeConnection(
            {
                mod.TABLE_CONTEXT_ITEM: [mod.COLUMN_WORKSPACE_ID],
                mod.TABLE_SPACE_APP_SETTINGS: [mod.COLUMN_WORKSPACE_ID],
            },
            index_names={mod.INDEX_0107B_MARKER},
        )
        recorder = _recorder([mod.MIGRATION_0107, mod.MIGRATION_0108])
        disk = [
            mod.MIGRATION_0107,
            mod.MIGRATION_0107A,
            mod.MIGRATION_0107B,
            mod.MIGRATION_0108,
            mod.MIGRATION_0108A,
            mod.MIGRATION_0108B,
        ]
        with patch.object(mod, "connections", {"default": conn}), patch.object(
            mod, "MigrationLoader", return_value=_loader(disk)
        ), patch.object(mod, "MigrationRecorder", return_value=recorder):
            recorded = mod.reconcile_split_migration_history(database="default")

        self.assertEqual(
            recorded,
            [
                f"{mod.TABTINSPACE}.{mod.MIGRATION_0107A}",
                f"{mod.TABTINSPACE}.{mod.MIGRATION_0107B}",
                f"{mod.TABTINSPACE}.{mod.MIGRATION_0108A}",
                f"{mod.TABTINSPACE}.{mod.MIGRATION_0108B}",
            ],
        )
        self.assertEqual(recorder.record_applied.call_count, 4)
        recorder.record_applied.assert_any_call(mod.TABTINSPACE, mod.MIGRATION_0107B)

    def test_skips_non_postgresql(self):
        conn = _FakeConnection({})
        conn.vendor = "sqlite"
        with patch.object(mod, "connections", {"default": conn}):
            self.assertEqual(
                mod.reconcile_split_migration_history(database="default"),
                [],
            )
