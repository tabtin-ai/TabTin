"""
钱包相关 Celery 任务
"""

import logging
from datetime import timedelta

from celery import shared_task
from celery.schedules import crontab
from django.conf import settings
from django.db import transaction
from django.db.models import Exists, OuterRef

logger = logging.getLogger(__name__)

_STALE_THRESHOLD_MINUTES = 120
_BATCH_LIMIT = 100

_BALANCE_TX_TYPES = ("recharge", "consume", "grant", "expire", "refund")
_FROZEN_TX_TYPES = ("freeze", "unfreeze")


@shared_task(
    bind=True,
    max_retries=2,
    ignore_result=True,
    acks_late=True,
    time_limit=300,
    soft_time_limit=280,
)
def preheat_monthly_budgets(self):
    """WAL-21: 每月1日凌晨批量预创建活跃 organization 的新月 budget，
    缓解月初首次 LLM 调用时的懒创建 DB 压力。
    取代原 reset_all_monthly_quotas 死代码（WAL-18）。
    """
    try:
        from apps.users.membership.models import OrganizationMembership
        from apps.services.billing.services.llm_budget_service import OrganizationLlmBudgetService

        active_wt_ids = list(
            OrganizationMembership.objects.filter(
                status="active",
            ).values_list("organization_id", flat=True)
        )
        if not active_wt_ids:
            logger.info("[preheat] 无活跃 organization，跳过")
            return {"preheated": 0, "total": 0}

        count = OrganizationLlmBudgetService.preheat_monthly_budgets(active_wt_ids)
        logger.info("[preheat] 预创建完成: %d/%d organizations", count, len(active_wt_ids))
        return {"preheated": count, "total": len(active_wt_ids)}
    except Exception as exc:
        logger.error("[preheat] 任务异常: %s", exc, exc_info=True)
        raise self.retry(exc=exc)


@shared_task(
    name="wallet.reconcile_wallet_balances",
    bind=True,
    max_retries=1,
    ignore_result=True,
    acks_late=True,
    time_limit=600,
    soft_time_limit=560,
)
def reconcile_wallet_balances(self):
    """WAL-43: 每日对账——校验 OrganizationWallet 余额与交易流水一致性。

    逐一比对每个 OrganizationWallet 的 credits_precise / credits_frozen_precise
    与关联 WalletTransaction.amount_precise 汇总值，不一致时创建 critical 告警。
    """
    try:
        return _run_wallet_reconciliation()
    except Exception as exc:
        logger.error("[reconcile_wallets] 任务异常: %s", exc, exc_info=True)
        raise self.retry(exc=exc)


