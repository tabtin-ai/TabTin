"""
organization entitlement 同步服务。

职责：
1. 统一计算 organization 当前应生效的基础权益（免费档 / 会员档）
2. 汇总存储加购包的有效容量
3. 将结果同步回 OrganizationBillingEntitlement，供计费、限额、前端展示共用
"""

from __future__ import annotations

import logging
from decimal import Decimal
from typing import Any, Dict, Optional

from django.core.cache import cache
from django.db import transaction
from django.db.utils import OperationalError, ProgrammingError
from django.db.models import Count, Max, Sum
from django.utils import timezone

from apps.services.billing.models import (
    OrganizationAddonEntitlement,
    OrganizationBillingEntitlement,
    OrganizationStorageSubscription,
)

logger = logging.getLogger(__name__)


class BillingProvisionHardFailure(RuntimeError):
    """不可通过简单重试自愈的 provision 失败。"""


class OrganizationEntitlementSyncService:
    """organization entitlement 真相源聚合服务。"""

    SUBSCRIPTION_BYTES_META_KEY = "storage_subscription_bytes"
    SUBSCRIPTION_COUNT_META_KEY = "storage_subscription_count"
    ADDON_STORAGE_BYTES_META_KEY = "active_addon_storage_bytes"
    MANUAL_PURCHASED_META_KEY = "manual_purchased_storage_bytes"
    MANUAL_INCLUDED_STORAGE_META_KEY = "manual_included_storage_bytes"
    MANUAL_INCLUDED_LLM_META_KEY = "manual_included_llm_credits_monthly"
    ENTITLEMENT_SOURCE_META_KEY = "entitlement_source"

    @staticmethod
    def _to_decimal(value: Any) -> Decimal:
        return Decimal(str(value or 0))

    @classmethod
    def _get_free_tier(cls):
        from apps.users.membership.models import MembershipTier

        return (
            MembershipTier.objects
            .filter(tier_type="free", is_active=True)
            .order_by("sort_order", "-created_at")
            .first()
        )

    @classmethod
    def _get_active_organization_membership(cls, organization_id: str, *, at_time=None):
        from apps.users.membership.models import OrganizationMembership

        if not organization_id:
            return None

        now = at_time or timezone.now()
        try:
            membership = (
                OrganizationMembership.objects
                .select_related("tier")
                .filter(
                    organization_id=organization_id,
                    status="active",
                    start_date__lte=now,
                    end_date__gt=now,
                )
                .order_by("-end_date", "-updated_at")
                .first()
            )
        except (OperationalError, ProgrammingError) as exc:
            raise BillingProvisionHardFailure(
                "membership schema is incompatible with organization entitlement sync; "
                "please apply membership migrations before provisioning billing"
            ) from exc
        return membership

    @classmethod
    def _get_base_tier_snapshot(cls, organization_id: str, *, at_time=None) -> Dict[str, Any]:
        now = at_time or timezone.now()
        membership = cls._get_active_organization_membership(organization_id, at_time=now)
        if membership and membership.tier:
            tier = membership.tier
            return {
                "tier": tier,
                "source": "organization_membership",
                "included_storage_bytes": int(tier.included_storage_bytes or 0),
                "included_llm_credits_monthly": cls._to_decimal(tier.included_llm_credits_monthly),
                "included_media_monthly": int(getattr(tier, "included_media_monthly", 0) or 0),
                "included_search_monthly": int(getattr(tier, "included_search_monthly", 0) or 0),
                "included_tts_monthly": int(getattr(tier, "included_tts_monthly", 0) or 0),
                "effective_to": membership.end_date,
            }

        free_tier = cls._get_free_tier()
        if free_tier:
            return {
                "tier": free_tier,
                "source": "free_tier",
                "included_storage_bytes": int(free_tier.included_storage_bytes or 0),
                "included_llm_credits_monthly": cls._to_decimal(free_tier.included_llm_credits_monthly),
                "included_media_monthly": int(getattr(free_tier, "included_media_monthly", 0) or 0),
                "included_search_monthly": int(getattr(free_tier, "included_search_monthly", 0) or 0),
                "included_tts_monthly": int(getattr(free_tier, "included_tts_monthly", 0) or 0),
                "effective_to": None,
            }

        return {
            "tier": None,
            "source": "default_zero",
            "included_storage_bytes": 0,
            "included_llm_credits_monthly": Decimal("0"),
            "included_media_monthly": 0,
            "included_search_monthly": 0,
            "included_tts_monthly": 0,
            "effective_to": None,
        }

    @classmethod
    def _get_active_subscription_stats(cls, organization_id: str, *, at_time=None) -> Dict[str, Any]:
        now = at_time or timezone.now()
        aggregated = (
            OrganizationStorageSubscription.objects.filter(
                organization_id=organization_id,
                status="active",
                start_at__lte=now,
                end_at__gt=now,
            )
            .aggregate(
                total_bytes=Sum("storage_bytes"),
                latest_end_at=Max("end_at"),
                total_count=Count("id"),
            )
        )
        return {
            "storage_bytes": int(aggregated.get("total_bytes") or 0),
            "subscription_count": int(aggregated.get("total_count") or 0),
            "latest_end_at": aggregated.get("latest_end_at"),
        }

    @classmethod
    def _get_active_addon_stats(cls, organization_id: str, *, at_time=None) -> Dict[str, Any]:
        now = at_time or timezone.now()
        queryset = OrganizationAddonEntitlement.objects.filter(
            organization_id=organization_id,
            status="active",
            starts_at__lte=now,
            expires_at__gt=now,
        )
        rows = queryset.values("quota_key").annotate(total=Sum("quota_value"))
        quotas = {str(row["quota_key"]): int(row["total"] or 0) for row in rows}
        aggregate = queryset.aggregate(latest_expires_at=Max("expires_at"), total_count=Count("id"))
        return {
            "quotas": quotas,
            "entitlement_count": int(aggregate.get("total_count") or 0),
            "latest_expires_at": aggregate.get("latest_expires_at"),
        }

    @classmethod
    def build_organization_entitlement_snapshot(
        cls,
        organization_id: str,
        *,
        at_time=None,
        clear_manual_overrides: bool = False,
        existing: Optional[OrganizationBillingEntitlement] = None,
    ) -> Dict[str, Any]:
        now = at_time or timezone.now()
        if existing is None:
            existing = OrganizationBillingEntitlement.objects.filter(organization_id=organization_id).first()
        existing_meta = dict(existing.metadata or {}) if existing else {}

        if clear_manual_overrides:
            existing_meta.pop(cls.MANUAL_INCLUDED_STORAGE_META_KEY, None)
            existing_meta.pop(cls.MANUAL_INCLUDED_LLM_META_KEY, None)

        stored_total_purchased = int(existing.purchased_storage_bytes or 0) if existing else 0
        stored_subscription_bytes = int(existing_meta.get(cls.SUBSCRIPTION_BYTES_META_KEY) or 0)
        stored_addon_storage_bytes = int(existing_meta.get(cls.ADDON_STORAGE_BYTES_META_KEY) or 0)
        manual_purchased_bytes = max(0, stored_total_purchased - stored_subscription_bytes - stored_addon_storage_bytes)

        base_snapshot = cls._get_base_tier_snapshot(organization_id, at_time=now)
        subscription_snapshot = cls._get_active_subscription_stats(organization_id, at_time=now)
        addon_snapshot = cls._get_active_addon_stats(organization_id, at_time=now)
        manual_included_storage_bytes = cls._resolve_manual_included_storage_bytes(existing, existing_meta)
        manual_included_llm_credits_monthly = cls._resolve_manual_included_llm_credits(existing, existing_meta)

        effective_included_storage_bytes = (
            manual_included_storage_bytes
            if manual_included_storage_bytes is not None
            else int(base_snapshot["included_storage_bytes"])
        )
        effective_included_llm_credits_monthly = (
            manual_included_llm_credits_monthly
            if manual_included_llm_credits_monthly is not None
            else cls._to_decimal(base_snapshot["included_llm_credits_monthly"])
        )

        addon_storage_bytes = int(addon_snapshot["quotas"].get("storage_quota_bytes") or 0)
        effective_purchased_bytes = (
            manual_purchased_bytes
            + int(subscription_snapshot["storage_bytes"])
            + addon_storage_bytes
        )

        effective_to_candidates = [
            candidate
            for candidate in (
                base_snapshot.get("effective_to"),
                subscription_snapshot.get("latest_end_at"),
                addon_snapshot.get("latest_expires_at"),
            )
            if candidate is not None
        ]
        effective_to = max(effective_to_candidates) if effective_to_candidates else None

        tier = base_snapshot.get("tier")
        metadata = {
            **existing_meta,
            cls.SUBSCRIPTION_BYTES_META_KEY: int(subscription_snapshot["storage_bytes"]),
            cls.SUBSCRIPTION_COUNT_META_KEY: int(subscription_snapshot["subscription_count"]),
            "addon_quotas": addon_snapshot["quotas"],
            "addon_entitlement_count": int(addon_snapshot["entitlement_count"]),
            cls.ADDON_STORAGE_BYTES_META_KEY: int(addon_snapshot["quotas"].get("storage_quota_bytes") or 0),
            cls.MANUAL_PURCHASED_META_KEY: int(manual_purchased_bytes),
            cls.ENTITLEMENT_SOURCE_META_KEY: base_snapshot["source"],
            "tier_id": str(tier.id) if tier else "",
            "tier_type": getattr(tier, "tier_type", ""),
            "tier_name": getattr(tier, "name", ""),
            "calculated_at": now.isoformat(),
        }
        if manual_included_storage_bytes is not None:
            metadata[cls.MANUAL_INCLUDED_STORAGE_META_KEY] = int(manual_included_storage_bytes)
        if manual_included_llm_credits_monthly is not None:
            metadata[cls.MANUAL_INCLUDED_LLM_META_KEY] = str(manual_included_llm_credits_monthly)

        return {
            "organization_id": organization_id,
            "included_storage_bytes": int(effective_included_storage_bytes),
            "purchased_storage_bytes": int(effective_purchased_bytes),
            "storage_package_bytes": int(effective_included_storage_bytes) + int(effective_purchased_bytes),
            "included_llm_credits_monthly": cls._to_decimal(effective_included_llm_credits_monthly),
            "included_media_monthly": int(base_snapshot["included_media_monthly"]),
            "included_search_monthly": int(base_snapshot["included_search_monthly"]),
            "included_tts_monthly": int(base_snapshot["included_tts_monthly"]),
            "manual_purchased_storage_bytes": int(manual_purchased_bytes),
            "active_subscription_storage_bytes": int(subscription_snapshot["storage_bytes"]),
            "active_addon_storage_bytes": addon_storage_bytes,
            "active_subscription_count": int(subscription_snapshot["subscription_count"]),
            "is_default": False,
            "metadata": metadata,
            "effective_from": existing.effective_from if existing else now,
            "effective_to": effective_to,
            "is_active": True,
            "updated_at": existing.updated_at if existing else None,
        }

    @classmethod
    @transaction.atomic
    def sync_organization_entitlement(
        cls,
        organization_id: str,
        *,
        at_time=None,
        metadata_updates: Optional[Dict[str, Any]] = None,
        clear_manual_overrides: bool = False,
    ) -> OrganizationBillingEntitlement:
        if not organization_id:
            raise ValueError("organization_id 不能为空")

        # 行锁：锁定现有行并传入 snapshot，防止并发 sync 各自基于旧快照计算并相互覆盖
        existing = (
            OrganizationBillingEntitlement.objects
            .select_for_update()
            .filter(organization_id=organization_id)
            .first()
        )

        snapshot = cls.build_organization_entitlement_snapshot(
            organization_id, at_time=at_time, clear_manual_overrides=clear_manual_overrides,
            existing=existing,
        )
        metadata = dict(snapshot["metadata"] or {})
        if clear_manual_overrides:
            metadata.pop(cls.MANUAL_INCLUDED_STORAGE_META_KEY, None)
            metadata.pop(cls.MANUAL_INCLUDED_LLM_META_KEY, None)
        if metadata_updates:
            metadata.update(metadata_updates)

        entitlement, _ = OrganizationBillingEntitlement.objects.update_or_create(
            organization_id=organization_id,
            defaults={
                "included_storage_bytes": int(snapshot["included_storage_bytes"]),
                "purchased_storage_bytes": int(snapshot["purchased_storage_bytes"]),
                "included_llm_credits_monthly": cls._to_decimal(snapshot["included_llm_credits_monthly"]),
                "included_media_monthly": int(snapshot["included_media_monthly"]),
                "included_search_monthly": int(snapshot["included_search_monthly"]),
                "included_tts_monthly": int(snapshot["included_tts_monthly"]),
                "effective_from": snapshot["effective_from"] or (at_time or timezone.now()),
                "effective_to": snapshot["effective_to"],
                "is_active": True,
                "metadata": metadata,
            },
        )

        # P1-5 (TECH-6): 事务提交后清除 Guard 缓存和 LLM 缓存，避免回滚时缓存与 DB 不一致
        _wt_id = organization_id
        def _clear_caches():
            try:
                from apps.services.billing.services.guard_service import BillingGuardService
                BillingGuardService.clear_guard_cache(_wt_id)
            except Exception:
                logger.warning("sync 后清除 Guard 缓存失败: organization=%s", _wt_id, exc_info=True)
            # P1-6 (TECH-2): 失效 LLM quota_remaining 缓存，key 格式与 LlmBudgetService 一致
            try:
                from datetime import date
                cycle_month = date.today().replace(day=1)
                cache.delete(f"llm:quota_remaining:{_wt_id}:{cycle_month.isoformat()}")
            except Exception:
                logger.warning("sync 后清除 LLM 缓存失败: organization=%s", _wt_id, exc_info=True)
        transaction.on_commit(_clear_caches)

        return entitlement

    @classmethod
    def _resolve_manual_included_storage_bytes(
        cls,
        existing: OrganizationBillingEntitlement | None,
        existing_meta: Dict[str, Any],
    ) -> int | None:
        if cls.MANUAL_INCLUDED_STORAGE_META_KEY in existing_meta:
            return int(existing_meta.get(cls.MANUAL_INCLUDED_STORAGE_META_KEY) or 0)
        if not existing:
            return None

        if not existing_meta and int(existing.included_storage_bytes or 0) == 0:
            return None

        # 兼容旧数据：若当前 entitlement 不是同步来源写入的，则视为手工覆写。
        if existing_meta.get(cls.ENTITLEMENT_SOURCE_META_KEY) not in {
            "organization_membership",
            "free_tier",
            "default_zero",
        }:
            return int(existing.included_storage_bytes or 0)
        return None

    @classmethod
    def _resolve_manual_included_llm_credits(
        cls,
        existing: OrganizationBillingEntitlement | None,
        existing_meta: Dict[str, Any],
    ) -> Decimal | None:
        if cls.MANUAL_INCLUDED_LLM_META_KEY in existing_meta:
            return cls._to_decimal(existing_meta.get(cls.MANUAL_INCLUDED_LLM_META_KEY))
        if not existing:
            return None

        if not existing_meta and cls._to_decimal(existing.included_llm_credits_monthly) == Decimal("0"):
            return None

        if existing_meta.get(cls.ENTITLEMENT_SOURCE_META_KEY) not in {
            "organization_membership",
            "free_tier",
            "default_zero",
        }:
            return cls._to_decimal(existing.included_llm_credits_monthly)
        return None
