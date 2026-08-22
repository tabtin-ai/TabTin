from __future__ import annotations

from io import StringIO
from unittest.mock import patch
import unittest

from django.core.management import call_command
from django.core.management.base import CommandError


class TabDocVerifyMigrationCommandTests(unittest.TestCase):
    @patch("apps.tabdoc.management.commands.tabdoc_verify_migration.Command._fetch_version_stats", return_value=(0, 0))
    @patch("apps.tabdoc.management.commands.tabdoc_verify_migration.Command._constraint_exists", return_value=True)
    @patch("apps.tabdoc.management.commands.tabdoc_verify_migration.Command._column_exists", return_value=True)
    @patch("apps.tabdoc.management.commands.tabdoc_verify_migration.Command._table_exists", return_value=True)
    @patch(
        "apps.tabdoc.management.commands.tabdoc_verify_migration.Command._is_migration_applied",
        side_effect=[True, False],
    )
    def test_verify_migration_success_in_strict_mode(
        self,
        _mock_migration,
        _mock_table,
        _mock_column,
        _mock_constraint,
        _mock_stats,
    ):
        out = StringIO()
        call_command("tabdoc_verify_migration", "--strict", stdout=out)
        output = out.getvalue()
        self.assertIn("迁移验收通过", output)

    @patch("apps.tabdoc.management.commands.tabdoc_verify_migration.Command._fetch_version_stats", return_value=(0, 0))
    @patch("apps.tabdoc.management.commands.tabdoc_verify_migration.Command._constraint_exists", return_value=True)
    @patch("apps.tabdoc.management.commands.tabdoc_verify_migration.Command._column_exists", return_value=True)
    @patch("apps.tabdoc.management.commands.tabdoc_verify_migration.Command._table_exists", return_value=True)
    @patch(
        "apps.tabdoc.management.commands.tabdoc_verify_migration.Command._is_migration_applied",
        side_effect=[False, False],
    )
    def test_verify_migration_fails_when_target_migration_missing(
        self,
        _mock_migration,
        _mock_table,
        _mock_column,
        _mock_constraint,
        _mock_stats,
    ):
        with self.assertRaises(CommandError):
            call_command("tabdoc_verify_migration", stdout=StringIO())

    @patch("apps.tabdoc.management.commands.tabdoc_verify_migration.Command._fetch_version_stats", return_value=(0, 0))
    @patch("apps.tabdoc.management.commands.tabdoc_verify_migration.Command._constraint_exists", return_value=True)
    @patch("apps.tabdoc.management.commands.tabdoc_verify_migration.Command._column_exists", return_value=True)
    @patch("apps.tabdoc.management.commands.tabdoc_verify_migration.Command._table_exists", return_value=True)
    @patch(
        "apps.tabdoc.management.commands.tabdoc_verify_migration.Command._is_migration_applied",
        side_effect=[True, True],
    )
    def test_verify_migration_fails_when_default_has_migration_record(
        self,
        _mock_migration,
        _mock_table,
        _mock_column,
        _mock_constraint,
        _mock_stats,
    ):
        with self.assertRaises(CommandError):
            call_command("tabdoc_verify_migration", stdout=StringIO())

    @patch("apps.tabdoc.management.commands.tabdoc_verify_migration.Command._fetch_version_stats", return_value=(10, 2))
    @patch("apps.tabdoc.management.commands.tabdoc_verify_migration.Command._constraint_exists", return_value=True)
    @patch("apps.tabdoc.management.commands.tabdoc_verify_migration.Command._column_exists", return_value=True)
    @patch("apps.tabdoc.management.commands.tabdoc_verify_migration.Command._table_exists", return_value=True)
    @patch(
        "apps.tabdoc.management.commands.tabdoc_verify_migration.Command._is_migration_applied",
        side_effect=[True, False],
    )
    def test_verify_migration_strict_mode_fails_on_warning(
        self,
        _mock_migration,
        _mock_table,
        _mock_column,
        _mock_constraint,
        _mock_stats,
    ):
        with self.assertRaises(CommandError):
            call_command("tabdoc_verify_migration", "--strict", stdout=StringIO())
