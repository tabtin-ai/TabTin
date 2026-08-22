"""tabdata.0047 遗留 managed_type 列的 PostgreSQL 场景测试。"""

from uuid import uuid4

from django.db.migrations.executor import MigrationExecutor

from apps.services.migration_guard.scenario import PostgresMigrationScenarioTestCase


class RemoveOrphanedManagedTypeScenario(PostgresMigrationScenarioTestCase):
    app_label = "tabdata"
    migrate_from = "0046_merge_0045_link_and_token_3266"
    migrate_to = "0047_remove_orphaned_managed_type"

    def test_orphaned_required_column_is_removed(self) -> None:
        self.run_migration_scenario()

    def seed_before_migration(self, connection) -> None:
        self.execute(
            "ALTER TABLE tabdata_table "
            "ADD COLUMN managed_type varchar(32) NOT NULL DEFAULT ''"
        )
        self.execute(
            "ALTER TABLE tabdata_table ALTER COLUMN managed_type DROP DEFAULT"
        )

    def assert_after_migration(self, connection) -> None:
        row = self.fetchone(
            """
            SELECT COUNT(*)
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'tabdata_table'
              AND column_name = 'managed_type'
            """
        )
        self.assertEqual(row[0], 0)

        executor = MigrationExecutor(connection)
        executor.loader.build_graph()
        state_apps = executor.loader.project_state(
            [("tabdata", self.migrate_to)]
        ).apps
        Table = state_apps.get_model("tabdata", "Table")
        table = Table.objects.create(
            name="迁移后建表回归",
            organization_id=uuid4(),
        )
        self.assertIsNotNone(table.pk)
