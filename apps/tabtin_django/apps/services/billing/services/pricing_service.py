"""
计价规则解析服务
"""

from __future__ import annotations

import logging
from decimal import Decimal
from typing import Optional

from django.core.cache import cache as django_cache
from django.db.models import Q
from django.utils import timezone

from apps.services.billing.models import MeterPricing

logger = logging.getLogger(__name__)


class MeterPricingService:
    """定价查询服务（organization 优先，渠道模型细粒度覆盖）"""

    _CACHE_TTL = 60
    _CACHE_PREFIX = "meter_pricing:"

    @staticmethod
    def get_pricing_rule(
        meter_key: str,
        *,
        organization_id: Optional[str] = None,
        provider_key: Optional[str] = None,
        model_name: Optional[str] = None,
        at_time=None,
    ):
        """返回与 get_unit_price 完全同口径的规则，供 Reservation 冻结快照。"""
        if not meter_key:
            return None
        provider_key = (provider_key or "").strip()
        model_name = (model_name or "").strip()
        now = at_time or timezone.now()
        queryset = MeterPricing.objects.filter(
            meter_key=meter_key,
            is_active=True,
            effective_from__lte=now,
        ).filter(Q(effective_to__isnull=True) | Q(effective_to__gt=now))
        queryset = queryset.filter(
            scope__in=["organization", "global"]
            if organization_id
            else ["global"]
        )

        best_rule = None
        best_score = -1
        for rule in queryset:
            score = 0
            if (
                organization_id
                and rule.scope == "organization"
                and rule.organization_id == organization_id
            ):
                score += 100
            elif rule.scope == "global":
                score += 10
            else:
                continue
            if rule.provider_key:
                if not provider_key or rule.provider_key != provider_key:
                    continue
                score += 20
            else:
                score += 2
            if rule.model_name:
                if not model_name or rule.model_name != model_name:
                    continue
                score += 10
            else:
                score += 1
            score += max(0, rule.priority)
            if score > best_score:
                best_score = score
                best_rule = rule
        return best_rule

    @staticmethod
    def get_unit_price(
        meter_key: str,
        *,
        organization_id: Optional[str] = None,
        provider_key: Optional[str] = None,
        model_name: Optional[str] = None,
        at_time=None,
        default_price: Optional[Decimal] = None,
    ) -> Optional[Decimal]:
        if not meter_key:
            return default_price

        use_cache = at_time is None
        cache_key = None

        provider_key = (provider_key or "").strip()
        model_name = (model_name or "").strip()

        if use_cache:
            cache_key = (
                f"{MeterPricingService._CACHE_PREFIX}"
                f"{meter_key}:{organization_id or ''}:{provider_key}:{model_name}"
            )
            cached = django_cache.get(cache_key)
            if cached is not None:
                return cached

        best_rule = MeterPricingService.get_pricing_rule(
            meter_key,
            organization_id=organization_id,
            provider_key=provider_key,
            model_name=model_name,
            at_time=at_time,
        )

        result = best_rule.unit_price if best_rule else default_price

        if use_cache and cache_key is not None and result is not None:
            django_cache.set(cache_key, result, MeterPricingService._CACHE_TTL)

        return result

    @staticmethod
    def invalidate_cache() -> None:
        """清除所有定价缓存。优先使用 delete_pattern（django-redis），
        否则依赖 TTL 自然过期（60s）。"""
        try:
            django_cache.delete_pattern(
                f"{MeterPricingService._CACHE_PREFIX}*"
            )
        except (AttributeError, NotImplementedError):
            logger.debug(
                "[MeterPricingService] cache backend 不支持 delete_pattern，"
                "等待 TTL 自然过期"
            )
