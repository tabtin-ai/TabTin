from __future__ import annotations

from contextlib import nullcontext
import uuid
from datetime import date, timedelta
from decimal import Decimal
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.test import SimpleTestCase, TestCase
from django.utils import timezone

from apps.services.billing.models import (
    AddonPackage,
    BillingAdminAuditLog,
    BillingAnomalyAlert,
    BillingBudgetPolicy,
    BillingInvoice,
    BillingInvoiceLine,
    BillingReconciliationReport,
    BillingUsageDaily,
    BillingUsageEvent,
    MeterPricing,
    MemberLlmBudgetPolicy,
    MemberLlmUsageCounter,
    OrganizationAddonEntitlement,
    StoragePackagePlan,
    OrganizationLifecycleCleanupJob,
    OrganizationBillingEntitlement,
    OrganizationBillingPolicy,
    OrganizationLlmMonthlyBudget,
    OrganizationServicePolicy,
    OrganizationStorageSubscription,
    OrganizationStorageUsage,
    ProviderCreditCampaign,
    ProviderCreditGrant,
    ProviderCreditTransaction,
)
from apps.services.billing.services.organization_lifecycle_cleanup_service import (
    OrganizationLifecycleCleanupService,
)
from apps.services.billing.services.provider_credit_service import ProviderCreditService
from apps.services.billing.tasks import retry_organization_lifecycle_cleanups
from apps.services.oss.models import FileRecord, FileUsage, OSSAdminActionLog, UploadTask
from apps.services.payment.models import PaymentCallback, PaymentOrder
from apps.users.wallet.models import WalletTransaction, OrganizationWallet
from apps.services.billing.tests.org_test_utils import org_id_for

User = get_user_model()


class OrganizationLifecycleCleanupCrossDbGuardTests(SimpleTestCase):
    @patch(
        "apps.services.billing.services.organization_lifecycle_cleanup_service.transaction.atomic",
        side_effect=lambda using=None: nullcontext(),
    )
    @patch("apps.tabtinspace.models.Organization.objects")
    @patch("apps.tabdata.models.AttachmentReference.objects")
    @patch("apps.tabdata.models.AttachmentUpload.objects")
    def test_cleanup_tabdata_artifacts_deletes_refs_before_uploads_when_organization_missing(
        self,
        mock_upload_objects,
        mock_reference_objects,
        mock_organization_objects,
        mock_atomic,
    ):
        reference_qs = mock_reference_objects.using.return_value.filter.return_value
        upload_qs = mock_upload_objects.using.return_value.filter.return_value
        reference_qs.count.return_value = 2
        upload_qs.count.return_value = 3
        #  墓碑管线：active 判定链变为 filter(...).exclude(status=deleting).exists()
        mock_organization_objects.using.return_value.filter.return_value.exclude.return_value.exists.return_value = False

        events = []
        reference_qs.delete.side_effect = lambda: events.append("references")
        upload_qs.delete.side_effect = lambda: events.append("uploads")

        with patch.object(OrganizationLifecycleCleanupService, "_is_app_installed", return_value=True):
            result = OrganizationLifecycleCleanupService._cleanup_tabdata_upload_artifacts(str(uuid.uuid4()))

        self.assertEqual(
            result,
            {
                "tabdata_attachment_references": 2,
                "tabdata_attachment_uploads": 3,
            },
        )
        self.assertEqual(events, ["references", "uploads"])

    @patch(
        "apps.services.billing.services.organization_lifecycle_cleanup_service.transaction.atomic",
        side_effect=lambda using=None: nullcontext(),
    )
    @patch("apps.tabtinspace.models.Organization.objects")
    @patch("apps.tabdata.models.AttachmentReference.objects")
    @patch("apps.tabdata.models.AttachmentUpload.objects")
    def test_cleanup_tabdata_artifacts_raises_when_organization_still_active(
        self,
        mock_upload_objects,
        mock_reference_objects,
        mock_organization_objects,
        mock_atomic,
    ):
        reference_qs = mock_reference_objects.using.return_value.filter.return_value
        upload_qs = mock_upload_objects.using.return_value.filter.return_value
        reference_qs.count.return_value = 1
        upload_qs.count.return_value = 1
        mock_organization_objects.using.return_value.filter.return_value.exclude.return_value.exists.return_value = True

        with patch.object(OrganizationLifecycleCleanupService, "_is_app_installed", return_value=True):
            with self.assertRaisesRegex(RuntimeError, "tabdata attachment artifacts still exist"):
                OrganizationLifecycleCleanupService._cleanup_tabdata_upload_artifacts(str(uuid.uuid4()))

        reference_qs.delete.assert_not_called()
        upload_qs.delete.assert_not_called()


