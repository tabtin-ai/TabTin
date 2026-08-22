"""DocumentShareComment → 评论线程兼容迁移的 PostgreSQL 场景。"""

from __future__ import annotations

from importlib import import_module
from types import SimpleNamespace
from uuid import uuid4

from django.conf import settings
from django.db.migrations.executor import MigrationExecutor

from apps.services.migration_guard.scenario import PostgresMigrationScenarioTestCase

migration_0034 = import_module(
    "apps.tabdoc.migrations.0034_backfill_comment_threads"
)


class CommentThreadBackfillScenario(PostgresMigrationScenarioTestCase):
    """每条旧评论迁成一个线程，且根消息沿用旧 UUID。"""

    __test__ = True

    app_label = "tabdoc"
    migrate_from = "0032_document_recovery_draft"
    migrate_to = "0035_comment_thread_indexes"

    def test_legacy_comment_becomes_thread_root_message(self) -> None:
        self.run_migration_scenario()

    def _state_apps(self, connection, target):
        executor = MigrationExecutor(connection)
        executor.loader.build_graph()
        targets = self._resolve_targets(target, required=True)
        return executor.loader.project_state(targets).apps

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
            username=f"comment-migration-{self.user_id.hex[:8]}",
            email=f"comment-migration-{self.user_id.hex[:8]}@tabtin.test",
            password="!",
        )
        document = Document.objects.create(
            id=self.document_id,
            organization_id=self.organization_id,
            space_id=uuid4(),
            owner_id=self.user_id,
            title="评论迁移文档",
        )
        DocumentShareComment.objects.create(
            id=self.comment_id,
            document=document,
            author=user,
            author_name="迁移作者",
            selected_text="迁移选区",
            body="保留的旧评论",
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
        self.assertEqual(thread.status, "open")
        self.assertEqual(thread.anchor_status, "attached")
        self.assertEqual(
            thread.anchor,
            {
                "version": 1,
                "selected_text": "迁移选区",
                "migration_source": "document_share_comment",
            },
        )

        root = CommentMessage.objects.get(thread=thread, kind="root")
        self.assertEqual(root.id, self.comment_id)
        self.assertEqual(root.body, "保留的旧评论")
        self.assertEqual(str(root.author_id), str(self.user_id))
        self.assertEqual(root.mention_user_ids, [str(self.user_id)])

        projection = DocumentShareComment.objects.get(id=self.comment_id)
        self.assertEqual(projection.body, root.body)

        # 迁移完成但旧 Django 尚未退出时，旧表 INSERT/软删除仍必须同步到线程表。
        late_comment_id = uuid4()
        late_projection = DocumentShareComment.objects.create(
            id=late_comment_id,
            document_id=self.document_id,
            author_id=self.user_id,
            author_name="旧实例迟到写入",
            selected_text="",
            body="迁移切换窗口里的评论",
            mention_user_ids=[],
        )
        late_root = CommentMessage.objects.get(id=late_comment_id, kind="root")
        late_thread = CommentThread.objects.get(id=late_root.thread_id)
        self.assertEqual(
            late_thread.anchor.get("migration_source"),
            "document_share_comment",
        )

        late_projection.is_deleted = True
        late_projection.save(update_fields=["is_deleted", "updated_at"])
        late_root.refresh_from_db()
        self.assertTrue(late_root.is_deleted)

        # 新服务原生线程也会双写同 id 的旧投影；reverse 只能删迁移投影。
        native_thread = CommentThread.objects.create(
            document_id=self.document_id,
            organization_id=self.organization_id,
            scope="document",
            status="open",
            anchor={"version": 1},
            anchor_status="none",
            created_by_id=self.user_id,
        )
        native_root_id = uuid4()
        CommentMessage.objects.create(
            id=native_root_id,
            thread=native_thread,
            kind="root",
            author_id=self.user_id,
            author_name="原生线程作者",
            body="迁移后原生线程",
            mention_user_ids=[],
        )
        DocumentShareComment.objects.create(
            id=native_root_id,
            document_id=self.document_id,
            author_id=self.user_id,
            author_name="原生线程作者",
            selected_text="",
            body="迁移后原生线程",
            mention_user_ids=[],
        )

        migration_0034.reverse_backfill_comment_threads(
            new_apps,
            SimpleNamespace(connection=connection),
        )
        self.assertFalse(CommentThread.objects.filter(id=thread.id).exists())
        self.assertFalse(CommentThread.objects.filter(id=late_thread.id).exists())
        self.assertTrue(CommentThread.objects.filter(id=native_thread.id).exists())
