from datetime import timedelta
from decimal import Decimal

from django.contrib.auth import get_user_model
from django.test import TestCase, TransactionTestCase, override_settings
from django.db import connection, transaction
from django.core import signing
from threading import Barrier, Thread
from django.utils import timezone

from apps.services.billing.models import OrganizationLlmMonthlyBudget
from apps.services.payment.models import PaymentOrder
from apps.services.payment.services.benefit_service import OrderBenefitService
from apps.tabtinspace.models import Organization
from apps.users.membership.models import (
    MembershipTier,
    OrganizationMembership,
    OrganizationMembershipChangeLog,
)
from apps.users.membership.services.subscription_lifecycle_service import (
    SubscriptionLifecycleService,
)
from apps.users.wallet.models import CashWalletTransaction
from apps.users.wallet.services.organization_cash_wallet_service import (
    OrganizationCashWalletService,
)
from apps.users.membership.exceptions import MembershipLifecycleError
from apps.users.membership.services.subscription_lifecycle_service import (
    LIFECYCLE_QUOTE_SALT,
)


User = get_user_model()


def create_pr5_tier(*, tier_type: str, level: int, price: str, credits: str) -> MembershipTier:
    return MembershipTier.objects.create(
        tier_type=tier_type,
        name=f"PR5-{tier_type}",
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
        sort_order=level,
        tier_level=level,
        is_active=True,
    )


