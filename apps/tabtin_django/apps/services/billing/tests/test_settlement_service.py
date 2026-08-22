from calendar import monthrange
from datetime import date, datetime, timedelta
from decimal import Decimal

from django.test import TestCase
from django.utils import timezone

from apps.services.billing.models import (
    BillingInvoice,
    BillingUsageDaily,
    BillingUsageEvent,
    MeterPricing,
    OrganizationBillingPolicy,
)
from apps.services.billing.services import BillingSettlementService
from apps.services.billing.tests.org_test_utils import org_id_for


class BillingSettlementServiceTests(TestCase):
    databases = {"default"}

    def setUp(self):
        OrganizationBillingPolicy.objects.create(
            organization_id=org_id_for("ws_settle_001"),
            storage_billing_mode="package_plus_paygo",
            llm_billing_mode="paygo_only",
            currency="CREDITS",
            is_active=True,
        )
        MeterPricing.objects.create(
            meter_key="storage.gb_day",
            scope="organization",
            organization_id=org_id_for("ws_settle_001"),
            unit="gb_day",
            unit_price=Decimal("1.00000000"),
            currency="CREDITS",
            precision=8,
            is_active=True,
            priority=100,
            effective_from=timezone.now() - timedelta(days=365),
        )

    def test_generate_monthly_invoice(self):
        now = timezone.now()
        year = now.year
        month = now.month - 1
        if month <= 0:
            month = 12
            year -= 1

        _, last_day = monthrange(year, month)
        occurred_at = timezone.make_aware(datetime(year, month, last_day, 12, 0, 0))
        one_gb = 1024 ** 3

        BillingUsageEvent.objects.create(
            organization_id=org_id_for("ws_settle_001"),
            user_id="",
            meter_key="llm.tokens",
            quantity=Decimal("1000"),
            unit="tokens",
            unit_price=Decimal("0.00200000"),
            amount=Decimal("2.00000000"),
            currency="CREDITS",
            occurred_at=occurred_at,
        )
        BillingUsageEvent.objects.create(
            organization_id=org_id_for("ws_settle_001"),
            user_id="",
            meter_key="storage.bytes",
            quantity=Decimal(one_gb),
            unit="bytes",
            unit_price=Decimal("0"),
            amount=Decimal("0"),
            currency="CREDITS",
            occurred_at=occurred_at,
        )

        invoice = BillingSettlementService.generate_monthly_invoice(
            organization_id=org_id_for("ws_settle_001"),
            year=year,
            month=month,
            overwrite_draft=True,
        )
        invoice.refresh_from_db()

        self.assertEqual(invoice.subtotal_amount, Decimal("3.00000000"))
        self.assertEqual(invoice.discount_amount, Decimal("0E-8"))
        self.assertEqual(invoice.total_amount, Decimal("3.00000000"))

        lines = {line.meter_key: line for line in invoice.lines.all()}
        self.assertIn("llm.tokens", lines)
        self.assertIn("storage.gb_day", lines)
        self.assertEqual(lines["llm.tokens"].amount, Decimal("2.00000000"))
        self.assertEqual(lines["storage.gb_day"].amount, Decimal("1.00000000"))

    def _prev_month(self):
        now = timezone.now()
        year = now.year
        month = now.month - 1
        if month <= 0:
            month = 12
            year -= 1
        return year, month

    def test_aggregate_daily_usage_excludes_charge_failed(self):
        """charge_failed/charge_skipped/charge_reversed 事件不被计入日聚合"""
        year, month = self._prev_month()
        usage_date = date(year, month, 15)
        occurred_at = timezone.make_aware(datetime(year, month, 15, 12, 0, 0))

        BillingUsageEvent.objects.create(
            organization_id=org_id_for("ws_settle_001"),
            user_id="",
            meter_key="llm.tokens",
            quantity=Decimal("1000"),
            unit="tokens",
            unit_price=Decimal("0.00200000"),
            amount=Decimal("2.00000000"),
            currency="CREDITS",
            occurred_at=occurred_at,
            biz_type="llm",
        )
        for biz_type in ("charge_failed", "charge_skipped", "charge_reversed"):
            BillingUsageEvent.objects.create(
                organization_id=org_id_for("ws_settle_001"),
                user_id="",
                meter_key="llm.tokens",
                quantity=Decimal("500"),
                unit="tokens",
                unit_price=Decimal("0.00200000"),
                amount=Decimal("1.00000000"),
                currency="CREDITS",
                occurred_at=occurred_at,
                biz_type=biz_type,
            )

        BillingSettlementService.aggregate_daily_usage(
            organization_id=org_id_for("ws_settle_001"),
            usage_date=usage_date,
        )

        daily_llm = BillingUsageDaily.objects.get(
            organization_id=org_id_for("ws_settle_001"),
            usage_date=usage_date,
            meter_key="llm.tokens",
        )
        self.assertEqual(daily_llm.amount, Decimal("2.00000000"))
        self.assertEqual(daily_llm.quantity, Decimal("1000.00000000"))
        self.assertEqual(daily_llm.source_event_count, 1)
        self.assertEqual(daily_llm.extra["excluded_event_count"], 3)
        self.assertEqual(daily_llm.extra["excluded_amount"], "3.00000000")

    def test_aggregate_daily_usage_idempotent(self):
        """同一天多次聚合结果幂等（bulk_create update_conflicts）"""
        year, month = self._prev_month()
        usage_date = date(year, month, 15)
        occurred_at = timezone.make_aware(datetime(year, month, 15, 12, 0, 0))

        BillingUsageEvent.objects.create(
            organization_id=org_id_for("ws_settle_001"),
            user_id="",
            meter_key="llm.tokens",
            quantity=Decimal("1000"),
            unit="tokens",
            unit_price=Decimal("0.00200000"),
            amount=Decimal("2.00000000"),
            currency="CREDITS",
            occurred_at=occurred_at,
        )

        BillingSettlementService.aggregate_daily_usage(
            organization_id=org_id_for("ws_settle_001"),
            usage_date=usage_date,
        )
        first_count = BillingUsageDaily.objects.filter(
            organization_id=org_id_for("ws_settle_001"),
            usage_date=usage_date,
        ).count()
        first_llm = BillingUsageDaily.objects.get(
            organization_id=org_id_for("ws_settle_001"),
            usage_date=usage_date,
            meter_key="llm.tokens",
        )

        BillingSettlementService.aggregate_daily_usage(
            organization_id=org_id_for("ws_settle_001"),
            usage_date=usage_date,
        )
        second_count = BillingUsageDaily.objects.filter(
            organization_id=org_id_for("ws_settle_001"),
            usage_date=usage_date,
        ).count()
        second_llm = BillingUsageDaily.objects.get(
            organization_id=org_id_for("ws_settle_001"),
            usage_date=usage_date,
            meter_key="llm.tokens",
        )

        self.assertEqual(first_count, second_count)
        self.assertEqual(first_llm.amount, second_llm.amount)
        self.assertEqual(first_llm.quantity, second_llm.quantity)

    def test_generate_monthly_invoice_idempotent(self):
        """已有非 draft 状态的 invoice 不会被覆盖（快速跳过逻辑）"""
        year, month = self._prev_month()
        _, last_day = monthrange(year, month)
        occurred_at = timezone.make_aware(datetime(year, month, last_day, 12, 0, 0))

        BillingUsageEvent.objects.create(
            organization_id=org_id_for("ws_settle_001"),
            user_id="",
            meter_key="llm.tokens",
            quantity=Decimal("1000"),
            unit="tokens",
            unit_price=Decimal("0.00200000"),
            amount=Decimal("2.00000000"),
            currency="CREDITS",
            occurred_at=occurred_at,
        )

        invoice1 = BillingSettlementService.generate_monthly_invoice(
            organization_id=org_id_for("ws_settle_001"),
            year=year,
            month=month,
            overwrite_draft=True,
        )

        invoice2 = BillingSettlementService.generate_monthly_invoice(
            organization_id=org_id_for("ws_settle_001"),
            year=year,
            month=month,
            overwrite_draft=True,
        )

        self.assertEqual(invoice1.id, invoice2.id)
        count = BillingInvoice.objects.filter(
            organization_id=org_id_for("ws_settle_001"),
            period_start=date(year, month, 1),
            period_end=date(year, month, last_day),
        ).count()
        self.assertEqual(count, 1)
