import json
from datetime import datetime, timedelta, timezone as datetime_timezone
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

from django.test import TestCase, override_settings
from django.utils import timezone

from apps.services.payment.api import create_payment_order
from apps.services.payment.schemas import CreateOrderRequest
from apps.users.membership.api import (
    _create_membership_payment,
    get_organization_membership,
    get_subscription_overview,
    preview_membership_purchase,
)
from apps.users.membership.exceptions import MembershipLifecycleError
from apps.users.membership.models import MembershipTier, OrganizationMembership
from apps.users.membership.schemas import OrganizationPurchasePreviewRequest
from apps.users.membership.services.membership_purchase_guard import (
    classify_and_guard_legacy_purchase,
)
from apps.users.membership.services.membership_state_resolver import (
    MembershipStateResolver,
)
from apps.users.membership.services.organization_membership_service import (
    OrganizationMembershipService,
)


def create_tier(*, tier_type, level, price="99.00", sort_order=0):
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
        included_llm_credits_monthly=Decimal("100"),
        max_members=5,
        features={},
        sort_order=sort_order,
        tier_level=level,
        is_active=True,
    )


class MembershipLifecyclePreviewTests(TestCase):
    databases = {"default"}

    def setUp(self):
        self.current_tier = create_tier(
            tier_type="same-level-a",
            level=20,
            sort_order=999,
        )
        self.target_tier = create_tier(
            tier_type="same-level-b",
            level=20,
            sort_order=-999,
        )
        self.membership = OrganizationMembership.objects.create(
            organization_id="org-preview-switch",
            tier=self.current_tier,
            status="active",
            start_date=timezone.now() - timedelta(days=10),
            end_date=timezone.now() + timedelta(days=20),
        )

    @patch("apps.users.membership.api.ensure_organization_permission")
    def test_preview_same_level_different_tier_returns_switch(self, _permission):
        response = preview_membership_purchase(
            SimpleNamespace(auth=SimpleNamespace(id="user-1")),
            "org-preview-switch",
            OrganizationPurchasePreviewRequest(
                tier_id=str(self.target_tier.id),
                billing_cycle="monthly",
            ),
        )
        data = response["data"]

        self.assertEqual(data["action"], "switch")
        self.assertIsNone(data["impact"])
        self.assertEqual(data["current_tier_level"], 20)
        self.assertEqual(data["target_tier_level"], 20)
        self.assertEqual(data["current_display_order"], 999)
        self.assertEqual(data["target_display_order"], -999)

    @patch("apps.users.membership.api.ensure_organization_permission")
    def test_preview_cycle_change_takes_priority_over_tier_id(self, _permission):
        response = preview_membership_purchase(
            SimpleNamespace(auth=SimpleNamespace(id="user-1")),
            "org-preview-switch",
            OrganizationPurchasePreviewRequest(
                tier_id=str(self.current_tier.id),
                billing_cycle="yearly",
            ),
        )
        self.assertEqual(response["data"]["action"], "switch")

    @patch(
        "apps.users.membership.services.organization_membership_service."
        "MembershipStateResolver.resolve",
        wraps=MembershipStateResolver.resolve,
    )
    @patch.object(OrganizationMembershipService, "_build_quota_usage", return_value={})
    @patch.object(OrganizationMembershipService, "_build_effective_quotas", return_value={})
    def test_membership_status_query_reuses_state_resolver(
        self,
        _quotas,
        _usage,
        resolve,
    ):
        result = OrganizationMembershipService().check_membership_status(
            "org-preview-switch"
        )
        self.assertEqual(result["tier"]["id"], self.current_tier.id)
        self.assertTrue(resolve.called)


class CommunityPermanentMembershipStatusTests(TestCase):
    databases = {"default"}

    def setUp(self):
        self.organization_id = str(uuid4())
        self.tier = create_tier(
            tier_type="community",
            level=1,
            price="0.00",
        )
        self.membership = OrganizationMembership.objects.create(
            organization_id=self.organization_id,
            tier=self.tier,
            status="active",
            start_date=timezone.now(),
            end_date=datetime.max.replace(tzinfo=datetime_timezone.utc),
        )
        self.request = SimpleNamespace(auth=SimpleNamespace(id="community-user"))

    @patch("apps.users.membership.api.ensure_organization_permission")
    def test_membership_endpoint_does_not_add_grace_to_permanent_end_date(self, _permission):
        response = get_organization_membership(self.request, self.organization_id)

        self.assertTrue(response["success"])
        self.assertEqual(response["data"]["end_date"], self.membership.end_date)
        self.assertIsNone(response["data"]["grace_period_end"])
        self.assertIsNone(response["data"]["grace_days_remaining"])

    @patch("apps.users.membership.api.ensure_organization_permission")
    def test_overview_endpoint_supports_permanent_community_membership(self, _permission):
        response = get_subscription_overview(self.request, self.organization_id)

        self.assertTrue(response["success"])
        self.assertEqual(response["data"]["membership"]["end_date"], self.membership.end_date)
        self.assertIsNone(response["data"]["membership"]["grace_period_end"])