@override_settings(
    MEMBERSHIP_DOWNGRADE_ENABLED=True,
    MEMBERSHIP_SWITCH_ENABLED=True,
    MEMBERSHIP_MANUAL_RENEWAL_ENABLED=True,
    MEMBERSHIP_GRACE_PERIOD_ENABLED=True,
    MEMBERSHIP_GRACE_PERIOD_DAYS=7,
)
class SubscriptionLifecyclePr5Tests(TestCase):
    databases = {"default"}

    def setUp(self):
        self.user = User.objects.create_user(
            username="subscription-pr5-user",
            email="subscription-pr5-user@tabtin.test",
            password="!",
        )
        self.organization = Organization.objects.create(
            name="subscription-pr5-org",
            owner=self.user,
            type=Organization.OrganizationType.TEAM,
        )
        self.free_tier = create_pr5_tier(
            tier_type="pr5-free",
            level=0,
            price="0.00",
            credits="0",
        )
        self.team_tier = create_pr5_tier(
            tier_type="pr5-team",
            level=10,
            price="99.00",
            credits="6000",
        )
        self.enterprise_tier = create_pr5_tier(
            tier_type="pr5-enterprise",
            level=20,
            price="399.00",
            credits="30000",
        )
        self.enterprise_peer_tier = create_pr5_tier(
            tier_type="pr5-enterprise-2",
            level=20,
            price="399.00",
            credits="30000",
        )
        now = timezone.now()
        self.membership = OrganizationMembership.objects.create(
            organization_id=str(self.organization.id),
            tier=self.enterprise_tier,
            status="active",
            start_date=now - timedelta(days=10),
            end_date=now + timedelta(days=20),
            billing_cycle="monthly",
            current_actual_paid_period_price=Decimal("399.00"),
        )
        OrganizationLlmMonthlyBudget.objects.create(
            organization=self.organization,
            cycle_month=now.date().replace(day=1),
            included_credits=Decimal("30000"),
            consumed_credits=Decimal("1234.5"),
            topup_credits=Decimal("50"),
        )
        self.service = SubscriptionLifecycleService()

    def test_schedule_downgrade_records_next_cycle_plan_without_changing_current_tier(self):
        preview = self.service.preview_downgrade(
            organization_id=str(self.organization.id),
            target_tier_id=str(self.team_tier.id),
            billing_cycle="monthly",
        )
        scheduled = self.service.schedule_downgrade(
            user=self.user,
            organization_id=str(self.organization.id),
            target_tier_id=str(self.team_tier.id),
            billing_cycle="monthly",
            quote_token=preview["quote_token"],
        )

        self.membership.refresh_from_db()
        self.assertEqual(self.membership.tier_id, self.enterprise_tier.id)
        self.assertEqual(self.membership.scheduled_tier_id, self.team_tier.id)
        self.assertEqual(self.membership.scheduled_change_type, "downgrade")
        self.assertEqual(scheduled["type"], "downgrade")
        log = OrganizationMembershipChangeLog.objects.get(id=self.membership.scheduled_change_log_id)
        self.assertEqual(log.status, OrganizationMembershipChangeLog.Status.SCHEDULED)
        self.assertEqual(log.payable_amount, Decimal("0.00"))

    def test_process_expiry_applies_scheduled_free_without_entering_grace(self):
        preview = self.service.preview_downgrade(
            organization_id=str(self.organization.id),
            target_tier_id=str(self.free_tier.id),
            billing_cycle="monthly",
        )
        self.service.schedule_downgrade(
            user=self.user,
            organization_id=str(self.organization.id),
            target_tier_id=str(self.free_tier.id),
            billing_cycle="monthly",
            quote_token=preview["quote_token"],
        )
        due_at = timezone.now() - timedelta(seconds=1)
        OrganizationMembership.objects.filter(id=self.membership.id).update(end_date=due_at)

        result = self.service.process_membership_expiry(
            membership_id=str(self.membership.id),
            now=timezone.now(),
        )

        self.membership.refresh_from_db()
        self.assertTrue(result["scheduled_change_applied"])
        self.assertEqual(self.membership.tier_id, self.free_tier.id)
        self.assertEqual(self.membership.status, "active")
        self.assertIsNone(self.membership.grace_period_end)
        self.assertIsNone(self.membership.scheduled_tier_id)

    def test_expired_active_membership_enters_grace_when_no_scheduled_free(self):
        due_at = timezone.now() - timedelta(seconds=1)
        OrganizationMembership.objects.filter(id=self.membership.id).update(end_date=due_at)

        result = self.service.process_membership_expiry(
            membership_id=str(self.membership.id),
            now=timezone.now(),
        )

        self.membership.refresh_from_db()
        self.assertEqual(result["state"], "grace")
        self.assertEqual(self.membership.status, "grace")
        self.assertIsNotNone(self.membership.grace_period_end)

    def test_wallet_paid_renewal_extends_period_and_keeps_consumed_credits(self):
        preview = self.service.preview_renewal(
            organization_id=str(self.organization.id),
            billing_cycle="monthly",
        )
        data = self.service.create_renewal_order(
            user=self.user,
            organization_id=str(self.organization.id),
            billing_cycle="monthly",
            quote_token=preview["quote_token"],
        )
        OrganizationCashWalletService().recharge(
            organization_id=str(self.organization.id),
            amount_cny=Decimal(data["payable_amount"]) + Decimal("1.00"),
            operator_user_id=str(self.user.id),
            related_order_id=f"pr5-renewal-recharge-{data['order_id']}",
        )

        paid = self.service.wallet_pay_membership_order(
            user=self.user,
            organization_id=str(self.organization.id),
            order_id=data["order_id"],
            change_type="renewal",
        )

        order = PaymentOrder.objects.get(id=data["order_id"])
        self.membership.refresh_from_db()
        budget = OrganizationLlmMonthlyBudget.objects.get(organization=self.organization)
        self.assertEqual(paid["payment_status"], "completed")
        self.assertEqual(order.benefit_status, "completed")
        self.assertEqual(self.membership.status, "active")
        self.assertEqual(self.membership.related_order_id, str(order.id))
        self.assertEqual(budget.included_credits, self.enterprise_tier.included_llm_credits_monthly)
        self.assertEqual(budget.consumed_credits, Decimal("1234.50000000"))
        self.assertEqual(
            CashWalletTransaction.objects.filter(transaction_type="membership_lifecycle_payment").count(),
            1,
        )

    def test_order_benefit_service_routes_paid_renewal_without_legacy_activation(self):
        preview = self.service.preview_renewal(
            organization_id=str(self.organization.id),
            billing_cycle="monthly",
        )
        data = self.service.create_renewal_order(
            user=self.user,
            organization_id=str(self.organization.id),
            billing_cycle="monthly",
            quote_token=preview["quote_token"],
        )
        order = PaymentOrder.objects.get(id=data["order_id"])
        order.status = "paid"
        order.paid_amount = order.amount
        order.paid_at = timezone.now()
        order.save(update_fields=["status", "paid_amount", "paid_at", "updated_at"])

        result = OrderBenefitService.grant(str(order.id))

        order.refresh_from_db()
        self.assertEqual(result, str(order.id))
        self.assertEqual(order.status, "completed")
        self.assertEqual(order.benefit_status, "completed")

    def test_switch_facade_rejects_stale_quote_if_lifecycle_version_changed(self):
        preview = self.service.preview_switch(
            organization_id=str(self.organization.id),
            target_tier_id=str(self.enterprise_peer_tier.id),
            billing_cycle="monthly",
        )
        self.membership.lifecycle_version = (self.membership.lifecycle_version or 0) + 1
        self.membership.save(update_fields=["lifecycle_version", "updated_at"])
        with self.assertRaises(MembershipLifecycleError) as raised:
            self.service.resolve_verified_switch_action(
                organization_id=str(self.organization.id),
                target_tier_id=str(self.enterprise_peer_tier.id),
                billing_cycle="monthly",
                quote_token=preview["quote_token"],
            )
        self.assertEqual(raised.exception.error_code, "MEMBERSHIP_STATE_CHANGED")

    def test_switch_facade_rejects_stale_quote_if_target_price_changed(self):
        target = create_pr5_tier(
            tier_type="pr5-switch-target",
            level=20,
            price="399.00",
            credits="6000",
        )
        preview = self.service.preview_switch(
            organization_id=str(self.organization.id),
            target_tier_id=str(target.id),
            billing_cycle="monthly",
        )
        target.price = Decimal("299.00")
        target.save(update_fields=["price", "updated_at"])
        with self.assertRaises(MembershipLifecycleError) as raised:
            self.service.resolve_verified_switch_action(
                organization_id=str(self.organization.id),
                target_tier_id=str(target.id),
                billing_cycle="monthly",
                quote_token=preview["quote_token"],
            )
        self.assertEqual(raised.exception.error_code, "QUOTE_INVALID")

    def test_switch_facade_rejects_stale_quote_if_current_period_end_changed(self):
        preview = self.service.preview_switch(
            organization_id=str(self.organization.id),
            target_tier_id=str(self.enterprise_peer_tier.id),
            billing_cycle="monthly",
        )
        self.membership.end_date = self.membership.end_date + timedelta(days=1)
        self.membership.save(update_fields=["end_date", "updated_at"])
        with self.assertRaises(MembershipLifecycleError) as raised:
            self.service.resolve_verified_switch_action(
                organization_id=str(self.organization.id),
                target_tier_id=str(self.enterprise_peer_tier.id),
                billing_cycle="monthly",
                quote_token=preview["quote_token"],
            )
        self.assertEqual(raised.exception.error_code, "MEMBERSHIP_STATE_CHANGED")

    def test_switch_facade_rejects_stale_quote_if_switch_mode_stale(self):
        target = create_pr5_tier(
            tier_type="pr5-switch-next-cycle",
            level=20,
            price="399.00",
            credits="25000",
        )
        preview = self.service.preview_switch(
            organization_id=str(self.organization.id),
            target_tier_id=str(target.id),
            billing_cycle="monthly",
        )
        payload = signing.loads(preview["quote_token"], salt=LIFECYCLE_QUOTE_SALT)
        payload["switch_mode"] = "next_cycle"
        stale_token = signing.dumps(payload, salt=LIFECYCLE_QUOTE_SALT)
        with self.assertRaises(MembershipLifecycleError) as raised:
            self.service.resolve_verified_switch_action(
                organization_id=str(self.organization.id),
                target_tier_id=str(target.id),
                billing_cycle="monthly",
                quote_token=stale_token,
            )
        self.assertEqual(raised.exception.error_code, "QUOTE_INVALID")

    def test_switch_facade_rejects_stale_quote_if_price_version_changed(self):
        preview = self.service.preview_switch(
            organization_id=str(self.organization.id),
            target_tier_id=str(self.enterprise_peer_tier.id),
            billing_cycle="monthly",
        )
        payload = signing.loads(preview["quote_token"], salt=LIFECYCLE_QUOTE_SALT)
        payload["schema_version"] = 99
        stale_token = signing.dumps(payload, salt=LIFECYCLE_QUOTE_SALT)
        with self.assertRaises(MembershipLifecycleError) as raised:
            self.service.resolve_verified_switch_action(
                organization_id=str(self.organization.id),
                target_tier_id=str(self.enterprise_peer_tier.id),
                billing_cycle="monthly",
                quote_token=stale_token,
            )
        self.assertEqual(raised.exception.error_code, "QUOTE_INVALID")

    def test_switch_facade_still_passes_if_sort_order_changes(self):
        self.enterprise_peer_tier.sort_order = 999
        self.enterprise_peer_tier.save(update_fields=["sort_order", "updated_at"])
        preview = self.service.preview_switch(
            organization_id=str(self.organization.id),
            target_tier_id=str(self.enterprise_peer_tier.id),
            billing_cycle="monthly",
        )
        result = self.service.resolve_verified_switch_action(
            organization_id=str(self.organization.id),
            target_tier_id=str(self.enterprise_peer_tier.id),
            billing_cycle="monthly",
            quote_token=preview["quote_token"],
        )
        self.assertEqual(result["payload"]["to_tier_id"], str(self.enterprise_peer_tier.id))


