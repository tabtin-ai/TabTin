from datetime import timedelta
from decimal import Decimal

from django.contrib.auth import get_user_model
from django.test import TestCase
from django.utils import timezone

from apps.services.billing.models import BillingInvoice, BillingUsageEvent, OrganizationLlmMonthlyBudget
from apps.services.billing.services.statement_service import StatementService
from apps.services.payment.models import PaymentOrder
from apps.users.wallet.models import WalletTransaction, OrganizationWallet
from apps.services.billing.tests.org_test_utils import org_id_for


User = get_user_model()


class StatementServiceTests(TestCase):
    databases = {"default"}

    def setUp(self):
        self.organization_id = org_id_for("wt_statement_001")
        self.user = User.objects.create_user(
            username="statement_user",
            email="statement@test.com",
            password="pass123",
        )

    def test_monthly_statement_is_read_only_and_summarizes_consumption(self):
        now = timezone.now()
        month = now.strftime("%Y-%m")
        wallet = OrganizationWallet.objects.create(
            organization_id=self.organization_id,
            credits=100,
            credits_precise=Decimal("100.0000"),
        )
        BillingUsageEvent.objects.create(
            organization_id=self.organization_id,
            user_id=str(self.user.id),
            meter_key="llm.token",
            quantity=Decimal("100"),
            unit="token",
            unit_price=Decimal("0.01000000"),
            amount=Decimal("1.00000000"),
            provider_key="openai",
            model_name="gpt-test",
            charge_status="charged",
            occurred_at=now,
        )
        WalletTransaction.objects.create(
            organization_wallet=wallet,
            organization_id=self.organization_id,
            transaction_type="consume",
            amount=1,
            amount_precise=Decimal("1.0000"),
            balance_before=100,
            balance_before_precise=Decimal("100.0000"),
            balance_after=99,
            balance_after_precise=Decimal("99.0000"),
            operator_user_id=str(self.user.id),
            description="LLM 超额消费",
        )
        PaymentOrder.objects.create(
            user=self.user,
            organization_id=self.organization_id,
            order_type="credits",
            subject="充值点券",
            description="statement test",
            amount=Decimal("10.00"),
            paid_amount=Decimal("10.00"),
            payment_method="alipay",
            status="completed",
            expired_at=now + timedelta(minutes=30),
            paid_at=now,
        )
        OrganizationLlmMonthlyBudget.objects.create(
            organization_id=self.organization_id,
            cycle_month=timezone.localdate().replace(day=1),
            included_credits=Decimal("500.00000000"),
            consumed_credits=Decimal("1.00000000"),
        )
        BillingInvoice.objects.create(
            organization_id=self.organization_id,
            period_start=timezone.localdate().replace(day=1),
            period_end=timezone.localdate(),
            status="open",
            total_amount=Decimal("99.00000000"),
            subtotal_amount=Decimal("99.00000000"),
            discount_amount=Decimal("0"),
        )

        statement = StatementService.generate_monthly_statement(self.organization_id, month)

        self.assertTrue(statement["read_only"])
        self.assertFalse(statement["collection_enabled"])
        self.assertEqual(statement["guardrails"]["manual_collect_invoice"], "disabled")
        self.assertEqual(statement["llm_usage"]["event_count"], 1)
        self.assertEqual(statement["wallet"]["transaction_count"], 1)
        self.assertEqual(statement["orders"]["by_type"]["credits"]["paid_count"], 1)
        self.assertEqual(statement["entitlements"]["llm_monthly_budget"]["consumed_credits"], "1.00000000")
        self.assertEqual(statement["legacy_invoices"]["invoice_count"], 1)

    def test_month_validation(self):
        with self.assertRaises(ValueError):
            StatementService.generate_monthly_statement(self.organization_id, "2026-13")
