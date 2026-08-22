"""
会员相关 Celery 任务

- 到期预警（每天 09:00）
- 自动续费（每天 00:30）
"""

import logging
from decimal import Decimal
from celery import shared_task
from celery.schedules import crontab
from django.conf import settings
from django.core.cache import cache
from django.utils import timezone
from django.db import transaction
from datetime import timedelta

from apps.services.billing.services.billing_metrics import billing_auto_renew_total
from apps.services.common.db_router import postgres_app_db_alias

logger = logging.getLogger(__name__)

EXPIRY_WARNING_DEDUP_TTL = 24 * 60 * 60  # 24h
AUTO_RENEW_DEDUP_TTL = 25 * 60 * 60  # 25h — 略大于 24h 避免边界竞态
OVERLIMIT_DEDUP_TTL = 24 * 60 * 60  # 24h — 同一 organization 每天最多推一次超限通知


@shared_task(bind=True, max_retries=2, acks_late=True, reject_on_worker_lost=True, time_limit=300, soft_time_limit=280)
def send_membership_expiry_warnings(self):
    """
    扫描即将到期的 OrganizationMembership，记录预警日志。
    未来可接入邮件/站内信通知。
    """
    from .models import OrganizationMembership

    now = timezone.now()
    thresholds = [7, 3, 1]  # 天

    warned = 0

    # 扫描 OrganizationMembership（P2 主路径）
    for days in thresholds:
        cutoff = now + timedelta(days=days)
        wt_members = OrganizationMembership.objects.filter(
            status='active',
            end_date__gt=now,
            end_date__lte=cutoff,
        ).select_related('tier')

        for wm in wt_members:
            dedup_key = f"billing:membership_expiring:{wm.organization_id}:{days}"
            if cache.get(dedup_key):
                continue

            days_left = wm.days_until_expiry()
            logger.info(
                "[MembershipExpiry] 组织会员到期预警: organization=%s tier=%s "
                "end_date=%s days_left=%s",
                wm.organization_id, wm.tier.name, wm.end_date, days_left,
            )
            try:
                from apps.services.billing.ws_events import publish_billing_event
                publish_billing_event(str(wm.organization_id), "membership_expiring", {
                    "tier_name": wm.tier.name,
                    "end_date": wm.end_date.isoformat() if wm.end_date else None,
                    "days_left": days_left,
                })
            except Exception as exc:
                logger.warning(
                    "[MembershipExpiry] WS 推送失败: organization=%s error=%s",
                    wm.organization_id, exc,
                )

            cache.set(dedup_key, 1, EXPIRY_WARNING_DEDUP_TTL)
            warned += 1

    logger.info("[MembershipExpiry] 扫描完成: warned=%d", warned)
    return {"warned": warned}


