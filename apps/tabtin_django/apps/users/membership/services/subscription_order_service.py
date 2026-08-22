"""会员升级订单与组织现金钱包支付服务。"""

from __future__ import annotations

import hashlib
import json
import logging
from datetime import datetime
from decimal import Decimal, ROUND_HALF_UP
from typing import Any

from django.conf import settings
from django.db import transaction
from django.utils import timezone

from apps.services.payment.models import PaymentOrder
from apps.services.payment.services.benefit_service import OrderBenefitService
from apps.tabtinspace.models import Organization
from apps.users.wallet.models import OrganizationCashWallet
from apps.users.wallet.services.organization_cash_wallet_service import (
    InsufficientCashBalance,
    OrganizationCashWalletService,
)

from ..exceptions import MembershipLifecycleError
from ..models import MembershipTier, OrganizationMembership, OrganizationMembershipChangeLog
from .subscription_pricing_service import (
    SubscriptionPricingError,
    SubscriptionPricingService,
)

logger = logging.getLogger(__name__)

MONEY = Decimal("0.01")


class MembershipUpgradeBalanceError(MembershipLifecycleError):
    """现金钱包余额不足；携带前端充值引导需要的数据。"""

    def __init__(self, *, wallet: dict[str, Any], payable_amount: Decimal):
        self.data = {
            "wallet": wallet,
            "payable_amount": _money_str(payable_amount),
            "shortage_amount": wallet["shortage_amount"],
            "recommended_recharge_amount": wallet["recommended_recharge_amount"],
            "recharge_entry": "cash_wallet",
        }
        super().__init__("组织现金钱包余额不足", "ORGANIZATION_BALANCE_INSUFFICIENT")


def _money(value: Any) -> Decimal:
    return Decimal(str(value or 0)).quantize(MONEY, rounding=ROUND_HALF_UP)


def _money_str(value: Any) -> str:
    return format(_money(value), ".2f")


def _decimal_payload(value: Any) -> str:
    return format(Decimal(str(value or 0)), "f")


def _canonical_hash(payload: dict[str, Any]) -> str:
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _parse_dt(value: str, *, field: str) -> datetime:
    try:
        dt = datetime.fromisoformat(value)
    except Exception as exc:
        raise SubscriptionPricingError("升级报价内容无效", "UPGRADE_QUOTE_INVALID") from exc
    if timezone.is_naive(dt):
        raise SubscriptionPricingError(f"{field} 必须是带时区时间戳", "MEMBERSHIP_PERIOD_INVALID")
    return dt


def _tier_snapshot(tier: MembershipTier | None) -> dict[str, Any]:
    if tier is None:
        return {}
    return {
        "id": str(tier.id),
        "tier_type": tier.tier_type,
        "name": tier.name,
        "tier_level": tier.tier_level,
        "display_order": tier.sort_order,
        "price": _money_str(tier.price),
        "included_llm_credits_monthly": _decimal_payload(tier.included_llm_credits_monthly),
        "included_storage_bytes": int(tier.included_storage_bytes or 0),
        "max_members": int(tier.max_members or 0),
        "max_documents": int(tier.max_documents or 0),
        "max_tables": int(tier.max_tables or 0),
        "max_groups": int(tier.max_groups or 0),
    }


