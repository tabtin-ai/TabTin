"""SeatBillingService 席位上限须与展示侧一致：套餐 + 扩容。"""
from decimal import Decimal

from django.test import TestCase

from apps.services.billing.models import AddonPackage
from apps.services.billing.services.addon_entitlement_service import AddonEntitlementService
from apps.services.billing.services.seat_billing_service import SeatBillingService
from apps.services.billing.tests.org_test_utils import org_id_for
from apps.tabtinspace.models import Organization, OrganizationMember
from apps.users.auth.models import User
from apps.users.membership.models import MembershipTier, OrganizationMembership
from django.utils import timezone
from dateutil.relativedelta import relativedelta


class SeatBillingServiceAddonTests(TestCase):
    databases = {"default"}

    def setUp(self):
        self.owner = User.objects.create_user(
            username="seat_billing_owner",
            email="seat-billing-owner@test.local",
            password="test-pass-123",
        )
        self.tier = MembershipTier.objects.create(
            tier_type="free",
            name="免费版",
            description="",
            price=Decimal("0"),
            duration_months=1,
            max_members=1,
            base_seats=1,
            max_documents=50,
            max_groups=1,
            included_storage_bytes=0,
            included_llm_credits_monthly=Decimal("0"),
            is_active=True,
        )
        self.organization_id = org_id_for("seat_billing_addon_001")
        self.organization = Organization.objects.get(id=self.organization_id)
        OrganizationMembership.objects.create(
            organization_id=self.organization_id,
            tier=self.tier,
            status="active",
            start_date=timezone.now() - relativedelta(days=1),
            end_date=timezone.now() + relativedelta(months=1),
            auto_renew=False,
        )
        OrganizationMember.objects.create(
            organization=self.organization,
            user=self.owner,
            role="owner",
        )

    def test_get_seat_info_includes_max_members_addon(self):
        package = AddonPackage.objects.create(
            addon_code="addon_max_members_3",
            addon_name="成员席位扩容",
            description="",
            price=Decimal("0"),
            quota_key="max_members",
            quota_value=3,
            period_months=1,
            is_active=True,
        )
        AddonEntitlementService.grant_addon(
            organization_id=self.organization_id,
            addon_package_id=str(package.id),
            order_id="order_seat_addon_001",
            purchased_by=str(self.owner.id),
        )

        info = SeatBillingService.get_seat_info(self.organization_id)

        self.assertEqual(info["used"], 1)
        self.assertEqual(info["max"], 4)
        self.assertTrue(SeatBillingService.check_seat_quota(self.organization_id))
