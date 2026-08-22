"""check_migration_integrity 命令的核心逻辑单元测试。

测试策略：
    使用 unittest.mock.patch 把数据库连接、router、MigrationLoader
    与 app registry 替换成可控 fake，避免依赖真实 MySQL/PostgreSQL。
    覆盖 history 缺失、重复记录、历史残留、schema 快照检查这些分支。

注意：我们不测试 ``Command._cleanup_legacy`` 真实删除行为 —— 该分支属于
有副作用的破坏性操作，单独的 E2E/手工验证覆盖。
"""

from __future__ import annotations

import io
from contextlib import contextmanager
from importlib import import_module
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import MagicMock, call, patch

from django.conf import settings
from django.core.management import CommandError, call_command


class _FakeCursor:
    """最小的 DB-API 2.0 cursor：只支持 ``execute`` + ``fetchall``。"""

    def __init__(self, rows):
        self._rows = list(rows)
        self._last_sql = ""
        self.rowcount = 0

    def execute(self, sql, params=None):
        self._last_sql = sql

    def fetchall(self):
        return list(self._rows)


class _FakeIntrospection:
    def __init__(self, tables=None):
        self._tables = tables or {}

    def table_names(self):
        return list(self._tables.keys())

    def get_table_description(self, cursor, table):
        descriptions = []
        for column in self._tables.get(table, []):
            if isinstance(column, str):
                descriptions.append(
                    SimpleNamespace(
                        name=column,
                        null_ok=True,
                        default=None,
                    )
                )
            else:
                descriptions.append(column)
        return descriptions


class _FakeConnection:
    def __init__(self, rows, tables=None):
        self._rows = rows
        self.introspection = _FakeIntrospection(tables)

    @contextmanager
    def cursor(self):
        yield _FakeCursor(self._rows)


class _UnavailableConnection:
    @contextmanager
    def cursor(self):
        raise RuntimeError("django_migrations is not initialized")
        yield


class _FakeConnectionHandler:
    """模拟 django.db.connections。"""

    def __init__(self, databases):
        self._databases = databases

    @property
    def databases(self):
        return self._databases

    def __getitem__(self, alias):
        return self._databases[alias]

    def all(self):
        return list(self._databases.values())


class _FakeRouter:
    def __init__(self, *, pg_apps=None, dual_apps=None):
        self.pg_apps = set(pg_apps or ())
        self.dual_apps = set(dual_apps or ())

    def allow_migrate(self, db, app_label, model_name=None, **hints):
        if app_label in self.pg_apps:
            return db == "postgresql"
        if app_label in self.dual_apps:
            return True
        return db == "default"

    def db_for_read(self, model, **hints):
        if model._meta.app_label in self.pg_apps:
            return "postgresql"
        return None

    def db_for_write(self, model, **hints):
        if model._meta.app_label in self.pg_apps:
            return "postgresql"
        return None


def _make_loader(disk_migrations, operations_by_key=None, reconciles_by_key=None):
    operations_by_key = operations_by_key or {}
    reconciles_by_key = reconciles_by_key or {}
    loader = MagicMock()
    loader.disk_migrations = {
        (app, name): SimpleNamespace(
            operations=list(operations_by_key.get((app, name), [])),
            reconciles=list(reconciles_by_key.get((app, name), [])),
        )
        for (app, name) in disk_migrations
    }
    return loader


def _make_operation(*, model_name="thing", hints=None):
    return SimpleNamespace(model_name=model_name, hints=hints or {})


def _make_app_configs(app_labels):
    configs = []
    for label in app_labels:
        cfg = MagicMock()
        cfg.label = label
        configs.append(cfg)
    return configs


def _make_model(app_label, model_name, table, columns):
    fields = [SimpleNamespace(column=column) for column in columns]
    meta = SimpleNamespace(
        app_label=app_label,
        model_name=model_name,
        db_table=table,
        fields=fields,
        proxy=False,
        managed=True,
    )
    return SimpleNamespace(_meta=meta)