@shared_task(bind=True, max_retries=2, acks_late=True, reject_on_worker_lost=True, time_limit=300, soft_time_limit=280)
def process_ws_auto_renewals(self):
    """
    组织会员自动续费（OrganizationMembership → OrganizationWallet 扣款）。

    FIN-14: 从 process_auto_renewals 拆分，独立调度，避免前路径超时连带后路径。
    FIN-13: 去除 get_wallet_info 前置余额检查，直接调用 consume 并捕获
            InsufficientCreditsError，消除无锁读与有锁扣款之间的 TOCTOU 竞争窗口。
    """
    from .models import OrganizationMembership
    from .services.organization_membership_service import OrganizationMembershipService
    from apps.users.wallet.services.organization_wallet_service import OrganizationWalletService
    from apps.users.wallet.exceptions import InsufficientCreditsError

    now = timezone.now()
    cutoff = now + timedelta(days=1)

    renewed = 0
    skipped = 0
    failed = 0

    try:
        candidate_ids = list(
            OrganizationMembership.objects.filter(
                status='active',
                auto_renew=True,
                end_date__gt=now,
                end_date__lte=cutoff,
            ).values_list('id', flat=True)
        )
    except Exception as setup_exc:
        logger.error("process_ws_auto_renewals 初始化查询失败（将重试）: %s", setup_exc)
        raise self.retry(exc=setup_exc, countdown=60 * (2 ** self.request.retries))

    wt_service = OrganizationMembershipService()
    wt_wallet_service = OrganizationWalletService()
    today_str = now.strftime('%Y-%m-%d')

    for wm_id in candidate_ids:
        dedup_key = f"billing:auto_renew:wt:{wm_id}:{today_str}"
        if cache.get(dedup_key):
            logger.debug("组织自动续费跳过（今日已处理）: wm_id=%s", wm_id)
            skipped += 1
            continue

        try:
            with transaction.atomic():
                try:
                    wm = OrganizationMembership.objects.select_for_update(
                        skip_locked=True,
                    ).select_related('tier').get(
                        id=wm_id, status='active', auto_renew=True,
                        end_date__gt=now, end_date__lte=cutoff,
                    )
                except OrganizationMembership.DoesNotExist:
                    continue

                tier = wm.tier
                price = tier.price
                credits_cost = price * settings.CREDITS_PER_YUAN

                try:
                    wt_wallet_service.consume(
                        organization_id=wm.organization_id,
                        credits_amount=credits_cost,
                        description=f'会员自动续费：{tier.name}',
                        user_id=wm.purchased_by or '',
                    )
                except InsufficientCreditsError as ice:
                    logger.warning(
                        "[AutoRenew] 组织余额不足，跳过续费: organization=%s tier=%s tier_id=%s "
                        "need=%s available=%s end_date=%s",
                        wm.organization_id, tier.name, tier.id,
                        credits_cost, ice.current, wm.end_date,
                    )
                    billing_auto_renew_total.labels(
                        membership_type="organization", result="skipped_balance"
                    ).inc()
                    try:
                        from apps.services.billing.ws_events import publish_billing_event
                        publish_billing_event(str(wm.organization_id), "auto_renew_failed", {
                            "tier_name": tier.name,
                            "end_date": wm.end_date.isoformat() if wm.end_date else None,
                            "reason": "insufficient_balance",
                        })
                    except Exception as notify_exc:
                        logger.warning(
                            "[AutoRenew] 余额不足 WS 推送异常: organization=%s error=%s",
                            wm.organization_id, notify_exc,
                        )
                    skipped += 1
                    continue

                wt_service.activate_membership(
                    organization_id=wm.organization_id,
                    tier_id=str(tier.id),
                    is_renewal=True,
                    purchased_by=wm.purchased_by or '',
                )

            cache.set(dedup_key, 1, AUTO_RENEW_DEDUP_TTL)
            logger.info(
                "[AutoRenew] 组织续费成功: organization=%s tier=%s tier_id=%s "
                "credits_cost=%s new_end_date=%s",
                wm.organization_id, tier.name, tier.id, credits_cost,
                wm.end_date,
            )
            billing_auto_renew_total.labels(membership_type="organization", result="success").inc()
            renewed += 1

        except Exception as e:
            logger.error(
                "[AutoRenew] 组织续费失败: wm_id=%s error_type=%s error=%s",
                wm_id, type(e).__name__, e,
                exc_info=True,
            )
            billing_auto_renew_total.labels(membership_type="organization", result="failed").inc()
            failed += 1
            try:
                failed_wm = OrganizationMembership.objects.filter(id=wm_id).only(
                    "organization_id", "tier__name"
                ).select_related("tier").first()
                if failed_wm:
                    from apps.services.billing.ws_events import publish_billing_event
                    publish_billing_event(str(failed_wm.organization_id), "auto_renew_failed", {
                        "tier_name": failed_wm.tier.name if failed_wm.tier else "",
                        "error": str(e),
                    })
            except Exception as notify_exc:
                logger.warning(
                    "[AutoRenew] 续费失败 WS 推送异常: wm_id=%s error=%s", wm_id, notify_exc,
                )

    logger.info(
        "[AutoRenew] 组织自动续费完成: renewed=%d skipped=%d failed=%d",
        renewed, skipped, failed,
    )
    return {"renewed": renewed, "skipped": skipped, "failed": failed}


