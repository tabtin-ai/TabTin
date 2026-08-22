"""
组织附件空间计量服务
"""

from __future__ import annotations

import logging
from datetime import date
from decimal import Decimal
from typing import Any, Dict, Optional

from ..api_utils import safe_decimal

from django.core.cache import cache
from django.db import transaction
from django.utils import timezone

from apps.services.billing.models import BillingUsageEvent, OrganizationStorageUsage
from apps.services.billing.services.policy_service import OrganizationBillingPolicyService
from apps.services.billing.services.pricing_service import MeterPricingService
from apps.services.billing.services.usage_service import BillingUsageService
from apps.services.billing.ws_events import publish_billing_event

logger = logging.getLogger(__name__)


def compute_storage_alert_level(usage_bytes: int, package_bytes: int) -> dict | None:
    """计算存储告警级别，供告警推送和外部模块复用。

    Returns:
        dict with 'level' and 'usage_percent', or None if below warning threshold (90%).
    """
    if package_bytes <= 0:
        return None
    usage_ratio = usage_bytes / package_bytes
    if usage_ratio >= 0.95:
        return {"level": "critical", "usage_percent": round(usage_ratio * 100)}
    if usage_ratio >= 0.90:
        return {"level": "warning", "usage_percent": round(usage_ratio * 100)}
    return None


def _check_and_publish_storage_alert(
    organization_id: str, after_bytes: int, package_bytes: int,
) -> None:
    """检测存储用量阈值并推送告警（transaction.on_commit 回调）。

    warning 级每天最多 1 次（dedup_ttl=86400），
    critical 级每 4 小时 1 次（dedup_ttl=14400）。
    critical 级别同时持久化 BillingAnomalyAlert。
    """
    try:
        alert = compute_storage_alert_level(after_bytes, package_bytes)
        if not alert:
            return

        level = alert["level"]
        dedup_key = f"storage_alert:{organization_id}:{level}:{date.today().isoformat()}"
        dedup_ttl = 14400 if level == "critical" else 86400

        if cache.get(dedup_key):
            return
        cache.set(dedup_key, "1", dedup_ttl)

        publish_billing_event(
            organization_id,
            f"storage_{level}",
            {
                "level": level,
                "usage_percent": alert["usage_percent"],
                "used_bytes": after_bytes,
                "package_bytes": package_bytes,
            },
        )

        if level == "critical":
            from apps.services.billing.models import BillingAnomalyAlert
            BillingAnomalyAlert.objects.get_or_create(
                organization_id=organization_id,
                alert_type="storage_critical",
                is_resolved=False,
                defaults={
                    "severity": "critical",
                    "metric_name": "storage_usage_ratio",
                    "current_value": Decimal(str(after_bytes)),
                    "baseline_value": Decimal(str(package_bytes)),
                    "threshold_ratio": Decimal("0.95"),
                    "message": (
                        f"存储用量超过 95%: organization={organization_id} "
                        f"used={after_bytes}B package={package_bytes}B "
                        f"usage={alert['usage_percent']}%"
                    ),
                },
            )
    except Exception as exc:
        logger.warning("存储告警检查失败（不影响主流程）: %s", exc)


def _check_and_publish_storage_resolved(
    organization_id: str, after_bytes: int, package_bytes: int,
) -> None:
    """检测存储用量恢复至 <80% 时推送 resolved 事件并自动 resolve 持久化告警。"""
    try:
        if package_bytes <= 0:
            return
        usage_ratio = after_bytes / package_bytes
        if usage_ratio >= 0.80:
            return

        dedup_key = f"storage_resolved:{organization_id}:{date.today().isoformat()}"
        if cache.get(dedup_key):
            return
        cache.set(dedup_key, "1", 3600)

        publish_billing_event(
            organization_id,
            "storage_resolved",
            {"usage_percent": round(usage_ratio * 100)},
        )

        from apps.services.billing.models import BillingAnomalyAlert
        BillingAnomalyAlert.objects.filter(
            organization_id=organization_id,
            alert_type__startswith="storage_",
            is_resolved=False,
        ).update(is_resolved=True, resolved_at=timezone.now())
    except Exception as exc:
        logger.warning("存储恢复检查失败: %s", exc)