class CheckMigrationIntegrityTests(TestCase):
    """给定 fake 两库记录 + fake 磁盘 migration 文件 + fake INSTALLED_APPS，验证输出。"""

    def _run(
        self,
        default_rows,
        pg_rows,
        disk_migrations,
        installed_apps,
        *,
        argv,
        operations_by_key=None,
        reconciles_by_key=None,
        models=None,
        default_tables=None,
        pg_tables=None,
        router=None,
    ):
        connections = _FakeConnectionHandler(
            {
                "default": _FakeConnection(default_rows, default_tables),
                "postgresql": _FakeConnection(pg_rows, pg_tables),
            }
        )
        loader = _make_loader(
            disk_migrations,
            operations_by_key,
            reconciles_by_key,
        )
        app_configs = _make_app_configs(installed_apps)
        fake_router = router or _FakeRouter(
            pg_apps={"tabdata"}, dual_apps={"users_auth"}
        )

        stdout = io.StringIO()
        stderr = io.StringIO()

        with (
            patch.object(
                settings,
                "TABTIN_MIGRATION_DATABASE_ALIASES",
                ["default", "postgresql"],
            ),
            patch(
                "apps.services.migration_guard.management.commands.check_migration_integrity.connections",
                connections,
            ),
            patch(
                "apps.services.migration_guard.management.commands.check_migration_integrity.MigrationLoader",
                return_value=loader,
            ),
            patch(
                "apps.services.migration_guard.management.commands.check_migration_integrity.db_router",
                fake_router,
            ),
            patch(
                "apps.services.migration_guard.management.commands.check_migration_integrity._django_apps"
            ) as apps_mock,
        ):
            apps_mock.get_app_configs.return_value = app_configs
            apps_mock.get_models.return_value = models or []
            call_command(
                "check_migration_integrity",
                *argv,
                stdout=stdout,
                stderr=stderr,
            )
        return stdout.getvalue(), stderr.getvalue()

    def test_two_databases_in_sync_passes_strict(self) -> None:
        rows = [
            (1, "tabdata", "0001_initial"),
            (2, "users_auth", "0001_initial"),
        ]
        out, _err = self._run(
            default_rows=rows,
            pg_rows=rows,
            disk_migrations={
                ("tabdata", "0001_initial"),
                ("users_auth", "0001_initial"),
            },
            installed_apps={"tabdata", "users_auth"},
            argv=["--strict"],
        )
        self.assertIn("跨库完全一致", out)

    def test_artifact_preflight_supports_fresh_database(self) -> None:
        connections = _FakeConnectionHandler({"default": _UnavailableConnection()})
        loader = _make_loader({("tabdata", "0001_initial")})
        stdout = io.StringIO()

        with (
            patch.object(settings, "TABTIN_MIGRATION_DATABASE_ALIASES", ["default"]),
            patch(
                "apps.services.migration_guard.management.commands.check_migration_integrity.connections",
                connections,
            ),
            patch(
                "apps.services.migration_guard.management.commands.check_migration_integrity.MigrationLoader",
                return_value=loader,
            ) as loader_cls,
            patch(
                "apps.services.migration_guard.management.commands.check_migration_integrity._django_apps"
            ) as apps_mock,
        ):
            apps_mock.get_app_configs.return_value = _make_app_configs({"tabdata"})
            call_command(
                "check_migration_integrity",
                artifact_preflight=True,
                stdout=stdout,
            )

        loader_cls.assert_called_once_with(
            connections["default"],
            ignore_no_migrations=True,
        )
        self.assertIn("仅执行发布包 migration graph 预检", stdout.getvalue())

    def test_active_gap_reports_missing_in_strict_mode(self) -> None:
        """MySQL 有 tabdata.0002，但 PG 没有；磁盘存在 → 应判定为活跃 gap。"""
        default_rows = [
            (1, "tabdata", "0001_initial"),
            (2, "tabdata", "0002_add_col"),
        ]
        pg_rows = [(1, "tabdata", "0001_initial")]

        with self.assertRaises(CommandError):
            self._run(
                default_rows=default_rows,
                pg_rows=pg_rows,
                disk_migrations={
                    ("tabdata", "0001_initial"),
                    ("tabdata", "0002_add_col"),
                },
                installed_apps={"tabdata"},
                argv=["--strict"],
                operations_by_key={
                    ("tabdata", "0002_add_col"): [_make_operation(model_name="share")]
                },
            )

    def test_active_gap_non_strict_is_non_fatal(self) -> None:
        """非 strict 模式下同样差异应输出报告但不抛异常。"""
        default_rows = [
            (1, "tabdata", "0001_initial"),
            (2, "tabdata", "0002_add_col"),
        ]
        pg_rows = [(1, "tabdata", "0001_initial")]

        out, _err = self._run(
            default_rows=default_rows,
            pg_rows=pg_rows,
            disk_migrations={("tabdata", "0001_initial"), ("tabdata", "0002_add_col")},
            installed_apps={"tabdata"},
            argv=[],
            operations_by_key={
                ("tabdata", "0002_add_col"): [_make_operation(model_name="share")]
            },
        )
        self.assertIn("跨库不一致", out)
        self.assertIn("postgresql", out)
        self.assertIn("0002_add_col", out)
        self.assertIn("目标库记录缺失", out)

    def test_missing_everywhere_is_reported(self) -> None:
        """两库都没有新 migration 记录时，也不能被旧的“跨库一致”逻辑漏掉。"""
        rows = [(1, "tabdata", "0001_initial")]

        out, _err = self._run(
            default_rows=rows,
            pg_rows=rows,
            disk_migrations={("tabdata", "0001_initial"), ("tabdata", "0002_add_col")},
            installed_apps={"tabdata"},
            argv=[],
            operations_by_key={
                ("tabdata", "0002_add_col"): [_make_operation(model_name="share")]
            },
        )

        self.assertIn("完全未记录", out)
        self.assertIn("0002_add_col", out)

    def test_missing_shadow_record_is_labelled_with_target_db(self) -> None:
        """默认库 DDL 已跑、PG 缺影子记录时，报告应明确它不是 PG DDL 缺失。"""
        default_rows = [
            (1, "billing", "0001_initial"),
            (2, "billing", "0002_add_col"),
        ]
        pg_rows = [(1, "billing", "0001_initial")]

        out, _err = self._run(
            default_rows=default_rows,
            pg_rows=pg_rows,
            disk_migrations={("billing", "0001_initial"), ("billing", "0002_add_col")},
            installed_apps={"billing"},
            argv=[],
            operations_by_key={
                ("billing", "0002_add_col"): [_make_operation(model_name="invoice")]
            },
            router=_FakeRouter(pg_apps=set(), dual_apps=set()),
        )

        self.assertIn("影子记录缺失", out)
        self.assertIn("DDL目标=default", out)

    def test_duplicate_record_detected(self) -> None:
        """PG 上同一条 migration 有 2 条记录（不同 id）→ 应报重复。"""
        default_rows = [(1, "tabdata", "0001_initial")]
        pg_rows = [
            (10, "tabdata", "0001_initial"),
            (11, "tabdata", "0001_initial"),
        ]

        with self.assertRaises(CommandError):
            self._run(
                default_rows=default_rows,
                pg_rows=pg_rows,
                disk_migrations={("tabdata", "0001_initial")},
                installed_apps={"tabdata"},
                argv=["--strict"],
            )

    def test_legacy_from_deleted_app_does_not_block(self) -> None:
        """orchestration 已从 INSTALLED_APPS 删除 → 应归类为历史残留、不阻断。"""
        default_rows = [
            (1, "tabdata", "0001_initial"),
            (2, "orchestration", "0001_initial"),
        ]
        pg_rows = [(1, "tabdata", "0001_initial")]

        out, _err = self._run(
            default_rows=default_rows,
            pg_rows=pg_rows,
            disk_migrations={("tabdata", "0001_initial")},
            installed_apps={"tabdata"},
            argv=["--strict"],
        )
        self.assertIn("历史残留", out)
        self.assertIn("default=1", out)
        self.assertNotIn("活跃 app 的 migration history 跨库不一致", out)

    def test_applied_migration_missing_from_active_app_blocks_strict(self) -> None:
        """活跃 app 在库中执行过发布包不存在的迁移，必须阻断发布。"""
        rows = [
            (1, "tabdata", "0001_initial"),
            (2, "tabdata", "0047_table_managed_type"),
        ]

        with self.assertRaises(CommandError):
            self._run(
                default_rows=rows,
                pg_rows=rows,
                disk_migrations={("tabdata", "0001_initial")},
                installed_apps={"tabdata"},
                argv=["--strict"],
            )

    def test_compensating_migration_can_explain_missing_applied_file(self) -> None:
        rows = [
            (1, "tabdata", "0001_initial"),
            (2, "tabdata", "0047_table_managed_type"),
            (3, "tabdata", "0047_remove_orphaned_managed_type"),
        ]

        out, _err = self._run(
            default_rows=rows,
            pg_rows=rows,
            disk_migrations={
                ("tabdata", "0001_initial"),
                ("tabdata", "0047_remove_orphaned_managed_type"),
            },
            installed_apps={"tabdata"},
            argv=["--artifact-preflight"],
            reconciles_by_key={
                ("tabdata", "0047_remove_orphaned_managed_type"): [
                    ("tabdata", "0047_table_managed_type")
                ]
            },
        )

        self.assertNotIn("发布包外 migration", out)

    def test_release_artifact_reconciles_ack_test_260812_history(self) -> None:
        """release 包可解释 ACK Test 先行执行的三组 migration history。"""
        applied_outside_release = {
            ("conversation", "0089_remove_chatsession_approval_mode"),
            ("conversation", "0090_merge_20260808_2145"),
            ("conversation", "0092_merge_20260810_1609"),
            ("conversation", "0093_backfill_system_authored_message_roles"),
            ("conversation", "0094_backfill_remaining_system_authored_roles"),
            (
                "conversation",
                "0095_alter_chatmessage_external_archive_context_kind",
            ),
            ("conversation", "0096_sessionshare_v2_contract"),
            ("tabchat", "0023_agent_mention_snapshots"),
            ("tabchat", "0024_handoff_message_refs"),
            ("tabchat", "0025_relax_retired_django_im_columns"),
            ("tabdoc", "0038_restore_comment_threads"),
            ("tabdoc", "0039_restore_comment_thread_projection"),
        }
        reconciler_modules = {
            ("conversation", "0097_reconcile_test_260812_history"): (
                "apps.chat.conversation.migrations."
                "0097_reconcile_test_260812_history"
            ),
            ("tabchat", "0026_reconcile_test_260812_history"): (
                "apps.tabchat.migrations.0026_reconcile_test_260812_history"
            ),
            ("tabdoc", "0040_reconcile_test_260812_history"): (
                "apps.tabdoc.migrations.0040_reconcile_test_260812_history"
            ),
        }
        rows = [
            (index, app, name)
            for index, (app, name) in enumerate(
                sorted(applied_outside_release),
                start=1,
            )
        ]

        out, _err = self._run(
            default_rows=rows,
            pg_rows=rows,
            disk_migrations=set(reconciler_modules),
            installed_apps={"conversation", "notification", "tabchat", "tabdoc"},
            argv=["--artifact-preflight"],
            reconciles_by_key={
                key: import_module(module_name).Migration.reconciles
                for key, module_name in reconciler_modules.items()
            },
        )

        self.assertNotIn("发布包外 migration", out)

    def test_include_legacy_shows_breakdown(self) -> None:
        default_rows = [
            (1, "tabdata", "0001_initial"),
            (2, "orchestration", "0001_initial"),
            (3, "billing", "0001_squashed"),
            (4, "billing", "0099_removed_by_squash"),
        ]
        pg_rows = [
            (1, "tabdata", "0001_initial"),
            (2, "billing", "0001_squashed"),
        ]

        out, _err = self._run(
            default_rows=default_rows,
            pg_rows=pg_rows,
            disk_migrations={("tabdata", "0001_initial"), ("billing", "0001_squashed")},
            installed_apps={"tabdata", "billing"},
            argv=["--include-legacy"],
        )
        self.assertIn("历史残留详情", out)
        self.assertIn("orchestration", out)
        self.assertIn("billing", out)

    def test_schema_check_reports_missing_current_model_column(self) -> None:
        rows = [(1, "tabdata", "0001_initial")]
        share_model = _make_model(
            "tabdata",
            "share",
            "tabdata_share",
            columns=["id", "password_hash"],
        )

        out, _err = self._run(
            default_rows=rows,
            pg_rows=rows,
            disk_migrations={("tabdata", "0001_initial")},
            installed_apps={"tabdata"},
            argv=["--schema"],
            models=[share_model],
            pg_tables={"tabdata_share": ["id"]},
        )

        self.assertIn("schema 与目标数据库不一致", out)
        self.assertIn("postgresql.tabdata_share", out)
        self.assertIn("password_hash", out)

    def test_schema_check_reports_extra_required_column_without_default(self) -> None:
        """ORM 不声明的 NOT NULL 无默认列会让 INSERT 失败，必须算 schema 漂移。"""
        rows = [(1, "tabdata", "0001_initial")]
        table_model = _make_model(
            "billing",
            "table",
            "tabdata_table",
            columns=["id", "name"],
        )
        managed_type = SimpleNamespace(
            name="managed_type",
            null_ok=False,
            default=None,
        )

        with self.assertRaises(CommandError):
            self._run(
                default_rows=rows,
                pg_rows=rows,
                disk_migrations={("tabdata", "0001_initial")},
                installed_apps={"tabdata", "billing"},
                argv=["--schema", "--strict"],
                models=[table_model],
                default_tables={"tabdata_table": ["id", "name", managed_type]},
            )