def _notify_overlimit_resources(wt_id: str, free_tier) -> None:
    """
    MEM-36 / D11: 降级后检查超限资源并推送 WS 通知。
    只读检查——不删除、不冻结、不标记任何用户数据。
    check_quota 已会阻止新增，此处仅告知用户哪些资源超限。
    """
    dedup_key = f"billing:downgrade_overlimit:{wt_id}"
    if cache.get(dedup_key):
        return

    exceeded_items = []

    try:
        from apps.tabdata.models import Table

        max_tables = free_tier.max_tables
        if max_tables is not None and max_tables != -1:
            table_count = (
                Table.objects.using(postgres_app_db_alias())
                .filter(organization_id=wt_id, is_archived=False, trashed_at__isnull=True)
                .count()
            )
            if table_count > max_tables:
                exceeded_items.append({
                    "resource": "tables",
                    "current": table_count,
                    "limit": max_tables,
                    "exceeded_by": table_count - max_tables,
                })

        max_records = free_tier.max_records_per_table
        if max_records is not None and max_records != -1:
            max_row = (
                Table.objects.using(postgres_app_db_alias())
                .filter(organization_id=wt_id, is_archived=False, trashed_at__isnull=True)
                .order_by("-row_count")
                .values_list("row_count", flat=True)
                .first()
            )
            if max_row and max_row > max_records:
                exceeded_items.append({
                    "resource": "records_per_table",
                    "current": max_row,
                    "limit": max_records,
                    "exceeded_by": max_row - max_records,
                })
    except Exception as exc:
        logger.warning("[OverlimitCheck] tabdata 查询失败: organization=%s, error=%s", wt_id, exc)

    try:
        from apps.tabtinspace.models import OrganizationMember

        max_members = free_tier.max_members
        if max_members is not None and max_members != -1:
            member_count = (
                OrganizationMember.objects.using(postgres_app_db_alias())
                .filter(organization_id=wt_id)
                .count()
            )
            if member_count > max_members:
                exceeded_items.append({
                    "resource": "members",
                    "current": member_count,
                    "limit": max_members,
                    "exceeded_by": member_count - max_members,
                })
    except Exception as exc:
        logger.warning("[OverlimitCheck] organization member 查询失败: organization=%s, error=%s", wt_id, exc)

    try:
        from apps.services.billing.models import OrganizationStorageUsage

        # included_storage_bytes=0 表示免费版无独立存储配额，跳过检查
        storage_limit = free_tier.included_storage_bytes or 0
        if storage_limit > 0:
            usage = OrganizationStorageUsage.objects.filter(organization_id=str(wt_id)).first()
            if usage and (usage.active_storage_bytes or 0) > storage_limit:
                exceeded_items.append({
                    "resource": "storage",
                    "current": usage.active_storage_bytes,
                    "limit": storage_limit,
                    "exceeded_by": usage.active_storage_bytes - storage_limit,
                })
    except Exception as exc:
        logger.warning("[OverlimitCheck] storage 查询失败: organization=%s, error=%s", wt_id, exc)

    if not exceeded_items:
        return

    try:
        from apps.services.billing.ws_events import publish_billing_event
        publish_billing_event(str(wt_id), "membership_downgraded_overlimit", {
            "exceeded_items": exceeded_items,
            "exceeded_count": len(exceeded_items),
        })
        cache.set(dedup_key, 1, OVERLIMIT_DEDUP_TTL)
        logger.info(
            "[OverlimitCheck] 超限通知已推送: organization=%s, exceeded=%d items",
            wt_id, len(exceeded_items),
        )
    except Exception as exc:
        logger.warning(
            "[OverlimitCheck] 超限通知推送失败: organization=%s, error=%s",
            wt_id, exc,
        )


