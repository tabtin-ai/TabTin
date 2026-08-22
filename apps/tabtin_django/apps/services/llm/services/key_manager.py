"""
LLM 渠道密钥管理器。

核心职责：
1. select_provider_key — 为指定 Provider 选择最优 Key（优先级 > 最久未用 > cooldown 排序）
2. mark_key_* — 按错误分类更新 Key 运行态（cooldown / disabled）
3. record_key_usage — 请求成功后更新用量统计

Auth Profile / Key 轮换设计：
- 同一 Provider 多 Key 轮换
- Key 级别独立熔断与冷却
- 会话粘性（通过 session_id 参数实现 pinning）
"""

from __future__ import annotations

import logging
from datetime import timedelta
from typing import Optional

from django.core.cache import cache
from django.db.models import F, Q
from django.utils import timezone

logger = logging.getLogger(__name__)

COOLDOWN_BASE_SECONDS = 30
COOLDOWN_MAX_SECONDS = 300

BILLING_DISABLE_BASE_HOURS = 4
BILLING_DISABLE_MAX_HOURS = 24

SESSION_PIN_TTL_SECONDS = 3600


def select_provider_key(
    provider_id: str,
    *,
    session_id: Optional[str] = None,
) -> Optional["LLMProviderKey"]:
    """为指定 Provider 选择最优可用 Key。

    选择策略（resolveAuthProfileOrder）：
    1. 若有 session_id 且存在 pin 缓存，优先返回 pinned key（若仍可用）
    2. 排除 cooldown/disabled 中的 key
    3. 按 priority DESC, last_used_at ASC（最久未用优先 = round-robin 效果）
    4. 若所有正常 key 不可用，降级到 cooldown 中最早恢复的 key

    Returns:
        LLMProviderKey instance or None
    """
    from ..models import LLMProviderKey

    if session_id:
        pinned = _get_session_pinned_key(session_id, provider_id)
        if pinned and pinned.is_usable:
            return pinned

    now = timezone.now()

    # v0.1：LLMProviderKey.is_active 已删（migration 0022），可用性语义
    # 完全由 cooldown_until / disabled_until 表达——
    # 排除 cooldown_until > now 与 disabled_until > now 即可。
    usable_keys = list(
        LLMProviderKey.objects.filter(provider_id=provider_id)
        .exclude(cooldown_until__gt=now)
        .exclude(disabled_until__gt=now)
        .order_by('-priority', F('last_used_at').asc(nulls_first=True), 'created_at')[:10]
    )

    if usable_keys:
        selected = usable_keys[0]
        if session_id:
            _set_session_pinned_key(session_id, provider_id, str(selected.id))
        return selected

    # 降级：从 cooldown 中选最早恢复的（排除 disabled）
    cooldown_keys = list(
        LLMProviderKey.objects.filter(
            provider_id=provider_id,
            cooldown_until__gt=now,
        )
        .exclude(disabled_until__gt=now)
        .order_by('cooldown_until')[:5]
    )
    if cooldown_keys:
        logger.info(
            "[KeyManager] Provider %s 所有 key 在冷却中，选择最早恢复的 key=%s cooldown_until=%s",
            provider_id, cooldown_keys[0].id, cooldown_keys[0].cooldown_until,
        )
        return cooldown_keys[0]

    return None


