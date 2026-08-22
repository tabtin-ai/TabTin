"""会员生命周期写入服务。

PR4 只落地「已支付升级订单」的生效动作：
- 不新增 Subscription 主表；
- 不处理降级 / switch / 自动续费 / 宽限期；
- 不重新计算价格，只消费 PaymentOrder.business_data 中冻结的快照。
"""

from __future__ import annotations

import logging
from decimal import Decimal
from typing import Any

from django.db import transaction
from django.utils import timezone

from apps.services.billing.services import (
    OrganizationEntitlementSyncService,
    OrganizationLlmBudgetService,
)
from apps.services.payment.models import PaymentOrder

from ..exceptions import MembershipLifecycleError
from ..models import MembershipTier, OrganizationMembership, OrganizationMembershipChangeLog

logger = logging.getLogger(__name__)


class SubscriptionService:
    """应用已冻结、已支付的套餐生命周期变更。"""

    @staticmethod
    def _as_decimal(value: Any, *, field_name: str) -> Decimal:
        try:
            return Decimal(str(value))
        except Exception as exc:
            raise MembershipLifecycleError(
                f"升级订单快照字段无效: {field_name}",
                "MEMBERSHIP_UPGRADE_ORDER_SNAPSHOT_INVALID",
            ) from exc

    @staticmethod
    def _mark_failed(order_id: str, *, code: str, message: str) -> None:
        with transaction.atomic():
            order = PaymentOrder.objects.select_for_update().filter(id=order_id).first()
            if not order:
                return
            business_data = dict(order.business_data or {})
            change_log_id = business_data.get("change_log_id")
            order.benefit_status = "failed"
            order.failure_code = code
            order.failure_message = message
            order.save(update_fields=[
                "benefit_status",
                "failure_code",
                "failure_message",
                "updated_at",
            ])
            if change_log_id:
                OrganizationMembershipChangeLog.objects.filter(
                    id=change_log_id,
                    status__in=[
                        OrganizationMembershipChangeLog.Status.PAID,
                        OrganizationMembershipChangeLog.Status.APPLYING,
                    ],
                ).update(
                    status=OrganizationMembershipChangeLog.Status.FAILED,
                    reason=message,
                    updated_at=timezone.now(),
                )

    def apply_paid_upgrade(self, order_id: str) -> str:
        """会员升级权益生效。

        幂等规则：
        - benefit_status=completed 或 order.status=completed 直接返回；
        - 只读取订单冻结的 pricing_snapshot / change_plan；
        - 保持原 start_date/end_date；
        - 当前月 included_credits 改为目标套餐月额度，consumed/topup 保持不变。
        """
        try:
            with transaction.atomic():
                order = PaymentOrder.objects.get(id=order_id)
                business_data = dict(order.business_data or {})

                if order.order_type != "membership" or business_data.get("change_type") != "upgrade":
                    raise MembershipLifecycleError(
                        "订单不是会员升级订单",
                        "MEMBERSHIP_UPGRADE_ORDER_INVALID",
                    )

                if order.benefit_status == "completed" or order.status == "completed":
                    return order.id

                if order.status != "paid":
                    raise MembershipLifecycleError(
                        "会员升级订单尚未支付",
                        "MEMBERSHIP_UPGRADE_ORDER_NOT_PAID",
                    )

                pricing_snapshot = dict(business_data.get("pricing_snapshot") or {})
                change_plan = dict(business_data.get("change_plan") or {})
                change_log_id = business_data.get("change_log_id")
                membership_id = change_plan.get("membership_id") or business_data.get("membership_id")
                target_tier_id = change_plan.get("to_tier_id") or business_data.get("tier_id")
                frozen_lifecycle_version = change_plan.get("membership_lifecycle_version")
                frozen_from_tier_id = change_plan.get("from_tier_id")
                billing_cycle = change_plan.get("billing_cycle") or business_data.get("billing_cycle") or "monthly"

                if not membership_id or not target_tier_id or frozen_lifecycle_version is None:
                    raise MembershipLifecycleError(
                        "升级订单缺少冻结变更计划",
                        "MEMBERSHIP_UPGRADE_CHANGE_PLAN_MISSING",
                    )

                membership = (
                    OrganizationMembership.objects
                    .select_for_update()
                    .select_related("tier")
                    .filter(id=str(membership_id), organization_id=order.organization_id)
                    .first()
                )
                if not membership:
                    order.status = "completed"
                    order.benefit_status = "completed"
                    order.save(update_fields=["status", "benefit_status", "updated_at"])
                    return order.id
                change_log = (
                    OrganizationMembershipChangeLog.objects
                    .select_for_update()
                    .filter(id=change_log_id)
                    .first()
                    if change_log_id
                    else None
                )
                order = (
                    PaymentOrder.objects
                    .select_for_update()
                    .select_related("user")
                    .get(id=order_id)
                )
                business_data = dict(order.business_data or {})
                if (
                    change_log
                    and str(business_data.get("payment_chain_winner_order_id") or "") == str(order.id)
                    and str(change_log.payment_order_id or "") != str(order.id)
                ):
                    metadata = dict(change_log.metadata or {})
                    metadata["payment_source"] = {
                        "method": order.payment_method,
                        "channel": "third_party",
                    }
                    change_log.metadata = metadata
                    change_log.payment_order_id = str(order.id)
                    change_log.save(update_fields=["metadata", "payment_order_id", "updated_at"])

                if str(membership.lifecycle_version) != str(frozen_lifecycle_version) or (
                    frozen_from_tier_id and str(membership.tier_id) != str(frozen_from_tier_id)
                ):
                    order.benefit_status = "failed"
                    order.failure_code = "MEMBERSHIP_STATE_CHANGED_AFTER_PAYMENT"
                    order.failure_message = "支付后会员状态已变化，升级未自动生效"
                    order.save(update_fields=[
                        "benefit_status",
                        "failure_code",
                        "failure_message",
                        "updated_at",
                    ])
                    if change_log:
                        change_log.mark_failed(reason=order.failure_message)
                    return order.id

                target_tier = MembershipTier.objects.get(id=str(target_tier_id), is_active=True)
                target_period_price = self._as_decimal(
                    pricing_snapshot.get("target_effective_period_price"),
                    field_name="target_effective_period_price",
                ).quantize(Decimal("0.01"))

                order.benefit_status = "processing"
                order.failure_code = ""
                order.failure_message = ""
                order.save(update_fields=[
                    "benefit_status",
                    "failure_code",
                    "failure_message",
                    "updated_at",
                ])
                if change_log:
                    change_log.status = OrganizationMembershipChangeLog.Status.APPLYING
                    change_log.save(update_fields=["status", "updated_at"])

                membership.tier = target_tier
                membership.billing_cycle = billing_cycle
                membership.status = "active"
                membership.current_actual_paid_period_price = target_period_price
                membership.related_order_id = str(order.id)
                membership.purchased_by = str(order.user_id)
                membership.lifecycle_version = int(membership.lifecycle_version or 0) + 1
                membership.save(update_fields=[
                    "tier",
                    "billing_cycle",
                    "status",
                    "current_actual_paid_period_price",
                    "related_order_id",
                    "purchased_by",
                    "lifecycle_version",
                    "updated_at",
                ])

                OrganizationEntitlementSyncService.sync_organization_entitlement(
                    str(order.organization_id),
                    metadata_updates={
                        "membership_upgrade_order_id": str(order.id),
                        "membership_change_log_id": str(change_log_id or ""),
                    },
                )

                budget = OrganizationLlmBudgetService.get_or_create_monthly_budget_locked(
                    str(order.organization_id),
                    at_time=timezone.now(),
                )
                budget.included_credits = Decimal(str(target_tier.included_llm_credits_monthly or 0))
                budget.updated_from_entitlement_at = timezone.now()
                budget.save(update_fields=[
                    "included_credits",
                    "updated_from_entitlement_at",
                    "updated_at",
                ])

                if change_log:
                    meta = dict(change_log.metadata or {})
                    meta["payment_completed"] = True
                    meta["applied_by_order_benefit_service"] = True
                    change_log.metadata = meta
                    change_log.status = OrganizationMembershipChangeLog.Status.APPLIED
                    change_log.applied_at = timezone.now()
                    change_log.save(update_fields=[
                        "metadata",
                        "status",
                        "applied_at",
                        "updated_at",
                    ])

                order.status = "completed"
                order.benefit_status = "completed"
                order.failure_code = ""
                order.failure_message = ""
                order.save(update_fields=[
                    "status",
                    "benefit_status",
                    "failure_code",
                    "failure_message",
                    "updated_at",
                ])

                logger.info(
                    "[SubscriptionService] 会员升级已生效: organization=%s order=%s membership=%s target_tier=%s",
                    order.organization_id,
                    order.order_no,
                    membership.id,
                    target_tier.id,
                )
                return order.id
        except MembershipLifecycleError:
            raise
        except Exception as exc:
            logger.exception("[SubscriptionService] 会员升级生效失败: order=%s", order_id)
            self._mark_failed(
                str(order_id),
                code="MEMBERSHIP_UPGRADE_APPLY_FAILED",
                message=str(exc),
            )
            raise
