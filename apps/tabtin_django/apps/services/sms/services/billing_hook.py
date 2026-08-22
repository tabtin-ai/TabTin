"""宪法 §3: SMS 发送成功后的计费事件写入。

meter_key = notification.sms.count，业务上下文发送走异步聚合（charge_status=pending）。
系统级发送（无用户上下文）用 __system__ 仅审计，不进入钱包聚合扣款。
"""

from __future__ import annotations

import logging
from decimal import Decimal

logger = logging.getLogger(__name__)


def record_sms_billing_event(
    *,
    organization_id: str = "",
    user_id: str = "",
    sms_record_id: str = "",
    phone: str = "",
    template_code: str = "",
    quantity: int = 1,
) -> None:
    """发送成功后写 BillingUsageEvent。

    调用方在发送成功路径调用，fail-open（异常只 warn 不阻断业务）。
    """
    try:
        from apps.services.billing.services.pricing_service import MeterPricingService
        from apps.services.billing.services.usage_service import BillingUsageService

        resolved_wt = organization_id or "__system__"

        meter_key = "notification.sms.count"
        unit_price = MeterPricingService.get_unit_price(
            meter_key,
            organization_id=resolved_wt if resolved_wt != "__system__" else None,
            default_price=Decimal("0"),
        ) or Decimal("0")
        qty = Decimal(str(quantity))
        is_system = resolved_wt == "__system__"
        amount = Decimal("0") if is_system else unit_price * qty

        BillingUsageService.record_event(
            organization_id=resolved_wt,
            user_id=user_id,
            meter_key=meter_key,
            quantity=qty,
            unit="count",
            unit_price=unit_price,
            amount=amount,
            biz_type="sms",
            biz_id=sms_record_id,
            charge_status="charged" if is_system else "pending",
            metadata={
                "phone_suffix": phone[-4:] if len(phone) >= 4 else "",
                "template_code": template_code,
                "system_event": is_system,
            },
        )
    except Exception:
        logger.warning(
            "[SMS] billing event write failed: record=%s wt=%s",
            sms_record_id, organization_id,
            exc_info=True,
        )