def reclaim_stale_frozen_credits(
    *,
    stale_threshold_minutes: int | None = None,
    batch_limit: int | None = None,
) -> dict:
    """扫描超时冻结并释放残留冻结额度。

    仅扫描：
    - ``WalletTransaction.transaction_type='freeze'``
    - ``created_at`` 早于阈值
    - ``reference_key`` 非空
    - 同一 ``reference_key`` / ``organization_wallet`` 下不存在 ``unfreeze`` 记录

    真正的释放仍复用 ``CreditsService.release_frozen_credits``，
    由其行锁 + unfreeze 幂等检查保证不会重复释放。
    """
    from django.utils import timezone

    from apps.services.billing.models import (
        BillingReservation,
        BillingReservationAllocation,
    )
    from apps.services.billing.services.degradation_tracker import track_billing_degradation

    from .models import WalletTransaction
    from .services.credits_service import CreditsService

    resolved_threshold_minutes = _resolve_stale_threshold_minutes(stale_threshold_minutes)
    resolved_batch_limit = _resolve_batch_limit(batch_limit)
    threshold = timezone.now() - timedelta(minutes=resolved_threshold_minutes)

    unfreeze_exists = WalletTransaction.objects.filter(
        transaction_type="unfreeze",
        reference_key=OuterRef("reference_key"),
        organization_wallet_id=OuterRef("organization_wallet_id"),
    )
    active_search_reservation_exists = BillingReservationAllocation.objects.filter(
        source_type="organization_wallet",
        source_reference=OuterRef("reference_key"),
        reservation__status__in=[
            BillingReservation.Status.RESERVED,
            BillingReservation.Status.EXECUTING,
            BillingReservation.Status.SETTLEMENT_PENDING,
            BillingReservation.Status.UNKNOWN,
        ],
    )

    with transaction.atomic():
        stale_candidates = list(
            WalletTransaction.objects
            .select_for_update(skip_locked=True)
            .filter(
                transaction_type="freeze",
                organization_wallet__isnull=False,
                created_at__lt=threshold,
                reference_key__isnull=False,
            )
            .annotate(has_unfreeze=Exists(unfreeze_exists))
            .annotate(has_active_search_reservation=Exists(active_search_reservation_exists))
            .filter(has_unfreeze=False, has_active_search_reservation=False)
            .order_by("created_at")[:resolved_batch_limit]
            .values(
                "id",
                "reference_key",
                "organization_id",
                "amount_precise",
                "created_at",
            )
        )

    released = 0
    skipped = 0
    errors = 0

    if stale_candidates:
        logger.info(
            "[release_stale_frozen] 发现候选冻结: scanned=%d threshold_minutes=%d batch_limit=%d",
            len(stale_candidates), resolved_threshold_minutes, resolved_batch_limit,
        )
    else:
        logger.debug(
            "[release_stale_frozen] 无超时冻结记录: threshold_minutes=%d",
            resolved_threshold_minutes,
        )

    for candidate in stale_candidates:
        freeze_id = str(candidate.get("reference_key") or "").strip()
        organization_id = str(candidate.get("organization_id") or "").strip()

        if not freeze_id or not organization_id:
            skipped += 1
            logger.warning(
                "[release_stale_frozen] 跳过异常冻结记录: tx=%s organization=%s freeze_id=%s",
                candidate.get("id"), organization_id, freeze_id,
            )
            continue

        try:
            ok = CreditsService.release_frozen_credits(organization_id, freeze_id)
            if ok:
                released += 1
                logger.info(
                    "[release_stale_frozen] 释放残留冻结: tx=%s organization=%s freeze_id=%s amount=%s created_at=%s",
                    candidate.get("id"),
                    organization_id,
                    freeze_id,
                    candidate.get("amount_precise"),
                    candidate.get("created_at"),
                )
            else:
                skipped += 1
                logger.warning(
                    "[release_stale_frozen] 候选冻结未释放（可能已被并发回收或钱包不存在）: "
                    "tx=%s organization=%s freeze_id=%s",
                    candidate.get("id"), organization_id, freeze_id,
                )
        except Exception as exc:
            errors += 1
            logger.warning(
                "[release_stale_frozen] 释放失败: tx=%s organization=%s freeze_id=%s err=%s",
                candidate.get("id"), organization_id, freeze_id, exc,
                exc_info=True,
            )
            try:
                track_billing_degradation(
                    meter_key="wallet.freeze_reclaim",
                    organization_id=organization_id,
                    biz_type="freeze_reclaim",
                    error=str(exc),
                )
            except Exception:
                pass

    summary = {
        "released": released,
        "skipped": skipped,
        "errors": errors,
        "scanned": len(stale_candidates),
        "threshold_minutes": resolved_threshold_minutes,
        "batch_limit": resolved_batch_limit,
    }
    if len(stale_candidates) >= resolved_batch_limit:
        logger.warning(
            "[release_stale_frozen] 命中批次上限，可能仍有积压冻结待下轮处理: %s",
            summary,
        )
    elif released > 0 or errors > 0:
        logger.info("[release_stale_frozen] 执行完成: %s", summary)
    return summary


def _resolve_stale_threshold_minutes(override: int | None = None) -> int:
    raw_value = (
        override
        if override is not None
        else getattr(settings, "WALLET_STALE_FREEZE_THRESHOLD_MINUTES", _STALE_THRESHOLD_MINUTES)
    )
    try:
        return max(int(raw_value), 1)
    except (TypeError, ValueError):
        logger.warning(
            "[release_stale_frozen] 非法阈值配置，回退默认值: %s",
            raw_value,
        )
        return _STALE_THRESHOLD_MINUTES


def _resolve_batch_limit(override: int | None = None) -> int:
    raw_value = (
        override
        if override is not None
        else getattr(settings, "WALLET_STALE_FREEZE_BATCH_LIMIT", _BATCH_LIMIT)
    )
    try:
        return max(int(raw_value), 1)
    except (TypeError, ValueError):
        logger.warning(
            "[release_stale_frozen] 非法 batch_limit 配置，回退默认值: %s",
            raw_value,
        )
        return _BATCH_LIMIT


