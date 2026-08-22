"""Organization 套餐升级的只读报价服务。

PR3 只负责报价与签名，不创建订单、不修改会员或任何额度事实。
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import datetime, timedelta
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP, localcontext
from typing import Any

from django.conf import settings
from django.core import signing
from django.utils import timezone

from ..exceptions import MembershipLifecycleError
from .membership_change_classifier import (
    MembershipChangeAction,
    MembershipChangeClassifier,
)
from .membership_state_resolver import MembershipStateResolver


QUOTE_TOKEN_SALT = "membership.upgrade.quote.v1"
MONEY_QUANTUM = Decimal("0.01")
ZERO = Decimal("0")


class SubscriptionPricingError(MembershipLifecycleError):
    """报价失败；可附带分类器识别出的正确动作。"""

    def __init__(self, message, error_code, *, correct_action=None):
        self.correct_action = correct_action
        super().__init__(message, error_code)


@dataclass(frozen=True)
class TargetPeriodPrice:
    list_period_price: Decimal
    discount_amount: Decimal
    effective_period_price: Decimal
    price_source: str
    price_version: str


@dataclass(frozen=True)
class UpgradeQuote:
    organization_id: str
    membership_id: str
    membership_lifecycle_version: int
    action: str
    from_tier_id: str
    to_tier_id: str
    billing_cycle: str
    quoted_at: datetime
    quote_expires_at: datetime
    period_start: datetime
    period_end: datetime
    period_seconds: Decimal
    remaining_seconds: Decimal
    remaining_ratio: Decimal
    current_actual_paid_period_price: Decimal
    current_value: Decimal
    target_list_period_price: Decimal
    discount_amount: Decimal
    target_effective_period_price: Decimal
    target_value: Decimal
    payable_amount: Decimal
    currency: str
    rounding: str
    price_source: str
    price_version: str

    def token_payload(self) -> dict[str, Any]:
        return {
            "organization_id": self.organization_id,
            "membership_id": self.membership_id,
            "lifecycle_version": self.membership_lifecycle_version,
            "action": self.action,
            "from_tier_id": self.from_tier_id,
            "to_tier_id": self.to_tier_id,
            "billing_cycle": self.billing_cycle,
            "quoted_at": self.quoted_at.isoformat(),
            "quote_expires_at": self.quote_expires_at.isoformat(),
            "period_start": self.period_start.isoformat(),
            "period_end": self.period_end.isoformat(),
            "period_seconds": _decimal_string(self.period_seconds),
            "remaining_seconds": _decimal_string(self.remaining_seconds),
            "remaining_ratio": _decimal_string(self.remaining_ratio),
            "current_actual_paid_period_price": _decimal_string(
                self.current_actual_paid_period_price
            ),
            "target_list_period_price": _decimal_string(
                self.target_list_period_price
            ),
            "discount_amount": _decimal_string(self.discount_amount),
            "target_effective_period_price": _decimal_string(
                self.target_effective_period_price
            ),
            "current_value": _decimal_string(self.current_value),
            "target_value": _decimal_string(self.target_value),
            "payable_amount": _decimal_string(self.payable_amount),
            "currency": self.currency,
            "rounding": self.rounding,
            "price_source": self.price_source,
            "price_version": self.price_version,
        }

    def to_preview_data(self, *, current_tier, target_tier, quote_token: str) -> dict:
        return {
            "action": self.action,
            "current_tier": _tier_preview(current_tier),
            "target_tier": _tier_preview(target_tier),
            "period_start": self.period_start.isoformat(),
            "period_end": self.period_end.isoformat(),
            "period_seconds": _decimal_string(self.period_seconds),
            "remaining_seconds": _decimal_string(self.remaining_seconds),
            "remaining_ratio": _decimal_string(self.remaining_ratio),
            "current_actual_paid_period_price": _money_string(
                self.current_actual_paid_period_price
            ),
            "current_value": _money_string(self.current_value),
            "target_list_period_price": _money_string(
                self.target_list_period_price
            ),
            "discount_amount": _money_string(self.discount_amount),
            "target_effective_period_price": _money_string(
                self.target_effective_period_price
            ),
            "target_value": _money_string(self.target_value),
            "payable_amount": _money_string(self.payable_amount),
            "currency": self.currency,
            "effective_time": "immediate",
            "preserve_period_end": True,
            "quoted_at": self.quoted_at.isoformat(),
            "quote_expires_at": self.quote_expires_at.isoformat(),
            "quote_token": quote_token,
            "membership_lifecycle_version": self.membership_lifecycle_version,
            "price_source": self.price_source,
            "price_version": self.price_version,
        }


def _decimal_string(value: Decimal) -> str:
    return format(value, "f")


def _money_string(value: Decimal) -> str:
    return format(value.quantize(MONEY_QUANTUM, rounding=ROUND_HALF_UP), ".2f")


def _tier_preview(tier) -> dict:
    return {
        "id": str(tier.id),
        "tier_type": tier.tier_type,
        "name": tier.name,
        "tier_level": tier.tier_level,
    }


def _timedelta_seconds(value: timedelta) -> Decimal:
    return (
        Decimal(value.days * 86400 + value.seconds)
        + Decimal(value.microseconds) / Decimal("1000000")
    )


class SubscriptionPricingService:
    """升级报价唯一实现；所有方法均无数据库写入。"""

    @staticmethod
    def _quote_ttl_seconds() -> int:
        try:
            ttl = int(getattr(settings, "MEMBERSHIP_UPGRADE_QUOTE_TTL_SECONDS", 600))
        except (TypeError, ValueError) as exc:
            raise SubscriptionPricingError(
                "升级报价有效期配置无效",
                "MEMBERSHIP_UPGRADE_QUOTE_CONFIG_INVALID",
            ) from exc
        if ttl <= 0:
            raise SubscriptionPricingError(
                "升级报价有效期配置无效",
                "MEMBERSHIP_UPGRADE_QUOTE_CONFIG_INVALID",
            )
        return ttl

    @staticmethod
    def _as_money(value, *, error_code: str, label: str) -> Decimal:
        try:
            amount = Decimal(str(value))
        except (InvalidOperation, TypeError, ValueError) as exc:
            raise SubscriptionPricingError(f"{label}无效", error_code) from exc
        if not amount.is_finite() or amount < ZERO:
            raise SubscriptionPricingError(f"{label}无效", error_code)
        return amount

    def resolve_current_period_price(self, membership) -> Decimal:
        value = getattr(membership, "current_actual_paid_period_price", None)
        if value is None:
            raise SubscriptionPricingError(
                "当前套餐缺少可信的本周期成交价快照",
                "CURRENT_PERIOD_PRICE_SNAPSHOT_MISSING",
            )
        return self._as_money(
            value,
            error_code="CURRENT_PERIOD_PRICE_SNAPSHOT_INVALID",
            label="当前套餐本周期成交价",
        )

    def resolve_target_effective_period_price(
        self,
        *,
        target_tier,
        billing_cycle: str,
    ) -> TargetPeriodPrice:
        """目标价的唯一薄入口；PR3 暂以 MembershipTier.price 作为服务端价。"""
        list_price = self._as_money(
            getattr(target_tier, "price", None),
            error_code="TARGET_PERIOD_PRICE_INVALID",
            label="目标套餐价格",
        )
        discount = Decimal("0.00")
        effective = list_price - discount
        version_material = json.dumps(
            {
                "tier_id": str(target_tier.id),
                "billing_cycle": billing_cycle,
                "list_period_price": _decimal_string(list_price),
                "updated_at": (
                    target_tier.updated_at.isoformat()
                    if getattr(target_tier, "updated_at", None)
                    else None
                ),
            },
            sort_keys=True,
            separators=(",", ":"),
        )
        return TargetPeriodPrice(
            list_period_price=list_price,
            discount_amount=discount,
            effective_period_price=effective,
            price_source="membership_tier.price",
            price_version=hashlib.sha256(version_material.encode("utf-8")).hexdigest(),
        )

    def calculate_upgrade_quote(
        self,
        *,
        organization_id: str,
        membership,
        target_tier,
        target_billing_cycle: str,
        quoted_at: datetime | None = None,
    ) -> UpgradeQuote:
        resolved_at = quoted_at or timezone.now()
        self._validate_aware_datetime(resolved_at, "quoted_at")
        requested_cycle = MembershipStateResolver.validate_billing_cycle(
            target_billing_cycle
        )

        action = MembershipChangeClassifier.classify(
            current_membership=membership,
            target_tier=target_tier,
            target_billing_cycle=requested_cycle,
            now=resolved_at,
        )
        self._validate_membership(
            organization_id=organization_id,
            membership=membership,
            target_tier=target_tier,
            target_billing_cycle=requested_cycle,
            quoted_at=resolved_at,
        )
        if action != MembershipChangeAction.UPGRADE.value:
            raise SubscriptionPricingError(
                "该套餐动作不能使用升级报价",
                "MEMBERSHIP_ACTION_MISMATCH",
                correct_action=action,
            )
        current_price = self.resolve_current_period_price(membership)
        target_price = self.resolve_target_effective_period_price(
            target_tier=target_tier,
            billing_cycle=requested_cycle,
        )

        period_seconds = _timedelta_seconds(membership.end_date - membership.start_date)
        raw_remaining = _timedelta_seconds(membership.end_date - resolved_at)
        remaining_seconds = min(period_seconds, max(ZERO, raw_remaining))

        # 避免全局 Decimal context 被其他模块修改，并给比例与中间金额保留充分精度。
        with localcontext() as context:
            context.prec = 40
            remaining_ratio = remaining_seconds / period_seconds
            price_difference = max(
                ZERO,
                target_price.effective_period_price - current_price,
            )
            current_value = current_price * remaining_ratio
            target_value = target_price.effective_period_price * remaining_ratio
            payable_amount = (price_difference * remaining_ratio).quantize(
                MONEY_QUANTUM,
                rounding=ROUND_HALF_UP,
            )

        return UpgradeQuote(
            organization_id=str(organization_id),
            membership_id=str(membership.id),
            membership_lifecycle_version=int(membership.lifecycle_version),
            action=MembershipChangeAction.UPGRADE.value,
            from_tier_id=str(membership.tier_id),
            to_tier_id=str(target_tier.id),
            billing_cycle=requested_cycle,
            quoted_at=resolved_at,
            quote_expires_at=resolved_at + timedelta(seconds=self._quote_ttl_seconds()),
            period_start=membership.start_date,
            period_end=membership.end_date,
            period_seconds=period_seconds,
            remaining_seconds=remaining_seconds,
            remaining_ratio=remaining_ratio,
            current_actual_paid_period_price=current_price,
            current_value=current_value,
            target_list_period_price=target_price.list_period_price,
            discount_amount=target_price.discount_amount,
            target_effective_period_price=target_price.effective_period_price,
            target_value=target_value,
            payable_amount=payable_amount,
            currency="CNY",
            rounding="ROUND_HALF_UP",
            price_source=target_price.price_source,
            price_version=target_price.price_version,
        )

    def create_quote_token(self, quote: UpgradeQuote) -> str:
        return signing.dumps(
            quote.token_payload(),
            salt=QUOTE_TOKEN_SALT,
            compress=True,
        )

    def verify_quote_token(
        self,
        quote_token: str,
        *,
        organization_id: str,
        membership,
        target_tier,
        billing_cycle: str,
        now: datetime | None = None,
    ) -> dict[str, Any]:
        resolved_now = now or timezone.now()
        self._validate_aware_datetime(resolved_now, "now")
        try:
            payload = signing.loads(
                quote_token,
                salt=QUOTE_TOKEN_SALT,
                max_age=self._quote_ttl_seconds(),
            )
        except signing.SignatureExpired as exc:
            raise SubscriptionPricingError(
                "升级报价已过期",
                "UPGRADE_QUOTE_EXPIRED",
            ) from exc
        except signing.BadSignature as exc:
            raise SubscriptionPricingError(
                "升级报价签名无效",
                "UPGRADE_QUOTE_INVALID",
            ) from exc

        try:
            expires_at = datetime.fromisoformat(payload["quote_expires_at"])
        except (KeyError, TypeError, ValueError) as exc:
            raise SubscriptionPricingError(
                "升级报价内容无效",
                "UPGRADE_QUOTE_INVALID",
            ) from exc
        self._validate_aware_datetime(expires_at, "quote_expires_at")
        if resolved_now >= expires_at:
            raise SubscriptionPricingError(
                "升级报价已过期",
                "UPGRADE_QUOTE_EXPIRED",
            )

        expected = {
            "organization_id": str(organization_id),
            "membership_id": str(membership.id),
            "lifecycle_version": int(membership.lifecycle_version),
            "to_tier_id": str(target_tier.id),
            "billing_cycle": MembershipStateResolver.validate_billing_cycle(
                billing_cycle
            ),
        }
        mismatch_codes = {
            "organization_id": "UPGRADE_QUOTE_ORGANIZATION_MISMATCH",
            "membership_id": "UPGRADE_QUOTE_MEMBERSHIP_MISMATCH",
            "lifecycle_version": "UPGRADE_QUOTE_STALE",
            "to_tier_id": "UPGRADE_QUOTE_TARGET_TIER_MISMATCH",
            "billing_cycle": "UPGRADE_QUOTE_BILLING_CYCLE_MISMATCH",
        }
        for key, expected_value in expected.items():
            if payload.get(key) != expected_value:
                raise SubscriptionPricingError(
                    "升级报价与当前请求不一致",
                    mismatch_codes[key],
                )
        return payload

    @staticmethod
    def _validate_aware_datetime(value, field_name: str) -> None:
        if not isinstance(value, datetime) or timezone.is_naive(value):
            raise SubscriptionPricingError(
                f"{field_name} 必须是带时区时间戳",
                "MEMBERSHIP_PERIOD_INVALID",
            )

    def _validate_membership(
        self,
        *,
        organization_id,
        membership,
        target_tier,
        target_billing_cycle,
        quoted_at,
    ) -> None:
        if membership is None or str(membership.organization_id) != str(organization_id):
            raise SubscriptionPricingError(
                "组织会员不存在",
                "MEMBERSHIP_NOT_FOUND",
            )
        if str(getattr(membership, "status", "")).lower() != "active":
            raise SubscriptionPricingError(
                "当前会员状态不允许升级",
                "MEMBERSHIP_NOT_ACTIVE",
            )
        if not getattr(target_tier, "is_active", False):
            raise SubscriptionPricingError(
                "目标套餐无效",
                "MEMBERSHIP_TARGET_TIER_INVALID",
            )
        if getattr(membership, "lifecycle_version", None) is None:
            raise SubscriptionPricingError(
                "会员生命周期版本缺失",
                "MEMBERSHIP_LIFECYCLE_VERSION_MISSING",
            )
        start = getattr(membership, "start_date", None)
        end = getattr(membership, "end_date", None)
        self._validate_aware_datetime(start, "start_date")
        self._validate_aware_datetime(end, "end_date")
        if end <= start:
            raise SubscriptionPricingError(
                "会员周期无效",
                "MEMBERSHIP_PERIOD_INVALID",
            )
        if quoted_at >= end:
            raise SubscriptionPricingError(
                "当前会员周期已到期",
                "MEMBERSHIP_PERIOD_EXPIRED",
            )
        current_cycle = MembershipStateResolver.resolve_billing_cycle(membership)
        if target_billing_cycle != current_cycle:
            raise SubscriptionPricingError(
                "计费周期变化不能使用升级报价",
                "MEMBERSHIP_BILLING_CYCLE_CHANGE_NOT_ALLOWED",
            )
