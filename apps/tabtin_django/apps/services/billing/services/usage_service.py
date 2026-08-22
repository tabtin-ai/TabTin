"""
用量事件服务
"""

from __future__ import annotations

import hashlib
import logging
from decimal import Decimal
from typing import Any, Dict, Optional

from django.conf import settings
from django.db import IntegrityError
from django.utils import timezone

from apps.services.billing.models import BillingUsageEvent

logger = logging.getLogger(__name__)

_SYSTEM_METER_KEYS = frozenset({
    "storage.gb_day",   # BillingUsageDaily 聚合维度，预留
    "storage.bytes",    # 系统级存储计量（孤儿清理、deactivate 等无用户上下文）
})


class BillingUsageService:
    """记录计费用量事件（organization 主体）"""

    LEGACY_CHARGE_STATUSES = {"pending", "aggregated"}

    @staticmethod
    def _is_llm_meter(meter_key: str) -> bool:
        return (meter_key or "").startswith("llm.")

    @staticmethod
    def _should_disable_non_llm_charge(
        *,
        meter_key: str,
        charge_status: str,
        amount: Decimal,
    ) -> bool:
        if BillingUsageService._is_llm_meter(meter_key):
            return False
        if getattr(settings, "BILLING_LEGACY_NON_LLM_USAGE_CHARGE_ENABLED", False):
            return False
        return charge_status in BillingUsageService.LEGACY_CHARGE_STATUSES or amount > 0

    @staticmethod
    def _build_idempotency_key(
        *,
        organization_id: str,
        meter_key: str,
        biz_type: str = "",
        biz_id: str = "",
        occurred_at=None,
    ) -> str:
        # occurred_at 精确到分钟，使同一 biz_id 在不同时间点的合法计费可区分，
        # 同一分钟内的重试仍命中幂等去重，避免漏计。
        if occurred_at is not None:
            try:
                minute_str = occurred_at.strftime("%Y%m%d%H%M")
            except AttributeError:
                minute_str = ""
        else:
            minute_str = ""
        raw = f"{organization_id}:{meter_key}:{biz_type}:{biz_id}:{minute_str}"
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()

    @staticmethod
    def record_event(
        *,
        organization_id: str,
        meter_key: str,
        quantity: Decimal,
        unit: str,
        unit_price: Decimal,
        amount: Decimal,
        currency: str = "CNY",
        user_id: Optional[str] = None,
        provider_key: str = "",
        model_name: str = "",
        biz_type: str = "",
        biz_id: str = "",
        scene_key: str = "",
        idempotency_key: str = "",
        logical_billing_key: str = "",
        attempt_index: Optional[int] = None,
        usage_source: str = "provider_final",
        metadata: Optional[Dict[str, Any]] = None,
        occurred_at=None,
        charge_status: str = "charged",
    ) -> BillingUsageEvent:
        if organization_id is None:
            raise ValueError("organization_id 不能为 None")

        #  FK 化：organization_id 为空串（无法归因的 legacy 场景）时落 NULL。
        resolved_organization_id = str(organization_id).strip() or None

        resolved_user_id = (user_id or "").strip()
        if not resolved_user_id and meter_key not in _SYSTEM_METER_KEYS:
            logger.warning(
                "[BillingUsage] user_id 为空: meter=%s ws=%s biz=%s:%s — "
                "成员消费统计将无法归属到具体用户",
                meter_key, organization_id, biz_type, biz_id,
            )

        occurred = occurred_at or timezone.now()
        idem_key = idempotency_key or BillingUsageService._build_idempotency_key(
            organization_id=organization_id,
            meter_key=meter_key,
            biz_type=biz_type,
            biz_id=biz_id,
            occurred_at=occurred,
        )

        resolved_amount = Decimal(str(amount or 0))
        resolved_unit_price = Decimal(str(unit_price or 0))
        resolved_charge_status = charge_status
        resolved_metadata = dict(metadata or {})

        if BillingUsageService._should_disable_non_llm_charge(
            meter_key=meter_key,
            charge_status=charge_status,
            amount=resolved_amount,
        ):
            logger.warning(
                "[BillingUsage] legacy non-LLM charge disabled: "
                "meter=%s status=%s amount=%s ws=%s biz=%s:%s",
                meter_key, charge_status, resolved_amount, organization_id, biz_type, biz_id,
            )
            resolved_metadata.update({
                "legacy_billing_disabled": True,
                "legacy_charge_status": charge_status,
                "legacy_amount": str(resolved_amount),
                "disabled_reason": "statement_mode",
            })
            resolved_amount = Decimal("0")
            resolved_unit_price = Decimal("0")
            # Keep a zero-amount audit event, but do not create new pending or
            # aggregated events that can be picked up by legacy collectors.
            resolved_charge_status = "charged"

        try:
            return BillingUsageEvent.objects.create(
                organization_id=resolved_organization_id,
                user_id=resolved_user_id,
                meter_key=meter_key,
                quantity=quantity,
                unit=unit,
                unit_price=resolved_unit_price,
                amount=resolved_amount,
                currency=currency,
                provider_key=provider_key or "",
                model_name=model_name or "",
                biz_type=biz_type or "",
                biz_id=biz_id or "",
                scene_key=scene_key or "",
                idempotency_key=idem_key,
                logical_billing_key=(logical_billing_key or "").strip(),
                attempt_index=attempt_index,
                usage_source=(usage_source or "").strip() or "provider_final",
                metadata=resolved_metadata,
                charge_status=resolved_charge_status,
                charged_at=occurred if resolved_charge_status == "charged" else None,
                occurred_at=occurred,
            )
        except IntegrityError:
            existing = BillingUsageEvent.objects.filter(idempotency_key=idem_key).first()
            if existing:
                return existing
            raise