def _run_wallet_reconciliation() -> dict:
    from datetime import date
    from decimal import Decimal

    from django.core.cache import cache
    from django.db.models import Sum

    from apps.services.billing.models import BillingAnomalyAlert

    from .models import CREDITS_QUANTIZE, OrganizationWallet, WalletTransaction

    tolerance = CREDITS_QUANTIZE
    today = date.today().isoformat()
    scanned = 0
    mismatched = 0
    errors = 0

    for wallet in OrganizationWallet.objects.all().iterator():
        scanned += 1
        try:
            balance_sum = (
                WalletTransaction.objects.filter(
                    organization_wallet=wallet,
                    transaction_type__in=_BALANCE_TX_TYPES,
                ).aggregate(total=Sum("amount_precise"))["total"]
                or Decimal("0")
            )
            if abs(wallet.credits_precise - balance_sum) > tolerance:
                cache_key = f"reconcile_wallet_{wallet.id}_{today}"
                if not cache.get(cache_key):
                    try:
                        BillingAnomalyAlert.objects.create(
                            alert_type="charge_failed",
                            severity="critical",
                            organization_id=wallet.organization_id,
                            metric_name="wallet_balance_mismatch",
                            current_value=wallet.credits_precise,
                            baseline_value=balance_sum,
                            message=(
                                f"钱包余额对账不一致: organization={wallet.organization_id}, "
                                f"余额={wallet.credits_precise}, 交易合计={balance_sum}, "
                                f"差额={wallet.credits_precise - balance_sum}"
                            ),
                        )
                    except Exception:
                        pass
                    cache.set(cache_key, True, timeout=86400)
                mismatched += 1

            frozen_sum = (
                WalletTransaction.objects.filter(
                    organization_wallet=wallet,
                    transaction_type__in=_FROZEN_TX_TYPES,
                ).aggregate(total=Sum("amount_precise"))["total"]
                or Decimal("0")
            )
            if abs(wallet.credits_frozen_precise - frozen_sum) > tolerance:
                frozen_key = f"reconcile_wallet_frozen_{wallet.id}_{today}"
                if not cache.get(frozen_key):
                    try:
                        BillingAnomalyAlert.objects.create(
                            alert_type="frozen_leak",
                            severity="critical",
                            organization_id=wallet.organization_id,
                            metric_name="wallet_frozen_balance_mismatch",
                            current_value=wallet.credits_frozen_precise,
                            baseline_value=frozen_sum,
                            message=(
                                f"钱包冻结余额对账不一致: organization={wallet.organization_id}, "
                                f"冻结余额={wallet.credits_frozen_precise}, 冻结交易合计={frozen_sum}, "
                                f"差额={wallet.credits_frozen_precise - frozen_sum}"
                            ),
                        )
                    except Exception:
                        pass
                    cache.set(frozen_key, True, timeout=86400)
                mismatched += 1

        except Exception as exc:
            errors += 1
            logger.warning(
                "[reconcile_wallets] wallet=%s 校验失败: %s",
                wallet.id, exc, exc_info=True,
            )

        if scanned % 500 == 0:
            logger.info(
                "[reconcile_wallets] 进度: scanned=%d mismatched=%d errors=%d",
                scanned, mismatched, errors,
            )

    summary = {"scanned": scanned, "mismatched": mismatched, "errors": errors}
    if mismatched or errors:
        logger.warning("[reconcile_wallets] 对账发现异常: %s", summary)
    else:
        logger.info("[reconcile_wallets] 对账完成，全部一致: %s", summary)
    return summary


WALLET_BEAT_SCHEDULE = {
    "preheat-monthly-budgets": {
        "task": "apps.users.wallet.tasks.preheat_monthly_budgets",
        "schedule": crontab(day_of_month="1", hour="0", minute="5"),
        "options": {"expires": 3600},
    },
    "reconcile-wallet-balances": {
        "task": "wallet.reconcile_wallet_balances",
        "schedule": crontab(hour="3", minute="0"),
        "options": {"expires": 3600},
    },
}
