from datetime import timedelta
from decimal import Decimal

from django.test import TestCase
from django.utils import timezone

from apps.services.payment.models import PaymentOrder
from apps.services.payment.services.benefit_service import OrderBenefitService
from apps.services.billing.models import StoragePackagePlan, OrganizationBillingEntitlement, OrganizationStorageSubscription
from apps.users.auth.models import User
from apps.users.membership.models import MembershipTier
from apps.users.wallet.models import (
    CashWalletTransaction,
    CreditPackage,
    OrganizationCashWallet,
    OrganizationWallet,
    WalletTransaction,
)


class OrderBenefitServiceTests(TestCase):
    databases = {"default"}

    def setUp(self):
        self.user = User.objects.create_user(
            email="benefit_service@test.com",
            password="test-pass-123",
        )

    def test_grant_credits_order_marks_completed_and_recharges_wallet(self):
        package = CreditPackage.objects.create(
            name="测试点券包",
            description="",
            price=Decimal("10.00"),
            credits_amount=100,
            bonus_credits=0,
            is_active=True,
        )
        order = PaymentOrder.objects.create(
            user=self.user,
            organization_id="wt_pay_001",
            order_type="credits",
            subject="点券充值",
            description="测试充值",
            amount=Decimal("10.00"),
            payment_method="alipay",
            status="paid",
            expired_at=timezone.now() + timedelta(minutes=30),
            business_data={
                "package_id": str(package.id),
                "total_credits": 100,
                "credits_snapshot_source": "credit_package",
                "organization_id": "wt_pay_001",
            },
        )
        package.credits_amount = 999
        package.save(update_fields=["credits_amount", "updated_at"])

        result = OrderBenefitService.grant(order.id)
        order.refresh_from_db()
        wallet = OrganizationWallet.objects.get(organization_id="wt_pay_001")
        tx = WalletTransaction.objects.get(related_order_id=str(order.id))

        self.assertEqual(result, order.id)
        self.assertEqual(order.status, "completed")
        self.assertEqual(wallet.credits_precise, Decimal("100.0000"))
        self.assertEqual(tx.organization_id, "wt_pay_001")

    def test_grant_storage_package_order_marks_completed_and_updates_entitlement(self):
        # PAY-26: 使用 GB 量级的真实字节数，与生产环境 StoragePackagePlan 保持一致。
        # 50 GB 基础 + 10 GB 赠送 = 60 GB = 60 * 1024**3 bytes
        _GB = 1024 ** 3
        BASE_STORAGE_BYTES = 50 * _GB   # 53687091200
        BONUS_STORAGE_BYTES = 10 * _GB  # 10737418240
        TOTAL_STORAGE_BYTES = BASE_STORAGE_BYTES + BONUS_STORAGE_BYTES  # 64424509440

        MembershipTier.objects.create(
            tier_type="free",
            name="免费版",
            description="",
            price=Decimal("0"),
            duration_months=1,
            included_storage_bytes=0,
            included_llm_credits_monthly=Decimal("0"),
            is_active=True,
        )
        package = StoragePackagePlan.objects.create(
            name="50GB 月包",
            description="",
            price=Decimal("29.90"),
            storage_bytes=BASE_STORAGE_BYTES,
            bonus_storage_bytes=BONUS_STORAGE_BYTES,
            duration_months=1,
            is_active=True,
        )
        order = PaymentOrder.objects.create(
            user=self.user,
            organization_id="wt_storage_order_001",
            order_type="storage_package",
            subject="存储套餐",
            description="测试存储套餐",
            amount=Decimal("29.90"),
            payment_method="alipay",
            status="paid",
            expired_at=timezone.now() + timedelta(minutes=30),
            business_data={
                "organization_id": "wt_storage_order_001",
                "storage_package_id": str(package.id),
            },
        )

        result = OrderBenefitService.grant(order.id)

        order.refresh_from_db()
        entitlement = OrganizationBillingEntitlement.objects.get(organization_id="wt_storage_order_001")
        subscription = OrganizationStorageSubscription.objects.get(order_id=str(order.id))

        self.assertEqual(result, order.id)
        self.assertEqual(order.status, "completed")
        self.assertEqual(subscription.storage_bytes, TOTAL_STORAGE_BYTES)
        self.assertEqual(entitlement.purchased_storage_bytes, TOTAL_STORAGE_BYTES)

    def test_grant_cash_wallet_order_marks_completed_and_recharges_cash(self):
        order = PaymentOrder.objects.create(
            user=self.user,
            organization_id="org_cash_pay_001",
            order_type="cash_wallet",
            subject="现金钱包充值",
            description="测试现金充值",
            amount=Decimal("100.00"),
            paid_amount=Decimal("100.00"),
            payment_method="alipay",
            status="paid",
            expired_at=timezone.now() + timedelta(minutes=30),
            business_data={
                "organization_id": "org_cash_pay_001",
                "amount_cny": "100.00",
            },
        )

        result = OrderBenefitService.grant(order.id)
        order.refresh_from_db()
        wallet = OrganizationCashWallet.objects.get(organization_id="org_cash_pay_001")
        tx = CashWalletTransaction.objects.get(related_order_id=str(order.id))

        self.assertEqual(result, order.id)
        self.assertEqual(order.status, "completed")
        self.assertEqual(wallet.balance_cny, Decimal("100.00"))
        self.assertEqual(tx.transaction_type, "recharge")
        self.assertEqual(tx.amount_cny, Decimal("100.00"))

        # 幂等：重复发放不重复入账
        OrderBenefitService.grant(order.id)
        wallet.refresh_from_db()
        self.assertEqual(wallet.balance_cny, Decimal("100.00"))
        self.assertEqual(
            CashWalletTransaction.objects.filter(related_order_id=str(order.id)).count(),
            1,
        )
