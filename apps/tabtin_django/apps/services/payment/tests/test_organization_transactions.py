"""账单中心团队资金流水：序列化 + 状态归一化 + 团队维度过滤。"""

from datetime import timedelta
from decimal import Decimal

from django.test import TestCase
from django.utils import timezone

from apps.services.payment.api import (
    _REFUND_STATUS_NORMALIZE,
    _PAYMENT_STATUS_NORMALIZE,
    _serialize_payment_transaction,
    _serialize_refund_transaction,
)
from apps.services.payment.models import PaymentOrder, RefundRecord
from apps.users.auth.models import User


class OrganizationTransactionSerializationTests(TestCase):
    databases = {"default"}

    def setUp(self):
        self.user = User.objects.create_user(
            email="organization_tx@test.com",
            password="test-pass-123",
        )
        self.now = timezone.now()

    def test_payment_status_normalization(self):
        cases = {
            "pending": "pending",
            "paying": "pending",
            "paid": "paid",
            "completed": "paid",
            "failed": "payment_failed",
            "cancelled": "closed",
            "expired": "closed",
            "refunded": "refunded",
            "partially_refunded": "partially_refunded",
        }
        for raw, expected in cases.items():
            with self.subTest(raw=raw):
                self.assertEqual(_PAYMENT_STATUS_NORMALIZE[raw], expected)
                order = PaymentOrder.objects.create(
                    user=self.user,
                    organization_id="wt_tx_a",
                    order_type="credits",
                    subject="测试订单",
                    description="",
                    amount=Decimal("10.00"),
                    payment_method="alipay",
                    status=raw,
                    expired_at=self.now + timedelta(minutes=30),
                )
                item = _serialize_payment_transaction(order)
                self.assertEqual(item["status"], expected)
                self.assertEqual(item["raw_status"], raw)

    def test_refund_status_normalization(self):
        cases = {
            "pending": "refunding",
            "refunding": "refunding",
            "refunded": "refunded",
            "refund_failed": "refund_failed",
        }
        for raw, expected in cases.items():
            with self.subTest(raw=raw):
                self.assertEqual(_REFUND_STATUS_NORMALIZE[raw], expected)

    def test_serialize_payment_transaction(self):
        order = PaymentOrder.objects.create(
            user=self.user,
            organization_id="wt_tx_a",
            order_type="credits",
            subject="点券充值 - 测试包",
            description="",
            amount=Decimal("99.00"),
            paid_amount=Decimal("99.00"),
            payment_method="alipay",
            status="completed",
            third_party_trade_no="TP202607060001",
            business_data={"package_name": "测试包", "total_credits": "1000"},
            paid_at=self.now,
            expired_at=self.now + timedelta(minutes=30),
        )

        item = _serialize_payment_transaction(order)

        self.assertEqual(item["kind"], "payment")
        self.assertEqual(item["id"], str(order.id))
        self.assertEqual(item["no"], order.order_no)
        self.assertEqual(item["summary"], "点券充值 - 测试包")
        self.assertEqual(item["amount"], "99.00")
        self.assertEqual(item["status"], "paid")
        self.assertEqual(item["third_party_no"], "TP202607060001")
        self.assertEqual(item["business_data"]["total_credits"], "1000")

    def test_serialize_refund_transaction_follows_payment_order(self):
        order = PaymentOrder.objects.create(
            user=self.user,
            organization_id="wt_tx_a",
            order_type="credits",
            subject="点券充值 - 测试包",
            description="",
            amount=Decimal("99.00"),
            payment_method="alipay",
            status="completed",
            expired_at=self.now + timedelta(minutes=30),
        )
        refund = RefundRecord.objects.create(
            payment_order=order,
            invoice_id="00000000-0000-0000-0000-000000000001",
            refund_amount=Decimal("99.00"),
            refund_status="refunded",
            payment_method="alipay",
            third_party_refund_no="RF202607060001",
            reason="验收退款",
            refunded_at=self.now,
        )

        item = _serialize_refund_transaction(refund)

        self.assertEqual(item["kind"], "refund")
        self.assertEqual(item["no"], refund.refund_no)
        self.assertEqual(item["summary"], order.subject)
        self.assertEqual(item["related_order_no"], order.order_no)
        self.assertEqual(item["order_type"], "credits")
        self.assertEqual(item["status"], "refunded")
        self.assertEqual(item["reason"], "验收退款")
        self.assertEqual(item["third_party_no"], "RF202607060001")

    def test_team_filter_payment_orders(self):
        PaymentOrder.objects.create(
            user=self.user,
            organization_id="wt_tx_a",
            order_type="credits",
            subject="团队 A 订单",
            description="",
            amount=Decimal("10.00"),
            payment_method="alipay",
            status="paid",
            expired_at=self.now + timedelta(minutes=30),
        )
        PaymentOrder.objects.create(
            user=self.user,
            organization_id="wt_tx_b",
            order_type="credits",
            subject="团队 B 订单",
            description="",
            amount=Decimal("20.00"),
            payment_method="alipay",
            status="paid",
            expired_at=self.now + timedelta(minutes=30),
        )

        team_a_orders = PaymentOrder.objects.filter(organization_id="wt_tx_a")
        self.assertEqual(team_a_orders.count(), 1)
        self.assertEqual(team_a_orders.first().subject, "团队 A 订单")

    def test_team_filter_refund_records(self):
        order_a = PaymentOrder.objects.create(
            user=self.user,
            organization_id="wt_tx_a",
            order_type="credits",
            subject="团队 A 订单",
            description="",
            amount=Decimal("10.00"),
            payment_method="alipay",
            status="paid",
            expired_at=self.now + timedelta(minutes=30),
        )
        order_b = PaymentOrder.objects.create(
            user=self.user,
            organization_id="wt_tx_b",
            order_type="credits",
            subject="团队 B 订单",
            description="",
            amount=Decimal("20.00"),
            payment_method="alipay",
            status="paid",
            expired_at=self.now + timedelta(minutes=30),
        )
        RefundRecord.objects.create(
            payment_order=order_a,
            invoice_id="00000000-0000-0000-0000-000000000002",
            refund_amount=Decimal("10.00"),
            refund_status="refunded",
            payment_method="alipay",
        )
        RefundRecord.objects.create(
            payment_order=order_b,
            invoice_id="00000000-0000-0000-0000-000000000003",
            refund_amount=Decimal("20.00"),
            refund_status="refunded",
            payment_method="alipay",
        )

        team_a_refunds = RefundRecord.objects.filter(payment_order__organization_id="wt_tx_a")
        self.assertEqual(team_a_refunds.count(), 1)
        self.assertEqual(team_a_refunds.first().payment_order_id, order_a.id)
