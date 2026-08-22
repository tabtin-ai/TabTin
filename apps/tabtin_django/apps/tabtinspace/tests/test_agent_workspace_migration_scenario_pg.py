"""#3266 Agent/Workspace 跨 app 真实 PostgreSQL 升级场景。"""

from __future__ import annotations

from uuid import uuid4

from django.conf import settings
from django.db.migrations.executor import MigrationExecutor

from apps.services.migration_guard.scenario import PostgresMigrationScenarioTestCase


class AgentWorkspaceMigrationScenario(PostgresMigrationScenarioTestCase):
    # 本场景从 0094 真实走到 0100；显式列出中间高风险节点，供 migration
    # 门禁和维护者确认覆盖范围。审批授权与 always 记忆在 0097 搬入
    # Workspace，0098 随后从 Agent 配置清除，权威源不得退回 Agent。
    covered_migrations = (
        ("tabtinspace", "0095a_agent_purification"),
        ("tabtinspace", "0095c_agent_drop_user_fk"),
        ("tabtinspace", "0097_workspace_backfill_from_space_3266"),
        ("tabtinspace", "0098_strip_agent_approval_config"),
    )
    migrate_from = (
        ("tabtinspace", "0094_device_machine_key"),
        ("conversation", "0061_engineruntimeconfig_cleanup_llm_snapshot_retention_days_and_more"),
        ("tracker", "0039_backfill_cron_timezone"),
    )
    migrate_to = (
        ("agent", "0002_restore_agent_indexes"),
        ("tabtinspace", "0100_alter_device_machine_key"),
        ("conversation", "0064_agent_fk_to_agent_app"),
        ("tracker", "0041_agent_fk_to_agent_app"),
    )

    def test_release_upgrade_preserves_identity_and_execution_context(self) -> None:
        self.run_migration_scenario()

    def _state_apps(self, connection, targets):
        executor = MigrationExecutor(connection)
        executor.loader.build_graph()
        return executor.loader.project_state(list(targets)).apps

    def seed_before_migration(self, connection) -> None:
        targets = self._resolve_targets(self.migrate_from, required=True)
        old_apps = self._state_apps(connection, targets)
        user_app_label, user_model_name = settings.AUTH_USER_MODEL.split(".", 1)
        User = old_apps.get_model(user_app_label, user_model_name)
        Organization = old_apps.get_model("tabtinspace", "Organization")
        OrganizationMember = old_apps.get_model("tabtinspace", "OrganizationMember")
        Device = old_apps.get_model("tabtinspace", "Device")
        Agent = old_apps.get_model("tabtinspace", "Agent")
        Space = old_apps.get_model("tabtinspace", "Space")
        ChatSession = old_apps.get_model("conversation", "ChatSession")

        self.user_id = uuid4()
        self.organization_id = uuid4()
        self.device_id = uuid4()
        self.agent_id = uuid4()
        self.space_id = uuid4()
        self.session_id = uuid4()
        self.duplicate_space_id = uuid4()
        self.duplicate_session_id = uuid4()
        self.team_space_id = uuid4()
        self.team_session_id = uuid4()

        user = User.objects.create(
            id=self.user_id,
            username=f"migration-{self.user_id.hex[:8]}",
            email=f"migration-{self.user_id.hex[:8]}@tabtin.test",
            password="!",
        )
        organization = Organization.objects.create(
            id=self.organization_id,
            owner=user,
            name="Migration Organization",
        )
        OrganizationMember.objects.create(
            organization=organization,
            user=user,
            role="owner",
        )
        device = Device.objects.create(
            id=self.device_id,
            organization=organization,
            user=user,
            name="Migration Device",
            device_type="electron",
            role="control",
            fingerprint=f"migration-{self.device_id}",
            status="offline",
        )
        agent = Agent.objects.create(
            id=self.agent_id,
            organization=organization,
            owner_user=user,
            name="Migration Agent",
            type="bot",
            custom_rules="preserve-rules",
            goal="preserve-goal",
            settings={"welcome_message": "preserve-settings"},
            agent_config={
                "git_status": {"is_repo": True, "branch": "migration"},
                "security": {
                    "approval_grant": "auto",
                    "approval_memo": {
                        "version": 1,
                        "entries": {"shell::run::*": {"decision": "allow"}},
                        "generation": 4,
                    },
                },
            },
            working_dir="/Users/migration/project",
            working_dir_type="code",
            control_device=device,
            bound_device=device,
        )
        space = Space.objects.create(
            id=self.space_id,
            organization=organization,
            agent=agent,
            type="workspace",
            name="Migration Workspace",
            status="active",
            control_device=device,
            bound_device=device,
            working_dir="/Users/migration/project",
            normalized_working_dir="/Users/migration/project",
            working_dir_type="code",
        )
        ChatSession.objects.create(
            id=self.session_id,
            user=user,
            organization_id=str(organization.id),
            space=space,
            title="Migration Session",
            status="active",
        )
        duplicate_space = Space.objects.create(
            id=self.duplicate_space_id,
            organization=organization,
            agent=agent,
            type="workspace",
            name="Archived Duplicate Workspace",
            status="archived",
            is_archived=True,
            control_device=device,
            bound_device=device,
            working_dir="/Users/migration/project",
            normalized_working_dir="/Users/migration/project",
            working_dir_type="code",
        )
        ChatSession.objects.create(
            id=self.duplicate_session_id,
            user=user,
            organization_id=str(organization.id),
            space=duplicate_space,
            title="Duplicate Session",
            status="active",
        )
        team_space = Space.objects.create(
            id=self.team_space_id,
            organization=organization,
            type="team_space",
            name="Migration Team Space",
            status="active",
            execution_space=space,
        )
        ChatSession.objects.create(
            id=self.team_session_id,
            user=user,
            organization_id=str(organization.id),
            space=team_space,
            title="Team Session",
            status="active",
        )

    def assert_after_migration(self, connection) -> None:
        targets = self._resolve_targets(self.migrate_to, required=True)
        new_apps = self._state_apps(connection, targets)
        Agent = new_apps.get_model("agent", "Agent")
        Workspace = new_apps.get_model("tabtinspace", "Workspace")
        Space = new_apps.get_model("tabtinspace", "Space")
        ChatSession = new_apps.get_model("conversation", "ChatSession")

        agent = Agent.objects.get(id=self.agent_id)
        workspace = Workspace.objects.get(id=self.space_id)
        space = Space.objects.get(id=self.space_id)
        session = ChatSession.objects.get(id=self.session_id)
        duplicate_session = ChatSession.objects.get(id=self.duplicate_session_id)
        team_session = ChatSession.objects.get(id=self.team_session_id)

        self.assertEqual(agent._meta.db_table, "agent_agent")
        self.assertEqual(agent.name, "Migration Agent")
        self.assertEqual(agent.custom_rules, "preserve-rules")
        self.assertEqual(agent.goal, "preserve-goal")
        self.assertEqual(agent.settings, {"welcome_message": "preserve-settings"})
        self.assertEqual(str(agent.owner_user_id), str(self.user_id))
        self.assertNotIn("git_status", agent.agent_config)
        self.assertNotIn("approval_grant", agent.agent_config)
        self.assertNotIn("approval_memo", agent.agent_config)
        self.assertNotIn("approval_grant", agent.agent_config.get("security", {}))
        self.assertNotIn("approval_memo", agent.agent_config.get("security", {}))

        self.assertEqual(str(workspace.device_id), str(self.device_id))
        self.assertEqual(str(workspace.created_by_id), str(self.user_id))
        self.assertEqual(workspace.working_dir, "/Users/migration/project")
        self.assertEqual(
            workspace.git_status,
            {"is_repo": True, "branch": "migration"},
        )
        self.assertEqual(workspace.approval_grant, "auto")
        self.assertEqual(
            workspace.approval_memo,
            {
                "version": 1,
                "entries": {"shell::run::*": {"decision": "allow"}},
                "generation": 4,
            },
        )

        self.assertEqual(str(space.agent_id), str(self.agent_id))
        self.assertEqual(str(session.agent_id), str(self.agent_id))
        self.assertEqual(str(session.workspace_id), str(self.space_id))
        self.assertEqual(str(duplicate_session.agent_id), str(self.agent_id))
        self.assertEqual(str(duplicate_session.workspace_id), str(self.space_id))
        self.assertEqual(str(team_session.agent_id), str(self.agent_id))
        self.assertEqual(str(team_session.workspace_id), str(self.space_id))

        tables = set(connection.introspection.table_names())
        self.assertIn("agent_agent", tables)
        self.assertNotIn("tabtinspace_agent", tables)

