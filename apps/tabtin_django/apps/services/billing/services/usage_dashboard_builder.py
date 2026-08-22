"""组织用量仪表盘数据构建（用户侧与 Admin staff 共用）。"""

from __future__ import annotations

from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Any, Dict

from django.db.models import Sum
from django.utils import timezone

from apps.services.billing.api_utils import safe_decimal, usage_event_display_credits
from apps.services.billing.models import BillingUsageEvent


def build_organization_usage_dashboard_data(
    organization_id: str,
    days: int = 30,
) -> Dict[str, Any]:
    """构建用量仪表盘 payload，字段与 Electron usage-dashboard 对齐。"""
    period_days = max(1, min(int(days or 30), 90))
    now = timezone.now()
    today = now.date()
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    tomorrow_start = today_start + timedelta(days=1)

    this_month_start = date(now.year, now.month, 1)
    last_month_end = this_month_start - timedelta(days=1)
    last_month_start = date(last_month_end.year, last_month_end.month, 1)
    last_month_start_dt = timezone.make_aware(
        datetime.combine(last_month_start, datetime.min.time()),
        timezone.get_current_timezone(),
    )

    display_rows = list(
        BillingUsageEvent.objects.filter(
            organization_id=organization_id,
            occurred_at__gte=last_month_start_dt,
        ).values(
            "meter_key",
            "quantity",
            "amount",
            "metadata",
            "model_name",
            "occurred_at",
        )
    )

    current_total = Decimal("0")
    last_total = Decimal("0")
    today_total = Decimal("0")
    meter_map: Dict[str, Dict[str, Decimal]] = {}
    model_map: Dict[str, Dict[str, Decimal | int]] = {}
    daily_map: Dict[str, Dict[str, Decimal]] = {}

    for row in display_rows:
        occurred_at = row["occurred_at"]
        occurred_date = occurred_at.date()
        credits = usage_event_display_credits(row)
        quantity = safe_decimal(row["quantity"])

        if occurred_date >= this_month_start:
            current_total += credits
            if today_start <= occurred_at < tomorrow_start:
                today_total += credits

            meter_key = row["meter_key"]
            meter = meter_map.setdefault(
                meter_key,
                {
                    "total_credits": Decimal("0"),
                    "total_quantity": Decimal("0"),
                },
            )
            meter["total_credits"] += credits
            meter["total_quantity"] += quantity

            model_name = (row.get("model_name") or "").strip()
            if meter_key == "llm.tokens" and model_name:
                model = model_map.setdefault(
                    model_name,
                    {
                        "total_credits": Decimal("0"),
                        "call_count": 0,
                    },
                )
                model["total_credits"] = safe_decimal(model["total_credits"]) + credits
                model["call_count"] = int(model["call_count"]) + 1

            day_key = occurred_date.isoformat()
            entry = daily_map.setdefault(
                day_key,
                {"total": Decimal("0"), "llm": Decimal("0"), "storage": Decimal("0")},
            )
            entry["total"] += credits
            if meter_key == "llm.tokens":
                entry["llm"] += credits
            elif meter_key in ("storage.gb_day", "storage.bytes"):
                entry["storage"] += credits
        elif last_month_start <= occurred_date < this_month_start:
            last_total += credits

    if last_total > 0:
        mom_pct = round(float((current_total - last_total) / last_total * 100), 1)
    else:
        mom_pct = None

    by_meter = sorted(
        [{"meter_key": k, **v} for k, v in meter_map.items()],
        key=lambda x: x["total_credits"],
        reverse=True,
    )

    today_key = today.isoformat()
    daily_trend = [
        {
            "date": day_key,
            "total_credits": str(safe_decimal(vals["total"])),
            "llm_credits": str(safe_decimal(vals["llm"])),
            "storage_credits": str(safe_decimal(vals["storage"])),
            "is_realtime": day_key == today_key,
        }
        for day_key, vals in sorted(daily_map.items())
    ]

    by_model = sorted(
        [
            {
                "model_name": model_name,
                "total_credits": safe_decimal(row["total_credits"]),
                "call_count": int(row["call_count"]),
            }
            for model_name, row in model_map.items()
        ],
        key=lambda row: row["total_credits"],
        reverse=True,
    )[:20]

    today_aggregated_agg = BillingUsageEvent.objects.filter(
        organization_id=organization_id,
        occurred_at__gte=today_start,
        occurred_at__lt=tomorrow_start,
        charge_status="aggregated",
    ).aggregate(total=Sum("amount"))
    today_aggregated_amount = str(safe_decimal(today_aggregated_agg.get("total")))

    return {
        "organization_id": organization_id,
        "period_days": period_days,
        "window_start": this_month_start.isoformat(),
        "current_month_total_credits": str(safe_decimal(current_total)),
        "last_month_total_credits": str(safe_decimal(last_total)),
        "month_over_month_pct": mom_pct,
        "today_total_credits": str(safe_decimal(today_total)),
        "today_aggregated_amount": today_aggregated_amount,
        "by_meter": [
            {
                "meter_key": row["meter_key"],
                "total_credits": str(safe_decimal(row["total_credits"])),
                "total_quantity": str(safe_decimal(row["total_quantity"])),
            }
            for row in by_meter
        ],
        "by_model": [
            {
                "model_name": row["model_name"],
                "total_credits": str(safe_decimal(row["total_credits"])),
                "call_count": int(row["call_count"]),
            }
            for row in by_model
        ],
        "daily_trend": daily_trend,
    }
