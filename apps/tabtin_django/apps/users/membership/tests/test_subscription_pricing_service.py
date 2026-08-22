from datetime import datetime, timedelta, timezone as datetime_timezone
from decimal import Decimal, ROUND_HALF_UP
from types import SimpleNamespace
from unittest.mock import patch

from django.core import signing
from django.test import TestCase, override_settings

from apps.users.membership.api import (
    preview_membership_purchase,
    preview_membership_upgrade,
)
from apps.users.membership.models import MembershipTier, OrganizationMembership
from apps.users.membership.schemas import (
    OrganizationPurchasePreviewRequest,
    OrganizationUpgradePreviewRequest,
)
from apps.users.membership.services.subscription_pricing_service import (
    SubscriptionPricingError,
    SubscriptionPricingService,
    TargetPeriodPrice,
)


UTC = datetime_timezone.utc


def create_tier(*, tier_type, tier_level, price):
    return MembershipTier.objects.create(
        tier_type=tier_type,
        name=f"tier-{tier_type}",
        description="",
        price=Decimal(price),
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
        is_active=True,
    )


class SubscriptionPricingServiceTests(TestCase):
    databases = {"default"}

    def setUp(self):
        self.service = SubscriptionPricingService()
        self.current_tier = create_tier(
            tier_type="pricing-current",
            tier_level=10,
            price="49.00",
        )
        self.target_tier = create_tier(
            tier_type="pricing-target",
            tier_level=20,
            price="399.00",
        )
        self.quoted_at = datetime(2026, 7, 11, 0, 0, 0, tzinfo=UTC)
        self.membership = self._membership(
            start=datetime(2026, 7, 1, 0, 0, 0, tzinfo=UTC),
            end=datetime(2026, 7, 31, 0, 0, 0, tzinfo=UTC),
            current_price="69.00",
        )

    def _membership(
        self,
        *,
        start,
        end,
        current_price="69.00",
        status="active",
        billing_cycle="monthly",
        organization_id="org-pricing",
    ):
        return OrganizationMembership.objects.create(
            organization_id=organization_id,
            tier=self.current_tier,
            status=status,
            start_date=start,
            end_date=end,
            billing_cycle=billing_cycle,
            current_actual_paid_period_price=(
                Decimal(current_price) if current_price is not None else None
            ),
        )

    def _quote(self, **overrides):
        values = {
            "organization_id": self.membership.organization_id,
            "membership": self.membership,
            "target_tier": self.target_tier,
            "target_billing_cycle": self.membership.billing_cycle,
            "quoted_at": self.quoted_at,
        }
        values.update(overrides)
        return self.service.calculate_upgrade_quote(**values)

    def assert_error(self, code, **overrides):
        with self.assertRaises(SubscriptionPricingError) as raised:
            self._quote(**overrides)
        self.assertEqual(raised.exception.error_code, code)
        return raised.exception

    def test_30_day_period_with_20_days_remaining_is_220(self):
        quote = self._quote()
        self.assertEqual(quote.period_seconds, Decimal(30 * 86400))
        self.assertEqual(quote.remaining_seconds, Decimal(20 * 86400))
        self.assertEqual(quote.payable_amount, Decimal("220.00"))
        self.assertEqual(
            quote.payable_amount,
            ((Decimal("399") - Decimal("69")) * Decimal(20) / Decimal(30))
            .quantize(Decimal("0.01"), rounding=ROUND_HALF_UP),
        )

    def test_real_calendar_period_lengths_28_29_31_days(self):
        for index, days in enumerate((28, 29, 31), start=1):
            membership = self._membership(
                organization_id=f"org-calendar-{index}",
                start=datetime(2028, 2, 1, tzinfo=UTC),
                end=datetime(2028, 2, 1, tzinfo=UTC) + timedelta(days=days),
            )
            quote = self._quote(
                organization_id=membership.organization_id,
                membership=membership,
                quoted_at=membership.start_date + timedelta(days=8),
            )
            self.assertEqual(quote.period_seconds, Decimal(days * 86400))
            self.assertEqual(
                quote.remaining_seconds,
                Decimal((days - 8) * 86400),
            )

    def test_time_of_day_and_seconds_are_preserved(self):
        membership = self._membership(
            organization_id="org-time-of-day",
            start=datetime(2026, 7, 1, 8, 15, 5, tzinfo=UTC),
            end=datetime(2026, 7, 31, 8, 15, 5, tzinfo=UTC),
        )
        quoted_at = datetime(2026, 7, 11, 9, 16, 7, tzinfo=UTC)
        quote = self._quote(
            organization_id=membership.organization_id,
            membership=membership,
            quoted_at=quoted_at,
        )
        self.assertEqual(
            quote.remaining_seconds,
            Decimal(20 * 86400 - 3662),
        )

    def test_remaining_seconds_before_start_are_capped_to_period(self):
        quote = self._quote(
            quoted_at=self.membership.start_date - timedelta(days=5),
        )
        self.assertEqual(quote.remaining_seconds, quote.period_seconds)
        self.assertEqual(quote.remaining_ratio, Decimal("1"))

    def test_expired_membership_is_rejected(self):
        self.assert_error(
            "MEMBERSHIP_PERIOD_EXPIRED",
            quoted_at=self.membership.end_date,
        )

    def test_zero_or_negative_period_is_rejected(self):
        for index, end_delta in enumerate((timedelta(0), timedelta(seconds=-1))):
            membership = self._membership(
                organization_id=f"org-invalid-period-{index}",
                start=datetime(2026, 8, 1, tzinfo=UTC),
                end=datetime(2026, 8, 1, tzinfo=UTC) + end_delta,
            )
            self.assert_error(
                "MEMBERSHIP_PERIOD_INVALID",
                organization_id=membership.organization_id,
                membership=membership,
                quoted_at=datetime(2026, 7, 1, tzinfo=UTC),
            )

    def test_missing_current_period_price_snapshot_is_rejected(self):
        self.membership.current_actual_paid_period_price = None
        self.assert_error("CURRENT_PERIOD_PRICE_SNAPSHOT_MISSING")

    def test_current_public_price_change_does_not_change_snapshot(self):
        self.current_tier.price = Decimal("9999.00")
        self.current_tier.save(update_fields=["price", "updated_at"])
        quote = self._quote()
        self.assertEqual(
            quote.current_actual_paid_period_price,
            Decimal("69.00"),
        )

    def test_target_price_uses_unified_resolver(self):
        resolved = TargetPeriodPrice(
            list_period_price=Decimal("500.00"),
            discount_amount=Decimal("101.00"),
            effective_period_price=Decimal("399.00"),
            price_source="test-price-source",
            price_version="price-v1",
        )
        with patch.object(
            self.service,
            "resolve_target_effective_period_price",
            return_value=resolved,
        ) as resolver:
            quote = self._quote()
        resolver.assert_called_once_with(
            target_tier=self.target_tier,
            billing_cycle="monthly",
        )
        self.assertEqual(quote.price_source, "test-price-source")
        self.assertEqual(quote.discount_amount, Decimal("101.00"))

    def test_tier_level_increase_is_upgrade(self):
        self.assertEqual(self._quote().action, "upgrade")

    def test_downgrade_renew_and_switch_are_rejected_with_correct_action(self):
        downgrade = create_tier(
            tier_type="pricing-down",
            tier_level=0,
            price="9.00",
        )
        same_level = create_tier(
            tier_type="pricing-peer",
            tier_level=10,
            price="199.00",
        )
        cases = (
            (downgrade, "monthly", "downgrade"),
            (self.current_tier, "monthly", "renew"),
            (same_level, "monthly", "switch"),
        )
        for tier, cycle, expected in cases:
            error = self.assert_error(
                "MEMBERSHIP_ACTION_MISMATCH",
                target_tier=tier,
                target_billing_cycle=cycle,
            )
            self.assertEqual(error.correct_action, expected)

    def test_billing_cycle_change_is_rejected(self):
        self.assert_error(
            "MEMBERSHIP_BILLING_CYCLE_CHANGE_NOT_ALLOWED",
            target_billing_cycle="yearly",
        )

    def test_lower_target_price_has_zero_payable(self):
        cheap_upgrade = create_tier(
            tier_type="pricing-cheap-upgrade",
            tier_level=30,
            price="50.00",
        )
        quote = self._quote(target_tier=cheap_upgrade)
        self.assertEqual(quote.payable_amount, Decimal("0.00"))

    def test_decimal_precision_and_round_half_up(self):
        membership = self._membership(
            organization_id="org-rounding",
            start=datetime(2026, 8, 1, 0, 0, 0, tzinfo=UTC),
            end=datetime(2026, 8, 1, 0, 0, 2, tzinfo=UTC),
            current_price="0.00",
        )
        target = create_tier(
            tier_type="pricing-rounding-target",
            tier_level=30,
            price="0.05",
        )
        quote = self._quote(
            organization_id=membership.organization_id,
            membership=membership,
            target_tier=target,
            quoted_at=membership.start_date + timedelta(seconds=1),
        )
        self.assertEqual(quote.remaining_ratio, Decimal("0.5"))
        self.assertEqual(quote.target_value, Decimal("0.025"))
        self.assertEqual(quote.payable_amount, Decimal("0.03"))

    def test_quote_token_round_trip_and_contains_frozen_values(self):
        quote = self._quote()
        token = self.service.create_quote_token(quote)
        payload = self.service.verify_quote_token(
            token,
            organization_id=self.membership.organization_id,
            membership=self.membership,
            target_tier=self.target_tier,
            billing_cycle="monthly",
            now=self.quoted_at,
        )
        self.assertEqual(payload["quoted_at"], self.quoted_at.isoformat())
        self.assertEqual(payload["payable_amount"], "220.00")
        self.assertEqual(payload["price_version"], quote.price_version)

    def test_quote_token_tampering_is_rejected(self):
        token = self.service.create_quote_token(self._quote()) + "tampered"
        with self.assertRaises(SubscriptionPricingError) as raised:
            self.service.verify_quote_token(
                token,
                organization_id=self.membership.organization_id,
                membership=self.membership,
                target_tier=self.target_tier,
                billing_cycle="monthly",
                now=self.quoted_at,
            )
        self.assertEqual(raised.exception.error_code, "UPGRADE_QUOTE_INVALID")

    def test_quote_token_explicit_expiry_is_rejected(self):
        quote = self._quote()
        token = self.service.create_quote_token(quote)
        with self.assertRaises(SubscriptionPricingError) as raised:
            self.service.verify_quote_token(
                token,
                organization_id=self.membership.organization_id,
                membership=self.membership,
                target_tier=self.target_tier,
                billing_cycle="monthly",
                now=quote.quote_expires_at,
            )
        self.assertEqual(raised.exception.error_code, "UPGRADE_QUOTE_EXPIRED")

    def test_quote_token_signer_expiry_is_rejected(self):
        token = self.service.create_quote_token(self._quote())
        with patch(
            "apps.users.membership.services.subscription_pricing_service.signing.loads",
            side_effect=signing.SignatureExpired("expired"),
        ):
            with self.assertRaises(SubscriptionPricingError) as raised:
                self.service.verify_quote_token(
                    token,
                    organization_id=self.membership.organization_id,
                    membership=self.membership,
                    target_tier=self.target_tier,
                    billing_cycle="monthly",
                    now=self.quoted_at,
                )
        self.assertEqual(raised.exception.error_code, "UPGRADE_QUOTE_EXPIRED")

    def test_quote_token_context_mismatches_are_rejected(self):
        quote = self._quote()
        token = self.service.create_quote_token(quote)
        other_target = create_tier(
            tier_type="pricing-other-target",
            tier_level=40,
            price="500.00",
        )
        cases = (
            (
                {"organization_id": "other-org"},
                "UPGRADE_QUOTE_ORGANIZATION_MISMATCH",
            ),
            (
                {"target_tier": other_target},
                "UPGRADE_QUOTE_TARGET_TIER_MISMATCH",
            ),
        )
        for overrides, code in cases:
            arguments = {
                "organization_id": self.membership.organization_id,
                "membership": self.membership,
                "target_tier": self.target_tier,
                "billing_cycle": "monthly",
                "now": self.quoted_at,
            }
            arguments.update(overrides)
            with self.assertRaises(SubscriptionPricingError) as raised:
                self.service.verify_quote_token(token, **arguments)
            self.assertEqual(raised.exception.error_code, code)

    def test_quote_token_membership_version_mismatch_is_stale(self):
        token = self.service.create_quote_token(self._quote())
        self.membership.lifecycle_version += 1
        with self.assertRaises(SubscriptionPricingError) as raised:
            self.service.verify_quote_token(
                token,
                organization_id=self.membership.organization_id,
                membership=self.membership,
                target_tier=self.target_tier,
                billing_cycle="monthly",
                now=self.quoted_at,
            )
        self.assertEqual(raised.exception.error_code, "UPGRADE_QUOTE_STALE")

    def test_quote_token_membership_mismatch_is_rejected(self):
        token = self.service.create_quote_token(self._quote())
        other_membership = self._membership(
            organization_id="org-pricing-other-membership",
            start=self.membership.start_date,
            end=self.membership.end_date,
        )
        with self.assertRaises(SubscriptionPricingError) as raised:
            self.service.verify_quote_token(
                token,
                organization_id=self.membership.organization_id,
                membership=other_membership,
                target_tier=self.target_tier,
                billing_cycle="monthly",
                now=self.quoted_at,
            )
        self.assertEqual(
            raised.exception.error_code,
            "UPGRADE_QUOTE_MEMBERSHIP_MISMATCH",
        )


