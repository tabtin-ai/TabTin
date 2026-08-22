from datetime import timedelta
from decimal import Decimal
from types import SimpleNamespace

from django.test import SimpleTestCase
from django.utils import timezone

from apps.users.membership.exceptions import MembershipLifecycleError
from apps.users.membership.services.membership_change_classifier import (
    MembershipChangeClassifier,
)


def tier(tier_id, level, **overrides):
    values = {
        "id": tier_id,
        "tier_level": level,
        "name": f"random-{tier_id}",
        "price": Decimal("123.45"),
        "included_llm_credits_monthly": Decimal("987.65"),
        "max_members": 17,
        "included_storage_bytes": 123456,
        "sort_order": 999,
    }
    values.update(overrides)
    return SimpleNamespace(**values)


def membership(current_tier, *, status="active", end_delta=timedelta(days=10), **extra):
    now = timezone.now()
    values = {
        "tier": current_tier,
        "status": status,
        "start_date": now - timedelta(days=20),
        "end_date": now + end_delta,
    }
    values.update(extra)
    return SimpleNamespace(**values)


class MembershipChangeClassifierTests(SimpleTestCase):
    def setUp(self):
        self.now = timezone.now()
        self.level_10 = tier("tier-10", 10)
        self.level_20 = tier("tier-20", 20)
        self.level_30 = tier("tier-30", 30)

    def classify(self, current, target, cycle="monthly"):
        return MembershipChangeClassifier.classify(
            current_membership=current,
            target_tier=target,
            target_billing_cycle=cycle,
            now=self.now,
        )

    def test_no_effective_membership_is_new(self):
        self.assertEqual(self.classify(None, self.level_10), "new")

    def test_same_tier_and_cycle_is_renew(self):
        self.assertEqual(
            self.classify(membership(self.level_10), self.level_10),
            "renew",
        )

    def test_level_10_to_20_is_upgrade(self):
        self.assertEqual(
            self.classify(membership(self.level_10), self.level_20),
            "upgrade",
        )

    def test_level_20_to_30_is_upgrade(self):
        self.assertEqual(
            self.classify(membership(self.level_20), self.level_30),
            "upgrade",
        )

    def test_level_30_to_20_is_downgrade(self):
        self.assertEqual(
            self.classify(membership(self.level_30), self.level_20),
            "downgrade",
        )

    def test_level_20_to_10_is_downgrade(self):
        self.assertEqual(
            self.classify(membership(self.level_20), self.level_10),
            "downgrade",
        )

    def test_same_level_different_tier_is_switch(self):
        same_level = tier("tier-20-b", 20)
        self.assertEqual(
            self.classify(membership(self.level_20), same_level),
            "switch",
        )

    def test_same_tier_monthly_to_yearly_is_switch(self):
        self.assertEqual(
            self.classify(membership(self.level_20), self.level_20, "yearly"),
            "switch",
        )

    def test_cycle_change_wins_over_level_change(self):
        self.assertEqual(
            self.classify(membership(self.level_10), self.level_30, "yearly"),
            "switch",
        )

    def test_non_level_fields_do_not_change_action(self):
        current = membership(
            tier(
                "current",
                10,
                name="任意名称",
                price=Decimal("9999"),
                included_llm_credits_monthly=Decimal("1"),
                max_members=1000,
                included_storage_bytes=999999999,
                sort_order=9000,
            )
        )
        target = tier(
            "target",
            20,
            name="另一个任意名称",
            price=Decimal("0"),
            included_llm_credits_monthly=Decimal("0"),
            max_members=1,
            included_storage_bytes=0,
            sort_order=-9000,
        )
        self.assertEqual(self.classify(current, target), "upgrade")

    def test_invalid_target_tier_level_fails_closed(self):
        with self.assertRaises(MembershipLifecycleError) as raised:
            self.classify(membership(self.level_10), tier("bad", None))
        self.assertEqual(raised.exception.error_code, "MEMBERSHIP_TARGET_TIER_INVALID")

    def test_inactive_target_tier_fails_closed(self):
        with self.assertRaises(MembershipLifecycleError) as raised:
            self.classify(
                membership(self.level_10),
                tier("inactive", 20, is_active=False),
            )
        self.assertEqual(raised.exception.error_code, "MEMBERSHIP_TARGET_TIER_INVALID")

    def test_invalid_current_tier_level_fails_closed(self):
        with self.assertRaises(MembershipLifecycleError) as raised:
            self.classify(membership(tier("bad-current", "10")), self.level_20)
        self.assertEqual(raised.exception.error_code, "MEMBERSHIP_TIER_LEVEL_INVALID")

    def test_invalid_billing_cycle_fails_closed(self):
        with self.assertRaises(MembershipLifecycleError) as raised:
            self.classify(membership(self.level_10), self.level_20, "weekly")
        self.assertEqual(
            raised.exception.error_code,
            "MEMBERSHIP_BILLING_CYCLE_INVALID",
        )

    def test_suspended_membership_is_new(self):
        current = membership(self.level_20, status="suspended")
        self.assertEqual(self.classify(current, self.level_20), "new")

    def test_expired_membership_is_new(self):
        current = membership(self.level_20, status="expired", end_delta=timedelta(days=-1))
        self.assertEqual(self.classify(current, self.level_20), "new")

    def test_active_membership_inside_legacy_grace_remains_effective(self):
        current = membership(self.level_20, end_delta=timedelta(days=-1))
        self.assertEqual(self.classify(current, self.level_20), "renew")