@shared_task(bind=True, max_retries=2, acks_late=True, reject_on_worker_lost=True, time_limit=300, soft_time_limit=280)
def downgrade_expired_entitlements(self):
    """
    扫描已过期（含宽限期）的组织会员，将 entitlement 降级到 free tier 权益值。

    - 宽限期通过 settings.ENTITLEMENT_GRACE_PERIOD_DAYS 配置，默认 3 天。
    - 降级操作幂等：多次执行结果一致。
    """
    from .models import MembershipTier, OrganizationMembership

    now = timezone.now()
    grace_days = getattr(settings, "ENTITLEMENT_GRACE_PERIOD_DAYS", 3)
    cutoff = now - timedelta(days=grace_days)

    free_tier = MembershipTier.objects.filter(tier_type="free", is_active=True).first()
    if not free_tier:
        logger.error("[DowngradeEntitlements] free tier 不存在，跳过降级")
        return {"error": "free_tier_not_found"}

    free_storage = free_tier.included_storage_bytes or 0
    free_llm_credits = free_tier.included_llm_credits_monthly or Decimal("0")

    expired_memberships = (
        OrganizationMembership.objects.filter(
            status="active",
            end_date__lt=cutoff,
        )
        .values_list("organization_id", flat=True)
    )

    downgraded = 0
    skipped = 0
    errors = 0

    for wt_id in expired_memberships:
        try:
            from apps.services.billing.models import OrganizationBillingEntitlement
            from apps.services.billing.services import OrganizationEntitlementSyncService

            # MEM-38: 在事务执行前先读取当前 entitlement 快照，
            # 待同步完成后与新值对比，判断是否真正降级（区别于"已是 free tier 的幂等操作"）。
            # membership 状态更新和 entitlement 同步始终执行（幂等安全），
            # 仅计数器 downgraded/skipped 按实际变化决定。
            before = OrganizationBillingEntitlement.objects.filter(
                organization_id=wt_id,
            ).first()

            # MEM-35: 事务前读取旧 tier 名称，用于降级 WS 通知 payload
            expiring_membership = (
                OrganizationMembership.objects.filter(
                    organization_id=wt_id,
                    status="active",
                    end_date__lt=now,
                )
                .select_related("tier")
                .first()
            )
            old_tier_name = (
                expiring_membership.tier.name
                if expiring_membership and expiring_membership.tier
                else ""
            )

            with transaction.atomic():
                OrganizationMembership.objects.filter(
                    organization_id=wt_id,
                    status="active",
                    end_date__lt=now,
                ).update(status="expired", updated_at=now)

                ent = OrganizationEntitlementSyncService.sync_organization_entitlement(
                    wt_id,
                    clear_manual_overrides=True,
                    metadata_updates={
                        "downgraded_reason": "membership_expired",
                        "downgraded_at": now.isoformat(),
                        "grace_days": grace_days,
                        "downgraded_to": "free",
                    },
                )

            entitlement_changed = not (
                before is not None
                and int(before.included_storage_bytes or 0) == int(ent.included_storage_bytes or 0)
                and Decimal(str(before.included_llm_credits_monthly or 0)) == Decimal(str(ent.included_llm_credits_monthly or 0))
                and int(before.purchased_storage_bytes or 0) == int(ent.purchased_storage_bytes or 0)
            )

            if entitlement_changed:
                downgraded += 1
                logger.info(
                    "[DowngradeEntitlements] 降级成功: organization=%s", wt_id,
                )
                # MEM-35: 降级成功后推送 WS 通知，前端据此展示 toast + 续费引导
                try:
                    from apps.services.billing.ws_events import publish_billing_event
                    publish_billing_event(str(wt_id), "membership_expired", {
                        "old_tier_name": old_tier_name,
                        "new_tier_name": free_tier.name,
                        "expired_at": now.isoformat(),
                    })
                except Exception as notify_exc:
                    logger.warning(
                        "[DowngradeEntitlements] WS 推送失败: organization=%s, error=%s",
                        wt_id, notify_exc,
                    )

                # MEM-36 / D11: 降级后检查超限资源，推送通知引导用户升级
                _notify_overlimit_resources(wt_id, free_tier)
            else:
                skipped += 1
                logger.debug(
                    "[DowngradeEntitlements] entitlement 无变化（已为 free tier），跳过计数: organization=%s", wt_id,
                )

        except Exception as e:
            errors += 1
            logger.error(
                "[DowngradeEntitlements] 降级失败: organization=%s, error=%s",
                wt_id, e,
            )

    logger.info(
        "[DowngradeEntitlements] 完成: downgraded=%d, skipped=%d, errors=%d",
        downgraded, skipped, errors,
    )
    return {"downgraded": downgraded, "skipped": skipped, "errors": errors}


