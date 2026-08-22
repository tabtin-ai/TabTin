from datetime import date
from decimal import Decimal

from django.db.models.signals import post_save
from django.test import TestCase

from apps.services.billing.models import BillingInvoice, OrganizationBillingPolicy
from apps.services.billing.services.collection_service import BillingCollectionService
from apps.services.billing.services.refund_service import BillingRefundService
from apps.tabtinspace.signals import create_default_organization
from apps.users.auth.models import User
from apps.users.wallet.models import WalletTransaction, OrganizationWallet
from apps.services.billing.tests.org_test_utils import org_id_for


class BillingRefundServiceTests(TestCase):
    databases = {"default"}

    def setUp(self):
        post_save.disconnect(create_default_organization, sender=User)
        self.addCleanup(lambda: post_save.connect(create_default_organization, sender=User))

        self.user = User.objects.create_user(
            email="billing_refund@test.com",
            password="test-pass-123",
        )
        OrganizationBillingPolicy.objects.create(
            organization_id=org_id_for("ws_refund_001"),
            storage_billing_mode="package_plus_paygo",
            llm_billing_mode="quota_then_paygo",
            currency="CREDITS",
            is_active=True,
            metadata={"payer_user_id": str(self.user.id)},
        )
        OrganizationWallet.objects.create(
            organization_id=org_id_for("ws_refund_001"),
            credits_precise=Decimal("200.0000"),
            credits_frozen_precise=Decimal("0.0000"),
        )

    def _create_and_pay_invoice(
        self,
        *,
        invoice_no: str,
        amount: Decimal,
        period_start: date = date(2026, 1, 1),
        period_end: date = date(2026, 1, 31),
    ) -> BillingInvoice:
        inv = BillingInvoice.objects.create(
            invoice_no=invoice_no,
            organization_id=org_id_for("ws_refund_001"),
            period_start=period_start,
            period_end=period_end,
            status="open",
            currency="CREDITS",
            subtotal_amount=amount,
            discount_amount=Decimal("0"),
            total_amount=amount,
            metadata={},
        )
        result = BillingCollectionService.collect_invoice(str(inv.id))
        self.assertEqual(result["result"], "paid")
        inv.refresh_from_db()
        return inv

    def test_full_refund(self):
        """全额退款 → status='refunded', refunded_amount=total_amount"""
        inv = self._create_and_pay_invoice(invoice_no="INV-REFUND-FULL", amount=Decimal("10.0000"))
        ws_wallet = OrganizationWallet.objects.get(organization_id=org_id_for("ws_refund_001"))
        wallet_before = ws_wallet.credits_precise

        result = BillingRefundService.refund_invoice(str(inv.id))

        inv.refresh_from_db()
        ws_wallet.refresh_from_db()
        wallet_after = ws_wallet.credits_precise

        self.assertEqual(result["status"], "refunded")
        self.assertEqual(inv.status, "refunded")
        self.assertEqual(inv.refunded_amount, Decimal("10.0000"))
        self.assertIsNotNone(inv.refunded_at)
        self.assertEqual(wallet_after - wallet_before, Decimal("10.0000"))

    def test_partial_refund(self):
        """部分退款 → status='partially_refunded'"""
        inv = self._create_and_pay_invoice(invoice_no="INV-REFUND-PART", amount=Decimal("10.0000"))

        result = BillingRefundService.refund_invoice(str(inv.id), amount=Decimal("3.0000"))

        inv.refresh_from_db()
        self.assertEqual(result["status"], "partially_refunded")
        self.assertEqual(inv.status, "partially_refunded")
        self.assertEqual(inv.refunded_amount, Decimal("3.0000"))

    def test_partial_then_full(self):
        """先部分退款再退剩余 → 最终 status='refunded'"""
        inv = self._create_and_pay_invoice(invoice_no="INV-REFUND-PF", amount=Decimal("10.0000"))

        BillingRefundService.refund_invoice(str(inv.id), amount=Decimal("4.0000"))
        inv.refresh_from_db()
        self.assertEqual(inv.status, "partially_refunded")
        self.assertEqual(inv.refunded_amount, Decimal("4.0000"))

        BillingRefundService.refund_invoice(str(inv.id), amount=Decimal("6.0000"))
        inv.refresh_from_db()
        self.assertEqual(inv.status, "refunded")
        self.assertEqual(inv.refunded_amount, Decimal("10.0000"))

        metadata = inv.metadata or {}
        refund_history = metadata.get("refund_history", [])
        self.assertEqual(len(refund_history), 2)

    def test_refund_exceeds_amount(self):
        """退款金额超过可退金额 → 应报错"""
        inv = self._create_and_pay_invoice(invoice_no="INV-REFUND-EXCEED", amount=Decimal("10.0000"))

        with self.assertRaises(ValueError) as ctx:
            BillingRefundService.refund_invoice(str(inv.id), amount=Decimal("15.0000"))
        self.assertIn("超过可退金额", str(ctx.exception))

    def test_refund_non_paid_invoice(self):
        """对 open 账单退款 → 应报错"""
        inv = BillingInvoice.objects.create(
            invoice_no="INV-REFUND-OPEN",
            organization_id=org_id_for("ws_refund_001"),
            period_start=date(2026, 2, 1),
            period_end=date(2026, 2, 28),
            status="open",
            currency="CREDITS",
            subtotal_amount=Decimal("5.0000"),
            discount_amount=Decimal("0"),
            total_amount=Decimal("5.0000"),
            metadata={},
        )

        with self.assertRaises(ValueError) as ctx:
            BillingRefundService.refund_invoice(str(inv.id))
        self.assertIn("仅 paid / partially_refunded 状态可退款", str(ctx.exception))

    def test_wallet_balance_restored(self):
        """退款后钱包余额正确增加"""
        ws_wallet = OrganizationWallet.objects.get(organization_id=org_id_for("ws_refund_001"))
        balance_before_pay = ws_wallet.credits_precise

        inv = self._create_and_pay_invoice(invoice_no="INV-REFUND-BAL", amount=Decimal("20.0000"))
        ws_wallet.refresh_from_db()
        self.assertEqual(ws_wallet.credits_precise, balance_before_pay - Decimal("20.0000"))

        BillingRefundService.refund_invoice(str(inv.id), amount=Decimal("12.0000"))
        ws_wallet.refresh_from_db()
        self.assertEqual(ws_wallet.credits_precise, balance_before_pay - Decimal("8.0000"))

        refund_tx = WalletTransaction.objects.filter(
            transaction_type="refund",
            related_order_id=str(inv.id),
        ).first()
        self.assertIsNotNone(refund_tx)
        self.assertEqual(refund_tx.amount_precise, Decimal("12.0000"))
        self.assertEqual(str(refund_tx.organization_wallet_id), str(ws_wallet.id))