class OrganizationLifecycleCleanupServiceTests(TestCase):
    databases = {"default", "postgresql"}

    @classmethod
    def setUpTestData(cls):
        cls.user = User.objects.create_user(
            username="organization_cleanup_user",
            email="organization_cleanup@test.com",
            password="pass123",
        )
        cls.package_plan = StoragePackagePlan.objects.create(
            name="50GB 月包",
            description="organization cleanup test",
            price=Decimal("19.90"),
            storage_bytes=50,
            bonus_storage_bytes=10,
            duration_months=1,
            is_active=True,
        )

    def _create_tombstoned_organization(self) -> str:
        """建一个 deleting 墓碑组织行（：FK 化后 seed 数据必须有真实父行；
        清理链也只允许对墓碑组织执行）。返回 str(organization.id)。"""
        from apps.tabtinspace.models import Organization

        organization = Organization.objects.create(
            name=f"cleanup-{uuid.uuid4().hex[:8]}",
            owner_id=self.user.id,
            type=Organization.OrganizationType.TEAM,
            status=Organization.Status.DELETING,
        )
        return str(organization.id)

    def _seed_organization_scope(self, organization_id: str, *, legacy_order: bool = False) -> dict:
        now = timezone.now()
        order = PaymentOrder.objects.create(
            user=self.user,
            organization_id="" if legacy_order else organization_id,
            order_type="storage_package",
            subject=f"{organization_id} 存储包",
            description="organization cleanup order",
            amount=Decimal("19.90"),
            payment_method="alipay",
            expired_at=now + timedelta(hours=1),
            business_data={
                "organization_id": organization_id,
                "storage_package_id": str(self.package_plan.id),
            },
        )
        callback = PaymentCallback.objects.create(
            order=order,
            payment_method="alipay",
            callback_data={"trade_no": f"trade_{organization_id}"},
        )

        usage_snapshot = OrganizationStorageUsage.objects.create(
            organization_id=organization_id,
            active_file_count=1,
            active_storage_bytes=1024,
            total_uploaded_bytes=1024,
            total_released_bytes=0,
        )
        policy = OrganizationBillingPolicy.objects.create(
            organization_id=organization_id,
            storage_billing_mode="package_plus_paygo",
            llm_billing_mode="quota_then_paygo",
            currency="CREDITS",
            is_active=True,
        )
        entitlement = OrganizationBillingEntitlement.objects.create(
            organization_id=organization_id,
            included_storage_bytes=512,
            purchased_storage_bytes=2048,
            included_llm_credits_monthly=Decimal("100"),
            is_active=True,
        )
        subscription = OrganizationStorageSubscription.objects.create(
            organization_id=organization_id,
            package_plan=self.package_plan,
            order_id=order.id,
            purchased_by=str(self.user.id),
            storage_bytes=self.package_plan.total_storage_bytes,
            start_at=now,
            end_at=now + timedelta(days=30),
            status="active",
        )
        llm_budget = OrganizationLlmMonthlyBudget.objects.create(
            organization_id=organization_id,
            cycle_month=date(2026, 3, 1),
            included_credits=Decimal("100"),
            consumed_credits=Decimal("10"),
        )
        usage_daily = BillingUsageDaily.objects.create(
            organization_id=organization_id,
            usage_date=date(2026, 3, 7),
            meter_key="storage.bytes",
            quantity=Decimal("1024"),
            amount=Decimal("5"),
            currency="CREDITS",
            source_event_count=1,
        )
        usage_event = BillingUsageEvent.objects.create(
            organization_id=organization_id,
            user_id=str(self.user.id),
            meter_key="storage.bytes",
            quantity=Decimal("1024"),
            unit="bytes",
            unit_price=Decimal("0.00488281"),
            amount=Decimal("5"),
            currency="CREDITS",
            biz_type="organization_cleanup",
            biz_id=f"biz_{organization_id}",
        )
        invoice = BillingInvoice.objects.create(
            invoice_no=f"INV-{organization_id}",
            organization_id=organization_id,
            period_start=date(2026, 3, 1),
            period_end=date(2026, 3, 31),
            status="open",
            total_amount=Decimal("5"),
        )
        invoice_line = BillingInvoiceLine.objects.create(
            invoice=invoice,
            organization_id=organization_id,
            meter_key="storage.bytes",
            description="organization cleanup line",
            quantity=Decimal("1024"),
            unit="bytes",
            unit_price=Decimal("0.00488281"),
            amount=Decimal("5"),
        )
        budget_policy = BillingBudgetPolicy.objects.create(
            organization_id=organization_id,
            warning_threshold_percent=Decimal("80"),
            critical_threshold_percent=Decimal("100"),
            block_on_critical=True,
            is_active=True,
        )
        service_policy = OrganizationServicePolicy.objects.create(
            organization_id=organization_id,
        )
        addon_package = AddonPackage.objects.create(
            addon_code=f"cleanup-{organization_id}",
            addon_name="organization cleanup addon",
            price=Decimal("1.00"),
            quota_key="max_tables",
            quota_value=1,
        )
        addon_entitlement = OrganizationAddonEntitlement.objects.create(
            organization_id=organization_id,
            addon_package=addon_package,
            quota_key="max_tables",
            quota_value=1,
            expires_at=now + timedelta(days=30),
        )
        member_budget_policy = MemberLlmBudgetPolicy.objects.create(
            organization_id=organization_id,
            user_id=str(self.user.id),
            monthly_credits_limit=Decimal("10"),
        )
        member_usage_counter = MemberLlmUsageCounter.objects.create(
            organization_id=organization_id,
            user_id=str(self.user.id),
            cycle_date=date(2026, 3, 1),
            cycle_type="monthly",
            consumed_credits=Decimal("1"),
        )
        provider_campaign = ProviderCreditService.create_campaign(
            code=f"CLEANUP-{organization_id}",
            name="organization cleanup provider credit",
            provider_key="volcengine",
            credits_amount=Decimal("100"),
            total_budget_credits=Decimal("100"),
        )
        provider_grant = ProviderCreditService.grant_credit(
            organization=organization_id,
            campaign=provider_campaign,
        )
        provider_transaction = ProviderCreditTransaction.objects.get(
            grant=provider_grant,
            transaction_type=ProviderCreditTransaction.TransactionType.GRANT,
        )
        reconciliation_report = BillingReconciliationReport.objects.create(
            report_date=date(2026, 3, 7),
            organization_id=organization_id,
            billing_total=Decimal("5"),
            wallet_total=Decimal("5"),
            diff_amount=Decimal("0"),
            diff_pct=Decimal("0"),
            status="matched",
        )
        anomaly = BillingAnomalyAlert.objects.create(
            alert_type="spike",
            severity="warning",
            organization_id=organization_id,
            user_id=str(self.user.id),
            metric_name="storage.bytes",
            current_value=Decimal("1024"),
            baseline_value=Decimal("256"),
            threshold_ratio=Decimal("4"),
            message=f"{organization_id} spike",
        )
        admin_audit = BillingAdminAuditLog.objects.create(
            admin_user_id=str(self.user.id),
            action="organization_cleanup",
            target_type="organization",
            target_id=organization_id,
            organization_id=organization_id,
            detail={"source": "test"},
        )
        organization_pricing = MeterPricing.objects.create(
            meter_key="storage.bytes",
            scope="organization",
            organization_id=organization_id,
            unit="bytes",
            unit_price=Decimal("0.00488281"),
            currency="CREDITS",
            precision=8,
            is_active=True,
            priority=100,
        )
        wallet = OrganizationWallet.objects.create(
            organization_id=organization_id,
            credits_precise=Decimal("50.0000"),
        )
        wallet_tx = WalletTransaction.objects.create(
            organization_wallet=wallet,
            organization_id=organization_id,
            transaction_type="consume",
            amount=5,
            amount_precise=Decimal("5.0000"),
            balance_before=50,
            balance_before_precise=Decimal("50.0000"),
            balance_after=45,
            balance_after_precise=Decimal("45.0000"),
            related_order_id=str(invoice.id),
            description="organization cleanup transaction",
        )
        file_record = FileRecord.objects.create(
            file_name=f"{organization_id}.txt",
            file_key=f"organization/{organization_id}/file.txt",
            file_path=f"/organization/{organization_id}/file.txt",
            file_size=1024,
            file_type="document",
            mime_type="text/plain",
            file_extension=".txt",
            file_hash=uuid.uuid4().hex,
            bucket_name="example-assets",
            organization_id=organization_id,
            status="completed",
        )
        file_usage = FileUsage.objects.create(
            file_record=file_record,
            user_id=uuid.uuid4(),
            module="tabdoc",
            context_type="document",
            context_id=f"doc_{organization_id}",
            is_active=True,
        )
        upload_task = UploadTask.objects.create(
            task_name=f"{organization_id} upload task",
            task_type="batch",
            total_files=1,
            completed_files=1,
            total_size=1024,
            uploaded_size=1024,
            status="completed",
            progress=100.0,
            created_by=str(self.user.id),
            organization_id=organization_id,
            result_data={"organization_id": organization_id},
        )
        upload_task.files.add(file_record)
        oss_admin_action_log = OSSAdminActionLog.objects.create(
            action_type="batch_delete",
            operator_name="cleanup-admin",
            organization_id=organization_id,
            organization_ids=[organization_id],
            organization_ids_text=f"|{organization_id}|",
            target_file_ids=[str(file_record.id)],
            target_file_ids_text=f"|{file_record.id}|",
            requested_count=1,
            processed_count=1,
            deleted_count=0,
            skipped_count=1,
            success=True,
            message="organization cleanup seed",
        )

        return {
            "order_id": order.id,
            "callback_id": callback.id,
            "usage_snapshot_id": usage_snapshot.id,
            "policy_id": policy.id,
            "entitlement_id": entitlement.id,
            "subscription_id": subscription.id,
            "llm_budget_id": llm_budget.id,
            "usage_daily_id": usage_daily.id,
            "usage_event_id": usage_event.id,
            "invoice_id": invoice.id,
            "invoice_line_id": invoice_line.id,
            "budget_policy_id": budget_policy.id,
            "service_policy_id": service_policy.id,
            "addon_package_id": addon_package.id,
            "addon_entitlement_id": addon_entitlement.id,
            "member_budget_policy_id": member_budget_policy.id,
            "member_usage_counter_id": member_usage_counter.id,
            "provider_campaign_id": provider_campaign.id,
            "provider_grant_id": provider_grant.id,
            "provider_transaction_id": provider_transaction.id,
            "reconciliation_report_id": reconciliation_report.id,
            "anomaly_id": anomaly.id,
            "admin_audit_id": admin_audit.id,
            "organization_pricing_id": organization_pricing.id,
            "wallet_id": wallet.id,
            "wallet_tx_id": wallet_tx.id,
            "file_record_id": file_record.id,
            "file_usage_id": file_usage.id,
            "upload_task_id": upload_task.id,
            "oss_admin_action_log_id": oss_admin_action_log.id,
        }

    def test_cleanup_organization_removes_organization_scoped_default_db_records(self):
        global_pricing = MeterPricing.objects.create(
            meter_key="storage.bytes",
            scope="global",
            unit="bytes",
            unit_price=Decimal("0.00000001"),
            currency="CREDITS",
            precision=8,
            is_active=True,
            priority=1,
        )
        target_org_id = self._create_tombstoned_organization()
        other_org_id = self._create_tombstoned_organization()
        target = self._seed_organization_scope(target_org_id, legacy_order=True)
        other = self._seed_organization_scope(other_org_id)
        mixed_admin_log = OSSAdminActionLog.objects.create(
            action_type="batch_delete",
            operator_name="cleanup-admin",
            organization_id="",
            organization_ids=[other_org_id, target_org_id],
            organization_ids_text=f"|{other_org_id}|{target_org_id}|",
            target_file_ids=[str(target["file_record_id"]), str(other["file_record_id"])],
            target_file_ids_text=f"|{target['file_record_id']}|{other['file_record_id']}|",
            requested_count=2,
            processed_count=2,
            deleted_count=0,
            skipped_count=2,
            success=True,
            message="mixed organization action",
        )

        summary = OrganizationLifecycleCleanupService.cleanup_organization(target_org_id)

        self.assertEqual(summary["payment_orders"], 1)
        self.assertEqual(summary["payment_callbacks"], 1)
        self.assertEqual(summary["organization_wallets"], 1)
        self.assertEqual(summary["wallet_transactions"], 1)
        self.assertEqual(summary["file_records"], 1)
        self.assertEqual(summary["file_records_orphaned"], 1)
        self.assertEqual(summary["file_records_deleted"], 0)
        self.assertEqual(summary["file_usages"], 1)
        self.assertEqual(summary["oss_upload_tasks"], 1)
        self.assertEqual(summary["oss_admin_action_logs"], 1)
        self.assertEqual(summary["tabdata_attachment_references"], 0)
        self.assertEqual(summary["tabdata_attachment_uploads"], 0)
        self.assertEqual(summary["billing_invoices"], 1)
        self.assertEqual(summary["billing_invoice_lines"], 1)
        self.assertEqual(summary["meter_pricing"], 1)
        self.assertEqual(summary["organization_service_policies"], 1)
        self.assertEqual(summary["organization_addon_entitlements"], 1)
        self.assertEqual(summary["member_llm_budget_policies"], 1)
        self.assertEqual(summary["member_llm_usage_counters"], 1)
        self.assertEqual(summary["provider_credit_grants"], 1)
        self.assertEqual(summary["provider_credit_transactions"], 1)
        self.assertGreater(summary["total_deleted"], 0)

        self.assertFalse(PaymentOrder.objects.filter(id=target["order_id"]).exists())
        self.assertFalse(PaymentCallback.objects.filter(id=target["callback_id"]).exists())
        self.assertFalse(OrganizationStorageUsage.objects.filter(id=target["usage_snapshot_id"]).exists())
        self.assertFalse(OrganizationBillingPolicy.objects.filter(id=target["policy_id"]).exists())
        self.assertFalse(OrganizationBillingEntitlement.objects.filter(id=target["entitlement_id"]).exists())
        self.assertFalse(OrganizationStorageSubscription.objects.filter(id=target["subscription_id"]).exists())
        self.assertFalse(OrganizationLlmMonthlyBudget.objects.filter(id=target["llm_budget_id"]).exists())
        self.assertFalse(BillingUsageDaily.objects.filter(id=target["usage_daily_id"]).exists())
        self.assertFalse(BillingUsageEvent.objects.filter(id=target["usage_event_id"]).exists())
        self.assertFalse(BillingInvoice.objects.filter(id=target["invoice_id"]).exists())
        self.assertFalse(BillingInvoiceLine.objects.filter(id=target["invoice_line_id"]).exists())
        self.assertFalse(BillingBudgetPolicy.objects.filter(id=target["budget_policy_id"]).exists())
        self.assertFalse(OrganizationServicePolicy.objects.filter(id=target["service_policy_id"]).exists())
        self.assertFalse(OrganizationAddonEntitlement.objects.filter(id=target["addon_entitlement_id"]).exists())
        self.assertFalse(MemberLlmBudgetPolicy.objects.filter(id=target["member_budget_policy_id"]).exists())
        self.assertFalse(MemberLlmUsageCounter.objects.filter(id=target["member_usage_counter_id"]).exists())
        self.assertFalse(
            ProviderCreditGrant.objects.filter(id=target["provider_grant_id"]).exists()
        )
        self.assertFalse(
            ProviderCreditTransaction.objects.filter(
                id=target["provider_transaction_id"]
            ).exists()
        )
        self.assertTrue(
            ProviderCreditCampaign.objects.filter(
                id=target["provider_campaign_id"]
            ).exists()
        )
        self.assertTrue(AddonPackage.objects.filter(id=target["addon_package_id"]).exists())
        #  拍板：审计/对账/告警类保持软引用且组织删除后留存可查账
        self.assertTrue(BillingReconciliationReport.objects.filter(id=target["reconciliation_report_id"]).exists())
        self.assertTrue(BillingAnomalyAlert.objects.filter(id=target["anomaly_id"]).exists())
        self.assertTrue(BillingAdminAuditLog.objects.filter(id=target["admin_audit_id"]).exists())
        self.assertFalse(MeterPricing.objects.filter(id=target["organization_pricing_id"]).exists())
        self.assertFalse(OrganizationWallet.objects.filter(id=target["wallet_id"]).exists())
        self.assertFalse(WalletTransaction.objects.filter(id=target["wallet_tx_id"]).exists())
        target_file = FileRecord.objects.get(id=target["file_record_id"])
        self.assertEqual(target_file.ref_count, 0)
        self.assertEqual(target_file.status, "completed")
        self.assertLessEqual(target_file.updated_at, timezone.now() - timedelta(days=7))
        self.assertFalse(FileUsage.objects.filter(id=target["file_usage_id"]).exists())
        self.assertFalse(UploadTask.objects.filter(id=target["upload_task_id"]).exists())
        self.assertFalse(OSSAdminActionLog.objects.filter(id=target["oss_admin_action_log_id"]).exists())

        self.assertTrue(PaymentOrder.objects.filter(id=other["order_id"]).exists())
        self.assertTrue(OrganizationWallet.objects.filter(id=other["wallet_id"]).exists())
        self.assertTrue(FileRecord.objects.filter(id=other["file_record_id"]).exists())
        self.assertTrue(MeterPricing.objects.filter(id=other["organization_pricing_id"]).exists())
        self.assertTrue(
            ProviderCreditGrant.objects.filter(id=other["provider_grant_id"]).exists()
        )
        self.assertTrue(UploadTask.objects.filter(id=other["upload_task_id"]).exists())
        self.assertTrue(OSSAdminActionLog.objects.filter(id=other["oss_admin_action_log_id"]).exists())
        self.assertTrue(OSSAdminActionLog.objects.filter(id=mixed_admin_log.id).exists())
        self.assertTrue(MeterPricing.objects.filter(id=global_pricing.id).exists())

    def test_cleanup_organization_is_idempotent(self):
        org_id = self._create_tombstoned_organization()
        self._seed_organization_scope(org_id, legacy_order=True)

        first = OrganizationLifecycleCleanupService.cleanup_organization(org_id)
        second = OrganizationLifecycleCleanupService.cleanup_organization(org_id)

        self.assertGreater(first["total_deleted"], 0)
        self.assertEqual(second["total_deleted"], 0)
        # 墓碑终步：首轮物理删除组织行，二轮幂等跳过
        self.assertEqual(first["organization_row_finalized"], 1)
        self.assertEqual(second["organization_row_finalized"], 0)

    def test_cleanup_organization_refuses_active_organization(self):
        """#3832 防御：清理链禁止对非墓碑（active）组织删除资金数据。"""
        from apps.tabtinspace.models import Organization

        organization = Organization.objects.create(
            name="active-org-guard",
            owner_id=self.user.id,
            type=Organization.OrganizationType.TEAM,
            status=Organization.Status.ACTIVE,
        )
        with self.assertRaisesRegex(RuntimeError, "非 deleting 墓碑"):
            OrganizationLifecycleCleanupService.cleanup_organization(str(organization.id))

    def test_finalize_blocks_on_protected_residual_rows(self):
        """#3832 墓碑终步：PROTECT 子表有残留时拒绝物理删除组织行并报错。"""
        from apps.tabtinspace.models import Organization

        org_id = self._create_tombstoned_organization()
        residual = OrganizationStorageUsage.objects.create(
            organization_id=org_id,
            active_file_count=1,
            active_storage_bytes=1,
        )
        with self.assertRaisesRegex(RuntimeError, "PROTECT 子表尚有残留行"):
            OrganizationLifecycleCleanupService._finalize_organization_row(org_id)
        self.assertTrue(Organization.objects.filter(id=org_id).exists())

        residual.delete()
        self.assertEqual(
            OrganizationLifecycleCleanupService._finalize_organization_row(org_id), 1
        )
        self.assertFalse(Organization.objects.filter(id=org_id).exists())

    def test_enqueue_cleanup_run_inline_records_succeeded_job(self):
        org_id = self._create_tombstoned_organization()
        self._seed_organization_scope(org_id, legacy_order=True)

        job = OrganizationLifecycleCleanupService.enqueue_cleanup(
            org_id,
            trigger_source="organization_delete",
            run_inline=True,
        )

        self.assertEqual(job.status, "succeeded")
        self.assertEqual(job.attempt_count, 1)
        self.assertEqual(job.trigger_source, "organization_delete")
        self.assertGreater(job.last_success_summary.get("total_deleted", 0), 0)
        self.assertFalse(
            OrganizationLifecycleCleanupJob.objects.filter(
                organization_id=org_id,
                status__in=["pending", "failed", "permanently_failed"],
            ).exists()
        )
        # 墓碑终步随清理链完成：组织行已物理删除
        from apps.tabtinspace.models import Organization
        self.assertFalse(Organization.objects.filter(id=org_id).exists())

    def test_enqueue_cleanup_failure_persists_retryable_job_and_alert(self):
        with patch.object(
            OrganizationLifecycleCleanupService,
            "cleanup_organization",
            side_effect=RuntimeError("default db timeout"),
        ):
            job = OrganizationLifecycleCleanupService.enqueue_cleanup(
                org_id_for("ws_cleanup_job_failed"),
                trigger_source="organization_delete",
                run_inline=True,
            )

        self.assertEqual(job.status, "failed")
        self.assertEqual(job.attempt_count, 1)
        self.assertIn("default db timeout", job.last_error)
        self.assertIsNotNone(job.next_retry_at)

        alert = BillingAnomalyAlert.objects.get(
            organization_id=org_id_for("ws_cleanup_job_failed"),
            alert_type="cleanup_failed",
            metric_name="organization_lifecycle_cleanup",
            is_resolved=False,
        )
        self.assertEqual(alert.severity, "warning")

    def test_failed_job_exhaustion_marks_permanently_failed(self):
        job = OrganizationLifecycleCleanupJob.objects.create(
            organization_id=org_id_for("ws_cleanup_job_exhausted"),
            trigger_source="organization_delete",
            status="failed",
            attempt_count=OrganizationLifecycleCleanupService.MAX_RETRY_ATTEMPTS - 1,
            max_attempts=OrganizationLifecycleCleanupService.MAX_RETRY_ATTEMPTS,
            next_retry_at=timezone.now() - timedelta(minutes=1),
        )

        with patch.object(
            OrganizationLifecycleCleanupService,
            "cleanup_organization",
            side_effect=RuntimeError("still broken"),
        ):
            updated = OrganizationLifecycleCleanupService.run_cleanup_job(str(job.id))

        self.assertEqual(updated.status, "permanently_failed")
        self.assertEqual(updated.attempt_count, OrganizationLifecycleCleanupService.MAX_RETRY_ATTEMPTS)
        self.assertIsNone(updated.next_retry_at)

        alert = BillingAnomalyAlert.objects.get(
            organization_id=org_id_for("ws_cleanup_job_exhausted"),
            alert_type="cleanup_failed",
            metric_name="organization_lifecycle_cleanup",
            is_resolved=False,
        )
        self.assertEqual(alert.severity, "critical")

    def test_force_retry_can_restart_permanently_failed_job(self):
        job = OrganizationLifecycleCleanupJob.objects.create(
            organization_id=org_id_for("ws_cleanup_job_manual_retry"),
            trigger_source="organization_delete",
            status="permanently_failed",
            attempt_count=OrganizationLifecycleCleanupService.MAX_RETRY_ATTEMPTS,
            max_attempts=OrganizationLifecycleCleanupService.MAX_RETRY_ATTEMPTS,
            last_error="still broken",
        )

        with patch.object(
            OrganizationLifecycleCleanupService,
            "cleanup_organization",
            return_value={"total_deleted": 0},
        ):
            updated = OrganizationLifecycleCleanupService.run_cleanup_job(
                str(job.id),
                force=True,
            )

        self.assertEqual(updated.status, "succeeded")
        self.assertEqual(
            updated.attempt_count,
            OrganizationLifecycleCleanupService.MAX_RETRY_ATTEMPTS + 1,
        )
        self.assertEqual(updated.last_error, "")

    def test_retry_organization_lifecycle_cleanups_processes_due_jobs(self):
        retry_org_id = self._create_tombstoned_organization()
        self._seed_organization_scope(retry_org_id, legacy_order=True)
        job = OrganizationLifecycleCleanupJob.objects.create(
            organization_id=retry_org_id,
            trigger_source="organization_delete",
            status="failed",
            attempt_count=1,
            max_attempts=OrganizationLifecycleCleanupService.MAX_RETRY_ATTEMPTS,
            next_retry_at=timezone.now() - timedelta(minutes=1),
        )

        result = retry_organization_lifecycle_cleanups(limit=10)

        self.assertEqual(result["processed"], 1)
        self.assertEqual(result["succeeded"], 1)
        job.refresh_from_db()
        self.assertEqual(job.status, "succeeded")
        self.assertGreater(job.last_success_summary.get("total_deleted", 0), 0)

    def test_process_due_jobs_recovers_stuck_running_job(self):
        stuck_org_id = self._create_tombstoned_organization()
        self._seed_organization_scope(stuck_org_id, legacy_order=True)
        job = OrganizationLifecycleCleanupJob.objects.create(
            organization_id=stuck_org_id,
            trigger_source="organization_delete",
            status="running",
            attempt_count=1,
            max_attempts=OrganizationLifecycleCleanupService.MAX_RETRY_ATTEMPTS,
            started_at=timezone.now() - timedelta(minutes=45),
        )

        result = OrganizationLifecycleCleanupService.process_due_jobs(limit=10)

        self.assertEqual(result["recovered_stuck_jobs"], 1)
        self.assertEqual(result["stuck_jobs_marked_permanently_failed"], 0)
        self.assertEqual(result["processed"], 1)
        self.assertEqual(result["succeeded"], 1)
        job.refresh_from_db()
        self.assertEqual(job.status, "succeeded")
        self.assertGreater(job.last_success_summary.get("total_deleted", 0), 0)

        # ：告警行留档不删（软引用例外），但成功后必须已 resolved
        self.assertFalse(
            BillingAnomalyAlert.objects.filter(
                organization_id=stuck_org_id,
                alert_type="cleanup_failed",
                metric_name="organization_lifecycle_cleanup",
                is_resolved=False,
            ).exists()
        )

    def test_recover_stuck_running_jobs_marks_exhausted_job_permanently_failed(self):
        job = OrganizationLifecycleCleanupJob.objects.create(
            organization_id=org_id_for("ws_cleanup_job_stuck_exhausted"),
            trigger_source="organization_delete",
            status="running",
            attempt_count=OrganizationLifecycleCleanupService.MAX_RETRY_ATTEMPTS,
            max_attempts=OrganizationLifecycleCleanupService.MAX_RETRY_ATTEMPTS,
            started_at=timezone.now() - timedelta(minutes=45),
        )

        result = OrganizationLifecycleCleanupService.recover_stuck_running_jobs(limit=10)

        self.assertEqual(result["recovered_jobs"], 1)
        self.assertEqual(result["retryable_jobs"], 0)
        self.assertEqual(result["permanently_failed_jobs"], 1)
        job.refresh_from_db()
        self.assertEqual(job.status, "permanently_failed")
        self.assertIsNone(job.next_retry_at)
        self.assertIn("running 超过", job.last_error)

        alert = BillingAnomalyAlert.objects.get(
            organization_id=org_id_for("ws_cleanup_job_stuck_exhausted"),
            alert_type="cleanup_failed",
            metric_name="organization_lifecycle_cleanup",
            is_resolved=False,
        )
        self.assertEqual(alert.severity, "critical")
