"""
存储套餐服务。
"""

from __future__ import annotations

import logging
from decimal import Decimal
from typing import Any, Dict, List

from dateutil.relativedelta import relativedelta
from django.db import transaction
from django.utils import timezone

from apps.services.billing.models import StoragePackagePlan, OrganizationStorageSubscription
from apps.services.billing.services.entitlement_service import OrganizationEntitlementSyncService

logger = logging.getLogger(__name__)


class OrganizationStoragePackageService:
    """存储套餐目录与发放服务。"""

    @classmethod
    def list_packages(cls, *, active_only: bool = True):
        queryset = StoragePackagePlan.objects.all()
        if active_only:
            queryset = queryset.filter(is_active=True)
        return queryset.order_by("sort_order", "-created_at")

    @classmethod
    @transaction.atomic
    def activate_storage_package(
        cls,
        *,
        organization_id: str,
        package_plan_id: str,
        order_id: str = "",
        purchased_by: str = "",
    ) -> OrganizationStorageSubscription:
        if not organization_id:
            raise ValueError("organization_id 不能为空")

        package_plan = StoragePackagePlan.objects.get(id=package_plan_id, is_active=True)

        if order_id:
            existing = OrganizationStorageSubscription.objects.filter(order_id=order_id).first()
            if existing:
                OrganizationEntitlementSyncService.sync_organization_entitlement(organization_id)
                return existing

        now = timezone.now()
        subscription = OrganizationStorageSubscription.objects.create(
            organization_id=organization_id,
            package_plan=package_plan,
            order_id=order_id or None,
            purchased_by=purchased_by or "",
            storage_bytes=package_plan.total_storage_bytes,
            start_at=now,
            end_at=now + relativedelta(months=package_plan.duration_months),
            status="active",
            metadata={
                "package_name": package_plan.name,
                "duration_months": package_plan.duration_months,
                "storage_bytes": package_plan.storage_bytes,
                "bonus_storage_bytes": package_plan.bonus_storage_bytes,
            },
        )

        OrganizationEntitlementSyncService.sync_organization_entitlement(
            organization_id,
            metadata_updates={
                "last_storage_package_purchase_at": now.isoformat(),
                "last_storage_package_id": str(package_plan.id),
                "last_storage_package_name": package_plan.name,
            },
        )

        logger.info(
            "存储套餐发放成功: organization=%s package=%s order=%s bytes=%s end_at=%s",
            organization_id, package_plan.id, order_id, subscription.storage_bytes, subscription.end_at,
        )
        return subscription

    @classmethod
    @transaction.atomic
    def expire_due_subscriptions(cls, *, organization_id: str = "") -> Dict[str, Any]:
        now = timezone.now()
        queryset = OrganizationStorageSubscription.objects.select_for_update().filter(
            status="active",
            end_at__lte=now,
        )
        if organization_id:
            queryset = queryset.filter(organization_id=organization_id)

        subscriptions = list(queryset)
        if not subscriptions:
            return {"expired_count": 0, "renewed_count": 0, "organization_ids": []}

        expired_ids: List[str] = []
        renewed_ids: List[str] = []
        expired_organization_ids: set[str] = set()

        for sub in subscriptions:
            if sub.auto_renew:
                renewed = cls._try_auto_renew(sub)
                if renewed:
                    renewed_ids.append(str(sub.id))
                    sub.status = "expired"
                    sub.metadata = sub.metadata or {}
                    sub.metadata["auto_renewed_to"] = str(renewed.id)
                    sub.save(update_fields=["status", "metadata", "updated_at"])
                    continue
            sub.status = "expired"
            sub.save(update_fields=["status", "updated_at"])
            expired_ids.append(str(sub.id))
            if sub.organization_id:
                expired_organization_ids.add(str(sub.organization_id))

        organization_ids = sorted({
            str(sub.organization_id)
            for sub in subscriptions
            if sub.organization_id
        })
        for ws_id in organization_ids:
            OrganizationEntitlementSyncService.sync_organization_entitlement(
                ws_id,
                metadata_updates={
                    "last_storage_package_expire_at": now.isoformat(),
                },
            )

        if expired_organization_ids:
            cls._check_over_quota_after_expiry(sorted(expired_organization_ids))

        logger.info(
            "过期存储套餐处理完成: expired=%d renewed=%d organization_count=%d",
            len(expired_ids), len(renewed_ids), len(organization_ids),
        )
        return {
            "expired_count": len(expired_ids),
            "renewed_count": len(renewed_ids),
            "expired_ids": expired_ids,
            "renewed_ids": renewed_ids,
            "organization_ids": organization_ids,
        }

    @classmethod
    def _try_auto_renew(cls, subscription: OrganizationStorageSubscription):
        """尝试从组织钱包扣款并创建新订阅周期。

        扣款与订阅创建在同一 savepoint 内，确保原子性（方案 8.6）。
        """
        plan = subscription.package_plan
        if not plan or not plan.is_active:
            logger.info(
                "自动续费跳过（套餐已下架）: sub=%s plan=%s",
                subscription.id, getattr(plan, "id", None),
            )
            return None

        from django.conf import settings
        from apps.users.wallet.exceptions import InsufficientCreditsError
        from apps.users.wallet.services.organization_wallet_service import OrganizationWalletService

        credits_rate = Decimal(getattr(settings, "CREDITS_PER_YUAN", 100))
        credits_cost = plan.price * credits_rate

        try:
            with transaction.atomic():
                wallet_service = OrganizationWalletService()
                wallet_service.consume(
                    organization_id=subscription.organization_id,
                    credits_amount=credits_cost,
                    description=f"存储套餐自动续费: {plan.name}",
                    related_order_id=f"ar_{subscription.id.hex}",
                    user_id=subscription.purchased_by or "",
                )
                new_sub = cls.activate_storage_package(
                    organization_id=subscription.organization_id,
                    package_plan_id=str(plan.id),
                    order_id=f"ar_{subscription.id.hex}",
                    purchased_by=subscription.purchased_by or "",
                )
                logger.info(
                    "存储套餐自动续费成功: old_sub=%s new_sub=%s organization=%s",
                    subscription.id, new_sub.id, subscription.organization_id,
                )
                return new_sub
        except InsufficientCreditsError:
            logger.warning(
                "存储套餐自动续费失败（余额不足）: sub=%s organization=%s",
                subscription.id, subscription.organization_id,
            )
            _publish_auto_renew_failed(subscription)
            return None
        except Exception as exc:
            logger.error(
                "存储套餐自动续费异常: sub=%s error=%s",
                subscription.id, exc, exc_info=True,
            )
            _publish_auto_renew_failed(subscription, reason="system_error")
            return None

    @classmethod
    @transaction.atomic
    def cancel_subscription(
        cls,
        *,
        organization_id: str,
        subscription_id: str,
        cancelled_by: str,
    ) -> Dict[str, Any]:
        """取消存储订阅的自动续费。

        采用「到期不续费」模式（方案 8.4）：订阅保持 active 直到自然过期，
        仅将 auto_renew 置 False 并记录取消信息。
        """
        sub = OrganizationStorageSubscription.objects.select_for_update().get(
            id=subscription_id, organization_id=organization_id, status="active",
        )
        sub.auto_renew = False
        sub.metadata = sub.metadata or {}
        sub.metadata["cancel_requested_by"] = cancelled_by
        sub.metadata["cancel_requested_at"] = timezone.now().isoformat()
        sub.save(update_fields=["auto_renew", "metadata", "updated_at"])

        logger.info(
            "存储订阅取消自动续费: sub=%s organization=%s cancelled_by=%s end_at=%s",
            subscription_id, organization_id, cancelled_by, sub.end_at,
        )
        return {
            "subscription_id": str(sub.id),
            "status": sub.status,
            "auto_renew": False,
            "end_at": sub.end_at.isoformat(),
        }

    @classmethod
    @transaction.atomic
    def enable_auto_renew(
        cls,
        *,
        organization_id: str,
        subscription_id: str,
        enabled_by: str,
    ) -> Dict[str, Any]:
        """重新开启存储订阅的自动续费。"""
        sub = OrganizationStorageSubscription.objects.select_for_update().get(
            id=subscription_id, organization_id=organization_id, status="active",
        )
        sub.auto_renew = True
        sub.metadata = sub.metadata or {}
        sub.metadata.pop("cancel_requested_by", None)
        sub.metadata.pop("cancel_requested_at", None)
        sub.metadata["auto_renew_enabled_by"] = enabled_by
        sub.metadata["auto_renew_enabled_at"] = timezone.now().isoformat()
        sub.save(update_fields=["auto_renew", "metadata", "updated_at"])

        logger.info(
            "存储订阅重新开启自动续费: sub=%s organization=%s enabled_by=%s",
            subscription_id, organization_id, enabled_by,
        )
        return {
            "subscription_id": str(sub.id),
            "status": sub.status,
            "auto_renew": True,
            "end_at": sub.end_at.isoformat(),
        }

    @classmethod
    def _check_over_quota_after_expiry(cls, organization_ids: List[str]) -> None:
        """套餐过期后检查是否超过新配额，推送 storage_critical 告警（方案 9.2）。"""
        from apps.services.billing.models import OrganizationStorageUsage
        from apps.services.billing.services.policy_service import OrganizationBillingPolicyService
        from apps.services.billing.ws_events import publish_billing_event

        for ws_id in organization_ids:
            try:
                usage = OrganizationStorageUsage.objects.filter(organization_id=ws_id).first()
                if not usage:
                    continue
                active_bytes = int(usage.active_storage_bytes or 0)
                if active_bytes <= 0:
                    continue

                alloc = OrganizationBillingPolicyService.resolve_storage_billable_bytes(
                    ws_id, active_bytes,
                )
                package_bytes = int(alloc.get("storage_package_bytes", 0))
                if package_bytes <= 0:
                    continue

                usage_ratio = active_bytes / package_bytes
                if usage_ratio >= 0.95:
                    _wid, _ratio, _used, _pkg = ws_id, usage_ratio, active_bytes, package_bytes
                    transaction.on_commit(
                        lambda wid=_wid, ratio=_ratio, used=_used, pkg=_pkg:
                        publish_billing_event(wid, "storage_critical", {
                            "level": "critical",
                            "usage_percent": round(ratio * 100),
                            "used_bytes": used,
                            "package_bytes": pkg,
                            "trigger": "package_expired",
                        })
                    )
            except Exception as exc:
                logger.warning(
                    "套餐过期后超额检查失败（不影响主流程）: organization=%s error=%s",
                    ws_id, exc,
                )


def _publish_auto_renew_failed(
    subscription: OrganizationStorageSubscription,
    reason: str = "insufficient_balance",
) -> None:
    """推送存储套餐自动续费失败事件，使用 on_commit 延迟到事务提交后。"""
    from apps.services.billing.ws_events import publish_billing_event

    wt_id = subscription.organization_id
    plan = subscription.package_plan
    payload = {
        "subscription_id": str(subscription.id),
        "package_name": plan.name if plan else "",
        "end_at": subscription.end_at.isoformat() if subscription.end_at else "",
        "reason": reason,
    }
    transaction.on_commit(
        lambda: publish_billing_event(wt_id, "storage_auto_renew_failed", payload)
    )