class MembershipLifecyclePurchaseGuardTests(TestCase):
    databases = {"default"}

    def setUp(self):
        self.current_tier = create_tier(tier_type="guard-high", level=30)
        self.lower_tier = create_tier(tier_type="guard-low", level=20)
        self.same_level_tier = create_tier(tier_type="guard-peer", level=30)
        OrganizationMembership.objects.create(
            organization_id="org-purchase-guard",
            tier=self.current_tier,
            status="active",
            start_date=timezone.now() - timedelta(days=10),
            end_date=timezone.now() + timedelta(days=20),
        )

    @override_settings(MEMBERSHIP_LIFECYCLE_CLASSIFIER_ENABLED=False)
    @patch(
        "apps.users.membership.services.membership_purchase_guard."
        "classify_organization_membership_change"
    )
    def test_feature_flag_off_keeps_legacy_path_unchanged(self, classify):
        action = classify_and_guard_legacy_purchase(
            organization_id="org-purchase-guard",
            target_tier=self.lower_tier,
        )
        self.assertIsNone(action)
        classify.assert_not_called()

    @override_settings(MEMBERSHIP_LIFECYCLE_CLASSIFIER_ENABLED=True)
    def test_feature_flag_on_rejects_downgrade_in_legacy_flow(self):
        with self.assertRaises(MembershipLifecycleError) as raised:
            classify_and_guard_legacy_purchase(
                organization_id="org-purchase-guard",
                target_tier=self.lower_tier,
            )
        self.assertEqual(
            raised.exception.error_code,
            "MEMBERSHIP_DOWNGRADE_NOT_AVAILABLE_IN_LEGACY_FLOW",
        )

    @override_settings(MEMBERSHIP_LIFECYCLE_CLASSIFIER_ENABLED=True)
    def test_feature_flag_on_rejects_switch_in_legacy_flow(self):
        with self.assertRaises(MembershipLifecycleError) as raised:
            classify_and_guard_legacy_purchase(
                organization_id="org-purchase-guard",
                target_tier=self.same_level_tier,
            )
        self.assertEqual(
            raised.exception.error_code,
            "MEMBERSHIP_SWITCH_NOT_AVAILABLE_IN_LEGACY_FLOW",
        )

    @override_settings(MEMBERSHIP_LIFECYCLE_CLASSIFIER_ENABLED=True)
    def test_feature_flag_on_allows_upgrade_and_returns_action(self):
        higher_tier = create_tier(tier_type="guard-higher", level=40)
        action = classify_and_guard_legacy_purchase(
            organization_id="org-purchase-guard",
            target_tier=higher_tier,
        )
        self.assertEqual(action, "upgrade")

    @override_settings(MEMBERSHIP_LIFECYCLE_CLASSIFIER_ENABLED=True)
    @patch(
        "apps.users.membership.api.classify_and_guard_legacy_purchase",
        side_effect=MembershipLifecycleError(
            "switch blocked",
            "MEMBERSHIP_SWITCH_NOT_AVAILABLE_IN_LEGACY_FLOW",
        ),
    )
    def test_membership_purchase_entry_calls_shared_guard(self, guard):
        with self.assertRaises(MembershipLifecycleError):
            _create_membership_payment(
                user_id="user-1",
                tier_id=str(self.same_level_tier.id),
                payment_method="alipay",
                organization_id="org-purchase-guard",
            )
        guard.assert_called_once()

    @override_settings(MEMBERSHIP_LIFECYCLE_CLASSIFIER_ENABLED=True)
    @patch(
        "apps.users.membership.services.membership_purchase_guard."
        "classify_and_guard_legacy_purchase",
        side_effect=MembershipLifecycleError(
            "downgrade blocked",
            "MEMBERSHIP_DOWNGRADE_NOT_AVAILABLE_IN_LEGACY_FLOW",
        ),
    )
    @patch("apps.services.common.permissions.ensure_organization_permission")
    def test_generic_payment_entry_calls_shared_guard(self, _permission, guard):
        response = create_payment_order(
            SimpleNamespace(auth=SimpleNamespace(id="user-1")),
            CreateOrderRequest(
                order_type="membership",
                payment_method="alipay",
                subject="会员",
                description="兼容入口",
                amount=self.lower_tier.price,
                business_data={
                    "tier_id": str(self.lower_tier.id),
                    "organization_id": "org-purchase-guard",
                },
            ),
        )
        payload = json.loads(response.content)
        self.assertEqual(
            payload["code"],
            "MEMBERSHIP_DOWNGRADE_NOT_AVAILABLE_IN_LEGACY_FLOW",
        )
        guard.assert_called_once()
