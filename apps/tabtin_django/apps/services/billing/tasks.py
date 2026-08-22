"""
Billing 定时任务
"""

from __future__ import annotations

import logging
import time
from datetime import timedelta
from decimal import Decimal

from celery import shared_task
from celery.schedules import crontab
from django.core.cache import cache
from django.utils import timezone

from apps.i18n import _
from apps.services.billing.constants import BILLING_TZ
from apps.services.billing.models import (
    BillingUsageDaily,
    BillingUsageEvent,
    OrganizationStorageUsage,
)
from django.db import transaction

from apps.services.billing.services import (
    AddonEntitlementService,
    OrganizationLifecycleCleanupService,
)
from apps.services.billing.services.storage_package_service import OrganizationStoragePackageService

logger = logging.getLogger(__name__)

# ── 分布式锁 (INFRA-18) ──

_LOCK_PREFIX = "billing_task_lock:"


@shared_task(
    name="apps.services.billing.tasks.recover_search_billing_reservations",
    ignore_result=True,
)
def recover_search_billing_reservations(batch_limit: int = 100) -> dict[str, int]:
    """有界回收 Search Reservation；UNKNOWN 只核查告警，不自动退款。"""
    from apps.services.billing.services.search_reservation_service import (
        SearchBillingReservationService,
    )

    return SearchBillingReservationService.sweep(limit=batch_limit)


@shared_task(name="apps.services.billing.tasks.deliver_single_real_recharge_report")
def deliver_single_real_recharge_report(order_id: str) -> dict:
    """支付成功后按配置投递单笔真实充值通知。"""
    from apps.services.billing.services.real_recharge_report_service import (
        queue_single_recharge_notification,
    )

    try:
        return queue_single_recharge_notification(order_id)
    except ValueError as exc:
        return {"queued": False, "reason": str(exc)}


@shared_task(name="apps.services.billing.tasks.deliver_due_daily_real_recharge_report")
def deliver_due_daily_real_recharge_report() -> dict:
    """每分钟检查一次配置，到点后按日期幂等投递当日汇总。"""
    from apps.services.billing.services.real_recharge_report_service import (
        queue_due_daily_recharge_report,
    )

    try:
        return queue_due_daily_recharge_report()
    except ValueError as exc:
        return {"queued": False, "reason": str(exc)}


def _try_acquire_lock(lock_name: str, timeout: int = 450) -> bool:
    """尝试获取分布式锁（cache.add → Redis SET NX），timeout 秒后自动过期。"""
    return cache.add(f"{_LOCK_PREFIX}{lock_name}", "1", timeout)


def _release_lock(lock_name: str) -> None:
    """主动释放分布式锁；任务正常结束时调用，异常由 timeout 兜底。"""
    cache.delete(f"{_LOCK_PREFIX}{lock_name}")


