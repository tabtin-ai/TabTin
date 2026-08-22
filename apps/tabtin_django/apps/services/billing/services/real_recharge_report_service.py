"""平台真实充值报表与外部群聊投递。

报表口径只在这里定义。AdminDash 展示和外部 IM 投递都应复用该口径，避免
“页面看到一个数、群里收到另一个数”。飞书账号复用 channel_gateway 的加密
配置和出站 outbox，但归属到明确的平台租户哨兵，不借用任何客户组织。
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from decimal import Decimal
from typing import Callable, Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from asgiref.sync import async_to_sync
from django.db.models import Count, Q, Sum
from django.utils import timezone

from apps.channel_gateway.adapters.feishu import (
    FeishuAdapter,
    is_feishu_custom_bot_webhook_url,
)
from apps.channel_gateway.models import ChannelAccount, ChannelOutboundMessageRecord
from apps.channel_gateway.schemas import ChannelOutboundMessage, ChannelOutboundPayload
from apps.channel_gateway.services.outbound_service import ChannelOutboundService
from apps.services.payment.models import PaymentOrder

PLATFORM_CHANNEL_ORGANIZATION_ID = "__platform__"
REAL_RECHARGE_ACCOUNT_ID = "billing-real-recharge"
DEFAULT_PROVIDER = "feishu"
DEFAULT_DELIVERY_MODE = "manual"
DEFAULT_DAILY_TIME = "09:00"
DEFAULT_SCHEDULE_TIMEZONE = "Asia/Shanghai"

SUCCESS_STATUSES = ("paid", "completed")
EXTERNAL_PAYMENT_METHODS = ("alipay", "wechat")
PeriodKey = Literal["today", "current_month", "last_30_days", "all", "custom"]
DeliveryMode = Literal["manual", "per_recharge", "daily"]


@dataclass(frozen=True)
class RechargePeriod:
    key: PeriodKey
    start: datetime | None
    end: datetime | None
    label: str


@dataclass(frozen=True)
class WebhookDeliveryProvider:
    """一个可插拔的 Webhook 投递渠道定义。"""

    key: str
    label: str
    channel: str
    webhook_label: str
    webhook_placeholder: str
    webhook_help: str
    validator: Callable[[str], bool]
    adapter_factory: Callable[[], object]

    def serialize(self) -> dict:
        return {
            "key": self.key,
            "label": self.label,
            "webhook_label": self.webhook_label,
            "webhook_placeholder": self.webhook_placeholder,
            "webhook_help": self.webhook_help,
        }


WEBHOOK_DELIVERY_PROVIDERS = {
    "feishu": WebhookDeliveryProvider(
        key="feishu",
        label="Webhook",
        channel="feishu",
        webhook_label="Webhook 地址",
        webhook_placeholder="https://…",
        webhook_help="填写接收报表消息的 Webhook 地址。",
        validator=is_feishu_custom_bot_webhook_url,
        adapter_factory=FeishuAdapter,
    ),
}


def list_delivery_providers() -> list[dict]:
    return [provider.serialize() for provider in WEBHOOK_DELIVERY_PROVIDERS.values()]


def _provider(provider_key: str) -> WebhookDeliveryProvider:
    provider = WEBHOOK_DELIVERY_PROVIDERS.get((provider_key or "").strip())
    if not provider:
        raise ValueError("暂不支持这个报表投递渠道")
    return provider


def _provider_for_webhook(webhook_url: str) -> WebhookDeliveryProvider:
    for provider in WEBHOOK_DELIVERY_PROVIDERS.values():
        if provider.validator(webhook_url):
            return provider
    raise ValueError("请输入当前支持的 Webhook 地址")


def _aware_start(value: date) -> datetime:
    return timezone.make_aware(datetime.combine(value, time.min), timezone.get_current_timezone())


def resolve_recharge_period(
    key: PeriodKey,
    *,
    start_date: date | None = None,
    end_date: date | None = None,
    today: date | None = None,
) -> RechargePeriod:
    current = today or timezone.localdate()
    if key == "today":
        return RechargePeriod(key, _aware_start(current), _aware_start(current + timedelta(days=1)), "今日")
    if key == "current_month":
        start = current.replace(day=1)
        next_month = (start.replace(day=28) + timedelta(days=4)).replace(day=1)
        return RechargePeriod(key, _aware_start(start), _aware_start(next_month), "本月")
    if key == "last_30_days":
        start = current - timedelta(days=29)
        return RechargePeriod(key, _aware_start(start), _aware_start(current + timedelta(days=1)), "近 30 天")
    if key == "all":
        return RechargePeriod(key, None, None, "全部时间")
    if key != "custom":
        raise ValueError("不支持的统计时间范围")
    if start_date and end_date and start_date > end_date:
        raise ValueError("开始日期不能晚于结束日期")
    start = _aware_start(start_date) if start_date else None
    end = _aware_start(end_date + timedelta(days=1)) if end_date else None
    if start_date and end_date:
        label = f"{start_date.isoformat()} 至 {end_date.isoformat()}"
    elif start_date:
        label = f"{start_date.isoformat()} 起"
    elif end_date:
        label = f"截至 {end_date.isoformat()}"
    else:
        label = "自定义时间"
    return RechargePeriod(key, start, end, label)


def real_recharge_queryset(period: RechargePeriod):
    queryset = PaymentOrder.objects.filter(
        order_type="cash_wallet",
        payment_method__in=EXTERNAL_PAYMENT_METHODS,
        status__in=SUCCESS_STATUSES,
    )
    if period.start:
        queryset = queryset.filter(paid_at__gte=period.start)
    if period.end:
        queryset = queryset.filter(paid_at__lt=period.end)
    return queryset


def summarize_real_recharges(period: RechargePeriod) -> dict:
    values = real_recharge_queryset(period).aggregate(
        amount=Sum("paid_amount"),
        order_count=Count("id"),
        user_count=Count("user_id", distinct=True),
        organization_count=Count(
            "organization_id",
            distinct=True,
            filter=~Q(organization_id=""),
        ),
    )
    amount = values["amount"] or Decimal("0.00")
    return {
        "period_key": period.key,
        "period_label": period.label,
        "start_at": period.start.isoformat() if period.start else None,
        "end_at": period.end.isoformat() if period.end else None,
        "amount": f"{amount:.2f}",
        "order_count": int(values["order_count"] or 0),
        "user_count": int(values["user_count"] or 0),
        "organization_count": int(values["organization_count"] or 0),
    }


def get_delivery_account() -> ChannelAccount | None:
    return ChannelAccount.objects.filter(
        account_id=REAL_RECHARGE_ACCOUNT_ID,
        organization_id=PLATFORM_CHANNEL_ORGANIZATION_ID,
    ).order_by("-updated_at").first()


def serialize_delivery_config(account: ChannelAccount | None) -> dict:
    config = dict(account.config or {}) if account else {}
    provider_key = str(config.get("provider") or (account.channel if account else DEFAULT_PROVIDER))
    return {
        "channel": account.channel if account else DEFAULT_PROVIDER,
        "provider": provider_key,
        "available_providers": list_delivery_providers(),
        "enabled": bool(account and account.enabled),
        "name": (account.name or "") if account else "",
        "has_webhook_url": bool(config.get("webhook_url")),
        "delivery_mode": str(config.get("delivery_mode") or DEFAULT_DELIVERY_MODE),
        "daily_time": str(config.get("daily_time") or DEFAULT_DAILY_TIME),
        "schedule_timezone": str(
            config.get("schedule_timezone") or DEFAULT_SCHEDULE_TIMEZONE
        ),
        "updated_at": account.updated_at.isoformat() if account else None,
    }


def save_delivery_config(
    *,
    enabled: bool,
    name: str,
    webhook_url: str,
    provider: str = DEFAULT_PROVIDER,
    delivery_mode: DeliveryMode = DEFAULT_DELIVERY_MODE,
    daily_time: str = DEFAULT_DAILY_TIME,
    schedule_timezone: str = DEFAULT_SCHEDULE_TIMEZONE,
) -> ChannelAccount:
    requested_provider = _provider(provider)
    if delivery_mode not in {"manual", "per_recharge", "daily"}:
        raise ValueError("请选择有效的自动发送方式")
    try:
        datetime.strptime(daily_time, "%H:%M")
    except ValueError as exc:
        raise ValueError("每日发送时间格式应为 HH:MM") from exc
    try:
        ZoneInfo(schedule_timezone)
    except ZoneInfoNotFoundError as exc:
        raise ValueError("请选择有效的报表时区") from exc

    supplied_webhook_url = webhook_url.strip()
    provider_definition = (
        _provider_for_webhook(supplied_webhook_url) if supplied_webhook_url else requested_provider
    )
    account = ChannelAccount.objects.filter(
        channel=provider_definition.channel,
        account_id=REAL_RECHARGE_ACCOUNT_ID,
        organization_id=PLATFORM_CHANNEL_ORGANIZATION_ID,
    ).first()
    previous = dict(account.config or {}) if account else {}
    resolved_webhook_url = supplied_webhook_url or str(previous.get("webhook_url") or "")
    if enabled and not resolved_webhook_url:
        raise ValueError("请先填写投递渠道的 Webhook 地址")
    if resolved_webhook_url and not provider_definition.validator(resolved_webhook_url):
        raise ValueError("请输入当前支持的 Webhook 地址")
    ChannelAccount.objects.filter(
        account_id=REAL_RECHARGE_ACCOUNT_ID,
        organization_id=PLATFORM_CHANNEL_ORGANIZATION_ID,
    ).exclude(channel=provider_definition.channel).update(enabled=False)
    account, _ = ChannelAccount.objects.update_or_create(
        channel=provider_definition.channel,
        account_id=REAL_RECHARGE_ACCOUNT_ID,
        organization_id=PLATFORM_CHANNEL_ORGANIZATION_ID,
        defaults={
            "name": name.strip() or "真实充值报表",
            "enabled": enabled,
            "config": {
                "provider": provider_definition.key,
                "webhook_url": resolved_webhook_url,
                "delivery_mode": delivery_mode,
                "daily_time": daily_time,
                "schedule_timezone": schedule_timezone,
            },
        },
    )
    return account


def _require_ready_account() -> tuple[ChannelAccount, str, WebhookDeliveryProvider]:
    account = get_delivery_account()
    config = dict(account.config or {}) if account else {}
    provider = _provider(str(config.get("provider") or DEFAULT_PROVIDER))
    webhook_url = str(config.get("webhook_url") or "").strip()
    if not account or not account.enabled:
        raise ValueError("请先配置报表投递渠道")
    if not webhook_url:
        raise ValueError("请先配置投递渠道的 Webhook 地址")
    return account, "custom-bot-webhook", provider


def format_recharge_report(summary: dict, *, test: bool = False) -> str:
    heading = "【测试】TabTin 真实充值报表" if test else "TabTin 真实充值报表"
    return "\n".join(
        [
            heading,
            f"统计时间：{summary['period_label']}",
            f"实付充值总额：¥{summary['amount']}",
            f"成功充值笔数：{summary['order_count']}",
            f"充值用户数：{summary['user_count']}",
            f"充值组织数：{summary['organization_count']}",
            "口径：现金钱包充值；支付宝/微信；已支付或已完成；按实付金额。",
        ],
    )


def test_delivery() -> dict:
    account, target, provider = _require_ready_account()
    summary = summarize_real_recharges(resolve_recharge_period("today"))
    result = async_to_sync(provider.adapter_factory().send_text)(
        account,
        target,
        format_recharge_report(summary, test=True),
    )
    if not result.ok:
        raise ValueError(result.error or "Webhook 测试消息发送失败")
    return {"provider_message_id": result.provider_message_id, "summary": summary}


def _publish_report_message(
    *,
    account: ChannelAccount,
    target: str,
    text: str,
    metadata: dict,
    idempotency_key: str,
    deduplicate: bool = False,
) -> ChannelOutboundMessageRecord:
    if deduplicate:
        existing = ChannelOutboundMessageRecord.objects.filter(
            channel=account.channel,
            account_id=account.account_id,
            organization_id=PLATFORM_CHANNEL_ORGANIZATION_ID,
            idempotency_key=idempotency_key,
        ).first()
        if existing:
            return existing
    message = ChannelOutboundMessage(
        schema_version=1,
        type="channel.outbound",
        channel=account.channel,
        account_id=account.account_id,
        organization_id=PLATFORM_CHANNEL_ORGANIZATION_ID,
        to=target,
        idempotency_key=idempotency_key,
        payload=ChannelOutboundPayload(text=text, metadata=metadata),
    )
    return ChannelOutboundService().publish(message)


def queue_recharge_report(
    period: RechargePeriod,
    *,
    idempotency_key: str | None = None,
    deduplicate: bool = False,
) -> dict:
    account, target, _provider_definition = _require_ready_account()
    summary = summarize_real_recharges(period)
    resolved_idempotency_key = idempotency_key or (
        f"real-recharge:manual:{period.key}:{period.start}:{period.end}:{timezone.now().isoformat()}"
    )
    record = _publish_report_message(
        account=account,
        target=target,
        text=format_recharge_report(summary),
        metadata={"report_key": "billing.real_recharge", "summary": summary},
        idempotency_key=resolved_idempotency_key,
        deduplicate=deduplicate,
    )
    return {"outbox_id": str(record.id), "status": record.status, "summary": summary}


def is_real_recharge_order(order: PaymentOrder) -> bool:
    return (
        order.order_type == "cash_wallet"
        and order.payment_method in EXTERNAL_PAYMENT_METHODS
        and order.status in SUCCESS_STATUSES
    )


def format_single_recharge_notification(order: PaymentOrder) -> str:
    from apps.tabtinspace.models import Organization

    organization_name = ""
    if order.organization_id:
        organization_name = (
            Organization.objects.filter(id=order.organization_id)
            .values_list("name", flat=True)
            .first()
            or ""
        )
    operator_name = (
        order.user.get_full_name().strip()
        or getattr(order.user, "nickname", "")
        or order.user.username
    )
    paid_at = order.paid_at or order.updated_at
    return "\n".join(
        [
            "TabTin 新增真实充值",
            f"实付金额：¥{order.paid_amount:.2f}",
            f"订单号：{order.order_no}",
            f"组织：{organization_name or order.organization_id or '—'}",
            f"用户：{operator_name}",
            f"支付方式：{order.get_payment_method_display()}",
            f"支付时间：{timezone.localtime(paid_at).strftime('%Y-%m-%d %H:%M:%S')}",
        ]
    )


def queue_single_recharge_notification(order_id: str) -> dict:
    account, target, _provider_definition = _require_ready_account()
    config = dict(account.config or {})
    if config.get("delivery_mode") != "per_recharge":
        return {"queued": False, "reason": "delivery_mode_mismatch"}
    order = PaymentOrder.objects.select_related("user").filter(id=order_id).first()
    if not order or not is_real_recharge_order(order):
        return {"queued": False, "reason": "not_real_recharge"}
    record = _publish_report_message(
        account=account,
        target=target,
        text=format_single_recharge_notification(order),
        metadata={"report_key": "billing.real_recharge.single", "order_id": str(order.id)},
        idempotency_key=f"real-recharge:order:{order.id}",
        deduplicate=True,
    )
    return {"queued": True, "outbox_id": str(record.id), "status": record.status}


def queue_due_daily_recharge_report(*, now: datetime | None = None) -> dict:
    account = get_delivery_account()
    config = dict(account.config or {}) if account else {}
    if not account or not account.enabled or config.get("delivery_mode") != "daily":
        return {"queued": False, "reason": "delivery_mode_mismatch"}
    zone = ZoneInfo(str(config.get("schedule_timezone") or DEFAULT_SCHEDULE_TIMEZONE))
    local_now = (now or timezone.now()).astimezone(zone)
    scheduled = datetime.strptime(
        str(config.get("daily_time") or DEFAULT_DAILY_TIME), "%H:%M"
    ).time()
    if local_now.time().replace(second=0, microsecond=0) < scheduled:
        return {"queued": False, "reason": "not_due"}

    local_day = local_now.date()
    start = datetime.combine(local_day, time.min, tzinfo=zone)
    end = start + timedelta(days=1)
    period = RechargePeriod("custom", start, end, f"{local_day.isoformat()} 日报")
    result = queue_recharge_report(
        period,
        idempotency_key=f"real-recharge:daily:{local_day.isoformat()}:{zone.key}",
        deduplicate=True,
    )
    return {"queued": True, **result}
