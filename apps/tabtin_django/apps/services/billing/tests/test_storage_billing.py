from datetime import timedelta
from decimal import Decimal

from django.test import TestCase, override_settings
from django.utils import timezone

from apps.services.billing.models import (
    BillingUsageEvent,
    MeterPricing,
    StoragePackagePlan,
    OrganizationBillingEntitlement,
    OrganizationBillingPolicy,
    OrganizationStorageSubscription,
    OrganizationStorageUsage,
)
from apps.services.billing.services import (
    OrganizationEntitlementSyncService,
    OrganizationStorageBillingService,
    OrganizationStoragePackageService,
)
from apps.services.billing.services.policy_service import OrganizationBillingPolicyService
from apps.users.membership.models import MembershipTier
from apps.services.billing.tests.org_test_utils import org_id_for


@override_settings(BILLING_LEGACY_NON_LLM_USAGE_CHARGE_ENABLED=True)
class OrganizationStorageBillingServiceTests(TestCase):
    databases = {"default"}

    def test_apply_positive_delta_updates_snapshot_and_event(self):
        usage = OrganizationStorageBillingService.apply_storage_delta(
            organization_id=org_id_for("ws_storage_001"),
            file_id="file_001",
            delta_bytes=1024,
            user_id="user_001",
            biz_type="attachment_upload",
            biz_id="ref_001",
        )

        usage.refresh_from_db()
        self.assertEqual(usage.active_storage_bytes, 1024)
        self.assertEqual(usage.active_file_count, 1)
        self.assertEqual(usage.total_uploaded_bytes, 1024)

        event = BillingUsageEvent.objects.get(organization_id=org_id_for("ws_storage_001"), biz_id="ref_001")
        self.assertEqual(event.meter_key, "storage.bytes")
        self.assertEqual(event.quantity, Decimal("1024"))
        self.assertEqual(event.amount, Decimal("0E-8"))

    def test_release_delta_clamps_to_zero(self):
        OrganizationStorageBillingService.apply_storage_delta(
            organization_id=org_id_for("ws_storage_002"),
            file_id="file_002",
            delta_bytes=100,
            biz_id="alloc_002",
        )

        usage = OrganizationStorageBillingService.apply_storage_delta(
            organization_id=org_id_for("ws_storage_002"),
            file_id="file_002",
            delta_bytes=-9999,
            biz_id="release_002",
        )

        usage.refresh_from_db()
        self.assertEqual(usage.active_storage_bytes, 0)
        self.assertEqual(usage.active_file_count, 0)
        self.assertEqual(usage.total_released_bytes, 100)

        release_event = BillingUsageEvent.objects.get(organization_id=org_id_for("ws_storage_002"), biz_id="release_002")
        self.assertEqual(release_event.quantity, Decimal("-100"))

    def test_fallback_to_storage_gb_price(self):
        MeterPricing.objects.create(
            meter_key="storage.gb",
            scope="organization",
            organization_id=org_id_for("ws_storage_003"),
            unit="gb",
            unit_price=Decimal("2.00000000"),
            currency="CREDITS",
            precision=8,
            is_active=True,
            priority=100,
        )

        one_gb = 1024 ** 3
        OrganizationStorageBillingService.apply_storage_delta(
            organization_id=org_id_for("ws_storage_003"),
            file_id="file_003",
            delta_bytes=one_gb,
            biz_id="alloc_003",
        )

        event = BillingUsageEvent.objects.get(organization_id=org_id_for("ws_storage_003"), biz_id="alloc_003")
        self.assertEqual(event.amount, Decimal("2.00000000"))
        usage = OrganizationStorageUsage.objects.get(organization_id=org_id_for("ws_storage_003"))
        self.assertEqual(usage.active_storage_bytes, one_gb)

    def test_package_plus_paygo_only_bills_overage(self):
        OrganizationBillingPolicy.objects.create(
            organization_id=org_id_for("ws_storage_004"),
            storage_billing_mode="package_plus_paygo",
            llm_billing_mode="paygo_only",
            currency="CREDITS",
            is_active=True,
        )
        OrganizationBillingEntitlement.objects.create(
            organization_id=org_id_for("ws_storage_004"),
            included_storage_bytes=100,
            purchased_storage_bytes=0,
            included_llm_credits_monthly=Decimal("0"),
            is_active=True,
        )
        MeterPricing.objects.create(
            meter_key="storage.bytes",
            scope="organization",
            organization_id=org_id_for("ws_storage_004"),
            unit="bytes",
            unit_price=Decimal("1.00000000"),
            currency="CREDITS",
            precision=8,
            is_active=True,
            priority=100,
        )

        OrganizationStorageBillingService.apply_storage_delta(
            organization_id=org_id_for("ws_storage_004"),
            file_id="file_004",
            delta_bytes=150,
            biz_id="alloc_004",
        )
        event = BillingUsageEvent.objects.get(organization_id=org_id_for("ws_storage_004"), biz_id="alloc_004")
        self.assertEqual(event.quantity, Decimal("150"))
        self.assertEqual(event.amount, Decimal("50.00000000"))

    def test_package_only_rejects_upload_precheck(self):
        OrganizationBillingPolicy.objects.create(
            organization_id=org_id_for("ws_storage_005"),
            storage_billing_mode="package_only",
            llm_billing_mode="paygo_only",
            currency="CREDITS",
            is_active=True,
        )
        OrganizationBillingEntitlement.objects.create(
            organization_id=org_id_for("ws_storage_005"),
            included_storage_bytes=100,
            purchased_storage_bytes=0,
            included_llm_credits_monthly=Decimal("0"),
            is_active=True,
        )
        OrganizationStorageUsage.objects.create(
            organization_id=org_id_for("ws_storage_005"),
            active_file_count=1,
            active_storage_bytes=90,
            total_uploaded_bytes=90,
            total_released_bytes=0,
        )

        with self.assertRaises(ValueError):
            OrganizationStorageBillingService.assert_storage_upload_allowed(
                organization_id=org_id_for("ws_storage_005"),
                incoming_bytes=20,
            )

    def test_package_plus_paygo_still_rejects_entitlement_overage_on_upload(self):
        """存储是权益硬上限，历史按量策略不得放行新的超额上传。"""
        OrganizationBillingPolicy.objects.create(
            organization_id=org_id_for("ws_storage_entitlement_guard"),
            storage_billing_mode="package_plus_paygo",
            llm_billing_mode="paygo_only",
            currency="CREDITS",
            is_active=True,
        )
        OrganizationBillingEntitlement.objects.create(
            organization_id=org_id_for("ws_storage_entitlement_guard"),
            included_storage_bytes=100,
            purchased_storage_bytes=0,
            included_llm_credits_monthly=Decimal("0"),
            is_active=True,
        )
        OrganizationStorageUsage.objects.create(
            organization_id=org_id_for("ws_storage_entitlement_guard"),
            active_file_count=1,
            active_storage_bytes=100,
            total_uploaded_bytes=100,
            total_released_bytes=0,
        )

        with self.assertRaisesRegex(ValueError, "附件空间不足"):
            OrganizationStorageBillingService.assert_storage_upload_allowed(
                organization_id=org_id_for("ws_storage_entitlement_guard"),
                incoming_bytes=1,
            )

    def test_storage_overage_message_uses_mb_for_package_and_projected_usage(self):
        organization_id = org_id_for("ws_storage_overage_message_mb")
        mib = 1024 ** 2
        OrganizationBillingPolicy.objects.create(
            organization_id=organization_id,
            storage_billing_mode="package_plus_paygo",
            llm_billing_mode="paygo_only",
            currency="CREDITS",
            is_active=True,
        )
        OrganizationBillingEntitlement.objects.create(
            organization_id=organization_id,
            included_storage_bytes=500 * mib,
            purchased_storage_bytes=0,
            included_llm_credits_monthly=Decimal("0"),
            is_active=True,
        )
        OrganizationStorageUsage.objects.create(
            organization_id=organization_id,
            active_file_count=1,
            active_storage_bytes=490 * mib,
            total_uploaded_bytes=490 * mib,
            total_released_bytes=0,
        )

        with self.assertRaisesRegex(
            ValueError,
            r"剩余存储空间不足.*套餐容量 500\.00MB，本次后预计占用 501\.00MB",
        ):
            OrganizationStorageBillingService.assert_storage_upload_allowed(
                organization_id=organization_id,
                incoming_bytes=11 * mib,
            )

    def test_package_only_evaluation_exposes_available_bytes(self):
        OrganizationBillingPolicy.objects.create(
            organization_id=org_id_for("ws_storage_006"),
            storage_billing_mode="package_only",
            llm_billing_mode="paygo_only",
            currency="CREDITS",
            is_active=True,
        )
        OrganizationBillingEntitlement.objects.create(
            organization_id=org_id_for("ws_storage_006"),
            included_storage_bytes=100,
            purchased_storage_bytes=0,
            included_llm_credits_monthly=Decimal("0"),
            is_active=True,
        )
        OrganizationStorageUsage.objects.create(
            organization_id=org_id_for("ws_storage_006"),
            active_file_count=1,
            active_storage_bytes=80,
            total_uploaded_bytes=80,
            total_released_bytes=0,
        )

        decision = OrganizationStorageBillingService.evaluate_storage_upload(
            organization_id=org_id_for("ws_storage_006"),
            incoming_bytes=30,
        )

        self.assertFalse(decision["allowed"])
        self.assertEqual(decision["available_bytes"], 20)
        self.assertEqual(decision["remaining_package_bytes"], 20)
        self.assertEqual(decision["projected_remaining_package_bytes"], 0)
        self.assertEqual(decision["projected_exceeded_bytes"], 10)


