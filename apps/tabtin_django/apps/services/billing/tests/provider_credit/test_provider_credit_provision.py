from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from decimal import Decimal
from threading import Barrier
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError
from django.db import close_old_connections
from django.test import RequestFactory, TestCase, TransactionTestCase
from django.utils import timezone
from ninja.errors import HttpError

from apps.services.billing.api_admin import (
    ProviderCreditGrantIn,
    admin_grant_provider_credit,
)
from apps.services.billing.models import (
    BillingAdminAuditLog,
    ProviderCreditCampaign,
    ProviderCreditGrant,
    ProviderCreditTransaction,
)
from apps.services.billing.services.provider_credit_provision import (
    grant_membership_provider_credits,
    grant_new_organization_provider_credits,
    reconcile_new_organization_provider_credits,
)
from apps.services.billing.services.provider_credit_service import ProviderCreditService
from apps.services.billing.tasks import (
    grant_new_organization_provider_credits_async,
)
from apps.services.billing.tests.org_test_utils import org_id_for
from apps.services.llm.models import LLMModel, LLMProvider
from apps.tabtinspace.models import Organization, OrganizationProviderCreditClaim
from apps.tabtinspace.services.organization_service import OrganizationService


class ProviderCreditProvisionTests(TestCase):
    databases = {"default"}

    def setUp(self):
        self.organization_id = org_id_for(
            "provider_credit_provision",
            first_team_eligible=True,
        )

    def _campaign(
        self,
        *,
        code: str,
        provider_key: str = "volcengine",
        attach_to_claim: bool = True,
        **overrides,
    ):
        values = {
            "code": code,
            "name": code,
            "provider_key": provider_key,
            "eligible_model_ids": [],
            "credits_amount": Decimal("80"),
            "total_budget_credits": Decimal("800"),
            "trigger_type": ProviderCreditCampaign.TriggerType.NEW_ORG,
        }
        values.update(overrides)
        campaign = ProviderCreditService.create_campaign(**values)
        if (
            attach_to_claim
            and campaign.trigger_type == ProviderCreditCampaign.TriggerType.NEW_ORG
        ):
            self._attach_campaign(self.organization_id, campaign)
        return campaign

    @staticmethod
    def _attach_campaign(organization_id: str, campaign: ProviderCreditCampaign):
        claim = OrganizationProviderCreditClaim.objects.get(
            organization_id=organization_id
        )
        campaign_ids = {
            str(campaign_id)
            for campaign_id in (claim.eligible_campaign_ids or [])
        }
        campaign_ids.add(str(campaign.id))
        claim.eligible_campaign_ids = sorted(campaign_ids)
        claim.save(update_fields=["eligible_campaign_ids"])

    def _new_owner(self, token: str):
        with patch.object(
            OrganizationService,
            "_dispatch_new_organization_provider_credits",
        ):
            return get_user_model().objects.create_user(
                username=f"provider_credit_{token}",
                email=f"provider_credit_{token}@test.local",
                password="test-pass-123",
            )

    def _doubao_campaigns(self, token: str):
        provider, _ = LLMProvider.objects.get_or_create(
            provider_key="volcengine",
            scope="global",
            organization_id=None,
            user_id=None,
            defaults={
                "name": "volcengine",
                "display_name": "火山引擎",
                "capability_domains": ["chat"],
            },
        )
        model_specs = {
            "seed_lite": (
                "doubao-seed-2-0-lite-260428",
                "Doubao Seed 2.0 Lite",
            ),
            "seed_evolving": (
                "doubao-seed-evolving",
                "Doubao Seed Evolving",
            ),
        }
        model_ids = {
            key: str(
                LLMModel.objects.get_or_create(
                    provider=provider,
                    model_name=model_name,
                    defaults={
                        "display_name": display_name,
                        "base_url": "https://ark.cn-beijing.volces.com/api/v3",
                        "capability_domain": "chat",
                        "context_window_tokens": 1_048_576,
                    },
                )[0].id
            )
            for key, (model_name, display_name) in model_specs.items()
        }
        campaigns = {
            "seed_lite": self._campaign(
                code=f"{token}_DOUBAO_SEED_LITE",
                name="豆包 Seed Lite 1000 credits",
                provider_key="volcengine",
                eligible_model_ids=[model_ids["seed_lite"]],
                credits_amount=Decimal("1000"),
                total_budget_credits=Decimal("10000"),
                attach_to_claim=False,
            ),
            "seed_evolving": self._campaign(
                code=f"{token}_DOUBAO_SEED_EVOLVING",
                name="豆包 Seed Evolving 1000 credits",
                provider_key="volcengine",
                eligible_model_ids=[model_ids["seed_evolving"]],
                credits_amount=Decimal("1000"),
                total_budget_credits=Decimal("10000"),
                attach_to_claim=False,
            ),
        }
        return model_ids, campaigns

    def _create_credit_test_teams(self, owner, *, count: int, token: str):
        with (
            patch.object(OrganizationService, "provision_organization_defaults"),
            patch.object(OrganizationService, "provision_billing"),
            patch.object(OrganizationService, "provision_builtin_extensions"),
            patch.object(
                OrganizationService,
                "_dispatch_new_organization_provider_credits",
            ),
            self.captureOnCommitCallbacks(execute=True),
        ):
            return [
                OrganizationService(user=owner).create_organization(
                    name=f"{token} Collaboration {index}",
                    enforce_owner_limit=False,
                )
                for index in range(1, count + 1)
            ]

    def _assert_doubao_grants(
        self,
        organization,
        *,
        model_ids: dict[str, str],
        campaigns: dict[str, ProviderCreditCampaign],
        expected_credits: Decimal,
    ):
        grants = grant_new_organization_provider_credits(organization)
        self.assertEqual(len(grants), 2)
        self.assertEqual(
            {grant.campaign_id for grant in grants},
            {campaign.id for campaign in campaigns.values()},
        )
        credits_by_model = {
            grant.eligible_model_ids[0]: grant.total_credits
            for grant in grants
        }
        self.assertEqual(
            credits_by_model,
            {
                model_ids["seed_lite"]: expected_credits,
                model_ids["seed_evolving"]: expected_credits,
            },
        )

    def test_new_account_gets_1000_per_doubao_model_for_personal_org(self):
        model_ids, campaigns = self._doubao_campaigns("NEW_ACCOUNT")
        owner = self._new_owner("doubao_new_account")
        personal = Organization.objects.get(
            owner=owner,
            type=Organization.OrganizationType.PERSONAL,
        )

        self._assert_doubao_grants(
            personal,
            model_ids=model_ids,
            campaigns=campaigns,
            expected_credits=Decimal("1000"),
        )

        for model_id in model_ids.values():
            self.assertEqual(
                sum(
                    grant.total_credits
                    for grant in ProviderCreditGrant.objects.filter(
                        organization=personal,
                        eligible_model_ids=[model_id],
                    )
                ),
                Decimal("1000"),
            )

    def test_existing_account_only_gets_doubao_credits_for_two_new_teams(self):
        owner = self._new_owner("doubao_existing_account")
        personal = Organization.objects.get(
            owner=owner,
            type=Organization.OrganizationType.PERSONAL,
        )
        model_ids, campaigns = self._doubao_campaigns("EXISTING_ACCOUNT")
        teams = self._create_credit_test_teams(
            owner,
            count=2,
            token="Existing Account",
        )

        self.assertEqual(
            grant_new_organization_provider_credits(personal),
            [],
        )
        for organization in teams:
            self._assert_doubao_grants(
                organization,
                model_ids=model_ids,
                campaigns=campaigns,
                expected_credits=Decimal("1000"),
            )

        for model_id in model_ids.values():
            self.assertEqual(
                sum(
                    grant.total_credits
                    for grant in ProviderCreditGrant.objects.filter(
                        organization__in=teams,
                        eligible_model_ids=[model_id],
                    )
                ),
                Decimal("2000"),
            )

    def test_personal_organization_creation_snapshots_and_dispatches_credit(self):
        campaign = self._campaign(
            code="NEW_ORG_PERSONAL_CREATE",
            attach_to_claim=False,
        )

        with (
            patch.object(
                OrganizationService,
                "_dispatch_new_organization_provider_credits",
            ) as dispatch,
            self.captureOnCommitCallbacks(execute=True),
        ):
            owner = get_user_model().objects.create_user(
                username="provider_credit_personal_create",
                email="provider_credit_personal_create@test.local",
                password="test-pass-123",
            )

        personal = Organization.objects.get(
            owner=owner,
            type=Organization.OrganizationType.PERSONAL,
        )
        claim = OrganizationProviderCreditClaim.objects.get(
            organization_id=personal.id
        )
        self.assertEqual(claim.eligibility_order, 1)
        self.assertIn(str(campaign.id), claim.eligible_campaign_ids)
        dispatch.assert_called_once_with(str(personal.id))

    def test_new_organization_creates_grant_and_transaction(self):
        campaign = self._campaign(code="NEW_ORG_DOUBAO")

        grants = grant_new_organization_provider_credits(self.organization_id)

        self.assertEqual(len(grants), 1)
        self.assertEqual(grants[0].campaign_id, campaign.id)
        self.assertEqual(grants[0].metadata["source"], "new_org")
        self.assertTrue(
            ProviderCreditTransaction.objects.filter(
                grant=grants[0],
                transaction_type=ProviderCreditTransaction.TransactionType.GRANT,
            ).exists()
        )

    def test_team_organization_creation_dispatches_credit_after_commit(self):
        first_campaign = self._campaign(
            code="NEW_ORG_CREATE_TEAM_DOUBAO",
            provider_key="volcengine",
        )
        second_campaign = self._campaign(
            code="NEW_ORG_CREATE_TEAM_QWEN",
            provider_key="dashscope",
        )
        owner = self._new_owner("first_team_dispatch")

        with (
            patch.object(OrganizationService, "provision_organization_defaults"),
            patch.object(OrganizationService, "provision_billing"),
            patch.object(OrganizationService, "provision_builtin_extensions"),
            patch.object(
                OrganizationService,
                "_dispatch_new_organization_provider_credits",
            ) as dispatch,
            self.captureOnCommitCallbacks(execute=True),
        ):
            organization = OrganizationService(user=owner).create_organization(
                name="Provider Credit Team",
                enforce_owner_limit=False,
            )

        self.assertTrue(Organization.objects.filter(id=organization.id).exists())
        dispatch.assert_called_once_with(str(organization.id))
        self.assertFalse(
            ProviderCreditGrant.objects.filter(organization=organization).exists()
        )
        second_campaign.status = ProviderCreditCampaign.Status.ENDED
        second_campaign.enabled = False
        second_campaign.trigger_type = ProviderCreditCampaign.TriggerType.MANUAL
        second_campaign.save(
            update_fields=["status", "enabled", "trigger_type", "updated_at"]
        )

        task_result = grant_new_organization_provider_credits_async(
            str(organization.id)
        )

        self.assertEqual(
            set(task_result["grant_ids"]),
            {
                str(
                    ProviderCreditGrant.objects.get(
                        organization=organization,
                        campaign=first_campaign,
                    ).id
                ),
                str(
                    ProviderCreditGrant.objects.get(
                        organization=organization,
                        campaign=second_campaign,
                    ).id
                ),
            },
        )

    def test_credit_failure_does_not_roll_back_created_team(self):
        self._campaign(code="NEW_ORG_THREAD_FAILURE")
        owner = self._new_owner("thread_failure")

        with (
            patch.object(OrganizationService, "provision_organization_defaults"),
            patch.object(OrganizationService, "provision_billing"),
            patch.object(OrganizationService, "provision_builtin_extensions"),
            patch(
                "apps.tabtinspace.services.organization_service.threading.Thread"
            ) as thread_class,
            self.captureOnCommitCallbacks(execute=True),
        ):
            thread_class.return_value.start.side_effect = RuntimeError(
                "thread unavailable"
            )
            organization = OrganizationService(user=owner).create_organization(
                name="Provider Credit Retry Team",
                enforce_owner_limit=False,
            )

        self.assertTrue(Organization.objects.filter(id=organization.id).exists())
        thread_class.return_value.start.assert_called_once()

    def test_first_three_team_organizations_dispatch_and_receive_credit(self):
        campaign = self._campaign(code="NEW_ORG_FIRST_THREE_TEAMS")
        owner = self._new_owner("second_team")

        with (
            patch.object(OrganizationService, "provision_organization_defaults"),
            patch.object(OrganizationService, "provision_billing"),
            patch.object(OrganizationService, "provision_builtin_extensions"),
            patch.object(
                OrganizationService,
                "_dispatch_new_organization_provider_credits",
            ) as dispatch,
            self.captureOnCommitCallbacks(execute=True),
        ):
            teams = [
                OrganizationService(user=owner).create_organization(
                    name=f"Provider Credit Team {index}",
                    enforce_owner_limit=False,
                )
                for index in range(1, 4)
            ]

        self.assertEqual(dispatch.call_count, 3)
        for team in teams:
            dispatch.assert_any_call(str(team.id))
            grants = grant_new_organization_provider_credits(team)
            self.assertEqual(len(grants), 1)
            self.assertEqual(grants[0].campaign_id, campaign.id)

    def test_deleting_claimed_teams_does_not_restore_eligibility(self):
        self._campaign(code="NEW_ORG_DELETED_CLAIMED_TEAMS")
        owner = self._new_owner("deleted_first_team")

        with (
            patch.object(OrganizationService, "provision_organization_defaults"),
            patch.object(OrganizationService, "provision_billing"),
            patch.object(OrganizationService, "provision_builtin_extensions"),
            patch.object(
                OrganizationService,
                "_dispatch_new_organization_provider_credits",
            ) as dispatch,
            self.captureOnCommitCallbacks(execute=True),
        ):
            claimed_teams = []
            for index in range(1, 4):
                team = OrganizationService(user=owner).create_organization(
                    name=f"Deleted Claimed Provider Credit Team {index}",
                    enforce_owner_limit=False,
                )
                claimed_teams.append(team)
                team.delete()
            fourth = OrganizationService(user=owner).create_organization(
                name="Team After Three Deleted Claims",
                enforce_owner_limit=False,
            )

        self.assertEqual(dispatch.call_count, 3)
        self.assertEqual(grant_new_organization_provider_credits(fourth), [])
        self.assertFalse(
            OrganizationProviderCreditClaim.objects.filter(
                organization_id=fourth.id
            ).exists()
        )

    def test_snapshotted_personal_organization_receives_new_org_credit(self):
        campaign = self._campaign(code="NEW_ORG_PERSONAL")
        team = Organization.objects.get(id=self.organization_id)
        personal = Organization.objects.get(
            owner=team.owner,
            type=Organization.OrganizationType.PERSONAL,
        )
        claim = OrganizationProviderCreditClaim.objects.get(
            organization_id=personal.id
        )
        claim.eligible_campaign_ids = [str(campaign.id)]
        claim.save(update_fields=["eligible_campaign_ids"])

        grants = grant_new_organization_provider_credits(personal)

        self.assertEqual(len(grants), 1)
        self.assertEqual(grants[0].campaign_id, campaign.id)
        self.assertEqual(grants[0].organization_id, personal.id)

    def test_personal_organization_rejects_team_eligibility_order(self):
        campaign = self._campaign(
            code="NEW_ORG_PERSONAL_WRONG_ORDER",
            attach_to_claim=False,
        )
        owner = self._new_owner("personal_wrong_order")
        personal = Organization.objects.get(
            owner=owner,
            type=Organization.OrganizationType.PERSONAL,
        )
        claim = OrganizationProviderCreditClaim.objects.get(
            organization_id=personal.id
        )
        claim.eligibility_order = 2
        claim.save(update_fields=["eligibility_order"])

        self.assertEqual(grant_new_organization_provider_credits(personal), [])
        with self.assertRaises(ValidationError):
            ProviderCreditService.grant_credit_from_campaign(
                organization=personal,
                campaign_code=campaign.code,
                source="new_org",
            )

    def test_default_team_organization_never_receives_new_org_credit(self):
        campaign = self._campaign(code="NEW_ORG_NON_DEFAULT_TEAM_ONLY")
        team = Organization.objects.get(id=self.organization_id)
        Organization.objects.filter(
            owner=team.owner,
            is_default=True,
        ).update(is_default=False)
        team.is_default = True
        team.save(update_fields=["is_default"])

        self.assertEqual(grant_new_organization_provider_credits(team), [])
        with self.assertRaises(ValidationError):
            ProviderCreditService.grant_credit_from_campaign(
                organization=team,
                campaign_code=campaign.code,
                source="new_org",
            )

    def test_deleting_team_is_skipped_without_grant(self):
        self._campaign(code="NEW_ORG_DELETING_TEAM")
        team = Organization.objects.get(id=self.organization_id)
        team.status = Organization.Status.DELETING
        team.save(update_fields=["status"])

        grants = grant_new_organization_provider_credits(team)

        self.assertEqual(grants, [])
        self.assertFalse(
            ProviderCreditGrant.objects.filter(organization=team).exists()
        )

    def test_periodic_scanner_recovers_missing_campaign_grant(self):
        campaign = self._campaign(
            code="NEW_ORG_PENDING_SCAN",
            start_at=timezone.now() - timedelta(minutes=1),
        )

        result = reconcile_new_organization_provider_credits(limit=10)

        self.assertGreaterEqual(result["processed"], 1)
        self.assertTrue(
            ProviderCreditGrant.objects.filter(
                organization_id=self.organization_id,
                campaign=campaign,
            ).exists()
        )

    def test_periodic_scanner_recovers_grant_after_campaign_ended(self):
        now = timezone.now()
        campaign = self._campaign(
            code="NEW_ORG_ENDED_PENDING_SCAN",
            status=ProviderCreditCampaign.Status.ENDED,
            start_at=now - timedelta(minutes=2),
            end_at=now - timedelta(minutes=1),
        )
        Organization.objects.filter(id=self.organization_id).update(
            created_at=now - timedelta(seconds=90)
        )

        result = reconcile_new_organization_provider_credits(limit=10)

        self.assertGreaterEqual(result["granted"], 1)
        self.assertTrue(
            ProviderCreditGrant.objects.filter(
                organization_id=self.organization_id,
                campaign=campaign,
            ).exists()
        )

    def test_periodic_scanner_honors_snapshot_after_campaign_ended(self):
        campaign = self._campaign(
            code="NEW_ORG_ENDED_WITHOUT_BOUNDARY",
            status=ProviderCreditCampaign.Status.ENDED,
            start_at=timezone.now() - timedelta(minutes=1),
            end_at=None,
        )

        result = reconcile_new_organization_provider_credits(limit=10)

        self.assertEqual(result["granted"], 1)
        self.assertTrue(
            ProviderCreditGrant.objects.filter(
                organization_id=self.organization_id,
                campaign=campaign,
            ).exists()
        )

    def test_periodic_scanner_rotates_after_persistent_failure(self):
        self._campaign(code="NEW_ORG_RECONCILE_FAILURE")
        later_organization_id = org_id_for(
            "provider_credit_reconcile_later_claim",
            first_team_eligible=True,
        )
        later_campaign = self._campaign(code="NEW_ORG_RECONCILE_LATER")
        self._attach_campaign(later_organization_id, later_campaign)

        with patch.object(
            ProviderCreditService,
            "grant_credit_from_campaign",
            side_effect=ValidationError("persistent failure"),
        ):
            first_result = reconcile_new_organization_provider_credits(
                limit=1
            )

        second_result = reconcile_new_organization_provider_credits(limit=1)

        self.assertEqual(first_result["skipped"], 1)
        self.assertEqual(second_result["granted"], 1)
        self.assertTrue(
            ProviderCreditGrant.objects.filter(
                organization_id=later_organization_id,
                campaign=later_campaign,
            ).exists()
        )

    def test_new_organization_provision_is_idempotent(self):
        campaign = self._campaign(code="NEW_ORG_IDEMPOTENT")

        first = grant_new_organization_provider_credits(self.organization_id)
        second = grant_new_organization_provider_credits(self.organization_id)

        self.assertEqual(first[0].id, second[0].id)
        self.assertEqual(
            ProviderCreditGrant.objects.filter(
                organization_id=self.organization_id,
                campaign=campaign,
            ).count(),
            1,
        )
        self.assertEqual(
            ProviderCreditTransaction.objects.filter(grant=first[0]).count(),
            1,
        )

    def test_automatic_source_must_match_campaign_trigger_type(self):
        campaign = self._campaign(
            code="MANUAL_CAMPAIGN_CANNOT_AUTO_GRANT",
            trigger_type=ProviderCreditCampaign.TriggerType.MANUAL,
        )

        with self.assertRaises(ValidationError):
            ProviderCreditService.grant_credit_from_campaign(
                organization=self.organization_id,
                campaign_code=campaign.code,
                source="new_org",
            )

    def test_new_org_cannot_forge_eligibility_for_later_campaign(self):
        campaign = self._campaign(
            code="NEW_ORG_CREATED_AFTER_FIRST_TEAM",
            attach_to_claim=False,
            start_at=timezone.now() + timedelta(days=1),
        )

        with self.assertRaises(ValidationError):
            ProviderCreditService.grant_credit_from_campaign(
                organization=self.organization_id,
                campaign_code=campaign.code,
                source="new_org",
                eligibility_at=campaign.start_at + timedelta(minutes=1),
            )

    def test_manual_grant_does_not_satisfy_new_org_automatic_grant(self):
        manual_campaign = self._campaign(code="NEW_ORG_ALREADY_MANUAL")
        ProviderCreditService.grant_credit_from_campaign(
            organization=self.organization_id,
            campaign_code=manual_campaign.code,
            source="admin",
        )
        automatic_campaign = self._campaign(code="NEW_ORG_AFTER_MANUAL")

        grants = grant_new_organization_provider_credits(self.organization_id)

        self.assertEqual(len(grants), 1)
        self.assertEqual(grants[0].campaign_id, automatic_campaign.id)
        self.assertEqual(
            grants[0].trigger_type,
            ProviderCreditCampaign.TriggerType.NEW_ORG,
        )

    def test_new_organization_receives_each_provider_campaign_once(self):
        first_campaign = self._campaign(
            code="NEW_ORG_DOUBAO_FIRST",
            provider_key="volcengine",
        )
        second_campaign = self._campaign(
            code="NEW_ORG_QWEN_SECOND",
            provider_key="dashscope",
            credits_amount=Decimal("50"),
            total_budget_credits=Decimal("500"),
        )

        grants = grant_new_organization_provider_credits(self.organization_id)
        retried_grants = grant_new_organization_provider_credits(self.organization_id)

        self.assertEqual(len(grants), 2)
        self.assertEqual(
            {grant.id for grant in retried_grants},
            {grant.id for grant in grants},
        )
        self.assertEqual(
            {grant.campaign_id for grant in grants},
            {first_campaign.id, second_campaign.id},
        )
        self.assertEqual(
            {grant.provider_key for grant in grants},
            {"volcengine", "dashscope"},
        )
        self.assertEqual(
            ProviderCreditGrant.objects.filter(
                organization_id=self.organization_id,
                trigger_type=ProviderCreditCampaign.TriggerType.NEW_ORG,
            ).count(),
            2,
        )

    def test_exhausted_campaign_does_not_block_other_provider_campaign(self):
        exhausted = self._campaign(
            code="NEW_ORG_EXHAUSTED",
            credits_amount=Decimal("80"),
            total_budget_credits=Decimal("80"),
        )
        other_organization_id = org_id_for(
            "provider_credit_exhaust_campaign",
            first_team_eligible=True,
        )
        self._attach_campaign(other_organization_id, exhausted)
        ProviderCreditService.grant_credit_from_campaign(
            organization=other_organization_id,
            campaign_code=exhausted.code,
            source="new_org",
        )
        available = self._campaign(
            code="NEW_ORG_AVAILABLE_QWEN",
            provider_key="dashscope",
        )

        grants = grant_new_organization_provider_credits(self.organization_id)

        self.assertEqual([grant.campaign_id for grant in grants], [available.id])

    def test_membership_plan_grants_only_matching_campaign(self):
        matching = self._campaign(
            code="EXPLORER_DOUBAO",
            trigger_type=ProviderCreditCampaign.TriggerType.MEMBERSHIP,
            membership_plan_codes=["Explorer"],
        )
        self._campaign(
            code="PRO_QWEN",
            provider_key="dashscope",
            trigger_type=ProviderCreditCampaign.TriggerType.MEMBERSHIP,
            membership_plan_codes=["pro"],
        )

        grants = grant_membership_provider_credits(
            self.organization_id,
            "EXPLORER",
            "subscription-explorer-1",
        )

        self.assertEqual(len(grants), 1)
        self.assertEqual(grants[0].campaign_id, matching.id)
        self.assertEqual(grants[0].grant_source, ProviderCreditGrant.GrantSource.MEMBERSHIP)
        self.assertEqual(grants[0].metadata["membership_plan_code"], "explorer")
        self.assertEqual(
            grants[0].metadata["subscription_id"],
            "subscription-explorer-1",
        )

    def test_campaign_budget_never_exceeds_total(self):
        campaign = self._campaign(
            code="BUDGET_SEQUENTIAL",
            credits_amount=Decimal("80"),
            total_budget_credits=Decimal("100"),
        )
        other_organization_id = org_id_for(
            "provider_credit_budget_second",
            first_team_eligible=True,
        )
        self._attach_campaign(other_organization_id, campaign)

        ProviderCreditService.grant_credit_from_campaign(
            organization=self.organization_id,
            campaign_code=campaign.code,
            source="new_org",
        )
        with self.assertRaises(ValidationError):
            ProviderCreditService.grant_credit_from_campaign(
                organization=other_organization_id,
                campaign_code=campaign.code,
                source="new_org",
            )

        campaign.refresh_from_db()
        self.assertEqual(campaign.granted_credits, Decimal("80"))
        self.assertLessEqual(campaign.granted_credits, campaign.total_budget_credits)

    def test_campaign_entry_validates_enabled_status_and_time_window(self):
        now = timezone.now()
        campaigns = [
            self._campaign(code="DISABLED_CAMPAIGN", enabled=False),
            self._campaign(
                code="PAUSED_CAMPAIGN",
                status=ProviderCreditCampaign.Status.PAUSED,
            ),
            self._campaign(
                code="FUTURE_CAMPAIGN",
                start_at=now + timedelta(days=1),
            ),
            self._campaign(
                code="ENDED_CAMPAIGN",
                start_at=now - timedelta(days=2),
                end_at=now - timedelta(days=1),
            ),
        ]

        for campaign in campaigns:
            with self.subTest(campaign=campaign.code), self.assertRaises(
                ValidationError
            ):
                ProviderCreditService.grant_credit_from_campaign(
                    organization=self.organization_id,
                    campaign_code=campaign.code,
                    source="admin",
                )

    def test_expire_grant_records_expire_transaction_once(self):
        campaign = self._campaign(code="EXPIRE_SERVICE")
        grant = ProviderCreditService.grant_credit_from_campaign(
            organization=self.organization_id,
            campaign_code=campaign.code,
            source="new_org",
        )
        ProviderCreditGrant.objects.filter(id=grant.id).update(
            expire_at=timezone.now()
        )

        first = ProviderCreditService.expire_grant(grant=grant.id)
        second = ProviderCreditService.expire_grant(grant=grant.id)

        self.assertIsNotNone(first)
        self.assertEqual(first.id, second.id)
        grant.refresh_from_db()
        self.assertEqual(grant.status, ProviderCreditGrant.Status.EXPIRED)
        self.assertEqual(grant.remaining_credits, Decimal("0"))
        self.assertEqual(
            ProviderCreditTransaction.objects.filter(
                grant=grant,
                transaction_type=ProviderCreditTransaction.TransactionType.EXPIRE,
            ).count(),
            1,
        )

    def test_admin_grant_records_billing_audit(self):
        campaign = self._campaign(
            code="ADMIN_MANUAL_GRANT",
            trigger_type=ProviderCreditCampaign.TriggerType.MANUAL,
        )
        admin = get_user_model().objects.create_superuser(
            username="provider_credit_provision_admin",
            email="provider-credit-provision-admin@test.local",
            password="test-pass-123",
        )
        request = RequestFactory().post(
            "/admin/billing/provider-credit/grants",
            content_type="application/json",
        )
        request.auth = admin
        request.admin_permissions = {"*"}

        response = admin_grant_provider_credit(
            request,
            ProviderCreditGrantIn(
                organization_id=self.organization_id,
                campaign_code=campaign.code,
                reason="供应商联合推广补发",
            ),
        )

        grant = ProviderCreditGrant.objects.get(
            id=response["data"]["grant"]["id"]
        )
        self.assertEqual(grant.grant_source, ProviderCreditGrant.GrantSource.ADMIN)
        self.assertEqual(
            grant.metadata,
            {
                "operator": str(admin.id),
                "reason": "供应商联合推广补发",
                "source": "admin",
            },
        )
        self.assertTrue(
            BillingAdminAuditLog.objects.filter(
                action="provider_credit_grant",
                target_id=str(grant.id),
                organization_id=self.organization_id,
            ).exists()
        )

    def test_admin_cannot_relabel_existing_automatic_grant(self):
        campaign = self._campaign(code="ADMIN_EXISTING_AUTOMATIC")
        ProviderCreditService.grant_credit_from_campaign(
            organization=self.organization_id,
            campaign_code=campaign.code,
            source="new_org",
        )
        admin = get_user_model().objects.create_superuser(
            username="provider_credit_conflict_admin",
            email="provider-credit-conflict-admin@test.local",
            password="test-pass-123",
        )
        request = RequestFactory().post("/admin/billing/provider-credit/grants")
        request.auth = admin
        request.admin_permissions = {"*"}

        with self.assertRaises(HttpError) as raised:
            admin_grant_provider_credit(
                request,
                ProviderCreditGrantIn(
                    organization_id=self.organization_id,
                    campaign_code=campaign.code,
                    reason="尝试改写来源",
                ),
            )

        self.assertEqual(raised.exception.status_code, 409)
        grant = ProviderCreditGrant.objects.get(
            organization_id=self.organization_id,
            campaign=campaign,
        )
        self.assertEqual(grant.grant_source, ProviderCreditGrant.GrantSource.CAMPAIGN)
        self.assertFalse(
            BillingAdminAuditLog.objects.filter(
                action="provider_credit_grant",
                target_id=str(grant.id),
            ).exists()
        )