def _invalidate_analytics_cache(organization_id: str) -> None:
    from apps.services.oss.services.analytics_cache import invalidate_safe
    invalidate_safe(organization_id)


class OrganizationStorageBillingService:
    """附件空间计量（按 organization 聚合）"""

    STORAGE_METER_KEY = "storage.bytes"
    STORAGE_GB_METER_KEY = "storage.gb"
    STORAGE_MB_BYTES = Decimal(1024 ** 2)
    STORAGE_GB_BYTES = Decimal(1024 ** 3)
    AMOUNT_QUANT = Decimal("0.00000001")

    @classmethod
    def _to_decimal(cls, value: int | float | Decimal | None) -> Decimal:
        return safe_decimal(value)

    @classmethod
    def evaluate_storage_upload(
        cls,
        *,
        organization_id: str,
        incoming_bytes: int,
    ) -> dict:
        usage = OrganizationStorageUsage.objects.filter(organization_id=organization_id).first()
        current_bytes = int(usage.active_storage_bytes or 0) if usage else 0
        return OrganizationBillingPolicyService.evaluate_storage_allocation(
            organization_id,
            current_storage_bytes=current_bytes,
            incoming_delta_bytes=int(incoming_bytes or 0),
        )

    @classmethod
    def assert_storage_upload_allowed(
        cls,
        *,
        organization_id: str,
        incoming_bytes: int,
    ) -> dict:
        from apps.services.billing.services.guard_service import BillingGuardService
        BillingGuardService.check_organization_billing_guard(organization_id, raise_on_block=True)

        decision = cls.evaluate_storage_upload(
            organization_id=organization_id,
            incoming_bytes=incoming_bytes,
        )
        package_bytes = int(decision["storage_package_bytes"])
        projected_bytes = int(decision["projected_storage_bytes"])
        entitlement_allowed = package_bytes < 0 or projected_bytes <= package_bytes
        decision = {**decision, "allowed": entitlement_allowed}
        if not entitlement_allowed:
            package_mb = Decimal(package_bytes) / cls.STORAGE_MB_BYTES
            projected_mb = Decimal(decision["projected_storage_bytes"]) / cls.STORAGE_MB_BYTES
            raise ValueError(
                f"附件空间不足：当前套餐剩余存储空间不足，请升级套餐或购买存储扩容包。"
                f"套餐容量 {package_mb.quantize(Decimal('0.01'))}MB，"
                f"本次后预计占用 {projected_mb.quantize(Decimal('0.01'))}MB。"
            )
        return decision

    @classmethod
    def _resolve_unit_price_per_byte(
        cls,
        *,
        organization_id: str,
    ) -> tuple[Decimal, str]:
        """
        解析 storage.bytes 的单价。
        优先读取 storage.bytes；未命中时回退 storage.gb 并自动折算为每字节价格。
        """
        unit_price = MeterPricingService.get_unit_price(
            cls.STORAGE_METER_KEY,
            organization_id=organization_id,
            default_price=None,
        )
        if unit_price is not None:
            return safe_decimal(unit_price), cls.STORAGE_METER_KEY

        gb_price = MeterPricingService.get_unit_price(
            cls.STORAGE_GB_METER_KEY,
            organization_id=organization_id,
            default_price=None,
        )
        if gb_price is None:
            logger.warning("存储定价未配置: organization=%s, 回退零值", organization_id)
            try:
                from apps.services.billing.models import BillingAnomalyAlert
                BillingAnomalyAlert.objects.get_or_create(
                    organization_id=organization_id,
                    alert_type="storage_no_price",
                    is_resolved=False,
                    defaults={
                        "severity": "warning",
                        "metric_name": "storage_unit_price",
                        "current_value": Decimal("0"),
                        "baseline_value": Decimal("0"),
                        "threshold_ratio": Decimal("0"),
                        "message": f"存储定价未配置: organization={organization_id}，"
                                   f"storage.bytes 和 storage.gb 均未找到有效价格，回退零值",
                    },
                )
            except Exception as exc:
                logger.debug("存储定价告警写入失败（不影响主流程）: %s", exc)
            return Decimal("0"), ""
        return (safe_decimal(gb_price) / cls.STORAGE_GB_BYTES), cls.STORAGE_GB_METER_KEY

    @classmethod
    @transaction.atomic
    def apply_storage_delta(
        cls,
        *,
        organization_id: str,
        file_id: str,
        delta_bytes: int,
        user_id: Optional[str] = None,
        biz_type: str = "attachment_storage",
        biz_id: str = "",
        metadata: Optional[Dict[str, Any]] = None,
        idempotency_key: str = "",
    ) -> OrganizationStorageUsage:
        """
        更新空间快照并写入 usage_event。

        注意：
        - `delta_bytes > 0` 表示新增占用
        - `delta_bytes < 0` 表示释放占用
        - 会自动兜底避免 active_storage_bytes 变负数
        """
        if not organization_id:
            raise ValueError("organization_id 不能为空")
        if not file_id:
            raise ValueError("file_id 不能为空")
        if delta_bytes == 0:
            usage, _ = OrganizationStorageUsage.objects.get_or_create(
                organization_id=organization_id,
                defaults={
                    "active_file_count": 0,
                    "active_storage_bytes": 0,
                    "total_uploaded_bytes": 0,
                    "total_released_bytes": 0,
                },
            )
            return usage

        usage, _ = OrganizationStorageUsage.objects.select_for_update().get_or_create(
            organization_id=organization_id,
            defaults={
                "active_file_count": 0,
                "active_storage_bytes": 0,
                "total_uploaded_bytes": 0,
                "total_released_bytes": 0,
            },
        )

        # 持锁期间做幂等检查，避免 TOCTOU 竞态（方案 2.5 + 8.2）
        idem_key = idempotency_key or f"storage:{organization_id}:{file_id}:{delta_bytes}:{biz_type}"
        if BillingUsageEvent.objects.filter(idempotency_key=idem_key).exists():
            logger.debug("storage delta idempotency hit (under lock): %s", idem_key)
            return usage

        before_bytes = int(usage.active_storage_bytes or 0)
        target_bytes = before_bytes + int(delta_bytes)
        after_bytes = max(0, target_bytes)
        actual_delta_bytes = after_bytes - before_bytes

        if actual_delta_bytes == 0:
            usage.last_metered_at = timezone.now()
            usage.save(update_fields=["last_metered_at", "updated_at"])
            return usage

        if actual_delta_bytes > 0:
            usage.active_file_count = max(0, int(usage.active_file_count or 0) + 1)
            usage.total_uploaded_bytes = int(usage.total_uploaded_bytes or 0) + actual_delta_bytes
        else:
            usage.active_file_count = max(0, int(usage.active_file_count or 0) - 1)
            usage.total_released_bytes = int(usage.total_released_bytes or 0) + abs(actual_delta_bytes)

        usage.active_storage_bytes = after_bytes
        usage.last_metered_at = timezone.now()
        usage.save(
            update_fields=[
                "active_file_count",
                "active_storage_bytes",
                "total_uploaded_bytes",
                "total_released_bytes",
                "last_metered_at",
                "updated_at",
            ]
        )

        billing_decision = OrganizationBillingPolicyService.evaluate_storage_allocation(
            organization_id,
            current_storage_bytes=before_bytes,
            incoming_delta_bytes=actual_delta_bytes,
        )

        unit_price_per_byte, price_source = cls._resolve_unit_price_per_byte(organization_id=organization_id)
        quantity = cls._to_decimal(actual_delta_bytes)
        billable_delta_bytes = cls._to_decimal(billing_decision["billable_delta_bytes"])
        amount = (billable_delta_bytes * unit_price_per_byte).quantize(cls.AMOUNT_QUANT)

        BillingUsageService.record_event(
            organization_id=organization_id,
            user_id=user_id or "",
            meter_key=cls.STORAGE_METER_KEY,
            quantity=quantity,
            unit="bytes",
            unit_price=unit_price_per_byte,
            amount=amount,
            currency="CREDITS",
            biz_type=biz_type,
            biz_id=biz_id or file_id,
            idempotency_key=idem_key,
            charge_status="pending",
            metadata={
                "file_id": file_id,
                "delta_bytes": actual_delta_bytes,
                "billable_delta_bytes": int(billing_decision["billable_delta_bytes"]),
                "active_storage_bytes": usage.active_storage_bytes,
                "storage_package_bytes": int(billing_decision["storage_package_bytes"]),
                "storage_billing_mode": billing_decision["storage_billing_mode"],
                "projected_exceeded_bytes": int(billing_decision["projected_exceeded_bytes"]),
                "price_source_meter": price_source,
                **(metadata or {}),
            },
        )

        _wt_id = organization_id
        transaction.on_commit(lambda: _invalidate_analytics_cache(_wt_id))

        _after = after_bytes
        _pkg = int(billing_decision["storage_package_bytes"])
        if actual_delta_bytes > 0:
            transaction.on_commit(
                lambda: _check_and_publish_storage_alert(_wt_id, _after, _pkg)
            )
        elif actual_delta_bytes < 0:
            transaction.on_commit(
                lambda: _check_and_publish_storage_resolved(_wt_id, _after, _pkg)
            )

        return usage

    @classmethod
    @transaction.atomic
    def reconcile_organization_storage(cls, organization_id: str) -> Dict[str, Any]:
        """基于 FileRecord 全量校准 OrganizationStorageUsage 快照。

        先对 OrganizationStorageUsage 加行锁，再在持锁期间聚合存储量，
        确保聚合与快照更新在同一时间窗口内，避免与 apply_storage_delta 产生竞态。

        XC-30: 使用 FileUsage(is_active=True) 关联 FileRecord 聚合，
        而非直接按 FileRecord(status='completed')。后者会把已 deactivate 但
        status 仍为 completed 的文件重新计入，导致修复工具反向膨胀计量。

        Returns:
            dict 包含 corrected (bool)、before/after 快照值、聚合值。
        """
        from apps.services.oss.models import FileRecord, FileUsage
        from django.db.models import Sum, Count

        def _aggregate_active_storage(ws_id: str) -> dict:
            """以 FileUsage(is_active=True) 为真实来源聚合 organization 存储量。

            按 file_record_id 去重后聚合，避免同一文件被多条 usage
            引用时字节重复计入。
            """
            active_file_ids = (
                FileUsage.objects.filter(
                    file_record__organization_id=ws_id,
                    file_record__status='completed',
                    is_active=True,
                )
                .values_list("file_record_id", flat=True)
                .distinct()
            )
            return FileRecord.objects.filter(
                id__in=active_file_ids,
            ).aggregate(
                real_bytes=Sum("file_size"),
                real_count=Count("id"),
            )

        usage = (
            OrganizationStorageUsage.objects
            .select_for_update()
            .filter(organization_id=organization_id)
            .first()
        )
        if not usage:
            agg = _aggregate_active_storage(organization_id)
            return {
                "organization_id": organization_id,
                "corrected": False,
                "reason": "no_snapshot",
                "real_bytes": int(agg["real_bytes"] or 0),
                "real_count": int(agg["real_count"] or 0),
            }

        agg = _aggregate_active_storage(organization_id)
        real_bytes = int(agg["real_bytes"] or 0)
        real_count = int(agg["real_count"] or 0)

        snapshot_bytes = int(usage.active_storage_bytes or 0)
        snapshot_count = int(usage.active_file_count or 0)
        drift_bytes = abs(real_bytes - snapshot_bytes)
        drift_count = abs(real_count - snapshot_count)

        result: Dict[str, Any] = {
            "organization_id": organization_id,
            "snapshot_bytes": snapshot_bytes,
            "snapshot_count": snapshot_count,
            "real_bytes": real_bytes,
            "real_count": real_count,
            "drift_bytes": drift_bytes,
            "drift_count": drift_count,
        }

        if drift_bytes == 0 and drift_count == 0:
            result["corrected"] = False
            result["reason"] = "no_drift"
            return result

        usage.active_storage_bytes = real_bytes
        usage.active_file_count = real_count

        drift_signed = real_bytes - snapshot_bytes
        if drift_signed > 0:
            usage.total_uploaded_bytes = int(usage.total_uploaded_bytes or 0) + drift_signed
        elif drift_signed < 0:
            usage.total_released_bytes = int(usage.total_released_bytes or 0) + abs(drift_signed)

        usage.save(update_fields=[
            "active_storage_bytes", "active_file_count",
            "total_uploaded_bytes", "total_released_bytes",
            "updated_at",
        ])
        result["corrected"] = True

        _wt_id = organization_id
        transaction.on_commit(lambda: _invalidate_analytics_cache(_wt_id))

        return result
