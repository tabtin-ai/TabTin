"""
BaseWalletService.recharge() 幂等检查测试

验证同一 order_id 重复调用 recharge：
- 返回已有的 WalletTransaction 实例
- 不创建新 WalletTransaction
- 不改变钱包余额
"""

import threading
from decimal import Decimal
from unittest.mock import patch

from django.db import close_old_connections
from django.test import TestCase, TransactionTestCase

from apps.users.wallet.models import WalletTransaction, OrganizationWallet
from apps.users.wallet.services.organization_wallet_service import OrganizationWalletService


class RechargeIdempotencyTests(TestCase):
    """BaseWalletService.recharge() 幂等性验证"""

    databases = {"default"}

    def setUp(self):
        from apps.tabtinspace.models import Organization
        from apps.users.auth.models import User
        self.owner = User.objects.create_user(
            email="recharge_idem_owner@test.com", password="test-pass-123",
        )
        self.organization_id = str(Organization.objects.create(
            name="recharge-idem-org",
            owner_id=self.owner.id,
            type=Organization.OrganizationType.TEAM,
        ).id)
        self.svc = OrganizationWalletService()
        self.order_id = "ORDER_IDEM_RECHARGE_001"

    def test_duplicate_order_id_returns_existing_tx(self):
        """同 order_id 第二次调用返回第一次创建的 tx，不创建新记录"""
        tx1 = self.svc.recharge(
            self.organization_id, Decimal("100"), order_id=self.order_id,
        )

        tx2 = self.svc.recharge(
            self.organization_id, Decimal("100"), order_id=self.order_id,
        )

        self.assertEqual(tx1.id, tx2.id)

        tx_count = WalletTransaction.objects.filter(
            related_order_id=self.order_id,
            transaction_type="recharge",
        ).count()
        self.assertEqual(tx_count, 1)

    def test_duplicate_order_id_does_not_change_balance(self):
        """同 order_id 重复充值不改变钱包余额"""
        self.svc.recharge(
            self.organization_id, Decimal("50"), order_id=self.order_id,
        )
        wallet = OrganizationWallet.objects.get(organization_id=self.organization_id)
        balance_after_first = wallet.credits_precise

        self.svc.recharge(
            self.organization_id, Decimal("50"), order_id=self.order_id,
        )
        wallet.refresh_from_db()
        balance_after_second = wallet.credits_precise

        self.assertEqual(balance_after_first, balance_after_second)
        self.assertEqual(balance_after_second, Decimal("50.0000"))

    def test_different_order_ids_create_separate_txs(self):
        """不同 order_id 各自独立充值"""
        tx1 = self.svc.recharge(
            self.organization_id, Decimal("30"), order_id="ORDER_A",
        )
        tx2 = self.svc.recharge(
            self.organization_id, Decimal("70"), order_id="ORDER_B",
        )

        self.assertNotEqual(tx1.id, tx2.id)

        wallet = OrganizationWallet.objects.get(organization_id=self.organization_id)
        self.assertEqual(wallet.credits_precise, Decimal("100.0000"))

    def test_same_order_id_across_organizations_create_separate_txs(self):
        """同 order_id 在不同 organization 下各自幂等，不互相吞单。"""
        from apps.tabtinspace.models import Organization

        other_organization_id = str(Organization.objects.create(
            name="recharge-idem-other-org",
            owner_id=self.owner.id,
            type=Organization.OrganizationType.TEAM,
        ).id)

        tx1 = self.svc.recharge(
            self.organization_id, Decimal("30"), order_id=self.order_id,
        )
        tx2 = self.svc.recharge(
            other_organization_id, Decimal("70"), order_id=self.order_id,
        )

        self.assertNotEqual(tx1.id, tx2.id)
        self.assertEqual(
            WalletTransaction.objects.filter(
                related_order_id=self.order_id,
                transaction_type="recharge",
            ).count(),
            2,
        )
        wallet = OrganizationWallet.objects.get(organization_id=self.organization_id)
        other_wallet = OrganizationWallet.objects.get(organization_id=other_organization_id)
        self.assertEqual(wallet.credits_precise, Decimal("30.0000"))
        self.assertEqual(other_wallet.credits_precise, Decimal("70.0000"))

    def test_no_order_id_bypasses_idempotency(self):
        """order_id 为空时不做幂等检查，每次都充值"""
        self.svc.recharge(self.organization_id, Decimal("10"))
        self.svc.recharge(self.organization_id, Decimal("10"))

        wallet = OrganizationWallet.objects.get(organization_id=self.organization_id)
        self.assertEqual(wallet.credits_precise, Decimal("20.0000"))

        recharge_count = WalletTransaction.objects.filter(
            organization_wallet=wallet,
            transaction_type="recharge",
        ).count()
        self.assertEqual(recharge_count, 2)


