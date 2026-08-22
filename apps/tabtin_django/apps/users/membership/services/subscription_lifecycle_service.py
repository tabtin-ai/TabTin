"""PR5 会员生命周期执行服务。

该服务只复用现有 OrganizationMembership / OrganizationMembershipChangeLog /
PaymentOrder / OrganizationCashWallet，不引入 Subscription 主表或动作专表。
"""

from __future__ import annotations

import hashlib
import json
import logging
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal, ROUND_HALF_UP, localcontext
from typing import Any, Optional

from dateutil.relativedelta import relativedelta
from django.conf import settings
from django.core import signing
from django.db import transaction
from django.utils import timezone

from apps.services.billing.services import (
    OrganizationEntitlementSyncService,
    OrganizationLlmBudgetService,
)
from apps.services.payment.models import PaymentOrder
from apps.services.payment.services.benefit_service import OrderBenefitService
from apps.tabtinspace.models import Organization
from apps.users.wallet.services.organization_cash_wallet_service import (
    InsufficientCashBalance,
    OrganizationCashWalletService,
)

from ..exceptions import MembershipLifecycleError
from ..models import MembershipTier, OrganizationMembership, OrganizationMembershipChangeLog
from .membership_change_classifier import MembershipChangeClassifier
from .membership_state_resolver import MembershipStateResolver
from .subscription_order_service import MembershipUpgradeBalanceError
from .subscription_pricing_service import SubscriptionPricingService

logger = logging.getLogger(__name__)

MONEY = Decimal("0.01")
LIFECYCLE_QUOTE_SCHEMA_VERSION = 1
LIFECYCLE_QUOTE_SALT = "membership.lifecycle.quote.v1"


def _money(value: Any) -> Decimal:
    return Decimal(str(value or 0)).quantize(MONEY, rounding=ROUND_HALF_UP)


def _money_str(value: Any) -> str:
    return format(_money(value), ".2f")


def _decimal_str(value: Any) -> str:
    return format(Decimal(str(value or 0)), "f")


def _dt(value: datetime | None) -> str | None:
    return value.isoformat() if value else None


def _parse_dt(value: str, *, code: str = "MEMBERSHIP_QUOTE_INVALID") -> datetime:
    try:
        parsed = datetime.fromisoformat(value)
    except Exception as exc:
        raise MembershipLifecycleError("生命周期报价已失效，请重新获取", code) from exc
    if timezone.is_naive(parsed):
        raise MembershipLifecycleError("生命周期报价时间无效", code)
    return parsed


def _canonical_hash(payload: dict[str, Any]) -> str:
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _tier_snapshot(tier: MembershipTier | None) -> dict[str, Any]:
    if not tier:
        return {}
    return {
        "id": str(tier.id),
        "tier_type": tier.tier_type,
        "name": tier.name,
        "tier_level": tier.tier_level,
        "display_order": tier.sort_order,
        "price": _money_str(tier.price),
        "included_llm_credits_monthly": _decimal_str(tier.included_llm_credits_monthly),
        "included_storage_bytes": int(tier.included_storage_bytes or 0),
        "max_members": int(tier.max_members or 0),
        "max_documents": int(tier.max_documents or 0),
        "max_tables": int(tier.max_tables or 0),
        "max_groups": int(tier.max_groups or 0),
    }


def _quote_ttl_seconds() -> int:
    return int(getattr(settings, "MEMBERSHIP_UPGRADE_QUOTE_TTL_SECONDS", 600))


def _period_end(start: datetime, billing_cycle: str) -> datetime:
    if billing_cycle == OrganizationMembership.BillingCycle.YEARLY:
        return start + relativedelta(years=1)
    return start + relativedelta(months=1)


def _ensure_flag(flag_name: str, message: str, code: str) -> None:
    if not getattr(settings, flag_name, False):
        raise MembershipLifecycleError(message, code)


@dataclass(frozen=True)
class LifecycleQuote:
    action: str
    effective_mode: str
    organization_id: str
    membership_id: str
    lifecycle_version: int
    from_tier_id: str
    to_tier_id: str
    billing_cycle: str
    quoted_at: datetime
    quote_expires_at: datetime
    effective_at: datetime | None
    payable_amount: Decimal
    target_effective_period_price: Decimal
    target_effective_period_price_version: str | None = None
    currency: str = "CNY"
    from_tier_level: int | None = None
    to_tier_level: int | None = None
    current_actual_paid_period_price: Decimal | None = None
    next_period_start: datetime | None = None
    next_period_end: datetime | None = None
    metadata: dict[str, Any] | None = None

    def payload(self) -> dict[str, Any]:
        return {
            "action": self.action,
            "effective_mode": self.effective_mode,
            "organization_id": self.organization_id,
            "membership_id": self.membership_id,
            "lifecycle_version": self.lifecycle_version,
            "from_tier_id": self.from_tier_id,
            "to_tier_id": self.to_tier_id,
            "billing_cycle": self.billing_cycle,
            "quoted_at": self.quoted_at.isoformat(),
            "quote_expires_at": self.quote_expires_at.isoformat(),
            "effective_at": _dt(self.effective_at),
            "switch_mode": self.effective_mode,
            "schema_version": LIFECYCLE_QUOTE_SCHEMA_VERSION,
            "currency": self.currency,
            "payable_amount": _money_str(self.payable_amount),
            "target_effective_period_price": _money_str(self.target_effective_period_price),
            "target_effective_period_price_version": self.target_effective_period_price_version,
            "from_tier_level": self.from_tier_level,
            "to_tier_level": self.to_tier_level,
            "current_period_end": (
                (self.metadata or {}).get("current_period_end") if self.metadata else None
            ),
            "current_actual_paid_period_price": (
                _money_str(self.current_actual_paid_period_price)
                if self.current_actual_paid_period_price is not None
                else None
            ),
            "next_period_start": _dt(self.next_period_start),
            "next_period_end": _dt(self.next_period_end),
            "metadata": self.metadata or {},
        }


