"""
计费运行时配置服务 — 统一读取 BillingRuntimeConfig，带 Redis 缓存。

所有原本硬编码的计费参数通过此服务读取，AdminDash 修改后实时生效。
"""

from __future__ import annotations

import logging
from decimal import Decimal
from typing import Any, Dict, Optional

from django.core.cache import cache as django_cache

logger = logging.getLogger(__name__)

_CACHE_KEY = "billing:runtime_config"
_CACHE_TTL = 30  # 配置缓存 30 秒，AdminDash 修改后最多 30s 生效


# 默认值字典（与 BillingRuntimeConfig 模型默认值保持一致）
_DEFAULTS: Dict[str, Any] = {
    "credits_per_yuan": 100,
    "min_balance_threshold": Decimal("0.01"),
    "freeze_fallback_credits": Decimal("0.5"),
    "freeze_est_input_tokens": 2000,
    "freeze_est_output_tokens": 500,
    "precheck_fail_threshold": 10,
    "failopen_max_credits": Decimal("10"),
    "precheck_fail_window": 60,
    "balance_recheck_interval": 1,
    "stale_freeze_threshold_minutes": 120,
    "pricing_cache_ttl": 60,
    "cache_discount_config": {},
    # PRD-04 Wave 5：默认 True，与 BillingRuntimeConfig 字段默认值保持一致。
    # 用户在消息气泡上默认能看到每条消息费用——TabTin"透明"承诺的底线。
    "show_per_message_cost": True,
    "sync_charge_threshold_credits": 100,
    "fail_open_24h_block_threshold": 50,
    "internal_llm_call_balance_guard_pct": 20,
    "internal_llm_call_balance_guard_floor": 500,
    "large_charge_review_threshold_credits": 1000,
    "degradation_window_seconds": 3600,
    "degradation_alert_threshold": 10,
}

DECIMAL_FIELDS = frozenset({"min_balance_threshold", "freeze_fallback_credits", "failopen_max_credits"})

_PROVIDER_CACHE_DISCOUNT_DEFAULTS = {
    "anthropic": {"cache_read_ratio": Decimal("0.1"), "cache_write_ratio": Decimal("1.25")},
    "claude": {"cache_read_ratio": Decimal("0.1"), "cache_write_ratio": Decimal("1.25")},
    "openai": {"cache_read_ratio": Decimal("0.5"), "cache_write_ratio": Decimal("1.0")},
    "google": {"cache_read_ratio": Decimal("0.25"), "cache_write_ratio": Decimal("1.0")},
    "gemini": {"cache_read_ratio": Decimal("0.25"), "cache_write_ratio": Decimal("1.0")},
    "deepseek": {"cache_read_ratio": Decimal("0.1"), "cache_write_ratio": Decimal("1.0")},
}


class BillingConfigService:
    """计费运行时配置读取服务。

    用法::

        from apps.services.billing.services.runtime_config_service import BillingConfigService

        threshold = BillingConfigService.get("min_balance_threshold")
        all_config = BillingConfigService.get_all()
    """

    @staticmethod
    def get_all() -> Dict[str, Any]:
        """读取全部配置（带缓存）。"""
        cached = django_cache.get(_CACHE_KEY)
        if cached is not None:
            return cached

        try:
            from apps.services.billing.models import BillingRuntimeConfig
            instance = BillingRuntimeConfig.get_instance()
            config = {}
            for key, default in _DEFAULTS.items():
                config[key] = getattr(instance, key, default)
            django_cache.set(_CACHE_KEY, config, _CACHE_TTL)
            return config
        except Exception as exc:
            logger.debug("[BillingConfigService] 读取配置失败，使用默认值: %s", exc)
            return dict(_DEFAULTS)

    @staticmethod
    def get(key: str, default: Any = None) -> Any:
        """读取单个配置项。"""
        all_config = BillingConfigService.get_all()
        if default is not None:
            return all_config.get(key, default)
        return all_config.get(key, _DEFAULTS.get(key))

    @staticmethod
    def get_provider_cache_discount(provider_key: str) -> Dict[str, Decimal]:
        """获取 Provider 的 cache 折扣率。

        优先使用 AdminDash 配置的值，其次使用内置默认值。
        """
        custom: Dict = BillingConfigService.get("cache_discount_config") or {}
        pk = (provider_key or "").lower()

        if pk in custom:
            entry = custom[pk]
            return {
                "cache_read_ratio": Decimal(str(entry.get("cache_read_ratio", "1"))),
                "cache_write_ratio": Decimal(str(entry.get("cache_write_ratio", "1"))),
            }

        return _PROVIDER_CACHE_DISCOUNT_DEFAULTS.get(pk, {})

    @staticmethod
    def invalidate_cache() -> None:
        """AdminDash 修改配置后调用。"""
        django_cache.delete(_CACHE_KEY)

    @staticmethod
    def update_partial(data: Dict[str, Any], updated_by: str = "") -> Dict[str, Any]:
        """部分更新配置，仅处理 _DEFAULTS 中已知的字段。

        返回最新的完整配置字典（含 updated_at / updated_by）。
        """
        from apps.services.billing.models import BillingRuntimeConfig
        from ..api_utils import safe_decimal

        instance = BillingRuntimeConfig.get_instance()

        for key, value in data.items():
            if key not in _DEFAULTS:
                continue
            if key in DECIMAL_FIELDS:
                value = safe_decimal(value)
            setattr(instance, key, value)

        instance.updated_by = updated_by
        instance.save()

        BillingConfigService.invalidate_cache()

        config = dict(BillingConfigService.get_all())
        config["updated_at"] = instance.updated_at.isoformat() if instance.updated_at else ""
        config["updated_by"] = instance.updated_by or ""
        return config

    @staticmethod
    def get_credits_per_yuan() -> int:
        """获取点券/元换算比例，供客户端 API 使用。"""
        return int(BillingConfigService.get("credits_per_yuan", 100))


BillingRuntimeConfigService = BillingConfigService
