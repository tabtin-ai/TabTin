"""
成员消费聚合服务 — 供 billing API 与 admin API 共用
"""

from __future__ import annotations

from datetime import timedelta
from decimal import Decimal
from typing import Any, Dict, List, Tuple

from django.utils import timezone

from apps.services.billing.api_utils import safe_decimal, usage_event_display_credits
from apps.services.billing.models import BillingUsageEvent

MAX_MEMBER_RESULTS = 100


def aggregate_member_usage(
    organization_id: str,
    *,
    period_days: int = 30,
    limit: int = MAX_MEMBER_RESULTS,
) -> Tuple[List[Dict[str, Any]], Dict[str, List[Dict[str, str]]], Decimal, int]:
    """
    按 user_id 聚合 organization 成员消费。

    Returns:
        (member_agg, meter_by_user, total_credits, period_days)
    """
    period_days = max(1, min(period_days, 90))
    window_start = timezone.now() - timedelta(days=period_days)

    usage_rows = list(
        BillingUsageEvent.objects.filter(
            organization_id=organization_id,
            occurred_at__gte=window_start,
        )
        .exclude(user_id="")
        .values("user_id", "meter_key", "quantity", "amount", "metadata")
    )

    member_map: Dict[str, Dict[str, Any]] = {}
    meter_by_user: Dict[str, List[Dict[str, str]]] = {}
    meter_map: Dict[tuple[str, str], Dict[str, Decimal]] = {}

    for row in usage_rows:
        uid = row["user_id"]
        credits = usage_event_display_credits(row)
        member = member_map.setdefault(uid, {
            "user_id": uid,
            "total_credits": Decimal("0"),
            "event_count": 0,
        })
        member["total_credits"] += credits
        member["event_count"] += 1

        meter_key = row["meter_key"]
        meter = meter_map.setdefault((uid, meter_key), {
            "credits": Decimal("0"),
            "quantity": Decimal("0"),
        })
        meter["credits"] += credits
        meter["quantity"] += safe_decimal(row["quantity"])

    member_agg = sorted(
        member_map.values(),
        key=lambda item: item["total_credits"],
        reverse=True,
    )[:limit]
    user_ids = [row["user_id"] for row in member_agg if row["user_id"]]

    allowed_users = set(user_ids)
    for (uid, meter_key), row in sorted(
        meter_map.items(),
        key=lambda item: (item[0][0], -item[1]["credits"]),
    ):
        if uid in allowed_users:
            meter_by_user.setdefault(uid, []).append({
                "meter_key": meter_key,
                "credits": str(safe_decimal(row["credits"])),
                "quantity": str(safe_decimal(row["quantity"])),
            })

    total_credits = sum(safe_decimal(row["total_credits"]) for row in member_agg)

    return member_agg, meter_by_user, total_credits, period_days


def build_user_info_map(user_ids: List[str]) -> Dict[str, Dict[str, str]]:
    """
    批量获取用户展示信息，统一使用 User.get_display_name()。
    供 billing API 与 admin API 共用，确保 display_name 逻辑一致。

    Returns:
        {user_id: {"display_name": "...", "avatar": "..."}}
    """
    if not user_ids:
        return {}

    from django.contrib.auth import get_user_model
    User = get_user_model()

    result: Dict[str, Dict[str, str]] = {}
    from apps.users.auth.api._shared import _maybe_presign_avatar

    for u in User.objects.using("default").filter(id__in=user_ids):
        display_fn = getattr(u, "get_display_name", None)
        display = display_fn() if callable(display_fn) else (
            u.username or u.email or f"用户{str(u.id)[:8]}"
        )
        result[str(u.id)] = {
            "display_name": display,
            "avatar": _maybe_presign_avatar(getattr(u, "avatar", None) or ""),
        }
    return result


def build_member_list(
    member_agg: List[Dict[str, Any]],
    meter_by_user: Dict[str, List[Dict[str, str]]],
    total_credits: Decimal,
    user_info_map: Dict[str, Dict[str, str]],
) -> List[Dict[str, Any]]:
    """
    将聚合结果与用户信息组装为最终成员列表。
    user_info_map: {user_id: {"display_name": ..., "avatar": ...}}
    """
    members = []
    for row in member_agg:
        uid = row["user_id"]
        info = user_info_map.get(uid, {})
        member_total = safe_decimal(row["total_credits"])
        pct = round(float(member_total / total_credits * 100), 1) if total_credits > 0 else 0
        members.append({
            "user_id": uid,
            "display_name": info.get("display_name", uid[:8]),
            "avatar": info.get("avatar", ""),
            "total_credits": str(member_total),
            "event_count": int(row["event_count"]),
            "percentage": pct,
            "by_meter": meter_by_user.get(uid, []),
        })
    return members
