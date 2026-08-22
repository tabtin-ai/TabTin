"""0071 回滚时保留 Agent 人设上下文，并降级为旧端可隐藏的消息类型。"""

from __future__ import annotations

from uuid import uuid4

from django.conf import settings
from django.db.migrations.executor import MigrationExecutor

from apps.services.migration_guard.scenario import PostgresMigrationScenarioTestCase


class AgentProfileContextRollbackMigrationScenario(
    PostgresMigrationScenarioTestCase
):
    covered_migrations = (
        ("conversation", "0071_chatmessage_agent_profile_context_kind"),
    )
    migrate_from = (
        ("conversation", "0071_chatmessage_agent_profile_context_kind"),
    )
    migrate_to = (
        ("conversation", "0070_chatcontext_current_project_backfill"),
    )

    def test_rollback_preserves_context_as_hidden_legacy_kind(self) -> None:
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
        ChatMessage = old_apps.get_model("conversation", "ChatMessage")

        self.user_id = uuid4()
        self.session_id = uuid4()
        self.message_id = uuid4()
        self.content_blocks = [
            {
                "type": "text",
                "text": '<context type="agent-profile">你是小 Tin。</context>',
            }
        ]

        user = User.objects.create(
            id=self.user_id,
            username=f"profile-rollback-{self.user_id.hex[:8]}",
            email=f"profile-rollback-{self.user_id.hex[:8]}@tabtin.test",
            password="!",
        )
        session = ChatSession.objects.create(
            id=self.session_id,
            user=user,
            organization_id=str(uuid4()),
            title="Agent profile rollback",
            status="active",
        )
        ChatMessage.objects.create(
            id=self.message_id,
            session=session,
            role="user",
            message_kind="agent_profile_context",
            content_blocks_json=self.content_blocks,
            text_summary="你是小 Tin。",
        )

    def assert_after_migration(self, connection) -> None:
        targets = self._resolve_targets(self.migrate_to, required=True)
        new_apps = self._state_apps(connection, targets)
        ChatMessage = new_apps.get_model("conversation", "ChatMessage")

        message = ChatMessage.objects.get(id=self.message_id)
        self.assertEqual(message.message_kind, "environment_context")
        self.assertEqual(message.content_blocks_json, self.content_blocks)
        self.assertEqual(message.text_summary, "你是小 Tin。")