def _dispatch_billing_alert(
    alert_type: str,
    severity: str,
    message: str,
    *,
    organization_id: str = "",
    user_id: str = "",
    extra: dict | None = None,
):
    """结构化告警：以合适日志级别输出并推送可选 webhook (INV-A14-006)。"""
    log_fn = logger.critical if severity == "critical" else (
        logger.error if severity == "error" else logger.warning
    )
    log_fn(
        "[BILLING_ALERT] type=%s severity=%s ws=%s user=%s | %s",
        alert_type, severity, organization_id or "-", user_id or "-", message,
    )

    from django.conf import settings as _settings
    webhook_url = getattr(_settings, "BILLING_ALERT_WEBHOOK_URL", "")
    if webhook_url:
        try:
            import json
            import urllib.request
            payload = json.dumps({
                "alert_type": alert_type,
                "severity": severity,
                "message": message,
                "organization_id": organization_id,
                "user_id": user_id,
                **(extra or {}),
            }).encode()
            req = urllib.request.Request(
                webhook_url, data=payload,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            urllib.request.urlopen(req, timeout=5)
        except Exception as exc:
            logger.warning("[BILLING_ALERT] webhook 推送失败: %s", exc)


@shared_task(
    bind=True,
    max_retries=5,
    default_retry_delay=60,
    acks_late=True,
    time_limit=60,
    soft_time_limit=45,
)
def grant_new_organization_provider_credits_async(self, organization_id: str):
    """异步发放团队组织创建时生效的全部 new_org Campaign。"""
    from apps.services.billing.services.provider_credit_provision import (
        grant_new_organization_provider_credits,
    )
    from apps.tabtinspace.models import Organization

    try:
        organization = Organization.objects.only(
            "id",
            "created_at",
            "type",
            "is_default",
            "status",
        ).get(id=organization_id)
        grants = grant_new_organization_provider_credits(
            organization,
            at=organization.created_at,
        )
        logger.info(
            "new_org Provider Credit 异步发放完成: organization=%s grants=%s",
            organization_id,
            [str(grant.id) for grant in grants],
        )
        return {
            "organization_id": organization_id,
            "grant_ids": [str(grant.id) for grant in grants],
        }
    except Organization.DoesNotExist:
        logger.info(
            "new_org Provider Credit 异步发放跳过已删除组织: organization=%s",
            organization_id,
        )
        return {"organization_id": organization_id, "skipped": "organization_deleted"}
    except Exception as exc:
        logger.error(
            "new_org Provider Credit 异步发放失败: organization=%s error=%s",
            organization_id,
            exc,
            exc_info=True,
        )
        raise self.retry(exc=exc)


@shared_task(bind=True, max_retries=2, default_retry_delay=300, acks_late=True, time_limit=300, soft_time_limit=280)
def expire_organization_storage_subscriptions(self, organization_id: str = ""):
    """同步过期的组织存储套餐，并回写 entitlement 快照。"""
    try:
        return OrganizationStoragePackageService.expire_due_subscriptions(organization_id=organization_id)
    except Exception as exc:
        logger.error("expire_organization_storage_subscriptions 任务异常: %s", exc, exc_info=True)
        raise self.retry(exc=exc)


@shared_task(bind=True, max_retries=2, default_retry_delay=300, acks_late=True, time_limit=300, soft_time_limit=280)
def expire_organization_addon_entitlements(self, organization_id: str = ""):
    """同步过期的通用增值包权益，并回写 entitlement 快照。"""
    try:
        return AddonEntitlementService.expire_addons(organization_id=organization_id)
    except Exception as exc:
        logger.error("expire_organization_addon_entitlements 任务异常: %s", exc, exc_info=True)
        raise self.retry(exc=exc)


_USAGE_EVENT_RETENTION_DAYS = 365
_USAGE_EVENT_BATCH_SIZE = 2000


@shared_task(ignore_result=True, time_limit=1800, soft_time_limit=1740)
def cleanup_old_usage_events(retention_days: int = _USAGE_EVENT_RETENTION_DAYS):
    """删除已结算的老旧 BillingUsageEvent（保留 N 天，默认 365 天）。

    删除前验证 BillingUsageDaily 是否已聚合，仅删除已聚合的事件，
    避免删除未聚合的事件导致不可恢复的数据丢失 (PR-X1)。
    """
    cutoff = timezone.now() - timedelta(days=retention_days)
    total_deleted = 0
    total_skipped = 0
    _DAILY_CHECK_CHUNK = 500
    last_id = None

    while True:
        qs = BillingUsageEvent.objects.filter(occurred_at__lt=cutoff).order_by("id")
        if last_id is not None:
            qs = qs.filter(id__gt=last_id)
        batch = list(
            qs.values_list("id", "organization_id", "occurred_at")[:_USAGE_EVENT_BATCH_SIZE]
        )
        if not batch:
            break
        last_id = batch[-1][0]

        event_date_map = {}
        for event_id, organization_id, occurred_at in batch:
            usage_date = occurred_at.astimezone(BILLING_TZ).date()
            event_date_map[event_id] = (organization_id, usage_date)

        unique_pairs = set(event_date_map.values())
        organization_ids = list({wt for wt, _ in unique_pairs})
        usage_dates = list({d for _, d in unique_pairs})

        aggregated_pairs = set()
        for i in range(0, len(organization_ids), _DAILY_CHECK_CHUNK):
            ws_chunk = organization_ids[i:i + _DAILY_CHECK_CHUNK]
            existing = BillingUsageDaily.objects.filter(
                organization_id__in=ws_chunk,
                usage_date__in=usage_dates,
            ).values_list("organization_id", "usage_date")
            aggregated_pairs.update(existing)

        safe_ids = [
            eid for eid, pair in event_date_map.items()
            if pair in aggregated_pairs
        ]
        skipped_count = len(batch) - len(safe_ids)

        if skipped_count > 0:
            skipped_pairs = {
                event_date_map[eid]
                for eid in event_date_map
                if event_date_map[eid] not in aggregated_pairs
            }
            logger.warning(
                "[BillingUsageEvent] Cleanup: 跳过 %d 条未聚合事件 (%d 个 organization/date 组合)",
                skipped_count, len(skipped_pairs),
            )
            total_skipped += skipped_count

        if safe_ids:
            deleted, _ = BillingUsageEvent.objects.filter(id__in=safe_ids).delete()
            total_deleted += deleted

        time.sleep(0.5)

    if total_deleted or total_skipped:
        logger.info(
            "[BillingUsageEvent] Cleanup completed: deleted=%d skipped=%d cutoff=%s",
            total_deleted, total_skipped, cutoff,
        )
    return {"deleted": total_deleted, "skipped": total_skipped}


@shared_task(bind=True, max_retries=5, acks_late=True, time_limit=120, soft_time_limit=110)
def reconcile_organization_storage_snapshot(
    self,
    organization_id: str,
    *,
    reason: str = "",
):
    """按组织重算存储快照，用于增量计量失败后的快速补偿。

    任务以当前有效 FileUsage 为真实来源做绝对值校准，因此可安全重试；
    首次计量即失败、尚无快照时，也会先创建空快照再完成重算。
    """
    from apps.services.billing.services.storage_service import OrganizationStorageBillingService

    if not organization_id:
        return {"skipped": True, "reason": "missing_organization_id"}

    try:
        OrganizationStorageUsage.objects.get_or_create(
            organization_id=organization_id,
            defaults={
                "active_file_count": 0,
                "active_storage_bytes": 0,
                "total_uploaded_bytes": 0,
                "total_released_bytes": 0,
            },
        )
        result = OrganizationStorageBillingService.reconcile_organization_storage(
            organization_id,
        )
        logger.info(
            "[StorageReconcileCompensation] 完成: organization=%s reason=%s corrected=%s",
            organization_id,
            reason or "-",
            result.get("corrected", False),
        )
        return result
    except Exception as exc:
        retry_count = int(getattr(self.request, "retries", 0) or 0)
        countdown = min(30 * (2 ** retry_count), 600)
        logger.warning(
            "[StorageReconcileCompensation] 失败，准备重试: "
            "organization=%s reason=%s retry=%d err=%s",
            organization_id,
            reason or "-",
            retry_count + 1,
            exc,
            exc_info=True,
        )
        raise self.retry(exc=exc, countdown=countdown)


def schedule_storage_snapshot_reconciliation(
    organization_id: str,
    *,
    reason: str = "",
) -> None:
    """在当前数据库事务提交后投递组织存储快照补偿任务。"""
    if not organization_id:
        return

    organization_id = str(organization_id)

    def _enqueue() -> None:
        try:
            reconcile_organization_storage_snapshot.apply_async(
                args=[organization_id],
                kwargs={"reason": reason},
            )
        except Exception as exc:
            # 消息代理故障不能反向破坏文档删除/恢复；每日全量对账仍是最终兜底。
            logger.error(
                "[StorageReconcileCompensation] 投递失败: organization=%s reason=%s err=%s",
                organization_id,
                reason or "-",
                exc,
                exc_info=True,
            )

    transaction.on_commit(_enqueue)


@shared_task(bind=True, max_retries=1, default_retry_delay=120, acks_late=True, time_limit=300, soft_time_limit=280)
def retry_organization_lifecycle_cleanups(self, limit: int = 50):
    """重试 organization 删除后的 default DB 清理任务。"""
    try:
        result = OrganizationLifecycleCleanupService.process_due_jobs(limit=max(1, int(limit or 50)))
        logger.info(
            "[OrganizationCleanupRetry] processed=%d succeeded=%d failed=%d permanently_failed=%d "
            "recovered_stuck_jobs=%d stuck_jobs_marked_permanently_failed=%d",
            result["processed"],
            result["succeeded"],
            result["failed"],
            result["permanently_failed"],
            result["recovered_stuck_jobs"],
            result["stuck_jobs_marked_permanently_failed"],
        )
        return result
    except Exception as exc:
        logger.error("retry_organization_lifecycle_cleanups 任务异常: %s", exc, exc_info=True)
        raise self.retry(exc=exc)


# --- 计费失败补偿 ---

@shared_task(bind=True, max_retries=2, default_retry_delay=300, acks_late=True, time_limit=300, soft_time_limit=280)
def notify_expiring_storage_subscriptions(self):
    """检查即将到期的存储套餐（7 天 / 1 天），推送提醒（方案 4.3 + 8.9）。

    每日 9:00 执行，使用分布式锁保证单实例运行，
    Redis dedup 防止同一订阅同一窗口重复推送。
    """
    from apps.services.billing.models import OrganizationStorageSubscription
    from apps.services.billing.ws_events import publish_billing_event

    _lock_key = "billing:notify_expiring_storage"
    if not _try_acquire_lock(_lock_key):
        return {"skipped": "lock_held"}
    try:
        now = timezone.now()
        notified = 0

        for days_before in [7, 1]:
            window_start = now + timedelta(days=days_before) - timedelta(hours=12)
            window_end = now + timedelta(days=days_before) + timedelta(hours=12)
            subs = OrganizationStorageSubscription.objects.filter(
                status="active",
                end_at__range=(window_start, window_end),
            )
            for sub in subs:
                dedup_key = f"storage_expiring:{sub.id}:{days_before}d"
                if cache.get(dedup_key):
                    continue

                package_name = ""
                if sub.package_plan_id:
                    package_name = getattr(sub.package_plan, "name", "")

                ok = publish_billing_event(
                    sub.organization_id,
                    "storage_package_expiring",
                    {
                        "days_remaining": days_before,
                        "package_name": package_name,
                        "subscription_id": str(sub.id),
                        "end_at": sub.end_at.isoformat() if sub.end_at else "",
                        "auto_renew": sub.auto_renew,
                    },
                )
                if ok:
                    cache.set(dedup_key, "1", 86400)
                    notified += 1

        logger.info("[NotifyExpiringStorage] 完成: notified=%d", notified)
        return {"notified": notified}
    except Exception as exc:
        logger.error("notify_expiring_storage_subscriptions 任务异常: %s", exc, exc_info=True)
        raise self.retry(exc=exc)
    finally:
        _release_lock(_lock_key)


@shared_task(bind=True, max_retries=2, default_retry_delay=300, acks_late=True, time_limit=600, soft_time_limit=560)
def daily_low_balance_email_alert(self):
    """每日 09:00 扫描余额低于阈值的 organization，给 owner 发低余额预警邮件 (PR 2)。

    对每个有钱包的 organization 检查余额是否低于 per-organization 配置的
    warning/critical 阈值（存储在 OrganizationBillingPolicy.metadata 中），
    满足条件则发送邮件。邮件去重由 Redis key 控制（warning 24h, critical 12h）。
    """
    from decimal import Decimal
    from apps.services.billing.services.low_balance_alert_service import (
        LowBalanceAlertService,
    )

    _lock_key = "billing:daily_low_balance_email"
    if not _try_acquire_lock(_lock_key, timeout=900):
        logger.debug("[DailyLowBalanceEmail] 跳过: 另一实例正在执行")
        return {"skipped": True, "reason": "another_instance_running"}
    try:
        from apps.users.wallet.models import OrganizationWallet

        # 含余额=0：归零组织最需要紧急邮件；阈值判断在循环内完成
        wallets = list(
            OrganizationWallet.objects.filter(
                credits_precise__gte=Decimal("0"),
            ).values_list("organization_id", "credits_precise")[:5000]
        )

        checked = 0
        warned = 0
        critical_count = 0
        emailed = 0

        for organization_id, _wallet_credits in wallets:
            if not organization_id:
                continue
            organization_id = str(organization_id)
            checked += 1

            try:
                # 与 toast / WS 一致：钱包可用 + 月度套餐剩余
                balance = LowBalanceAlertService.resolve_alertable_credits(organization_id)
                if balance is None:
                    continue

                thresholds = LowBalanceAlertService.get_thresholds(organization_id)
                if not thresholds.email_enabled:
                    continue

                level = None
                if balance < thresholds.critical_credits:
                    level = "critical"
                    critical_count += 1
                elif balance < thresholds.warning_credits:
                    level = "warning"
                    warned += 1

                if level is None:
                    continue

                email_dedup_key = f"billing:low_bal_email:{level}:{organization_id}"
                email_ttl = 43200 if level == "critical" else 86400
                if cache.get(email_dedup_key):
                    continue

                ok = LowBalanceAlertService.send_low_balance_email(
                    organization_id, balance, level, thresholds,
                )
                if ok:
                    # 仅发送成功后写入去重，避免 SMTP 失败被 12h/24h 挡住重试
                    cache.set(email_dedup_key, True, email_ttl)
                    emailed += 1
            except Exception as exc:
                logger.warning(
                    "[DailyLowBalanceEmail] 检查失败: wt=%s err=%s",
                    organization_id, exc,
                )

        logger.info(
            "[DailyLowBalanceEmail] 完成: checked=%d warned=%d critical=%d emailed=%d",
            checked, warned, critical_count, emailed,
        )
        return {
            "checked": checked,
            "warned": warned,
            "critical": critical_count,
            "emailed": emailed,
        }
    except Exception as exc:
        logger.error("daily_low_balance_email_alert 异常: %s", exc, exc_info=True)
        raise self.retry(exc=exc)
    finally:
        _release_lock(_lock_key)


BILLING_BEAT_SCHEDULE = {
    "billing-recover-search-reservations": {
        "task": "apps.services.billing.tasks.recover_search_billing_reservations",
        "schedule": crontab(minute="*"),
        "options": {"expires": 50},
    },
    "billing-deliver-due-daily-real-recharge-report": {
        "task": "apps.services.billing.tasks.deliver_due_daily_real_recharge_report",
        "schedule": crontab(minute="*"),
        "options": {"expires": 50},
    },
    "billing-expire-storage-subscriptions": {
        "task": "apps.services.billing.tasks.expire_organization_storage_subscriptions",
        "schedule": crontab(minute="*/30"),
        "options": {"expires": 1500},
    },
    "billing-expire-addon-entitlements": {
        "task": "apps.services.billing.tasks.expire_organization_addon_entitlements",
        "schedule": crontab(minute="*/30"),
        "options": {"expires": 1500},
    },
    "billing-retry-organization-lifecycle-cleanups": {
        "task": "apps.services.billing.tasks.retry_organization_lifecycle_cleanups",
        "schedule": crontab(minute="*/10"),
        "options": {"expires": 480},
    },
    "billing-cleanup-old-usage-events": {
        "task": "apps.services.billing.tasks.cleanup_old_usage_events",
        "schedule": crontab(hour=5, minute=20),
        "options": {"expires": 3600},
    },
    "billing-notify-expiring-storage": {
        "task": "apps.services.billing.tasks.notify_expiring_storage_subscriptions",
        "schedule": crontab(hour=9, minute=0),
        "options": {"expires": 3600},
    },
    "billing-daily-low-balance-email-alert": {
        "task": "apps.services.billing.tasks.daily_low_balance_email_alert",
        "schedule": crontab(hour=9, minute=0),
        "options": {"expires": 3600},
    },
}
