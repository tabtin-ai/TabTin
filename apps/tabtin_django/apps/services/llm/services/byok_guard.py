"""
BYOK（Bring Your Own Key）渠道用量上限保护。

虽然 BYOK 渠道免收平台费，但仍需限制调用频率和 token 消耗，
防止被盗用 key 或异常脚本对用户自有渠道产生过大开销。

基于 Django cache 的滑动窗口实现，阈值通过 settings.BYOK_RATE_LIMITS 可配置。
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Optional

from django.conf import settings
from django.core.cache import cache

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# BYOK 异常计数器 — 有上限的 fail-open
# ---------------------------------------------------------------------------
_byok_fail_counter = 0
_byok_fail_lock = threading.Lock()
_BYOK_FAIL_THRESHOLD = 10
_byok_last_failure_time: float = 0.0
_BYOK_FAIL_WINDOW = 60


def _record_byok_failure() -> bool:
    """记录 BYOK 检查异常。返回 True 表示已超过阈值，应拒绝请求。"""
    global _byok_fail_counter, _byok_last_failure_time
    now = time.monotonic()
    with _byok_fail_lock:
        if now - _byok_last_failure_time > _BYOK_FAIL_WINDOW:
            _byok_fail_counter = 0
        _byok_fail_counter += 1
        _byok_last_failure_time = now
        return _byok_fail_counter >= _BYOK_FAIL_THRESHOLD


def _reset_byok_failures() -> None:
    """BYOK 检查成功时重置异常计数器。"""
    global _byok_fail_counter
    with _byok_fail_lock:
        _byok_fail_counter = 0

_DEFAULT_LIMITS = {
    "hourly_calls": 500,
    "daily_calls": 5000,
    "hourly_tokens": 2_000_000,
    "daily_tokens": 10_000_000,
    "single_call_token_warning": 500_000,
}


def _get_limits() -> dict:
    return getattr(settings, "BYOK_RATE_LIMITS", None) or _DEFAULT_LIMITS


def check_byok_rate_limit(
    user_id: str,
    organization_id: str,
    provider_key: str,
) -> Optional[dict]:
    """检查 BYOK 渠道的调用频率是否超限。

    Returns:
        None — 未超限，允许继续。
        dict — 超限，含 ``success=False`` + ``error_code="BYOK_RATE_LIMIT"``。
    """
    limits = _get_limits()
    scope = f"{user_id}:{organization_id}:{provider_key}"

    try:
        hourly_key = f"byok:calls:h:{scope}"
        daily_key = f"byok:calls:d:{scope}"

        hourly_count = _incr_window(hourly_key, ttl=3600)
        daily_count = _incr_window(daily_key, ttl=86400)

        hourly_max = limits.get("hourly_calls", _DEFAULT_LIMITS["hourly_calls"])
        daily_max = limits.get("daily_calls", _DEFAULT_LIMITS["daily_calls"])

        if hourly_count > hourly_max:
            logger.warning(
                "[BYOK] 调用频率超限(hourly): scope=%s count=%d limit=%d",
                scope, hourly_count, hourly_max,
            )
            return _build_rate_limit_error("hourly_calls", hourly_count, hourly_max)

        if daily_count > daily_max:
            logger.warning(
                "[BYOK] 调用频率超限(daily): scope=%s count=%d limit=%d",
                scope, daily_count, daily_max,
            )
            return _build_rate_limit_error("daily_calls", daily_count, daily_max)

        _reset_byok_failures()

    except Exception as exc:
        if _record_byok_failure():
            logger.error(
                "[BYOK] 连续频率检查异常超过阈值(%d)，拒绝请求: %s",
                _BYOK_FAIL_THRESHOLD, exc,
            )
            return _build_rate_limit_error("system_error", 0, 0)
        logger.warning("[BYOK] 调用频率检查异常，本次放行: %s", exc)

    return None


def record_byok_token_usage(
    user_id: str,
    organization_id: str,
    total_tokens: int,
) -> Optional[str]:
    """记录 BYOK 渠道的 token 消耗并检查上限。

    Returns:
        None — 未超限。
        str  — 超限维度名（``"hourly_tokens"`` 或 ``"daily_tokens"``）。
    """
    if total_tokens <= 0:
        return None

    limits = _get_limits()
    scope = f"{user_id}:{organization_id}"

    try:
        hourly_key = f"byok:tokens:h:{scope}"
        daily_key = f"byok:tokens:d:{scope}"

        hourly_total = _incr_window(hourly_key, ttl=3600, delta=total_tokens)
        daily_total = _incr_window(daily_key, ttl=86400, delta=total_tokens)

        warning_threshold = limits.get(
            "single_call_token_warning",
            _DEFAULT_LIMITS["single_call_token_warning"],
        )
        if total_tokens > warning_threshold:
            logger.warning(
                "[BYOK] 单次调用 token 异常偏高: scope=%s tokens=%d threshold=%d",
                scope, total_tokens, warning_threshold,
            )

        hourly_max = limits.get("hourly_tokens", _DEFAULT_LIMITS["hourly_tokens"])
        daily_max = limits.get("daily_tokens", _DEFAULT_LIMITS["daily_tokens"])

        if hourly_total > hourly_max:
            logger.warning(
                "[BYOK] token 消耗超限(hourly): scope=%s total=%d limit=%d",
                scope, hourly_total, hourly_max,
            )
            return "hourly_tokens"

        if daily_total > daily_max:
            logger.warning(
                "[BYOK] token 消耗超限(daily): scope=%s total=%d limit=%d",
                scope, daily_total, daily_max,
            )
            return "daily_tokens"

        _reset_byok_failures()

    except Exception as exc:
        if _record_byok_failure():
            logger.error(
                "[BYOK] 连续 token 用量记录异常超过阈值(%d): %s",
                _BYOK_FAIL_THRESHOLD, exc,
            )
            return "system_error"
        logger.warning("[BYOK] token 用量记录异常，本次放行: %s", exc)

    return None


# ---------------------------------------------------------------------------
# 内部工具
# ---------------------------------------------------------------------------

def _incr_window(cache_key: str, *, ttl: int, delta: int = 1) -> int:
    """对 cache_key 做滑动窗口递增，首次写入时设置 TTL。"""
    initialized = cache.add(cache_key, delta, ttl)
    if initialized:
        return delta
    try:
        return cache.incr(cache_key, delta)
    except ValueError:
        cache.set(cache_key, delta, ttl)
        return delta


def _build_rate_limit_error(dimension: str, current: int, limit: int) -> dict:
    return {
        "success": False,
        "error_code": "BYOK_RATE_LIMIT_EXCEEDED",
        "error_category": "byok_rate_limit_exceeded",
        "error": (
            f"[byok_rate_limit_exceeded] BYOK 渠道调用频率超限 "
            f"({dimension}: {current}/{limit})"
        ),
        "dimension": dimension,
        "current": current,
        "limit": limit,
    }
