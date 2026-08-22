"""
组织计费结算服务（日聚合 + 月结账单）
"""

from __future__ import annotations

import logging
import uuid
from calendar import monthrange
from datetime import date, datetime, time, timedelta
from decimal import Decimal
from typing import Dict, Iterable, List, Tuple

from django.db import transaction
from django.db.models import Count, Sum
from django.utils import timezone

from apps.i18n import _
from apps.services.billing.constants import BILLING_TZ

from apps.services.billing.models import (
    BillingInvoice,
    BillingInvoiceLine,
    BillingUsageDaily,
    BillingUsageEvent,
    OrganizationStorageUsage,
)
from apps.services.billing.services.policy_service import OrganizationBillingPolicyService
from apps.services.billing.services.pricing_service import MeterPricingService

logger = logging.getLogger(__name__)


class BillingSettlementService:
    """organization 级结算器"""

    EXCLUDED_BIZ_TYPES = frozenset({"charge_failed", "charge_skipped", "charge_reversed"})
    AMOUNT_QUANT = Decimal("0.00000001")
    GB_BYTES = Decimal(1024 ** 3)

    @classmethod
    def _to_decimal(cls, value) -> Decimal:
        return Decimal(str(value or 0))

    @classmethod
    def _quantize(cls, value) -> Decimal:
        return cls._to_decimal(value).quantize(cls.AMOUNT_QUANT)

    @staticmethod
    def _month_range(year: int, month: int) -> Tuple[date, date]:
        _, max_day = monthrange(year, month)
        return date(year, month, 1), date(year, month, max_day)

    @staticmethod
    def _iter_days(start_date: date, end_date: date) -> Iterable[date]:
        cursor = start_date
        while cursor <= end_date:
            yield cursor
            cursor += timedelta(days=1)

    @staticmethod
    def _day_window(usage_date: date) -> Tuple[datetime, datetime]:
        start_dt = datetime.combine(usage_date, time.min, tzinfo=BILLING_TZ)
        end_dt = start_dt + timedelta(days=1)
        return start_dt, end_dt

    @classmethod
    def _resolve_storage_gb_day_price(
        cls,
        organization_id: str,
        *,
        at_time=None,
    ) -> Tuple[Decimal, str]:
        price = MeterPricingService.get_unit_price(
            "storage.gb_day",
            organization_id=organization_id,
            at_time=at_time,
            default_price=None,
        )
        if price is not None:
            return cls._to_decimal(price), "storage.gb_day"

        gb_price = MeterPricingService.get_unit_price(
            "storage.gb",
            organization_id=organization_id,
            at_time=at_time,
            default_price=None,
        )
        if gb_price is not None:
            return cls._to_decimal(gb_price), "storage.gb"

        byte_price = MeterPricingService.get_unit_price(
            "storage.bytes",
            organization_id=organization_id,
            at_time=at_time,
            default_price=None,
        )
        if byte_price is not None:
            return cls._to_decimal(byte_price) * cls.GB_BYTES, "storage.bytes"

        return Decimal("0"), ""

    @classmethod
    def _calc_storage_active_bytes_end_of_day(cls, organization_id: str, usage_date: date) -> int:
        """获取指定日期的日末存储字节数。

        优先级：
        1. DB 日末快照（eod_snapshot_date 匹配时使用，方案 2.7 + 8.11）
        2. 已持久化的 BillingUsageDaily 记录（历史日期）
        3. 实时快照（兜底）
        """
        today = timezone.now().astimezone(BILLING_TZ).date()
        yesterday = today - timedelta(days=1)

        # 优先读取 DB 日末快照
        usage = OrganizationStorageUsage.objects.filter(organization_id=organization_id).first()
        if usage and usage.eod_snapshot_date == usage_date:
            return max(0, int(usage.eod_snapshot_bytes or 0))

        if usage_date < yesterday:
            daily = BillingUsageDaily.objects.filter(
                organization_id=organization_id,
                usage_date=usage_date,
                meter_key="storage.gb_day",
            ).first()
            if daily and daily.extra:
                stored = daily.extra.get("active_storage_bytes")
                if stored is not None:
                    return max(0, int(stored))

        if usage:
            return max(0, int(usage.active_storage_bytes or 0))
        return 0

    @classmethod
    def aggregate_daily_usage(
        cls,
        *,
        organization_id: str,
        usage_date: date,
        persist: bool = True,
    ) -> Dict:
        start_dt, end_dt = cls._day_window(usage_date)
        rows: List[Dict] = []
        bulk_objs: List[BillingUsageDaily] = []
        now = timezone.now()

        # 查询被排除的异常事件统计（便于对账）
        excluded_stats = BillingUsageEvent.objects.filter(
            organization_id=organization_id,
            occurred_at__gte=start_dt,
            occurred_at__lt=end_dt,
            biz_type__in=cls.EXCLUDED_BIZ_TYPES,
        ).aggregate(
            excluded_count=Count("id"),
            excluded_amount=Sum("amount"),
        )
        excluded_info = {
            "excluded_event_count": excluded_stats["excluded_count"] or 0,
            "excluded_amount": str(cls._quantize(excluded_stats["excluded_amount"])),
        }

        _SETTLED_STATUSES = ["charged", "aggregated"]
        grouped = (
            BillingUsageEvent.objects.filter(
                organization_id=organization_id,
                occurred_at__gte=start_dt,
                occurred_at__lt=end_dt,
                charge_status__in=_SETTLED_STATUSES,
            )
            .exclude(biz_type__in=cls.EXCLUDED_BIZ_TYPES)
            .values("meter_key", "currency")
            .annotate(
                total_quantity=Sum("quantity"),
                total_amount=Sum("amount"),
                event_count=Count("id"),
            )
        )

        for item in grouped:
            meter_key = item["meter_key"]
            currency = item["currency"] or "CREDITS"
            quantity = cls._quantize(item.get("total_quantity"))
            amount = cls._quantize(item.get("total_amount"))
            event_count = int(item.get("event_count") or 0)

            if persist:
                bulk_objs.append(BillingUsageDaily(
                    organization_id=organization_id,
                    usage_date=usage_date,
                    meter_key=meter_key,
                    quantity=quantity,
                    amount=amount,
                    currency=currency,
                    source_event_count=event_count,
                    extra={**excluded_info},
                    generated_at=now,
                ))
            rows.append(
                {
                    "meter_key": meter_key,
                    "quantity": str(quantity),
                    "amount": str(amount),
                    "currency": currency,
                    "source_event_count": event_count,
                }
            )

        # storage.gb_day 合成已停用；这里只保留日用量报表聚合。
        if persist and bulk_objs:
            BillingUsageDaily.objects.bulk_create(
                bulk_objs,
                update_conflicts=True,
                unique_fields=["organization_id", "usage_date", "meter_key"],
                update_fields=["quantity", "amount", "currency", "source_event_count", "extra", "generated_at"],
            )

        return {
            "organization_id": organization_id,
            "usage_date": usage_date.isoformat(),
            "rows": rows,
        }

    @classmethod
    def aggregate_daily_usage_range(
        cls,
        *,
        organization_id: str,
        start_date: date,
        end_date: date,
        persist: bool = True,
    ) -> Dict:
        days = list(cls._iter_days(start_date, end_date))
        aggregated = [
            cls.aggregate_daily_usage(
                organization_id=organization_id,
                usage_date=day,
                persist=persist,
            )
            for day in days
        ]
        return {
            "organization_id": organization_id,
            "start_date": start_date.isoformat(),
            "end_date": end_date.isoformat(),
            "day_count": len(days),
            "days": aggregated,
        }

    @classmethod
    def _build_invoice_no(cls, organization_id: str, period_start: date) -> str:
        organization_suffix = (organization_id or "ws")[-6:].upper()
        return f"INV-{period_start.strftime('%Y%m')}-{organization_suffix}-{uuid.uuid4().hex[:6].upper()}"

    @classmethod
    def _upsert_invoice_line(
        cls,
        *,
        invoice: BillingInvoice,
        meter_key: str,
        description: str,
        quantity: Decimal,
        unit: str,
        unit_price: Decimal,
        amount: Decimal,
        metadata: Dict,
    ) -> BillingInvoiceLine:
        return BillingInvoiceLine.objects.create(
            invoice=invoice,
            organization_id=invoice.organization_id,
            meter_key=meter_key,
            description=description,
            quantity=cls._quantize(quantity),
            unit=unit,
            unit_price=cls._quantize(unit_price),
            amount=cls._quantize(amount),
            metadata=metadata or {},
        )

    @classmethod
    def _aggregate_llm_token_breakdown(
        cls,
        organization_id: str,
        period_start: date,
        period_end: date,
    ) -> Dict:
        """从 BillingUsageEvent metadata 中聚合 input/output token 分项及加权均价。

        除 token 计数外，还计算输入/输出 token 的加权平均单价，供账单行 metadata
        展示，使用户能理解 blended unit_price 的构成（XM-19）。
        """
        start_dt = datetime.combine(period_start, time.min, tzinfo=BILLING_TZ)
        end_dt = datetime.combine(period_end + timedelta(days=1), time.min, tzinfo=BILLING_TZ)

        events = BillingUsageEvent.objects.filter(
            organization_id=organization_id,
            meter_key="llm.tokens",
            occurred_at__gte=start_dt,
            occurred_at__lt=end_dt,
        ).exclude(
            biz_type__in=cls.EXCLUDED_BIZ_TYPES,
        ).values_list("metadata", "amount")

        total_input_tokens = 0
        total_output_tokens = 0
        # 加权累计（用于计算 token 种类各自的加权均价）
        weighted_input_price_sum = Decimal("0")
        weighted_output_price_sum = Decimal("0")
        has_price_data = False

        for meta, _amount in events:
            if not isinstance(meta, dict):
                continue
            inp = int(meta.get("input_tokens") or 0)
            out = int(meta.get("output_tokens") or 0)
            total_input_tokens += inp
            total_output_tokens += out
            try:
                ip = Decimal(str(meta.get("input_price_per_1k") or 0))
                op = Decimal(str(meta.get("output_price_per_1k") or 0))
                if ip > 0 or op > 0:
                    has_price_data = True
                weighted_input_price_sum += Decimal(inp) * ip
                weighted_output_price_sum += Decimal(out) * op
            except Exception:
                pass

        result: Dict = {
            "input_tokens": total_input_tokens,
            "output_tokens": total_output_tokens,
        }

        # 仅当存在价格数据时才输出均价字段，避免全零值误导前端展示
        if has_price_data:
            quant = Decimal("0.00000001")
            if total_input_tokens > 0:
                result["input_price_per_1k_avg"] = str(
                    (weighted_input_price_sum / Decimal(total_input_tokens))
                    .quantize(quant)
                )
            if total_output_tokens > 0:
                result["output_price_per_1k_avg"] = str(
                    (weighted_output_price_sum / Decimal(total_output_tokens))
                    .quantize(quant)
                )

        return result

    # 与 cleanup_old_usage_events 保持一致的保留天数默认值
    _DEFAULT_EVENT_RETENTION_DAYS = 365
    # 在事件保留截止前留出安全缓冲，避免恰好在清理窗口内的月份被误判
    _RETENTION_SAFETY_MARGIN_DAYS = 7

    @classmethod
    def _safe_aggregate_period(
        cls,
        *,
        organization_id: str,
        period_start: date,
        period_end: date,
    ) -> None:
        """聚合月结算数据，对历史期间做事件可用性保护 (INV-A13-007)。

        若账期距今超过事件保留天数（减去安全缓冲），且该期间内已无 BillingUsageEvent
        但已有 BillingUsageDaily 记录，则跳过重聚合，避免用全零数据覆盖有效历史记录。
        """
        from django.conf import settings as _settings

        retention_days = getattr(
            _settings, "BILLING_USAGE_EVENT_RETENTION_DAYS", cls._DEFAULT_EVENT_RETENTION_DAYS
        )
        threshold_days = retention_days - cls._RETENTION_SAFETY_MARGIN_DAYS
        today = timezone.now().astimezone(BILLING_TZ).date()
        period_age_days = (today - period_start).days

        if period_age_days <= threshold_days:
            # 在保留期安全窗口内，正常重聚合
            cls.aggregate_daily_usage_range(
                organization_id=organization_id,
                start_date=period_start,
                end_date=period_end,
                persist=True,
            )
            return

        # 账期超出安全窗口 — 检查原始事件是否仍然存在
        start_dt = datetime.combine(period_start, time.min, tzinfo=BILLING_TZ)
        end_dt = datetime.combine(period_end + timedelta(days=1), time.min, tzinfo=BILLING_TZ)
        has_events = BillingUsageEvent.objects.filter(
            organization_id=organization_id,
            occurred_at__gte=start_dt,
            occurred_at__lt=end_dt,
        ).exists()

        if has_events:
            cls.aggregate_daily_usage_range(
                organization_id=organization_id,
                start_date=period_start,
                end_date=period_end,
                persist=True,
            )
        else:
            existing_count = BillingUsageDaily.objects.filter(
                organization_id=organization_id,
                usage_date__gte=period_start,
                usage_date__lte=period_end,
            ).count()
            logger.warning(
                "[Settlement] 跳过历史月份重聚合（原始事件已被清理）: "
                "organization=%s period=%s/%s age_days=%d existing_daily=%d",
                organization_id, period_start, period_end, period_age_days, existing_count,
            )

    @classmethod
    def generate_monthly_invoice(
        cls,
        *,
        organization_id: str,
        year: int,
        month: int,
        overwrite_draft: bool = True,
    ) -> BillingInvoice:
        period_start, period_end = cls._month_range(year, month)

        # 快速跳过已完成的 invoice，避免无谓的重聚合 (P1-4)
        existing = BillingInvoice.objects.filter(
            organization_id=organization_id,
            period_start=period_start,
            period_end=period_end,
        ).exclude(status="draft").first()
        if existing:
            return existing

        # 聚合在事务外执行，避免长事务持锁阻塞并发日结算 (INV-A13-002)
        # 历史月份先检查事件可用性，防止清理后重聚合归零 (INV-A13-007)
        cls._safe_aggregate_period(
            organization_id=organization_id,
            period_start=period_start,
            period_end=period_end,
        )

        return cls._build_invoice_within_txn(
            organization_id=organization_id,
            period_start=period_start,
            period_end=period_end,
            overwrite_draft=overwrite_draft,
        )

    @classmethod
    @transaction.atomic
    def _build_invoice_within_txn(
        cls,
        *,
        organization_id: str,
        period_start: date,
        period_end: date,
        overwrite_draft: bool,
    ) -> BillingInvoice:
        invoice = (
            BillingInvoice.objects.select_for_update()
            .filter(
                organization_id=organization_id,
                period_start=period_start,
                period_end=period_end,
            )
            .first()
        )
        if invoice and invoice.status != "draft":
            return invoice
        if invoice and not overwrite_draft:
            return invoice

        if not invoice:
            invoice = BillingInvoice.objects.create(
                invoice_no=cls._build_invoice_no(organization_id, period_start),
                organization_id=organization_id,
                period_start=period_start,
                period_end=period_end,
                status="draft",
                currency="CREDITS",
            )
        else:
            BillingInvoiceLine.objects.filter(invoice=invoice).delete()

        usage_qs = BillingUsageDaily.objects.filter(
            organization_id=organization_id,
            usage_date__gte=period_start,
            usage_date__lte=period_end,
        )
        policy = OrganizationBillingPolicyService.get_effective_policy(organization_id)
        entitlement = OrganizationBillingPolicyService.get_entitlement_snapshot(organization_id)

        subtotal = cls._quantize(0)

        # 折扣：优先从 policy.metadata["discount_credits"] 读取 (INV-A13-006)
        # 支持促销/会员抵扣等场景，0 为无折扣默认值
        discount = cls._quantize(
            (policy.get("metadata") or {}).get("discount_credits", 0)
        )

        llm_agg = usage_qs.filter(meter_key="llm.tokens").aggregate(
            total_quantity=Sum("quantity"),
            total_amount=Sum("amount"),
        )
        llm_tokens = cls._quantize(llm_agg.get("total_quantity"))
        llm_raw_amount = cls._quantize(llm_agg.get("total_amount"))

        llm_mode = policy["llm_billing_mode"]
        included_llm_credits = cls._quantize(entitlement["included_llm_credits_monthly"])
        llm_unit_price = cls._quantize(llm_raw_amount / llm_tokens) if llm_tokens > 0 else cls._quantize(0)

        llm_breakdown = cls._aggregate_llm_token_breakdown(
            organization_id, period_start, period_end,
        )

        cls._upsert_invoice_line(
            invoice=invoice,
            meter_key="llm.tokens",
            description="billing.invoice_line.llm_tokens",
            quantity=llm_tokens,
            unit="tokens",
            unit_price=llm_unit_price,
            amount=llm_raw_amount,
            metadata={
                "llm_billing_mode": llm_mode,
                "included_llm_credits_monthly": str(included_llm_credits),
                "amount_semantics": "paygo_charged",
                "unit_price_note": "paygo_blended_average_all_tokens",
                **llm_breakdown,
            },
        )
        subtotal = cls._quantize(subtotal + llm_raw_amount)


        # W3-3: storage 统一到 storage.bytes 事件体系，由 hourly 聚合扣款。
        # storage.bytes 的 BillingUsageDaily 金额走 other_rows，
        # hourly 聚合产生的 WalletTransaction 已完成实际扣款。
        # storage.gb_day 合成行已停用，无需独立处理。

        other_rows = (
            usage_qs.exclude(meter_key__in=["llm.tokens"])
            .values("meter_key")
            .annotate(
                total_quantity=Sum("quantity"),
                total_amount=Sum("amount"),
            )
        )
        for row in other_rows:
            meter_key = row["meter_key"]
            quantity = cls._quantize(row.get("total_quantity"))
            amount = cls._quantize(row.get("total_amount"))
            if amount == 0 and quantity == 0:
                continue
            unit_price = cls._quantize(amount / quantity) if quantity != 0 else cls._quantize(0)
            cls._upsert_invoice_line(
                invoice=invoice,
                meter_key=meter_key,
                description=f"billing.invoice_line.other_meter:{meter_key}",
                quantity=quantity,
                unit="unit",
                unit_price=unit_price,
                amount=amount,
                metadata={},
            )
            subtotal = cls._quantize(subtotal + amount)

        # 折扣不能超出小计（防止负数账单）
        if discount > subtotal:
            discount = subtotal
        total = cls._quantize(subtotal - discount)
        if total < 0:
            total = cls._quantize(0)

        invoice.currency = policy.get("currency") or "CREDITS"
        invoice.subtotal_amount = subtotal
        invoice.discount_amount = discount
        invoice.total_amount = total
        invoice.status = "open" if total > 0 else "paid"
        invoice.issued_at = timezone.now()
        invoice.metadata = {
            "policy": policy,
            "entitlement": {
                "included_storage_bytes": int(entitlement["included_storage_bytes"]),
                "purchased_storage_bytes": int(entitlement["purchased_storage_bytes"]),
                "storage_package_bytes": int(entitlement["storage_package_bytes"]),
                "included_llm_credits_monthly": str(included_llm_credits),
            },
            "generated_at": timezone.now().isoformat(),
        }
        invoice.save(
            update_fields=[
                "currency",
                "subtotal_amount",
                "discount_amount",
                "total_amount",
                "status",
                "issued_at",
                "metadata",
                "updated_at",
            ]
        )
        return invoice
