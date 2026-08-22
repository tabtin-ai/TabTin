"""#8430 前四个自有组织专享券资格的真实 PostgreSQL 升级场景。"""

from __future__ import annotations

from uuid import uuid4

from django.conf import settings
from django.db.migrations.executor import MigrationExecutor

from apps.services.migration_guard.scenario import PostgresMigrationScenarioTestCase


class ProviderCreditClaimMigrationScenario(PostgresMigrationScenarioTestCase):
    migrate_from = (("tabtinspace", "0135_organization_first_team_claim"),)
    migrate_to = (
        (
            "tabtinspace",
            "0136_first_four_organization_provider_credit_claims",
        ),
    )

    def test_upgrade_preserves_first_team_and_reserves_four_owned_slots(self):
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
        OrganizationMember = old_apps.get_model(
            "tabtinspace",
            "OrganizationMember",
        )
        OldClaim = old_apps.get_model(
            "tabtinspace",
            "OrganizationFirstTeamClaim",
        )

        self.user_id = uuid4()
        self.personal_id = uuid4()
        self.team_ids = [uuid4() for _ in range(4)]
        self.campaign_id = uuid4()
        self.transferred_owner_id = uuid4()

        user = User.objects.create(
            id=self.user_id,
            username=f"provider-credit-migration-{self.user_id.hex[:8]}",
            email=f"provider-credit-migration-{self.user_id.hex[:8]}@tabtin.test",
            password="!",
        )
        transferred_owner = User.objects.create(
            id=self.transferred_owner_id,
            username=(
                "provider-credit-transferred-"
                f"{self.transferred_owner_id.hex[:8]}"
            ),
            email=(
                "provider-credit-transferred-"
                f"{self.transferred_owner_id.hex[:8]}@tabtin.test"
            ),
            password="!",
        )
        Organization.objects.create(
            id=self.personal_id,
            owner=user,
            name=f"Migration Personal {self.personal_id.hex[:8]}",
            type="personal",
            is_default=True,
        )
        for index, team_id in enumerate(self.team_ids, start=1):
            Organization.objects.create(
                id=team_id,
                owner=transferred_owner if index == 1 else user,
                name=f"Migration Team {index} {team_id.hex[:8]}",
                type="team",
                is_default=False,
            )
        transferred_team = Organization.objects.get(id=self.team_ids[0])
        OrganizationMember.objects.create(
            organization=transferred_team,
            user=user,
            role="editor",
        )
        OrganizationMember.objects.create(
            organization=transferred_team,
            user=transferred_owner,
            role="owner",
        )
        OldClaim.objects.create(
            user_id=str(self.user_id),
            organization_id=self.team_ids[0],
            eligible_campaign_ids=[str(self.campaign_id)],
        )

    def assert_after_migration(self, connection) -> None:
        targets = self._resolve_targets(self.migrate_to, required=True)
        new_apps = self._state_apps(connection, targets)
        NewClaim = new_apps.get_model(
            "tabtinspace",
            "OrganizationProviderCreditClaim",
        )

        claims = {
            claim.eligibility_order: claim
            for claim in NewClaim.objects.filter(
                user_id=str(self.user_id)
            ).order_by("eligibility_order")
        }

        self.assertEqual(set(claims), {1, 2, 3, 4})
        self.assertEqual(claims[1].organization_id, self.personal_id)
        self.assertEqual(claims[1].eligible_campaign_ids, [])
        self.assertEqual(claims[2].organization_id, self.team_ids[0])
        self.assertEqual(
            claims[2].eligible_campaign_ids,
            [str(self.campaign_id)],
        )
        self.assertEqual(
            {claims[3].organization_id, claims[4].organization_id},
            {self.team_ids[1], self.team_ids[2]},
        )
        self.assertFalse(
            NewClaim.objects.filter(
                organization_id=self.team_ids[3]
            ).exists()
        )
        tables = set(connection.introspection.table_names())
        self.assertIn(
            "tabtinspace_organization_first_team_claim",
            tables,
        )
        self.assertIn(
            "tabtinspace_organization_provider_credit_claim",
            tables,
        )