class ProviderCreditProvisionConcurrencyTests(TransactionTestCase):
    databases = {"default"}
    reset_sequences = False

    def setUp(self):
        self.first_organization_id = org_id_for(
            "provider_credit_concurrent_first",
            first_team_eligible=True,
        )
        self.second_organization_id = org_id_for(
            "provider_credit_concurrent_second",
            first_team_eligible=True,
        )
        self.campaign = ProviderCreditService.create_campaign(
            code="CONCURRENT_LAST_BUDGET",
            name="并发尾额测试",
            provider_key="volcengine",
            eligible_model_ids=[],
            credits_amount=Decimal("80"),
            total_budget_credits=Decimal("100"),
            trigger_type=ProviderCreditCampaign.TriggerType.NEW_ORG,
        )
        for organization_id in (
            self.first_organization_id,
            self.second_organization_id,
        ):
            claim = OrganizationProviderCreditClaim.objects.get(
                organization_id=organization_id
            )
            claim.eligible_campaign_ids = [str(self.campaign.id)]
            claim.save(update_fields=["eligible_campaign_ids"])

    def test_two_organizations_cannot_overspend_campaign_budget(self):
        barrier = Barrier(2)

        def _grant(organization_id: str):
            close_old_connections()
            try:
                barrier.wait(timeout=10)
                try:
                    grant = ProviderCreditService.grant_credit_from_campaign(
                        organization=organization_id,
                        campaign_code=self.campaign.code,
                        source="new_org",
                    )
                    return str(grant.id)
                except ValidationError:
                    return None
            finally:
                close_old_connections()

        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(
                executor.map(
                    _grant,
                    [self.first_organization_id, self.second_organization_id],
                )
            )

        self.campaign.refresh_from_db()
        self.assertEqual(sum(result is not None for result in results), 1)
        self.assertEqual(self.campaign.granted_credits, Decimal("80"))
        self.assertLessEqual(
            self.campaign.granted_credits,
            self.campaign.total_budget_credits,
        )
        self.assertEqual(
            ProviderCreditTransaction.objects.filter(
                transaction_type=ProviderCreditTransaction.TransactionType.GRANT,
                grant__campaign=self.campaign,
            ).count(),
            1,
        )

    def test_same_organization_gets_each_concurrent_campaign_once(self):
        second_campaign = ProviderCreditService.create_campaign(
            code="CONCURRENT_SECOND_NEW_ORG_CAMPAIGN",
            name="并发第二活动",
            provider_key="dashscope",
            eligible_model_ids=[],
            credits_amount=Decimal("50"),
            total_budget_credits=Decimal("500"),
            trigger_type=ProviderCreditCampaign.TriggerType.NEW_ORG,
        )
        claim = OrganizationProviderCreditClaim.objects.get(
            organization_id=self.first_organization_id
        )
        claim.eligible_campaign_ids = [
            *claim.eligible_campaign_ids,
            str(second_campaign.id),
        ]
        claim.save(update_fields=["eligible_campaign_ids"])
        barrier = Barrier(2)

        def _grant(campaign_code: str):
            close_old_connections()
            try:
                barrier.wait(timeout=10)
                grant = ProviderCreditService.grant_credit_from_campaign(
                    organization=self.first_organization_id,
                    campaign_code=campaign_code,
                    source="new_org",
                )
                return str(grant.id)
            finally:
                close_old_connections()

        with ThreadPoolExecutor(max_workers=2) as executor:
            grant_ids = list(
                executor.map(
                    _grant,
                    [self.campaign.code, second_campaign.code],
                )
            )

        self.assertEqual(len(set(grant_ids)), 2)
        self.assertEqual(
            ProviderCreditGrant.objects.filter(
                organization_id=self.first_organization_id,
                trigger_type=ProviderCreditCampaign.TriggerType.NEW_ORG,
            ).count(),
            2,
        )

    def test_concurrent_team_creation_claims_only_one_first_organization(self):
        owner = get_user_model().objects.create_user(
            username="provider_credit_concurrent_creator",
            email="provider_credit_concurrent_creator@test.local",
            password="test-pass-123",
        )
        barrier = Barrier(2)

        def _create(index: int):
            close_old_connections()
            try:
                thread_owner = get_user_model().objects.get(pk=owner.pk)
                barrier.wait(timeout=10)
                organization = OrganizationService(
                    user=thread_owner
                ).create_organization(
                    name=f"Concurrent First Team {index}",
                    enforce_owner_limit=False,
                )
                return str(organization.id)
            finally:
                close_old_connections()

        with (
            patch.object(OrganizationService, "provision_organization_defaults"),
            patch.object(OrganizationService, "provision_billing"),
            patch.object(OrganizationService, "provision_builtin_extensions"),
            patch.object(
                OrganizationService,
                "_dispatch_new_organization_provider_credits",
            ) as dispatch,
            ThreadPoolExecutor(max_workers=2) as executor,
        ):
            organization_ids = list(executor.map(_create, [1, 2]))

        claims = OrganizationProviderCreditClaim.objects.filter(
            user_id=owner.id,
            eligibility_order__gte=2,
        ).order_by("eligibility_order")
        self.assertEqual(
            {str(claim.organization_id) for claim in claims},
            set(organization_ids),
        )
        self.assertEqual(
            claims.count(),
            2,
        )
        self.assertEqual(dispatch.call_count, 2)
        for organization_id in organization_ids:
            dispatch.assert_any_call(organization_id)
