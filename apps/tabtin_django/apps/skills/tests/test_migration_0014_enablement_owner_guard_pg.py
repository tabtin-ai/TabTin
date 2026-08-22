"""#3266 SkillEnablement 换锚迁移的 owner 边界回归测试。"""

from uuid import uuid4

import pytest
from django.conf import settings
from django.db.migrations.executor import MigrationExecutor

from apps.services.migration_guard.scenario import PostgresMigrationScenarioTestCase


pytestmark = pytest.mark.requires_pg_native


class _SkillEnablementOwnerGuardMigrationScenario(
    PostgresMigrationScenarioTestCase
):
    migrate_from = ("skills", "0013_backfill_agent_skill_link")
    migrate_to = ("skills", "0014_3266_enablement_device_anchor")

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
        Device = old_apps.get_model("tabtinspace", "Device")
        Agent = old_apps.get_model("agent", "Agent")
        Space = old_apps.get_model("tabtinspace", "Space")
        SkillEnablement = old_apps.get_model("skills", "SkillEnablement")

        self.owner_id = uuid4()
        self.other_user_id = uuid4()
        owner = User.objects.create(
            id=self.owner_id,
            username=f"skill-owner-{self.owner_id.hex[:8]}",
            email=f"skill-owner-{self.owner_id.hex[:8]}@tabtin.test",
            password="!",
        )
        other_user = User.objects.create(
            id=self.other_user_id,
            username=f"skill-other-{self.other_user_id.hex[:8]}",
            email=f"skill-other-{self.other_user_id.hex[:8]}@tabtin.test",
            password="!",
        )
        organization = Organization.objects.create(
            id=uuid4(),
            owner=owner,
            name="Skill Migration Organization",
        )
        self.bound_device_id = uuid4()
        bound_device = Device.objects.create(
            id=self.bound_device_id,
            organization=organization,
            user=owner,
            name="Bound Device",
            device_type="electron",
            role="execution",
            fingerprint=f"skill-bound-{self.bound_device_id}",
            status="offline",
        )
        control_device = Device.objects.create(
            id=uuid4(),
            organization=organization,
            user=owner,
            name="Control Device",
            device_type="electron",
            role="control",
            fingerprint=f"skill-control-{uuid4()}",
            status="offline",
        )
        owned_agent = Agent.objects.create(
            id=uuid4(),
            organization=organization,
            owner_user=owner,
            name="Owned Agent",
            type="bot",
        )
        ownerless_agent = Agent.objects.create(
            id=uuid4(),
            organization=organization,
            owner_user=None,
            name="Ownerless Agent",
            type="bot",
        )
        self.owned_agent_id = owned_agent.id

        owned_workspace = Space.objects.create(
            id=uuid4(),
            organization=organization,
            agent=owned_agent,
            type="workspace",
            name="Owned Workspace",
            status="active",
            bound_device=bound_device,
        )
        ownerless_workspace = Space.objects.create(
            id=uuid4(),
            organization=organization,
            agent=ownerless_agent,
            type="workspace",
            name="Ownerless Workspace",
            status="active",
            control_device=control_device,
        )
        team_space = Space.objects.create(
            id=uuid4(),
            organization=organization,
            agent=owned_agent,
            type="team_space",
            name="Team Space",
            status="active",
            bound_device=bound_device,
        )

        self.matching_key = "platform:owner-match"
        self.mismatched_key = "platform:owner-mismatch"
        self.ownerless_key = "platform:ownerless"
        self.team_key = "platform:team-space"
        rows = [
            (
                owner.id,
                owned_workspace.id,
                self.matching_key,
                {"credential_id": "matching-credential"},
                1,
                "matching-hash",
            ),
            (
                other_user.id,
                owned_workspace.id,
                self.mismatched_key,
                {"credential_id": "foreign-credential"},
                2,
                "mismatched-hash",
            ),
            (
                owner.id,
                ownerless_workspace.id,
                self.ownerless_key,
                {"credential_id": "ownerless-credential"},
                3,
                "ownerless-hash",
            ),
            (
                owner.id,
                team_space.id,
                self.team_key,
                {"credential_id": "team-credential"},
                4,
                "team-hash",
            ),
        ]
        for user_id, space_id, key, config_json, version, content_hash in rows:
            SkillEnablement.objects.create(
                user_id=user_id,
                space_id=space_id,
                skill_canonical_key=key,
                source="platform",
                enabled=True,
                config_json=config_json,
                installed_version_seq=version,
                install_content_hash=content_hash,
            )

    def assert_after_migration(self, connection) -> None:
        targets = self._resolve_targets(self.migrate_to, required=True)
        new_apps = self._state_apps(connection, targets)
        AgentSkillLink = new_apps.get_model("skills", "AgentSkillLink")
        SkillEnablement = new_apps.get_model("skills", "SkillEnablement")

        links = AgentSkillLink.objects.filter(agent_id=self.owned_agent_id)
        self.assertEqual(links.count(), 1)
        matching_link = links.get(skill_canonical_key=self.matching_key)
        self.assertEqual(
            matching_link.config_json,
            {"credential_id": "matching-credential"},
        )
        self.assertFalse(
            AgentSkillLink.objects.filter(
                skill_canonical_key__in=[
                    self.mismatched_key,
                    self.ownerless_key,
                    self.team_key,
                ]
            ).exists()
        )

        bound_install = SkillEnablement.objects.get(
            skill_canonical_key=self.matching_key
        )
        self.assertEqual(bound_install.device_id, self.bound_device_id)
        self.assertEqual(bound_install.installed_version_seq, 1)
        self.assertEqual(bound_install.install_content_hash, "matching-hash")
        self.assertSetEqual(
            set(
                SkillEnablement.objects.values_list(
                    "skill_canonical_key", flat=True
                )
            ),
            {
                self.matching_key,
                self.mismatched_key,
                self.ownerless_key,
                self.team_key,
            },
        )
        SkillEnablement.objects.create(
            device_id=self.bound_device_id,
            skill_canonical_key="platform:new-install",
            source="platform",
        )

        reverse_targets = self._resolve_targets(self.migrate_from, required=True)
        self._migrate(connection, reverse_targets)
        old_apps = self._state_apps(connection, reverse_targets)
        LegacyEnablement = old_apps.get_model("skills", "SkillEnablement")
        self.assertEqual(LegacyEnablement.objects.count(), 4)
        self.assertFalse(
            LegacyEnablement.objects.filter(
                skill_canonical_key="platform:new-install",
            ).exists()
        )
        restored = LegacyEnablement.objects.get(
            skill_canonical_key=self.matching_key,
        )
        self.assertEqual(restored.user_id, self.owner_id)
        self.assertEqual(
            restored.config_json,
            {"credential_id": "matching-credential"},
        )


def test_owner_guard_and_device_anchor_migration(django_db_blocker) -> None:
    scenario_class = _SkillEnablementOwnerGuardMigrationScenario
    scenario = scenario_class()
    with django_db_blocker.unblock():
        scenario_class.setUpClass()
        try:
            scenario.run_migration_scenario()
        finally:
            scenario_class.tearDownClass()