class ReconcileOrganizationStorageTests(TestCase):
    databases = {"default"}

    def test_reconcile_no_snapshot(self):
        """无 OrganizationStorageUsage → 返回 corrected=False, reason='no_snapshot'"""
        result = OrganizationStorageBillingService.reconcile_organization_storage(org_id_for("ws_reconcile_none"))
        self.assertFalse(result["corrected"])
        self.assertEqual(result["reason"], "no_snapshot")

    def test_reconcile_no_drift(self):
        """快照与 FileRecord 一致 → 返回 corrected=False, reason='no_drift'"""
        OrganizationStorageUsage.objects.create(
            organization_id=org_id_for("ws_reconcile_nodrift"),
            active_file_count=0,
            active_storage_bytes=0,
            total_uploaded_bytes=0,
            total_released_bytes=0,
        )
        result = OrganizationStorageBillingService.reconcile_organization_storage(org_id_for("ws_reconcile_nodrift"))
        self.assertFalse(result["corrected"])
        self.assertEqual(result["reason"], "no_drift")

    def test_reconcile_with_drift(self):
        """快照与 FileRecord 不一致 → 返回 corrected=True，快照被校准"""
        from apps.services.oss.models import FileRecord

        ws_id = org_id_for("ws_reconcile_drift")
        OrganizationStorageUsage.objects.create(
            organization_id=ws_id,
            active_file_count=5,
            active_storage_bytes=5000,
            total_uploaded_bytes=5000,
            total_released_bytes=0,
        )
        FileRecord.objects.create(
            file_name="test_file.txt",
            file_key="test/abc.txt",
            file_size=1024,
            file_type="document",
            status="completed",
            organization_id=ws_id,
        )

        result = OrganizationStorageBillingService.reconcile_organization_storage(ws_id)
        self.assertTrue(result["corrected"])
        self.assertEqual(result["real_bytes"], 1024)
        self.assertEqual(result["real_count"], 1)

        usage = OrganizationStorageUsage.objects.get(organization_id=ws_id)
        self.assertEqual(usage.active_storage_bytes, 1024)
        self.assertEqual(usage.active_file_count, 1)

    def test_reconcile_uses_select_for_update(self):
        """用 mock 验证 select_for_update 被调用"""
        from unittest.mock import patch, MagicMock

        ws_id = org_id_for("ws_reconcile_lock")
        OrganizationStorageUsage.objects.create(
            organization_id=ws_id,
            active_file_count=0,
            active_storage_bytes=0,
            total_uploaded_bytes=0,
            total_released_bytes=0,
        )

        original_method = OrganizationStorageUsage.objects.select_for_update

        call_tracker = {"called": False}

        def tracking_select_for_update(*args, **kwargs):
            call_tracker["called"] = True
            return original_method(*args, **kwargs)

        with patch.object(
            type(OrganizationStorageUsage.objects),
            "select_for_update",
            side_effect=tracking_select_for_update,
            autospec=False,
        ):
            OrganizationStorageBillingService.reconcile_organization_storage(ws_id)

        self.assertTrue(call_tracker["called"])


