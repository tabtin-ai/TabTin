from __future__ import annotations

import logging
from datetime import timedelta
from typing import Dict
from uuid import UUID

from django.apps import apps as django_apps
from django.db import connections, transaction
from django.db.models import Q, QuerySet
from django.utils import timezone
from apps.services.common.db_router import postgres_app_db_alias

logger = logging.getLogger(__name__)


class OrganizationLifecycleCleanupService:
    """清理 organization 在 default DB 中的计费/账务/OSS 强归属数据。"""

    MAX_RETRY_ATTEMPTS = 6
    RETRY_DELAYS_MINUTES = (5, 15, 30, 60, 180, 360)
    STUCK_RUNNING_MINUTES = 30

    @classmethod
    def enqueue_cleanup(
        cls,
        organization_id: str,
        *,
        trigger_source: str = "organization_delete",
        run_inline: bool = False,
        force: bool = False,
    ):
        from apps.services.billing.models import OrganizationLifecycleCleanupJob

        organization_id = str(organization_id or "").strip()
        if not organization_id:
            raise ValueError("organization_id 不能为空")

        with transaction.atomic(using="default"):
            job, created = OrganizationLifecycleCleanupJob.objects.select_for_update().get_or_create(
                organization_id=organization_id,
                defaults={
                    "trigger_source": trigger_source or "organization_delete",
                    "status": "pending",
                    "max_attempts": cls.MAX_RETRY_ATTEMPTS,
                },
            )
            if not created:
                update_fields = []
                if trigger_source and job.trigger_source != trigger_source:
                    job.trigger_source = trigger_source
                    update_fields.append("trigger_source")
                if force and job.status != "running":
                    job.status = "pending"
                    job.next_retry_at = None
                    update_fields.extend(["status", "next_retry_at"])
                if update_fields:
                    update_fields.append("updated_at")
                    job.save(update_fields=update_fields)

        if run_inline:
            return cls.run_cleanup_job(str(job.id), force=force)
        return job

    @classmethod
    def run_cleanup_job(cls, job_id: str, *, force: bool = False):
        from apps.services.billing.models import OrganizationLifecycleCleanupJob

        now = timezone.now()
        with transaction.atomic(using="default"):
            job = (
                OrganizationLifecycleCleanupJob.objects.select_for_update()
                .get(id=job_id)
            )
            if job.status == "running":
                return job
            if job.status == "succeeded" and not force:
                return job
            if job.status == "permanently_failed" and not force:
                return job

            job.attempt_count = int(job.attempt_count or 0) + 1
            job.max_attempts = int(job.max_attempts or cls.MAX_RETRY_ATTEMPTS)
            job.status = "running"
            job.started_at = now
            job.finished_at = None
            job.last_error = ""
            job.next_retry_at = None
            job.save(
                update_fields=[
                    "attempt_count",
                    "max_attempts",
                    "status",
                    "started_at",
                    "finished_at",
                    "last_error",
                    "next_retry_at",
                    "updated_at",
                ]
            )

        try:
            summary = cls.cleanup_organization(job.organization_id)
        except Exception as exc:
            logger.exception(
                "Organization default DB cleanup job failed: organization=%s attempt=%s",
                job.organization_id,
                job.attempt_count,
            )
            return cls._mark_job_failed(str(job.id), str(exc))

        return cls._mark_job_succeeded(str(job.id), summary)

    @classmethod
    def list_due_jobs(cls, *, limit: int = 50):
        from apps.services.billing.models import OrganizationLifecycleCleanupJob

        now = timezone.now()
        return list(
            OrganizationLifecycleCleanupJob.objects.filter(
                status__in=["pending", "failed"],
            )
            .filter(Q(next_retry_at__isnull=True) | Q(next_retry_at__lte=now))
            .order_by("next_retry_at", "created_at")[: max(1, int(limit or 50))]
        )

    @classmethod
    def list_stuck_running_jobs(cls, *, limit: int = 50, older_than_minutes: int | None = None):
        from apps.services.billing.models import OrganizationLifecycleCleanupJob

        cutoff = cls._build_stuck_running_cutoff(older_than_minutes)
        return list(
            OrganizationLifecycleCleanupJob.objects.filter(
                status="running",
                started_at__isnull=False,
                started_at__lte=cutoff,
            )
            .order_by("started_at", "created_at")[: max(1, int(limit or 50))]
        )

    @classmethod
    def recover_stuck_running_jobs(
        cls,
        *,
        limit: int = 50,
        older_than_minutes: int | None = None,
    ) -> Dict[str, int]:
        from apps.services.billing.models import OrganizationLifecycleCleanupJob

        now = timezone.now()
        cutoff = cls._build_stuck_running_cutoff(older_than_minutes)
        timeout_minutes = max(1, int(older_than_minutes or cls.STUCK_RUNNING_MINUTES))
        recovered_jobs = 0
        permanently_failed_jobs = 0

        for candidate in cls.list_stuck_running_jobs(limit=limit, older_than_minutes=timeout_minutes):
            with transaction.atomic(using="default"):
                job = (
                    OrganizationLifecycleCleanupJob.objects.select_for_update()
                    .get(id=candidate.id)
                )
                if job.status != "running" or not job.started_at or job.started_at > cutoff:
                    continue

                exhausted = int(job.attempt_count or 0) >= int(job.max_attempts or cls.MAX_RETRY_ATTEMPTS)
                job.status = "permanently_failed" if exhausted else "failed"
                job.finished_at = now
                job.last_error = (
                    f"organization cleanup job 卡在 running 超过 {timeout_minutes} 分钟，"
                    "已自动恢复为可处理状态"
                )[:2000]
                job.next_retry_at = None if exhausted else now
                job.save(
                    update_fields=[
                        "status",
                        "finished_at",
                        "last_error",
                        "next_retry_at",
                        "updated_at",
                    ]
                )

            cls._upsert_failure_alert(job.organization_id, job.attempt_count, job.last_error, exhausted)
            recovered_jobs += 1
            permanently_failed_jobs += int(exhausted)
            logger.warning(
                "Organization cleanup stuck job recovered: organization=%s status=%s attempt=%s exhausted=%s",
                job.organization_id,
                job.status,
                job.attempt_count,
                exhausted,
            )

        return {
            "recovered_jobs": recovered_jobs,
            "permanently_failed_jobs": permanently_failed_jobs,
            "retryable_jobs": recovered_jobs - permanently_failed_jobs,
        }

    @classmethod
    def process_due_jobs(
        cls,
        *,
        limit: int = 50,
        recover_stuck: bool = True,
        older_than_minutes: int | None = None,
    ) -> Dict[str, int]:
        from apps.services.billing.models import OrganizationLifecycleCleanupJob

        limit = max(1, int(limit or 50))
        result = {
            "processed": 0,
            "succeeded": 0,
            "failed": 0,
            "permanently_failed": 0,
            "recovered_stuck_jobs": 0,
            "stuck_jobs_marked_permanently_failed": 0,
            "pending_total": 0,
        }

        if recover_stuck:
            recovered = cls.recover_stuck_running_jobs(
                limit=limit,
                older_than_minutes=older_than_minutes,
            )
            result["recovered_stuck_jobs"] = recovered["retryable_jobs"]
            result["stuck_jobs_marked_permanently_failed"] = recovered["permanently_failed_jobs"]

        due_jobs = cls.list_due_jobs(limit=limit)
        for job in due_jobs:
            updated = cls.run_cleanup_job(str(job.id))
            result["processed"] += 1
            if updated.status == "succeeded":
                result["succeeded"] += 1
            elif updated.status == "permanently_failed":
                result["permanently_failed"] += 1
            elif updated.status == "failed":
                result["failed"] += 1

        result["pending_total"] = OrganizationLifecycleCleanupJob.objects.filter(
            status__in=["pending", "failed"]
        ).count()
        return result

    @classmethod
    def cleanup_organization(cls, organization_id: str) -> Dict[str, int]:
        organization_id = str(organization_id or "").strip()
        if not organization_id:
            raise ValueError("organization_id 不能为空")

        cls._assert_organization_tombstoned(organization_id)

        #  拍板：审计 / 对账 / 告警 / 清理作业记录类（BillingAdminAuditLog、
        # BillingReconciliationReport、BillingAnomalyAlert、OrganizationCreditLedger、
        # BillingDispute、OrganizationLifecycleCleanupJob）**不再随组织清理删除**——
        # 它们保持软引用的意义就是组织删掉后还能查账，故从删除清单移除。
        from apps.services.billing.models import (
            BillingBudgetPolicy,
            BillingInvoice,
            BillingInvoiceLine,
            BillingUsageDaily,
            BillingUsageEvent,
            MemberLlmBudgetPolicy,
            MemberLlmUsageCounter,
            MeterPricing,
            OrganizationAddonEntitlement,
            OrganizationBillingEntitlement,
            OrganizationBillingPolicy,
            OrganizationLlmMonthlyBudget,
            OrganizationServicePolicy,
            OrganizationStorageSubscription,
            OrganizationStorageUsage,
            ProviderCreditGrant,
            ProviderCreditTransaction,
        )
        from apps.services.oss.models import FileRecord, FileUsage, OSSAdminActionLog, UploadTask
        from apps.services.payment.models import PaymentCallback, PaymentOrder
        from apps.users.wallet.models import WalletTransaction, OrganizationWallet

        tabdata_summary = cls._cleanup_tabdata_upload_artifacts(organization_id)
        order_ids = list(
            PaymentOrder.objects
            .filter(cls._build_organization_order_query(organization_id))
            .values_list("id", flat=True)
        )
        invoice_ids = list(
            BillingInvoice.objects.filter(organization_id=organization_id).values_list("id", flat=True)
        )
        file_ids = list(
            FileRecord.objects.filter(organization_id=organization_id).values_list("id", flat=True)
        )
        # DEL-18: 防御性检查 — organization_id 未正确填充时发出告警
        if not file_ids:
            usage_count = FileUsage.objects.filter(
                file_record__organization_id=organization_id, is_active=True,
            ).count()
            if usage_count > 0:
                logger.warning(
                    "DEL-18: organization=%s 的 FileRecord 为空，但存在 %d 条活跃 FileUsage，"
                    "可能因历史 FileRecord.organization_id 未填充导致 OSS 引用静默泄漏",
                    organization_id, usage_count,
                )
        related_biz_ids = [str(item_id) for item_id in [*order_ids, *invoice_ids]]

        summary = {
            "billing_usage_events": 0,
            "billing_usage_daily": 0,
            "billing_invoices": 0,
            "billing_invoice_lines": 0,
            "billing_budget_policies": 0,
            "billing_reconciliation_reports": 0,
            "billing_anomaly_alerts": 0,
            "billing_admin_audit_logs": 0,
            "meter_pricing": 0,
            "organization_billing_policies": 0,
            "organization_billing_entitlements": 0,
            "organization_service_policies": 0,
            "organization_addon_entitlements": 0,
            "organization_storage_usages": 0,
            "organization_storage_subscriptions": 0,
            "organization_llm_monthly_budgets": 0,
            "provider_credit_grants": 0,
            "provider_credit_transactions": 0,
            "member_llm_budget_policies": 0,
            "member_llm_usage_counters": 0,
            "wallet_transactions": 0,
            "organization_wallets": 0,
            "payment_callbacks": 0,
            "payment_orders": 0,
            "file_usages": 0,
            "file_records": 0,
            "file_records_orphaned": 0,
            "file_records_deleted": 0,
            "oss_upload_tasks": 0,
            "oss_admin_action_logs": 0,
            "tabdata_attachment_references": tabdata_summary["tabdata_attachment_references"],
            "tabdata_attachment_uploads": tabdata_summary["tabdata_attachment_uploads"],
            "extension_connections": 0,
            "extension_event_logs": 0,
            "notification_rules": 0,
            "extension_webhook_subscriptions": 0,
            "notifications": 0,
            "channel_bindings": 0,
            "channel_accounts": 0,
            "channel_runtime_statuses": 0,
            "channel_inbound_logs": 0,
            "channel_outbound_records": 0,
            "channel_allowlist_entries": 0,
            "channel_pairing_requests": 0,
            "llm_usage_facts": 0,
            "llm_usage_budget_policies": 0,
            "llm_admin_audit_logs": 0,
            "llm_usage_statistics": 0,
            "llm_vision_requests": 0,
            "llm_requests": 0,
            "llm_provider_probe_logs": 0,
            "llm_models": 0,
            "llm_providers": 0,
            "media_tasks": 0,
            "media_models": 0,
            "media_providers": 0,
            "chat_messages": 0,
            "chat_sessions": 0,
            "mail_embeddings": 0,
            "mail_suppressions": 0,
            "mail_drafts": 0,
            "mail_messages": 0,
            "mail_threads": 0,
            "mail_accounts": 0,
            "mail_inboxes": 0,
            "mail_domains": 0,
        }

        # FileStatistics 是按 bucket/date 聚合的全局统计，不属于单一 organization，故不在此删除。
        # OSSAdminActionLog 仅清理单 organization 归属的日志；跨 organization 的治理日志保留作审计用途。
        with transaction.atomic(using="default"):
            summary["provider_credit_transactions"] = cls._delete_queryset(
                ProviderCreditTransaction.objects.filter(organization_id=organization_id)
            )
            summary["provider_credit_grants"] = cls._delete_queryset(
                ProviderCreditGrant.objects.filter(organization_id=organization_id)
            )
            summary["wallet_transactions"] = cls._delete_queryset(
                WalletTransaction.objects.filter(
                    Q(organization_id=organization_id)
                    | Q(organization_wallet__organization_id=organization_id)
                    | Q(related_order_id__in=related_biz_ids)
                )
            )
            summary["payment_callbacks"] = cls._delete_queryset(
                PaymentCallback.objects.filter(order_id__in=order_ids)
            )
            summary["billing_invoice_lines"] = cls._delete_queryset(
                BillingInvoiceLine.objects.filter(
                    Q(organization_id=organization_id) | Q(invoice_id__in=invoice_ids)
                )
            )
            summary["file_usages"] = cls._delete_queryset(
                FileUsage.objects.filter(file_record_id__in=file_ids)
            )
            summary["oss_upload_tasks"] = cls._delete_upload_tasks(
                UploadTask.objects.filter(organization_id=organization_id)
            )
            summary["oss_admin_action_logs"] = cls._delete_queryset(
                OSSAdminActionLog.objects.filter(organization_id=organization_id)
            )
            summary["billing_invoices"] = cls._delete_queryset(
                BillingInvoice.objects.filter(organization_id=organization_id)
            )
            summary["payment_orders"] = cls._delete_queryset(
                PaymentOrder.objects.filter(id__in=order_ids)
            )
            orphan_cutoff = timezone.now() - timedelta(days=8)
            orphan_count = FileRecord.objects.filter(
                id__in=file_ids,
            ).exclude(status='deleted').exclude(
                ref_count=0,
                status='completed',
                updated_at__lte=orphan_cutoff,
            ).update(
                ref_count=0,
                status='completed',
                updated_at=orphan_cutoff,
            )
            deleted_file_queryset = FileRecord.objects.filter(
                id__in=file_ids,
                status='deleted',
            )
            deleted_file_count = deleted_file_queryset.count()
            if deleted_file_count:
                deleted_file_queryset.delete()
            summary["file_records_orphaned"] = orphan_count
            summary["file_records_deleted"] = deleted_file_count
            summary["file_records"] = orphan_count + deleted_file_count
            if orphan_count:
                logger.info(
                    "organization cleanup: %d FileRecord 已标记为 orphan 待异步清理 OSS 物理文件 (organization=%s)",
                    orphan_count, organization_id,
                )
            summary["organization_storage_subscriptions"] = cls._delete_queryset(
                OrganizationStorageSubscription.objects.filter(organization_id=organization_id)
            )
            summary["organization_storage_usages"] = cls._delete_queryset(
                OrganizationStorageUsage.objects.filter(organization_id=organization_id)
            )
            summary["organization_billing_policies"] = cls._delete_queryset(
                OrganizationBillingPolicy.objects.filter(organization_id=organization_id)
            )
            summary["organization_billing_entitlements"] = cls._delete_queryset(
                OrganizationBillingEntitlement.objects.filter(organization_id=organization_id)
            )
            summary["organization_service_policies"] = cls._delete_queryset(
                OrganizationServicePolicy.objects.filter(organization_id=organization_id)
            )
            summary["organization_addon_entitlements"] = cls._delete_queryset(
                OrganizationAddonEntitlement.objects.filter(organization_id=organization_id)
            )
            summary["organization_llm_monthly_budgets"] = cls._delete_queryset(
                OrganizationLlmMonthlyBudget.objects.filter(organization_id=organization_id)
            )
            summary["member_llm_budget_policies"] = cls._delete_queryset(
                MemberLlmBudgetPolicy.objects.filter(organization_id=organization_id)
            )
            summary["member_llm_usage_counters"] = cls._delete_queryset(
                MemberLlmUsageCounter.objects.filter(organization_id=organization_id)
            )
            summary["billing_usage_daily"] = cls._delete_queryset(
                BillingUsageDaily.objects.filter(organization_id=organization_id)
            )
            summary["billing_usage_events"] = cls._delete_queryset(
                BillingUsageEvent.objects.filter(organization_id=organization_id)
            )
            summary["billing_budget_policies"] = cls._delete_queryset(
                BillingBudgetPolicy.objects.filter(organization_id=organization_id)
            )
            # 审计（BillingAdminAuditLog）/ 对账（BillingReconciliationReport）/
            # 告警（BillingAnomalyAlert）为记录在案的软引用例外，组织删除后
            # 留存可查账，不再删除；summary key 保留为 0 兼容展示。
            summary["meter_pricing"] = cls._delete_queryset(
                MeterPricing.objects.filter(scope="organization", organization_id=organization_id)
            )
            summary["organization_wallets"] = cls._delete_queryset(
                OrganizationWallet.objects.filter(organization_id=organization_id)
            )
            for label, queryset in cls._iter_optional_cleanup_querysets(organization_id):
                summary[label] = cls._delete_queryset(queryset)

        # ── 墓碑终步：以上清理全部提交后，校验真 FK 子表已清空，
        # 物理删除组织墓碑行。失败（残留子行）会 raise → job 转 failed →
        # 复用既有退避重试 + BillingAnomalyAlert 告警。
        summary["organization_row_finalized"] = cls._finalize_organization_row(organization_id)

        summary["total_deleted"] = cls._compute_total_deleted(summary)
        logger.info("Organization default DB cleanup completed: organization=%s summary=%s", organization_id, summary)
        return summary

    @staticmethod
    def _load_organization_for_lifecycle(organization_id: str):
        """按 organization_id 取组织行；id 非法（legacy 非 UUID 测试值）视为无行。"""
        from apps.tabtinspace.models import Organization

        try:
            organization_uuid = UUID(str(organization_id))
        except (TypeError, ValueError, AttributeError):
            return None
        return (
            Organization.objects.using(postgres_app_db_alias())
            .filter(id=organization_uuid)
            .first()
        )

    @classmethod
    def _assert_organization_tombstoned(cls, organization_id: str) -> None:
        """防御：清理链只允许对墓碑（deleting）或已消失的组织执行。

        误对活组织跑清理会直接删掉它的钱包/账单等资金数据，必须在删除
        任何数据之前拦截。
        """
        from apps.tabtinspace.models import Organization

        organization = cls._load_organization_for_lifecycle(organization_id)
        if organization is not None and organization.status != Organization.Status.DELETING:
            raise RuntimeError(
                "organization lifecycle cleanup blocked: organization 仍为 "
                f"{organization.status}（非 deleting 墓碑），拒绝清理资金数据; "
                f"organization={organization_id}"
            )

    @classmethod
    def _finalize_organization_row(cls, organization_id: str) -> int:
        """墓碑终步：校验各真 FK 子表已清空 → 物理删除组织行。

        返回 1 表示本次物理删除了组织行；0 表示行已不存在（幂等重入）。
        PROTECT 关系仍有残行时 raise（job 进入 failed 重试 + 告警）；
        CASCADE 关系（如 OrganizationControlPolicy）由 ORM collector 收尾。
        """
        from apps.tabtinspace.models import Organization

        organization = cls._load_organization_for_lifecycle(organization_id)
        if organization is None:
            return 0
        if organization.status != Organization.Status.DELETING:
            raise RuntimeError(
                "organization finalize blocked: organization 仍为 "
                f"{organization.status}（非 deleting 墓碑）; organization={organization_id}"
            )

        residuals = cls._collect_protected_residuals(organization)
        if residuals:
            raise RuntimeError(
                "organization finalize blocked: PROTECT 子表尚有残留行，"
                f"organization={organization_id} residuals={residuals}"
            )

        with transaction.atomic(using=postgres_app_db_alias()):
            organization.delete()
        logger.info(
            "[OrganizationDelete] phase=finalized organization=%s（墓碑行已物理删除）",
            organization_id,
        )
        return 1

    @staticmethod
    def _collect_protected_residuals(organization) -> Dict[str, int]:
        """统计所有 on_delete=PROTECT 的反向关系残留行数（应全为 0）。

        编程式遍历保证后续新增的 PROTECT FK 自动纳入校验，不依赖手工清单。
        注意用 get_fields(include_hidden=True)——billing FK 均为
        related_name='+'（hidden），_meta.related_objects 不含它们。
        """
        from django.db.models.deletion import PROTECT

        residuals: Dict[str, int] = {}
        for relation in organization._meta.get_fields(include_hidden=True):
            if not (relation.one_to_many or relation.one_to_one):
                continue
            if not relation.auto_created or relation.concrete:
                continue
            if getattr(relation, "on_delete", None) is not PROTECT:
                continue
            related_model = relation.related_model
            count = related_model._base_manager.filter(
                **{relation.field.name: organization.pk}
            ).count()
            if count:
                residuals[related_model._meta.label] = count
        return residuals

    @classmethod
    def _mark_job_succeeded(cls, job_id: str, summary: Dict[str, int]):
        from apps.services.billing.models import OrganizationLifecycleCleanupJob

        now = timezone.now()
        with transaction.atomic(using="default"):
            job = (
                OrganizationLifecycleCleanupJob.objects.select_for_update()
                .get(id=job_id)
            )
            job.status = "succeeded"
            job.finished_at = now
            job.next_retry_at = None
            job.last_error = ""
            job.last_success_summary = summary
            job.save(
                update_fields=[
                    "status",
                    "finished_at",
                    "next_retry_at",
                    "last_error",
                    "last_success_summary",
                    "updated_at",
                ]
            )
        cls._resolve_failure_alerts(job.organization_id)
        return job

    @classmethod
    def _mark_job_failed(cls, job_id: str, error_message: str):
        from apps.services.billing.models import OrganizationLifecycleCleanupJob

        now = timezone.now()
        with transaction.atomic(using="default"):
            job = (
                OrganizationLifecycleCleanupJob.objects.select_for_update()
                .get(id=job_id)
            )
            exhausted = int(job.attempt_count or 0) >= int(job.max_attempts or cls.MAX_RETRY_ATTEMPTS)
            job.status = "permanently_failed" if exhausted else "failed"
            job.finished_at = now
            job.last_error = (error_message or "")[:2000]
            job.next_retry_at = None if exhausted else now + cls._build_retry_delay(job.attempt_count)
            job.save(
                update_fields=[
                    "status",
                    "finished_at",
                    "last_error",
                    "next_retry_at",
                    "updated_at",
                ]
            )
        cls._upsert_failure_alert(job.organization_id, job.attempt_count, job.last_error, exhausted)
        return job

    @classmethod
    def _upsert_failure_alert(
        cls,
        organization_id: str,
        attempt_count: int,
        error_message: str,
        exhausted: bool,
    ) -> None:
        from decimal import Decimal

        from apps.services.billing.models import BillingAnomalyAlert

        severity = "critical" if exhausted else "warning"
        metric_name = "organization_lifecycle_cleanup"
        message = (
            f"organization default DB 清理失败: organization={organization_id} "
            f"attempt={attempt_count} exhausted={exhausted} error={error_message[:160]}"
        )
        alert = (
            BillingAnomalyAlert.objects.filter(
                organization_id=organization_id,
                alert_type="cleanup_failed",
                metric_name=metric_name,
                is_resolved=False,
            )
            .order_by("-created_at")
            .first()
        )
        if alert:
            alert.severity = severity
            alert.current_value = Decimal(str(attempt_count))
            alert.message = message
            alert.save(update_fields=["severity", "current_value", "message"])
            return

        BillingAnomalyAlert.objects.create(
            alert_type="cleanup_failed",
            severity=severity,
            organization_id=organization_id,
            metric_name=metric_name,
            current_value=Decimal(str(attempt_count)),
            baseline_value=Decimal("0"),
            threshold_ratio=Decimal("0"),
            message=message,
        )

    @classmethod
    def _resolve_failure_alerts(cls, organization_id: str) -> None:
        from apps.services.billing.models import BillingAnomalyAlert

        BillingAnomalyAlert.objects.filter(
            organization_id=organization_id,
            alert_type="cleanup_failed",
            metric_name="organization_lifecycle_cleanup",
            is_resolved=False,
        ).update(
            is_resolved=True,
            resolved_at=timezone.now(),
        )

    @classmethod
    def _build_retry_delay(cls, attempt_count: int) -> timedelta:
        attempt_count = max(1, int(attempt_count or 1))
        index = min(attempt_count - 1, len(cls.RETRY_DELAYS_MINUTES) - 1)
        return timedelta(minutes=cls.RETRY_DELAYS_MINUTES[index])

    @staticmethod
    def _build_organization_order_query(organization_id: str) -> Q:
        return Q(organization_id=organization_id) | Q(business_data__organization_id=organization_id)

    @staticmethod
    def _is_app_installed(app_name: str) -> bool:
        return bool(app_name) and django_apps.is_installed(app_name)

    @classmethod
    def _iter_optional_cleanup_querysets(cls, organization_id: str):
        if cls._is_app_installed("apps.extensions"):
            from apps.extensions.models import (
                ExtensionConnection,
                ExtensionEventLog,
                ExtensionWebhookSubscription,
                NotificationRule,
            )

            yield "extension_event_logs", ExtensionEventLog.objects.filter(organization_id=organization_id)
            yield "notification_rules", NotificationRule.objects.filter(organization_id=organization_id)
            yield "extension_webhook_subscriptions", ExtensionWebhookSubscription.objects.filter(
                organization_id=organization_id
            )
            yield "extension_connections", ExtensionConnection.objects.filter(organization_id=organization_id)

        if cls._is_app_installed("apps.services.notification"):
            from apps.services.notification.models import Notification

            yield "notifications", Notification.objects.filter(organization_id=organization_id)

        if cls._is_app_installed("apps.channel_gateway"):
            from apps.channel_gateway.models import (
                ChannelAccount,
                ChannelAllowlistEntry,
                ChannelBinding,
                ChannelInboundMessageLog,
                ChannelOutboundMessageRecord,
                ChannelPairingRequest,
                ChannelRuntimeStatus,
            )

            yield "channel_bindings", ChannelBinding.objects.filter(organization_id=organization_id)
            yield "channel_accounts", ChannelAccount.objects.filter(organization_id=organization_id)
            yield "channel_runtime_statuses", ChannelRuntimeStatus.objects.filter(organization_id=organization_id)
            yield "channel_inbound_logs", ChannelInboundMessageLog.objects.filter(organization_id=organization_id)
            yield "channel_outbound_records", ChannelOutboundMessageRecord.objects.filter(organization_id=organization_id)
            yield "channel_allowlist_entries", ChannelAllowlistEntry.objects.filter(organization_id=organization_id)
            yield "channel_pairing_requests", ChannelPairingRequest.objects.filter(organization_id=organization_id)

        if cls._is_app_installed("apps.services.llm"):
            from apps.services.llm.models import (
                LLMAdminAuditLog,
                LLMModel,
                LLMProvider,
                LLMUsageFact,
            )

            yield "llm_usage_facts", LLMUsageFact.objects.filter(organization_id=organization_id)
            yield "llm_admin_audit_logs", LLMAdminAuditLog.objects.filter(organization_id=organization_id)
            yield "llm_models", LLMModel.objects.filter(provider__organization_id=organization_id)
            yield "llm_providers", LLMProvider.objects.filter(organization_id=organization_id)

        if cls._is_app_installed("apps.services.media_generation"):
            from apps.services.media_generation.models import MediaModel, MediaProvider, MediaTask

            yield "media_tasks", MediaTask.objects.filter(organization_id=organization_id)
            yield "media_models", MediaModel.objects.filter(provider__organization_id=organization_id)
            yield "media_providers", MediaProvider.objects.filter(organization_id=organization_id)

        if cls._is_app_installed("apps.chat.conversation"):
            from apps.chat.conversation.models import ChatMessage, ChatSession

            yield "chat_messages", ChatMessage.objects.filter(session__organization_id=organization_id)
            yield "chat_sessions", ChatSession.objects.filter(organization_id=organization_id)

    @staticmethod
    def _delete_queryset(queryset: QuerySet) -> int:
        count = queryset.count()
        if count:
            queryset.delete()
        return count

    @staticmethod
    def _delete_upload_tasks(queryset: QuerySet) -> int:
        count = queryset.count()
        if not count:
            return 0

        task_ids = list(queryset.values_list("id", flat=True))
        through = queryset.model.files.through
        through.objects.using(queryset.db).filter(uploadtask_id__in=task_ids).delete()
        connection = connections[queryset.db]
        qn = connection.ops.quote_name
        placeholders = ", ".join(["%s"] * len(task_ids))
        pk_field = queryset.model._meta.pk
        sql_task_ids = [
            pk_field.get_db_prep_value(task_id, connection, prepared=False)
            for task_id in task_ids
        ]
        with connection.cursor() as cursor:
            cursor.execute(
                f"DELETE FROM {qn(queryset.model._meta.db_table)} "
                f"WHERE {qn('id')} IN ({placeholders})",
                sql_task_ids,
            )
        return count

    @classmethod
    def _cleanup_tabdata_upload_artifacts(cls, organization_id: str) -> Dict[str, int]:
        result = {
            "tabdata_attachment_references": 0,
            "tabdata_attachment_uploads": 0,
        }
        if not cls._is_app_installed("apps.tabdata"):
            return result

        try:
            organization_uuid = UUID(str(organization_id))
        except (TypeError, ValueError, AttributeError):
            logger.debug(
                "跳过 tabdata 上传残留清理：非法 organization_id=%s",
                organization_id,
            )
            return result

        from apps.tabdata.models import AttachmentReference, AttachmentUpload
        from apps.tabtinspace.models import Organization

        with transaction.atomic(using=postgres_app_db_alias()):
            reference_qs = AttachmentReference.objects.using(postgres_app_db_alias()).filter(
                organization_id=organization_uuid
            )
            upload_qs = AttachmentUpload.objects.using(postgres_app_db_alias()).filter(
                organization_id=organization_uuid
            )
            reference_count = reference_qs.count()
            upload_count = upload_qs.count()
            # 墓碑管线：组织行在清理链末步才物理删除，deleting 墓碑
            # 视同“删除中”，正常清理；仅 active 组织拒绝动它的数据。
            organization_active = (
                Organization.objects.using(postgres_app_db_alias())
                .filter(id=organization_uuid)
                .exclude(status=Organization.Status.DELETING)
                .exists()
            )

            if organization_active:
                if reference_count or upload_count:
                    raise RuntimeError(
                        "tabdata attachment artifacts still exist while organization is active; "
                        f"organization={organization_id} references={reference_count} uploads={upload_count}"
                    )
                return result

            if reference_count:
                reference_qs.delete()
                result["tabdata_attachment_references"] = reference_count
            if upload_count:
                upload_qs.delete()
                result["tabdata_attachment_uploads"] = upload_count

        if result["tabdata_attachment_references"] or result["tabdata_attachment_uploads"]:
            logger.info(
                "已清理 tabdata 上传残留: organization=%s references=%d uploads=%d",
                organization_id,
                result["tabdata_attachment_references"],
                result["tabdata_attachment_uploads"],
            )
        return result

    @staticmethod
    def _compute_total_deleted(summary: Dict[str, int]) -> int:
        excluded_keys = {
            "file_records_orphaned",
            "file_records_deleted",
            "organization_row_finalized",
            "total_deleted",
        }
        return sum(
            value
            for key, value in summary.items()
            if key not in excluded_keys
        )

    @classmethod
    def _build_stuck_running_cutoff(cls, older_than_minutes: int | None = None):
        minutes = max(1, int(older_than_minutes or cls.STUCK_RUNNING_MINUTES))
        return timezone.now() - timedelta(minutes=minutes)
