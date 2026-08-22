from datetime import timedelta
from decimal import Decimal
from threading import Barrier, Thread
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.db import connection, transaction
from django.test import TransactionTestCase, override_settings
from django.utils import timezone

from apps.services.billing.models import OrganizationLlmMonthlyBudget
from apps.services.billing.services import OrganizationEntitlementSyncService
from apps.services.payment.models import PaymentOrder
from apps.tabtinspace.models import Organization
from apps.users.membership.models import MembershipTier, OrganizationMembership, OrganizationMembershipChangeLog
from apps.users.membership.services.subscription_lifecycle_service import SubscriptionLifecycleService
from apps.users.wallet.models import CashWalletTransaction
from apps.users.wallet.services.organization_cash_wallet_service import OrganizationCashWalletService


User = get_user_model()


def create_tier(*, tier_type: str, level: int, price: str, credits: str) -> MembershipTier:
    return MembershipTier.objects.create(
        tier_type=tier_type,
        name=f"PR5-Comp-{tier_type}",
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


def _refresh_membership(membership_id: str) -> OrganizationMembership:
    return OrganizationMembership.objects.get(id=membership_id)


@override_settings(
    MEMBERSHIP_DOWNGRADE_ENABLED=True,
    MEMBERSHIP_SWITCH_ENABLED=True,
    MEMBERSHIP_MANUAL_RENEWAL_ENABLED=True,
    MEMBERSHIP_GRACE_PERIOD_ENABLED=True,
    MEMBERSHIP_GRACE_PERIOD_DAYS=7,
    MEMBERSHIP_LIFECYCLE_TASKS_ENABLED=True,
)
class SubscriptionLifecycleCompensationPr5Tests(TransactionTestCase):
    databases = {"default"}
    reset_sequences = True

    def setUp(self):
        self.user = User.objects.create_user(
            username="subscription-pr5-comp-user",
            email="subscription-pr5-comp-user@tabtin.test",
            password="!",
        )
        self.organization = Organization.objects.create(
            name="subscription-pr5-comp-org",
            owner=self.user,
            type=Organization.OrganizationType.TEAM,
        )
        self.current_tier = create_tier(
            tier_type="pr5-comp-basic",
            level=10,
            price="199.00",
            credits="8000",
        )
        self.next_tier = create_tier(
            tier_type="pr5-comp-pro",
            level=20,
            price="399.00",
            credits="18000",
        )
        self.free_tier = create_tier(
            tier_type="pr5-comp-free",
            level=0,
            price="0.00",
            credits="0",
        )
        now = timezone.now()
        self.membership = OrganizationMembership.objects.create(
            organization_id=str(self.organization.id),
            tier=self.current_tier,
            status="active",
            start_date=now - timedelta(days=10),
            end_date=now + timedelta(days=20),
            billing_cycle="monthly",
            current_actual_paid_period_price=Decimal("199.00"),
        )
        self.budget = OrganizationLlmMonthlyBudget.objects.create(
            organization=self.organization,
            cycle_month=now.date().replace(day=1),
            included_credits=Decimal("8000"),
            consumed_credits=Decimal("100"),
        )
        self.service = SubscriptionLifecycleService()

    def _refresh_state(self):
        self.membership.refresh_from_db()
        self.budget.refresh_from_db()

    def test_renewal_compensation_failure_and_retry_does_not_double_recharge_budget(self):
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
        initial_end_date = self.membership.end_date
        OrganizationCashWalletService().recharge(
            organization_id=str(self.organization.id),
            amount_cny=Decimal(data["payable_amount"]),
            operator_user_id=str(self.user.id),
            related_order_id=f"pr5-comp-renewal-{data['order_id']}",
        )
        target_end = _refresh_membership(str(self.membership.id)).end_date
        original_budget = Decimal(self.budget.included_credits)

        with patch.object(OrganizationEntitlementSyncService, "sync_organization_entitlement", side_effect=RuntimeError("sync failed")):
            with self.assertRaises(RuntimeError):
                self.service.wallet_pay_membership_order(
                    user=self.user,
                    organization_id=str(self.organization.id),
                    order_id=data["order_id"],
                    change_type="renewal",
                )

        order = PaymentOrder.objects.get(id=data["order_id"])
        self._refresh_state()
        self.assertEqual(order.status, "paid")
        self.assertEqual(order.benefit_status, "failed")
        self.assertEqual(order.failure_code, "MEMBERSHIP_RENEWAL_APPLY_FAILED")
        self.assertEqual(self.membership.end_date, target_end)
        self.assertEqual(self.budget.included_credits, original_budget)
        self.assertEqual(
            OrganizationMembershipChangeLog.objects.get(id=order.business_data["change_log_id"]).status,
            OrganizationMembershipChangeLog.Status.FAILED,
        )
        self.assertEqual(
            CashWalletTransaction.objects.filter(
                transaction_type="membership_lifecycle_payment",
                related_order_id=order.id,
            ).count(),
            1,
        )

        with patch(
            "apps.users.membership.services.subscription_lifecycle_service.OrganizationEntitlementSyncService.sync_organization_entitlement",
            return_value=None,
        ):
            paid = self.service.wallet_pay_membership_order(
                user=self.user,
                organization_id=str(self.organization.id),
                order_id=data["order_id"],
                change_type="renewal",
            )
        order.refresh_from_db()
        self.membership.refresh_from_db()
        self.assertEqual(paid["payment_status"], "completed")
        self.assertEqual(order.benefit_status, "completed")
        self.assertEqual(order.status, "completed")
        self.assertGreater(self.membership.end_date, initial_end_date)
        self.assertEqual(self.budget.included_credits, self.membership.tier.included_llm_credits_monthly)
        self.assertEqual(self.membership.lifecycle_version, 2)
        self.assertEqual(
            CashWalletTransaction.objects.filter(
                transaction_type="membership_lifecycle_payment",
                related_order_id=order.id,
            ).count(),
            1,
        )

    def test_renewal_apply_retry_marks_no_duplicate_wallet_charge(self):
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
            amount_cny=Decimal(data["payable_amount"]),
            operator_user_id=str(self.user.id),
            related_order_id=f"pr5-comp-renewal-retry-{data['order_id']}",
        )
        with patch(
            "apps.users.membership.services.subscription_lifecycle_service.OrganizationEntitlementSyncService.sync_organization_entitlement",
            side_effect=RuntimeError("sync failed"),
        ):
            with self.assertRaises(RuntimeError):
                self.service.wallet_pay_membership_order(
                    user=self.user,
                    organization_id=str(self.organization.id),
                    order_id=data["order_id"],
                    change_type="renewal",
                )

        self.service.apply_paid_renewal(str(data["order_id"]))
        self.assertEqual(
            CashWalletTransaction.objects.filter(
                transaction_type="membership_lifecycle_payment",
                related_order_id=data["order_id"],
            ).count(),
            1,
        )

    def test_paid_switch_compensation_failure_and_retry(self):
        # switch is only valid for peer tiers; renewal tests retain the
        # higher-level target fixture below.
        self.next_tier.tier_level = self.current_tier.tier_level
        self.next_tier.save(update_fields=["tier_level", "updated_at"])
        self.next_tier.price = Decimal("499.00")
        self.next_tier.save(update_fields=["price", "updated_at"])
        preview = self.service.preview_switch(
            organization_id=str(self.organization.id),
            target_tier_id=str(self.next_tier.id),
            billing_cycle="monthly",
        )
        data = self.service.create_switch_order(
            user=self.user,
            organization_id=str(self.organization.id),
            target_tier_id=str(self.next_tier.id),
            billing_cycle="monthly",
            quote_token=preview["quote_token"],
        )
        OrganizationCashWalletService().recharge(
            organization_id=str(self.organization.id),
            amount_cny=Decimal(data["payable_amount"]),
            operator_user_id=str(self.user.id),
            related_order_id=f"pr5-comp-switch-{data['order_id']}",
        )
        old_lifecycle = self.membership.lifecycle_version

        with patch.object(OrganizationEntitlementSyncService, "sync_organization_entitlement", side_effect=RuntimeError("sync failed")):
            with self.assertRaises(RuntimeError):
                self.service.wallet_pay_membership_order(
                    user=self.user,
                    organization_id=str(self.organization.id),
                    order_id=data["order_id"],
                    change_type="switch",
                )
        self._refresh_state()
        self.membership.refresh_from_db()
        order = PaymentOrder.objects.get(id=data["order_id"])
        self.assertEqual(order.status, "paid")
        self.assertEqual(order.benefit_status, "failed")
        self.assertEqual(self.membership.tier_id, str(self.current_tier.id))
        self.assertEqual(self.membership.lifecycle_version, old_lifecycle)
        self.assertEqual(
            OrganizationMembershipChangeLog.objects.get(id=order.business_data["change_log_id"]).status,
            OrganizationMembershipChangeLog.Status.FAILED,
        )

        with patch(
            "apps.users.membership.services.subscription_lifecycle_service.OrganizationEntitlementSyncService.sync_organization_entitlement",
            return_value=None,
        ):
            paid = self.service.wallet_pay_membership_order(
                user=self.user,
                organization_id=str(self.organization.id),
                order_id=data["order_id"],
                change_type="switch",
            )
        order.refresh_from_db()
        self.assertIn(paid["payment_status"], {"completed", "paid"})
        self.assertEqual(order.status, "completed")
        self.assertEqual(order.benefit_status, "completed")
        self.membership.refresh_from_db()
        self.assertEqual(self.membership.tier_id, str(self.next_tier.id))
        self.assertEqual(self.membership.lifecycle_version, old_lifecycle + 1)
        self.assertEqual(
            CashWalletTransaction.objects.filter(
                transaction_type="membership_lifecycle_payment",
                related_order_id=order.id,
            ).count(),
            1,
        )

    def test_expiry_vs_renewal_concurrent_only_one_wins_and_membership_remains_active(self):
        now = timezone.now()
        self.membership.end_date = now - timedelta(seconds=1)
        self.membership.save(update_fields=["end_date", "status", "updated_at"])
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
            amount_cny=Decimal(data["payable_amount"]),
            operator_user_id=str(self.user.id),
            related_order_id=f"pr5-comp-expiry-{data['order_id']}",
        )

        barrier = Barrier(2)
        results = []
        errors = []

        def worker_expire():
            connection.close()
            try:
                barrier.wait(timeout=10)
                with transaction.atomic():
                    results.append(
                        self.service.process_membership_expiry(
                            membership_id=str(self.membership.id),
                            now=timezone.now(),
                        )
                    )
            except Exception as exc:
                errors.append(type(exc).__name__)
            finally:
                connection.close()

        def worker_pay():
            connection.close()
            try:
                barrier.wait(timeout=10)
                results.append(
                    self.service.wallet_pay_membership_order(
                        user=self.user,
                        organization_id=str(self.organization.id),
                        order_id=data["order_id"],
                        change_type="renewal",
                    )
                )
            except Exception as exc:
                errors.append(type(exc).__name__)
            finally:
                connection.close()

        threads = [Thread(target=worker_expire), Thread(target=worker_pay)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=30)

        self._refresh_state()
        self.assertFalse(errors, f"concurrent workers failed: {errors}")
        self.membership.refresh_from_db()
        self.assertEqual(self.membership.status, "active")
        self.assertGreater(self.membership.end_date, now)
        self.assertEqual(CashWalletTransaction.objects.filter(
            transaction_type="membership_lifecycle_payment",
            related_order_id=data["order_id"],
        ).count(), 1)

    def test_grace_expiry_vs_renewal_concurrent_only_renewal_keeps_active(self):
        now = timezone.now()
        self.membership.status = "grace"
        self.membership.grace_period_end = now - timedelta(seconds=1)
        self.membership.save(update_fields=["status", "grace_period_end", "updated_at"])
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
            amount_cny=Decimal(data["payable_amount"]),
            operator_user_id=str(self.user.id),
            related_order_id=f"pr5-comp-grace-{data['order_id']}",
        )

        barrier = Barrier(2)
        errors = []

        def worker_expire():
            connection.close()
            try:
                barrier.wait(timeout=10)
                self.service.process_grace_expiration(
                    membership_id=str(self.membership.id),
                    now=timezone.now(),
                )
            except Exception as exc:
                errors.append(type(exc).__name__)
            finally:
                connection.close()

        def worker_pay():
            connection.close()
            try:
                barrier.wait(timeout=10)
                self.service.wallet_pay_membership_order(
                    user=self.user,
                    organization_id=str(self.organization.id),
                    order_id=data["order_id"],
                    change_type="renewal",
                )
            except Exception as exc:
                errors.append(type(exc).__name__)
            finally:
                connection.close()

        threads = [Thread(target=worker_expire), Thread(target=worker_pay)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=30)

        self.membership.refresh_from_db()
        self.assertFalse(errors)
        self.assertEqual(self.membership.status, "active")
        self.assertIsNone(self.membership.scheduled_change_log_id)

    def test_two_lifecycle_workers_apply_scheduled_change_once(self):
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

        self.membership.end_date = timezone.now() - timedelta(seconds=1)
        self.membership.save(update_fields=["end_date", "updated_at"])
        barrier = Barrier(2)
        errors = []
        members = []

        def worker():
            connection.close()
            try:
                barrier.wait(timeout=10)
                result = self.service.process_membership_expiry(
                    membership_id=str(self.membership.id),
                    now=timezone.now(),
                )
                members.append(result)
            except Exception as exc:
                errors.append(type(exc).__name__)
            finally:
                connection.close()

        threads = [Thread(target=worker), Thread(target=worker)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=30)

        self.membership.refresh_from_db()
        self.assertFalse(errors)
        self.assertEqual(self.membership.tier_id, str(self.free_tier.id))
        self.assertIsNone(self.membership.scheduled_tier_id)
        self.budget.refresh_from_db()
        self.assertEqual(self.budget.included_credits, self.membership.tier.included_llm_credits_monthly)
        self.assertIn(self.membership.status, {"active", "grace", "expired"})