class OrganizationEntitlementSyncServiceTests(TestCase):
    databases = {"default"}

    def test_sync_defaults_to_free_tier(self):
        MembershipTier.objects.create(
            tier_type="free",
            name="免费版",
            description="",
            price=Decimal("0"),
            duration_months=1,
            included_storage_bytes=512,
            included_llm_credits_monthly=Decimal("3"),
            is_active=True,
        )

        entitlement = OrganizationEntitlementSyncService.sync_organization_entitlement(org_id_for("ws_ent_free"))

        self.assertEqual(entitlement.included_storage_bytes, 512)
        self.assertEqual(entitlement.included_llm_credits_monthly, Decimal("3"))
        self.assertEqual(entitlement.purchased_storage_bytes, 0)
        self.assertEqual(entitlement.metadata.get("entitlement_source"), "free_tier")

    def test_sync_does_not_treat_zero_provision_defaults_as_manual_override(self):
        MembershipTier.objects.create(
            tier_type="free",
            name="免费版",
            description="",
            price=Decimal("0"),
            duration_months=1,
            included_storage_bytes=512,
            included_llm_credits_monthly=Decimal("100"),
            is_active=True,
        )
        OrganizationBillingEntitlement.objects.create(
            organization_id=org_id_for("ws_ent_provisioned_zero"),
            included_storage_bytes=0,
            included_llm_credits_monthly=Decimal("0"),
            is_active=True,
            metadata={},
        )

        entitlement = OrganizationEntitlementSyncService.sync_organization_entitlement(org_id_for("ws_ent_provisioned_zero"))

        self.assertEqual(entitlement.included_storage_bytes, 512)
        self.assertEqual(entitlement.included_llm_credits_monthly, Decimal("100"))
        self.assertEqual(entitlement.metadata.get("entitlement_source"), "free_tier")
        self.assertNotIn("manual_included_storage_bytes", entitlement.metadata)
        self.assertNotIn("manual_included_llm_credits_monthly", entitlement.metadata)

    def test_sync_preserves_explicit_manual_zero_override(self):
        MembershipTier.objects.create(
            tier_type="free",
            name="免费版",
            description="",
            price=Decimal("0"),
            duration_months=1,
            included_storage_bytes=512,
            included_llm_credits_monthly=Decimal("100"),
            is_active=True,
        )
        OrganizationBillingEntitlement.objects.create(
            organization_id=org_id_for("ws_ent_manual_zero"),
            included_storage_bytes=0,
            included_llm_credits_monthly=Decimal("0"),
            is_active=True,
            metadata={
                "manual_included_storage_bytes": 0,
                "manual_included_llm_credits_monthly": "0",
            },
        )

        entitlement = OrganizationEntitlementSyncService.sync_organization_entitlement(org_id_for("ws_ent_manual_zero"))

        self.assertEqual(entitlement.included_storage_bytes, 0)
        self.assertEqual(entitlement.included_llm_credits_monthly, Decimal("0"))
        self.assertEqual(entitlement.metadata.get("manual_included_storage_bytes"), 0)
        self.assertEqual(entitlement.metadata.get("manual_included_llm_credits_monthly"), "0")

    def test_snapshot_includes_active_storage_subscriptions(self):
        MembershipTier.objects.create(
            tier_type="free",
            name="免费版",
            description="",
            price=Decimal("0"),
            duration_months=1,
            included_storage_bytes=100,
            included_llm_credits_monthly=Decimal("0"),
            is_active=True,
        )
        entitlement = OrganizationBillingEntitlement.objects.create(
            organization_id=org_id_for("ws_ent_sub"),
            included_storage_bytes=100,
            purchased_storage_bytes=20,
            included_llm_credits_monthly=Decimal("0"),
            is_active=True,
            metadata={
                "storage_subscription_bytes": 0,
            },
        )
        plan = StoragePackagePlan.objects.create(
            name="10GB 月包",
            description="",
            price=Decimal("9.90"),
            storage_bytes=30,
            bonus_storage_bytes=10,
            duration_months=1,
            is_active=True,
        )
        OrganizationStorageSubscription.objects.create(
            organization_id=org_id_for("ws_ent_sub"),
            package_plan=plan,
            storage_bytes=40,
            start_at=timezone.now() - timedelta(hours=1),
            end_at=timezone.now() + timedelta(days=30),
            status="active",
        )

        snapshot = OrganizationBillingPolicyService.get_entitlement_snapshot(org_id_for("ws_ent_sub"))

        self.assertEqual(snapshot["included_storage_bytes"], 100)
        self.assertEqual(snapshot["purchased_storage_bytes"], 60)
        self.assertEqual(snapshot["storage_package_bytes"], 160)


