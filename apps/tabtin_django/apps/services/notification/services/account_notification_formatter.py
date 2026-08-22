"""将强类型 Account 展示快照格式化为产品正典文案。"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Mapping

from apps.services.notification.services.account_notification_payloads import (
    AccountDisplayContext,
    AccountDisplayPayload,
    AutoRenewFailedDisplay,
    BalanceAlertDisplay,
    BillingBlockedDisplay,
    CashRechargeDisplay,
    CreditsRechargeDisplay,
    DegradationAlertDisplay,
    InvoiceCollectionFailedDisplay,
    MemberBudgetExhaustedDisplay,
    MemberBudgetWarningDisplay,
    MembershipExpiredDisplay,
    MembershipOverlimitDisplay,
    PlatformRefundFailedDisplay,
    StorageAlertDisplay,
    StorageAutoRenewFailedDisplay,
    build_account_display_payload,
    serialize_account_display,
)


CANONICAL_ACCOUNT_DISPLAY_EVENTS = frozenset({
    "balance_low",
    "billing_blocked",
    "degradation_alert",
    "credits_recharged",
    "cash_recharged",
    "membership_expired",
    "auto_renew_failed",
    "membership_downgraded_overlimit",
    "invoice_collection_failed",
    "platform_refund_failed",
    "storage_warning",
    "storage_critical",
    "storage_auto_renew_failed",
    "member_budget_warning",
    "member_budget_exhausted",
})


@dataclass(frozen=True, slots=True)
class PreparedAccountNotification:
    title: str
    body: str
    display: dict[str, object]


def _human_decimal(value: str) -> str:
    """移除无意义尾零，但不经 float、不舍入且不输出科学计数法。"""
    return format(Decimal(value).normalize(), "f")


def _human_cny(value: str) -> str:
    """人民币至少展示两位小数；超过两位的有效精度原样保留。"""
    text = _human_decimal(value)
    if "." not in text:
        return f"{text}.00"
    whole, fraction = text.split(".", 1)
    return f"{whole}.{fraction.ljust(2, '0')}"


def _currency_amount(amount: str, currency: str) -> str:
    if currency == "CNY":
        return f"{_human_cny(amount)} 元"
    return f"{_human_decimal(amount)}点券"


def _capacity(value: int) -> str:
    units = ("B", "KB", "MB", "GB", "TB", "PB")
    amount = Decimal(value)
    unit_index = 0
    while amount >= 1024 and unit_index < len(units) - 1:
        amount /= Decimal(1024)
        unit_index += 1
    text = format(amount.quantize(Decimal("0.01")), "f").rstrip("0").rstrip(".")
    return f"{text} {units[unit_index]}"


def format_account_notification(payload: AccountDisplayPayload) -> tuple[str, str]:
    if isinstance(payload, BalanceAlertDisplay):
        if payload.level == "critical":
            return (
                "点券余额严重不足",
                f"当前可用{_human_decimal(payload.current_balance)}{payload.unit}，"
                "继续消耗可能导致付费任务停止。",
            )
        return (
            "点券余额不足",
            f"当前可用{_human_decimal(payload.current_balance)}{payload.unit}，"
            f"已低于预警值{_human_decimal(payload.threshold)}{payload.unit}。",
        )

    if isinstance(payload, BillingBlockedDisplay):
        return (
            f"「{payload.organization_name}」的计费已被阻断",
            f"因{payload.safe_reason}，需要付费的任务暂时无法继续执行。",
        )

    if isinstance(payload, DegradationAlertDisplay):
        return "计费服务出现异常", f"{payload.capability}暂时受到影响，系统正在处理中。"

    if isinstance(payload, CreditsRechargeDisplay):
        return "点券充值已到账", f"本次到账 +{_human_decimal(payload.amount)}点券。"

    if isinstance(payload, CashRechargeDisplay):
        return "现金充值已到账", f"本次到账 +{_currency_amount(payload.amount, payload.currency)}。"

    if isinstance(payload, MembershipExpiredDisplay):
        return (
            f"{payload.old_tier_name}已到期",
            f"当前已切换为{payload.new_tier_name}，部分会员权益已停止。",
        )

    if isinstance(payload, AutoRenewFailedDisplay):
        return (
            f"{payload.tier_name}自动续费失败",
            f"失败原因：{payload.safe_reason}。请更新付款方式后重新续费。",
        )

    if isinstance(payload, MembershipOverlimitDisplay):
        details = "".join(
            f"{item.resource}已使用{_human_decimal(item.current)}，"
            f"当前上限为{_human_decimal(item.limit)}。"
            for item in payload.exceeded_items
        )
        return "会员降级后存在资源超限", details

    if isinstance(payload, InvoiceCollectionFailedDisplay):
        return (
            "账单扣款失败",
            f"应付金额为{_currency_amount(payload.total_amount, payload.currency)}。"
            f"失败原因：{payload.safe_reason}。",
        )

    if isinstance(payload, PlatformRefundFailedDisplay):
        return (
            "退款处理失败",
            f"{_currency_amount(payload.amount, payload.currency)}退款未完成。"
            f"失败原因：{payload.safe_reason}。",
        )

    if isinstance(payload, StorageAlertDisplay):
        usage = f"已使用{_capacity(payload.used_bytes)}/{_capacity(payload.total_bytes)}"
        if payload.level == "critical":
            return "存储空间严重不足", f"{usage}，上传和创建资源可能受到限制。"
        return "存储空间即将用满", f"{usage}，请及时清理或扩充空间。"

    if isinstance(payload, StorageAutoRenewFailedDisplay):
        return (
            f"{payload.package_name}自动续费失败",
            f"失败原因：{payload.safe_reason}。请更新付款方式后重新续费。",
        )

    if isinstance(payload, MemberBudgetWarningDisplay):
        title = f"{payload.member_name}的预算即将用尽" if payload.member_name else "你的预算即将用尽"
        return (
            title,
            f"已使用{_human_decimal(payload.consumed)}点券/"
            f"{_human_decimal(payload.limit)}点券，"
            f"剩余{_human_decimal(payload.remaining)}点券。",
        )

    if isinstance(payload, MemberBudgetExhaustedDisplay):
        title = f"{payload.member_name}的预算已用尽" if payload.member_name else "你的预算已用尽"
        return title, "该成员后续需要付费的任务可能无法继续执行。"

    raise TypeError(f"unsupported account display payload: {type(payload).__name__}")


def prepare_account_notification_display(
    event_type: str,
    raw_payload: Mapping[str, object],
    context: AccountDisplayContext,
) -> PreparedAccountNotification | None:
    display_payload = build_account_display_payload(event_type, raw_payload, context)
    if display_payload is None:
        return None
    title, body = format_account_notification(display_payload)
    return PreparedAccountNotification(
        title=title,
        body=body,
        display=serialize_account_display(display_payload),
    )
