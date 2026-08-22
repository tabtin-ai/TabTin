"""ChatSession / ChatMessage Agent FK 的真实 PostgreSQL 升级场景。"""

from __future__ import annotations

from uuid import uuid4

from django.conf import settings
from django.db.migrations.executor import MigrationExecutor

from apps.services.migration_guard.scenario import PostgresMigrationScenarioTestCase


class ConversationAgentFkMigrationScenario(PostgresMigrationScenarioTestCase):
    covered_migrations = (
        ("conversation", "0063_align_agent_workspace_models"),
        ("conversation", "0064_agent_fk_to_agent_app"),
    )
    # agent.0001 同时依赖 conversation.0063 与 tracker.0040。显式钉住整组
    # cross-app targets，避免 MigrationExecutor 把另一个 app 迁到非预期叶子。
    migrate_from = (
        ("tabtinspace", "0098_strip_agent_approval_config"),
        ("conversation", "0062_agent_workspace_turn_binding"),
        ("tracker", "0040_tracker_workspace_binding"),
    )
    migrate_to = (
        ("tabtinspace", "0098_strip_agent_approval_config"),
        ("agent", "0001_move_agent_from_tabtinspace"),
        ("conversation", "0064_agent_fk_to_agent_app"),
        ("tracker", "0040_tracker_workspace_binding"),
    )

    def test_migration_preserves_identity_and_workspace(self) -> None:
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
        Organization = old_apps.get_model("tabtinspace", "Organization")
        Device = old_apps.get_model("tabtinspace", "Device")
        Agent = old_apps.get_model("tabtinspace", "Agent")
        Space = old_apps.get_model("tabtinspace", "Space")
        Workspace = old_apps.get_model("tabtinspace", "Workspace")
        ChatSession = old_apps.get_model("conversation", "ChatSession")
        ChatMessage = old_apps.get_model("conversation", "ChatMessage")

        self.user_id = uuid4()
        self.organization_id = uuid4()
        self.device_id = uuid4()
        self.agent_id = uuid4()
        self.space_id = uuid4()
        self.workspace_id = uuid4()
        self.session_id = uuid4()
        self.message_id = uuid4()

        user = User.objects.create(
            id=self.user_id,
            username=f"conversation-migration-{self.user_id.hex[:8]}",
            email=f"conversation-migration-{self.user_id.hex[:8]}@tabtin.test",
            password="!",
        )
        organization = Organization.objects.create(
            id=self.organization_id,
            owner=user,
            name="Conversation Migration Organization",
        )
        device = Device.objects.create(
            id=self.device_id,
            organization=organization,
            user=user,
            name="Conversation Migration Device",
            device_type="electron",
            role="control",
            fingerprint=f"conversation-migration-{self.device_id}",
            status="offline",
        )
        agent = Agent.objects.create(
            id=self.agent_id,
            organization=organization,
            owner_user=user,
            name="Conversation Migration Agent",
            type="bot",
            custom_rules="preserve-conversation-agent",
            goal="preserve-conversation-goal",
            settings={"default_mode": "agent"},
            agent_config={},
        )
        space = Space.objects.create(
            id=self.space_id,
            organization=organization,
            agent=agent,
            type="workspace",
            name="Conversation Migration Space",
            status="active",
            control_device=device,
            working_dir="/Users/migration/conversation",
            normalized_working_dir="/Users/migration/conversation",
            working_dir_type="code",
        )
        workspace = Workspace.objects.create(
            id=self.workspace_id,
            organization=organization,
            device=device,
            created_by=user,
            name="Conversation Migration Workspace",
            working_dir="/Users/migration/conversation",
            normalized_working_dir="/Users/migration/conversation",
            working_dir_type="code",
        )
        session = ChatSession.objects.create(
            id=self.session_id,
            user=user,
            organization_id=str(organization.id),
            space=space,
            workspace=workspace,
            agent=agent,
            title="Conversation Migration Session",
            status="active",
        )
        ChatMessage.objects.create(
            id=self.message_id,
            session=session,
            agent=agent,
            role="assistant",
            message_kind="llm",
            content_blocks_json=[
                {"type": "text", "text": "preserve migration message"}
            ],
            text_summary="preserve migration message",
        )

    def assert_after_migration(self, connection) -> None:
        targets = self._resolve_targets(self.migrate_to, required=True)
        new_apps = self._state_apps(connection, targets)
        Agent = new_apps.get_model("agent", "Agent")
        ChatSession = new_apps.get_model("conversation", "ChatSession")
        ChatMessage = new_apps.get_model("conversation", "ChatMessage")

        agent = Agent.objects.get(id=self.agent_id)
        session = ChatSession.objects.get(id=self.session_id)
        message = ChatMessage.objects.get(id=self.message_id)

        self.assertEqual(agent._meta.db_table, "agent_agent")
        self.assertEqual(str(agent.organization_id), str(self.organization_id))
        self.assertEqual(str(agent.owner_user_id), str(self.user_id))
        self.assertEqual(agent.name, "Conversation Migration Agent")
        self.assertEqual(str(session.agent_id), str(self.agent_id))
        self.assertEqual(str(session.workspace_id), str(self.workspace_id))
        self.assertEqual(str(session.space_id), str(self.space_id))
        self.assertEqual(str(message.session_id), str(self.session_id))
        self.assertEqual(str(message.agent_id), str(self.agent_id))
        self.assertEqual(
            ChatSession._meta.get_field("agent").remote_field.model._meta.label_lower,
            "agent.agent",
        )
        self.assertEqual(
            ChatMessage._meta.get_field("agent").remote_field.model._meta.label_lower,
            "agent.agent",
        )

        session_constraints = connection.introspection.get_constraints(
            connection.cursor(), ChatSession._meta.db_table
        )
        message_constraints = connection.introspection.get_constraints(
            connection.cursor(), ChatMessage._meta.db_table
        )
        self.assertTrue(
            any(
                constraint["foreign_key"] == ("agent_agent", "id")
                and constraint["columns"] == ["agent_id"]
                for constraint in session_constraints.values()
            )
        )
        self.assertTrue(
            any(
                constraint["foreign_key"] == ("agent_agent", "id")
                and constraint["columns"] == ["agent_id"]
                for constraint in message_constraints.values()
            )
        )
