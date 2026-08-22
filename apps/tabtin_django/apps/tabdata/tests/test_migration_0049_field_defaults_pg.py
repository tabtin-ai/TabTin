"""字段默认值迁移在真实 PostgreSQL 上的升级与回滚场景。"""

import json
from uuid import uuid4

from django.db.migrations.executor import MigrationExecutor

from apps.services.migration_guard.scenario import PostgresMigrationScenarioTestCase


class FieldDefaultsMigrationScenario(PostgresMigrationScenarioTestCase):
    app_label = "tabdata"
    migrate_from = "0048_alter_table_space_id"
    migrate_to = "0049_tablefield_default_value"

    def test_default_value_is_additive_and_required_contract_survives(self) -> None:
        self.run_migration_scenario()

    def seed_before_migration(self, connection) -> None:
        executor = MigrationExecutor(connection)
        state_apps = executor.loader.project_state(
            [("tabdata", self.migrate_from)]
        ).apps
        Table = state_apps.get_model("tabdata", "Table")
        TableField = state_apps.get_model("tabdata", "TableField")

        table = Table.objects.create(
            id=uuid4(),
            name="字段默认值迁移场景",
            organization_id=uuid4(),
            space_id=uuid4(),
        )
        self.field_id = uuid4()
        TableField.objects.create(
            id=self.field_id,
            table=table,
            name="原必填字段",
            field_type="text",
            is_required=True,
            validation_rules={"allow_blank": False, "max_length": 20},
        )

    def assert_after_migration(self, connection) -> None:
        columns = {
            row[0]
            for row in self.fetchall(
                """
                SELECT column_name
                  FROM information_schema.columns
                 WHERE table_schema = 'public'
                   AND table_name = 'tabdata_field'
                """
            )
        }
        self.assertIn("default_value", columns)
        self.assertIn("is_required", columns)

        is_required, rules, default_value = self.fetchone(
            """
            SELECT is_required, validation_rules, default_value
              FROM tabdata_field
             WHERE id = %s
            """,
            [str(self.field_id)],
        )
        self.assertTrue(is_required)
        self.assertEqual(
            rules if isinstance(rules, dict) else json.loads(rules),
            {"allow_blank": False, "max_length": 20},
        )
        self.assertIsNone(default_value)

        executor = MigrationExecutor(connection)
        executor.loader.build_graph()
        executor.migrate([("tabdata", self.migrate_from)])

        columns = {
            row[0]
            for row in self.fetchall(
                """
                SELECT column_name
                  FROM information_schema.columns
                 WHERE table_schema = 'public'
                   AND table_name = 'tabdata_field'
                """
            )
        }
        self.assertNotIn("default_value", columns)
        self.assertIn("is_required", columns)
        is_required, rules = self.fetchone(
            "SELECT is_required, validation_rules FROM tabdata_field WHERE id = %s",
            [str(self.field_id)],
        )
        self.assertTrue(is_required)
        self.assertEqual(
            rules if isinstance(rules, dict) else json.loads(rules),
            {"allow_blank": False, "max_length": 20},
        )