class SafeMigrateSmokeTest(TestCase):
    """safe_migrate 命令加载不报错（不实际对数据库 apply migration）。"""

    def test_safe_migrate_plan_runs_without_error(self) -> None:
        """--plan 模式不会实际修改数据库，只验证命令可 import/parser 正常。"""
        with (
            patch(
                "apps.services.migration_guard.management.commands.safe_migrate.call_command"
            ) as call_mock,
            patch(
                "apps.services.migration_guard.management.commands.safe_migrate.connections"
            ) as connections_mock,
        ):
            connections_mock.databases = {"default": object(), "postgresql": object()}
            stdout = io.StringIO()
            call_command("safe_migrate", "--plan", stdout=stdout)

            expected_aliases = list(settings.TABTIN_MIGRATION_DATABASE_ALIASES)
            self.assertEqual(call_mock.call_count, len(expected_aliases))
            actual_aliases = [
                call.kwargs.get("database") for call in call_mock.call_args_list
            ]
            self.assertEqual(actual_aliases, expected_aliases)

    def test_safe_migrate_runs_artifact_preflight_and_schema_postflight(self) -> None:
        with (
            patch(
                "apps.services.migration_guard.management.commands.safe_migrate.call_command"
            ) as call_mock,
            patch(
                "apps.services.migration_guard.management.commands.safe_migrate.reconcile_split_migration_history",
                return_value=[],
            ),
        ):
            call_command("safe_migrate", "--noinput")

        self.assertEqual(
            call_mock.call_args_list[0],
            call("check_migration_integrity", artifact_preflight=True),
        )
        self.assertEqual(call_mock.call_args_list[-1].args, ("check_migration_integrity",))
        self.assertEqual(
            call_mock.call_args_list[-1].kwargs,
            {"strict": True, "schema": True},
        )