@override_settings(
    MEMBERSHIP_DOWNGRADE_ENABLED=True,
    MEMBERSHIP_SWITCH_ENABLED=True,
    MEMBERSHIP_MANUAL_RENEWAL_ENABLED=True,
    MEMBERSHIP_GRACE_PERIOD_ENABLED=True,
    MEMBERSHIP_GRACE_PERIOD_DAYS=7,
)
class SubscriptionLifecyclePr5ConcurrentPayTests(TransactionTestCase):
    databases = {"default"}
    reset_sequences = True

    def setUp(self):
        self.user = User.objects.create_user(
            username="subscription-pr5-concurrent-user",
            email="subscription-pr5-concurrent-user@tabtin.test",
            password="!",
        )
        self.organization = Organization.objects.create(
            name="subscription-pr5-concurrent-org",
            owner=self.user,
            type=Organization.OrganizationType.TEAM,
        )
        self.team_tier = create_pr5_tier(
            tier_type="pr5-con-team",
            level=10,
            price="199.00",
            credits="12000",
        )
        self.premium_tier = create_pr5_tier(
            tier_type="pr5-con-premium",
            level=10,
            price="499.00",
            credits="35000",
        )
        now = timezone.now()
        self.membership = OrganizationMembership.objects.create(
            organization_id=str(self.organization.id),
            tier=self.team_tier,
            status="active",
            start_date=now - timedelta(days=10),
            end_date=now + timedelta(days=20),
            billing_cycle="monthly",
            current_actual_paid_period_price=Decimal("199.00"),
        )
        OrganizationLlmMonthlyBudget.objects.create(
            organization=self.organization,
            cycle_month=now.date().replace(day=1),
            included_credits=Decimal("12000"),
            consumed_credits=Decimal("1000"),
        )
        self.service = SubscriptionLifecycleService()

    def _run_concurrent_pay(self, call, *args, **kwargs):
        barrier = Barrier(2)
        results = []
        errors = []

        def worker():
            connection.close()
            try:
                barrier.wait(timeout=10)
                data = call(*args, **kwargs)
                results.append(data["payment_status"])
            except Exception as exc:
                errors.append(type(exc).__name__)
            finally:
                connection.close()

        threads = [Thread(target=worker), Thread(target=worker)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=30)

        return results, errors

    def test_paid_switch_wallet_payment_deduplicates_benefit_and_deduction(self):
        preview = self.service.preview_switch(
            organization_id=str(self.organization.id),
            target_tier_id=str(self.premium_tier.id),
            billing_cycle="monthly",
        )
        order_data = self.service.create_switch_order(
            user=self.user,
            organization_id=str(self.organization.id),
            target_tier_id=str(self.premium_tier.id),
            billing_cycle="monthly",
            quote_token=preview["quote_token"],
        )
        OrganizationCashWalletService().recharge(
            organization_id=str(self.organization.id),
            amount_cny=Decimal(order_data["payable_amount"]),
            operator_user_id=str(self.user.id),
            related_order_id=f"pr5-switch-pay-{order_data['order_id']}",
        )

        results, errors = self._run_concurrent_pay(
            self.service.wallet_pay_membership_order,
            user=self.user,
            organization_id=str(self.organization.id),
            order_id=order_data["order_id"],
            change_type="switch",
        )

        order = PaymentOrder.objects.get(id=order_data["order_id"])
        self.membership.refresh_from_db()
        self.assertEqual(self.membership.tier_id, str(self.premium_tier.id))
        self.assertEqual(order.status, "completed")
        self.assertEqual(order.benefit_status, "completed")
        self.assertEqual(
            CashWalletTransaction.objects.filter(
                transaction_type="membership_lifecycle_payment",
                related_order_id=order.id,
            ).count(),
            1,
        )
        self.assertFalse(errors)
        self.assertEqual(len(results), 2)

    def test_paid_renewal_wallet_payment_deduplicates_benefit_and_deduction(self):
        with transaction.atomic():
            # 保证续费目标是原套餐，形成正常续费场景
            self.membership.current_actual_paid_period_price = Decimal("199.00")
            self.membership.save(update_fields=["current_actual_paid_period_price", "updated_at"])

        preview = self.service.preview_renewal(
            organization_id=str(self.organization.id),
            billing_cycle="monthly",
        )
        order_data = self.service.create_renewal_order(
            user=self.user,
            organization_id=str(self.organization.id),
            billing_cycle="monthly",
            quote_token=preview["quote_token"],
        )
        OrganizationCashWalletService().recharge(
            organization_id=str(self.organization.id),
            amount_cny=Decimal(order_data["payable_amount"]),
            operator_user_id=str(self.user.id),
            related_order_id=f"pr5-renewal-pay-{order_data['order_id']}",
        )

        results, errors = self._run_concurrent_pay(
            self.service.wallet_pay_membership_order,
            user=self.user,
            organization_id=str(self.organization.id),
            order_id=order_data["order_id"],
            change_type="renewal",
        )

        order = PaymentOrder.objects.get(id=order_data["order_id"])
        self.membership.refresh_from_db()
        self.assertEqual(order.status, "completed")
        self.assertEqual(order.benefit_status, "completed")
        self.assertEqual(
            CashWalletTransaction.objects.filter(
                transaction_type="membership_lifecycle_payment",
                related_order_id=order.id,
            ).count(),
            1,
        )
        self.assertFalse(errors)
        self.assertEqual(len(results), 2)