class SubscriptionPricingPreviewApiTests(TestCase):
    databases = {"default"}

    def setUp(self):
        self.current_tier = create_tier(
            tier_type="pricing-api-current",
            tier_level=10,
            price="69.00",
        )
        self.target_tier = create_tier(
            tier_type="pricing-api-target",
            tier_level=20,
            price="399.00",
        )
        self.membership = OrganizationMembership.objects.create(
            organization_id="org-pricing-api",
            tier=self.current_tier,
            status="active",
            start_date=datetime.now(tz=UTC) - timedelta(days=10),
            end_date=datetime.now(tz=UTC) + timedelta(days=20),
            billing_cycle="monthly",
            current_actual_paid_period_price=Decimal("69.00"),
        )
        self.request = SimpleNamespace(auth=SimpleNamespace(id="user-pricing"))

    @override_settings(
        MEMBERSHIP_UPGRADE_QUOTE_ENABLED=True,
        MEMBERSHIP_UPGRADE_QUOTE_TTL_SECONDS=600,
    )
    @patch("apps.users.membership.api.ensure_organization_permission")
    def test_preview_api_returns_string_amounts_and_token(self, _permission):
        response = preview_membership_upgrade(
            self.request,
            self.membership.organization_id,
            OrganizationUpgradePreviewRequest(
                target_tier_id=str(self.target_tier.id),
                billing_cycle="monthly",
            ),
        )
        data = response["data"]
        self.assertEqual(data["action"], "upgrade")
        for field in (
            "period_seconds",
            "remaining_seconds",
            "remaining_ratio",
            "current_actual_paid_period_price",
            "current_value",
            "target_list_period_price",
            "discount_amount",
            "target_effective_period_price",
            "target_value",
            "payable_amount",
        ):
            self.assertIsInstance(data[field], str)
        self.assertTrue(data["quote_token"])
        self.assertTrue(data["preserve_period_end"])

    @override_settings(MEMBERSHIP_UPGRADE_QUOTE_ENABLED=False)
    @patch("apps.users.membership.api.ensure_organization_permission")
    def test_feature_flag_off_keeps_legacy_preview(self, _permission):
        response = preview_membership_upgrade(
            self.request,
            self.membership.organization_id,
            OrganizationUpgradePreviewRequest(
                target_tier_id=str(self.target_tier.id),
                billing_cycle="monthly",
            ),
        )
        data = response["data"]
        self.assertEqual(data["action"], "upgrade")
        self.assertIn("current_tier_level", data)
        self.assertNotIn("quote_token", data)

    @override_settings(MEMBERSHIP_UPGRADE_QUOTE_ENABLED=True)
    @patch("apps.users.membership.api.ensure_organization_permission")
    def test_existing_purchase_preview_uses_same_quote_service(self, _permission):
        with patch.object(
            SubscriptionPricingService,
            "calculate_upgrade_quote",
            wraps=SubscriptionPricingService().calculate_upgrade_quote,
        ) as calculate:
            response = preview_membership_purchase(
                self.request,
                self.membership.organization_id,
                OrganizationPurchasePreviewRequest(
                    tier_id=str(self.target_tier.id),
                    billing_cycle="monthly",
                ),
            )
        self.assertTrue(response["success"])
        calculate.assert_called_once()

    @override_settings(MEMBERSHIP_UPGRADE_QUOTE_ENABLED=True)
    @patch("apps.users.membership.api.ensure_organization_permission")
    def test_non_upgrade_action_keeps_classifier_result(self, _permission):
        response = preview_membership_upgrade(
            self.request,
            self.membership.organization_id,
            OrganizationUpgradePreviewRequest(
                target_tier_id=str(self.current_tier.id),
                billing_cycle="monthly",
            ),
        )
        self.assertEqual(response["data"]["action"], "renew")
        self.assertNotIn("quote_token", response["data"])
