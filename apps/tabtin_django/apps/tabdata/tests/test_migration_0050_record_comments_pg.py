"""RecordComment 0049→0050 的 PostgreSQL 数据保留场景。"""

from uuid import uuid4

from django.db.migrations.executor import MigrationExecutor

from apps.services.migration_guard.scenario import PostgresMigrationScenarioTestCase


class RecordCommentFoundationMigrationScenario(PostgresMigrationScenarioTestCase):
    app_label = "tabdata"
    migrate_from = "0049_tablefield_default_value"
    migrate_to = "0050_recordcomment_api_foundation"

    def test_actor_snapshots_survive_author_deletion(self) -> None:
        self.run_migration_scenario()

    def seed_before_migration(self, connection) -> None:
        executor = MigrationExecutor(connection)
        state_apps = executor.loader.project_state(
            [("tabdata", self.migrate_from)]
        ).apps
        User = state_apps.get_model("users_auth", "User")
        Table = state_apps.get_model("tabdata", "Table")
        TableRecord = state_apps.get_model("tabdata", "TableRecord")
        RecordComment = state_apps.get_model("tabdata", "RecordComment")

        self.author_id = uuid4()
        self.record_id = uuid4()
        self.comment_id = uuid4()
        author = User.objects.create(
            id=self.author_id,
            username=f"migration_comment_{str(self.author_id)[:8]}",
            nickname="迁移前作者",
            email=f"{self.author_id}@example.com",
        )
        table = Table.objects.create(
            id=uuid4(),
            name="评论迁移测试表",
            organization_id=uuid4(),
            space_id=uuid4(),
            owner=author,
        )
        record = TableRecord.objects.create(
            id=self.record_id,
            table=table,
            data={},
            created_by=author,
            updated_by=author,
        )
        RecordComment.objects.create(
            id=self.comment_id,
            record=record,
            author=author,
            content="迁移前评论",
            mentions=[],
        )

    def assert_after_migration(self, connection) -> None:
        executor = MigrationExecutor(connection)
        executor.loader.build_graph()
        state_apps = executor.loader.project_state(
            [("tabdata", self.migrate_to)]
        ).apps
        User = state_apps.get_model("users_auth", "User")
        RecordComment = state_apps.get_model("tabdata", "RecordComment")

        comment = RecordComment.objects.get(id=self.comment_id)
        self.assertEqual(str(comment.author_id), str(self.author_id))
        self.assertEqual(comment.author_name, "迁移前作者")
        self.assertEqual(comment.actor_type, "human")
        self.assertEqual(comment.actor_id, str(self.author_id))
        self.assertEqual(comment.actor_name, "迁移前作者")

        User.objects.filter(id=self.author_id).delete()

        comment = RecordComment.objects.get(id=self.comment_id)
        self.assertIsNone(comment.author_id)
        self.assertEqual(comment.author_name, "迁移前作者")
        self.assertEqual(comment.actor_type, "human")
        self.assertEqual(comment.actor_id, str(self.author_id))
        self.assertEqual(comment.actor_name, "迁移前作者")
