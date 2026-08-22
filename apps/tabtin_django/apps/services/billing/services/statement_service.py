"""
消费对账单服务。

Statement 是只读对账视图：汇总已发生的 LLM 用量、钱包流水、支付订单和当前权益，
不生成应收账单，也不触发任何钱包扣款。
"""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Any, Dict, Iterable, Tuple

from django.db.models import Count, Q, Sum
from django.utils import timezone

from apps.services.billing.models import (
    BillingInvoice,
    BillingUsageEvent,
    OrganizationLlmMonthlyBudget,
    OrganizationStorageUsage,
)
from apps.services.payment.models import PaymentOrder
from apps.users.wallet.models import WalletTransaction

from .policy_service import OrganizationBillingPolicyService


class StatementService:
    """构建 organization 月度消费对账单。"""

    LLM_METER_PREFIXES = ("llm.", "chat.", "agent.")
    ORDER_TYPES = ("credits", "membership", "storage_package", "billing_addon")

    @classmethod
    def generate_monthly_statement(cls, organization_id: str, month: str | date | None = None) -> Dict[str, Any]:
        if not organization_id:
            raise ValueError("organization_id 不能为空")

        month_start = cls._parse_month(month)
        period_start, period_end = cls._month_bounds(month_start)

        return {
            "organization_id": organization_id,
            "month": month_start.strftime("%Y-%m"),
            "period_start": period_start.isoformat(),
            "period_end": period_end.isoformat(),
            "statement_type": "statement",
            "read_only": True,
            "collection_enabled": False,
            "llm_usage": cls._build_llm_usage(organization_id, period_start, period_end),
            "wallet": cls._build_wallet_summary(organization_id, period_start, period_end),
            "orders": cls._build_order_summary(organization_id, period_start, period_end),
            "entitlements": cls._build_entitlement_summary(organization_id, month_start),
            "legacy_invoices": cls._build_legacy_invoice_summary(organization_id, period_start, period_end),
            "guardrails": {
                "auto_collect_open_invoices": "disabled",
                "manual_collect_invoice": "disabled",
                "non_llm_resources": "entitlement_only",
            },
        }

    @classmethod
    def get_statement_detail(cls, organization_id: str, month: str | date | None = None) -> Dict[str, Any]:
        return cls.generate_monthly_statement(organization_id=organization_id, month=month)

    @staticmethod
    def _parse_month(month: str | date | None) -> date:
        if isinstance(month, date):
            return date(month.year, month.month, 1)
        if not month:
            today = timezone.localdate()
            return date(today.year, today.month, 1)
        try:
            year_text, month_text = str(month).split("-", 1)
            year = int(year_text)
            month_number = int(month_text)
            if month_number < 1 or month_number > 12:
                raise ValueError
            return date(year, month_number, 1)
        except (TypeError, ValueError):
            raise ValueError("month 必须为 YYYY-MM")

    @staticmethod
    def _month_bounds(month_start: date) -> Tuple[datetime, datetime]:
        if month_start.month == 12:
            next_month = date(month_start.year + 1, 1, 1)
        else:
            next_month = date(month_start.year, month_start.month + 1, 1)
        start = timezone.make_aware(datetime.combine(month_start, datetime.min.time()))
        end = timezone.make_aware(datetime.combine(next_month, datetime.min.time()))
        return start, end

    @classmethod
    def _build_llm_usage(cls, organization_id: str, start: datetime, end: datetime) -> Dict[str, Any]:
        llm_filter = Q()
        for prefix in cls.LLM_METER_PREFIXES:
            llm_filter |= Q(meter_key__startswith=prefix)
        llm_filter |= Q(provider_key__gt="")
        llm_filter |= Q(model_name__gt="")

        qs = BillingUsageEvent.objects.filter(
            organization_id=organization_id,
            occurred_at__gte=start,
            occurred_at__lt=end,
        ).filter(llm_filter)
        totals = qs.aggregate(
            event_count=Count("id"),
            total_tokens=Sum("quantity"),
            total_credits=Sum("amount"),
        )
        by_status = {
            row["charge_status"]: {
                "event_count": int(row["event_count"] or 0),
                "credits": str(row["credits"] or Decimal("0")),
            }
            for row in qs.values("charge_status").annotate(event_count=Count("id"), credits=Sum("amount"))
        }
        by_model = [
            {
                "provider_key": row["provider_key"] or "",
                "model_name": row["model_name"] or "",
                "event_count": int(row["event_count"] or 0),
                "tokens": str(row["tokens"] or Decimal("0")),
                "credits": str(row["credits"] or Decimal("0")),
            }
            for row in qs.values("provider_key", "model_name")
            .annotate(event_count=Count("id"), tokens=Sum("quantity"), credits=Sum("amount"))
            .order_by("-credits")[:20]
        ]
        return {
            "event_count": int(totals["event_count"] or 0),
            "total_tokens": str(totals["total_tokens"] or Decimal("0")),
            "total_credits": str(totals["total_credits"] or Decimal("0")),
            "by_status": by_status,
            "by_model": by_model,
        }

    @staticmethod
    def _build_wallet_summary(organization_id: str, start: datetime, end: datetime) -> Dict[str, Any]:
        qs = WalletTransaction.objects.filter(
            created_at__gte=start,
            created_at__lt=end,
        ).filter(Q(organization_id=organization_id) | Q(organization_wallet__organization_id=organization_id))
        by_type = {
            row["transaction_type"]: {
                "count": int(row["count"] or 0),
                "amount": str(row["amount"] or Decimal("0")),
                "amount_precise": str(row["amount_precise"] or Decimal("0")),
            }
            for row in qs.values("transaction_type").annotate(
                count=Count("id"),
                amount=Sum("amount"),
                amount_precise=Sum("amount_precise"),
            )
        }
        return {
            "transaction_count": qs.count(),
            "by_type": by_type,
            "llm_wallet_charged_credits": str(by_type.get("consume", {}).get("amount_precise", "0")),
            "recharge_credits": str(by_type.get("recharge", {}).get("amount_precise", "0")),
            "refund_credits": str(by_type.get("refund", {}).get("amount_precise", "0")),
            "grant_credits": str(by_type.get("grant", {}).get("amount_precise", "0")),
        }

    @classmethod
    def _build_order_summary(cls, organization_id: str, start: datetime, end: datetime) -> Dict[str, Any]:
        qs = PaymentOrder.objects.filter(
            organization_id=organization_id,
            created_at__gte=start,
            created_at__lt=end,
            order_type__in=cls.ORDER_TYPES,
        )
        paid_q = Q(status__in=["paid", "completed", "refunded", "partially_refunded"])
        by_type = {
            row["order_type"]: {
                "count": int(row["count"] or 0),
                "paid_count": int(row["paid_count"] or 0),
                "amount": str(row["amount"] or Decimal("0")),
                "paid_amount": str(row["paid_amount"] or Decimal("0")),
            }
            for row in qs.values("order_type").annotate(
                count=Count("id"),
                paid_count=Count("id", filter=paid_q),
                amount=Sum("amount"),
                paid_amount=Sum("paid_amount", filter=paid_q),
            )
        }
        return {
            "order_count": qs.count(),
            "by_type": by_type,
        }

    @staticmethod
    def _build_entitlement_summary(organization_id: str, month_start: date) -> Dict[str, Any]:
        snapshot = OrganizationBillingPolicyService.get_entitlement_snapshot(organization_id)
        budget = OrganizationLlmMonthlyBudget.objects.filter(
            organization_id=organization_id,
            cycle_month=month_start,
        ).first()
        storage_usage = OrganizationStorageUsage.objects.filter(organization_id=organization_id).first()
        return {
            "snapshot": cls_safe_json(snapshot),
            "llm_monthly_budget": {
                "included_credits": str(budget.included_credits) if budget else "0",
                "consumed_credits": str(budget.consumed_credits) if budget else "0",
                "remaining_credits": str(budget.remaining_credits) if budget else "0",
                "overflow_credits": str(budget.overflow_credits) if budget else "0",
            },
            "storage_usage": {
                "active_file_count": int(storage_usage.active_file_count or 0) if storage_usage else 0,
                "active_storage_bytes": int(storage_usage.active_storage_bytes or 0) if storage_usage else 0,
            },
        }

    @staticmethod
    def _build_legacy_invoice_summary(organization_id: str, start: datetime, end: datetime) -> Dict[str, Any]:
        qs = BillingInvoice.objects.filter(
            organization_id=organization_id,
            period_start__gte=start.date(),
            period_start__lt=end.date(),
        )
        by_status = {
            row["status"]: {
                "count": int(row["count"] or 0),
                "total_amount": str(row["total_amount"] or Decimal("0")),
            }
            for row in qs.values("status").annotate(count=Count("id"), total_amount=Sum("total_amount"))
        }
        return {
            "invoice_count": qs.count(),
            "total_amount": str(qs.aggregate(total=Sum("total_amount"))["total"] or Decimal("0")),
            "by_status": by_status,
            "note": "历史 invoice 仅用于只读展示，不作为自动或手动扣款入口。",
        }


def cls_safe_json(data: Dict[str, Any]) -> Dict[str, Any]:
    result: Dict[str, Any] = {}
    for key, value in (data or {}).items():
        if isinstance(value, Decimal):
            result[key] = str(value)
        elif isinstance(value, (datetime, date)):
            result[key] = value.isoformat()
        elif isinstance(value, dict):
            result[key] = cls_safe_json(value)
        elif isinstance(value, Iterable) and not isinstance(value, (str, bytes)):
            result[key] = [cls_safe_json(item) if isinstance(item, dict) else item for item in value]
        else:
            result[key] = value
    return result