class OrganizationStoragePackageServiceTests(TestCase):
    databases = {"default"}

    def setUp(self):
        MembershipTier.objects.create(
            tier_type="free",
            name="免费版",
            description="",
            price=Decimal("0"),
            duration_months=1,
            included_storage_bytes=0,
            included_llm_credits_monthly=Decimal("0"),
            is_active=True,
        )

    def test_activate_storage_package_updates_entitlement_and_is_idempotent(self):
        plan = StoragePackagePlan.objects.create(
            name="20GB 月包",
            description="",
            price=Decimal("19.90"),
            storage_bytes=20,
            bonus_storage_bytes=5,
            duration_months=1,
            is_active=True,
        )

        subscription = OrganizationStoragePackageService.activate_storage_package(
            organization_id=org_id_for("ws_pkg_001"),
            package_plan_id=str(plan.id),
            order_id="order_pkg_001",
            purchased_by="user_001",
        )
        duplicated = OrganizationStoragePackageService.activate_storage_package(
            organization_id=org_id_for("ws_pkg_001"),
            package_plan_id=str(plan.id),
            order_id="order_pkg_001",
            purchased_by="user_001",
        )

        self.assertEqual(subscription.id, duplicated.id)
        self.assertEqual(
            OrganizationStorageSubscription.objects.filter(order_id="order_pkg_001").count(),
            1,
        )
        entitlement = OrganizationBillingEntitlement.objects.get(organization_id=org_id_for("ws_pkg_001"))
        self.assertEqual(entitlement.purchased_storage_bytes, 25)
        self.assertEqual(entitlement.metadata.get("storage_subscription_bytes"), 25)

    def test_expire_due_subscriptions_syncs_entitlement_back_to_zero(self):
        plan = StoragePackagePlan.objects.create(
            name="10GB 月包",
            description="",
            price=Decimal("9.90"),
            storage_bytes=10,
            bonus_storage_bytes=2,
            duration_months=1,
            is_active=True,
        )

        OrganizationStoragePackageService.activate_storage_package(
            organization_id=org_id_for("ws_pkg_expire_001"),
            package_plan_id=str(plan.id),
            order_id="order_pkg_expire_001",
            purchased_by="user_001",
        )
        subscription = OrganizationStorageSubscription.objects.get(order_id="order_pkg_expire_001")
        subscription.end_at = timezone.now() - timedelta(minutes=1)
        subscription.save(update_fields=["end_at", "updated_at"])

        result = OrganizationStoragePackageService.expire_due_subscriptions(organization_id=org_id_for("ws_pkg_expire_001"))

        subscription.refresh_from_db()
        entitlement = OrganizationBillingEntitlement.objects.get(organization_id=org_id_for("ws_pkg_expire_001"))
        self.assertEqual(result["expired_count"], 1)
        self.assertEqual(result["organization_ids"], [org_id_for("ws_pkg_expire_001")])
        self.assertEqual(subscription.status, "expired")
        self.assertEqual(entitlement.purchased_storage_bytes, 0)
        self.assertEqual(entitlement.metadata.get("storage_subscription_bytes"), 0)