@shared_task(bind=True, max_retries=3, acks_late=True, reject_on_worker_lost=True, time_limit=300, soft_time_limit=280)
def retry_sync_entitlement(self, organization_id: str, tier_id: str):
    """补偿任务：在 _sync_entitlement 首次失败后异步重试。"""
    from .models import MembershipTier, OrganizationMembership
    from .services.organization_membership_service import OrganizationMembershipService

    try:
        tier = MembershipTier.objects.get(id=tier_id, is_active=True)
    except MembershipTier.DoesNotExist:
        logger.error("[RetrySyncEntitlement] tier 不存在: %s", tier_id)
        return {"error": "tier_not_found"}

    wt_membership = OrganizationMembership.objects.filter(
        organization_id=organization_id,
        status='active',
    ).first()
    if not wt_membership:
        logger.warning(
            "[RetrySyncEntitlement] organization 会员不存在或已非 active，跳过补偿: organization=%s",
            organization_id,
        )
        return {"error": "organization_membership_not_active"}

    if str(wt_membership.tier_id) != tier_id:
        logger.warning(
            "[RetrySyncEntitlement] organization 会员 tier 已变更，跳过补偿: "
            "organization=%s, expected_tier=%s, actual_tier=%s",
            organization_id, tier_id, wt_membership.tier_id,
        )
        return {"error": "tier_mismatch", "expected": tier_id, "actual": str(wt_membership.tier_id)}

    end_date = wt_membership.end_date

    try:
        service = OrganizationMembershipService()
        service._sync_entitlement(organization_id, tier, end_date=end_date)
        logger.info("[RetrySyncEntitlement] 补偿同步成功: organization=%s", organization_id)
        return {"success": True}
    except Exception as exc:
        countdown = 60 * (2 ** self.request.retries)
        logger.error(
            "[RetrySyncEntitlement] 补偿同步失败: organization=%s, error=%s, retry_in=%ds",
            organization_id, exc, countdown,
        )
        raise self.retry(exc=exc, countdown=countdown)


MEMBERSHIP_BEAT_SCHEDULE = {
    "membership-expiry-warnings": {
        "task": "apps.users.membership.tasks.send_membership_expiry_warnings",
        "schedule": crontab(hour=9, minute=0),  # 每天 09:00
        "options": {"expires": 3600},
    },
    "membership-ws-auto-renewals": {
        "task": "apps.users.membership.tasks.process_ws_auto_renewals",
        "schedule": crontab(hour=0, minute=30),  # 每天 00:30
        "options": {"expires": 3600},
    },
    "membership-downgrade-expired-entitlements": {
        "task": "apps.users.membership.tasks.downgrade_expired_entitlements",
        "schedule": crontab(hour=1, minute=0),  # 每天 01:00（在自动续费 00:30 之后）
        "options": {"expires": 3600},
    },
}