class SubscriptionOrderService:
    """冻结升级报价、创建会员订单，并用组织现金钱包完成支付。"""

    def __init__(self) -> None:
        self.pricing = SubscriptionPricingService()
        self.cash_wallet = OrganizationCashWalletService()

    @staticmethod
    def _ensure_payment_enabled() -> None:
        if not getattr(settings, "MEMBERSHIP_UPGRADE_PAYMENT_ENABLED", False):
            raise MembershipLifecycleError(
                "会员升级下单暂未开启",
                "MEMBERSHIP_UPGRADE_PAYMENT_DISABLED",
            )

    @staticmethod
    def _ensure_wallet_payment_enabled() -> None:
        if not getattr(settings, "MEMBERSHIP_UPGRADE_WALLET_PAYMENT_ENABLED", False):
            raise MembershipLifecycleError(
                "会员升级钱包支付暂未开启",
                "MEMBERSHIP_UPGRADE_WALLET_PAYMENT_DISABLED",
            )

    def _wallet_snapshot(self, organization_id: str, payable_amount: Decimal) -> dict[str, Any]:
        wallet = self.cash_wallet.get_or_create_wallet(str(organization_id))
        available = _money(wallet.get_available_cny())
        shortage = max(Decimal("0.00"), _money(payable_amount) - available)
        return {
            "organization_id": str(organization_id),
            "balance_cny": _money_str(wallet.balance_cny),
            "frozen_cny": _money_str(wallet.frozen_cny),
            "available_cny": _money_str(available),
            "available_balance": _money_str(available),
            "shortage_amount": _money_str(shortage),
            "recommended_recharge_amount": _money_str(shortage),
            "sufficient": shortage <= 0,
        }

    def _serialize_order(self, order: PaymentOrder) -> dict[str, Any]:
        business_data = dict(order.business_data or {})
        amount = _money(order.amount)
        wallet = self._wallet_snapshot(str(order.organization_id), amount)
        return {
            "order_id": str(order.id),
            "order_no": order.order_no,
            "order_type": order.order_type,
            "subject": order.subject,
            "change_type": business_data.get("change_type") or "",
            "payment_method": order.payment_method,
            "payment_status": order.status,
            "benefit_status": getattr(order, "benefit_status", "pending"),
            "failure_code": getattr(order, "failure_code", "") or "",
            "failure_message": getattr(order, "failure_message", "") or "",
            "payable_amount": _money_str(amount),
            "currency": business_data.get("currency") or "CNY",
            "pricing_snapshot": business_data.get("pricing_snapshot") or {},
            "change_plan": business_data.get("change_plan") or {},
            "payment_source": business_data.get("payment_source") or {},
            "payment_data": business_data.get("third_party_payment"),
            "wallet": wallet,
            "allowed_actions": self._allowed_order_actions(order, wallet=wallet),
            "created_at": order.created_at.isoformat() if order.created_at else None,
            "paid_at": order.paid_at.isoformat() if order.paid_at else None,
            "expired_at": order.expired_at.isoformat() if order.expired_at else None,
        }

    @staticmethod
    def _allowed_order_actions(order: PaymentOrder, *, wallet: dict[str, Any]) -> dict[str, bool]:
        if (
            order.order_type == "membership"
            and order.status == "pending"
            and not order.is_expired()
        ):
            return {
                "pay_with_wallet": bool(wallet.get("sufficient")),
                "pay_with_alipay": True,
                "pay_with_wechat": True,
                "recharge": True,
                "refresh": True,
                "retry_benefit": False,
                "contact_support": False,
                "close": True,
            }
        if order.status == "paid" and getattr(order, "benefit_status", "") in {"pending", "failed"}:
            return {
                "pay_with_wallet": False,
                "pay_with_alipay": False,
                "pay_with_wechat": False,
                "recharge": False,
                "refresh": True,
                "retry_benefit": getattr(order, "benefit_status", "") == "failed",
                "contact_support": getattr(order, "benefit_status", "") == "failed",
                "close": True,
            }
        can_resume_alipay = order.status == "paying" and order.payment_method == "alipay"
        can_resume_wechat = order.status == "paying" and order.payment_method == "wechat"
        return {
            "pay_with_wallet": False,
            "pay_with_alipay": can_resume_alipay,
            "pay_with_wechat": can_resume_wechat,
            "recharge": False,
            "refresh": True,
            "retry_benefit": False,
            "contact_support": getattr(order, "benefit_status", "") == "failed",
            "close": True,
        }

    def _freeze_quote(
        self,
        *,
        organization_id: str,
        membership: OrganizationMembership,
        target_tier: MembershipTier,
        billing_cycle: str,
        quote_token: str,
    ):
        payload = self.pricing.verify_quote_token(
            quote_token,
            organization_id=organization_id,
            membership=membership,
            target_tier=target_tier,
            billing_cycle=billing_cycle,
        )
        quoted_at = _parse_dt(payload["quoted_at"], field="quoted_at")
        quote = self.pricing.calculate_upgrade_quote(
            organization_id=organization_id,
            membership=membership,
            target_tier=target_tier,
            target_billing_cycle=billing_cycle,
            quoted_at=quoted_at,
        )
        expected_payload = quote.token_payload()
        if expected_payload != payload:
            raise SubscriptionPricingError(
                "升级报价已失效，请重新获取",
                "UPGRADE_QUOTE_STALE",
            )
        return quote, payload

    def _find_existing_pending_order(self, *, organization_id: str, quote_hash: str) -> PaymentOrder | None:
        return (
            PaymentOrder.objects
            .filter(
                organization_id=str(organization_id),
                order_type="membership",
                business_data__change_type="upgrade",
                business_data__quote_hash=quote_hash,
                status__in=["pending", "paying", "paid"],
            )
            .order_by("-created_at")
            .first()
        )

    def get_active_upgrade_order(self, *, organization_id: str) -> dict[str, Any] | None:
        order = (
            PaymentOrder.objects
            .filter(
                organization_id=str(organization_id),
                order_type="membership",
                business_data__change_type="upgrade",
                status__in=["pending", "paying", "paid"],
            )
            .exclude(benefit_status="completed")
            .order_by("-created_at")
            .first()
        )
        if not order:
            return None
        if order.status == "pending" and order.is_expired():
            with transaction.atomic():
                locked = PaymentOrder.objects.select_for_update().get(id=order.id)
                if locked.status == "pending" and locked.is_expired():
                    locked.status = "expired"
                    locked.save(update_fields=["status", "updated_at"])
                    change_log_id = (locked.business_data or {}).get("change_log_id")
                    if change_log_id:
                        OrganizationMembershipChangeLog.objects.filter(
                            id=change_log_id,
                            status=OrganizationMembershipChangeLog.Status.PAYMENT_PENDING,
                        ).update(
                            status=OrganizationMembershipChangeLog.Status.CANCELLED,
                            reason="upgrade_order_expired",
                            updated_at=timezone.now(),
                        )
            return None
        return self._serialize_order(order)

    def create_upgrade_order(
        self,
        *,
        user,
        organization_id: str,
        target_tier_id: str,
        billing_cycle: str,
        quote_token: str,
        bypass_feature_gates: bool = False,
    ) -> dict[str, Any]:
        # AdminDash 运营升级不受 Electron 灰度开关限制。
        if not bypass_feature_gates:
            self._ensure_payment_enabled()
        order_id_to_apply = None
        with transaction.atomic():
            organization = Organization.objects.select_for_update().get(id=str(organization_id))
            membership = (
                OrganizationMembership.objects
                .select_for_update()
                .select_related("tier")
                .get(organization_id=str(organization.id))
            )
            try:
                target_tier = MembershipTier.objects.get(id=str(target_tier_id), is_active=True)
            except MembershipTier.DoesNotExist as exc:
                raise MembershipLifecycleError(
                    "目标套餐不可用",
                    "TARGET_TIER_NOT_AVAILABLE",
                ) from exc
            quote, payload = self._freeze_quote(
                organization_id=str(organization.id),
                membership=membership,
                target_tier=target_tier,
                billing_cycle=billing_cycle or "monthly",
                quote_token=quote_token,
            )
            quote_hash = _canonical_hash(payload)
            existing = self._find_existing_pending_order(
                organization_id=str(organization.id),
                quote_hash=quote_hash,
            )
            if existing:
                return self._serialize_order(existing)

            pricing_snapshot = {
                **payload,
                "quote_hash": quote_hash,
                "current_value": _money_str(quote.current_value),
                "target_value": _money_str(quote.target_value),
                "discount_amount": _money_str(quote.discount_amount),
                "payable_amount": _money_str(quote.payable_amount),
                "target_effective_period_price": _money_str(quote.target_effective_period_price),
                "current_actual_paid_period_price": _money_str(quote.current_actual_paid_period_price),
            }
            change_plan = {
                "change_type": "upgrade",
                "organization_id": str(organization.id),
                "membership_id": str(membership.id),
                "membership_lifecycle_version": int(membership.lifecycle_version),
                "from_tier_id": str(membership.tier_id),
                "to_tier_id": str(target_tier.id),
                "billing_cycle": quote.billing_cycle,
                "period_start": quote.period_start.isoformat(),
                "period_end": quote.period_end.isoformat(),
                "preserve_period": True,
                "effective_time": "immediate_after_payment",
            }
            payment_source = {
                "method": "organization_wallet",
                "wallet_model": "OrganizationCashWallet",
                "wallet_currency": "CNY",
            }
            change_log = OrganizationMembershipChangeLog.objects.create(
                organization=organization,
                membership=membership,
                change_type=OrganizationMembershipChangeLog.ChangeType.UPGRADE,
                status=OrganizationMembershipChangeLog.Status.PAYMENT_PENDING,
                from_tier=membership.tier,
                to_tier=target_tier,
                from_tier_snapshot=_tier_snapshot(membership.tier),
                to_tier_snapshot=_tier_snapshot(target_tier),
                from_billing_cycle=membership.billing_cycle,
                to_billing_cycle=quote.billing_cycle,
                requested_by=user,
                effective_at=quote.quoted_at,
                list_amount=_money(quote.target_list_period_price),
                current_value=_money(quote.current_value),
                target_value=_money(quote.target_value),
                discount_amount=_money(quote.discount_amount),
                payable_amount=_money(quote.payable_amount),
                reason="membership_upgrade",
                metadata={
                    "quote_hash": quote_hash,
                    "pricing_snapshot": pricing_snapshot,
                    "change_plan": change_plan,
                    "payment_source": payment_source,
                    "payment_completed": False,
                },
            )
            order = PaymentOrder.objects.create(
                user=user,
                organization_id=str(organization.id),
                order_type="membership",
                subject=f"会员升级：{membership.tier.name} → {target_tier.name}",
                description="组织现金钱包支付会员升级补差价",
                amount=_money(quote.payable_amount),
                paid_amount=Decimal("0.00"),
                payment_method="organization_wallet",
                status="pending",
                benefit_status="pending",
                expired_at=quote.quote_expires_at,
                business_data={
                    "schema_version": 1,
                    "tier_id": str(target_tier.id),
                    "organization_id": str(organization.id),
                    "membership_id": str(membership.id),
                    "membership_lifecycle_version": int(membership.lifecycle_version),
                    "change_type": "upgrade",
                    "from_tier_id": str(membership.tier_id),
                    "to_tier_id": str(target_tier.id),
                    "billing_cycle": quote.billing_cycle,
                    "change_log_id": str(change_log.id),
                    "quote_hash": quote_hash,
                    "pricing_snapshot": pricing_snapshot,
                    "change_plan": change_plan,
                    "payment_source": payment_source,
                    "currency": quote.currency,
                },
            )
            change_log.payment_order_id = str(order.id)
            change_log.save(update_fields=["payment_order_id", "updated_at"])

            if _money(order.amount) == Decimal("0.00"):
                order.status = "paid"
                order.paid_amount = Decimal("0.00")
                order.paid_at = timezone.now()
                order.save(update_fields=["status", "paid_amount", "paid_at", "updated_at"])
                change_log.status = OrganizationMembershipChangeLog.Status.PAID
                meta = dict(change_log.metadata or {})
                meta["payment_completed"] = True
                change_log.metadata = meta
                change_log.save(update_fields=["status", "metadata", "updated_at"])
                order_id_to_apply = str(order.id)

        if order_id_to_apply:
            OrderBenefitService.grant(order_id_to_apply)
            order = PaymentOrder.objects.get(id=order_id_to_apply)
            return self._serialize_order(order)
        return self.get_upgrade_order(organization_id=organization_id, order_id=str(order.id))

    def get_upgrade_order(self, *, organization_id: str, order_id: str) -> dict[str, Any]:
        order = PaymentOrder.objects.get(
            id=str(order_id),
            organization_id=str(organization_id),
            order_type="membership",
            business_data__change_type="upgrade",
        )
        if order.status == "paying" and order.payment_method in {"alipay", "wechat"}:
            from apps.services.payment.tasks import _sync_order_with_provider

            order = _sync_order_with_provider(order)
        return self._serialize_order(order)

    def wallet_pay_upgrade_order(
        self,
        *,
        user,
        organization_id: str,
        order_id: str,
        bypass_feature_gates: bool = False,
    ) -> dict[str, Any]:
        # AdminDash 运营升级不受 Electron 灰度开关限制。
        if not bypass_feature_gates:
            self._ensure_wallet_payment_enabled()
        should_apply = False
        with transaction.atomic():
            order = PaymentOrder.objects.get(
                id=str(order_id),
                organization_id=str(organization_id),
                order_type="membership",
                payment_method="organization_wallet",
                business_data__change_type="upgrade",
            )
            if order.status == "completed" or getattr(order, "benefit_status", "") == "completed":
                return self._serialize_order(order)

            business_data = dict(order.business_data or {})
            change_plan = dict(business_data.get("change_plan") or {})
            if not change_plan.get("membership_id") and not business_data.get("membership_id"):
                raise MembershipLifecycleError(
                    "会员升级订单缺少会员关联信息",
                    "MEMBERSHIP_UPGRADE_ORDER_MISSING_MEMBERSHIP",
                )
            membership_id = (
                str(change_plan.get("membership_id") or business_data.get("membership_id") or "")
            )
            membership = (
                OrganizationMembership.objects
                .select_for_update()
                .filter(id=membership_id, organization_id=str(organization_id))
                .first()
            )
            if not membership:
                raise MembershipLifecycleError(
                    "会员升级订单关联的会员不存在",
                    "MEMBERSHIP_NOT_FOUND",
                )
            if (
                str(membership.lifecycle_version) != str(change_plan.get("membership_lifecycle_version"))
                or str(membership.tier_id) != str(change_plan.get("from_tier_id"))
            ):
                raise MembershipLifecycleError(
                    "会员状态已变化，请重新获取升级报价",
                    "MEMBERSHIP_STATE_CHANGED",
                )
            change_log_id = business_data.get("change_log_id")
            change_log = (
                OrganizationMembershipChangeLog.objects
                .select_for_update()
                .filter(id=change_log_id, organization_id=str(organization_id))
                .first()
                if change_log_id
                else None
            )
            if not change_log:
                raise MembershipLifecycleError(
                    "会员升级变更记录不存在",
                    "MEMBERSHIP_CHANGE_LOG_NOT_FOUND",
                )
            order = (
                PaymentOrder.objects
                .select_for_update()
                .get(
                    id=str(order.id),
                    organization_id=str(organization_id),
                    order_type="membership",
                    payment_method="organization_wallet",
                    business_data__change_type="upgrade",
                )
            )
            if order.status == "completed" or getattr(order, "benefit_status", "") == "completed":
                return self._serialize_order(order)

            if order.status == "paid":
                should_apply = True
            elif order.status != "pending":
                raise MembershipLifecycleError(
                    "会员升级订单状态不允许支付",
                    "MEMBERSHIP_UPGRADE_ORDER_STATUS_INVALID",
                )
            elif order.is_expired():
                order.status = "expired"
                order.save(update_fields=["status", "updated_at"])
                raise MembershipLifecycleError(
                    "会员升级订单已过期，请重新获取报价",
                    "QUOTE_EXPIRED",
                )
            else:
                amount = _money(order.amount)
                wallet_snapshot = self._wallet_snapshot(str(organization_id), amount)
                if not wallet_snapshot["sufficient"]:
                    raise MembershipUpgradeBalanceError(
                        wallet=wallet_snapshot,
                        payable_amount=amount,
                    )

                try:
                    if amount > 0:
                        self.cash_wallet.spend(
                            organization_id=str(organization_id),
                            amount_cny=amount,
                            transaction_type="membership_upgrade_payment",
                            description=f"会员升级支付: {order.order_no}",
                            operator_user_id=str(getattr(user, "id", "") or ""),
                            related_order_id=str(order.id),
                            metadata={
                                "order_no": order.order_no,
                                "change_log_id": business_data.get("change_log_id") or "",
                                "change_plan": business_data.get("change_plan") or {},
                            },
                        )
                except InsufficientCashBalance as exc:
                    raise MembershipUpgradeBalanceError(
                        wallet=self._wallet_snapshot(str(organization_id), amount),
                        payable_amount=amount,
                    ) from exc

                order.status = "paid"
                order.paid_amount = amount
                order.paid_at = timezone.now()
                order.benefit_status = "pending"
                order.save(update_fields=[
                    "status",
                    "paid_amount",
                    "paid_at",
                    "benefit_status",
                    "updated_at",
                ])

                meta = dict(change_log.metadata or {})
                meta["payment_completed"] = True
                change_log.metadata = meta
                change_log.status = OrganizationMembershipChangeLog.Status.PAID
                change_log.payment_order_id = str(order.id)
                change_log.save(update_fields=[
                    "metadata",
                    "status",
                    "payment_order_id",
                    "updated_at",
                ])
                should_apply = True

        if should_apply:
            OrderBenefitService.grant(str(order_id))
        return self.get_upgrade_order(organization_id=organization_id, order_id=order_id)
