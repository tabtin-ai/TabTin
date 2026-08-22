import threading
from datetime import timedelta
from decimal import Decimal
from unittest.mock import MagicMock, patch

from django.contrib.auth import get_user_model
from django.db import connection
from django.test import TestCase, TransactionTestCase, override_settings
from django.utils import timezone

from apps.services.billing.models import BillingUsageEvent, OrganizationBillingEntitlement, OrganizationLlmMonthlyBudget
from apps.services.payment.models import PaymentOrder
from apps.services.payment.services.benefit_service import OrderBenefitService
from apps.tabtinspace.models import Organization
from apps.users.membership.exceptions import MembershipLifecycleError
from apps.users.membership.models import (
    MembershipTier,
    OrganizationMembership,
    OrganizationMembershipChangeLog,
)
from apps.users.membership.services.subscription_order_service import (
    MembershipUpgradeBalanceError,
    SubscriptionOrderService,
)
from apps.users.membership.services.membership_payment_service import (
    MembershipPaymentError,
    MembershipPaymentService,
)
from apps.users.membership.services.subscription_pricing_service import (
    SubscriptionPricingService,
)
from apps.users.membership.services.subscription_service import SubscriptionService
from apps.users.wallet.models import CashWalletTransaction, OrganizationCashWallet, OrganizationWallet
from apps.users.wallet.services.organization_cash_wallet_service import (
    OrganizationCashWalletService,
)


User = get_user_model()


def create_tier(*, tier_type, level, price, credits):
    return MembershipTier.objects.create(
        tier_type=tier_type,
        name=f"套餐-{tier_type}",
        description="",
        price=Decimal(price),
        duration_months=1,
        max_tables=10,
        max_documents=10,
        max_groups=10,
        max_records_per_table=100,
        included_storage_bytes=1024,
        included_llm_credits_monthly=Decimal(credits),
        max_members=5,
        features={},
        tier_level=level,
        is_active=True,
    )


