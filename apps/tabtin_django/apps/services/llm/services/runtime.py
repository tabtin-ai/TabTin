"""
LLM 渠道运行态服务。

负责：
1. 健康探测执行
2. 运行态字段更新
3. 探测日志落库
"""

from __future__ import annotations

import hashlib
import logging
import threading
import time
from datetime import timedelta
from typing import Any, Dict, Optional, Tuple

from django.db import transaction
from django.db.models import F
from django.utils import timezone

from ..models import LLMModel, LLMProvider
from .capability_guard import provider_supports_llm_capability
from .factory import LLMServiceFactory

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Probe 服务实例进程内缓存
# key = (provider_id, config_fingerprint), value = (service, created_at)
# Celery prefork 每个子进程有独立缓存，不存在跨进程共享问题。
# ---------------------------------------------------------------------------
_probe_service_cache: Dict[Tuple[str, str], Tuple[Any, float]] = {}
_probe_service_cache_lock = threading.Lock()
_PROBE_CACHE_TTL = 300  # 5 分钟
_PROBE_CACHE_MAX_SIZE = 50


def _resolve_probe_base_url(provider: LLMProvider, model_name: str) -> str:
    """v0.1.x Phase 2.5：base_url 从 Model 取（Provider.base_url 已删）。
    委托给 ``_runtime/endpoint_resolver``，避免跟 failover_executor 重复实现。
    """
    from ._runtime.endpoint_resolver import resolve_model_base_url
    return resolve_model_base_url(provider, model_name)


def _config_fingerprint(provider: LLMProvider, model_name: str, base_url: str) -> str:
    """基于 api_key/base_url/model 生成配置指纹，配置变更时自动失效。"""
    raw = f"{provider.api_key}|{base_url}|{model_name}|{provider.updated_at.isoformat()}"
    return hashlib.md5(raw.encode()).hexdigest()[:12]


def _get_or_create_probe_service(provider: LLMProvider, model_name: str):
    """获取或创建用于 probe 的 LLM 服务实例（进程内缓存）。"""
    provider_id = str(provider.id)
    base_url = _resolve_probe_base_url(provider, model_name)
    fp = _config_fingerprint(provider, model_name, base_url)
    cache_key = (provider_id, fp)
    now = time.monotonic()

    with _probe_service_cache_lock:
        entry = _probe_service_cache.get(cache_key)
        if entry and (now - entry[1]) < _PROBE_CACHE_TTL:
            return entry[0]

    provider_config = {
        "name": provider.name,
        "api_key": provider.api_key,
        "base_url": base_url,
        "model_name": model_name,
        "max_retries": 1,
        "retry_delay": 1,
        "provider_obj": provider,
    }
    service = LLMServiceFactory.create_service(provider.name, provider_config)

    with _probe_service_cache_lock:
        _probe_service_cache[cache_key] = (service, now)
        if len(_probe_service_cache) > _PROBE_CACHE_MAX_SIZE:
            oldest_key = min(_probe_service_cache, key=lambda k: _probe_service_cache[k][1])
            _probe_service_cache.pop(oldest_key, None)

    return service

RUNTIME_STATUS_UNKNOWN = "unknown"
RUNTIME_STATUS_HEALTHY = "healthy"
RUNTIME_STATUS_DEGRADED = "degraded"
RUNTIME_STATUS_UNHEALTHY = "unhealthy"

DEFAULT_FAIL_TO_UNHEALTHY = 3
DEGRADED_LATENCY_THRESHOLD_MS = 2500

# 从 degraded 恢复到 healthy 需要的连续成功次数。
# health_consecutive_failures 用负值表示恢复进度（-1 → -2 → -3 = 恢复完成）。
RECOVERY_SUCCESS_THRESHOLD = 3


def _resolve_probe_model_name(provider: LLMProvider) -> str:
    # v0.1：LLMModel.is_active 字段已删（0022），下线模型直接 DELETE。
    model = (
        LLMModel.objects.filter(provider=provider)
        .order_by("-updated_at", "-created_at")
        .first()
    )
    if model:
        return model.model_name
    return ""


CIRCUIT_BREAKER_BASE_COOLDOWN_SECONDS = 60
CIRCUIT_BREAKER_MAX_COOLDOWN_SECONDS = 300


HALF_OPEN_PROBE_WINDOW_SECONDS = 30


