from datetime import datetime, timedelta
from decimal import Decimal
from unittest.mock import patch
from zoneinfo import ZoneInfo

from django.contrib.auth import get_user_model
from django.test import TestCase
from django.utils import timezone

from apps.channel_gateway.models import ChannelAccount, ChannelOutboundMessageRecord
from apps.services.billing.services.real_recharge_report_service import (
    format_recharge_report,
    queue_due_daily_recharge_report,
    queue_single_recharge_notification,
    resolve_recharge_period,
    summarize_real_recharges,
)
from apps.services.payment.models import PaymentOrder
from apps.services.billing.tasks import BILLING_BEAT_SCHEDULE

User = get_user_model()


class RealRechargeReportServiceTests(TestCase):
    databases = {"default"}

    def setUp(self):
        self.user = User.objects.create_user(
            username="real_recharge_report_user",
            email="real-recharge@test.com",
            password="pass123",
        )
        now = timezone.now()
        common = {
            "user": self.user,
            "organization_id": "organization-real-recharge",
            "subject": "现金钱包充值",
            "amount": Decimal("50.00"),
            "paid_amount": Decimal("50.00"),
            "paid_at": now,
            "expired_at": now + timedelta(hours=1),
        }
        PaymentOrder.objects.create(
            **common,
            order_type="cash_wallet",
            payment_method="wechat",
            status="completed",
        )
        PaymentOrder.objects.create(
            **{**common, "paid_amount": Decimal("88.00")},
            order_type="cash_wallet",
            payment_method="organization_wallet",
            status="completed",
        )
        PaymentOrder.objects.create(
            **{**common, "paid_amount": Decimal("66.00")},
            order_type="cash_wallet",
            payment_method="alipay",
            status="cancelled",
        )

    def test_summary_only_counts_successful_external_cash_recharges(self):
        summary = summarize_real_recharges(resolve_recharge_period("current_month"))
        self.assertEqual(summary["amount"], "50.00")
        self.assertEqual(summary["order_count"], 1)
        self.assertEqual(summary["user_count"], 1)
        self.assertEqual(summary["organization_count"], 1)

    def test_report_text_explains_the_accounting_definition(self):
        summary = summarize_real_recharges(resolve_recharge_period("today"))
        text = format_recharge_report(summary)
        self.assertIn("实付充值总额：¥50.00", text)
        self.assertIn("支付宝/微信", text)
        self.assertIn("按实付金额", text)


class RealRechargeAutomationTests(TestCase):
    databases = {"default"}

    def setUp(self):
        self.user = User.objects.create_user(
            username="real_recharge_automation_user",
            email="real-recharge-automation@test.com",
            password="pass123",
        )
        self.webhook_url = (
            "https://open.feishu.cn/open-apis/bot/v2/hook/"
            "00000000-0000-0000-0000-000000000000"
        )

    def test_daily_delivery_task_is_registered(self):
        entry = BILLING_BEAT_SCHEDULE["billing-deliver-due-daily-real-recharge-report"]
        self.assertEqual(
            entry["task"],
            "apps.services.billing.tasks.deliver_due_daily_real_recharge_report",
        )

    def _create_account(self, delivery_mode: str, daily_time: str = "09:00"):
        return ChannelAccount.objects.create(
            channel="feishu",
            account_id="billing-real-recharge",
            organization_id="__platform__",
            name="自动充值报表",
            enabled=True,
            config={
                "provider": "feishu",
                "webhook_url": self.webhook_url,
                "delivery_mode": delivery_mode,
                "daily_time": daily_time,
                "schedule_timezone": "Asia/Shanghai",
            },
        )

    def _create_real_recharge(self):
        now = timezone.now()
        return PaymentOrder.objects.create(
            user=self.user,
            organization_id="",
            order_type="cash_wallet",
            subject="现金钱包充值",
            amount=Decimal("25.00"),
            paid_amount=Decimal("25.00"),
            payment_method="wechat",
            status="completed",
            paid_at=now,
            expired_at=now + timedelta(hours=1),
        )

    def test_per_recharge_delivery_is_idempotent_by_order(self):
        self._create_account("per_recharge")
        order = self._create_real_recharge()

        first = queue_single_recharge_notification(order.id)
        second = queue_single_recharge_notification(order.id)

        self.assertTrue(first["queued"])
        self.assertEqual(second["outbox_id"], first["outbox_id"])
        self.assertEqual(
            ChannelOutboundMessageRecord.objects.filter(
                idempotency_key=f"real-recharge:order:{order.id}"
            ).count(),
            1,
        )

    def test_daily_delivery_waits_until_configured_time_and_sends_once(self):
        self._create_account("daily", daily_time="18:00")
        self._create_real_recharge()
        zone = ZoneInfo("Asia/Shanghai")

        early = queue_due_daily_recharge_report(
            now=datetime(2026, 8, 11, 17, 59, tzinfo=zone)
        )
        first = queue_due_daily_recharge_report(
            now=datetime(2026, 8, 11, 18, 0, tzinfo=zone)
        )
        second = queue_due_daily_recharge_report(
            now=datetime(2026, 8, 11, 18, 5, tzinfo=zone)
        )

        self.assertFalse(early["queued"])
        self.assertTrue(first["queued"])
        self.assertEqual(second["outbox_id"], first["outbox_id"])
        self.assertEqual(
            ChannelOutboundMessageRecord.objects.filter(
                idempotency_key="real-recharge:daily:2026-08-11:Asia/Shanghai"
            ).count(),
            1,
        )

    @patch("apps.services.billing.tasks.deliver_single_real_recharge_report.delay")
    def test_payment_transition_enqueues_single_delivery_once(self, mocked_delay):
        self._create_account("per_recharge")
        now = timezone.now()
        order = PaymentOrder.objects.create(
            user=self.user,
            organization_id="",
            order_type="cash_wallet",
            subject="现金钱包充值",
            amount=Decimal("12.00"),
            paid_amount=Decimal("0.00"),
            payment_method="alipay",
            status="pending",
            expired_at=now + timedelta(hours=1),
        )

        with self.captureOnCommitCallbacks(execute=True):
            order.status = "paid"
            order.paid_amount = Decimal("12.00")
            order.paid_at = now
            order.save(update_fields=["status", "paid_amount", "paid_at", "updated_at"])

        with self.captureOnCommitCallbacks(execute=True):
            order.subject = "现金钱包充值（已入账）"
            order.save(update_fields=["subject", "updated_at"])

        mocked_delay.assert_called_once_with(str(order.id))
