from datetime import timedelta
from decimal import Decimal
from django.contrib import admin
from django.contrib.auth import get_user_model
from django.db import IntegrityError, transaction
from django.test import TestCase
from django.utils import timezone

from apps.tabtinspace.models import Organization
from apps.users.membership.admin import OrganizationMembershipAdmin
from apps.users.membership.models import (
    MembershipTier,
    OrganizationMembership,
    OrganizationMembershipChangeLog,
)


User = get_user_model()


def create_tier(*, tier_type, tier_level, sort_order=0):
    return MembershipTier.objects.create(
        tier_type=tier_type,
        name=f"tier-{tier_type}",
        description="",
        price=Decimal("99.00"),
        duration_months=1,
        max_tables=10,
        max_documents=10,
        max_groups=10,
        max_records_per_table=100,
        included_storage_bytes=1024,
        included_llm_credits_monthly=Decimal("100"),
        max_members=5,
        features={},
        tier_level=tier_level,
        sort_order=sort_order,
        is_active=True,
    )


class OrganizationMembershipLifecycleModelTests(TestCase):
    databases = {"default"}

    @classmethod
    def setUpTestData(cls):
        cls.user = User.objects.create(
            username="membership-pr2-user",
            email="membership-pr2-user@tabtin.test",
            password="!",
        )
        cls.organization = Organization.objects.create(
            name="membership-pr2-org",
            owner=cls.user,
            type=Organization.OrganizationType.TEAM,
        )
        cls.base_tier = create_tier(
            tier_type="pr2-base",
            tier_level=10,
            sort_order=900,
        )
        cls.target_tier = create_tier(
            tier_type="pr2-target",
            tier_level=20,
            sort_order=-900,
        )

    def create_membership(self):
        now = timezone.now()
        return OrganizationMembership.objects.create(
            organization_id=str(self.organization.id),
            tier=self.base_tier,
            status="active",
            start_date=now,
            end_date=now + timedelta(days=30),
        )

    def create_log(self, **overrides):
        values = {
            "organization": self.organization,
            "change_type": OrganizationMembershipChangeLog.ChangeType.NEW,
            "status": OrganizationMembershipChangeLog.Status.APPLIED,
            "to_tier": self.target_tier,
        }
        values.update(overrides)
        return OrganizationMembershipChangeLog.objects.create(**values)

    def test_membership_lifecycle_defaults(self):
        membership = self.create_membership()
        self.assertEqual(
            membership.billing_cycle,
            OrganizationMembership.BillingCycle.MONTHLY,
        )
        self.assertEqual(membership.lifecycle_version, 1)
        self.assertIsNone(membership.current_actual_paid_period_price)
        self.assertIsNone(membership.grace_period_end)

    def test_bump_lifecycle_version_is_explicit(self):
        membership = self.create_membership()
        self.assertEqual(membership.bump_lifecycle_version(), 2)
        membership.auto_renew = True
        membership.save(update_fields=["auto_renew", "updated_at"])
        membership.refresh_from_db()
        self.assertEqual(membership.lifecycle_version, 2)

    def test_change_log_supports_core_change_types(self):
        for change_type in (
            OrganizationMembershipChangeLog.ChangeType.NEW,
            OrganizationMembershipChangeLog.ChangeType.UPGRADE,
            OrganizationMembershipChangeLog.ChangeType.DOWNGRADE,
            OrganizationMembershipChangeLog.ChangeType.SWITCH,
        ):
            log = self.create_log(change_type=change_type)
            self.assertEqual(log.change_type, change_type)

    def test_tier_delete_keeps_log_and_snapshots(self):
        source = create_tier(tier_type="pr2-delete-source", tier_level=15)
        target = create_tier(tier_type="pr2-delete-target", tier_level=25)
        log = self.create_log(
            from_tier=source,
            to_tier=target,
            from_tier_snapshot={"id": str(source.id), "price": "49.00"},
            to_tier_snapshot={"id": str(target.id), "price": "199.00"},
        )

        source.delete()
        target.delete()
        log.refresh_from_db()

        self.assertIsNone(log.from_tier)
        self.assertIsNone(log.to_tier)
        self.assertEqual(log.from_tier_snapshot["price"], "49.00")
        self.assertEqual(log.to_tier_snapshot["price"], "199.00")

    def test_membership_delete_keeps_log(self):
        membership = self.create_membership()
        log = self.create_log(membership=membership)
        membership.delete()
        log.refresh_from_db()
        self.assertIsNone(log.membership)

    def test_payment_order_id_non_null_is_unique(self):
        self.create_log(payment_order_id="payment-pk-1")
        with self.assertRaises(IntegrityError):
            with transaction.atomic():
                self.create_log(payment_order_id="payment-pk-1")

    def test_null_payment_order_id_allows_multiple_rows(self):
        first = self.create_log(payment_order_id=None)
        second = self.create_log(payment_order_id=None)
        self.assertIsNone(first.payment_order_id)
        self.assertIsNone(second.payment_order_id)

    def test_blank_payment_order_id_is_normalized_to_null(self):
        first = self.create_log(payment_order_id="")
        second = self.create_log(payment_order_id="   ")
        first.refresh_from_db()
        second.refresh_from_db()
        self.assertIsNone(first.payment_order_id)
        self.assertIsNone(second.payment_order_id)

    def test_only_one_pending_downgrade_or_switch_per_organization(self):
        self.create_log(
            change_type=OrganizationMembershipChangeLog.ChangeType.DOWNGRADE,
            status=OrganizationMembershipChangeLog.Status.PENDING,
        )
        with self.assertRaises(IntegrityError):
            with transaction.atomic():
                self.create_log(
                    change_type=OrganizationMembershipChangeLog.ChangeType.SWITCH,
                    status=OrganizationMembershipChangeLog.Status.PENDING,
                )

    def test_non_pending_or_other_change_type_does_not_hit_pending_constraint(self):
        self.create_log(
            change_type=OrganizationMembershipChangeLog.ChangeType.DOWNGRADE,
            status=OrganizationMembershipChangeLog.Status.CANCELLED,
        )
        self.create_log(
            change_type=OrganizationMembershipChangeLog.ChangeType.UPGRADE,
            status=OrganizationMembershipChangeLog.Status.PENDING,
        )

    def test_terminal_status_helpers(self):
        applied = self.create_log(status=OrganizationMembershipChangeLog.Status.APPLYING)
        applied.mark_applied()
        self.assertEqual(applied.status, OrganizationMembershipChangeLog.Status.APPLIED)
        self.assertIsNotNone(applied.applied_at)

        failed = self.create_log(status=OrganizationMembershipChangeLog.Status.APPLYING)
        failed.mark_failed(reason="apply failed")
        self.assertEqual(failed.status, OrganizationMembershipChangeLog.Status.FAILED)
        self.assertEqual(failed.reason, "apply failed")

        cancelled = self.create_log(status=OrganizationMembershipChangeLog.Status.PENDING)
        cancelled.mark_cancelled(reason="superseded")
        self.assertEqual(
            cancelled.status,
            OrganizationMembershipChangeLog.Status.CANCELLED,
        )
        self.assertEqual(cancelled.reason, "superseded")

    def test_json_snapshots_use_decimal_strings_and_amounts_are_decimal(self):
        log = self.create_log(
            to_tier_snapshot={
                "id": str(self.target_tier.id),
                "price": "399.00",
                "included_llm_credits_monthly": "30000.00000000",
            },
            list_amount=Decimal("399.00"),
            current_value=Decimal("46.00"),
            target_value=Decimal("266.00"),
            discount_amount=Decimal("0.00"),
            payable_amount=Decimal("220.00"),
        )
        log.refresh_from_db()
        self.assertEqual(log.to_tier_snapshot["price"], "399.00")
        for value in (
            log.list_amount,
            log.current_value,
            log.target_value,
            log.discount_amount,
            log.payable_amount,
        ):
            self.assertIsInstance(value, Decimal)

    def test_admin_critical_fields_are_readonly_and_add_delete_are_disabled(self):
        model_admin = OrganizationMembershipAdmin(
            OrganizationMembership,
            admin.site,
        )
        readonly = set(model_admin.get_readonly_fields(request=None))
        self.assertTrue(
            {
                "organization_id",
                "tier",
                "status",
                "start_date",
                "end_date",
                "billing_cycle",
                "current_actual_paid_period_price",
                "grace_period_end",
                "lifecycle_version",
                "related_order_id",
                "purchased_by",
            }.issubset(readonly)
        )
        self.assertFalse(model_admin.has_add_permission(request=None))
        self.assertFalse(model_admin.has_delete_permission(request=None))

    def test_tier_level_and_sort_order_are_unchanged(self):
        self.base_tier.refresh_from_db()
        self.target_tier.refresh_from_db()
        self.assertEqual(self.base_tier.tier_level, 10)
        self.assertEqual(self.base_tier.sort_order, 900)
        self.assertEqual(self.target_tier.tier_level, 20)
        self.assertEqual(self.target_tier.sort_order, -900)