def mark_key_cooldown(key: "LLMProviderKey", reason: str = "") -> None:
    """标记 Key 进入短冷却（rate_limit / timeout / overloaded 等临时错误）。

    冷却时间按 error_count 指数退避：30s, 60s, 120s, 300s（上限）。
    使用 F() 原子递增避免并发竞态。
    """
    from ..models import LLMProviderKey

    now = timezone.now()

    LLMProviderKey.objects.filter(pk=key.pk).update(
        error_count=F("error_count") + 1,
        last_error_reason=reason[:50],
        updated_at=now,
    )

    updated = LLMProviderKey.objects.filter(pk=key.pk).values_list("error_count", flat=True).first() or 1
    multiplier = min(2 ** (updated - 1), COOLDOWN_MAX_SECONDS // COOLDOWN_BASE_SECONDS)
    cooldown_secs = min(COOLDOWN_BASE_SECONDS * multiplier, COOLDOWN_MAX_SECONDS)

    LLMProviderKey.objects.filter(pk=key.pk).update(
        cooldown_until=now + timedelta(seconds=cooldown_secs),
    )
    logger.info(
        "[KeyManager] Key %s (%s) 进入冷却 %ds，reason=%s error_count=%d",
        key.id, key.label, cooldown_secs, reason, updated,
    )


def mark_key_disabled(key: "LLMProviderKey", reason: str = "billing") -> None:
    """标记 Key 长期禁用（billing / auth_permanent 等持久错误）。

    禁用时间：4h 起步，翻倍递增，上限 24h。
    使用 F() 原子递增避免并发竞态。
    """
    from ..models import LLMProviderKey

    now = timezone.now()

    LLMProviderKey.objects.filter(pk=key.pk).update(
        error_count=F("error_count") + 1,
        last_error_reason=reason[:50],
        updated_at=now,
    )

    updated = LLMProviderKey.objects.filter(pk=key.pk).values_list("error_count", flat=True).first() or 1
    multiplier = min(2 ** (updated - 1), BILLING_DISABLE_MAX_HOURS // BILLING_DISABLE_BASE_HOURS)
    disable_hours = min(BILLING_DISABLE_BASE_HOURS * multiplier, BILLING_DISABLE_MAX_HOURS)

    LLMProviderKey.objects.filter(pk=key.pk).update(
        disabled_until=now + timedelta(hours=disable_hours),
        disabled_reason=reason[:50],
    )
    logger.warning(
        "[KeyManager] Key %s (%s) 被禁用 %dh，reason=%s",
        key.id, key.label, disable_hours, reason,
    )


def record_key_success(key: "LLMProviderKey", tokens: int = 0) -> None:
    """请求成功后更新 Key 状态：重置错误计数、清除冷却、更新用量。"""
    from ..models import LLMProviderKey

    now = timezone.now()
    update_kwargs = {
        "last_used_at": now,
        "error_count": 0,
        "cooldown_until": None,
        "last_error_reason": "",
        "total_requests": F("total_requests") + 1,
        "updated_at": now,
    }
    if tokens > 0:
        update_kwargs["total_tokens"] = F("total_tokens") + tokens

    LLMProviderKey.objects.filter(pk=key.pk).update(**update_kwargs)


def _session_pin_cache_key(session_id: str, provider_id: str) -> str:
    return f"llm:session_pin:{session_id}:{provider_id}"


def _get_session_pinned_key(session_id: str, provider_id: str) -> Optional["LLMProviderKey"]:
    """获取 session pinned key。v0.1 LLMProviderKey.is_active 已删（0022），
    禁用语义改由 ``disabled_until`` 表达：>now 即不可用。"""
    from django.utils import timezone

    from ..models import LLMProviderKey

    key_id = cache.get(_session_pin_cache_key(session_id, provider_id))
    if not key_id:
        return None
    try:
        key = LLMProviderKey.objects.get(pk=key_id)
    except LLMProviderKey.DoesNotExist:
        return None
    disabled_until = getattr(key, "disabled_until", None)
    if disabled_until and disabled_until > timezone.now():
        return None
    return key


def _set_session_pinned_key(session_id: str, provider_id: str, key_id: str) -> None:
    cache.set(
        _session_pin_cache_key(session_id, provider_id),
        key_id,
        SESSION_PIN_TTL_SECONDS,
    )


def clear_session_pin(session_id: str, provider_id: str) -> None:
    """手动清除会话粘性（Key 进入 cooldown 时调用）。"""
    cache.delete(_session_pin_cache_key(session_id, provider_id))
