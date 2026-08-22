"""tabdata.0048 在真实 PostgreSQL 上保留合法 UUID 宿主归属。"""

from uuid import uuid4

from django.db.migrations.executor import MigrationExecutor

from apps.services.migration_guard.scenario import PostgresMigrationScenarioTestCase


class AlterTableSpaceIdScenario(PostgresMigrationScenarioTestCase):
    app_label = "tabdata"
    migrate_from = "0047_remove_orphaned_managed_type"
    migrate_to = "0048_alter_table_space_id"

    def test_existing_uuid_space_id_is_preserved(self) -> None:
        self.run_migration_scenario()

    def seed_before_migration(self, connection) -> None:
        executor = MigrationExecutor(connection)
        state_apps = executor.loader.project_state(
            [("tabdata", self.migrate_from)]
        ).apps
        Table = state_apps.get_model("tabdata", "Table")
        self.table_id = uuid4()
        self.space_id = uuid4()
        Table.objects.create(
            id=self.table_id,
            name="space_id 迁移回归",
            organization_id=uuid4(),
            space_id=self.space_id,
        )

    def assert_after_migration(self, connection) -> None:
        row = self.fetchone(
            "SELECT space_id FROM tabdata_table WHERE id = %s",
            [str(self.table_id)],
        )
        self.assertEqual(row[0], self.space_id)
        self.assertEqual(
            self.column_udt_name("tabdata_table", "space_id"),
            "uuid",
        )