def is_provider_routable(provider: LLMProvider) -> bool:
    """判断渠道是否可路由（只读快速检查）。

    v0.1：LLMProvider.is_active 字段已删（0022），可路由 = ``routing_enabled`` 且
    runtime_status 非 unhealthy（或冷却期已过）。
    """
    if not provider.routing_enabled:
        return False
    if provider.runtime_status != RUNTIME_STATUS_UNHEALTHY:
        return True

    cooldown_until = provider.runtime_cooldown_until
    if cooldown_until is None:
        return False
    return timezone.now() >= cooldown_until


def try_enter_half_open(provider: LLMProvider) -> bool:
    """原子地尝试进入 half-open 试探窗口。

    仅第一个到达的请求返回 True（CAS 语义），后续并发请求返回 False。
    成功进入后会将 cooldown_until 前推一个试探窗口，阻止其他请求涌入。
    """
    now = timezone.now()
    with transaction.atomic():
        locked = LLMProvider.objects.select_for_update().get(pk=provider.pk)
        if locked.runtime_status != RUNTIME_STATUS_UNHEALTHY:
            return True
        if locked.runtime_cooldown_until is None:
            return False
        if now < locked.runtime_cooldown_until:
            return False
        locked.runtime_cooldown_until = now + timedelta(seconds=HALF_OPEN_PROBE_WINDOW_SECONDS)
        locked.save(update_fields=["runtime_cooldown_until"])
        return True


