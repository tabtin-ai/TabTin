"""Provider Credit 的只读能力展示与资金预览。"""

from __future__ import annotations

from decimal import Decimal
from typing import Any

from django.db.models import F, Q
from django.utils import timezone

from apps.services.billing.models import ProviderCreditGrant
from apps.services.billing.services.funding_allocator import FundingAllocator
from apps.services.billing.services.provider_credit_service import ProviderCreditService


class ProviderCreditCapabilityService:
    """面向 API 的 Provider Credit 只读投影。"""

    @classmethod
    def get_model_promotion_credit(
        cls,
        *,
        organization,
        provider_key: str,
        model_id: str,
        at=None,
    ) -> dict[str, Any] | None:
        """返回模型当前可用的赠送额度；不匹配时返回 None。"""
        return cls.get_model_promotion_credits(
            organization=organization,
            models=[{"id": model_id, "provider_key": provider_key}],
            at=at,
        ).get(str(model_id or ""))

    @classmethod
    def get_model_promotion_credits(
        cls,
        *,
        organization,
        models: list[dict[str, Any]],
        at=None,
    ) -> dict[str, dict[str, Any] | None]:
        """一次读取 Organization Grant，批量投影模型权益，避免 Catalog N+1。"""
        current_time = at or timezone.now()
        organization_id = str(getattr(organization, "pk", organization) or "").strip()
        normalized_models = [
            {
                "id": str(model.get("id") or "").strip(),
                "provider_key": str(model.get("provider_key") or "").strip().lower(),
            }
            for model in models
        ]
        provider_keys = {
            model["provider_key"]
            for model in normalized_models
            if model["provider_key"]
        }
        grants = (
            ProviderCreditGrant.objects.select_related("campaign")
            .filter(
                organization_id=organization_id,
                provider_key__in=provider_keys,
                status=ProviderCreditGrant.Status.ACTIVE,
                effective_at__lte=current_time,
                remaining_credits__gt=0,
            )
            .filter(Q(expire_at__isnull=True) | Q(expire_at__gt=current_time))
            .order_by(F("expire_at").asc(nulls_last=True), "created_at", "id")
        )
        grants_by_provider: dict[str, list[ProviderCreditGrant]] = {}
        for grant in grants:
            grants_by_provider.setdefault(grant.provider_key, []).append(grant)

        result: dict[str, dict[str, Any] | None] = {}
        for model in normalized_models:
            model_id = model["id"]
            provider_key = model["provider_key"]
            matching = [
                grant
                for grant in grants_by_provider.get(provider_key, [])
                if ProviderCreditService.matches_provider_credit(
                    grant,
                    provider_key,
                    model_id,
                )
            ]
            if not matching:
                result[model_id] = None
                continue

            first = matching[0]
            available = sum(
                (Decimal(str(grant.remaining_credits)) for grant in matching),
                Decimal("0"),
            )
            total = sum(
                (Decimal(str(grant.total_credits)) for grant in matching),
                Decimal("0"),
            )
            expire_at = next(
                (grant.expire_at for grant in matching if grant.expire_at is not None),
                None,
            )
            result[model_id] = {
                "eligible": True,
                "provider_key": first.provider_key,
                "remaining_credits": float(available),
                "total_credits": float(total),
                "expire_at": expire_at.isoformat() if expire_at else None,
                "label": first.campaign.name,
            }
        return result

    @classmethod
    def preview_funding(
        cls,
        *,
        organization,
        provider_key: str,
        model_id: str,
        required_credits,
        billing_context: dict[str, Any] | None = None,
        funding_mode: str | None = None,
    ) -> list[dict[str, Any]]:
        """生成不落账、不失效缓存且不触发事件的有序资金预览。"""
        preview: list[dict[str, Any]] = []
        allocations = FundingAllocator.preview_funding(
            organization=organization,
            provider_key=provider_key,
            model_id=model_id,
            required_credits=required_credits,
            billing_context=billing_context or {},
            funding_mode=funding_mode,
        )

        provider_grant_ids = [
            allocation.source_id
            for allocation in allocations
            if allocation.source_type == "provider_credit"
        ]
        grants_by_id = {
            str(grant.id): grant
            for grant in ProviderCreditGrant.objects.select_related("campaign").filter(
                id__in=provider_grant_ids
            )
        }
        for allocation in allocations:
            item: dict[str, Any] = {
                "source_type": allocation.source_type,
                "credits": str(allocation.credits),
            }
            if allocation.source_type == "provider_credit":
                grant = grants_by_id.get(allocation.source_id)
                if grant is not None:
                    item.update(
                        {
                            "source_id": str(grant.id),
                            "campaign_code": grant.campaign.code,
                            "label": grant.campaign.name,
                            "provider_key": grant.provider_key,
                            "expire_at": (
                                grant.expire_at.isoformat()
                                if grant.expire_at
                                else None
                            ),
                        }
                    )
            preview.append(item)
        return preview


__all__ = ["ProviderCreditCapabilityService"]
