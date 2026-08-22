"""Account 通知的强类型历史展示快照。"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from decimal import Decimal, InvalidOperation
import re
from typing import ClassVar, Mapping, TypeAlias

from apps.services.notification.services.account_notification_safe_reason import (
    resolve_safe_capability,
    resolve_safe_reason,
)


UUID_PATTERN = re.compile(
    r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-"
    r"[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}"
)
EMPTY_DISPLAY_VALUES = {"none", "null", "undefined"}
RESOURCE_LABELS = {
    "tables": "表格",
    "records_per_table": "单表记录",
    "members": "成员",
    "storage": "存储空间",
}
SUPPORTED_CURRENCIES = {"CNY", "CREDITS"}


@dataclass(frozen=True, slots=True)
class AccountDisplayContext:
    organization_name: str | None = None
    member_name: str | None = None


@dataclass(frozen=True, slots=True)
class BalanceAlertDisplay:
    schema: ClassVar[str] = "account.balance_alert.v1"
    level: str
    current_balance: str
    threshold: str
    unit: str = "点券"


@dataclass(frozen=True, slots=True)
class BillingBlockedDisplay:
    schema: ClassVar[str] = "account.billing_blocked.v1"
    organization_name: str
    safe_reason: str


@dataclass(frozen=True, slots=True)
class DegradationAlertDisplay:
    schema: ClassVar[str] = "account.degradation_alert.v1"
    capability: str


@dataclass(frozen=True, slots=True)
class CreditsRechargeDisplay:
    schema: ClassVar[str] = "account.credits_recharged.v1"
    amount: str


@dataclass(frozen=True, slots=True)
class CashRechargeDisplay:
    schema: ClassVar[str] = "account.cash_recharged.v1"
    amount: str
    currency: str


@dataclass(frozen=True, slots=True)
class MembershipExpiredDisplay:
    schema: ClassVar[str] = "account.membership_expired.v1"
    old_tier_name: str
    new_tier_name: str


@dataclass(frozen=True, slots=True)
class AutoRenewFailedDisplay:
    schema: ClassVar[str] = "account.auto_renew_failed.v1"
    tier_name: str
    safe_reason: str


@dataclass(frozen=True, slots=True)
class OverlimitItemDisplay:
    resource: str
    current: str
    limit: str


@dataclass(frozen=True, slots=True)
class MembershipOverlimitDisplay:
    schema: ClassVar[str] = "account.membership_downgraded_overlimit.v1"
    exceeded_items: tuple[OverlimitItemDisplay, ...]


@dataclass(frozen=True, slots=True)
class InvoiceCollectionFailedDisplay:
    schema: ClassVar[str] = "account.invoice_collection_failed.v1"
    total_amount: str
    currency: str
    safe_reason: str
    attempt_count: int | None = None


@dataclass(frozen=True, slots=True)
class PlatformRefundFailedDisplay:
    schema: ClassVar[str] = "account.platform_refund_failed.v1"
    amount: str
    currency: str
    safe_reason: str


@dataclass(frozen=True, slots=True)
class StorageAlertDisplay:
    schema: ClassVar[str] = "account.storage_alert.v1"
    level: str
    used_bytes: int
    total_bytes: int


@dataclass(frozen=True, slots=True)
class StorageAutoRenewFailedDisplay:
    schema: ClassVar[str] = "account.storage_auto_renew_failed.v1"
    package_name: str
    safe_reason: str


@dataclass(frozen=True, slots=True)
class MemberBudgetWarningDisplay:
    schema: ClassVar[str] = "account.member_budget_warning.v1"
    member_name: str | None
    consumed: str
    limit: str
    remaining: str


@dataclass(frozen=True, slots=True)
class MemberBudgetExhaustedDisplay:
    schema: ClassVar[str] = "account.member_budget_exhausted.v1"
    member_name: str | None


AccountDisplayPayload: TypeAlias = (
    BalanceAlertDisplay
    | BillingBlockedDisplay
    | DegradationAlertDisplay
    | CreditsRechargeDisplay
    | CashRechargeDisplay
    | MembershipExpiredDisplay
    | AutoRenewFailedDisplay
    | MembershipOverlimitDisplay
    | InvoiceCollectionFailedDisplay
    | PlatformRefundFailedDisplay
    | StorageAlertDisplay
    | StorageAutoRenewFailedDisplay
    | MemberBudgetWarningDisplay
    | MemberBudgetExhaustedDisplay
)


def _safe_name(value: object, fallback: str | None) -> str | None:
    if not isinstance(value, str):
        return fallback
    candidate = " ".join(value.split()).strip()
    if (
        not candidate
        or candidate.casefold() in EMPTY_DISPLAY_VALUES
        or UUID_PATTERN.fullmatch(candidate)
    ):
        return fallback
    return candidate


def _decimal_text(value: object) -> str | None:
    if isinstance(value, bool) or not isinstance(value, (Decimal, int, float, str)):
        return None
    if isinstance(value, str) and not value.strip():
        return None
    try:
        number = Decimal(str(value).strip())
    except (InvalidOperation, ValueError):
        return None
    if not number.is_finite() or number < 0:
        return None
    return format(number, "f")


def _integer(value: object) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return None
    return value


def _currency(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    candidate = value.strip().upper()
    return candidate if candidate in SUPPORTED_CURRENCIES else None


def _reason_from(payload: Mapping[str, object]) -> str:
    for key in ("reason", "error_code", "last_error_code"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return resolve_safe_reason(value)
    return resolve_safe_reason("unknown")


def build_account_display_payload(
    event_type: str,
    payload: Mapping[str, object],
    context: AccountDisplayContext,
) -> AccountDisplayPayload | None:
    if event_type == "balance_low":
        level = payload.get("level")
        current = _decimal_text(payload.get("current_balance"))
        threshold = _decimal_text(payload.get("threshold"))
        if level not in {"warning", "critical"} or current is None or threshold is None:
            return None
        return BalanceAlertDisplay(level=level, current_balance=current, threshold=threshold)

    if event_type == "billing_blocked":
        return BillingBlockedDisplay(
            organization_name=_safe_name(context.organization_name, "该组织") or "该组织",
            safe_reason=_reason_from(payload),
        )

    if event_type == "degradation_alert":
        return DegradationAlertDisplay(
            capability=resolve_safe_capability(payload.get("biz_type"), payload.get("meter_key"))
        )

    if event_type == "credits_recharged":
        amount = _decimal_text(payload.get("amount"))
        return CreditsRechargeDisplay(amount=amount) if amount is not None else None

    if event_type == "cash_recharged":
        amount = _decimal_text(payload.get("amount_cny"))
        return CashRechargeDisplay(amount=amount, currency="CNY") if amount is not None else None

    if event_type == "membership_expired":
        return MembershipExpiredDisplay(
            old_tier_name=_safe_name(payload.get("old_tier_name"), "会员方案") or "会员方案",
            new_tier_name=_safe_name(payload.get("new_tier_name"), "当前方案") or "当前方案",
        )

    if event_type == "auto_renew_failed":
        return AutoRenewFailedDisplay(
            tier_name=_safe_name(payload.get("tier_name"), "会员方案") or "会员方案",
            safe_reason=_reason_from(payload),
        )

    if event_type == "membership_downgraded_overlimit":
        raw_items = payload.get("exceeded_items")
        if not isinstance(raw_items, (list, tuple)):
            return None
        items: list[OverlimitItemDisplay] = []
        for raw_item in raw_items:
            if not isinstance(raw_item, Mapping):
                continue
            current = _decimal_text(raw_item.get("current"))
            limit = _decimal_text(raw_item.get("limit"))
            if current is None or limit is None:
                continue
            raw_resource = raw_item.get("resource")
            resource = RESOURCE_LABELS.get(raw_resource, "资源") if isinstance(raw_resource, str) else "资源"
            items.append(OverlimitItemDisplay(resource=resource, current=current, limit=limit))
        return MembershipOverlimitDisplay(tuple(items)) if items else None

    if event_type == "invoice_collection_failed":
        amount = _decimal_text(payload.get("total_amount"))
        currency = _currency(payload.get("currency"))
        if amount is None or currency is None:
            return None
        return InvoiceCollectionFailedDisplay(
            total_amount=amount,
            currency=currency,
            safe_reason=_reason_from(payload),
            attempt_count=_integer(payload.get("attempt_count")),
        )

    if event_type == "platform_refund_failed":
        amount = _decimal_text(payload.get("amount"))
        currency = _currency(payload.get("currency"))
        if amount is None or currency is None:
            return None
        return PlatformRefundFailedDisplay(
            amount=amount,
            currency=currency,
            safe_reason=_reason_from(payload),
        )

    if event_type in {"storage_warning", "storage_critical"}:
        used_bytes = _integer(payload.get("used_bytes"))
        total_bytes = _integer(payload.get("package_bytes"))
        if used_bytes is None or total_bytes is None:
            return None
        return StorageAlertDisplay(
            level="critical" if event_type == "storage_critical" else "warning",
            used_bytes=used_bytes,
            total_bytes=total_bytes,
        )

    if event_type == "storage_auto_renew_failed":
        return StorageAutoRenewFailedDisplay(
            package_name=_safe_name(payload.get("package_name"), "存储包") or "存储包",
            safe_reason=_reason_from(payload),
        )

    if event_type == "member_budget_warning":
        consumed = _decimal_text(payload.get("consumed"))
        limit = _decimal_text(payload.get("limit"))
        if consumed is None or limit is None:
            return None
        remaining = max(Decimal(limit) - Decimal(consumed), Decimal("0"))
        return MemberBudgetWarningDisplay(
            member_name=_safe_name(context.member_name, None),
            consumed=consumed,
            limit=limit,
            remaining=format(remaining, "f"),
        )

    if event_type == "member_budget_exhausted":
        return MemberBudgetExhaustedDisplay(
            member_name=_safe_name(context.member_name, None),
        )

    return None


def serialize_account_display(payload: AccountDisplayPayload) -> dict[str, object]:
    values = asdict(payload)
    serialized: dict[str, object] = {"schema": payload.schema}
    for key, value in values.items():
        if value is None:
            continue
        if isinstance(value, tuple):
            serialized[key] = list(value)
        else:
            serialized[key] = value
    return serialized
