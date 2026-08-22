"""billing.0047 在真实 PostgreSQL 上的资金数据升级场景。"""

from __future__ import annotations

import logging
import time
import uuid
from datetime import date, timedelta
from decimal import Decimal

from django.db import IntegrityError, transaction
from django.db.migrations.executor import MigrationExecutor
from django.utils import timezone

from apps.services.migration_guard.scenario import PostgresMigrationScenarioTestCase


logger = logging.getLogger(__name__)


class BillingReservationMigrationScenario(PostgresMigrationScenarioTestCase):
    app_label = "billing"
    migrate_from = "0046_alter_organizationcreditledger_options_and_more"
    migrate_to = "0047_billingreservation_and_more"
    extra_targets = (
        ("wallet", "0023_cash_transaction_membership_lifecycle_type"),
        ("tabtinspace", "0145_shared_resource_placement_dismissed"),
    )

    def test_existing_funding_rows_survive_and_new_guards_are_enforced(self) -> None:
        self.run_migration_scenario()

    def seed_before_migration(self, connection) -> None:
        executor = MigrationExecutor(connection)
        state_apps = executor.loader.project_state(
            [
                (self.app_label, self.migrate_from),
                *self.extra_targets,
            ]
        ).apps

        User = state_apps.get_model("users_auth", "User")
        Organization = state_apps.get_model("tabtinspace", "Organization")
        ProviderCreditCampaign = state_apps.get_model(
            "billing", "ProviderCreditCampaign"
        )
        ProviderCreditGrant = state_apps.get_model("billing", "ProviderCreditGrant")
        OrganizationLlmMonthlyBudget = state_apps.get_model(
            "billing", "OrganizationLlmMonthlyBudget"
        )
        OrganizationWallet = state_apps.get_model("wallet", "OrganizationWallet")

        user = User.objects.create(
            username="migration-0047-owner",
            password="",
            avatar="",
            bio="",
            date_joined=timezone.now(),
        )
        organization = Organization.objects.create(
            name="Migration 0047 Organization",
            description="",
            icon="",
            owner=user,
        )
        campaign = ProviderCreditCampaign.objects.create(
            code="migration-0047-campaign",
            name="Migration 0047 Campaign",
            provider_key="bytedance",
            credits_amount=Decimal("1000"),
            total_budget_credits=Decimal("1000"),
        )
        grant = ProviderCreditGrant.objects.create(
            organization=organization,
            campaign=campaign,
            provider_key="bytedance",
            total_credits=Decimal("1000"),
            consumed_credits=Decimal("101"),
            remaining_credits=Decimal("899"),
        )
        budget = OrganizationLlmMonthlyBudget.objects.create(
            organization=organization,
            cycle_month=date(2026, 8, 1),
            included_credits=Decimal("120"),
            consumed_credits=Decimal("20"),
            topup_credits=Decimal("5"),
        )
        wallet = OrganizationWallet.objects.create(
            organization=organization,
            credits=80,
            credits_precise=Decimal("80.0000"),
            credits_frozen=7,
            credits_frozen_precise=Decimal("7.0000"),
        )

        self.organization_id = organization.pk
        self.grant_id = grant.pk
        self.budget_id = budget.pk
        self.wallet_id = wallet.pk
        self.table_nodes_before = dict(
            self.fetchall(
                """
                SELECT relname, relfilenode
                FROM pg_class
                WHERE relname IN (
                    'services_billing_provider_credit_grant',
                    'services_billing_organization_llm_monthly_budget'
                )
                """
            )
        )
        self.migration_started_at = time.monotonic()

    def assert_after_migration(self, connection) -> None:
        migration_seconds = time.monotonic() - self.migration_started_at

        grant = self.fetchone(
            """
            SELECT total_credits, consumed_credits, remaining_credits,
                   active_reserved_credits
            FROM services_billing_provider_credit_grant
            WHERE id = %s
            """,
            [self.grant_id],
        )
        self.assertEqual(
            grant,
            (
                Decimal("1000.00000000"),
                Decimal("101.00000000"),
                Decimal("899.00000000"),
                Decimal("0E-8"),
            ),
        )

        budget = self.fetchone(
            """
            SELECT included_credits, consumed_credits, topup_credits,
                   active_reserved_credits
            FROM services_billing_organization_llm_monthly_budget
            WHERE id = %s
            """,
            [self.budget_id],
        )
        self.assertEqual(
            budget,
            (
                Decimal("120.00000000"),
                Decimal("20.00000000"),
                Decimal("5.00000000"),
                Decimal("0E-8"),
            ),
        )

        wallet = self.fetchone(
            """
            SELECT credits, credits_precise, credits_frozen,
                   credits_frozen_precise
            FROM users_wallet_organization_wallet
            WHERE id = %s
            """,
            [self.wallet_id],
        )
        self.assertEqual(
            wallet,
            (80, Decimal("80.0000"), 7, Decimal("7.0000")),
        )

        table_nodes_after = dict(
            self.fetchall(
                """
                SELECT relname, relfilenode
                FROM pg_class
                WHERE relname IN (
                    'services_billing_provider_credit_grant',
                    'services_billing_organization_llm_monthly_budget'
                )
                """
            )
        )
        self.assertEqual(
            table_nodes_after,
            self.table_nodes_before,
            "常量默认值列不应重写现有额度或预算表",
        )
        self.assertLess(
            migration_seconds,
            30,
            f"billing.0047 在场景库迁移耗时异常: {migration_seconds:.3f}s",
        )
        logger.info(
            "billing.0047 PostgreSQL evidence: duration=%.3fs table_rewrite=false",
            migration_seconds,
        )

        constraint_names = {
            row[0]
            for row in self.fetchall(
                """
                SELECT conname
                FROM pg_constraint
                WHERE conname = ANY(%s)
                """,
                [[
                    "pcred_reserved_nonnegative",
                    "pcred_reserved_lte_remaining",
                    "llmbudget_reserved_nonneg",
                    "uniq_provider_attempt_res_generation_number",
                    "uniq_billing_reservation_allocation_source",
                    "uniq_billing_reservation_org_search_invocation",
                ]],
            )
        }
        self.assertEqual(
            constraint_names,
            {
                "pcred_reserved_nonnegative",
                "pcred_reserved_lte_remaining",
                "llmbudget_reserved_nonneg",
                "uniq_provider_attempt_res_generation_number",
                "uniq_billing_reservation_allocation_source",
                "uniq_billing_reservation_org_search_invocation",
            },
        )

        index_names = {
            row[0]
            for row in self.fetchall(
                """
                SELECT indexname
                FROM pg_indexes
                WHERE schemaname = 'public'
                  AND indexname = ANY(%s)
                """,
                [[
                    "bill_prov_attempt_out_idx",
                    "bill_res_alloc_status_idx",
                    "bill_res_status_lease_idx",
                    "bill_res_status_recover_idx",
                    "bill_res_org_created_idx",
                ]],
            )
        }
        self.assertEqual(
            index_names,
            {
                "bill_prov_attempt_out_idx",
                "bill_res_alloc_status_idx",
                "bill_res_status_lease_idx",
                "bill_res_status_recover_idx",
                "bill_res_org_created_idx",
            },
        )

        self._assert_check_constraint_rejects(
            """
            UPDATE services_billing_provider_credit_grant
            SET active_reserved_credits = -1
            WHERE id = %s
            """,
            [self.grant_id],
        )
        self._assert_check_constraint_rejects(
            """
            UPDATE services_billing_provider_credit_grant
            SET active_reserved_credits = remaining_credits + 1
            WHERE id = %s
            """,
            [self.grant_id],
        )
        self._assert_check_constraint_rejects(
            """
            UPDATE services_billing_organization_llm_monthly_budget
            SET active_reserved_credits = -1
            WHERE id = %s
            """,
            [self.budget_id],
        )

        self._assert_unique_constraints(connection)

    def _assert_check_constraint_rejects(self, sql: str, params: list) -> None:
        with self.assertRaises(IntegrityError):
            with transaction.atomic(using=self._alias):
                self.execute(sql, params)

    def _assert_unique_constraints(self, connection) -> None:
        executor = MigrationExecutor(connection)
        state_apps = executor.loader.project_state(
            [
                (self.app_label, self.migrate_to),
                *self.extra_targets,
            ]
        ).apps
        BillingReservation = state_apps.get_model("billing", "BillingReservation")
        BillingReservationAllocation = state_apps.get_model(
            "billing", "BillingReservationAllocation"
        )
        ProviderAttempt = state_apps.get_model("billing", "ProviderAttempt")

        logical_id = uuid.uuid4()
        lease_expires_at = timezone.now() + timedelta(minutes=5)
        reservation_kwargs = {
            "organization_id": self.organization_id,
            "user_id": str(uuid.uuid4()),
            "logical_search_invocation_id": logical_id,
            "request_fingerprint": "a" * 64,
            "fingerprint_version": "v1",
            "meter_key": "web.search.request",
            "quantity": Decimal("1"),
            "unit_price": Decimal("1"),
            "total_credits": Decimal("1"),
            "funding_mode": "quota_then_paygo",
            "lease_expires_at": lease_expires_at,
        }
        reservation = BillingReservation.objects.create(**reservation_kwargs)
        with self.assertRaises(IntegrityError):
            with transaction.atomic(using=self._alias):
                BillingReservation.objects.create(**reservation_kwargs)

        allocation_kwargs = {
            "reservation": reservation,
            "source_type": "sponsored",
            "source_reference": str(self.grant_id),
            "credits": Decimal("1"),
            "provider_credit_grant_id": self.grant_id,
        }
        BillingReservationAllocation.objects.create(**allocation_kwargs)
        with self.assertRaises(IntegrityError):
            with transaction.atomic(using=self._alias):
                BillingReservationAllocation.objects.create(**allocation_kwargs)

        attempt_kwargs = {
            "reservation": reservation,
            "provider_key": "bocha",
            "generation": 1,
            "attempt_number": 1,
        }
        ProviderAttempt.objects.create(**attempt_kwargs)
        with self.assertRaises(IntegrityError):
            with transaction.atomic(using=self._alias):
                ProviderAttempt.objects.create(**attempt_kwargs)
