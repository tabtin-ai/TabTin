"""
计费降级追踪工具。

当计费失败但业务选择"不阻断主流程"时，通过 ``track_billing_degradation`` 记录降级次数。
窗口内累计超过阈值时自动创建 ``BillingAnomalyAlert``，使运维可及时感知计费服务异常。

阈值和窗口大小从 BillingRuntimeConfig 读取，AdminDash 可调。
"""

from __future__ import annotations

import logging
from decimal import Decimal

from prometheus_client import Counter

logger = logging.getLogger(__name__)

DEGRADATION_CACHE_PREFIX = "billing:degradation:"


def _get_degradation_config() -> tuple[int, int]:
    """返回 (window_seconds, alert_threshold)，从 RuntimeConfig 读取，回退到默认值。"""
    try:
        from apps.services.billing.services.runtime_config_service import BillingRuntimeConfigService
        config = BillingRuntimeConfigService.get_all()
        window = int(config.get("degradation_window_seconds", 3600))
        threshold = int(config.get("degradation_alert_threshold", 10))
        return window, threshold
    except Exception:
        return 3600, 10

DEGRADATION_EVENTS_TOTAL = Counter(
    "billing_degradation_events_total",
    "Total billing degradation events tracked",
    ["meter_key"],
)
DEGRADATION_ALERTS_CREATED = Counter(
    "billing_degradation_alerts_created_total",
    "Total billing degradation alerts created",
    ["meter_key"],
)


def track_billing_degradation(
    *,
    meter_key: str,
    organization_id: str = "",
    biz_type: str = "",
    error: str = "",
) -> int:
    """记录一次计费降级，返回当前窗口内累计次数。超阈值时创建 BillingAnomalyAlert。"""
    try:
        from django.core.cache import cache

        window_seconds, alert_threshold = _get_degradation_config()
        DEGRADATION_EVENTS_TOTAL.labels(meter_key=meter_key).inc()

        cache_key = f"{DEGRADATION_CACHE_PREFIX}{meter_key}"
        current = cache.get(cache_key)
        if current is None:
            cache.set(cache_key, 1, window_seconds)
            count = 1
        else:
            count = cache.incr(cache_key)

        if count >= alert_threshold:
            alert_flag_key = f"{cache_key}:alerted"
            if not cache.get(alert_flag_key):
                cache.set(alert_flag_key, 1, window_seconds)
                _create_degradation_alert(meter_key, count, organization_id, biz_type, error, alert_threshold)

        return count
    except Exception as exc:
        logger.warning("[DegradationTracker] tracker 自身异常: %s", exc)
        return -1


def _create_degradation_alert(
    meter_key: str,
    count: int,
    organization_id: str,
    biz_type: str,
    error: str,
    alert_threshold: int = 10,
) -> None:
    """创建降级告警记录并通过 EventBus 发送通知。"""
    try:
        from apps.services.billing.models import BillingAnomalyAlert

        BillingAnomalyAlert.objects.create(
            alert_type="pattern",
            severity="warning",
            organization_id=organization_id,
            metric_name=f"degradation:{meter_key}",
            current_value=Decimal(str(count)),
            baseline_value=Decimal("0"),
            threshold_ratio=Decimal(str(alert_threshold)),
            message=(
                f"计费降级频次告警: {meter_key} 在窗口内已发生 {count} 次。"
                f" biz_type={biz_type}, last_error={error[:200]}"
            ),
        )
        DEGRADATION_ALERTS_CREATED.labels(meter_key=meter_key).inc()
        logger.warning(
            "[DegradationTracker] 已创建降级告警: meter_key=%s, count=%d",
            meter_key, count,
        )
    except Exception as exc:
        logger.error("[DegradationTracker] 告警创建失败: %s", exc)

    try:
        from apps.extensions.event_bus import Event, EventBus

        EventBus.emit(Event(
            source="billing",
            event_type="billing.degradation_alert",
            organization_id=organization_id,
            payload={
                "meter_key": meter_key,
                "count": count,
                "biz_type": biz_type,
                "error": error[:200],
            },
        ))
    except Exception:
        pass

    try:
        from apps.services.billing.ws_events import publish_billing_event
        if organization_id:
            publish_billing_event(organization_id, "degradation_alert", {
                "meter_key": meter_key,
                "count": count,
                "biz_type": biz_type,
                "error": error[:200],
            })
    except Exception:
        pass
