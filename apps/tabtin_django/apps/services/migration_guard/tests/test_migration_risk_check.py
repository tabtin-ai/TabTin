"""migration_risk_check 规则单元测试（不连真实 DB）。"""

from __future__ import annotations

from io import StringIO
from pathlib import Path
from unittest import TestCase
from unittest.mock import patch

from django.core.management.base import CommandError
from django.db import migrations, models

from apps.services.migration_guard.management.commands.migration_risk_check import (
    Command,
)


class MigrationRiskCheckRuleTests(TestCase):
    def setUp(self) -> None:
        self.cmd = Command()
        self.fake_path = Path("/tmp/fake_app/migrations/0039_example.py")

    def test_detects_null_write_before_nullable(self):
        operations = [
            migrations.RunSQL(
                "UPDATE services_billing_usage_event SET organization_id = NULL WHERE organization_id = '';"
            ),
            migrations.AlterField(
                model_name="billingusageevent",
                name="organization_id",
                field=models.CharField(max_length=100, null=True),
            ),
        ]
        findings = self.cmd._rule_null_write_before_nullable(self.fake_path, operations)
        self.assertEqual(len(findings), 1)
        self.assertEqual(findings[0]["rule"], "null_write_before_nullable")

    def test_allows_nullable_before_null_write(self):
        operations = [
            migrations.AlterField(
                model_name="billingusageevent",
                name="organization_id",
                field=models.CharField(max_length=100, null=True),
            ),
            migrations.RunSQL(
                "UPDATE services_billing_usage_event SET organization_id = NULL WHERE organization_id = '';"
            ),
        ]
        findings = self.cmd._rule_null_write_before_nullable(self.fake_path, operations)
        self.assertEqual(findings, [])

    def test_detects_type_change_without_cleanup(self):
        operations = [
            migrations.AlterField(
                model_name="billingusageevent",
                name="organization",
                field=models.ForeignKey(
                    "tabtinspace.Organization",
                    on_delete=models.PROTECT,
                ),
            ),
        ]
        findings = self.cmd._rule_type_change_without_cleanup(self.fake_path, operations)
        self.assertEqual(len(findings), 1)
        self.assertEqual(findings[0]["rule"], "type_change_without_cleanup")

    def test_detects_data_op_then_schema_ddl_when_atomic(self):
        ops = [
            migrations.RunPython(migrations.RunPython.noop, migrations.RunPython.noop),
            migrations.AddIndex(
                model_name="collection",
                index=models.Index(fields=["workspace"], name="ctx_ws_idx"),
            ),
        ]

        class Migration:
            atomic = True

        findings = self.cmd._rule_data_op_then_schema_ddl(
            self.fake_path, Migration, ops
        )
        self.assertEqual(len(findings), 1)
        self.assertEqual(findings[0]["rule"], "data_op_then_schema_ddl")

    def test_allows_data_op_then_schema_ddl_when_atomic_false(self):
        ops = [
            migrations.RunPython(migrations.RunPython.noop, migrations.RunPython.noop),
            migrations.AddConstraint(
                model_name="collection",
                constraint=models.UniqueConstraint(
                    fields=("workspace", "name"),
                    name="ctx_coll_ws_name_unique",
                ),
            ),
        ]

        class Migration:
            atomic = False

        findings = self.cmd._rule_data_op_then_schema_ddl(
            self.fake_path, Migration, ops
        )
        self.assertEqual(findings, [])

    def test_detects_add_field_then_runpython(self):
        ops = [
            migrations.AddField(
                model_name="collection",
                name="workspace",
                field=models.ForeignKey(
                    "tabtinspace.Workspace",
                    on_delete=models.CASCADE,
                    null=True,
                ),
            ),
            migrations.RunPython(migrations.RunPython.noop, migrations.RunPython.noop),
        ]

        class Migration:
            atomic = True

        findings = self.cmd._rule_data_op_then_schema_ddl(
            self.fake_path, Migration, ops
        )
        self.assertEqual(len(findings), 1)
        self.assertIn("AddField", findings[0]["message"])

    def test_allows_add_field_only_migration(self):
        ops = [
            migrations.AddField(
                model_name="collection",
                name="workspace",
                field=models.UUIDField(null=True),
            ),
        ]

        class Migration:
            atomic = True

        findings = self.cmd._rule_data_op_then_schema_ddl(
            self.fake_path, Migration, ops
        )
        self.assertEqual(findings, [])

    def test_allows_runpython_only_migration(self):
        ops = [
            migrations.RunPython(migrations.RunPython.noop, migrations.RunPython.noop),
        ]

        class Migration:
            atomic = True

        findings = self.cmd._rule_data_op_then_schema_ddl(
            self.fake_path, Migration, ops
        )
        self.assertEqual(findings, [])
    def test_require_scenario_tests_passes_when_every_risk_is_covered(self):
        output = StringIO()
        command = Command(stdout=output)
        finding = {
            "path": str(self.fake_path),
            "rule": "destructive_without_data_move",
            "message": "remove field",
        }

        with (
            patch.object(command, "_collect_migration_files", return_value=[self.fake_path]),
            patch.object(command, "_scan_file", return_value=[finding]),
            patch.object(command, "_has_scenario_test", return_value=True),
        ):
            command.handle(
                paths=[str(self.fake_path)],
                strict=False,
                warn_only=False,
                require_scenario_tests=True,
            )

        self.assertIn("均有 PostgreSQL 场景测试覆盖", output.getvalue())

    def test_require_scenario_tests_fails_when_any_risk_is_uncovered(self):
        command = Command(stdout=StringIO())
        finding = {
            "path": str(self.fake_path),
            "rule": "destructive_without_data_move",
            "message": "remove field",
        }

        with (
            patch.object(command, "_collect_migration_files", return_value=[self.fake_path]),
            patch.object(command, "_scan_file", return_value=[finding]),
            patch.object(command, "_has_scenario_test", return_value=False),
            self.assertRaises(CommandError),
        ):
            command.handle(
                paths=[str(self.fake_path)],
                strict=False,
                warn_only=False,
                require_scenario_tests=True,
            )
