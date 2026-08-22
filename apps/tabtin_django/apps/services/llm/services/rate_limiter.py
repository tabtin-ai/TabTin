"""
通用 Provider 级限流/熔断工具函数。

从 BaseLLMService._check_provider_rate_limit 中提取的独立版本，
可被 LLM、TTS、ASR、Media、BGM 等所有 Service 共用。

限流算法：基于 Django cache 的滑动窗口（分钟级），与 LLM 层完全一致。
熔断反馈：委托 runtime.report_provider_call_result（含状态机转换 + Prometheus）。
"""

from __future__ import annotations

import logging
import time
from typing import Any, Dict, Optional, TYPE_CHECKING

from django.core.cache import cache

if TYPE_CHECKING:
    from apps.services.llm.models import LLMProvider

logger = logging.getLogger(__name__)


def check_provider_rate_limit(
    provider_id: str,
    rate_limit: int,
    *,
    provider_name: str = "",
    service_tag: str = "generic",
) -> Optional[Dict[str, Any]]:
    """通用的 Provider 级限流检查（基于 Django cache 滑动窗口）。

    与 BaseLLMService._check_provider_rate_limit 行为完全一致。

    Args:
        provider_id: Provider UUID（字符串）
        rate_limit: 每分钟请求上限。<= 0 时跳过限流
        provider_name: 用于错误消息展示
        service_tag: 服务标签（如 "tts"/"asr"/"media"/"bgm"），用于 cache key 隔离

    Returns:
        None: 未触发限流
        dict: 标准限流错误结构 {"success": False, "error_code": "RATE_LIMIT", ...}
    """
    if rate_limit <= 0:
        return None
    if not provider_id:
        return None

    current_bucket = int(time.time() // 60)
    cache_key = f"svc:{service_tag}:rate_limit:{provider_id}:{current_bucket}"
    ttl_seconds = 90

    try:
        initialized = cache.add(cache_key, 1, ttl_seconds)
        current_count = 1 if initialized else int(cache.incr(cache_key))
    except Exception as exc:
        logger.warning(
            "[%s] 限流计数失败，降级放行 provider=%s err=%s",
            service_tag, provider_id, exc,
        )
        return None

    if current_count <= rate_limit:
        return None

    # 超限拒绝时回滚本次 incr，避免 worker 崩溃 / 空转 attempt 虚增计数。
    try:
        cache.decr(cache_key)
    except Exception as exc:
        logger.warning(
            "[%s] 限流拒绝后回滚计数失败 provider=%s err=%s",
            service_tag, provider_id, exc,
        )

    retry_after_seconds = max(1, int(60 - (time.time() % 60)))
    display_name = provider_name or provider_id

    try:
        from apps.services.llm.services.llm_metrics import llm_rate_limit_rejections_total
        llm_rate_limit_rejections_total.labels(
            provider=provider_name or provider_id,
        ).inc()
    except Exception:
        pass

    return {
        "success": False,
        "error": f"渠道 {display_name} 已触发每分钟限流（{rate_limit}/min）",
        "error_code": "RATE_LIMIT",
        "status_code": 429,
        "retry_after_seconds": retry_after_seconds,
    }


def check_provider_rate_limit_from_obj(
    provider: "LLMProvider",
    *,
    service_tag: str = "generic",
) -> Optional[Dict[str, Any]]:
    """从 LLMProvider ORM 对象读取 rate_limit 并执行限流检查。"""
    if not provider:
        return None

    try:
        rate_limit = int(getattr(provider, "rate_limit", 0) or 0)
    except (TypeError, ValueError):
        rate_limit = 0

    provider_id = str(getattr(provider, "id", "") or "")
    provider_name = (
        getattr(provider, "display_name", None)
        or getattr(provider, "name", "")
        or ""
    )

    return check_provider_rate_limit(
        provider_id=provider_id,
        rate_limit=rate_limit,
        provider_name=provider_name,
        service_tag=service_tag,
    )


def report_call_result_by_id(
    provider_id: str,
    *,
    success: bool,
    latency_seconds: float = 0,
    error_message: str = "",
) -> None:
    """通过 provider_id（字符串）上报调用结果，内部做 DB lookup。

    适用于 TTS/ASR/BGM 等持有 provider_id 但不持有 Provider ORM 对象的场景。
    """
    if not provider_id:
        return
    try:
        # v0.1：LLMProvider.is_active 字段已删（0022），可路由 = routing_enabled。
        from apps.services.llm.models import LLMProvider
        provider = LLMProvider.objects.filter(id=provider_id, routing_enabled=True).first()
        if provider:
            report_call_result(provider, success=success, latency_seconds=latency_seconds, error_message=error_message)
    except Exception as exc:
        logger.debug("[rate_limiter] report_call_result_by_id failed: %s", exc)


def report_call_result(
    provider: Optional["LLMProvider"],
    *,
    success: bool,
    latency_seconds: Optional[float] = None,
    error_message: str = "",
) -> None:
    """报告调用结果，驱动 Provider 熔断状态机（不写探测日志）。

    直接委托 runtime.report_provider_call_result，确保状态机逻辑单一来源。
    TTS/ASR/Media/BGM 应在每次调用上游后调用此函数。
    """
    if not provider:
        return

    try:
        from apps.services.llm.services.runtime import report_provider_call_result
        report_provider_call_result(
            provider,
            success=success,
            latency_seconds=latency_seconds,
            error_message=error_message,
        )
    except Exception as exc:
        logger.warning(
            "[rate_limiter] 上报调用结果失败 provider=%s err=%s",
            getattr(provider, "id", "?"), exc,
        )


def is_provider_available(provider: Optional["LLMProvider"]) -> bool:
    """快速检查 Provider 是否处于可路由状态（未熔断）。

    返回 False 时，调用方应跳过该 Provider 或返回错误。
    """
    if not provider:
        return True

    try:
        from apps.services.llm.services.runtime import is_provider_routable
        return is_provider_routable(provider)
    except Exception:
        return True
