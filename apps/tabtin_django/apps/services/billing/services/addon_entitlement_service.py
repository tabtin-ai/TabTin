"""Generic add-on entitlement service."""

from __future__ import annotations

import logging
from typing import Any, Dict

from dateutil.relativedelta import relativedelta
from django.db import transaction
from django.db.models import Sum
from django.utils import timezone

from apps.services.billing.models import AddonPackage, OrganizationAddonEntitlement

logger = logging.getLogger(__name__)


class AddonEntitlementService:
    """Catalog, grant and aggregate generic add-on entitlements."""

    @classmethod
    def list_packages(cls, *, active_only: bool = True):
        queryset = AddonPackage.objects.all()
        if active_only:
            queryset = queryset.filter(is_active=True)
        return queryset.order_by("sort_order", "-created_at")

    @classmethod
    def get_active_addons(cls, organization_id: str, *, at_time=None):
        now = at_time or timezone.now()
        return OrganizationAddonEntitlement.objects.filter(
            organization_id=organization_id,
            status="active",
            starts_at__lte=now,
            expires_at__gt=now,
        ).select_related("addon_package")

    @classmethod
    def get_addon_quota(cls, organization_id: str, quota_key: str, *, at_time=None) -> int:
        result = cls.get_active_addons(organization_id, at_time=at_time).filter(
            quota_key=quota_key,
        ).aggregate(total=Sum("quota_value"))
        return int(result.get("total") or 0)

    @classmethod
    def get_addon_quotas(cls, organization_id: str, *, at_time=None) -> Dict[str, int]:
        quotas: Dict[str, int] = {}
        for row in (
            cls.get_active_addons(organization_id, at_time=at_time)
            .values("quota_key")
            .annotate(total=Sum("quota_value"))
        ):
            quotas[str(row["quota_key"])] = int(row["total"] or 0)
        return quotas

    @classmethod
    @transaction.atomic
    def grant_addon(
        cls,
        *,
        organization_id: str,
        addon_package_id: str,
        order_id: str = "",
        purchased_by: str = "",
        quota_key: str = "",
        quota_value: int | None = None,
        period_months: int | None = None,
        addon_code: str = "",
        addon_name: str = "",
        allow_inactive_package: bool = False,
    ) -> OrganizationAddonEntitlement:
        if not organization_id:
            raise ValueError("organization_id 不能为空")

        package_query = AddonPackage.objects.filter(id=addon_package_id)
        if not allow_inactive_package:
            package_query = package_query.filter(is_active=True)
        package = package_query.get()

        if order_id:
            existing = OrganizationAddonEntitlement.objects.filter(order_id=order_id).first()
            if existing:
                cls._sync_entitlement_metadata(organization_id)
                return existing

        now = timezone.now()
        effective_quota_key = quota_key or package.quota_key
        effective_quota_value = int(quota_value if quota_value is not None else package.quota_value)
        effective_period_months = int(period_months if period_months is not None else package.period_months)
        effective_addon_code = addon_code or package.addon_code
        effective_addon_name = addon_name or package.addon_name
        entitlement = OrganizationAddonEntitlement.objects.create(
            organization_id=organization_id,
            addon_package=package,
            order_id=order_id or None,
            quota_key=effective_quota_key,
            quota_value=effective_quota_value,
            starts_at=now,
            expires_at=now + relativedelta(months=effective_period_months),
            status="active",
            purchased_by=purchased_by or "",
            metadata={
                "addon_code": effective_addon_code,
                "addon_name": effective_addon_name,
                "period_months": effective_period_months,
                "source_package_id": str(package.id),
                "source_package_active": bool(package.is_active),
            },
        )

        cls._sync_entitlement_metadata(
            organization_id,
            metadata_updates={
                "last_addon_purchase_at": now.isoformat(),
                "last_addon_package_id": str(package.id),
                "last_addon_code": effective_addon_code,
                "last_addon_name": effective_addon_name,
            },
        )

        logger.info(
            "增值包权益发放成功: organization=%s addon=%s order=%s quota=%s:%s expires_at=%s",
            organization_id,
            package.id,
            order_id,
            effective_quota_key,
            effective_quota_value,
            entitlement.expires_at,
        )
        return entitlement

    @classmethod
    def grant_addon_from_order(cls, order_id: str) -> OrganizationAddonEntitlement:
        from apps.services.payment.models import PaymentOrder

        order = PaymentOrder.objects.select_related("user").get(id=order_id)
        data = order.business_data or {}
        organization_id = getattr(order, "organization_id", "") or data.get("organization_id", "")
        addon_package_id = data.get("addon_package_id")
        if not organization_id:
            raise ValueError("billing_addon 订单缺少 organization_id")
        if not addon_package_id:
            raise ValueError("billing_addon 订单缺少 addon_package_id")
        return cls.grant_addon(
            organization_id=organization_id,
            addon_package_id=str(addon_package_id),
            order_id=str(order.id),
            purchased_by=str(order.user_id),
            quota_key=str(data.get("quota_key") or ""),
            quota_value=int(data["quota_value"]) if data.get("quota_value") is not None else None,
            period_months=int(data["period_months"]) if data.get("period_months") is not None else None,
            addon_code=str(data.get("addon_code") or ""),
            addon_name=str(data.get("addon_name") or ""),
            allow_inactive_package=True,
        )

    @classmethod
    @transaction.atomic
    def expire_addons(cls, *, organization_id: str = "") -> Dict[str, Any]:
        now = timezone.now()
        queryset = OrganizationAddonEntitlement.objects.select_for_update().filter(
            status="active",
            expires_at__lte=now,
        )
        if organization_id:
            queryset = queryset.filter(organization_id=organization_id)

        entitlements = list(queryset)
        if not entitlements:
            return {"expired_count": 0, "organization_ids": []}

        organization_ids = sorted({ent.organization_id for ent in entitlements if ent.organization_id})
        expired_ids = []
        for entitlement in entitlements:
            entitlement.status = "expired"
            entitlement.save(update_fields=["status", "updated_at"])
            expired_ids.append(str(entitlement.id))

        for wt_id in organization_ids:
            cls._sync_entitlement_metadata(
                wt_id,
                metadata_updates={"last_addon_expire_at": now.isoformat()},
            )

        return {
            "expired_count": len(expired_ids),
            "expired_ids": expired_ids,
            "organization_ids": organization_ids,
        }

    @classmethod
    def _sync_entitlement_metadata(
        cls,
        organization_id: str,
        *,
        metadata_updates: Dict[str, Any] | None = None,
    ):
        from apps.services.billing.services.entitlement_service import OrganizationEntitlementSyncService

        addon_quotas = cls.get_addon_quotas(organization_id)
        OrganizationEntitlementSyncService.sync_organization_entitlement(
            organization_id,
            metadata_updates={
                "addon_quotas": addon_quotas,
                "addon_entitlement_count": sum(1 for _ in cls.get_active_addons(organization_id)),
                **(metadata_updates or {}),
            },
        )
