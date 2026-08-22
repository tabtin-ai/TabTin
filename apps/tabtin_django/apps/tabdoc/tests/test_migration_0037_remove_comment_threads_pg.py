"""评论线程退役迁移的 PostgreSQL 场景。"""

from django.db.migrations.executor import MigrationExecutor

from apps.services.migration_guard.scenario import PostgresMigrationScenarioTestCase


class CommentThreadRetirementScenario(PostgresMigrationScenarioTestCase):
    """保留迁移历史，同时安全卸载 trigger 与评论线程表。"""

    __test__ = True

    app_label = "tabdoc"
    migrate_from = "0036_comment_attachment_binding_and_idempotency"
    migrate_to = "0037_remove_comment_threads"

    def test_comment_thread_schema_is_retired_forward_only(self) -> None:
        self.run_migration_scenario()

    def seed_before_migration(self, connection) -> None:
        self.assertEqual(
            self.fetchone("SELECT to_regclass('public.tabdoc_comment_thread')")[0],
            "tabdoc_comment_thread",
        )
        self.assertEqual(
            self.fetchone(
                """
                SELECT count(*)
                  FROM pg_trigger
                 WHERE tgname = 'tabdoc_legacy_comment_thread_sync'
                   AND NOT tgisinternal
                """
            )[0],
            1,
        )

    def assert_after_migration(self, connection) -> None:
        for table in (
            "tabdoc_comment_attachment",
            "tabdoc_comment_message",
            "tabdoc_comment_thread",
        ):
            self.assertIsNone(
                self.fetchone("SELECT to_regclass(%s)", [f"public.{table}"])[0]
            )
        self.assertEqual(
            self.fetchone(
                """
                SELECT count(*)
                  FROM pg_trigger
                 WHERE tgname = 'tabdoc_legacy_comment_thread_sync'
                   AND NOT tgisinternal
                """
            )[0],
            0,
        )
        self.assertEqual(
            self.fetchone(
                """
                SELECT count(*)
                  FROM pg_proc
                 WHERE proname = 'tabdoc_sync_legacy_comment_thread'
                """
            )[0],
            0,
        )

        # 回滚只恢复 schema/trigger；0037 已明确不承诺恢复被删除的评论数据。
        executor = MigrationExecutor(connection)
        executor.loader.build_graph()
        executor.migrate(
            [("tabdoc", "0036_comment_attachment_binding_and_idempotency")]
        )
        self.assertEqual(
            self.fetchone("SELECT to_regclass('public.tabdoc_comment_thread')")[0],
            "tabdoc_comment_thread",
        )
        self.assertEqual(
            self.fetchone(
                """
                SELECT count(*)
                  FROM pg_trigger
                 WHERE tgname = 'tabdoc_legacy_comment_thread_sync'
                   AND NOT tgisinternal
                """
            )[0],
            1,
        )
