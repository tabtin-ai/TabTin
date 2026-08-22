"""Tracker Agent FK 的真实 PostgreSQL 升级场景。"""

from __future__ import annotations

from uuid import uuid4

from django.conf import settings
from django.db.migrations.executor import MigrationExecutor

from apps.services.migration_guard.scenario import PostgresMigrationScenarioTestCase


class TrackerAgentFkMigrationScenario(PostgresMigrationScenarioTestCase):
    covered_migrations = (("tracker", "0041_agent_fk_to_agent_app"),)
    # agent.0001 依赖 conversation.0063；显式钉住 cross-app targets，确保场景
    # 只跨过 tracker.0041，不把 conversation 顺带推进到 0064。
    migrate_from = (
        ("tabtinspace", "0098_strip_agent_approval_config"),
        ("conversation", "0063_align_agent_workspace_models"),
        ("tracker", "0040_tracker_workspace_binding"),
    )
    migrate_to = (
        ("tabtinspace", "0098_strip_agent_approval_config"),
        ("agent", "0001_move_agent_from_tabtinspace"),
        ("conversation", "0063_align_agent_workspace_models"),
        ("tracker", "0041_agent_fk_to_agent_app"),
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
        Tracker = old_apps.get_model("tracker", "Tracker")

        self.user_id = uuid4()
        self.organization_id = uuid4()
        self.device_id = uuid4()
        self.agent_id = uuid4()
        self.space_id = uuid4()
        self.workspace_id = uuid4()
        self.tracker_id = uuid4()

        user = User.objects.create(
            id=self.user_id,
            username=f"tracker-migration-{self.user_id.hex[:8]}",
            email=f"tracker-migration-{self.user_id.hex[:8]}@tabtin.test",
            password="!",
        )
        organization = Organization.objects.create(
            id=self.organization_id,
            owner=user,
            name="Tracker Migration Organization",
        )
        device = Device.objects.create(
            id=self.device_id,
            organization=organization,
            user=user,
            name="Tracker Migration Device",
            device_type="electron",
            role="control",
            fingerprint=f"tracker-migration-{self.device_id}",
            status="offline",
        )
        agent = Agent.objects.create(
            id=self.agent_id,
            organization=organization,
            owner_user=user,
            name="Tracker Migration Agent",
            type="bot",
            custom_rules="preserve-tracker-agent",
            goal="preserve-tracker-goal",
            settings={"default_mode": "agent"},
            agent_config={},
        )
        space = Space.objects.create(
            id=self.space_id,
            organization=organization,
            agent=agent,
            type="workspace",
            name="Tracker Migration Space",
            status="active",
            control_device=device,
            working_dir="/Users/migration/tracker",
            normalized_working_dir="/Users/migration/tracker",
            working_dir_type="code",
        )
        workspace = Workspace.objects.create(
            id=self.workspace_id,
            organization=organization,
            device=device,
            created_by=user,
            name="Tracker Migration Workspace",
            working_dir="/Users/migration/tracker",
            normalized_working_dir="/Users/migration/tracker",
            working_dir_type="code",
        )
        Tracker.objects.create(
            id=self.tracker_id,
            organization=organization,
            space=space,
            agent=agent,
            workspace=workspace,
            name="Tracker Migration Scenario",
            description="preserve tracker ownership across Agent app move",
            trigger_type="manual",
            trigger_config={},
            status="active",
            created_by=user,
        )

    def assert_after_migration(self, connection) -> None:
        targets = self._resolve_targets(self.migrate_to, required=True)
        new_apps = self._state_apps(connection, targets)
        Agent = new_apps.get_model("agent", "Agent")
        Tracker = new_apps.get_model("tracker", "Tracker")

        agent = Agent.objects.get(id=self.agent_id)
        tracker = Tracker.objects.get(id=self.tracker_id)

        self.assertEqual(agent._meta.db_table, "agent_agent")
        self.assertEqual(str(agent.organization_id), str(self.organization_id))
        self.assertEqual(str(agent.owner_user_id), str(self.user_id))
        self.assertEqual(agent.name, "Tracker Migration Agent")
        self.assertEqual(str(tracker.agent_id), str(self.agent_id))
        self.assertEqual(str(tracker.workspace_id), str(self.workspace_id))
        self.assertEqual(str(tracker.space_id), str(self.space_id))
        self.assertEqual(
            Tracker._meta.get_field("agent").remote_field.model._meta.label_lower,
            "agent.agent",
        )

        constraints = connection.introspection.get_constraints(
            connection.cursor(), Tracker._meta.db_table
        )
        self.assertTrue(
            any(
                constraint["foreign_key"] == ("agent_agent", "id")
                and constraint["columns"] == ["agent_id"]
                for constraint in constraints.values()
            )
        )