class RechargeConcurrencyIdempotencyTests(TransactionTestCase):
    """并发同 order_id 充值只能入账一次。"""

    databases = {"default"}

    def setUp(self):
        from apps.tabtinspace.models import Organization
        from apps.users.auth.models import User

        self.owner = User.objects.create_user(
            email="recharge_concurrent_owner@test.com", password="test-pass-123",
        )
        self.organization_id = str(Organization.objects.create(
            name="recharge-concurrent-org",
            owner_id=self.owner.id,
            type=Organization.OrganizationType.TEAM,
        ).id)
        self.order_id = "ORDER_CONCURRENT_RECHARGE_001"

    def test_concurrent_same_order_id_recharges_once(self):
        barrier = threading.Barrier(2)
        results = []
        errors = []

        def recharge_once():
            close_old_connections()
            try:
                barrier.wait(timeout=5)
                tx = OrganizationWalletService().recharge(
                    self.organization_id,
                    Decimal("100"),
                    order_id=self.order_id,
                )
                results.append(tx.id)
            except Exception as exc:  # pragma: no cover - surfaced by assertion
                errors.append(repr(exc))
            finally:
                close_old_connections()

        threads = [threading.Thread(target=recharge_once) for _ in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=10)

        self.assertEqual(errors, [])
        self.assertEqual(len(results), 2)
        self.assertEqual(len(set(results)), 1)
        self.assertEqual(
            WalletTransaction.objects.filter(
                related_order_id=self.order_id,
                transaction_type="recharge",
            ).count(),
            1,
        )
        wallet = OrganizationWallet.objects.get(organization_id=self.organization_id)
        self.assertEqual(wallet.credits_precise, Decimal("100.0000"))


class OrganizationGrantCreditsSideEffectTests(TestCase):
    """Admin grant 赠送点券后应复用充值后的实时刷新链路。"""

    databases = {"default"}

    def setUp(self):
        from apps.tabtinspace.models import Organization
        from apps.users.auth.models import User
        self.owner = User.objects.create_user(
            email="grant_side_effect_owner@test.com", password="test-pass-123",
        )
        self.organization_id = str(Organization.objects.create(
            name="grant-side-effect-org",
            owner_id=self.owner.id,
            type=Organization.OrganizationType.TEAM,
        ).id)
        self.svc = OrganizationWalletService()

    @patch("apps.services.billing.services.guard_service.BillingGuardService.clear_guard_cache")
    @patch("apps.services.billing.ws_events.publish_billing_event")
    def test_grant_credits_notifies_and_clears_billing_guard(
        self,
        mock_publish_billing_event,
        mock_clear_guard_cache,
    ):
        with self.captureOnCommitCallbacks(execute=True):
            tx = self.svc.grant_credits(
                self.organization_id,
                Decimal("25"),
                description="AdminDash 赠送",
                user_id="admin-user",
            )

        self.assertEqual(tx.transaction_type, "grant")
        mock_publish_billing_event.assert_called_once_with(
            self.organization_id,
            "credits_recharged",
            {
                "amount": "25",
                "order_id": "",
                "transaction_id": str(tx.id),
            },
        )
        mock_clear_guard_cache.assert_called_once_with(
            self.organization_id,
            trigger="grant",
        )

    @patch("apps.services.billing.services.guard_service.BillingGuardService.clear_guard_cache")
    @patch("apps.services.billing.ws_events.publish_billing_event")
    def test_repeated_grants_publish_distinct_transaction_ids(
        self,
        mock_publish_billing_event,
        _mock_clear_guard_cache,
    ):
        with self.captureOnCommitCallbacks(execute=True):
            first = self.svc.grant_credits(self.organization_id, Decimal("25"))
        with self.captureOnCommitCallbacks(execute=True):
            second = self.svc.grant_credits(self.organization_id, Decimal("25"))

        payloads = [call.args[2] for call in mock_publish_billing_event.call_args_list]
        self.assertEqual(len(payloads), 2)
        self.assertEqual(payloads[0]["transaction_id"], str(first.id))
        self.assertEqual(payloads[1]["transaction_id"], str(second.id))
        self.assertNotEqual(payloads[0]["transaction_id"], payloads[1]["transaction_id"])
