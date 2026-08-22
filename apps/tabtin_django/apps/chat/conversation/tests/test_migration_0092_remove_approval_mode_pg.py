"""0092 删除 ChatSession.approval_mode 的 PostgreSQL 升级场景（ /  PR）。"""

from __future__ import annotations

from uuid import uuid4

from django.conf import settings
from django.db.migrations.executor import MigrationExecutor

from apps.services.migration_guard.scenario import PostgresMigrationScenarioTestCase


class RemoveChatSessionApprovalModeMigrationScenario(
    PostgresMigrationScenarioTestCase
):
    """有意丢弃会话级 approval_mode，保留会话行；列在升级后消失。"""

    __test__ = True

    covered_migrations = (
        ("conversation", "0092_remove_chatsession_approval_mode"),
    )
    app_label = "conversation"
    migrate_from = "0091_sessionshareresourcesyncjob"
    migrate_to = "0092_remove_chatsession_approval_mode"

    def test_migration_discards_approval_mode_and_keeps_session(self) -> None:
        self.run_migration_scenario()

    @staticmethod
    def _state_apps(connection, targets):
        executor = MigrationExecutor(connection)
        executor.loader.build_graph()
        return executor.loader.project_state(list(targets)).apps

    def seed_before_migration(self, connection) -> None:
        targets = self._resolve_targets(self.migrate_from, required=True)
        old_apps = self._state_apps(connection, targets)
        user_app_label, user_model_name = settings.AUTH_USER_MODEL.split(".", 1)
        User = old_apps.get_model(user_app_label, user_model_name)
        ChatSession = old_apps.get_model("conversation", "ChatSession")

        self.user_id = uuid4()
        self.session_always_ask_id = uuid4()
        self.session_full_access_id = uuid4()
        self.organization_id = uuid4()

        user = User.objects.create(
            id=self.user_id,
            username=f"approval-mode-drop-{self.user_id.hex[:8]}",
            email=f"approval-mode-drop-{self.user_id.hex[:8]}@tabtin.test",
            password="!",
        )
        ChatSession.objects.create(
            id=self.session_always_ask_id,
            user=user,
            organization_id=str(self.organization_id),
            title="approval_mode always_ask seed",
            status="active",
            approval_mode="always_ask",
        )
        ChatSession.objects.create(
            id=self.session_full_access_id,
            user=user,
            organization_id=str(self.organization_id),
            title="approval_mode full_access seed",
            status="active",
            approval_mode="full_access",
        )

        self.assertTrue(
            any(field.name == "approval_mode" for field in ChatSession._meta.fields)
        )
        column = self.fetchone(
            """
            SELECT 1
              FROM information_schema.columns
             WHERE table_schema = 'public'
               AND table_name = 'chat_session'
               AND column_name = 'approval_mode'
            """
        )
        self.assertIsNotNone(column)

    def assert_after_migration(self, connection) -> None:
        targets = self._resolve_targets(self.migrate_to, required=True)
        new_apps = self._state_apps(connection, targets)
        ChatSession = new_apps.get_model("conversation", "ChatSession")

        self.assertFalse(
            any(field.name == "approval_mode" for field in ChatSession._meta.fields)
        )
        column = self.fetchone(
            """
            SELECT 1
              FROM information_schema.columns
             WHERE table_schema = 'public'
               AND table_name = 'chat_session'
               AND column_name = 'approval_mode'
            """
        )
        self.assertIsNone(column)

        always_ask = ChatSession.objects.get(id=self.session_always_ask_id)
        full_access = ChatSession.objects.get(id=self.session_full_access_id)
        self.assertEqual(always_ask.title, "approval_mode always_ask seed")
        self.assertEqual(full_access.title, "approval_mode full_access seed")
        self.assertFalse(hasattr(always_ask, "approval_mode"))
        self.assertFalse(hasattr(full_access, "approval_mode"))


class AlreadyRemovedChatSessionApprovalModeMigrationScenario(
    RemoveChatSessionApprovalModeMigrationScenario
):
    """兼容测试线 0089 已先删除物理列、release history 尚未记录 0092。"""

    __test__ = True

    def seed_before_migration(self, connection) -> None:
        super().seed_before_migration(connection)
        self.execute('ALTER TABLE "chat_session" DROP COLUMN "approval_mode"')
