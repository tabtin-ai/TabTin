"""将已确认的账户业务事实投影为用户通知。

这里只消费 billing 白名单事件，不重新判断余额、会员或存储状态。所有通知均按
接收人写入数据库级幂等键；异常不会反向影响原业务事实或实时数据刷新。
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Any

from apps.services.notification.services.account_notification_formatter import (
    CANONICAL_ACCOUNT_DISPLAY_EVENTS,
    prepare_account_notification_display,
)
from apps.services.notification.services.account_notification_payloads import (
    AccountDisplayContext,
)
from apps.services.notification.services.notification_service import (
    NotificationService,
    compact_notification_source_event_id,
)


CENTER_ONLY_EVENTS = {
    "invoice_refunded",
    "platform_refund_completed",
    "invoice_collection_succeeded",
}

# 这些事件在 Billing WS 与消息中心之间完成展示权交接。白名单之外的既有投影仍按
# 原路径写入消息中心，但不能在 WS 上声明已接管展示。
PRESENTATION_AUTHORITY_EVENTS = {
    "billing_blocked",
    "degradation_alert",
    "platform_refund_failed",
    "refund_partial_failure",
    "invoice_collection_failed",
    "credits_recharged",
    "membership_expiring",
    "membership_expired",
    "auto_renew_failed",
    "membership_downgraded_overlimit",
    "storage_warning",
    "storage_critical",
    "storage_package_expiring",
    "storage_auto_renew_failed",
    "member_budget_warning",
    "member_budget_exhausted",
}


@dataclass(frozen=True)
class ProjectionResult:
    authoritative: bool
    projected: bool
    recipient_count: int
    source_event_id: str


EVENT_PRESENTATION: dict[str, tuple[str, str, str]] = {
    "balance_low": ("账户余额提醒", "组织可用额度已低于提醒阈值。", "action_required"),
    "budget_warning": ("月度花费接近上限", "组织本月花费已达到预警阈值。", "action_required"),
    "budget_critical": ("月度花费达到上限", "组织本月花费已达到严重阈值，请及时处理。", "action_required"),
    "billing_blocked": ("组织计费已受限", "部分付费能力暂不可用，请检查账户状态。", "action_required"),
    "degradation_alert": ("计费能力出现降级", "产品检测到计费链路降级，请查看账户状态。", "view_context"),
    "credits_recharged": ("点券充值已到账", "本次充值已确认到账。", "notification_only"),
    "cash_recharged": ("现金钱包充值已到账", "本次充值已确认到账。", "notification_only"),
    "membership_expiring": ("组织会员即将到期", "请在到期前确认续费安排。", "action_required"),
    "membership_expired": ("组织会员已到期", "组织权益已按当前套餐状态更新。", "action_required"),
    "auto_renew_failed": ("组织会员自动续费失败", "请检查账户余额或续费设置。", "action_required"),
    "membership_downgraded_overlimit": ("降级后资源超出额度", "现有资源已超过当前套餐额度，请及时处理。", "action_required"),
    "invoice_refunded": ("账单退款成功", "退款状态已确认。", "notification_only"),
    "platform_refund_completed": ("支付平台退款成功", "退款状态已确认。", "notification_only"),
    "invoice_collection_succeeded": ("账单扣款成功", "账单已完成扣款。", "notification_only"),
    "invoice_collection_failed": ("账单扣款失败", "账单多次扣款未成功，请检查账户状态。", "action_required"),
    "platform_refund_failed": ("支付平台退款失败", "退款未完成，请查看账单详情。", "action_required"),
    "refund_partial_failure": ("退款部分失败", "退款流程未全部完成，请查看账单详情。", "action_required"),
    "storage_warning": ("存储空间即将用尽", "组织存储用量已达到预警阈值。", "action_required"),
    "storage_critical": ("存储空间严重不足", "组织存储用量已达到严重阈值。", "action_required"),
    "storage_package_expiring": ("存储套餐即将到期", "请在到期前确认续费安排。", "action_required"),
    "storage_auto_renew_failed": ("存储套餐自动续费失败", "请检查账户余额或续费设置。", "action_required"),
    "member_budget_warning": ("个人额度即将用尽", "你的成员额度已达到预警阈值。", "action_required"),
    "member_budget_exhausted": ("个人额度已用尽", "你的成员额度已达到上限。", "action_required"),
}


def _recipient_ids(organization_id: str, event_type: str, payload: dict[str, Any]) -> set[str]:
    from apps.tabtinspace.models import Organization, OrganizationMember

    organization = Organization.objects.filter(id=organization_id).only("owner_id").first()
    if not organization:
        return set()

    if event_type in {"member_budget_warning", "member_budget_exhausted"}:
        user_id = str(payload.get("user_id") or "").strip()
        if not user_id:
            return set()
        is_current_member = str(organization.owner_id) == user_id or OrganizationMember.objects.filter(
            organization_id=organization_id,
            user_id=user_id,
        ).exists()
        return {user_id} if is_current_member else set()

    recipients = {
        str(user_id)
        for user_id in OrganizationMember.objects.filter(
            organization_id=organization_id,
            role__in=("owner", "admin"),
        ).values_list("user_id", flat=True)
        if user_id
    }
    if organization.owner_id:
        recipients.add(str(organization.owner_id))
    return recipients


def _display_context(
    organization_id: str,
    event_type: str,
    payload: dict[str, Any],
) -> AccountDisplayContext:
    """读取事件发生时可安全展示的名称；失败时交由 formatter 使用语义 fallback。"""
    organization_name = None
    member_name = None
    try:
        from apps.tabtinspace.models import Organization

        organization_name = (
            Organization.objects.filter(id=organization_id)
            .values_list("name", flat=True)
            .first()
        )
    except Exception:
        organization_name = None

    if event_type in {"member_budget_warning", "member_budget_exhausted"}:
        user_id = payload.get("user_id")
        if isinstance(user_id, str) and user_id.strip():
            try:
                from apps.users.auth.models import User

                member_name = (
                    User.objects.filter(id=user_id.strip())
                    .values_list("nickname", flat=True)
                    .first()
                )
            except Exception:
                member_name = None

    return AccountDisplayContext(
        organization_name=organization_name,
        member_name=member_name,
    )


def _first(payload: dict[str, Any], *keys: str) -> str:
    for key in keys:
        value = payload.get(key)
        if value not in (None, ""):
            return str(value)
    return ""


def _business_key(organization_id: str, event_type: str, payload: dict[str, Any]) -> str:
    stable_id = _first(
        payload,
        "order_id",
        "transaction_id",
        "invoice_id",
        "refund_record_id",
        "subscription_id",
    )
    if stable_id:
        suffix = stable_id
    elif event_type in {"membership_expiring", "auto_renew_failed"}:
        suffix = f'{_first(payload, "end_date") or date.today().isoformat()}:{_first(payload, "days_left")}'
    elif event_type in {"member_budget_warning", "member_budget_exhausted"}:
        budget_type = _first(payload, "budget_type") or "monthly"
        cycle = (
            date.today().isoformat()
            if budget_type == "daily"
            else date.today().strftime("%Y-%m")
        )
        suffix = ":".join([
            _first(payload, "user_id"),
            budget_type,
            cycle,
        ])
    elif event_type in {"budget_warning", "budget_critical"}:
        suffix = date.today().strftime("%Y-%m")
    elif event_type == "balance_low":
        suffix = f'{_first(payload, "level") or "warning"}:{date.today().isoformat()}'
    elif event_type == "degradation_alert":
        suffix = f'{_first(payload, "meter_key") or "product"}:{date.today().isoformat()}'
    elif event_type in {"storage_warning", "storage_critical"}:
        suffix = f'{_first(payload, "level") or event_type}:{date.today().isoformat()}'
    elif event_type == "billing_blocked":
        suffix = f'{_first(payload, "block_type") or "billing"}:{date.today().isoformat()}'
    else:
        suffix = _first(payload, "expired_at", "end_at", "tier_name") or date.today().isoformat()
    return f"account:{organization_id}:{event_type}:{suffix}"


def project_account_notification(
    organization_id: str,
    event_type: str,
    payload: dict[str, Any],
) -> ProjectionResult:
    """持久化账户事实，并返回是否完成了权威展示投影。"""
    authoritative = event_type in PRESENTATION_AUTHORITY_EVENTS
    presentation = EVENT_PRESENTATION.get(event_type)
    if not presentation:
        return ProjectionResult(False, False, 0, "")
    if event_type == "billing_blocked" and payload.get("block_type") != "organization_billing_guard":
        return ProjectionResult(authoritative, False, 0, "")
    # 含支付平台退款时，invoice_refunded 只是内部账完成；等平台确认后再提示一次。
    if event_type == "invoice_refunded" and payload.get("platform_refunded") is True:
        return ProjectionResult(authoritative, False, 0, "")

    title, body, behavior = presentation
    if event_type == "balance_low" and payload.get("level") == "critical":
        title = "账户余额严重临界"
        body = "组织可用额度已达到严重阈值，请立即检查账户状态。"
    prepared_display = None
    if event_type in CANONICAL_ACCOUNT_DISPLAY_EVENTS:
        prepared_display = prepare_account_notification_display(
            event_type,
            payload,
            _display_context(str(organization_id), event_type, payload),
        )
        if prepared_display is not None:
            title = prepared_display.title
            body = prepared_display.body
    business_key = _business_key(str(organization_id), event_type, payload)
    stored_source_event_id, raw_source_event_id = compact_notification_source_event_id(
        business_key
    )
    metadata: dict[str, Any] = {
        "category": "account",
        "behavior": behavior,
        "billing_event_type": event_type,
        "dedupe_key": business_key,
        "source_event_id": stored_source_event_id,
        "channels": ["center"],
    }
    if prepared_display is not None:
        metadata["display"] = prepared_display.display
    if raw_source_event_id != stored_source_event_id:
        metadata["original_source_event_id"] = raw_source_event_id
    if authoritative:
        metadata["presentation_owner"] = "notification_projection"
        metadata["toast_policy"] = "desktop_fallback"
    if event_type in CENTER_ONLY_EVENTS:
        metadata["desktop_delivery"] = "never"
    else:
        metadata["navigate_to"] = {
            "type": "settings",
            "id": "usageBilling",
            "organizationId": str(organization_id),
        }

    # metadata 仅保留展示与去重需要的非敏感上下文；金额只进入用户可见文案，
    # 不复制到 metadata，也不持久化错误栈或原因全文。
    for key in (
        "level",
        "days_left",
        "days_remaining",
        "budget_type",
        "usage_percent",
        "tier_name",
        "package_name",
        "invoice_no",
    ):
        if payload.get(key) not in (None, ""):
            metadata[key] = payload[key]

    recipients = _recipient_ids(str(organization_id), event_type, payload)
    for user_id in recipients:
        NotificationService.notify(
            user_id=user_id,
            type=f"account.{event_type}",
            title=title,
            body=body,
            metadata=metadata,
            organization_id=str(organization_id),
        )
    recipient_count = len(recipients)
    return ProjectionResult(
        authoritative=authoritative,
        projected=authoritative and recipient_count > 0,
        recipient_count=recipient_count,
        source_event_id=stored_source_event_id,
    )


def persist_account_notification(
    organization_id: str,
    event_type: str,
    payload: dict[str, Any],
) -> int:
    """兼容旧调用方：持久化一个白名单账户事实并返回接收人数。"""
    return project_account_notification(
        organization_id,
        event_type,
        payload,
    ).recipient_count
