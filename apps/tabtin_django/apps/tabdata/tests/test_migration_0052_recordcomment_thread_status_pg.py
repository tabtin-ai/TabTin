"""RecordComment 0051->0052 的 PostgreSQL 迁移和回滚场景。"""

from __future__ import annotations

import json
from uuid import uuid4

from django.conf import settings
from django.db.migrations.executor import MigrationExecutor

from apps.services.migration_guard.scenario import PostgresMigrationScenarioTestCase


class RecordCommentThreadStatusMigrationScenario(PostgresMigrationScenarioTestCase):
    app_label = "tabdata"
    migrate_from = "0051_tablerecord_position_id"
    migrate_to = "0052_recordcomment_thread_status"

    def test_thread_status_columns_are_additive_and_reverse_safe(self) -> None:
        self.run_migration_scenario()

    def _state_apps(self, connection, target):
        executor = MigrationExecutor(connection)
        executor.loader.build_graph()
        return executor.loader.project_state([("tabdata", target)]).apps

    def seed_before_migration(self, connection) -> None:
        old_apps = self._state_apps(connection, self.migrate_from)
        user_app_label, user_model_name = settings.AUTH_USER_MODEL.split(".", 1)
        User = old_apps.get_model(user_app_label, user_model_name)
        Table = old_apps.get_model("tabdata", "Table")
        TableRecord = old_apps.get_model("tabdata", "TableRecord")
        RecordComment = old_apps.get_model("tabdata", "RecordComment")

        self.user_id = uuid4()
        self.table_id = uuid4()
        self.record_id = uuid4()
        self.comment_id = uuid4()

        user = User.objects.create(
            id=self.user_id,
            username=f"migration_thread_{self.user_id.hex[:8]}",
            nickname="迁移评论作者",
            email=f"{self.user_id}@example.com",
        )
        table = Table.objects.create(
            id=self.table_id,
            name="评论线程状态迁移表",
            organization_id=uuid4(),
            space_id=uuid4(),
            owner=user,
        )
        record = TableRecord.objects.create(
            id=self.record_id,
            table=table,
            data={},
            created_by=user,
            updated_by=user,
        )
        RecordComment.objects.create(
            id=self.comment_id,
            record=record,
            author=user,
            content="迁移前评论",
            mentions=[],
        )

    def assert_after_migration(self, connection) -> None:
        new_apps = self._state_apps(connection, self.migrate_to)
        RecordComment = new_apps.get_model("tabdata", "RecordComment")
        comment_table = RecordComment._meta.db_table

        columns = {
            row[0]
            for row in self.fetchall(
                """
                SELECT column_name
                  FROM information_schema.columns
                 WHERE table_schema = 'public'
                   AND table_name = %s
                """,
                [comment_table],
            )
        }
        self.assertIn("status", columns)
        self.assertIn("resolved_by_id", columns)
        self.assertIn("resolved_at", columns)

        indexes = {
            row[0]
            for row in self.fetchall(
                """
                SELECT indexname
                  FROM pg_indexes
                 WHERE schemaname = 'public'
                   AND tablename = %s
                """,
                [comment_table],
            )
        }
        self.assertIn("td_comment_thread_status_idx", indexes)

        status, resolved_by_id, resolved_at = self.fetchone(
            f"""
            SELECT status, resolved_by_id, resolved_at
              FROM {comment_table}
             WHERE id = %s
            """,
            [str(self.comment_id)],
        )
        self.assertEqual(status, "open")
        self.assertIsNone(resolved_by_id)
        self.assertIsNone(resolved_at)

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
                   AND table_name = %s
                """,
                [comment_table],
            )
        }
        self.assertNotIn("status", columns)
        self.assertNotIn("resolved_by_id", columns)
        self.assertNotIn("resolved_at", columns)

        indexes = {
            row[0]
            for row in self.fetchall(
                """
                SELECT indexname
                  FROM pg_indexes
                 WHERE schemaname = 'public'
                   AND tablename = %s
                """,
                [comment_table],
            )
        }
        self.assertNotIn("td_comment_thread_status_idx", indexes)

        content, mentions, author_id = self.fetchone(
            f"""
            SELECT content, mentions, author_id
              FROM {comment_table}
             WHERE id = %s
            """,
            [str(self.comment_id)],
        )
        self.assertEqual(content, "迁移前评论")
        self.assertEqual(
            mentions if isinstance(mentions, list) else json.loads(mentions),
            [],
        )
        self.assertEqual(str(author_id), str(self.user_id))