@override_settings(
    MEMBERSHIP_UPGRADE_QUOTE_ENABLED=True,
    MEMBERSHIP_UPGRADE_PAYMENT_ENABLED=True,
    MEMBERSHIP_UPGRADE_WALLET_PAYMENT_ENABLED=True,
)
class SubscriptionUpgradePr4Tests(TestCase):
    databases = {"default"}

    def setUp(self):
        self.user = User.objects.create_user(
            username="subscription-pr4-user",
            email="subscription-pr4-user@tabtin.test",
            password="!",
        )
        self.organization = Organization.objects.create(
            name="subscription-pr4-org",
            owner=self.user,
            type=Organization.OrganizationType.TEAM,
        )
        self.current_tier = create_tier(
            tier_type="pr4-basic",
            level=10,
            price="69.00",
            credits="5000",
        )
        self.target_tier = create_tier(
            tier_type="pr4-pro",
            level=20,
            price="399.00",
            credits="30000",
        )
        now = timezone.now()
        self.membership = OrganizationMembership.objects.create(
            organization_id=str(self.organization.id),
            tier=self.current_tier,
            status="active",
            start_date=now - timedelta(days=10),
            end_date=now + timedelta(days=20),
            billing_cycle="monthly",
            current_actual_paid_period_price=Decimal("69.00"),
        )
        self.budget = OrganizationLlmMonthlyBudget.objects.create(
            organization=self.organization,
            cycle_month=now.date().replace(day=1),
            included_credits=Decimal("5000"),
            consumed_credits=Decimal("3000"),
            topup_credits=Decimal("200"),
        )
        self.pricing = SubscriptionPricingService()
        self.service = SubscriptionOrderService()

    def quote_token(self):
        quoted_at = timezone.now()
        quote = self.pricing.calculate_upgrade_quote(
            organization_id=str(self.organization.id),
            membership=self.membership,
            target_tier=self.target_tier,
            target_billing_cycle="monthly",
            quoted_at=quoted_at,
        )
        return self.pricing.create_quote_token(quote), quote

    def create_upgrade_order(self):
        token, quote = self.quote_token()
        data = self.service.create_upgrade_order(
            user=self.user,
            organization_id=str(self.organization.id),
            target_tier_id=str(self.target_tier.id),
            billing_cycle="monthly",
            quote_token=token,
        )
        return data, quote

    def pay_without_applying(self):
        data, quote = self.create_upgrade_order()
        OrganizationCashWalletService().recharge(
            organization_id=str(self.organization.id),
            amount_cny=quote.payable_amount + Decimal("50.00"),
            operator_user_id=str(self.user.id),
            related_order_id=f"cash-recharge-{data['order_id']}",
        )
        with patch.object(OrderBenefitService, "grant", return_value=data["order_id"]):
            self.service.wallet_pay_upgrade_order(
                user=self.user,
                organization_id=str(self.organization.id),
                order_id=data["order_id"],
            )
        return PaymentOrder.objects.get(id=data["order_id"]), quote

    def test_create_upgrade_order_freezes_wallet_membership_payment_order(self):
        data, quote = self.create_upgrade_order()
        order = PaymentOrder.objects.get(id=data["order_id"])
        change_log = OrganizationMembershipChangeLog.objects.get(payment_order_id=order.id)

        self.assertEqual(order.order_type, "membership")
        self.assertEqual(order.payment_method, "organization_wallet")
        self.assertEqual(order.status, "pending")
        self.assertEqual(order.benefit_status, "pending")
        self.assertEqual(order.amount, quote.payable_amount)
        self.assertEqual(order.business_data["change_type"], "upgrade")
        self.assertEqual(order.business_data["pricing_snapshot"]["payable_amount"], str(quote.payable_amount))
        self.assertEqual(change_log.status, OrganizationMembershipChangeLog.Status.PAYMENT_PENDING)
        self.assertEqual(change_log.payable_amount, quote.payable_amount)

    def test_duplicate_create_returns_same_active_order(self):
        token, _quote = self.quote_token()
        first = self.service.create_upgrade_order(
            user=self.user,
            organization_id=str(self.organization.id),
            target_tier_id=str(self.target_tier.id),
            billing_cycle="monthly",
            quote_token=token,
        )
        second = self.service.create_upgrade_order(
            user=self.user,
            organization_id=str(self.organization.id),
            target_tier_id=str(self.target_tier.id),
            billing_cycle="monthly",
            quote_token=token,
        )
        self.assertEqual(first["order_id"], second["order_id"])
        self.assertEqual(
            PaymentOrder.objects.filter(
                order_type="membership",
                payment_method="organization_wallet",
                business_data__change_type="upgrade",
            ).count(),
            1,
        )

    def test_balance_insufficient_keeps_order_pending_and_does_not_deduct(self):
        data, _quote = self.create_upgrade_order()

        with self.assertRaises(MembershipUpgradeBalanceError) as raised:
            self.service.wallet_pay_upgrade_order(
                user=self.user,
                organization_id=str(self.organization.id),
                order_id=data["order_id"],
            )

        order = PaymentOrder.objects.get(id=data["order_id"])
        self.assertEqual(order.status, "pending")
        self.assertEqual(CashWalletTransaction.objects.count(), 0)
        self.assertEqual(raised.exception.error_code, "ORGANIZATION_BALANCE_INSUFFICIENT")
        self.assertEqual(raised.exception.data["shortage_amount"], data["wallet"]["shortage_amount"])

    def test_wallet_balance_shortage_is_calculated_from_server_amount(self):
        data, quote = self.create_upgrade_order()
        OrganizationCashWalletService().recharge(
            organization_id=str(self.organization.id),
            amount_cny=quote.payable_amount - Decimal("1.23"),
            operator_user_id=str(self.user.id),
            related_order_id="cash-recharge-shortage",
        )
        with self.assertRaises(MembershipUpgradeBalanceError) as raised:
            self.service.wallet_pay_upgrade_order(
                user=self.user,
                organization_id=str(self.organization.id),
                order_id=data["order_id"],
            )
        self.assertEqual(raised.exception.data["shortage_amount"], "1.23")

    def test_wallet_pay_deducts_cash_and_applies_upgrade(self):
        data, quote = self.create_upgrade_order()
        original_start = self.membership.start_date
        original_end = self.membership.end_date
        OrganizationCashWalletService().recharge(
            organization_id=str(self.organization.id),
            amount_cny=quote.payable_amount,
            operator_user_id=str(self.user.id),
            related_order_id="cash-recharge-pr4",
        )

        paid = self.service.wallet_pay_upgrade_order(
            user=self.user,
            organization_id=str(self.organization.id),
            order_id=data["order_id"],
        )

        order = PaymentOrder.objects.get(id=data["order_id"])
        self.membership.refresh_from_db()
        self.budget.refresh_from_db()
        wallet = OrganizationCashWallet.objects.get(organization_id=str(self.organization.id))

        self.assertEqual(paid["payment_status"], "completed")
        self.assertEqual(order.benefit_status, "completed")
        self.assertEqual(self.membership.tier_id, self.target_tier.id)
        self.assertEqual(self.membership.start_date, original_start)
        self.assertEqual(self.membership.end_date, original_end)
        self.assertEqual(self.membership.current_actual_paid_period_price, Decimal("399.00"))
        self.assertEqual(self.budget.included_credits, Decimal("30000"))
        self.assertEqual(self.budget.consumed_credits, Decimal("3000"))
        self.assertEqual(self.budget.topup_credits, Decimal("200"))
        self.assertEqual(self.membership.lifecycle_version, 2)
        self.assertEqual(self.membership.related_order_id, str(order.id))
        self.assertEqual(wallet.balance_cny, Decimal("0.00"))
        self.assertTrue(
            CashWalletTransaction.objects.filter(
                transaction_type="membership_upgrade_payment",
                related_order_id=str(order.id),
                amount_cny=-quote.payable_amount,
            ).exists()
        )

    def test_repeated_wallet_pay_does_not_deduct_twice_or_increment_ai_budget(self):
        data, quote = self.create_upgrade_order()
        OrganizationCashWalletService().recharge(
            organization_id=str(self.organization.id),
            amount_cny=quote.payable_amount + Decimal("10.00"),
            operator_user_id=str(self.user.id),
            related_order_id="cash-recharge-pr4-repeat",
        )

        self.service.wallet_pay_upgrade_order(
            user=self.user,
            organization_id=str(self.organization.id),
            order_id=data["order_id"],
        )
        self.service.wallet_pay_upgrade_order(
            user=self.user,
            organization_id=str(self.organization.id),
            order_id=data["order_id"],
        )

        self.budget.refresh_from_db()
        wallet = OrganizationCashWallet.objects.get(organization_id=str(self.organization.id))
        self.assertEqual(
            CashWalletTransaction.objects.filter(
                transaction_type="membership_upgrade_payment",
                related_order_id=data["order_id"],
            ).count(),
            1,
        )
        self.assertEqual(wallet.balance_cny, Decimal("10.00"))
        self.assertEqual(self.budget.included_credits, Decimal("30000"))

    def test_apply_paid_upgrade_requires_paid_order(self):
        data, _quote = self.create_upgrade_order()
        with self.assertRaises(MembershipLifecycleError) as raised:
            SubscriptionService().apply_paid_upgrade(data["order_id"])
        self.assertEqual(raised.exception.error_code, "MEMBERSHIP_UPGRADE_ORDER_NOT_PAID")

    def test_apply_paid_upgrade_is_idempotent_after_completed(self):
        data, quote = self.create_upgrade_order()
        OrganizationCashWalletService().recharge(
            organization_id=str(self.organization.id),
            amount_cny=quote.payable_amount,
            operator_user_id=str(self.user.id),
            related_order_id="cash-recharge-idempotent-apply",
        )
        self.service.wallet_pay_upgrade_order(
            user=self.user,
            organization_id=str(self.organization.id),
            order_id=data["order_id"],
        )
        self.membership.refresh_from_db()
        version = self.membership.lifecycle_version
        SubscriptionService().apply_paid_upgrade(data["order_id"])
        self.membership.refresh_from_db()
        self.assertEqual(self.membership.lifecycle_version, version)
        self.assertEqual(self.membership.tier_id, self.target_tier.id)

    def test_paid_upgrade_uses_frozen_target_price_not_current_tier_price(self):
        order, _quote = self.pay_without_applying()
        self.target_tier.price = Decimal("9999.00")
        self.target_tier.save(update_fields=["price", "updated_at"])
        OrderBenefitService.grant(order.id)
        self.membership.refresh_from_db()
        self.assertEqual(self.membership.current_actual_paid_period_price, Decimal("399.00"))

    def test_ai_budget_sets_target_included_and_preserves_usage(self):
        data, quote = self.create_upgrade_order()
        self.budget.included_credits = Decimal("5000")
        self.budget.consumed_credits = Decimal("3000")
        self.budget.topup_credits = Decimal("1000")
        self.budget.save(update_fields=["included_credits", "consumed_credits", "topup_credits", "updated_at"])
        OrganizationCashWalletService().recharge(
            organization_id=str(self.organization.id),
            amount_cny=quote.payable_amount,
            operator_user_id=str(self.user.id),
            related_order_id="cash-recharge-ai-budget",
        )
        self.service.wallet_pay_upgrade_order(
            user=self.user,
            organization_id=str(self.organization.id),
            order_id=data["order_id"],
        )
        self.budget.refresh_from_db()
        self.assertEqual(self.budget.included_credits, Decimal("30000"))
        self.assertEqual(self.budget.consumed_credits, Decimal("3000"))
        self.assertEqual(self.budget.topup_credits, Decimal("1000"))
        remaining = self.budget.included_credits + self.budget.topup_credits - self.budget.consumed_credits
        self.assertEqual(remaining, Decimal("28000"))

    def test_ai_budget_missing_creates_single_current_month_record(self):
        self.budget.delete()
        data, quote = self.create_upgrade_order()
        OrganizationCashWalletService().recharge(
            organization_id=str(self.organization.id),
            amount_cny=quote.payable_amount,
            operator_user_id=str(self.user.id),
            related_order_id="cash-recharge-ai-budget-create",
        )
        self.service.wallet_pay_upgrade_order(
            user=self.user,
            organization_id=str(self.organization.id),
            order_id=data["order_id"],
        )
        month = timezone.now().date().replace(day=1)
        budgets = OrganizationLlmMonthlyBudget.objects.filter(
            organization=self.organization,
            cycle_month=month,
        )
        self.assertEqual(budgets.count(), 1)
        self.assertEqual(budgets.first().included_credits, Decimal("30000"))

    def test_billing_usage_events_are_not_modified(self):
        usage = BillingUsageEvent.objects.create(
            organization=self.organization,
            user_id=str(self.user.id),
            meter_key="llm.tokens",
            quantity=Decimal("1"),
            unit_price=Decimal("1"),
            amount=Decimal("1"),
            idempotency_key="pr4-usage-event",
        )
        data, quote = self.create_upgrade_order()
        OrganizationCashWalletService().recharge(
            organization_id=str(self.organization.id),
            amount_cny=quote.payable_amount,
            operator_user_id=str(self.user.id),
            related_order_id="cash-recharge-usage-unchanged",
        )
        self.service.wallet_pay_upgrade_order(
            user=self.user,
            organization_id=str(self.organization.id),
            order_id=data["order_id"],
        )
        usage.refresh_from_db()
        self.assertEqual(usage.amount, Decimal("1.00000000"))

    def test_organization_credits_wallet_is_not_used_for_cash_payment(self):
        data, _quote = self.create_upgrade_order()
        credits_wallet, _ = OrganizationWallet.objects.get_or_create(organization=self.organization)
        credits_wallet.credits_precise = Decimal("999999.0000")
        credits_wallet.save(update_fields=["credits", "credits_precise", "updated_at"])
        with self.assertRaises(MembershipUpgradeBalanceError):
            self.service.wallet_pay_upgrade_order(
                user=self.user,
                organization_id=str(self.organization.id),
                order_id=data["order_id"],
            )
        credits_wallet.refresh_from_db()
        self.assertEqual(credits_wallet.credits_precise, Decimal("999999.0000"))

    def test_lifecycle_change_before_wallet_pay_does_not_deduct(self):
        data, quote = self.create_upgrade_order()
        OrganizationCashWalletService().recharge(
            organization_id=str(self.organization.id),
            amount_cny=quote.payable_amount,
            operator_user_id=str(self.user.id),
            related_order_id="cash-recharge-state-before-pay",
        )
        self.membership.bump_lifecycle_version()
        with self.assertRaises(MembershipLifecycleError) as raised:
            self.service.wallet_pay_upgrade_order(
                user=self.user,
                organization_id=str(self.organization.id),
                order_id=data["order_id"],
            )
        self.assertEqual(raised.exception.error_code, "MEMBERSHIP_STATE_CHANGED")
        self.assertFalse(CashWalletTransaction.objects.filter(transaction_type="membership_upgrade_payment").exists())

    def test_cancelled_and_expired_orders_cannot_pay(self):
        for status in ("cancelled", "expired"):
            data, quote = self.create_upgrade_order()
            PaymentOrder.objects.filter(id=data["order_id"]).update(status=status)
            OrganizationCashWalletService().recharge(
                organization_id=str(self.organization.id),
                amount_cny=quote.payable_amount,
                operator_user_id=str(self.user.id),
                related_order_id=f"cash-recharge-{status}",
            )
            with self.assertRaises(MembershipLifecycleError):
                self.service.wallet_pay_upgrade_order(
                    user=self.user,
                    organization_id=str(self.organization.id),
                    order_id=data["order_id"],
                )
            PaymentOrder.objects.filter(id=data["order_id"]).update(status="cancelled")

    def test_target_tier_unavailable_fails_create(self):
        token, _quote = self.quote_token()
        self.target_tier.is_active = False
        self.target_tier.save(update_fields=["is_active", "updated_at"])
        with self.assertRaises(MembershipLifecycleError) as raised:
            self.service.create_upgrade_order(
                user=self.user,
                organization_id=str(self.organization.id),
                target_tier_id=str(self.target_tier.id),
                billing_cycle="monthly",
                quote_token=token,
            )
        self.assertEqual(raised.exception.error_code, "TARGET_TIER_NOT_AVAILABLE")

    def test_tampered_quote_fails(self):
        token, _quote = self.quote_token()
        with self.assertRaises(Exception):
            self.service.create_upgrade_order(
                user=self.user,
                organization_id=str(self.organization.id),
                target_tier_id=str(self.target_tier.id),
                billing_cycle="monthly",
                quote_token=token + "x",
            )

    def test_expired_quote_payload_fails(self):
        quoted_at = timezone.now() - timedelta(hours=1)
        quote = self.pricing.calculate_upgrade_quote(
            organization_id=str(self.organization.id),
            membership=self.membership,
            target_tier=self.target_tier,
            target_billing_cycle="monthly",
            quoted_at=quoted_at,
        )
        token = self.pricing.create_quote_token(quote)
        with self.assertRaises(Exception):
            self.service.create_upgrade_order(
                user=self.user,
                organization_id=str(self.organization.id),
                target_tier_id=str(self.target_tier.id),
                billing_cycle="monthly",
                quote_token=token,
            )

    def test_organization_mismatch_quote_fails(self):
        other = Organization.objects.create(name="other", owner=self.user, type=Organization.OrganizationType.TEAM)
        with self.assertRaises(Exception):
            token, _quote = self.quote_token()
            self.service.create_upgrade_order(
                user=self.user,
                organization_id=str(other.id),
                target_tier_id=str(self.target_tier.id),
                billing_cycle="monthly",
                quote_token=token,
            )

    def test_zero_amount_upgrade_creates_order_and_does_not_deduct_wallet(self):
        cheap_target = create_tier(tier_type="pr4-cheap-high", level=30, price="1.00", credits="35000")
        token_quote = self.pricing.calculate_upgrade_quote(
            organization_id=str(self.organization.id),
            membership=self.membership,
            target_tier=cheap_target,
            target_billing_cycle="monthly",
            quoted_at=timezone.now(),
        )
        data = self.service.create_upgrade_order(
            user=self.user,
            organization_id=str(self.organization.id),
            target_tier_id=str(cheap_target.id),
            billing_cycle="monthly",
            quote_token=self.pricing.create_quote_token(token_quote),
        )
        order = PaymentOrder.objects.get(id=data["order_id"])
        self.membership.refresh_from_db()
        self.assertEqual(order.amount, Decimal("0.00"))
        self.assertEqual(order.status, "completed")
        self.assertEqual(self.membership.tier_id, cheap_target.id)
        self.assertFalse(CashWalletTransaction.objects.filter(transaction_type="membership_upgrade_payment").exists())

    def test_entitlement_failure_marks_paid_order_benefit_failed(self):
        order, quote = self.pay_without_applying()
        with patch(
            "apps.users.membership.services.subscription_service.OrganizationEntitlementSyncService.sync_organization_entitlement",
            side_effect=RuntimeError("entitlement boom"),
        ):
            with self.assertRaises(RuntimeError):
                OrderBenefitService.grant(order.id)
        order.refresh_from_db()
        self.membership.refresh_from_db()
        self.assertEqual(order.status, "paid")
        self.assertEqual(order.benefit_status, "failed")
        self.assertTrue(order.failure_code)
        self.assertEqual(self.membership.tier_id, self.current_tier.id)
        self.assertEqual(
            CashWalletTransaction.objects.filter(
                transaction_type="membership_upgrade_payment",
                related_order_id=order.id,
                amount_cny=-quote.payable_amount,
            ).count(),
            1,
        )

    def test_ai_budget_failure_marks_paid_order_benefit_failed(self):
        order, _quote = self.pay_without_applying()
        with patch(
            "apps.users.membership.services.subscription_service.OrganizationLlmBudgetService.get_or_create_monthly_budget_locked",
            side_effect=RuntimeError("budget boom"),
        ):
            with self.assertRaises(RuntimeError):
                OrderBenefitService.grant(order.id)
        order.refresh_from_db()
        change_log = OrganizationMembershipChangeLog.objects.get(payment_order_id=order.id)
        self.assertEqual(order.status, "paid")
        self.assertEqual(order.benefit_status, "failed")
        self.assertEqual(change_log.status, OrganizationMembershipChangeLog.Status.FAILED)

    def test_compensation_retry_after_failed_benefit_succeeds_without_second_deduct(self):
        order, _quote = self.pay_without_applying()
        with patch(
            "apps.users.membership.services.subscription_service.OrganizationEntitlementSyncService.sync_organization_entitlement",
            side_effect=RuntimeError("first failure"),
        ):
            with self.assertRaises(RuntimeError):
                OrderBenefitService.grant(order.id)
        OrderBenefitService.grant(order.id)
        order.refresh_from_db()
        self.membership.refresh_from_db()
        self.budget.refresh_from_db()
        self.assertEqual(order.status, "completed")
        self.assertEqual(order.benefit_status, "completed")
        self.assertEqual(self.membership.tier_id, self.target_tier.id)
        self.assertEqual(self.membership.lifecycle_version, 2)
        self.assertEqual(self.budget.included_credits, Decimal("30000"))
        self.assertEqual(
            CashWalletTransaction.objects.filter(
                transaction_type="membership_upgrade_payment",
                related_order_id=order.id,
            ).count(),
            1,
        )

    def test_membership_changed_after_payment_marks_failed_without_overwrite(self):
        order, _quote = self.pay_without_applying()
        other_tier = create_tier(tier_type="pr4-other", level=40, price="888.00", credits="88888")
        self.membership.tier = other_tier
        self.membership.lifecycle_version = 99
        self.membership.save(update_fields=["tier", "lifecycle_version", "updated_at"])
        OrderBenefitService.grant(order.id)
        order.refresh_from_db()
        self.membership.refresh_from_db()
        self.assertEqual(order.status, "paid")
        self.assertEqual(order.benefit_status, "failed")
        self.assertEqual(order.failure_code, "MEMBERSHIP_STATE_CHANGED_AFTER_PAYMENT")
        self.assertEqual(self.membership.tier_id, other_tier.id)

    def test_get_active_upgrade_order_returns_pending_and_excludes_completed(self):
        data, quote = self.create_upgrade_order()
        active = self.service.get_active_upgrade_order(organization_id=str(self.organization.id))
        self.assertEqual(active["order_id"], data["order_id"])
        OrganizationCashWalletService().recharge(
            organization_id=str(self.organization.id),
            amount_cny=quote.payable_amount,
            operator_user_id=str(self.user.id),
            related_order_id="cash-recharge-active",
        )
        self.service.wallet_pay_upgrade_order(
            user=self.user,
            organization_id=str(self.organization.id),
            order_id=data["order_id"],
        )
        self.assertIsNone(self.service.get_active_upgrade_order(organization_id=str(self.organization.id)))

    def test_get_active_upgrade_order_restores_started_alipay_qr(self):
        data, _quote = self.create_upgrade_order()
        order = PaymentOrder.objects.get(id=data["order_id"])
        payment_data = {
            "order_id": str(order.id),
            "order_no": order.order_no,
            "payment_method": "alipay",
            "pay_url": "https://pay.test/alipay",
        }
        order.payment_method = "alipay"
        order.status = "paying"
        order.business_data = {
            **order.business_data,
            "third_party_payment": payment_data,
        }
        order.save(update_fields=["payment_method", "status", "business_data", "updated_at"])

        active = self.service.get_active_upgrade_order(
            organization_id=str(self.organization.id)
        )

        self.assertEqual(active["payment_status"], "paying")
        self.assertEqual(active["payment_data"], payment_data)
        self.assertTrue(active["allowed_actions"]["pay_with_alipay"])
        self.assertFalse(active["allowed_actions"]["pay_with_wechat"])
        self.assertFalse(active["allowed_actions"]["pay_with_wallet"])

    def test_switching_upgrade_payment_rebinds_change_log_to_replacement_order(self):
        data, _quote = self.create_upgrade_order()
        order = PaymentOrder.objects.get(id=data["order_id"])
        order.payment_method = "alipay"
        order.status = "paying"
        order.business_data = {
            **order.business_data,
            "third_party_payment": {
                "order_id": str(order.id),
                "order_no": order.order_no,
                "payment_method": "alipay",
                "qr_code": "alipay-qr",
            },
        }
        order.save(update_fields=["payment_method", "status", "business_data", "updated_at"])
        payment_service = MagicMock()
        payment_service.query_order.return_value = {}
        payment_service.close_unpaid_order.return_value = True

        with patch(
            "apps.services.payment.services.factory.PaymentServiceFactory.get_service",
            return_value=payment_service,
        ):
            replacement = MembershipPaymentService().switch_third_party_method(
                organization_id=str(self.organization.id),
                order_id=str(order.id),
                target_method="wechat",
            )

        change_log = OrganizationMembershipChangeLog.objects.get(
            id=order.business_data["change_log_id"]
        )
        self.assertEqual(change_log.payment_order_id, str(replacement.id))
        self.assertEqual(change_log.status, OrganizationMembershipChangeLog.Status.PAYMENT_PENDING)
        self.assertEqual(change_log.metadata["payment_source"]["method"], "wechat")
        self.assertEqual(
            change_log.metadata["payment_attempts"][-1]["order_id"],
            str(order.id),
        )

    def test_switch_retry_rejects_upgrade_when_change_log_is_no_longer_pending(self):
        data, _quote = self.create_upgrade_order()
        order = PaymentOrder.objects.get(id=data["order_id"])
        order.payment_method = "alipay"
        order.status = "paying"
        order.save(update_fields=["payment_method", "status", "updated_at"])
        payment_service = MagicMock()
        payment_service.query_order.return_value = {}
        payment_service.close_unpaid_order.return_value = True

        with patch(
            "apps.services.payment.services.factory.PaymentServiceFactory.get_service",
            return_value=payment_service,
        ):
            replacement = MembershipPaymentService().switch_third_party_method(
                organization_id=str(self.organization.id),
                order_id=str(order.id),
                target_method="wechat",
            )

        change_log = OrganizationMembershipChangeLog.objects.get(
            id=order.business_data["change_log_id"]
        )
        change_log.status = OrganizationMembershipChangeLog.Status.CANCELLED
        change_log.save(update_fields=["status", "updated_at"])

        with self.assertRaises(MembershipPaymentError) as raised:
            MembershipPaymentService().switch_third_party_method(
                organization_id=str(self.organization.id),
                order_id=str(order.id),
                target_method="wechat",
            )

        self.assertEqual(raised.exception.code, "MEMBERSHIP_CHANGE_LOG_INVALID")
        self.assertEqual(str(change_log.payment_order_id), str(replacement.id))

    def test_expiry_task_cancels_third_party_upgrade_change_log(self):
        data, _quote = self.create_upgrade_order()
        order = PaymentOrder.objects.get(id=data["order_id"])
        order.payment_method = "alipay"
        order.status = "paying"
        order.expired_at = timezone.now() - timedelta(seconds=1)
        order.save(update_fields=[
            "payment_method",
            "status",
            "expired_at",
            "updated_at",
        ])
        payment_service = MagicMock()

        with patch(
            "apps.services.payment.tasks._try_acquire_lock",
            return_value=True,
        ), patch(
            "apps.services.payment.tasks._release_lock",
        ), patch(
            "apps.services.payment.tasks._sync_order_with_provider",
            side_effect=lambda current: current,
        ), patch(
            "apps.services.payment.tasks.PaymentServiceFactory.get_service",
            return_value=payment_service,
        ):
            from apps.services.payment.tasks import check_pending_orders

            check_pending_orders()

        order.refresh_from_db()
        change_log = OrganizationMembershipChangeLog.objects.get(
            id=order.business_data["change_log_id"]
        )
        self.assertEqual(order.status, "expired")
        self.assertEqual(
            change_log.status,
            OrganizationMembershipChangeLog.Status.CANCELLED,
        )
        payment_service.close_unpaid_order.assert_called_once_with(order.order_no)

    def test_expiry_task_keeps_order_when_third_party_close_fails(self):
        data, _quote = self.create_upgrade_order()
        order = PaymentOrder.objects.get(id=data["order_id"])
        order.payment_method = "wechat"
        order.status = "paying"
        order.expired_at = timezone.now() - timedelta(seconds=1)
        order.save(update_fields=[
            "payment_method",
            "status",
            "expired_at",
            "updated_at",
        ])
        payment_service = MagicMock()
        payment_service.close_unpaid_order.return_value = False

        with patch(
            "apps.services.payment.tasks._try_acquire_lock",
            return_value=True,
        ), patch(
            "apps.services.payment.tasks._release_lock",
        ), patch(
            "apps.services.payment.tasks._sync_order_with_provider",
            side_effect=lambda current: current,
        ), patch(
            "apps.services.payment.tasks.PaymentServiceFactory.get_service",
            return_value=payment_service,
        ):
            from apps.services.payment.tasks import check_pending_orders

            check_pending_orders()

        order.refresh_from_db()
        change_log = OrganizationMembershipChangeLog.objects.get(
            id=order.business_data["change_log_id"]
        )
        self.assertEqual(order.status, "paying")
        self.assertEqual(
            change_log.status,
            OrganizationMembershipChangeLog.Status.PAYMENT_PENDING,
        )

    def test_get_upgrade_order_allowed_actions_reflect_wallet_sufficiency(self):
        data, quote = self.create_upgrade_order()
        pending = self.service.get_upgrade_order(
            organization_id=str(self.organization.id),
            order_id=data["order_id"],
        )
        self.assertFalse(pending["allowed_actions"]["pay_with_wallet"])
        OrganizationCashWalletService().recharge(
            organization_id=str(self.organization.id),
            amount_cny=quote.payable_amount,
            operator_user_id=str(self.user.id),
            related_order_id="cash-recharge-actions",
        )
        enough = self.service.get_upgrade_order(
            organization_id=str(self.organization.id),
            order_id=data["order_id"],
        )
        self.assertTrue(enough["allowed_actions"]["pay_with_wallet"])

    def test_recharge_order_is_decoupled_from_upgrade_order(self):
        data, quote = self.create_upgrade_order()
        OrganizationCashWalletService().recharge(
            organization_id=str(self.organization.id),
            amount_cny=quote.payable_amount + Decimal("12.34"),
            operator_user_id=str(self.user.id),
            related_order_id="cash-wallet-recharge-order",
        )
        order = PaymentOrder.objects.get(id=data["order_id"])
        self.membership.refresh_from_db()
        wallet = OrganizationCashWallet.objects.get(organization_id=str(self.organization.id))
        self.assertEqual(order.status, "pending")
        self.assertEqual(self.membership.tier_id, self.current_tier.id)
        self.assertEqual(wallet.balance_cny, quote.payable_amount + Decimal("12.34"))

    @override_settings(MEMBERSHIP_UPGRADE_PAYMENT_ENABLED=False)
    def test_payment_flag_blocks_create_order(self):
        token, _quote = self.quote_token()
        with self.assertRaises(MembershipLifecycleError) as raised:
            self.service.create_upgrade_order(
                user=self.user,
                organization_id=str(self.organization.id),
                target_tier_id=str(self.target_tier.id),
                billing_cycle="monthly",
                quote_token=token,
            )
        self.assertEqual(raised.exception.error_code, "MEMBERSHIP_UPGRADE_PAYMENT_DISABLED")


