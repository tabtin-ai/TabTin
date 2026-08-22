"""统一会员订单支付服务（PR5.2-A）。"""
from __future__ import annotations

from decimal import Decimal

from django.db import transaction
from django.utils import timezone

from apps.services.payment.models import PaymentOrder
from apps.services.payment.services.factory import PaymentServiceFactory
from apps.services.payment.services.benefit_service import OrderBenefitService
from apps.users.membership.models import OrganizationMembershipChangeLog
from apps.users.wallet.services.organization_cash_wallet_service import (
    InsufficientCashBalance,
    OrganizationCashWalletService,
)


class MembershipPaymentError(Exception):
    def __init__(self, message: str, code: str, data: dict | None = None):
        super().__init__(message)
        self.code = code
        self.data = data or {}


class MembershipPaymentService:
    """唯一会员订单余额支付入口；订单金额和动作均读取冻结快照。"""

    CHANGE_TYPES = {"new", "upgrade", "renewal", "switch"}

    def payment_options(self, *, organization_id: str, order_id: str) -> dict:
        order = PaymentOrder.objects.filter(
            id=str(order_id), organization_id=str(organization_id), order_type="membership"
        ).first()
        if not order:
            raise MembershipPaymentError("会员订单不存在", "MEMBERSHIP_ORDER_NOT_FOUND")
        if order.status == "paying" and order.payment_method in {"alipay", "wechat"}:
            from apps.services.payment.tasks import _sync_order_with_provider

            order = _sync_order_with_provider(order)
        if order.status == "pending" and order.is_expired():
            order.status = "expired"
            order.save(update_fields=["status", "updated_at"])
        wallet = OrganizationCashWalletService().get_or_create_wallet(str(organization_id))
        balance = Decimal(str(wallet.get_available_cny() or 0)).quantize(Decimal("0.01"))
        amount = Decimal(str(order.amount or 0)).quantize(Decimal("0.01"))
        shortage = max(Decimal("0.00"), amount - balance)
        change_type = (order.business_data or {}).get("change_type") or "new"
        can_start_payment = order.status == "pending"
        can_resume_alipay = order.status == "paying" and order.payment_method == "alipay"
        can_resume_wechat = order.status == "paying" and order.payment_method == "wechat"
        can_switch_to_wallet = (
            change_type == "new"
            and shortage <= 0
            and order.status == "paying"
            and order.payment_method in {"alipay", "wechat"}
        )
        return {
            "order_id": str(order.id),
            "order_no": order.order_no,
            "order_amount": format(amount, ".2f"),
            "wallet_balance": format(balance, ".2f"),
            "payment_method": order.payment_method,
            "payment_status": order.status,
            "benefit_status": order.benefit_status,
            "payment_data": (order.business_data or {}).get("third_party_payment"),
            "can_pay": shortage <= 0 and can_start_payment,
            "shortage_amount": format(shortage, ".2f"),
            "allowed_actions": {
                "organization_wallet": (shortage <= 0 and can_start_payment) or can_switch_to_wallet,
                "alipay": can_start_payment or can_resume_alipay,
                "wechat": can_start_payment or can_resume_wechat,
            },
        }

    def pay_with_wallet(self, *, user, organization_id: str, order_id: str) -> dict:
        order = PaymentOrder.objects.filter(
            id=str(order_id), organization_id=str(organization_id), order_type="membership"
        ).first()
        if not order:
            raise MembershipPaymentError("会员订单不存在", "MEMBERSHIP_ORDER_NOT_FOUND")
        order_business_data = dict(order.business_data or {})
        replacement_order_id = order_business_data.get("replacement_order_id")
        if order.status == "cancelled" and replacement_order_id:
            replacement = PaymentOrder.objects.filter(
                id=str(replacement_order_id),
                organization_id=str(organization_id),
                order_type="membership",
                payment_method="organization_wallet",
            ).first()
            if not replacement:
                raise MembershipPaymentError(
                    "余额支付订单不存在，请刷新后重试",
                    "PAYMENT_REPLACEMENT_NOT_FOUND",
                )
            return self.pay_with_wallet(
                user=user,
                organization_id=organization_id,
                order_id=str(replacement.id),
            )

        # 扫码进行中改回余额：先安全关单并换新 pending 订单，再扣余额。
        if order.status == "paying" and order.payment_method in {"alipay", "wechat"}:
            change_type = order_business_data.get("change_type") or "new"
            if change_type != "new":
                raise MembershipPaymentError(
                    "当前订单不允许切换到组织余额",
                    "PAYMENT_SWITCH_NOT_ALLOWED",
                )
            # Provider 关单无法参与数据库事务；把本地替代单、钱包扣款和权益状态
            # 放进同一事务。后续任一步失败时本地回滚，重试可从原订单重新确认关单。
            with transaction.atomic():
                replacement = self.switch_third_party_method(
                    organization_id=organization_id,
                    order_id=str(order.id),
                    target_method="organization_wallet",
                )
                return self.pay_with_wallet(
                    user=user,
                    organization_id=organization_id,
                    order_id=str(replacement.id),
                )

        grant_required = False
        with transaction.atomic():
            order = PaymentOrder.objects.select_for_update().filter(
                id=str(order_id), organization_id=str(organization_id), order_type="membership"
            ).first()
            if not order:
                raise MembershipPaymentError("会员订单不存在", "MEMBERSHIP_ORDER_NOT_FOUND")
            change_type = (order.business_data or {}).get("change_type") or "new"
            if change_type not in self.CHANGE_TYPES:
                raise MembershipPaymentError("会员订单动作无效", "MEMBERSHIP_ACTION_MISMATCH")
            if order.status == "completed" or getattr(order, "benefit_status", "") == "completed":
                return {"order_id": str(order.id), "status": order.status, "benefit_status": order.benefit_status}
            if order.status == "paid":
                grant_required = True
            elif order.status != "pending" or order.is_expired():
                raise MembershipPaymentError("会员订单状态不允许支付", "MEMBERSHIP_ORDER_STATUS_INVALID")
            else:
                wallet = OrganizationCashWalletService().get_or_create_wallet(str(organization_id))
                amount = Decimal(str(order.amount or 0)).quantize(Decimal("0.01"))
                try:
                    if amount > 0:
                        business_data = dict(order.business_data or {})
                        snapshot = dict(business_data.get("pricing_snapshot") or {})
                        tier_name = (
                            snapshot.get("target_tier_name")
                            or business_data.get("tier_name")
                            or ""
                        )
                        billing_cycle = (
                            business_data.get("billing_cycle")
                            or snapshot.get("billing_cycle")
                            or "monthly"
                        )
                        action_label = {
                            "new": "首次订阅",
                            "upgrade": "升级套餐",
                            "renewal": "续费",
                            "switch": "切换套餐",
                        }.get(change_type, "会员支付")
                        OrganizationCashWalletService().spend(
                            organization_id=str(organization_id), amount_cny=amount,
                            transaction_type="membership_payment",
                            description=(
                                f"{action_label}·{tier_name or '会员套餐'}·"
                                f"{'按年' if billing_cycle in {'yearly', 'annual'} else '按月'}"
                                f"（{order.order_no}）"
                            ),
                            operator_user_id=str(getattr(user, "id", "") or ""),
                            related_order_id=str(order.id),
                            metadata={
                                "order_no": order.order_no,
                                "change_type": change_type,
                                "billing_cycle": billing_cycle,
                                "target_tier_name": tier_name,
                                "target_tier_id": str(
                                    snapshot.get("target_tier_id")
                                    or business_data.get("tier_id")
                                    or ""
                                ),
                                "payable_amount": format(amount, ".2f"),
                                "pricing_snapshot": snapshot,
                            },
                        )
                except InsufficientCashBalance:
                    available = Decimal(str(wallet.get_available_cny() or 0)).quantize(Decimal("0.01"))
                    raise MembershipPaymentError(
                        "组织现金钱包余额不足", "ORGANIZATION_BALANCE_INSUFFICIENT",
                        {"current_balance": format(available, ".2f"), "required_amount": format(amount, ".2f"), "shortage_amount": format(max(Decimal("0"), amount - available), ".2f")},
                    )
                order.payment_method = "organization_wallet"
                order.status = "paid"
                order.paid_amount = amount
                order.paid_at = timezone.now()
                order.benefit_status = "pending"
                order.save(update_fields=["payment_method", "status", "paid_amount", "paid_at", "benefit_status", "updated_at"])
                grant_required = True
                result = {"order_id": str(order.id), "status": order.status, "benefit_status": order.benefit_status}
        if grant_required:
            try:
                OrderBenefitService.grant(str(order.id))
            except Exception:
                PaymentOrder.objects.filter(id=order.id).update(benefit_status="failed")
                raise
            order.refresh_from_db(fields=["status", "benefit_status"])
        return {"order_id": str(order.id), "status": order.status, "benefit_status": order.benefit_status}

    def switch_third_party_method(
        self,
        *,
        organization_id: str,
        order_id: str,
        target_method: str,
    ) -> PaymentOrder:
        """确认原渠道安全关单后，以新订单号重建目标渠道支付。

        不复用原订单号，避免旧渠道迟到回调被误认为新渠道付款。
        目标可为支付宝/微信（继续扫码）或组织余额（pending，由余额支付入口扣款）。
        """
        if target_method not in {"alipay", "wechat", "organization_wallet"}:
            raise MembershipPaymentError("不支持的支付方式", "PAYMENT_METHOD_INVALID")

        order = PaymentOrder.objects.filter(
            id=str(order_id),
            organization_id=str(organization_id),
            order_type="membership",
        ).first()
        if not order:
            raise MembershipPaymentError("会员订单不存在", "MEMBERSHIP_ORDER_NOT_FOUND")
        order_business_data = dict(order.business_data or {})
        if (
            target_method == "organization_wallet"
            and (order_business_data.get("change_type") or "new") != "new"
        ):
            raise MembershipPaymentError(
                "当前订单不允许切换到组织余额",
                "PAYMENT_SWITCH_NOT_ALLOWED",
            )
        replacement_order_id = order_business_data.get("replacement_order_id")
        if order.status == "cancelled" and replacement_order_id:
            replacement = PaymentOrder.objects.filter(
                id=str(replacement_order_id),
                organization_id=str(organization_id),
                order_type="membership",
            ).first()
            if not replacement:
                raise MembershipPaymentError(
                    "更换后的支付订单不存在，请联系客服",
                    "PAYMENT_REPLACEMENT_NOT_FOUND",
                )
            if replacement.payment_method != target_method:
                raise MembershipPaymentError(
                    "支付方式已更换，请刷新后继续",
                    "PAYMENT_STATUS_CHANGED",
                    {
                        "replacement_order_id": str(replacement.id),
                        "payment_method": replacement.payment_method,
                        "payment_status": replacement.status,
                    },
                )
            replacement_business_data = dict(replacement.business_data or {})
            if replacement_business_data.get("change_type") == "upgrade":
                replacement_change_log_id = replacement_business_data.get("change_log_id")
                if (
                    not replacement_change_log_id
                    or not OrganizationMembershipChangeLog.objects.filter(
                        id=replacement_change_log_id,
                        organization_id=str(organization_id),
                        status=OrganizationMembershipChangeLog.Status.PAYMENT_PENDING,
                        payment_order_id=str(replacement.id),
                    ).exists()
                ):
                    raise MembershipPaymentError(
                        "升级支付记录状态异常，请刷新后重试",
                        "MEMBERSHIP_CHANGE_LOG_INVALID",
                    )
            if replacement.status in {"pending", "paying"}:
                return replacement
            raise MembershipPaymentError(
                "更换后的订单状态已变化，请刷新后查看",
                "PAYMENT_STATUS_CHANGED",
                {
                    "replacement_order_id": str(replacement.id),
                    "payment_method": replacement.payment_method,
                    "payment_status": replacement.status,
                    "benefit_status": replacement.benefit_status,
                },
            )
        if order.status == "paying" and order.payment_method == target_method:
            return order
        if order.status != "paying" or order.payment_method not in {"alipay", "wechat"}:
            raise MembershipPaymentError("当前订单不允许更换支付方式", "PAYMENT_SWITCH_NOT_ALLOWED")
        change_type = order_business_data.get("change_type")
        change_log_id = order_business_data.get("change_log_id")
        if change_type == "upgrade" and (
            not change_log_id
            or not OrganizationMembershipChangeLog.objects.filter(
                id=change_log_id,
                organization_id=str(organization_id),
                status=OrganizationMembershipChangeLog.Status.PAYMENT_PENDING,
                payment_order_id=str(order.id),
            ).exists()
        ):
            raise MembershipPaymentError(
                "升级支付记录状态异常，请刷新后重试",
                "MEMBERSHIP_CHANGE_LOG_INVALID",
            )

        from apps.services.payment.tasks import _sync_order_with_provider

        order = _sync_order_with_provider(order)
        if order.status != "paying":
            raise MembershipPaymentError(
                "订单状态已变化，请刷新后查看",
                "PAYMENT_STATUS_CHANGED",
                {"payment_status": order.status, "benefit_status": order.benefit_status},
            )

        current_method = order.payment_method
        current_service = PaymentServiceFactory.get_service(current_method)
        if not current_service.close_unpaid_order(order.order_no):
            provider_result = current_service.query_order(order.order_no) or {}
            provider_status = str(provider_result.get("trade_status") or "").upper()
            if provider_status in {"TRADE_SUCCESS", "TRADE_FINISHED", "SUCCESS"}:
                latest = _sync_order_with_provider(order)
                raise MembershipPaymentError(
                    "订单状态已变化，请刷新后查看",
                    "PAYMENT_STATUS_CHANGED",
                    {"payment_status": latest.status, "benefit_status": latest.benefit_status},
                )
            if provider_status not in {
                "TRADE_CLOSED",
                "CLOSED",
                "REVOKED",
                # 支付宝当面付：用户未扫码前交易不存在，等同于无可支付旧单。
                "TRADE_NOT_EXIST",
            }:
                raise MembershipPaymentError(
                    "暂时无法确认原支付订单已关闭，请稍后重试",
                    "PAYMENT_SWITCH_UNCONFIRMED",
                )

        with transaction.atomic():
            locked = PaymentOrder.objects.select_for_update().get(id=str(order.id))
            if locked.status != "paying" or locked.payment_method != current_method:
                raise MembershipPaymentError(
                    "订单状态已变化，请刷新后查看",
                    "PAYMENT_STATUS_CHANGED",
                    {"payment_status": locked.status, "benefit_status": locked.benefit_status},
                )
            if locked.is_expired():
                locked.status = "expired"
                locked.save(update_fields=["status", "updated_at"])
                raise MembershipPaymentError("订单已过期，请重新创建订单", "MEMBERSHIP_ORDER_EXPIRED")

            old_business_data = dict(locked.business_data or {})
            payment_chain_id = str(
                old_business_data.get("payment_chain_id") or locked.id
            )
            payment_channel = (
                "wallet" if target_method == "organization_wallet" else "third_party"
            )
            replacement_business_data = {
                **old_business_data,
                "replaces_order_id": str(locked.id),
                "payment_chain_id": payment_chain_id,
                "payment_source": {"method": target_method, "channel": payment_channel},
            }
            replacement_business_data.pop("third_party_payment", None)
            replacement = PaymentOrder.objects.create(
                user=locked.user,
                organization_id=locked.organization_id,
                order_type=locked.order_type,
                subject=locked.subject,
                description=locked.description,
                amount=locked.amount,
                payment_method=target_method,
                status="pending",
                benefit_status="pending",
                expired_at=locked.expired_at,
                business_data=replacement_business_data,
            )

            locked.business_data = {
                **old_business_data,
                "replacement_order_id": str(replacement.id),
                "payment_chain_id": payment_chain_id,
            }
            locked.status = "cancelled"
            locked.failure_code = "PAYMENT_METHOD_SWITCHED"
            locked.failure_message = f"支付方式已从 {current_method} 切换为 {target_method}"
            locked.save(update_fields=[
                "business_data",
                "status",
                "failure_code",
                "failure_message",
                "updated_at",
            ])

            change_log_id = old_business_data.get("change_log_id")
            if change_log_id:
                change_log = (
                    OrganizationMembershipChangeLog.objects
                    .select_for_update()
                    .filter(
                        id=change_log_id,
                        organization_id=str(organization_id),
                        status=OrganizationMembershipChangeLog.Status.PAYMENT_PENDING,
                    )
                    .first()
                )
                if not change_log:
                    raise MembershipPaymentError(
                        "升级支付记录状态异常，请刷新后重试",
                        "MEMBERSHIP_CHANGE_LOG_INVALID",
                    )
                metadata = dict(change_log.metadata or {})
                attempts = list(metadata.get("payment_attempts") or [])
                attempts.append({
                    "order_id": str(locked.id),
                    "order_no": locked.order_no,
                    "method": current_method,
                    "status": "cancelled_for_method_switch",
                })
                metadata["payment_attempts"] = attempts
                metadata["payment_source"] = {
                    "method": target_method,
                    "channel": payment_channel,
                }
                change_log.metadata = metadata
                change_log.payment_order_id = str(replacement.id)
                change_log.save(update_fields=["metadata", "payment_order_id", "updated_at"])

        return replacement
