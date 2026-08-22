from datetime import datetime, timedelta, timezone as dt_timezone
from decimal import Decimal
from unittest.mock import MagicMock, patch

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.db import connection
from django.test import TransactionTestCase

from apps.services.billing.models import OrganizationBillingEntitlement, OrganizationLlmMonthlyBudget
from apps.services.billing.services import OrganizationLlmBudgetService
from apps.services.billing.tests.org_test_utils import org_id_for
from apps.tabtinspace.models import Organization
from apps.users.membership.models import MembershipTier, OrganizationMembership


User = get_user_model()


class OrganizationLlmBudgetServiceTests(TransactionTestCase):
    databases = {"default"}

    def setUp(self):
        cache.clear()
        self.organization_id = org_id_for("ws_llm_budget_001")
        OrganizationBillingEntitlement.objects.create(
            organization_id=self.organization_id,
            included_storage_bytes=0,
            purchased_storage_bytes=0,
            included_llm_credits_monthly=Decimal("10.0000"),
            is_active=True,
        )

    def test_consume_quota_then_paygo(self):
        result_1 = OrganizationLlmBudgetService.consume_llm_credits(
            organization_id=self.organization_id,
            requested_credits=Decimal("6.0000"),
            llm_billing_mode="quota_then_paygo",
        )
        self.assertEqual(result_1["quota_covered_credits"], Decimal("6.0000"))
        self.assertEqual(result_1["paygo_credits"], Decimal("0.0000"))
        self.assertEqual(result_1["remaining_quota_credits"], Decimal("4.0000"))

        result_2 = OrganizationLlmBudgetService.consume_llm_credits(
            organization_id=self.organization_id,
            requested_credits=Decimal("7.0000"),
            llm_billing_mode="quota_then_paygo",
        )
        self.assertEqual(result_2["quota_covered_credits"], Decimal("4.0000"))
        self.assertEqual(result_2["paygo_credits"], Decimal("3.0000"))
        self.assertEqual(result_2["remaining_quota_credits"], Decimal("0.0000"))

    def test_get_remaining_quota_credits_no_budget_record(self):
        remaining = OrganizationLlmBudgetService.get_remaining_quota_credits(self.organization_id)
        self.assertEqual(remaining, Decimal("10.0000"))

    def test_get_remaining_quota_credits_after_partial_consume(self):
        OrganizationLlmBudgetService.consume_llm_credits(
            organization_id=self.organization_id,
            requested_credits=Decimal("3.0000"),
            llm_billing_mode="quota_then_paygo",
        )
        remaining = OrganizationLlmBudgetService.get_remaining_quota_credits(self.organization_id)
        self.assertEqual(remaining, Decimal("7.0000"))

    def test_get_remaining_quota_credits_after_full_consume(self):
        OrganizationLlmBudgetService.consume_llm_credits(
            organization_id=self.organization_id,
            requested_credits=Decimal("10.0000"),
            llm_billing_mode="quota_then_paygo",
        )
        remaining = OrganizationLlmBudgetService.get_remaining_quota_credits(self.organization_id)
        self.assertEqual(remaining, Decimal("0.0000"))

    def test_read_only_remaining_quota_uses_entitlement_without_syncing_budget(self):
        OrganizationLlmBudgetService.consume_llm_credits(
            organization_id=self.organization_id,
            requested_credits=Decimal("1.0000"),
            llm_billing_mode="quota_then_paygo",
        )
        OrganizationBillingEntitlement.objects.filter(
            organization_id=self.organization_id,
        ).update(included_llm_credits_monthly=Decimal("20.0000"))
        cache.clear()

        remaining = OrganizationLlmBudgetService.get_remaining_quota_credits(
            self.organization_id,
            sync_entitlement=False,
        )

        self.assertEqual(remaining, Decimal("19.0000"))
        budget = OrganizationLlmMonthlyBudget.objects.get(
            organization_id=self.organization_id,
            cycle_month=OrganizationLlmBudgetService.cycle_month(),
        )
        self.assertEqual(budget.included_credits, Decimal("10.0000"))

    def test_read_only_membership_fallback_does_not_sync_entitlement(self):
        membership = MagicMock()
        membership.tier.tier_type = "pro"
        membership.tier.included_llm_credits_monthly = Decimal("20.0000")
        membership.tier.name = "Pro"

        with patch(
            "apps.users.membership.models.OrganizationMembership.objects",
        ) as memberships, patch(
            "apps.services.billing.services.entitlement_service."
            "OrganizationEntitlementSyncService.sync_organization_entitlement",
        ) as sync_entitlement:
            memberships.filter.return_value.select_related.return_value.order_by.return_value.first.return_value = membership
            credits = OrganizationLlmBudgetService._resolve_membership_fallback_credits(
                self.organization_id,
                sync_entitlement=False,
            )

        self.assertEqual(credits, Decimal("20.0000"))
        sync_entitlement.assert_not_called()

    def test_preview_consumption_does_not_emit_quota_exhausted_event(self):
        with patch.object(
            OrganizationLlmBudgetService,
            "_notify_quota_exhausted",
        ) as notify:
            OrganizationLlmBudgetService.consume_llm_credits(
                organization_id=self.organization_id,
                requested_credits=Decimal("12.0000"),
                llm_billing_mode="quota_then_paygo",
                emit_events=False,
            )

        notify.assert_not_called()

    def test_get_remaining_quota_credits_no_entitlement(self):
        remaining = OrganizationLlmBudgetService.get_remaining_quota_credits(
            org_id_for("nonexistent_ws")
        )
        self.assertEqual(remaining, Decimal("0.0000"))

    def test_new_membership_budget_uses_full_cycle_credits_without_prorate(self):
        organization, tier = self._create_active_membership_context(
            start_at=datetime(2026, 7, 30, 11, 40, tzinfo=dt_timezone.utc),
            credits=Decimal("6000"),
        )

        budget = OrganizationLlmBudgetService.get_or_create_monthly_budget_locked(
            str(organization.id),
            at_time=datetime(2026, 7, 30, 12, 0, tzinfo=dt_timezone.utc),
        )

        self.assertEqual(budget.included_credits, tier.included_llm_credits_monthly)
        self.assertEqual(budget.consumed_credits, Decimal("0"))

    def test_existing_prorated_membership_budget_refreshes_full_and_preserves_usage(self):
        organization, tier = self._create_active_membership_context(
            start_at=datetime(2026, 7, 30, 11, 40, tzinfo=dt_timezone.utc),
            credits=Decimal("6000"),
        )
        OrganizationLlmMonthlyBudget.objects.create(
            organization=organization,
            cycle_month=datetime(2026, 7, 1, tzinfo=dt_timezone.utc).date(),
            included_credits=Decimal("387.09680000"),
            consumed_credits=Decimal("28.09060000"),
            topup_credits=Decimal("10.00000000"),
        )

        remaining = OrganizationLlmBudgetService.get_remaining_quota_credits(
            str(organization.id),
            at_time=datetime(2026, 7, 30, 12, 0, tzinfo=dt_timezone.utc),
        )

        budget = OrganizationLlmMonthlyBudget.objects.get(organization=organization)
        self.assertEqual(budget.included_credits, tier.included_llm_credits_monthly)
        self.assertEqual(budget.consumed_credits, Decimal("28.09060000"))
        self.assertEqual(budget.topup_credits, Decimal("10.00000000"))
        self.assertEqual(remaining, Decimal("5981.9094"))

    def test_create_budget_sets_topup_credits_when_database_requires_it(self):
        """Sentry : deployed DB may have NOT NULL topup_credits before code writes it."""
        added_column, dropped_default = self._ensure_topup_credits_required_without_db_default()
        try:
            OrganizationLlmBudgetService.consume_llm_credits(
                organization_id=self.organization_id,
                requested_credits=Decimal("1.0000"),
                llm_billing_mode="quota_then_paygo",
            )
            budget = OrganizationLlmMonthlyBudget.objects.get(
                organization_id=self.organization_id,
                cycle_month=OrganizationLlmBudgetService.cycle_month(),
            )
            self.assertEqual(budget.topup_credits, Decimal("0.00000000"))
        finally:
            if dropped_default:
                with connection.cursor() as cursor:
                    cursor.execute(
                        "ALTER TABLE services_billing_organization_llm_monthly_budget "
                        "ALTER COLUMN topup_credits SET DEFAULT 0"
                    )
            if added_column:
                with connection.cursor() as cursor:
                    cursor.execute(
                        "ALTER TABLE services_billing_organization_llm_monthly_budget "
                        "DROP COLUMN topup_credits"
                    )

    def test_consume_quota_only_overflows_to_wallet_paygo(self):
        # ：quota_only 配额耗尽后不再免费溢出，超额部分作为 paygo_credits
        # 交由下游从持久点券钱包 OrganizationWallet 扣减。
        OrganizationLlmBudgetService.consume_llm_credits(
            organization_id=self.organization_id,
            requested_credits=Decimal("10.0000"),
            llm_billing_mode="quota_only",
        )
        result = OrganizationLlmBudgetService.consume_llm_credits(
            organization_id=self.organization_id,
            requested_credits=Decimal("2.5000"),
            llm_billing_mode="quota_only",
        )
        self.assertEqual(result["quota_covered_credits"], Decimal("0.0000"))
        self.assertEqual(result["paygo_credits"], Decimal("2.5000"))
        self.assertEqual(result["overflow_credits"], Decimal("0"))

    @staticmethod
    def _ensure_topup_credits_required_without_db_default() -> tuple[bool, bool]:
        table = "services_billing_organization_llm_monthly_budget"
        with connection.cursor() as cursor:
            existing_columns = {
                column.name
                for column in connection.introspection.get_table_description(cursor, table)
            }
            if "topup_credits" not in existing_columns and connection.vendor == "postgresql":
                cursor.execute(
                    f"ALTER TABLE {table} "
                    "ADD COLUMN topup_credits numeric(20, 8) NOT NULL"
                )
                return True, False
            if "topup_credits" not in existing_columns:
                cursor.execute(
                    f"ALTER TABLE {table} "
                    "ADD COLUMN topup_credits numeric(20, 8) NOT NULL DEFAULT 0"
                )
                return True, False
            if connection.vendor == "postgresql":
                cursor.execute(f"ALTER TABLE {table} ALTER COLUMN topup_credits DROP DEFAULT")
                return False, True
        return False, False

    def _create_active_membership_context(
        self,
        *,
        start_at,
        credits: Decimal,
    ) -> tuple[Organization, MembershipTier]:
        token = str(start_at.timestamp()).replace(".", "_")
        user = User.objects.create_user(
            username=f"llm-budget-membership-{token}",
            email=f"llm-budget-membership-{token}@tabtin.test",
            password="!",
        )
        organization = Organization.objects.create(
            name=f"llm-budget-membership-{token}",
            owner=user,
            type=Organization.OrganizationType.TEAM,
        )
        tier = MembershipTier.objects.create(
            tier_type=f"llm-budget-pro-{token}",
            name="LLM Budget Pro",
            description="",
            price=Decimal("69.00"),
            duration_months=1,
            max_tables=10,
            max_documents=10,
            max_groups=10,
            max_records_per_table=100,
            included_storage_bytes=1024,
            included_llm_credits_monthly=credits,
            max_members=5,
            features={},
            sort_order=20,
            tier_level=20,
            is_active=True,
        )
        OrganizationMembership.objects.create(
            organization_id=str(organization.id),
            tier=tier,
            status="active",
            start_date=start_at,
            end_date=start_at + timedelta(days=31),
            billing_cycle="monthly",
            current_actual_paid_period_price=tier.price,
        )
        OrganizationBillingEntitlement.objects.create(
            organization_id=str(organization.id),
            included_storage_bytes=0,
            purchased_storage_bytes=0,
            included_llm_credits_monthly=credits,
            is_active=True,
        )
        return organization, tier
