from datetime import timedelta
from types import SimpleNamespace

from django.test import SimpleTestCase, override_settings
from django.utils import timezone

from apps.users.membership.exceptions import MembershipLifecycleError
from apps.users.membership.services.membership_state_resolver import (
    MembershipStateResolver,
)


class MembershipStateResolverTests(SimpleTestCase):
    def setUp(self):
        self.now = timezone.now()
        self.tier = SimpleNamespace(id="tier-10", tier_level=10)

    def membership(self, **overrides):
        values = {
            "tier": self.tier,
            "status": "active",
            "start_date": self.now - timedelta(days=20),
            "end_date": self.now + timedelta(days=10),
        }
        values.update(overrides)
        return SimpleNamespace(**values)

    def test_missing_membership_resolves_free(self):
        state = MembershipStateResolver.resolve(None, now=self.now)
        self.assertEqual(state.lifecycle_state, "free")
        self.assertFalse(state.has_effective_membership)
        self.assertEqual(state.current_billing_cycle, "monthly")

    def test_active_membership_resolves_effective(self):
        state = MembershipStateResolver.resolve(self.membership(), now=self.now)
        self.assertEqual(state.lifecycle_state, "active")
        self.assertTrue(state.has_effective_membership)
        self.assertIs(state.effective_tier, self.tier)

    @override_settings(ENTITLEMENT_GRACE_PERIOD_DAYS=3)
    def test_active_record_past_end_resolves_expired_until_task_sets_grace(self):
        state = MembershipStateResolver.resolve(
            self.membership(end_date=self.now - timedelta(days=2)),
            now=self.now,
        )
        self.assertEqual(state.lifecycle_state, "expired")
        self.assertFalse(state.has_effective_membership)
        self.assertTrue(state.is_expired_by_time)

    def test_explicit_grace_record_resolves_effective_grace_period(self):
        state = MembershipStateResolver.resolve(
            self.membership(
                status="grace",
                end_date=self.now - timedelta(days=1),
                grace_period_end=self.now + timedelta(days=6),
            ),
            now=self.now,
        )
        self.assertEqual(state.lifecycle_state, "grace_period")
        self.assertTrue(state.has_effective_membership)
        self.assertIn("renew", state.allowed_actions)

    def test_explicit_zero_grace_resolves_time_expired(self):
        state = MembershipStateResolver.resolve(
            self.membership(end_date=self.now - timedelta(seconds=1)),
            now=self.now,
            grace_period=timedelta(0),
        )
        self.assertEqual(state.lifecycle_state, "expired")
        self.assertFalse(state.has_effective_membership)

    def test_suspended_is_not_effective(self):
        state = MembershipStateResolver.resolve(
            self.membership(status="suspended"),
            now=self.now,
        )
        self.assertEqual(state.lifecycle_state, "suspended")
        self.assertFalse(state.has_effective_membership)

    def test_unknown_status_fails_safe(self):
        state = MembershipStateResolver.resolve(
            self.membership(status="corrupt"),
            now=self.now,
        )
        self.assertEqual(state.lifecycle_state, "unknown")
        self.assertFalse(state.has_effective_membership)

    def test_missing_model_billing_cycle_uses_monthly_compatibility(self):
        state = MembershipStateResolver.resolve(self.membership(), now=self.now)
        self.assertEqual(state.current_billing_cycle, "monthly")

    def test_explicit_yearly_billing_cycle_is_preserved(self):
        state = MembershipStateResolver.resolve(
            self.membership(billing_cycle="yearly"),
            now=self.now,
        )
        self.assertEqual(state.current_billing_cycle, "yearly")

    def test_invalid_billing_cycle_fails_closed(self):
        with self.assertRaises(MembershipLifecycleError) as raised:
            MembershipStateResolver.resolve(
                self.membership(billing_cycle="weekly"),
                now=self.now,
            )
        self.assertEqual(
            raised.exception.error_code,
            "MEMBERSHIP_BILLING_CYCLE_INVALID",
        )
