"""Comment-thread restoration after the forward-only 0037 retirement."""

from uuid import uuid4

from django.conf import settings
from django.db.migrations.executor import MigrationExecutor

from apps.services.migration_guard.scenario import PostgresMigrationScenarioTestCase


class CommentThreadRestoreScenario(PostgresMigrationScenarioTestCase):
    __test__ = True

    app_label = "tabdoc"
    migrate_from = "0037_remove_comment_threads"
    migrate_to = "0039_restore_comment_thread_projection"

    def test_schema_projection_and_trigger_are_restored(self) -> None:
        self.run_migration_scenario()

    def _state_apps(self, connection, target):
        executor = MigrationExecutor(connection)
        executor.loader.build_graph()
        return executor.loader.project_state([("tabdoc", target)]).apps

    def seed_before_migration(self, connection) -> None:
        old_apps = self._state_apps(connection, self.migrate_from)
        user_app_label, user_model_name = settings.AUTH_USER_MODEL.split(".", 1)
        User = old_apps.get_model(user_app_label, user_model_name)
        Document = old_apps.get_model("tabdoc", "Document")
        DocumentShareComment = old_apps.get_model("tabdoc", "DocumentShareComment")

        self.user_id = uuid4()
        self.organization_id = uuid4()
        self.document_id = uuid4()
        self.comment_id = uuid4()

        user = User.objects.create(
            id=self.user_id,
            username=f"comment-restore-{self.user_id.hex[:8]}",
            email=f"comment-restore-{self.user_id.hex[:8]}@tabtin.test",
            password="!",
        )
        document = Document.objects.create(
            id=self.document_id,
            organization_id=self.organization_id,
            space_id=uuid4(),
            owner_id=self.user_id,
            title="评论线程恢复",
        )
        DocumentShareComment.objects.create(
            id=self.comment_id,
            document=document,
            author=user,
            author_name="恢复前作者",
            selected_text="恢复锚点",
            body="从旧评论恢复的根消息",
            mention_user_ids=[str(self.user_id)],
        )

    def assert_after_migration(self, connection) -> None:
        new_apps = self._state_apps(connection, self.migrate_to)
        CommentThread = new_apps.get_model("tabdoc", "CommentThread")
        CommentMessage = new_apps.get_model("tabdoc", "CommentMessage")
        DocumentShareComment = new_apps.get_model("tabdoc", "DocumentShareComment")

        thread = CommentThread.objects.get(document_id=self.document_id)
        self.assertEqual(thread.organization_id, self.organization_id)
        self.assertEqual(thread.scope, "text_range")
        self.assertEqual(thread.anchor_status, "attached")
        self.assertEqual(
            thread.anchor.get("migration_source"),
            "document_share_comment",
        )

        root = CommentMessage.objects.get(id=self.comment_id, kind="root")
        self.assertEqual(root.thread_id, thread.id)
        self.assertEqual(root.body, "从旧评论恢复的根消息")

        late_comment_id = uuid4()
        DocumentShareComment.objects.create(
            id=late_comment_id,
            document_id=self.document_id,
            author_id=self.user_id,
            author_name="恢复后旧客户端",
            selected_text="",
            body="trigger 投影的根消息",
            mention_user_ids=[],
        )
        self.assertTrue(
            CommentMessage.objects.filter(id=late_comment_id, kind="root").exists()
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

        executor = MigrationExecutor(connection)
        executor.loader.build_graph()
        executor.migrate([("tabdoc", self.migrate_from)])
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