def apply_provider_runtime_feedback(
    provider: LLMProvider,
    *,
    is_success: bool,
    latency_ms: Optional[int] = None,
    error_message: str = "",
    check_type: str = "inline",
    details: Optional[Dict[str, Any]] = None,
    persist_log: bool = False,
) -> Dict[str, Any]:
    """
    更新渠道运行态。

    说明：
    - 探测任务与手动探测使用 persist_log=True，写入 structured log。
    - 在线请求反馈默认不写探测日志，避免日志量暴涨。
    """
    _prev_runtime_status = provider.runtime_status

    now = timezone.now()
    needs_failure_status = not is_success
    needs_avg_update = is_success and latency_ms is not None

    update_kwargs: dict = {
        "health_total_checks": F("health_total_checks") + 1,
        "health_last_checked_at": now,
        "health_last_latency_ms": latency_ms,
        "updated_at": now,
    }

    if is_success:
        update_kwargs.update({
            "health_success_checks": F("health_success_checks") + 1,
            "health_last_success_at": now,
            "health_last_error": "",
        })

        is_high_latency = latency_ms is not None and latency_ms >= DEGRADED_LATENCY_THRESHOLD_MS

        if _prev_runtime_status == RUNTIME_STATUS_UNHEALTHY:
            # unhealthy → degraded：首次试探成功，进入降级观察期
            update_kwargs["runtime_status"] = RUNTIME_STATUS_DEGRADED
            update_kwargs["health_consecutive_failures"] = -1
            update_kwargs["runtime_cooldown_until"] = None
            update_kwargs["runtime_cooldown_multiplier"] = max(
                1, provider.runtime_cooldown_multiplier // 2
            )
        elif _prev_runtime_status == RUNTIME_STATUS_DEGRADED:
            # degraded 状态：累计连续成功，达到阈值后提升为 healthy
            update_kwargs["runtime_cooldown_until"] = None
            recovery_count = abs(min(provider.health_consecutive_failures, 0)) + 1
            if is_high_latency:
                # 高延迟不计入恢复进度，保持 degraded
                update_kwargs["runtime_status"] = RUNTIME_STATUS_DEGRADED
                update_kwargs["health_consecutive_failures"] = -(recovery_count - 1)
            elif recovery_count >= RECOVERY_SUCCESS_THRESHOLD:
                update_kwargs["runtime_status"] = RUNTIME_STATUS_HEALTHY
                update_kwargs["health_consecutive_failures"] = 0
                update_kwargs["runtime_cooldown_multiplier"] = 1
            else:
                update_kwargs["runtime_status"] = RUNTIME_STATUS_DEGRADED
                update_kwargs["health_consecutive_failures"] = -recovery_count
        else:
            # healthy / unknown 状态：正常成功逻辑
            update_kwargs["health_consecutive_failures"] = 0
            update_kwargs["runtime_cooldown_until"] = None
            update_kwargs["runtime_cooldown_multiplier"] = 1
            update_kwargs["runtime_status"] = (
                RUNTIME_STATUS_DEGRADED if is_high_latency else RUNTIME_STATUS_HEALTHY
            )
    else:
        update_kwargs.update({
            "health_last_failure_at": now,
            "health_last_error": (error_message or "")[:2000],
        })

    with transaction.atomic():
        if needs_failure_status:
            locked = LLMProvider.objects.select_for_update().get(pk=provider.pk)
            prev_fail = locked.health_consecutive_failures
            # 负值表示恢复进度，失败时重置为 1；正值正常递增
            new_fail_count = 1 if prev_fail < 0 else prev_fail + 1
            update_kwargs["health_consecutive_failures"] = new_fail_count
            if new_fail_count >= DEFAULT_FAIL_TO_UNHEALTHY:
                update_kwargs["runtime_status"] = RUNTIME_STATUS_UNHEALTHY
                multiplier = max(locked.runtime_cooldown_multiplier, 1)
                cooldown_secs = min(
                    CIRCUIT_BREAKER_BASE_COOLDOWN_SECONDS * multiplier,
                    CIRCUIT_BREAKER_MAX_COOLDOWN_SECONDS,
                )
                update_kwargs["runtime_cooldown_until"] = now + timedelta(seconds=cooldown_secs)
                update_kwargs["runtime_cooldown_multiplier"] = min(multiplier * 2, 8)
            else:
                update_kwargs["runtime_status"] = RUNTIME_STATUS_DEGRADED

        if needs_avg_update:
            # ⚠️ MySQL UPDATE SET 按列顺序从左到右求值，后列的 F() 会读到前列已更新的值。
            # 为保证 health_avg_latency_ms 始终基于更新前的 health_success_checks 计算，
            # 必须在 health_success_checks 递增之前单独执行 avg 更新。
            from django.db.models.functions import Greatest
            old_count = F("health_success_checks")
            new_count = Greatest(F("health_success_checks") + 1, 1)
            LLMProvider.objects.filter(pk=provider.pk).update(
                health_avg_latency_ms=(
                    F("health_avg_latency_ms") * old_count + float(latency_ms)
                ) / new_count
            )

        LLMProvider.objects.filter(pk=provider.pk).update(**update_kwargs)

        if persist_log:
            logger.info(
                "[LLM Runtime] probe_log provider=%s check_type=%s success=%s "
                "latency_ms=%s error=%s details=%s",
                provider.id, check_type, is_success, latency_ms,
                (error_message or "")[:200], details or {},
            )

    # 刷新内存中的 provider 实例以反映 DB 最新值
    provider.refresh_from_db()

    # ── Prometheus: 熔断状态 Gauge ──
    try:
        from .llm_metrics import llm_circuit_breaker_state
        _cb_status_map = {"healthy": 0, "degraded": 1, "unhealthy": 2, "unknown": 0}
        llm_circuit_breaker_state.labels(
            provider=getattr(provider, "provider_key", "") or provider.name,
        ).set(_cb_status_map.get(provider.runtime_status, 0))
    except Exception:
        pass

    # E13-2: Provider 进入或脱离 UNHEALTHY 时清除 SceneBinding 缓存，
    # 确保 get_llm_service_for_scene 立即感知路由变化。
    _new_status = provider.runtime_status
    if _new_status != _prev_runtime_status and (
        _prev_runtime_status == RUNTIME_STATUS_UNHEALTHY
        or _new_status == RUNTIME_STATUS_UNHEALTHY
    ):
        from .factory import invalidate_scene_cache
        invalidate_scene_cache()

    return {
        "provider_id": str(provider.id),
        "runtime_status": provider.runtime_status,
        "is_success": is_success,
        "latency_ms": latency_ms,
        "health_consecutive_failures": provider.health_consecutive_failures,
        "health_total_checks": provider.health_total_checks,
        "health_success_checks": provider.health_success_checks,
        "health_success_rate": provider.health_success_rate,
    }


