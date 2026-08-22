"""TabData 必填停用迁移在 PostgreSQL 上的行为场景。"""

import json
from uuid import uuid4

from django.db.migrations.executor import MigrationExecutor

from apps.services.migration_guard.scenario import PostgresMigrationScenarioTestCase


class DisableRequiredFieldsMigrationScenario(PostgresMigrationScenarioTestCase):
    app_label = "tabdata"
    migrate_from = "0049_tablefield_default_value"
    migrate_to = "0050_disable_required_fields"

    def test_historical_required_state_is_cleared(self) -> None:
        self.run_migration_scenario()

    def seed_before_migration(self, connection) -> None:
        executor = MigrationExecutor(connection)
        state_apps = executor.loader.project_state(
            [("tabdata", self.migrate_from)]
        ).apps
        Table = state_apps.get_model("tabdata", "Table")
        TableField = state_apps.get_model("tabdata", "TableField")
        TableView = state_apps.get_model("tabdata", "TableView")

        table = Table.objects.create(
            id=uuid4(),
            name="required cleanup",
            organization_id=uuid4(),
            space_id=uuid4(),
        )
        self.field_id = uuid4()
        TableField.objects.create(
            id=self.field_id,
            table=table,
            name="legacy required field",
            field_type="text",
            is_required=True,
            validation_rules={"allow_blank": False, "max_length": 20},
            config={
                "nested_schema": {
                    "fields": [
                        {"name": "author", "required": True},
                        {"name": "body", "required": False},
                    ]
                }
            },
        )
        self.blank_blocked_field_id = uuid4()
        TableField.objects.create(
            id=self.blank_blocked_field_id,
            table=table,
            name="legacy allow blank rule",
            field_type="text",
            is_required=False,
            validation_rules={"allow_blank": False},
        )
        self.view_id = uuid4()
        TableView.objects.create(
            id=self.view_id,
            table=table,
            name="legacy form",
            view_type="form",
            config={
                "field_configs": {
                    str(self.field_id): {"required": True, "description": "keep"}
                }
            },
        )

    def assert_after_migration(self, connection) -> None:
        is_required, rules, field_config = self.fetchone(
            "SELECT is_required, validation_rules, config FROM tabdata_field WHERE id = %s",
            [str(self.field_id)],
        )
        self.assertFalse(is_required)
        if isinstance(rules, str):
            rules = json.loads(rules)
        self.assertTrue(rules["allow_blank"])
        self.assertEqual(rules["max_length"], 20)
        if isinstance(field_config, str):
            field_config = json.loads(field_config)
        self.assertFalse(field_config["nested_schema"]["fields"][0]["required"])

        blank_blocked_rules = self.fetchone(
            "SELECT validation_rules FROM tabdata_field WHERE id = %s",
            [str(self.blank_blocked_field_id)],
        )[0]
        if isinstance(blank_blocked_rules, str):
            blank_blocked_rules = json.loads(blank_blocked_rules)
        self.assertTrue(blank_blocked_rules["allow_blank"])

        config = self.fetchone(
            "SELECT config FROM tabdata_view WHERE id = %s",
            [str(self.view_id)],
        )[0]
        if isinstance(config, str):
            config = json.loads(config)
        field_config = config["field_configs"][str(self.field_id)]
        self.assertFalse(field_config["required"])
        self.assertEqual(field_config["description"], "keep")


class RemoveRequiredFieldContractMigrationScenario(PostgresMigrationScenarioTestCase):
    app_label = "tabdata"
    migrate_from = "0053_merge_required_fields_and_recordcomment_status"
    migrate_to = "0054_remove_required_field_contract"

    def test_required_contract_is_removed_from_storage(self) -> None:
        self.run_migration_scenario()

    def seed_before_migration(self, connection) -> None:
        executor = MigrationExecutor(connection)
        state_apps = executor.loader.project_state(
            [("tabdata", self.migrate_from)]
        ).apps
        Table = state_apps.get_model("tabdata", "Table")
        TableField = state_apps.get_model("tabdata", "TableField")
        TableView = state_apps.get_model("tabdata", "TableView")

        table = Table.objects.create(
            id=uuid4(),
            name="required contract removal",
            organization_id=uuid4(),
            space_id=uuid4(),
        )
        self.field_id = uuid4()
        TableField.objects.create(
            id=self.field_id,
            table=table,
            name="legacy field",
            field_type="nested_list",
            is_required=False,
            validation_rules={"allow_blank": True, "max_length": 20},
            config={
                "nested_schema": {
                    "fields": [
                        {"name": "author", "required": False},
                        {"name": "body", "type": "text"},
                    ]
                }
            },
        )
        self.view_id = uuid4()
        TableView.objects.create(
            id=self.view_id,
            table=table,
            name="legacy form",
            view_type="form",
            config={
                "field_configs": {
                    str(self.field_id): {
                        "required": False,
                        "description": "keep",
                    }
                }
            },
        )

    def assert_after_migration(self, connection) -> None:
        columns = {
            row[0]
            for row in self.fetchall(
                """
                SELECT column_name
                FROM information_schema.columns
                WHERE table_name = 'tabdata_field'
                """
            )
        }
        self.assertNotIn("is_required", columns)

        rules, field_config = self.fetchone(
            "SELECT validation_rules, config FROM tabdata_field WHERE id = %s",
            [str(self.field_id)],
        )
        if isinstance(rules, str):
            rules = json.loads(rules)
        self.assertNotIn("allow_blank", rules)
        self.assertEqual(rules["max_length"], 20)
        if isinstance(field_config, str):
            field_config = json.loads(field_config)
        nested_fields = field_config["nested_schema"]["fields"]
        self.assertNotIn("required", nested_fields[0])
        self.assertEqual(nested_fields[0]["name"], "author")

        config = self.fetchone(
            "SELECT config FROM tabdata_view WHERE id = %s",
            [str(self.view_id)],
        )[0]
        if isinstance(config, str):
            config = json.loads(config)
        view_field_config = config["field_configs"][str(self.field_id)]
        self.assertNotIn("required", view_field_config)
        self.assertEqual(view_field_config["description"], "keep")
