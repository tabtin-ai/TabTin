"""
订单权益发放服务
"""

from __future__ import annotations

import logging
from decimal import Decimal
from typing import Optional

from django.db import transaction

from apps.services.payment.models import PaymentOrder

logger = logging.getLogger(__name__)


class OrderBenefitService:
    """统一订单权益发放入口（回调与补偿任务复用）"""

    @staticmethod
    def _enqueue_superseded_order_closures(order_ids: tuple[str, ...]) -> None:
        from apps.services.payment.tasks import close_superseded_payment_order

        for order_id in order_ids:
            try:
                close_superseded_payment_order.delay(order_id)
            except Exception:
                logger.exception("提交支付链安全关单任务失败: order_id=%s", order_id)

    @staticmethod
    def _claim_membership_payment_chain(
        *,
        order_id: str,
        organization_id: str,
        chain_id: str,
    ) -> tuple[PaymentOrder, bool]:
        """确保一次更换支付方式形成的订单链只发放一次权益。"""
        chain_orders = list(
            PaymentOrder.objects
            .select_for_update()
            .filter(
                organization_id=organization_id,
                order_type="membership",
                business_data__payment_chain_id=str(chain_id),
            )
            .order_by("id")
        )
        order = next(item for item in chain_orders if str(item.id) == str(order_id))
        business_data = dict(order.business_data or {})
        if order.status not in {"paid", "completed"}:
            return order, False
        winner_id = next(
            (
                str((item.business_data or {}).get("payment_chain_winner_order_id"))
                for item in chain_orders
                if (item.business_data or {}).get("payment_chain_winner_order_id")
            ),
            "",
        )
        if winner_id and winner_id != str(order.id):
            order.benefit_status = "failed"
            order.failure_code = "DUPLICATE_PAYMENT_CHAIN"
            order.failure_message = "同一支付方式切换链已有订单完成付款，请联系客服处理重复付款"
            order.save(update_fields=[
                "benefit_status",
                "failure_code",
                "failure_message",
                "updated_at",
            ])
            return order, False

        orders_to_close: list[str] = []
        for item in chain_orders:
            item_business_data = dict(item.business_data or {})
            item_business_data["payment_chain_winner_order_id"] = str(order.id)
            item.business_data = item_business_data
            update_fields = ["business_data", "updated_at"]
            if item.id != order.id and item.status in {"pending", "paying"}:
                was_paying = item.status == "paying"
                item.status = "cancelled"
                item.failure_code = "PAYMENT_CHAIN_SUPERSEDED"
                item.failure_message = f"同一支付链订单 {order.order_no} 已确认付款"
                update_fields.extend(["status", "failure_code", "failure_message"])
                if was_paying and item.payment_method in {"alipay", "wechat"}:
                    item_business_data["payment_chain_close_pending"] = True
                    orders_to_close.append(str(item.id))
            item.save(update_fields=update_fields)

        if orders_to_close:
            transaction.on_commit(
                lambda order_ids=tuple(orders_to_close): (
                    OrderBenefitService._enqueue_superseded_order_closures(order_ids)
                )
            )
        return order, True

    @staticmethod
    def _resolve_total_credits(order: PaymentOrder) -> tuple[Decimal, str]:
        """返回 (credits 数量, 套餐名)，credits 统一由服务端套餐决定。"""
        business_data = order.business_data or {}
        package_name = business_data.get("package_name", "credits 充值")

        from apps.users.wallet.models import CreditPackage

        package_id = business_data.get("package_id", "")
        if not package_id:
            return Decimal("0"), package_name

        try:
            pkg = CreditPackage.objects.get(id=package_id)
            if business_data.get("credits_snapshot_source") == "credit_package":
                total_credits = business_data.get("total_credits")
                if total_credits:
                    return Decimal(str(total_credits)), package_name
            return Decimal(str(pkg.total_credits)), pkg.name
        except CreditPackage.DoesNotExist:
            return Decimal("0"), package_name

    @staticmethod
    def grant(order_id: str) -> Optional[str]:
        seed = PaymentOrder.objects.only(
            "id",
            "organization_id",
            "order_type",
            "business_data",
        ).get(id=order_id)
        seed_business_data = dict(seed.business_data or {})
        chain_id = (
            seed_business_data.get("payment_chain_id")
            if seed.order_type == "membership"
            else None
        )
        with transaction.atomic():
            if chain_id:
                order, chain_claimed = OrderBenefitService._claim_membership_payment_chain(
                    order_id=str(order_id),
                    organization_id=str(seed.organization_id),
                    chain_id=str(chain_id),
                )
            else:
                order = (
                    PaymentOrder.objects
                    .select_for_update()
                    .select_related("user")
                    .get(id=order_id)
                )
                chain_claimed = True

            if order.status == "completed":
                logger.info(f"订单已完成，跳过重复发放: {order.order_no}")
                return order.id

            if order.status not in ["paid", "completed"]:
                logger.warning(f"订单未支付，无法发放权益: {order.order_no}, 状态={order.status}")
                return None

            if not chain_claimed:
                return order.id

            business_data = order.business_data or {}
            membership_change_type = (
                business_data.get("change_type")
                if order.order_type == "membership"
                else None
            )

        if membership_change_type == "upgrade":
            from apps.users.membership.services.subscription_service import (
                SubscriptionService,
            )

            return SubscriptionService().apply_paid_upgrade(str(order.id))
        if membership_change_type in {"renewal", "switch"}:
            from apps.users.membership.services.subscription_lifecycle_service import (
                SubscriptionLifecycleService,
            )

            lifecycle_service = SubscriptionLifecycleService()
            if membership_change_type == "renewal":
                return lifecycle_service.apply_paid_renewal(str(order.id))
            return lifecycle_service.apply_paid_switch(str(order.id))

        with transaction.atomic():
            order = PaymentOrder.objects.select_for_update().select_related("user").get(id=order_id)

            if order.status == "completed":
                logger.info(f"订单已完成，跳过重复发放: {order.order_no}")
                return order.id

            if order.status not in ["paid", "completed"]:
                logger.warning(f"订单未支付，无法发放权益: {order.order_no}, 状态={order.status}")
                return None

            if order.order_type == "membership":
                business_data = order.business_data or {}
                if business_data.get("change_type") == "upgrade":
                    from apps.users.membership.services.subscription_service import (
                        SubscriptionService,
                    )

                    return SubscriptionService().apply_paid_upgrade(str(order.id))
                if business_data.get("change_type") in {"renewal", "switch"}:
                    from apps.users.membership.services.subscription_lifecycle_service import (
                        SubscriptionLifecycleService,
                    )

                    lifecycle_service = SubscriptionLifecycleService()
                    if business_data.get("change_type") == "renewal":
                        return lifecycle_service.apply_paid_renewal(str(order.id))
                    return lifecycle_service.apply_paid_switch(str(order.id))

                tier_id = business_data.get("tier_id")
                if not tier_id:
                    raise ValueError("订单缺少会员等级信息")

                # P2: 优先走 organization 级别会员
                organization_id = getattr(order, 'organization_id', '') or (order.business_data or {}).get("organization_id", "")
                if organization_id:
                    from apps.users.membership.services.organization_membership_service import (
                        OrganizationMembershipService,
                    )
                    from apps.users.membership.models import OrganizationMembership

                    # 判断是否为续费：同等级即为续费（含已过期情形），不同等级才是升降级
                    existing_membership = OrganizationMembership.objects.filter(
                        organization_id=organization_id
                    ).first()
                    is_renewal = (
                        existing_membership is not None
                        and str(existing_membership.tier_id) == str(tier_id)
                    )

                    OrganizationMembershipService().activate_membership(
                        organization_id=organization_id,
                        tier_id=tier_id,
                        order_id=order.id,
                        is_renewal=is_renewal,
                        purchased_by=str(order.user_id),
                        actual_paid_period_price=order.amount,
                    )
                else:
                    raise ValueError(
                        f"会员订单缺少 organization_id，用户级会员已废弃: order={order.order_no}"
                    )

            elif order.order_type == "credits":
                organization_id = getattr(order, 'organization_id', '') or (order.business_data or {}).get('organization_id', '')
                if not organization_id:
                    raise ValueError(
                        f"点券订单缺少 organization_id，用户级充值已废弃: order={order.order_no}"
                    )

                from apps.users.wallet.services import OrganizationWalletService

                total_credits, package_name = OrderBenefitService._resolve_total_credits(order)

                if total_credits:
                    OrganizationWalletService().recharge(
                        organization_id=organization_id,
                        credits_amount=total_credits,
                        order_id=str(order.id),
                        user_id=str(order.user_id),
                        description=f'credits 充值: {package_name}',
                    )
                else:
                    raise ValueError(f"credits 订单缺少有效 package_id: order={order.order_no}")
            elif order.order_type == "storage_package":
                organization_id = getattr(order, "organization_id", "") or (order.business_data or {}).get("organization_id", "")
                package_id = (order.business_data or {}).get("storage_package_id")
                if not organization_id:
                    raise ValueError("storage_package 订单缺少 organization_id")
                if not package_id:
                    raise ValueError("storage_package 订单缺少 storage_package_id")

                from apps.services.billing.services import OrganizationStoragePackageService

                OrganizationStoragePackageService.activate_storage_package(
                    organization_id=organization_id,
                    package_plan_id=str(package_id),
                    order_id=str(order.id),
                    purchased_by=str(order.user_id),
                )
            elif order.order_type == "billing_addon":
                from apps.services.billing.services import AddonEntitlementService

                AddonEntitlementService.grant_addon_from_order(str(order.id))

            elif order.order_type == "cash_wallet":
                organization_id = (
                    getattr(order, "organization_id", "")
                    or (order.business_data or {}).get("organization_id", "")
                )
                if not organization_id:
                    raise ValueError(
                        f"现金钱包订单缺少 organization_id: order={order.order_no}"
                    )

                from apps.users.wallet.services.organization_cash_wallet_service import (
                    OrganizationCashWalletService,
                )

                OrganizationCashWalletService().recharge(
                    organization_id=str(organization_id),
                    amount_cny=order.paid_amount or order.amount,
                    description=f"现金钱包充值: {order.order_no}",
                    operator_user_id=str(order.user_id),
                    related_order_id=str(order.id),
                )

            order.status = "completed"
            # 首次订阅等通用路径此前只改 status，前端/active 接口会按 benefit_status
            # 判断权益是否生效，必须同步写成 completed。
            order.benefit_status = "completed"
            order.failure_code = ""
            order.failure_message = ""
            order.save(
                update_fields=[
                    "status",
                    "benefit_status",
                    "failure_code",
                    "failure_message",
                    "updated_at",
                ]
            )

            logger.info(f"订单权益发放成功: {order.order_no}")
            return order.id