class SubscriptionLifecycleService:
    """套餐降级、同级切换、手动续费、到期和宽限期执行器。"""

    def __init__(self) -> None:
        self.pricing = SubscriptionPricingService()
        self.cash_wallet = OrganizationCashWalletService()

    # ---------- shared ----------

    def _target_price_snapshot(self, target_tier: MembershipTier, billing_cycle: str):
        target_price = self.pricing.resolve_target_effective_period_price(
            target_tier=target_tier,
            billing_cycle=billing_cycle,
        )
        return (
            _money(target_price.effective_period_price),
            target_price.price_version,
        )

    def _target_price(self, target_tier: MembershipTier, billing_cycle: str) -> Decimal:
        return self._target_price_snapshot(target_tier, billing_cycle)[0]

    def _sign(self, quote: LifecycleQuote) -> str:
        return signing.dumps(quote.payload(), salt=LIFECYCLE_QUOTE_SALT, compress=True)

    def _verify(self, token: str, *, organization_id: str, action: str) -> dict[str, Any]:
        try:
            payload = signing.loads(token, salt=LIFECYCLE_QUOTE_SALT, max_age=_quote_ttl_seconds())
        except signing.SignatureExpired as exc:
            raise MembershipLifecycleError("报价已过期，请重新获取", "QUOTE_EXPIRED") from exc
        except signing.BadSignature as exc:
            raise MembershipLifecycleError("报价无效，请重新获取", "QUOTE_INVALID") from exc
        if payload.get("organization_id") != str(organization_id) or payload.get("action") != action:
            raise MembershipLifecycleError("报价与当前操作不匹配", "MEMBERSHIP_ACTION_MISMATCH")
        return payload

    @staticmethod
    def _parse_payload_dt(payload: dict[str, Any], field: str) -> datetime | None:
        raw = payload.get(field)
        if raw in (None, ""):
            return None
        return _parse_dt(raw)

    def resolve_verified_switch_action(
        self,
        *,
        organization_id: str,
        target_tier_id: str,
        billing_cycle: str,
        quote_token: str,
    ) -> dict[str, Any]:
        """统一解析并校验 switch 预览 token。

        与 preview_switch 共享判断口径：
        - action 必须是 switch
        - quote payload 必须和当前状态一致
        - 目标套餐/周期/生命周期版本一致
        - payable 与有效模式一致（用于识别 quote stale）
        """
        payload = self._verify(quote_token, organization_id=organization_id, action="switch")
        membership = OrganizationMembership.objects.select_related("tier").filter(
            organization_id=str(organization_id)
        ).first()
        if not membership:
            raise MembershipLifecycleError("会员不存在", "MEMBERSHIP_NOT_FOUND")
        if payload.get("switch_mode") != payload.get("effective_mode"):
            raise MembershipLifecycleError("报价切换方式已变化，请重新获取", "QUOTE_INVALID")
        if str(payload.get("membership_id") or "") not in {"", str(membership.id)}:
            raise MembershipLifecycleError("报价与会员不匹配，请重新获取", "MEMBERSHIP_STATE_CHANGED")
        if str(membership.lifecycle_version) != str(payload.get("lifecycle_version")):
            raise MembershipLifecycleError("会员状态已变化，请重新获取报价", "MEMBERSHIP_STATE_CHANGED")
        target_tier = MembershipTier.objects.get(id=str(target_tier_id), is_active=True)
        cycle = MembershipStateResolver.validate_billing_cycle(billing_cycle)
        if str(payload.get("to_tier_id") or "") not in {"", str(target_tier.id)}:
            raise MembershipLifecycleError("报价目标套餐不匹配", "QUOTE_INVALID")
        if str(payload.get("from_tier_id") or "") not in {"", str(membership.tier_id)}:
            raise MembershipLifecycleError("报价与当前套餐已变化，请重新获取", "MEMBERSHIP_STATE_CHANGED")
        if str(payload.get("from_tier_level") or "") not in {"", str(membership.tier.tier_level)}:
            raise MembershipLifecycleError("报价与当前套餐已变化，请重新获取", "MEMBERSHIP_STATE_CHANGED")
        if str(payload.get("to_tier_level") or "") not in {"", str(target_tier.tier_level)}:
            raise MembershipLifecycleError("报价目标套餐不匹配", "QUOTE_INVALID")
        preview = self.preview_switch(
            organization_id=organization_id,
            target_tier_id=str(target_tier.id),
            billing_cycle=cycle,
        )
        if str(preview.get("current_tier", {}).get("id") or "") != str(membership.tier_id):
            raise MembershipLifecycleError("报价与当前套餐已变化，请重新获取", "MEMBERSHIP_STATE_CHANGED")
        if payload.get("current_period_end") or preview.get("current_period_end"):
            payload_end = self._parse_payload_dt(payload, "current_period_end")
            if payload_end and membership.end_date and abs((payload_end - membership.end_date).total_seconds()) > 1:
                raise MembershipLifecycleError("报价与当前周期无效，请重新获取", "MEMBERSHIP_STATE_CHANGED")
        if payload.get("effective_mode") != preview.get("effective_mode"):
            raise MembershipLifecycleError("报价已失效，请重新获取", "QUOTE_INVALID")
        # switch_mode is part of the signed canonical quote.  Do not infer or
        # normalize it from effective_mode: a tampered token must be rejected.
        if payload.get("switch_mode") != payload.get("effective_mode"):
            raise MembershipLifecycleError("报价切换方式已变化，请重新获取", "QUOTE_INVALID")
        if payload.get("switch_mode") != preview.get("switch_mode"):
            raise MembershipLifecycleError("报价有效方式已变化，请重新获取", "MEMBERSHIP_SWITCH_MODE_INVALID")
        if payload.get("to_tier_id") != str(target_tier.id):
            raise MembershipLifecycleError("报价目标套餐不匹配", "QUOTE_INVALID")
        target_price_snapshot, _ = self._target_price_snapshot(target_tier, cycle)
        if _money(payload.get("target_effective_period_price")) != target_price_snapshot:
            raise MembershipLifecycleError("报价目标周期价格已变化，请重新获取", "QUOTE_INVALID")
        if _money(payload.get("payable_amount")) != _money(preview.get("payable_amount")):
            raise MembershipLifecycleError("报价与当前套餐价格已变化，请重新获取", "QUOTE_INVALID")
        if str(payload.get("currency") or "") not in {"", "CNY"}:
            raise MembershipLifecycleError("币种不匹配", "QUOTE_INVALID")
        if payload.get("schema_version") not in {None, LIFECYCLE_QUOTE_SCHEMA_VERSION}:
            raise MembershipLifecycleError("报价版本不匹配", "QUOTE_INVALID")
        if str(payload.get("billing_cycle") or "") not in {"", str(cycle)}:
            raise MembershipLifecycleError("报价与当前计费周期不匹配", "QUOTE_INVALID")
        if str(payload.get("billing_cycle") or "") == "":
            payload["billing_cycle"] = str(cycle)
        if _parse_dt(payload.get("quoted_at")) is None:
            raise MembershipLifecycleError("报价时间无效，请重新获取", "QUOTE_INVALID")
        if _parse_dt(payload.get("quote_expires_at")) is None:
            raise MembershipLifecycleError("报价过期时间无效，请重新获取", "QUOTE_INVALID")

        return {
            "target_tier": {
                "id": str(target_tier.id),
                "tier_level": int(target_tier.tier_level),
                "display_order": int(target_tier.sort_order),
            },
            "preview": preview,
            "payload": payload,
            "canonical_quote": {
                "action": preview.get("action"),
                "effective_mode": preview.get("effective_mode"),
                "switch_mode": preview.get("effective_mode"),
                "quoted_at": payload.get("quoted_at"),
                "quote_expires_at": payload.get("quote_expires_at"),
                "current_period_end": preview.get("current_period_end"),
                "current_tier_id": payload.get("from_tier_id"),
                "target_tier_id": payload.get("to_tier_id"),
                "billing_cycle": payload.get("billing_cycle"),
                "payable_amount": payload.get("payable_amount"),
                "target_effective_period_price": payload.get("target_effective_period_price"),
                "current_actual_paid_period_price": payload.get("current_actual_paid_period_price"),
                "price_version": payload.get("target_effective_period_price_version"),
                "currency": payload.get("currency"),
                "schema_version": payload.get("schema_version"),
            },
        }

    @staticmethod
    def _free_tier() -> MembershipTier | None:
        qs = MembershipTier.objects.filter(is_active=True, price=Decimal("0.00")).order_by("tier_level", "sort_order")
        return qs.first()

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
        wallet = self._wallet_snapshot(str(order.organization_id), _money(order.amount))
        return {
            "order_id": str(order.id),
            "order_no": order.order_no,
            "order_type": order.order_type,
            "change_type": (order.business_data or {}).get("change_type") or "",
            "payment_method": order.payment_method,
            "payment_status": order.status,
            "benefit_status": getattr(order, "benefit_status", "pending"),
            "failure_code": getattr(order, "failure_code", "") or "",
            "failure_message": getattr(order, "failure_message", "") or "",
            "payable_amount": _money_str(order.amount),
            "currency": (order.business_data or {}).get("currency") or "CNY",
            "pricing_snapshot": (order.business_data or {}).get("pricing_snapshot") or {},
            "change_plan": (order.business_data or {}).get("change_plan") or {},
            "wallet": wallet,
            "allowed_actions": {
                "pay_with_wallet": order.status == "pending" and not order.is_expired() and wallet["sufficient"],
                "recharge": order.status == "pending" and not order.is_expired(),
                "refresh": True,
                "retry_benefit": order.status == "paid" and getattr(order, "benefit_status", "") == "failed",
            },
            "created_at": _dt(order.created_at),
            "paid_at": _dt(order.paid_at),
            "expired_at": _dt(order.expired_at),
        }

    def _sync_entitlement_and_budget(self, membership: OrganizationMembership, *, reason: str, reset_consumed: bool = False) -> None:
        OrganizationEntitlementSyncService.sync_organization_entitlement(
            str(membership.organization_id),
            metadata_updates={
                "membership_lifecycle_reason": reason,
                "membership_id": str(membership.id),
            },
        )
        budget = OrganizationLlmBudgetService.get_or_create_monthly_budget_locked(
            str(membership.organization_id),
            at_time=timezone.now(),
        )
        budget.included_credits = Decimal(str(membership.tier.included_llm_credits_monthly or 0))
        if reset_consumed:
            budget.consumed_credits = Decimal("0")
        budget.updated_from_entitlement_at = timezone.now()
        fields = ["included_credits", "updated_from_entitlement_at", "updated_at"]
        if reset_consumed:
            fields.append("consumed_credits")
        budget.save(update_fields=fields)

    # ---------- downgrade / scheduled switch ----------

    def preview_downgrade(self, *, organization_id: str, target_tier_id: str, billing_cycle: str = "monthly") -> dict[str, Any]:
        _ensure_flag("MEMBERSHIP_DOWNGRADE_ENABLED", "套餐降级暂未开启", "MEMBERSHIP_DOWNGRADE_DISABLED")
        membership = OrganizationMembership.objects.select_related("tier").get(organization_id=str(organization_id))
        target = MembershipTier.objects.get(id=str(target_tier_id), is_active=True)
        cycle = MembershipStateResolver.validate_billing_cycle(billing_cycle or membership.billing_cycle)
        action = MembershipChangeClassifier.classify(
            current_membership=membership,
            target_tier=target,
            target_billing_cycle=cycle,
        )
        if action != "downgrade":
            raise MembershipLifecycleError("目标套餐不是降级", "MEMBERSHIP_ACTION_MISMATCH")
        quoted_at = timezone.now()
        target_price, target_price_version = self._target_price_snapshot(target, cycle)
        quote = LifecycleQuote(
            action="downgrade",
            effective_mode="next_cycle",
            organization_id=str(organization_id),
            membership_id=str(membership.id),
            lifecycle_version=int(membership.lifecycle_version),
            from_tier_id=str(membership.tier_id),
            to_tier_id=str(target.id),
            billing_cycle=cycle,
            quoted_at=quoted_at,
            quote_expires_at=quoted_at + timezone.timedelta(seconds=_quote_ttl_seconds()),
            effective_at=membership.end_date,
            payable_amount=Decimal("0.00"),
            target_effective_period_price=target_price,
            current_actual_paid_period_price=membership.current_actual_paid_period_price,
            metadata={"current_period_end": _dt(membership.end_date)},
        )
        return {
            "action": "downgrade",
            "effective_mode": "next_cycle",
            "effective_at": _dt(membership.end_date),
            "current_tier": _tier_snapshot(membership.tier),
            "target_tier": _tier_snapshot(target),
            "current_period_end": _dt(membership.end_date),
            "refund_amount": "0.00",
            "current_benefits_retained_until": _dt(membership.end_date),
            "next_period_list_price": _money_str(target_price),
            "warnings": ["当前周期不退款", "当前权益保持到周期结束", "不会立即减少 AI 额度、成员或存储权益"],
            "allowed": True,
            "quote_token": self._sign(quote),
        }

    def schedule_downgrade(self, *, user, organization_id: str, target_tier_id: str, billing_cycle: str, quote_token: str) -> dict[str, Any]:
        return self._schedule_change(
            user=user,
            organization_id=organization_id,
            target_tier_id=target_tier_id,
            billing_cycle=billing_cycle,
            quote_token=quote_token,
            action="downgrade",
        )

    def _schedule_change(self, *, user, organization_id: str, target_tier_id: str, billing_cycle: str, quote_token: str, action: str) -> dict[str, Any]:
        flag = "MEMBERSHIP_DOWNGRADE_ENABLED" if action == "downgrade" else "MEMBERSHIP_SWITCH_ENABLED"
        _ensure_flag(flag, "套餐生命周期预约暂未开启", "MEMBERSHIP_SCHEDULED_CHANGE_DISABLED")
        payload = self._verify(quote_token, organization_id=organization_id, action=action)
        with transaction.atomic():
            membership = (
                OrganizationMembership.objects
                .select_for_update()
                .select_related("tier")
                .get(organization_id=str(organization_id))
            )
            target = MembershipTier.objects.get(id=str(target_tier_id), is_active=True)
            if str(membership.lifecycle_version) != str(payload["lifecycle_version"]):
                raise MembershipLifecycleError("会员状态已变化，请重新获取报价", "MEMBERSHIP_STATE_CHANGED")
            if str(target.id) != str(payload["to_tier_id"]):
                raise MembershipLifecycleError("报价目标套餐不匹配", "QUOTE_INVALID")
            cycle = MembershipStateResolver.validate_billing_cycle(billing_cycle or membership.billing_cycle)
            if cycle != payload["billing_cycle"]:
                raise MembershipLifecycleError("报价计费周期不匹配", "QUOTE_INVALID")

            old_log_id = membership.scheduled_change_log_id
            if old_log_id:
                OrganizationMembershipChangeLog.objects.select_for_update().filter(
                    id=old_log_id,
                    status__in=[
                        OrganizationMembershipChangeLog.Status.PENDING,
                        OrganizationMembershipChangeLog.Status.SCHEDULED,
                    ],
                ).update(
                    status=OrganizationMembershipChangeLog.Status.CANCELLED,
                    reason=f"superseded_by_{action}",
                    updated_at=timezone.now(),
                )

            change_log = OrganizationMembershipChangeLog.objects.create(
                organization_id=str(organization_id),
                membership=membership,
                change_type=action,
                status=OrganizationMembershipChangeLog.Status.SCHEDULED,
                from_tier=membership.tier,
                to_tier=target,
                from_tier_snapshot=_tier_snapshot(membership.tier),
                to_tier_snapshot=_tier_snapshot(target),
                from_billing_cycle=membership.billing_cycle,
                to_billing_cycle=cycle,
                requested_by=user,
                effective_at=_parse_dt(payload["effective_at"]),
                list_amount=_money(payload["target_effective_period_price"]),
                payable_amount=Decimal("0.00"),
                reason=f"membership_{action}_scheduled",
                metadata={"quote_hash": _canonical_hash(payload), "quote_payload": payload},
            )
            membership.scheduled_tier = target
            membership.scheduled_billing_cycle = cycle
            membership.scheduled_change_type = action
            membership.scheduled_change_effective_at = change_log.effective_at
            membership.scheduled_change_log_id = change_log.id
            membership.lifecycle_version = int(membership.lifecycle_version or 0) + 1
            membership.save(update_fields=[
                "scheduled_tier",
                "scheduled_billing_cycle",
                "scheduled_change_type",
                "scheduled_change_effective_at",
                "scheduled_change_log_id",
                "lifecycle_version",
                "updated_at",
            ])
            return self.get_scheduled_change(organization_id=str(organization_id)) or {}


    def _has_pending_renewal(self, membership: OrganizationMembership) -> bool:
        return OrganizationMembershipChangeLog.objects.filter(
            membership_id=membership.id,
            change_type=OrganizationMembershipChangeLog.ChangeType.RENEWAL,
            status__in=[
                OrganizationMembershipChangeLog.Status.PAYMENT_PENDING,
                OrganizationMembershipChangeLog.Status.PAID,
                OrganizationMembershipChangeLog.Status.APPLYING,
            ],
        ).exists()

    def cancel_scheduled_change(self, *, user, organization_id: str, reason: str = "user_cancelled") -> dict[str, Any]:
        with transaction.atomic():
            membership = (
                OrganizationMembership.objects
                .select_for_update()
                .get(organization_id=str(organization_id))
            )
            log = None
            if membership.scheduled_change_log_id:
                log = (
                    OrganizationMembershipChangeLog.objects
                    .select_for_update()
                    .filter(id=membership.scheduled_change_log_id)
                    .first()
                )
            if not log or log.status not in {
                OrganizationMembershipChangeLog.Status.PENDING,
                OrganizationMembershipChangeLog.Status.SCHEDULED,
            }:
                raise MembershipLifecycleError("没有可取消的预约变更", "SCHEDULED_CHANGE_NOT_FOUND")
            log.mark_cancelled(reason=reason)
            membership.scheduled_tier = None
            membership.scheduled_billing_cycle = None
            membership.scheduled_change_type = None
            membership.scheduled_change_effective_at = None
            membership.scheduled_change_log_id = None
            membership.lifecycle_version = int(membership.lifecycle_version or 0) + 1
            membership.save(update_fields=[
                "scheduled_tier",
                "scheduled_billing_cycle",
                "scheduled_change_type",
                "scheduled_change_effective_at",
                "scheduled_change_log_id",
                "lifecycle_version",
                "updated_at",
            ])
        return {"cancelled": True, "reason": reason}

    def get_scheduled_change(self, *, organization_id: str) -> dict[str, Any] | None:
        membership = (
            OrganizationMembership.objects
            .filter(organization_id=str(organization_id))
            .select_related("tier", "scheduled_tier")
            .first()
        )
        if not membership or not membership.scheduled_tier_id:
            return None
        return {
            "type": membership.scheduled_change_type,
            "target_tier": _tier_snapshot(membership.scheduled_tier),
            "billing_cycle": membership.scheduled_billing_cycle,
            "effective_at": _dt(membership.scheduled_change_effective_at),
            "change_log_id": str(membership.scheduled_change_log_id or ""),
            "can_cancel": True,
        }

    def apply_scheduled_change(self, *, membership_id: str, now=None) -> str | None:
        resolved_now = now or timezone.now()
        with transaction.atomic():
            membership = (
                OrganizationMembership.objects
                .select_for_update()
                .select_related("tier")
                .filter(id=str(membership_id))
                .first()
            )
            if not membership:
                return {"changed": False, "reason": "membership_missing"}
            if not membership.scheduled_tier_id:
                return None
            if membership.scheduled_change_effective_at and membership.scheduled_change_effective_at > resolved_now:
                return None
            log = (
                OrganizationMembershipChangeLog.objects
                .select_for_update()
                .filter(id=membership.scheduled_change_log_id)
                .first()
            )
            if not log or log.status == OrganizationMembershipChangeLog.Status.APPLIED:
                return None
            if log.status not in {
                OrganizationMembershipChangeLog.Status.PENDING,
                OrganizationMembershipChangeLog.Status.SCHEDULED,
                OrganizationMembershipChangeLog.Status.REQUESTED,
                OrganizationMembershipChangeLog.Status.PAID,
            }:
                return None
            if log.status == OrganizationMembershipChangeLog.Status.APPLYING:
                return None
            log.status = OrganizationMembershipChangeLog.Status.APPLYING
            log.save(update_fields=["status", "updated_at"])
            try:
                target = MembershipTier.objects.filter(id=membership.scheduled_tier_id, is_active=True).first()
                if not target:
                    return None
                cycle = membership.scheduled_billing_cycle or membership.billing_cycle
                is_free_target = _money(target.price) == Decimal("0.00")
                if not is_free_target:
                    membership.status = "expired"
                    membership.grace_period_end = None
                else:
                    membership.tier = target
                    membership.billing_cycle = cycle
                    membership.status = "active"
                    membership.current_actual_paid_period_price = Decimal("0.00")
                    membership.start_date = resolved_now
                    # 会员表 end_date 为非空字段；免费版由状态解析器呈现为长期有效。
                    membership.end_date = _period_end(resolved_now, cycle)
                membership.scheduled_tier = None
                membership.scheduled_billing_cycle = None
                membership.scheduled_change_type = None
                membership.scheduled_change_effective_at = None
                membership.scheduled_change_log_id = None
                membership.lifecycle_version = int(membership.lifecycle_version or 0) + 1
                membership.save()
                self._sync_entitlement_and_budget(membership, reason="scheduled_change_applied")
                log.mark_applied(at=resolved_now)
                return str(log.id)
            except Exception as exc:
                log.mark_failed(reason=str(exc))
                raise

    # ---------- switch ----------

    def preview_switch(self, *, organization_id: str, target_tier_id: str, billing_cycle: str = "monthly") -> dict[str, Any]:
        _ensure_flag("MEMBERSHIP_SWITCH_ENABLED", "套餐切换暂未开启", "MEMBERSHIP_SWITCH_DISABLED")
        membership = OrganizationMembership.objects.select_related("tier").get(organization_id=str(organization_id))
        target = MembershipTier.objects.get(id=str(target_tier_id), is_active=True)
        cycle = MembershipStateResolver.validate_billing_cycle(billing_cycle or membership.billing_cycle)
        action = MembershipChangeClassifier.classify(
            current_membership=membership,
            target_tier=target,
            target_billing_cycle=cycle,
        )
        if action != "switch":
            raise MembershipLifecycleError("目标套餐不是同级切换", "MEMBERSHIP_ACTION_MISMATCH")
        target_price, target_price_version = self._target_price_snapshot(target, cycle)
        current_price = _money(membership.current_actual_paid_period_price if membership.current_actual_paid_period_price is not None else membership.tier.price)
        quoted_at = timezone.now()
        if target_price == current_price:
            mode = "immediate_free"
            payable = Decimal("0.00")
            effective_at = quoted_at
        elif target_price > current_price:
            # 同级高价切换不属于 upgrade，不能调用升级分类器；但价格入口仍复用
            # SubscriptionPricingService.resolve_target_effective_period_price。
            mode = "immediate_paid"
            period_seconds = Decimal(str(max((membership.end_date - membership.start_date).total_seconds(), 1)))
            remaining_seconds = Decimal(str(max((membership.end_date - quoted_at).total_seconds(), 0)))
            with localcontext() as context:
                context.prec = 40
                remaining_ratio = min(Decimal("1"), remaining_seconds / period_seconds)
                payable = ((target_price - current_price) * remaining_ratio).quantize(MONEY, rounding=ROUND_HALF_UP)
            effective_at = quoted_at
        else:
            mode = "next_cycle"
            payable = Decimal("0.00")
            effective_at = membership.end_date
        lifecycle_quote = LifecycleQuote(
            action="switch",
            effective_mode=mode,
            organization_id=str(organization_id),
            membership_id=str(membership.id),
            lifecycle_version=int(membership.lifecycle_version),
            from_tier_id=str(membership.tier_id),
            to_tier_id=str(target.id),
            billing_cycle=cycle,
            quoted_at=quoted_at,
            quote_expires_at=quoted_at + timezone.timedelta(seconds=_quote_ttl_seconds()),
            effective_at=effective_at,
            payable_amount=payable,
            target_effective_period_price=target_price,
            target_effective_period_price_version=target_price_version,
            from_tier_level=membership.tier.tier_level,
            to_tier_level=target.tier_level,
            current_actual_paid_period_price=current_price,
            metadata={
                "current_period_start": _dt(membership.start_date),
                "current_period_end": _dt(membership.end_date),
            },
        )
        return {
            "action": "switch",
            "effective_mode": mode,
            "switch_mode": mode,
            "effective_at": _dt(effective_at),
            "quoted_at": _dt(quoted_at),
            "quote_expires_at": _dt(quoted_at + timezone.timedelta(seconds=_quote_ttl_seconds())),
            "current_period_end": _dt(membership.end_date),
            "from_tier_level": membership.tier.tier_level,
            "to_tier_level": target.tier_level,
            "schema_version": LIFECYCLE_QUOTE_SCHEMA_VERSION,
            "currency": "CNY",
            "target_effective_period_price_version": target_price_version,
            "current_tier": _tier_snapshot(membership.tier),
            "target_tier": _tier_snapshot(target),
            "payable_amount": _money_str(payable),
            "target_effective_period_price": _money_str(target_price),
            "current_actual_paid_period_price": _money_str(current_price),
            "quote_token": self._sign(lifecycle_quote),
        }

    def apply_free_switch(self, *, user, organization_id: str, target_tier_id: str, billing_cycle: str, quote_token: str) -> dict[str, Any]:
        _ensure_flag("MEMBERSHIP_SWITCH_ENABLED", "套餐切换暂未开启", "MEMBERSHIP_SWITCH_DISABLED")
        payload = self._verify(quote_token, organization_id=organization_id, action="switch")
        if payload["effective_mode"] == "next_cycle":
            return self._schedule_change(
                user=user,
                organization_id=organization_id,
                target_tier_id=target_tier_id,
                billing_cycle=billing_cycle,
                quote_token=quote_token,
                action="switch",
            )
        if payload["effective_mode"] != "immediate_free":
            raise MembershipLifecycleError("该切换需要创建支付订单", "MEMBERSHIP_SWITCH_REQUIRES_PAYMENT")
        with transaction.atomic():
            membership = (
                OrganizationMembership.objects
                .select_for_update()
                .select_related("tier")
                .get(organization_id=str(organization_id))
            )
            target = MembershipTier.objects.get(id=str(target_tier_id), is_active=True)
            if str(membership.lifecycle_version) != str(payload["lifecycle_version"]):
                raise MembershipLifecycleError("会员状态已变化，请重新获取报价", "MEMBERSHIP_STATE_CHANGED")
            log = OrganizationMembershipChangeLog.objects.create(
                organization_id=str(organization_id),
                membership=membership,
                change_type=OrganizationMembershipChangeLog.ChangeType.SWITCH,
                status=OrganizationMembershipChangeLog.Status.APPLYING,
                from_tier=membership.tier,
                to_tier=target,
                from_tier_snapshot=_tier_snapshot(membership.tier),
                to_tier_snapshot=_tier_snapshot(target),
                from_billing_cycle=membership.billing_cycle,
                to_billing_cycle=payload["billing_cycle"],
                requested_by=user,
                effective_at=timezone.now(),
                list_amount=_money(payload["target_effective_period_price"]),
                payable_amount=Decimal("0.00"),
                reason="membership_switch_free_immediate",
                metadata={"quote_hash": _canonical_hash(payload), "quote_payload": payload},
            )
            membership.tier = target
            membership.billing_cycle = payload["billing_cycle"]
            membership.current_actual_paid_period_price = _money(payload["target_effective_period_price"])
            membership.lifecycle_version = int(membership.lifecycle_version or 0) + 1
            membership.save(update_fields=[
                "tier",
                "billing_cycle",
                "current_actual_paid_period_price",
                "lifecycle_version",
                "updated_at",
            ])
            self._sync_entitlement_and_budget(membership, reason="switch_free_immediate")
            log.mark_applied(at=timezone.now())
        return {"applied": True, "change_log_id": str(log.id)}

    def create_switch_order(self, *, user, organization_id: str, target_tier_id: str, billing_cycle: str, quote_token: str) -> dict[str, Any]:
        """创建同级高价切换钱包订单；低价/下周期和零差价不走支付订单。"""
        _ensure_flag("MEMBERSHIP_SWITCH_ENABLED", "套餐切换暂未开启", "MEMBERSHIP_SWITCH_DISABLED")
        payload = self._verify(quote_token, organization_id=organization_id, action="switch")
        if payload.get("effective_mode") != "immediate_paid":
            raise MembershipLifecycleError("该同级切换不需要创建支付订单", "MEMBERSHIP_SWITCH_ORDER_NOT_REQUIRED")
        with transaction.atomic():
            organization = Organization.objects.select_for_update().get(id=str(organization_id))
            membership = (
                OrganizationMembership.objects
                .select_for_update()
                .select_related("tier")
                .get(organization_id=str(organization.id))
            )
            target = MembershipTier.objects.get(id=str(target_tier_id), is_active=True)
            if str(membership.lifecycle_version) != str(payload["lifecycle_version"]):
                raise MembershipLifecycleError("会员状态已变化，请重新获取报价", "MEMBERSHIP_STATE_CHANGED")
            if str(target.id) != str(payload["to_tier_id"]):
                raise MembershipLifecycleError("报价目标套餐不匹配", "QUOTE_INVALID")
            cycle = MembershipStateResolver.validate_billing_cycle(billing_cycle or membership.billing_cycle)
            if cycle != payload["billing_cycle"]:
                raise MembershipLifecycleError("报价计费周期不匹配", "QUOTE_INVALID")

            quote_hash = _canonical_hash(payload)
            existing = PaymentOrder.objects.filter(
                organization_id=str(organization.id),
                order_type="membership",
                payment_method="organization_wallet",
                business_data__change_type="switch",
                business_data__quote_hash=quote_hash,
                status__in=["pending", "paid"],
            ).order_by("-created_at").first()
            if existing:
                return self._serialize_order(existing)

            change_plan = {
                "change_type": "switch",
                "organization_id": str(organization.id),
                "membership_id": str(membership.id),
                "membership_lifecycle_version": int(membership.lifecycle_version),
                "from_tier_id": str(membership.tier_id),
                "to_tier_id": str(target.id),
                "billing_cycle": payload["billing_cycle"],
                "effective_at": payload["effective_at"],
            }
            pricing_snapshot = {**payload, "quote_hash": quote_hash}
            log = OrganizationMembershipChangeLog.objects.create(
                organization=organization,
                membership=membership,
                change_type=OrganizationMembershipChangeLog.ChangeType.SWITCH,
                status=OrganizationMembershipChangeLog.Status.PAYMENT_PENDING,
                from_tier=membership.tier,
                to_tier=target,
                from_tier_snapshot=_tier_snapshot(membership.tier),
                to_tier_snapshot=_tier_snapshot(target),
                from_billing_cycle=membership.billing_cycle,
                to_billing_cycle=payload["billing_cycle"],
                requested_by=user,
                effective_at=_parse_dt(payload["effective_at"]),
                list_amount=_money(payload["target_effective_period_price"]),
                payable_amount=_money(payload["payable_amount"]),
                reason="membership_switch_paid_immediate",
                metadata={"quote_hash": quote_hash, "pricing_snapshot": pricing_snapshot, "change_plan": change_plan},
            )
            order = PaymentOrder.objects.create(
                user=user,
                organization_id=str(organization.id),
                order_type="membership",
                subject=f"会员同级切换：{target.name}",
                description="组织现金钱包支付会员同级切换差价",
                amount=_money(payload["payable_amount"]),
                paid_amount=Decimal("0.00"),
                payment_method="organization_wallet",
                status="pending",
                benefit_status="pending",
                expired_at=_parse_dt(payload["quote_expires_at"]),
                business_data={
                    "schema_version": 1,
                    "change_type": "switch",
                    "tier_id": str(target.id),
                    "organization_id": str(organization.id),
                    "membership_id": str(membership.id),
                    "membership_lifecycle_version": int(membership.lifecycle_version),
                    "change_log_id": str(log.id),
                    "quote_hash": quote_hash,
                    "pricing_snapshot": pricing_snapshot,
                    "change_plan": change_plan,
                    "currency": "CNY",
                },
            )
            log.payment_order_id = str(order.id)
            log.save(update_fields=["payment_order_id", "updated_at"])
        return self._serialize_order(order)

    # ---------- renewal order ----------

    def preview_renewal(self, *, organization_id: str, billing_cycle: str = "monthly") -> dict[str, Any]:
        _ensure_flag("MEMBERSHIP_MANUAL_RENEWAL_ENABLED", "手动续费暂未开启", "MEMBERSHIP_RENEWAL_DISABLED")
        membership = OrganizationMembership.objects.select_related("tier", "scheduled_tier").get(organization_id=str(organization_id))
        cycle = MembershipStateResolver.validate_billing_cycle(billing_cycle or membership.billing_cycle)
        target = membership.scheduled_tier or membership.tier
        now = timezone.now()
        if membership.status == "expired" and (not membership.grace_period_end or membership.grace_period_end < now):
            next_start = now
        else:
            next_start = membership.end_date
        next_end = _period_end(next_start, cycle)
        target_price = self._target_price(target, cycle)
        quote = LifecycleQuote(
            action="renewal",
            effective_mode="next_cycle",
            organization_id=str(organization_id),
            membership_id=str(membership.id),
            lifecycle_version=int(membership.lifecycle_version),
            from_tier_id=str(membership.tier_id),
            to_tier_id=str(target.id),
            billing_cycle=cycle,
            quoted_at=now,
            quote_expires_at=now + timezone.timedelta(seconds=_quote_ttl_seconds()),
            effective_at=next_start,
            payable_amount=target_price,
            target_effective_period_price=target_price,
            next_period_start=next_start,
            next_period_end=next_end,
            metadata={
                "scheduled_change_log_id": str(membership.scheduled_change_log_id or ""),
                "scheduled_change_applied_on_renewal": bool(membership.scheduled_tier_id),
            },
        )
        return {
            "action": "renewal",
            "current_tier": _tier_snapshot(membership.tier),
            "renewal_target_tier": _tier_snapshot(target),
            "current_end_date": _dt(membership.end_date),
            "next_period_start": _dt(next_start),
            "next_period_end": _dt(next_end),
            "list_price": _money_str(target_price),
            "effective_price": _money_str(target_price),
            "payable_amount": _money_str(target_price),
            "currency": "CNY",
            "scheduled_change_applied_on_renewal": bool(membership.scheduled_tier_id),
            "quote_token": self._sign(quote),
        }

    def create_renewal_order(self, *, user, organization_id: str, billing_cycle: str, quote_token: str) -> dict[str, Any]:
        _ensure_flag("MEMBERSHIP_MANUAL_RENEWAL_ENABLED", "手动续费暂未开启", "MEMBERSHIP_RENEWAL_DISABLED")
        payload = self._verify(quote_token, organization_id=organization_id, action="renewal")
        with transaction.atomic():
            organization = Organization.objects.select_for_update().get(id=str(organization_id))
            membership = (
                OrganizationMembership.objects
                .select_for_update()
                .select_related("tier")
                .get(organization_id=str(organization.id))
            )
            if str(membership.lifecycle_version) != str(payload["lifecycle_version"]):
                raise MembershipLifecycleError("会员状态已变化，请重新获取续费报价", "MEMBERSHIP_STATE_CHANGED")
            target = MembershipTier.objects.get(id=str(payload["to_tier_id"]), is_active=True)
            quote_hash = _canonical_hash(payload)
            existing = PaymentOrder.objects.filter(
                organization_id=str(organization.id),
                order_type="membership",
                payment_method="organization_wallet",
                business_data__change_type="renewal",
                business_data__quote_hash=quote_hash,
                status__in=["pending", "paid"],
            ).order_by("-created_at").first()
            if existing:
                return self._serialize_order(existing)
            change_plan = {
                "change_type": "renewal",
                "organization_id": str(organization.id),
                "membership_id": str(membership.id),
                "membership_lifecycle_version": int(membership.lifecycle_version),
                "from_tier_id": str(membership.tier_id),
                "to_tier_id": str(target.id),
                "billing_cycle": payload["billing_cycle"],
                "next_period_start": payload["next_period_start"],
                "next_period_end": payload["next_period_end"],
                "scheduled_change_log_id": (payload.get("metadata") or {}).get("scheduled_change_log_id") or "",
            }
            pricing_snapshot = {**payload, "quote_hash": quote_hash}
            log = OrganizationMembershipChangeLog.objects.create(
                organization=organization,
                membership=membership,
                change_type=OrganizationMembershipChangeLog.ChangeType.RENEWAL,
                status=OrganizationMembershipChangeLog.Status.PAYMENT_PENDING,
                from_tier=membership.tier,
                to_tier=target,
                from_tier_snapshot=_tier_snapshot(membership.tier),
                to_tier_snapshot=_tier_snapshot(target),
                from_billing_cycle=membership.billing_cycle,
                to_billing_cycle=payload["billing_cycle"],
                requested_by=user,
                effective_at=_parse_dt(payload["next_period_start"]),
                list_amount=_money(payload["target_effective_period_price"]),
                payable_amount=_money(payload["payable_amount"]),
                reason="membership_renewal",
                metadata={"quote_hash": quote_hash, "pricing_snapshot": pricing_snapshot, "change_plan": change_plan},
            )
            order = PaymentOrder.objects.create(
                user=user,
                organization_id=str(organization.id),
                order_type="membership",
                subject=f"会员续费：{target.name}",
                description="组织现金钱包支付会员续费",
                amount=_money(payload["payable_amount"]),
                paid_amount=Decimal("0.00"),
                payment_method="organization_wallet",
                status="pending",
                benefit_status="pending",
                expired_at=_parse_dt(payload["quote_expires_at"]),
                business_data={
                    "schema_version": 1,
                    "change_type": "renewal",
                    "tier_id": str(target.id),
                    "organization_id": str(organization.id),
                    "membership_id": str(membership.id),
                    "membership_lifecycle_version": int(membership.lifecycle_version),
                    "change_log_id": str(log.id),
                    "quote_hash": quote_hash,
                    "pricing_snapshot": pricing_snapshot,
                    "change_plan": change_plan,
                    "currency": "CNY",
                },
            )
            log.payment_order_id = str(order.id)
            log.save(update_fields=["payment_order_id", "updated_at"])
        return self._serialize_order(order)

    def wallet_pay_membership_order(
        self,
        user,
        organization_id: str,
        order_id: str,
        change_type: Optional[str] = None,
    ) -> dict[str, Any]:
        should_apply = False
        with transaction.atomic():
            order = (
                PaymentOrder.objects
                .select_for_update()
                .get(
                    id=str(order_id),
                    organization_id=str(organization_id),
                    order_type="membership",
                    payment_method="organization_wallet",
                )
            )
            order_business_data = dict(order.business_data or {})
            resolved_change_type = str(change_type or order_business_data.get("change_type") or "").strip().lower()
            if not resolved_change_type:
                raise MembershipLifecycleError("订单缺失变更类型", "MEMBERSHIP_ORDER_MISSING_CHANGE_TYPE")
            if order_business_data.get("change_type") and order_business_data.get("change_type") != resolved_change_type:
                raise MembershipLifecycleError("订单生命周期类型不匹配", "MEMBERSHIP_ACTION_MISMATCH")
            if order.status == "completed" or getattr(order, "benefit_status", "") == "completed":
                return self._serialize_order(order)
            if order.status == "paid" and order.benefit_status == "processing":
                return self._serialize_order(order)
            if order.status == "completed":
                return self._serialize_order(order)

            if order.status not in {"pending", "paid"}:
                raise MembershipLifecycleError("会员订单状态不允许支付", "MEMBERSHIP_ORDER_STATUS_INVALID")
            if order.is_expired():
                order.status = "expired"
                order.save(update_fields=["status", "updated_at"])
                raise MembershipLifecycleError("订单已过期，请重新获取报价", "QUOTE_EXPIRED")

            data = order_business_data
            change_plan = dict(data.get("change_plan") or {})
            change_log = (
                OrganizationMembershipChangeLog.objects
                .select_for_update()
                .filter(id=data.get("change_log_id"))
                .first()
            )

            if order.status == "paid":
                should_apply = True
            else:
                amount = _money(order.amount)
                if amount > Decimal("0.00"):
                    wallet = self._wallet_snapshot(str(organization_id), amount)
                    if not wallet["sufficient"]:
                        raise MembershipUpgradeBalanceError(wallet=wallet, payable_amount=amount)
                    try:
                        self.cash_wallet.spend(
                            organization_id=str(organization_id),
                            amount_cny=amount,
                            transaction_type="membership_lifecycle_payment",
                            description=f"会员生命周期支付: {order.order_no}",
                            operator_user_id=str(getattr(user, "id", "") or ""),
                            related_order_id=str(order.id),
                            metadata={"change_type": resolved_change_type, "order_no": order.order_no},
                        )
                    except InsufficientCashBalance as exc:
                        raise MembershipUpgradeBalanceError(
                            wallet=self._wallet_snapshot(str(organization_id), amount),
                            payable_amount=amount,
                        ) from exc
                order.status = "paid"
                order.paid_amount = _money(order.amount)
                order.paid_at = timezone.now()
                order.benefit_status = "pending"
                should_apply = True
                if change_log:
                    change_log.status = OrganizationMembershipChangeLog.Status.PAID
                    change_log.save(update_fields=["status", "updated_at"])

            order.save(update_fields=["status", "paid_amount", "paid_at", "benefit_status", "updated_at"])
            if order.status == "paid" and change_log and order.benefit_status != "processing":
                change_log.status = OrganizationMembershipChangeLog.Status.PAID
                change_log.save(update_fields=["status", "updated_at"])

        if should_apply:
            OrderBenefitService.grant(str(order_id))
        return self._serialize_order(PaymentOrder.objects.get(id=str(order_id)))

    def apply_paid_renewal(self, order_id: str) -> str:
        return self._apply_paid_order(order_id, expected_change_type="renewal")

    def apply_paid_switch(self, order_id: str) -> str:
        return self._apply_paid_order(order_id, expected_change_type="switch")

    def _apply_paid_order(self, order_id: str, *, expected_change_type: str) -> str:
        try:
            with transaction.atomic():
                order = (
                    PaymentOrder.objects
                    .select_for_update()
                    .select_related("user")
                    .get(id=str(order_id))
                )
                data = dict(order.business_data or {})
                if data.get("change_type") != expected_change_type:
                    raise MembershipLifecycleError("订单生命周期类型不匹配", "MEMBERSHIP_ACTION_MISMATCH")
                if order.status == "completed" or getattr(order, "benefit_status", "") == "completed":
                    return str(order.id)
                if order.status == "paid" and getattr(order, "benefit_status", "") == "processing":
                    return str(order.id)
                if order.status != "paid":
                    raise MembershipLifecycleError("会员订单尚未支付", "MEMBERSHIP_ORDER_NOT_PAID")

                plan = dict(data.get("change_plan") or {})
                membership = (
                    OrganizationMembership.objects
                    .select_for_update()
                    .select_related("tier")
                    .get(id=str(plan.get("membership_id")), organization_id=str(order.organization_id))
                )
                log = (
                    OrganizationMembershipChangeLog.objects
                    .select_for_update()
                    .filter(id=data.get("change_log_id"))
                    .first()
                )
                plan_version = int(plan.get("membership_lifecycle_version") or 0)
                log_status = (log.status if log else None)
                if str(membership.lifecycle_version) != str(plan_version):
                    if not log or log_status != OrganizationMembershipChangeLog.Status.FAILED:
                        order.benefit_status = "failed"
                        order.failure_code = "MEMBERSHIP_STATE_CHANGED_AFTER_PAYMENT"
                        order.failure_message = "支付后会员状态已变化，权益未自动生效"
                        order.save(update_fields=["benefit_status", "failure_code", "failure_message", "updated_at"])
                        if log:
                            log.mark_failed(reason=order.failure_message)
                        return str(order.id)

                target = MembershipTier.objects.get(id=str(plan.get("to_tier_id")), is_active=True)
                if log:
                    if log.status == OrganizationMembershipChangeLog.Status.APPLIED:
                        order.status = "completed"
                        order.benefit_status = "completed"
                        order.save(update_fields=["status", "benefit_status", "updated_at"])
                        return str(order.id)
                    if log.status == OrganizationMembershipChangeLog.Status.APPLYING:
                        return str(order.id)
                    if log.status not in {
                        OrganizationMembershipChangeLog.Status.PAID,
                        OrganizationMembershipChangeLog.Status.FAILED,
                        # PaymentOrder may already be marked paid when the
                        # callback is delivered directly to OrderBenefitService.
                        # In that path the change log can still be PAYMENT_PENDING;
                        # the paid order is the authoritative hand-off.
                        OrganizationMembershipChangeLog.Status.PAYMENT_PENDING,
                    }:
                        raise MembershipLifecycleError(
                            "订单对应变更记录状态不允许执行",
                            "MEMBERSHIP_ORDER_NOT_READY",
                        )
                    log.status = OrganizationMembershipChangeLog.Status.APPLYING
                    log.save(update_fields=["status", "updated_at"])
                order.benefit_status = "processing"
                order.failure_code = ""
                order.failure_message = ""
                order.save(update_fields=["benefit_status", "failure_code", "failure_message", "updated_at"])

                if expected_change_type == "renewal":
                    membership.tier = target
                    membership.billing_cycle = plan.get("billing_cycle") or membership.billing_cycle
                    membership.status = "active"
                    membership.grace_period_end = None
                    membership.end_date = _parse_dt(plan["next_period_end"])
                    if membership.scheduled_change_log_id:
                        membership.scheduled_tier = None
                        membership.scheduled_billing_cycle = None
                        membership.scheduled_change_type = None
                        membership.scheduled_change_effective_at = None
                        membership.scheduled_change_log_id = None
                else:
                    membership.tier = target
                    membership.billing_cycle = plan.get("billing_cycle") or membership.billing_cycle
                # 若是历史失败补偿重放且该次已执行过版本推进，避免重复增加生命周期版本。
                should_bump_version = int(membership.lifecycle_version or 0) == plan_version
                membership.current_actual_paid_period_price = _money((data.get("pricing_snapshot") or {}).get("target_effective_period_price") or order.amount)
                membership.related_order_id = str(order.id)
                membership.purchased_by = str(order.user_id)
                if should_bump_version:
                    membership.lifecycle_version = int(membership.lifecycle_version or 0) + 1
                membership.save()
                self._sync_entitlement_and_budget(
                    membership,
                    reason=f"paid_{expected_change_type}",
                )

                if log:
                    meta = dict(log.metadata or {})
                    meta["payment_completed"] = True
                    meta["applied_by_order_benefit_service"] = True
                    log.metadata = meta
                    log.status = OrganizationMembershipChangeLog.Status.APPLIED
                    log.applied_at = timezone.now()
                    log.save(update_fields=["metadata", "status", "applied_at", "updated_at"])

                order.status = "completed"
                order.benefit_status = "completed"
                order.failure_code = ""
                order.failure_message = ""
                order.save(update_fields=["status", "benefit_status", "failure_code", "failure_message", "updated_at"])
                return str(order.id)
        except Exception as exc:
            self._mark_paid_order_failed(order_id, code=f"MEMBERSHIP_{expected_change_type.upper()}_APPLY_FAILED", message=str(exc))
            raise

    def _mark_paid_order_failed(self, order_id: str, *, code: str, message: str) -> None:
        with transaction.atomic():
            order = PaymentOrder.objects.select_for_update().filter(id=str(order_id)).first()
            if not order:
                return
            order.benefit_status = "failed"
            order.failure_code = code
            order.failure_message = message
            order.save(update_fields=["benefit_status", "failure_code", "failure_message", "updated_at"])
            change_log_id = (order.business_data or {}).get("change_log_id")
            if change_log_id:
                OrganizationMembershipChangeLog.objects.filter(id=change_log_id).update(
                    status=OrganizationMembershipChangeLog.Status.FAILED,
                    reason=message,
                    updated_at=timezone.now(),
                )

    # ---------- expiry / grace ----------

    def process_membership_expiry(self, *, membership_id: str, now=None) -> dict[str, Any]:
        resolved_now = now or timezone.now()
        with transaction.atomic():
            membership = (
                OrganizationMembership.objects
                .select_for_update()
                .select_related("tier")
                .filter(id=str(membership_id))
                .first()
            )
            if not membership:
                return {"changed": False, "reason": "membership_missing"}
            if membership.status not in {"active", "grace"} or not membership.end_date:
                return {"changed": False}
            # 并发保护：任务重试/重入时，如果状态已被其他 worker 更新为更高状态，直接返回。
            if membership.status == "active" and membership.end_date > resolved_now:
                return {"changed": False}
            if membership.status == "grace" and membership.grace_period_end and membership.grace_period_end <= resolved_now:
                return {"changed": False}
            if membership.grace_period_end and membership.grace_period_end > resolved_now:
                if membership.status == "grace":
                    return {"changed": False, "state": "grace", "reason": "legacy_grace"}
                if membership.end_date <= resolved_now:
                    return {"changed": False, "state": "active", "reason": "legacy_grace"}
            if membership.end_date > resolved_now:
                return {"changed": False}
            if membership.status == "grace":
                return {"changed": False}
            if self._has_pending_renewal(membership):
                return {"changed": False, "state": "active", "reason": "pending_renewal"}
            if membership.scheduled_tier_id:
                log = (
                    OrganizationMembershipChangeLog.objects
                    .select_for_update()
                    .filter(id=membership.scheduled_change_log_id)
                    .first()
                )
                # The period boundary is end_date.  A worker/test may move the
                # boundary forward (for example after an expiry scan); do not
                # let an older scheduled timestamp prevent the due change.
                if membership.end_date > resolved_now and (
                    not membership.scheduled_change_effective_at
                    or membership.scheduled_change_effective_at > resolved_now
                ):
                    return {"changed": False, "state": "scheduled_waiting"}
                if log and log.status in {
                    OrganizationMembershipChangeLog.Status.APPLIED,
                    OrganizationMembershipChangeLog.Status.FAILED,
                    OrganizationMembershipChangeLog.Status.CANCELLED,
                }:
                    membership.scheduled_tier = None
                    membership.scheduled_billing_cycle = None
                    membership.scheduled_change_type = None
                    membership.scheduled_change_effective_at = None
                    membership.scheduled_change_log_id = None
                    membership.save(update_fields=[
                        "scheduled_tier",
                        "scheduled_billing_cycle",
                        "scheduled_change_type",
                        "scheduled_change_effective_at",
                        "scheduled_change_log_id",
                        "updated_at",
                    ])
                    return {"changed": False, "state": membership.status, "reason": "invalid_scheduled_change"}
                if log and log.status == OrganizationMembershipChangeLog.Status.APPLYING:
                    return {"changed": False, "state": "scheduled_waiting"}

                if log and log.status in {
                    OrganizationMembershipChangeLog.Status.PENDING,
                    OrganizationMembershipChangeLog.Status.SCHEDULED,
                    OrganizationMembershipChangeLog.Status.REQUESTED,
                    OrganizationMembershipChangeLog.Status.PAYMENT_PENDING,
                    OrganizationMembershipChangeLog.Status.PAID,
                }:
                    log.status = OrganizationMembershipChangeLog.Status.APPLYING
                    log.save(update_fields=["status", "updated_at"])

                # 免费目标可立即执行；付费目标未续费时不赠送，继续按 grace/expired。
                target = MembershipTier.objects.filter(
                    id=membership.scheduled_tier_id,
                    is_active=True,
                ).first()
                if not target:
                    return {"changed": False, "state": membership.status, "reason": "missing_scheduled_tier"}
                if _money(target.price) == Decimal("0.00"):
                    old_tier = membership.tier
                    membership.tier = target
                    membership.billing_cycle = membership.scheduled_billing_cycle or OrganizationMembership.BillingCycle.MONTHLY
                    membership.status = "active"
                    membership.current_actual_paid_period_price = Decimal("0.00")
                    membership.start_date = resolved_now
                    membership.end_date = _period_end(resolved_now, membership.billing_cycle)
                    membership.grace_period_end = None
                    membership.scheduled_tier = None
                    membership.scheduled_billing_cycle = None
                    membership.scheduled_change_type = None
                    membership.scheduled_change_effective_at = None
                    membership.scheduled_change_log_id = None
                    membership.lifecycle_version = int(membership.lifecycle_version or 0) + 1
                    membership.save()
                    if log:
                        log.status = OrganizationMembershipChangeLog.Status.APPLIED
                        log.applied_at = resolved_now
                        log.reason = "scheduled_free_change_applied_on_expiry"
                        meta = dict(log.metadata or {})
                        meta["applied_from_tier_id"] = str(old_tier.id)
                        meta["applied_to_tier_id"] = str(target.id)
                        log.metadata = meta
                        log.save(update_fields=["status", "applied_at", "reason", "metadata", "updated_at"])
                    self._sync_entitlement_and_budget(membership, reason="scheduled_free_change_applied")
                    return {"changed": True, "state": "free", "scheduled_change_applied": True}
                else:
                    membership.scheduled_tier = None
                    membership.scheduled_billing_cycle = None
                    membership.scheduled_change_type = None
                    membership.scheduled_change_effective_at = None
                    membership.scheduled_change_log_id = None
            if getattr(settings, "MEMBERSHIP_GRACE_PERIOD_ENABLED", False):
                grace_days = max(0, int(getattr(settings, "MEMBERSHIP_GRACE_PERIOD_DAYS", 7)))
                if grace_days > 0:
                    membership.status = "grace"
                    membership.grace_period_end = membership.end_date + timezone.timedelta(days=grace_days)
                    membership.lifecycle_version = int(membership.lifecycle_version or 0) + 1
                    membership.save(update_fields=[
                        "status", "grace_period_end", "scheduled_tier", "scheduled_billing_cycle",
                        "scheduled_change_type", "scheduled_change_effective_at", "scheduled_change_log_id",
                        "lifecycle_version", "updated_at",
                    ])
                    OrganizationMembershipChangeLog.objects.create(
                        organization_id=str(membership.organization_id),
                        membership=membership,
                        change_type=OrganizationMembershipChangeLog.ChangeType.GRACE_ENTER,
                        status=OrganizationMembershipChangeLog.Status.APPLIED,
                        from_tier=membership.tier,
                        to_tier=membership.tier,
                        from_tier_snapshot=_tier_snapshot(membership.tier),
                        to_tier_snapshot=_tier_snapshot(membership.tier),
                        effective_at=resolved_now,
                        applied_at=resolved_now,
                        reason="membership_expired_enter_grace",
                        metadata={"grace_period_end": _dt(membership.grace_period_end)},
                    )
                    self._sync_entitlement_and_budget(membership, reason="grace_enter")
                    return {"changed": True, "state": "grace"}
            membership.status = "expired"
            membership.grace_period_end = None
            membership.lifecycle_version = int(membership.lifecycle_version or 0) + 1
            membership.save(update_fields=[
                "status", "grace_period_end", "scheduled_tier", "scheduled_billing_cycle",
                "scheduled_change_type", "scheduled_change_effective_at", "scheduled_change_log_id",
                "lifecycle_version", "updated_at",
            ])
            return {"changed": True, "state": "expired"}

    def process_grace_expiration(self, *, membership_id: str, now=None) -> dict[str, Any]:
        resolved_now = now or timezone.now()
        with transaction.atomic():
            membership = (
                OrganizationMembership.objects
                .select_for_update()
                .select_related("tier")
                .get(id=str(membership_id))
            )
            if membership.status != "grace" or not membership.grace_period_end or membership.grace_period_end > resolved_now:
                return {"changed": False}
            if self._has_pending_renewal(membership):
                return {"changed": False, "state": "active", "reason": "pending_renewal"}
            free = self._free_tier() if getattr(settings, "MEMBERSHIP_EXPIRE_TO_FREE_ENABLED", True) else None
            old_tier = membership.tier
            if free:
                membership.tier = free
                membership.billing_cycle = OrganizationMembership.BillingCycle.MONTHLY
                membership.status = "active"
                membership.current_actual_paid_period_price = Decimal("0.00")
                membership.start_date = resolved_now
                membership.end_date = _period_end(resolved_now, membership.billing_cycle)
                state = "free"
            else:
                membership.status = "expired"
                state = "expired"
            membership.grace_period_end = None
            membership.lifecycle_version = int(membership.lifecycle_version or 0) + 1
            membership.save()
            OrganizationMembershipChangeLog.objects.create(
                organization_id=str(membership.organization_id),
                membership=membership,
                change_type=OrganizationMembershipChangeLog.ChangeType.GRACE_EXIT,
                status=OrganizationMembershipChangeLog.Status.APPLIED,
                from_tier=old_tier,
                to_tier=membership.tier,
                from_tier_snapshot=_tier_snapshot(old_tier),
                to_tier_snapshot=_tier_snapshot(membership.tier),
                effective_at=resolved_now,
                applied_at=resolved_now,
                reason=f"grace_expired_to_{state}",
            )
            self._sync_entitlement_and_budget(membership, reason="grace_exit")
            return {"changed": True, "state": state}
