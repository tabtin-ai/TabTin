from datetime import timedelta
from decimal import Decimal

from django.test import TestCase
from django.utils import timezone

from apps.services.billing.models import (
    AddonPackage,
    OrganizationAddonEntitlement,
    OrganizationBillingEntitlement,
)
from apps.services.billing.services.addon_entitlement_service import AddonEntitlementService
from apps.services.payment.models import PaymentOrder
from apps.services.payment.api import _hydrate_billing_addon_business_data
from apps.services.payment.services.benefit_service import OrderBenefitService
from apps.users.auth.models import User
from apps.users.membership.models import MembershipTier
from apps.users.membership.services.organization_membership_service import OrganizationMembershipService
from apps.users.membership.services.quota_service import QuotaService
from apps.services.billing.tests.org_test_utils import org_id_for


class AddonEntitlementServiceTests(TestCase):
    databases = {"default"}

    def setUp(self):
        self.user = User.objects.create_user(
            email="addon-benefit@test.com",
            password="test-pass-123",
        )
        MembershipTier.objects.create(
            tier_type="free",
            name="免费版",
            description="",
            price=Decimal("0"),
            duration_months=1,
            max_documents=10,
            max_groups=3,
            included_storage_bytes=0,
            included_llm_credits_monthly=Decimal("0"),
            included_media_monthly=2,
            included_search_monthly=3,
            included_tts_monthly=4,
            is_active=True,
        )

    def _create_package(self, *, quota_key="max_tables", quota_value=100):
        return AddonPackage.objects.create(
            addon_code=f"addon_{quota_key}_{quota_value}",
            addon_name="测试增值包",
            description="",
            price=Decimal("1000.00"),
            quota_key=quota_key,
            quota_value=quota_value,
            period_months=1,
            is_active=True,
        )

    def test_grant_addon_is_idempotent_and_updates_snapshot_metadata(self):
        package = self._create_package(quota_key="max_tables", quota_value=100)

        entitlement = AddonEntitlementService.grant_addon(
            organization_id=org_id_for("wt_addon_001"),
            addon_package_id=str(package.id),
            order_id="order_addon_001",
            purchased_by=str(self.user.id),
        )
        duplicated = AddonEntitlementService.grant_addon(
            organization_id=org_id_for("wt_addon_001"),
            addon_package_id=str(package.id),
            order_id="order_addon_001",
            purchased_by=str(self.user.id),
        )

        self.assertEqual(entitlement.id, duplicated.id)
        self.assertEqual(OrganizationAddonEntitlement.objects.filter(order_id="order_addon_001").count(), 1)
        self.assertEqual(AddonEntitlementService.get_addon_quota(org_id_for("wt_addon_001"), "max_tables"), 100)

        snapshot = OrganizationBillingEntitlement.objects.get(organization_id=org_id_for("wt_addon_001"))
        self.assertEqual(snapshot.metadata["addon_quotas"]["max_tables"], 100)
        self.assertEqual(snapshot.metadata["addon_entitlement_count"], 1)
        self.assertEqual(snapshot.included_media_monthly, 2)
        self.assertEqual(snapshot.included_search_monthly, 3)
        self.assertEqual(snapshot.included_tts_monthly, 4)

    def test_expire_addons_removes_quota_from_snapshot(self):
        package = self._create_package(quota_key="max_groups", quota_value=50)
        AddonEntitlementService.grant_addon(
            organization_id=org_id_for("wt_addon_expire"),
            addon_package_id=str(package.id),
            order_id="order_addon_expire",
            purchased_by=str(self.user.id),
        )
        entitlement = OrganizationAddonEntitlement.objects.get(order_id="order_addon_expire")
        entitlement.expires_at = timezone.now() - timedelta(minutes=1)
        entitlement.save(update_fields=["expires_at", "updated_at"])

        result = AddonEntitlementService.expire_addons(organization_id=org_id_for("wt_addon_expire"))

        entitlement.refresh_from_db()
        snapshot = OrganizationBillingEntitlement.objects.get(organization_id=org_id_for("wt_addon_expire"))
        self.assertEqual(result["expired_count"], 1)
        self.assertEqual(entitlement.status, "expired")
        self.assertEqual(AddonEntitlementService.get_addon_quota(org_id_for("wt_addon_expire"), "max_groups"), 0)
        self.assertEqual(snapshot.metadata["addon_quotas"], {})
        self.assertEqual(snapshot.metadata["addon_entitlement_count"], 0)

    def test_paid_billing_addon_order_grants_entitlement_and_completes(self):
        package = self._create_package(quota_key="max_documents", quota_value=1000)
        order = PaymentOrder.objects.create(
            user=self.user,
            organization_id=org_id_for("wt_addon_order"),
            order_type="billing_addon",
            subject="文档扩容包",
            description="测试文档扩容",
            amount=package.price,
            payment_method="alipay",
            status="paid",
            expired_at=timezone.now() + timedelta(minutes=30),
            business_data={
                "organization_id": org_id_for("wt_addon_order"),
                "addon_package_id": str(package.id),
            },
        )

        result = OrderBenefitService.grant(order.id)

        order.refresh_from_db()
        entitlement = OrganizationAddonEntitlement.objects.get(order_id=str(order.id))
        self.assertEqual(result, order.id)
        self.assertEqual(order.status, "completed")
        self.assertEqual(entitlement.quota_key, "max_documents")
        self.assertEqual(entitlement.quota_value, 1000)
        self.assertEqual(AddonEntitlementService.get_addon_quota(org_id_for("wt_addon_order"), "max_documents"), 1000)

    def test_paid_order_uses_snapshot_when_package_is_changed_after_checkout(self):
        package = self._create_package(quota_key="max_tables", quota_value=100)
        order = PaymentOrder.objects.create(
            user=self.user,
            organization_id=org_id_for("wt_addon_snapshot"),
            order_type="billing_addon",
            subject="表格扩容包",
            description="测试快照发放",
            amount=package.price,
            payment_method="alipay",
            status="paid",
            expired_at=timezone.now() + timedelta(minutes=30),
            business_data={
                "organization_id": org_id_for("wt_addon_snapshot"),
                "addon_package_id": str(package.id),
                "addon_code": package.addon_code,
                "addon_name": package.addon_name,
                "quota_key": "max_tables",
                "quota_value": 100,
                "period_months": 1,
            },
        )
        package.quota_value = 999
        package.is_active = False
        package.save(update_fields=["quota_value", "is_active", "updated_at"])

        OrderBenefitService.grant(order.id)

        entitlement = OrganizationAddonEntitlement.objects.get(order_id=str(order.id))
        self.assertEqual(entitlement.quota_key, "max_tables")
        self.assertEqual(entitlement.quota_value, 100)
        self.assertFalse(entitlement.metadata["source_package_active"])

    def test_addon_quota_extends_membership_quota_service_limit(self):
        package = self._create_package(quota_key="max_tables", quota_value=100)
        AddonEntitlementService.grant_addon(
            organization_id=org_id_for("wt_addon_quota"),
            addon_package_id=str(package.id),
            order_id="order_addon_quota",
            purchased_by=str(self.user.id),
        )

        result = QuotaService().check_quota(
            quota_type="max_tables",
            organization_id=org_id_for("wt_addon_quota"),
            current_usage=20,
        )

        self.assertEqual(result["limit"], 110)
        self.assertEqual(result["addon_limit"], 100)
        self.assertEqual(result["remaining"], 90)

    def test_document_and_group_addons_extend_quota_service_limits(self):
        document_package = self._create_package(quota_key="max_documents", quota_value=1000)
        group_package = self._create_package(quota_key="max_groups", quota_value=50)
        AddonEntitlementService.grant_addon(
            organization_id=org_id_for("wt_addon_doc_group"),
            addon_package_id=str(document_package.id),
            order_id="order_addon_documents",
            purchased_by=str(self.user.id),
        )
        AddonEntitlementService.grant_addon(
            organization_id=org_id_for("wt_addon_doc_group"),
            addon_package_id=str(group_package.id),
            order_id="order_addon_groups",
            purchased_by=str(self.user.id),
        )

        document_result = QuotaService().check_quota(
            quota_type="max_documents",
            organization_id=org_id_for("wt_addon_doc_group"),
            current_usage=20,
        )
        group_result = QuotaService().check_quota(
            quota_type="max_groups",
            organization_id=org_id_for("wt_addon_doc_group"),
            current_usage=20,
        )

        self.assertEqual(document_result["addon_limit"], 1000)
        self.assertEqual(group_result["addon_limit"], 50)
        self.assertGreaterEqual(document_result["limit"], 1000)
        self.assertGreaterEqual(group_result["limit"], 50)

    def test_organization_membership_status_includes_active_addon_quotas(self):
        document_package = self._create_package(quota_key="max_documents", quota_value=1000)
        storage_package = self._create_package(quota_key="storage_quota_bytes", quota_value=1234)
        AddonEntitlementService.grant_addon(
            organization_id=org_id_for("wt_addon_status"),
            addon_package_id=str(document_package.id),
            order_id="order_addon_status_documents",
            purchased_by=str(self.user.id),
        )
        AddonEntitlementService.grant_addon(
            organization_id=org_id_for("wt_addon_status"),
            addon_package_id=str(storage_package.id),
            order_id="order_addon_status_storage",
            purchased_by=str(self.user.id),
        )

        status = OrganizationMembershipService().check_membership_status(org_id_for("wt_addon_status"))
        quotas = status["quotas"]
        quota_usage = status["quota_usage"]

        free_tier = MembershipTier.objects.get(tier_type="free")
        self.assertEqual(quotas["max_documents"], 1000 + free_tier.max_documents)
        self.assertEqual(quotas["included_storage_bytes"], 1234)
        self.assertEqual(quotas["addon_quotas"]["max_documents"], 1000)
        self.assertEqual(quotas["addon_quotas"]["storage_quota_bytes"], 1234)
        self.assertEqual(quota_usage["max_documents"]["used"], 0)
        self.assertEqual(quota_usage["max_documents"]["limit"], 1000 + free_tier.max_documents)
        self.assertEqual(quota_usage["max_documents"]["plan_limit"], free_tier.max_documents)
        self.assertEqual(quota_usage["max_documents"]["addon_limit"], 1000)
        self.assertEqual(quota_usage["included_storage_bytes"]["used"], 0)
        self.assertEqual(quota_usage["included_storage_bytes"]["limit"], 1234)
        self.assertEqual(quota_usage["included_storage_bytes"]["addon_limit"], 1234)

    def test_organization_membership_status_keeps_unlimited_storage_with_addon(self):
        free_tier = MembershipTier.objects.get(tier_type="free")
        free_tier.included_storage_bytes = -1
        free_tier.save(update_fields=["included_storage_bytes"])
        storage_package = self._create_package(quota_key="storage_quota_bytes", quota_value=1234)
        AddonEntitlementService.grant_addon(
            organization_id=org_id_for("wt_addon_unlimited_storage"),
            addon_package_id=str(storage_package.id),
            order_id="order_addon_unlimited_storage",
            purchased_by=str(self.user.id),
        )

        status = OrganizationMembershipService().check_membership_status(org_id_for("wt_addon_unlimited_storage"))

        self.assertEqual(status["quotas"]["included_storage_bytes"], -1)
        self.assertEqual(status["quota_usage"]["included_storage_bytes"]["limit"], -1)
        self.assertEqual(status["quota_usage"]["included_storage_bytes"]["plan_limit"], -1)
        self.assertEqual(status["quota_usage"]["included_storage_bytes"]["addon_limit"], 1234)

    def test_storage_quota_addon_enters_storage_snapshot(self):
        package = self._create_package(quota_key="storage_quota_bytes", quota_value=1234)

        AddonEntitlementService.grant_addon(
            organization_id=org_id_for("wt_addon_storage"),
            addon_package_id=str(package.id),
            order_id="order_addon_storage",
            purchased_by=str(self.user.id),
        )

        snapshot = OrganizationBillingEntitlement.objects.get(organization_id=org_id_for("wt_addon_storage"))
        self.assertEqual(snapshot.purchased_storage_bytes, 1234)
        self.assertEqual(snapshot.metadata["active_addon_storage_bytes"], 1234)
        self.assertEqual(snapshot.metadata["addon_quotas"]["storage_quota_bytes"], 1234)

    def test_storage_quota_addon_does_not_duplicate_on_resync(self):
        package = self._create_package(quota_key="storage_quota_bytes", quota_value=1234)

        AddonEntitlementService.grant_addon(
            organization_id=org_id_for("wt_addon_storage_resync"),
            addon_package_id=str(package.id),
            order_id="order_addon_storage_resync",
            purchased_by=str(self.user.id),
        )
        AddonEntitlementService._sync_entitlement_metadata(org_id_for("wt_addon_storage_resync"))

        snapshot = OrganizationBillingEntitlement.objects.get(organization_id=org_id_for("wt_addon_storage_resync"))
        self.assertEqual(snapshot.purchased_storage_bytes, 1234)
        self.assertEqual(snapshot.metadata["manual_purchased_storage_bytes"], 0)
        self.assertEqual(snapshot.metadata["active_addon_storage_bytes"], 1234)

    def test_storage_quota_addon_releases_capacity_after_expire(self):
        package = self._create_package(quota_key="storage_quota_bytes", quota_value=1234)

        AddonEntitlementService.grant_addon(
            organization_id=org_id_for("wt_addon_storage_expire"),
            addon_package_id=str(package.id),
            order_id="order_addon_storage_expire",
            purchased_by=str(self.user.id),
        )
        entitlement = OrganizationAddonEntitlement.objects.get(order_id="order_addon_storage_expire")
        entitlement.expires_at = timezone.now() - timedelta(minutes=1)
        entitlement.save(update_fields=["expires_at", "updated_at"])

        AddonEntitlementService.expire_addons(organization_id=org_id_for("wt_addon_storage_expire"))

        snapshot = OrganizationBillingEntitlement.objects.get(organization_id=org_id_for("wt_addon_storage_expire"))
        self.assertEqual(snapshot.purchased_storage_bytes, 0)
        self.assertEqual(snapshot.included_storage_bytes + snapshot.purchased_storage_bytes, 0)
        self.assertEqual(snapshot.metadata["active_addon_storage_bytes"], 0)
        self.assertEqual(snapshot.metadata["addon_quotas"], {})

    def test_billing_addon_order_overwrites_client_supplied_quota_snapshot(self):
        package = self._create_package(quota_key="max_tables", quota_value=100)

        business_data = _hydrate_billing_addon_business_data(
            {
                "addon_package_id": str(package.id),
                "organization_id": org_id_for("wt_addon_snapshot_guard"),
                "quota_key": "storage_quota_bytes",
                "quota_value": 999999999,
                "period_months": 120,
            },
            package.price,
        )

        self.assertEqual(business_data["quota_key"], "max_tables")
        self.assertEqual(business_data["quota_value"], 100)
        self.assertEqual(business_data["period_months"], 1)
        self.assertEqual(business_data["addon_code"], package.addon_code)