@override_settings(
    MEMBERSHIP_UPGRADE_QUOTE_ENABLED=True,
    MEMBERSHIP_UPGRADE_PAYMENT_ENABLED=True,
    MEMBERSHIP_UPGRADE_WALLET_PAYMENT_ENABLED=True,
)
class SubscriptionUpgradeConcurrentPr4Tests(TransactionTestCase):
    databases = {"default"}
    reset_sequences = True

    def setUp(self):
        self.user = User.objects.create_user(
            username="subscription-pr4-concurrent",
            email="subscription-pr4-concurrent@tabtin.test",
            password="!",
        )
        self.organization = Organization.objects.create(
            name="subscription-pr4-concurrent-org",
            owner=self.user,
            type=Organization.OrganizationType.TEAM,
        )
        self.current_tier = create_tier(tier_type="pr4-con-basic", level=10, price="69.00", credits="5000")
        self.target_tier = create_tier(tier_type="pr4-con-pro", level=20, price="399.00", credits="30000")
        now = timezone.now()
        self.membership = OrganizationMembership.objects.create(
            organization_id=str(self.organization.id),
            tier=self.current_tier,
            status="active",
            start_date=now - timedelta(days=10),
            end_date=now + timedelta(days=20),
            billing_cycle="monthly",
            current_actual_paid_period_price=Decimal("69.00"),
        )
        OrganizationLlmMonthlyBudget.objects.create(
            organization=self.organization,
            cycle_month=now.date().replace(day=1),
            included_credits=Decimal("5000"),
            consumed_credits=Decimal("3000"),
        )
        pricing = SubscriptionPricingService()
        quote = pricing.calculate_upgrade_quote(
            organization_id=str(self.organization.id),
            membership=self.membership,
            target_tier=self.target_tier,
            target_billing_cycle="monthly",
            quoted_at=timezone.now(),
        )
        self.order_data = SubscriptionOrderService().create_upgrade_order(
            user=self.user,
            organization_id=str(self.organization.id),
            target_tier_id=str(self.target_tier.id),
            billing_cycle="monthly",
            quote_token=pricing.create_quote_token(quote),
        )
        self.quote = quote
        OrganizationCashWalletService().recharge(
            organization_id=str(self.organization.id),
            amount_cny=quote.payable_amount,
            operator_user_id=str(self.user.id),
            related_order_id="cash-recharge-concurrent",
        )

    def test_concurrent_wallet_pay_deducts_only_once(self):
        barrier = threading.Barrier(2)
        results = []
        errors = []

        def worker():
            connection.close()
            try:
                barrier.wait(timeout=10)
                result = SubscriptionOrderService().wallet_pay_upgrade_order(
                    user=self.user,
                    organization_id=str(self.organization.id),
                    order_id=self.order_data["order_id"],
                )
                results.append(result["payment_status"])
            except Exception as exc:
                errors.append(type(exc).__name__)
            finally:
                connection.close()

        threads = [threading.Thread(target=worker), threading.Thread(target=worker)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=30)

        order = PaymentOrder.objects.get(id=self.order_data["order_id"])
        wallet = OrganizationCashWallet.objects.get(organization_id=str(self.organization.id))
        self.assertFalse(errors)
        self.assertEqual(len(results), 2)
        self.assertIn(order.status, {"paid", "completed"})
        self.assertEqual(wallet.balance_cny, Decimal("0.00"))
        self.assertEqual(
            CashWalletTransaction.objects.filter(
                transaction_type="membership_upgrade_payment",
                related_order_id=order.id,
            ).count(),
            1,
        )
