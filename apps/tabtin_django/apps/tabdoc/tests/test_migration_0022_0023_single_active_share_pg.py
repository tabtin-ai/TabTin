"""tabdoc.0022/0023：双活清理 + 条件唯一约束的 PostgreSQL 场景测试。

0022：RunPython 停用同文档多余 active share（优先保留 organization）+ 默认值改 organization。
0023：AddConstraint ``docshare_one_active_per_document``。

验证：迁移前双活脏数据被收成一条；单独 public 不被误杀；约束落库。
"""

from __future__ import annotations

from uuid import uuid4

from django.conf import settings
from django.db.migrations.executor import MigrationExecutor

from apps.services.migration_guard.scenario import PostgresMigrationScenarioTestCase


class DocumentShareSingleActiveScenario(PostgresMigrationScenarioTestCase):
    app_label = "tabdoc"
    migrate_from = "0021_alter_dochistory_organization_id_and_more"
    migrate_to = "0023_documentshare_one_active_constraint"

    def test_dual_active_cleaned_and_constraint_added(self) -> None:
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
        DocumentShare = old_apps.get_model("tabdoc", "DocumentShare")

        self.user_id = uuid4()
        self.org_id = uuid4()
        self.space_id = uuid4()
        self.dual_doc_id = uuid4()
        self.solo_doc_id = uuid4()
        self.public_share_id = uuid4()
        self.org_share_id = uuid4()
        self.solo_public_share_id = uuid4()

        User.objects.create(
            id=self.user_id,
            username=f"share-mig-{self.user_id.hex[:8]}",
            email=f"share-mig-{self.user_id.hex[:8]}@tabtin.test",
            password="!",
        )

        dual_doc = Document.objects.create(
            id=self.dual_doc_id,
            organization_id=self.org_id,
            space_id=self.space_id,
            owner_id=self.user_id,
            title="dual active share doc",
        )
        solo_doc = Document.objects.create(
            id=self.solo_doc_id,
            organization_id=self.org_id,
            space_id=self.space_id,
            owner_id=self.user_id,
            title="solo public share doc",
        )

        # 故意制造双活：同文档 public + organization 均 is_active
        DocumentShare.objects.create(
            id=self.public_share_id,
            document=dual_doc,
            share_type="public",
            share_id=f"pub{self.public_share_id.hex[:8]}",
            permission="view",
            is_active=True,
        )
        DocumentShare.objects.create(
            id=self.org_share_id,
            document=dual_doc,
            share_type="organization",
            share_id=f"org{self.org_share_id.hex[:8]}",
            permission="view",
            organization_id=str(self.org_id),
            is_active=True,
        )
        # 单独 public：清理逻辑不得停用
        DocumentShare.objects.create(
            id=self.solo_public_share_id,
            document=solo_doc,
            share_type="public",
            share_id=f"solo{self.solo_public_share_id.hex[:8]}",
            permission="view",
            is_active=True,
        )

    def assert_after_migration(self, connection) -> None:
        new_apps = self._state_apps(connection, self.migrate_to)
        DocumentShare = new_apps.get_model("tabdoc", "DocumentShare")

        dual_active = list(
            DocumentShare.objects.filter(document_id=self.dual_doc_id, is_active=True)
        )
        self.assertEqual(len(dual_active), 1)
        self.assertEqual(dual_active[0].id, self.org_share_id)
        self.assertEqual(dual_active[0].share_type, "organization")

        disabled_public = DocumentShare.objects.get(id=self.public_share_id)
        self.assertFalse(disabled_public.is_active)

        solo = DocumentShare.objects.get(id=self.solo_public_share_id)
        self.assertTrue(solo.is_active)
        self.assertEqual(solo.share_type, "public")

        # 条件 UniqueConstraint 在 PG 上通常落成 unique index
        row = self.fetchone(
            """
            SELECT 1
            FROM pg_indexes
            WHERE indexname = %s
            """,
            ["docshare_one_active_per_document"],
        )
        self.assertIsNotNone(row, "条件唯一约束（unique index）应已落库")