def probe_provider_health(
    provider: LLMProvider,
    check_type: str = "periodic",
    probe_model_name: Optional[str] = None,
    extra_details: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """执行一次渠道健康探测并更新运行态。"""
    if not provider_supports_llm_capability(provider.name):
        message = f"Provider '{provider.name}' 不支持 LLM 能力，跳过探测"
        logger.info("[LLM Runtime] skip non-llm provider probe: provider=%s", provider.id)
        return {
            "success": False,
            "skipped": True,
            "provider_id": str(provider.id),
            "provider_name": provider.display_name,
            "error": message,
            "probe": {
                "provider_id": str(provider.id),
                "runtime_status": provider.runtime_status,
                "is_success": False,
                "skipped": True,
                "reason": "non_llm_provider",
            },
        }

    model_name = (probe_model_name or "").strip() or _resolve_probe_model_name(provider)
    if not model_name:
        message = "渠道尚未配置模型，请先添加模型后再测试连接"
        logger.info("[LLM Runtime] skip provider probe without models: provider=%s", provider.id)
        return {
            "success": False,
            "skipped": True,
            "provider_id": str(provider.id),
            "provider_name": provider.display_name,
            "error": message,
            "probe": {
                "provider_id": str(provider.id),
                "runtime_status": provider.runtime_status,
                "is_success": False,
                "skipped": True,
                "reason": "no_models",
            },
        }

    start = time.perf_counter()
    try:
        service = _get_or_create_probe_service(provider, model_name)
        result = service.validate_config()
        latency_ms = int((time.perf_counter() - start) * 1000)

        is_success = bool(result.get("valid"))
        error_message = result.get("error") or ""
        diagnostic = build_probe_failure_diagnostic(
            error=error_message,
            error_code=result.get("error_code"),
            status_code=result.get("status_code"),
            model_name=model_name,
        ) if not is_success else None
        details = {
            "valid": bool(result.get("valid")),
            "details": result.get("details") or {},
            "probe_model_name": model_name,
            "error_code": result.get("error_code"),
            "status_code": result.get("status_code"),
        }
        if extra_details:
            details.update(extra_details)

        feedback = apply_provider_runtime_feedback(
            provider,
            is_success=is_success,
            latency_ms=latency_ms,
            error_message=error_message,
            check_type=check_type,
            details=details,
            persist_log=True,
        )

        return {
            "success": True,
            "provider_id": str(provider.id),
            "provider_name": provider.display_name,
            "probe": feedback,
            "diagnostic": diagnostic,
        }

    except Exception as exc:
        latency_ms = int((time.perf_counter() - start) * 1000)
        message = str(exc)
        diagnostic = build_probe_failure_diagnostic(
            error=message,
            error_code=getattr(exc, "code", None),
            status_code=getattr(exc, "status_code", None),
            model_name=model_name,
        )
        logger.warning("[LLM Runtime] probe failed provider=%s err=%s", provider.id, message)

        feedback = apply_provider_runtime_feedback(
            provider,
            is_success=False,
            latency_ms=latency_ms,
            error_message=message,
            check_type=check_type,
            details={
                "exception": message,
                "probe_model_name": model_name,
                **(extra_details or {}),
            },
            persist_log=True,
        )

        return {
            "success": False,
            "provider_id": str(provider.id),
            "provider_name": provider.display_name,
            "error": message,
            "probe": feedback,
            "diagnostic": diagnostic,
        }


def build_probe_failure_diagnostic(
    *,
    error: str = "",
    error_code: Any = None,
    status_code: Any = None,
    model_name: str = "",
) -> Dict[str, Any]:
    """把上游探测错误归一化为可展示、无敏感原文的运维诊断。"""
    try:
        http_status = int(status_code) if status_code is not None else None
    except (TypeError, ValueError):
        http_status = None
    code = str(error_code or "").strip().upper()
    lowered = str(error or "").lower()

    if http_status in {401, 403} or code in {"AUTH_FAILED", "UNAUTHORIZED", "FORBIDDEN"}:
        stage, label = "authentication", "密钥鉴权"
        summary = "API 密钥未通过服务商鉴权"
        suggestion = "检查密钥是否正确、有效，并确认它有权调用该模型。"
    elif http_status == 429 or code in {"RATE_LIMIT", "RATE_LIMITED"}:
        stage, label = "rate_limit", "调用额度或限流"
        summary = "服务商拒绝了请求，当前额度或调用频率可能已超限"
        suggestion = "检查账户余额、套餐额度和 RPM/TPM 限制，稍后再试。"
    elif (
        code == "MODEL_NOT_FOUND"
        or http_status == 404
        or "model not found" in lowered
        or "unknown model" in lowered
    ):
        stage, label = "model", "模型 ID"
        summary = f"服务商未找到模型 {model_name}" if model_name else "服务商未找到配置的模型"
        suggestion = "从服务商模型列表复制准确的上游模型 ID，并确认该密钥已开通此模型。"
    elif http_status in {400, 405, 415, 422}:
        stage, label = "request", "协议或请求参数"
        summary = "API 地址可访问，但服务商不接受当前探测请求"
        suggestion = "检查服务类型、API 地址和接口协议是否匹配；中转站通常应使用 OpenAI-compatible 地址。"
    elif http_status is not None and http_status >= 500:
        stage, label = "upstream", "上游服务"
        summary = "服务商当前返回服务器错误"
        suggestion = "查看服务商状态页或中转站日志，确认恢复后重新探测。"
    elif any(token in lowered for token in ("dns", "connect", "timeout", "timed out", "tls", "ssl")):
        stage, label = "connection", "网络连接"
        summary = "后端无法连接到配置的 API 地址"
        suggestion = "检查 API 地址、DNS、HTTPS 证书、防火墙和中转站可用性。"
    else:
        stage, label = "unknown", "未知阶段"
        summary = "探测未通过，但上游没有返回可识别的失败类型"
        suggestion = "核对服务类型、API 地址、密钥和模型 ID；仍失败时查看服务商或中转站日志。"

    return {
        "failure_stage": stage,
        "failure_stage_label": label,
        "summary": summary,
        "suggestion": suggestion,
        "error_code": code or None,
        "http_status": http_status,
        "model_name": model_name or None,
    }


def reset_provider_health(provider: LLMProvider) -> None:
    provider.runtime_status = RUNTIME_STATUS_UNKNOWN
    provider.health_consecutive_failures = 0
    provider.health_total_checks = 0
    provider.health_success_checks = 0
    provider.health_last_checked_at = None
    provider.health_last_success_at = None
    provider.health_last_failure_at = None
    provider.health_last_latency_ms = None
    provider.health_avg_latency_ms = 0
    provider.health_last_error = ""
    provider.runtime_cooldown_until = None
    provider.runtime_cooldown_multiplier = 1
    provider.save(
        update_fields=[
            "runtime_status",
            "health_consecutive_failures",
            "health_total_checks",
            "health_success_checks",
            "health_last_checked_at",
            "health_last_success_at",
            "health_last_failure_at",
            "health_last_latency_ms",
            "health_avg_latency_ms",
            "health_last_error",
            "runtime_cooldown_until",
            "runtime_cooldown_multiplier",
            "updated_at",
        ]
    )


def resolve_provider_key_for_report(llm_service, result: Optional[Dict[str, Any]]) -> Any:
    """sync chat / vision 在 chat_with_failover 后，用结果中的 _provider_key_id 解析实际上报的 Key。"""
    if result and result.get('_provider_key_id'):
        from ..models import LLMProviderKey

        try:
            return LLMProviderKey.objects.get(pk=result['_provider_key_id'])
        except LLMProviderKey.DoesNotExist:
            pass
    return getattr(llm_service, 'provider_key', None) if llm_service else None


def report_provider_call_result(
    provider: Optional[LLMProvider],
    *,
    success: bool,
    latency_seconds: Optional[float] = None,
    error_message: str = "",
    error: Optional[Exception] = None,
    provider_key_obj=None,
    tokens: int = 0,
) -> None:
    """基于真实请求结果回写运行态（Provider 级 + Key 级）。

    当 provider_key_obj 存在时，同时更新 Key 级状态：
    - 成功 → record_key_success
    - 失败 → 按 FailoverReason 分类决定 cooldown 或 disable
    """
    if not provider:
        return

    try:
        latency_ms = None
        if latency_seconds is not None and latency_seconds >= 0:
            latency_ms = int(latency_seconds * 1000)

        apply_provider_runtime_feedback(
            provider,
            is_success=success,
            latency_ms=latency_ms,
            error_message=error_message,
            check_type="inline",
            details={},
            persist_log=False,
        )
    except Exception as exc:
        logger.warning("[LLM Runtime] report call result failed provider=%s err=%s", provider.id, exc)

    if provider_key_obj is None:
        return

    try:
        from .key_manager import record_key_success, mark_key_cooldown, mark_key_disabled

        if success:
            record_key_success(provider_key_obj, tokens=tokens)
            return

        from .failover_classifier import classify_failover_reason
        reason = classify_failover_reason(error=error, raw_message=error_message)
        if not reason:
            mark_key_cooldown(provider_key_obj, reason="unknown")
            return

        if reason.should_disable_key:
            mark_key_disabled(provider_key_obj, reason=reason.value)
        elif reason.should_rotate_key:
            mark_key_cooldown(provider_key_obj, reason=reason.value)
    except Exception as exc:
        logger.warning("[LLM Runtime] Key 级状态更新失败 key=%s err=%s", provider_key_obj.id, exc)
