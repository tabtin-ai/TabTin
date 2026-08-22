"""LLM 管理员 API 共用辅助函数。"""

from typing import Optional, Iterable, Any

import logging
import math
from datetime import datetime, timedelta
from decimal import Decimal

from django.db.models import Q
from django.utils import timezone
from ninja.errors import HttpError

from apps.i18n.response import success_response, error_response_with_status
from apps.tabtinspace.models import Organization

from .models import (
    LLMCredentialDecryptionError,
    LLMProvider,
    LLMModel,
    LLMAdminAuditLog,
    LLMUsageFact,
)
from apps.services.billing.models import BillingBudgetPolicy
from .services import invalidate_models_cache
from .utils.capabilities import resolve_model_capabilities, resolve_model_limits

logger = logging.getLogger(__name__)


def _mask_api_key(api_key: str) -> str:
    if not api_key:
        return ""
    if len(api_key) <= 8:
        return "*" * len(api_key)
    return f"{api_key[:4]}{'*' * (len(api_key) - 8)}{api_key[-4:]}"


def _provider_api_key_preview(provider: LLMProvider) -> tuple[str, str]:
    """Return a safe API key preview and status without leaking secrets."""
    try:
        return _mask_api_key(provider.api_key), "ok"
    except LLMCredentialDecryptionError:
        return "无法解密，请重新录入", "credential_decryption_failed"


def _sanitize_audit_value(key: str, value: Any) -> Any:
    key_lower = key.lower()
    if "api_key" in key_lower:
        return "***"
    return value


def _sanitize_audit_snapshot(snapshot: Optional[dict]) -> dict:
    source = snapshot or {}
    sanitized = {}
    for key, value in source.items():
        sanitized[key] = _sanitize_audit_value(str(key), value)
    return sanitized


def _build_changed_fields(before_data: dict, after_data: dict) -> dict:
    changed = {}
    all_keys = sorted(set(before_data.keys()) | set(after_data.keys()))
    for key in all_keys:
        before_val = before_data.get(key)
        after_val = after_data.get(key)
        if before_val != after_val:
            changed[key] = {
                "before": before_val,
                "after": after_val,
            }
    return changed


def _serialize_audit_log(log: LLMAdminAuditLog) -> dict:
    return {
        "id": str(log.id),
        "operator_id": log.operator_id,
        "operator_username": log.operator_username,
        "action": log.action,
        "target_type": log.target_type,
        "target_id": log.target_id,
        "organization_id": log.organization_id,
        "provider_id": log.provider_id,
        "model_id": log.model_id,
        "changed_fields": log.changed_fields or {},
        "before_data": log.before_data or {},
        "after_data": log.after_data or {},
        "extra_data": log.extra_data or {},
        "created_at": log.created_at.isoformat(),
    }


def _record_admin_audit(
    request,
    *,
    action: str,
    target_type: str,
    target_id: Optional[str] = None,
    organization_id: Optional[str] = None,
    provider_id: Optional[str] = None,
    model_id: Optional[str] = None,
    before_data: Optional[dict] = None,
    after_data: Optional[dict] = None,
    extra_data: Optional[dict] = None,
) -> None:
    operator = getattr(request, "auth", None)
    if not operator:
        return

    try:
        before_snapshot = _sanitize_audit_snapshot(before_data)
        after_snapshot = _sanitize_audit_snapshot(after_data)
        LLMAdminAuditLog.objects.create(
            operator_id=str(getattr(operator, "id", "") or ""),
            operator_username=str(getattr(operator, "username", "") or ""),
            action=action,
            target_type=target_type,
            target_id=target_id or "",
            organization_id=organization_id or None,
            provider_id=provider_id or None,
            model_id=model_id or None,
            changed_fields=_build_changed_fields(before_snapshot, after_snapshot),
            before_data=before_snapshot,
            after_data=after_snapshot,
            extra_data=extra_data or {},
        )
    except Exception as exc:
        logger.warning("写入 LLM 管理审计日志失败（非阻断）: %s", exc)


def _serialize_provider(provider: LLMProvider) -> dict:
    model_count = getattr(provider, "model_count", None)
    if model_count is None:
        # v0.1：LLMModel.provider 反向名为 'models'（related_name='models'，
        # 见 apps/services/llm/models.py:202），Django 不再生成默认 llmmodel_set。
        model_count = provider.models.count()

    api_key_masked, api_key_status = _provider_api_key_preview(provider)

    return {
        "id": str(provider.id),
        "name": provider.name,
        "provider_key": provider.provider_key,
        "display_name": provider.display_name,
        # 返回渠道默认端点；历史数据没有默认值时回退首个模型端点。
        "base_url": _resolve_first_model_base_url(provider),
        "api_key_masked": api_key_masked,
        "api_key_status": api_key_status,
        "scope": provider.scope,
        "organization_id": provider.organization_id,
        "user_id": provider.user_id,
        "priority": provider.priority,
        "rate_limit": provider.rate_limit,
        "routing_enabled": provider.routing_enabled,
        "routing_weight": provider.routing_weight,
        "runtime_status": provider.runtime_status,
        "health_check_enabled": provider.health_check_enabled,
        "health_check_interval_sec": provider.health_check_interval_sec,
        "health_consecutive_failures": provider.health_consecutive_failures,
        "health_total_checks": provider.health_total_checks,
        "health_success_checks": provider.health_success_checks,
        "health_success_rate": provider.health_success_rate,
        "health_last_checked_at": provider.health_last_checked_at.isoformat() if provider.health_last_checked_at else None,
        "health_last_success_at": provider.health_last_success_at.isoformat() if provider.health_last_success_at else None,
        "health_last_failure_at": provider.health_last_failure_at.isoformat() if provider.health_last_failure_at else None,
        "health_last_latency_ms": provider.health_last_latency_ms,
        "health_avg_latency_ms": provider.health_avg_latency_ms,
        "health_last_error": provider.health_last_error,
        # v0.1.x：Provider 支持多 capability_domain（ArrayField）；前端按 tag 列表展示。
        "capability_domains": list(getattr(provider, "capability_domains", None) or []),
        # 兼容旧前端：返回首个 domain 作为 "capability_domain"，下个版本移除
        "capability_domain": (list(getattr(provider, "capability_domains", None) or []) or [""])[0],
        "created_at": provider.created_at.isoformat(),
        "updated_at": provider.updated_at.isoformat(),
        "model_count": model_count,
    }


def _resolve_first_model_base_url(provider) -> str:
    """返回渠道默认端点；历史数据回退下属首个模型的端点。"""
    try:
        default_base_url = getattr(provider, 'default_base_url', '') or ''
        if default_base_url:
            return default_base_url
        # order_by 保证多 model 时返回值稳定，避免 PG 默认顺序导致 UI 列表抖动。
        m = provider.models.order_by('created_at').only('base_url').first()
        return (m.base_url if m else '') or ''
    except Exception:
        return ''


def _serialize_model(model: LLMModel, *, related_scenes_count: Optional[int] = None) -> dict:
    provider = model.provider
    capabilities = model.capabilities_config or {}

    # v0.1：related_scenes_count 表示有多少个 LLMSceneBinding 把本模型作为 primary_model。
    # 默认惰性查询；若调用方已批量预聚合（如 list 端点），可通过 kw 参数显式注入避免 N+1。
    if related_scenes_count is None:
        try:
            from .models import LLMSceneBinding  # 局部 import 避免循环
            related_scenes_count = LLMSceneBinding.objects.filter(
                primary_model_id=model.id,
            ).count()
        except Exception:  # noqa: BLE001 — list 时不要因 binding 表异常炸掉
            related_scenes_count = 0

    return {
        "id": str(model.id),
        "provider_id": str(provider.id),
        "provider_name": provider.name,
        "provider_display_name": provider.display_name,
        "provider_key": provider.provider_key,
        "provider_scope": provider.scope,
        "provider_organization_id": provider.organization_id,
        "provider_user_id": provider.user_id,
        "model_name": model.model_name,
        "display_name": model.display_name,
        "description": model.description,
        "capability_domain": model.capability_domain,
        # v0.1.x Phase 2.5：每个 Model 自带 base_url（Provider.base_url 已删）
        "base_url": model.base_url,
        "context_window_tokens": model.context_window_tokens,
        "max_input_tokens": model.max_input_tokens_resolved,
        "max_output_tokens": model.max_output_tokens_resolved,
        "capabilities_config": capabilities,
        "resolved_capabilities": resolve_model_capabilities(model),
        "resolved_limits": resolve_model_limits(model),
        "billing_type": model.billing_type,
        "input_price_per_1k": float(model.input_price_per_1k),
        "output_price_per_1k": float(model.output_price_per_1k),
        "price_per_request": float(model.price_per_request),
        "price_per_second": float(model.price_per_second),
        "cost_per_1k_tokens": float(model.cost_per_1k_tokens),
        "custom_billing_config": model.custom_billing_config or {},
        "wave_status": model.wave_status,
        "related_scenes_count": related_scenes_count,
        "created_at": model.created_at.isoformat(),
        "updated_at": model.updated_at.isoformat(),
    }


def _resolve_model_runtime_status(
    *,
    model_active: bool,
    provider_runtime_status: str,
    total_requests: int,
    success_rate: float,
    p95_latency_ms: float,
    min_requests: int,
) -> tuple[str, str]:
    """
    根据模型近时窗运行指标计算运行态。

    返回:
    - runtime_status: healthy/degraded/unhealthy/unknown/inactive
    - reason: 触发原因（便于前端展示）
    """
    if not model_active:
        return "inactive", "model_inactive"

    normalized_provider_status = (provider_runtime_status or "unknown").strip().lower()
    if normalized_provider_status == "unhealthy":
        return "unhealthy", "provider_unhealthy"

    if total_requests < min_requests:
        if normalized_provider_status in {"healthy", "degraded"}:
            return normalized_provider_status, "sample_insufficient"
        return "unknown", "sample_insufficient"

    # 成功率优先
    if success_rate < 80.0:
        return "unhealthy", "low_success_rate"
    if success_rate < 92.0:
        return "degraded", "success_rate_degraded"

    # 延迟次优先
    if p95_latency_ms >= 7000:
        return "unhealthy", "high_latency"
    if p95_latency_ms >= 3500:
        return "degraded", "latency_degraded"

    if normalized_provider_status == "degraded":
        return "degraded", "provider_degraded"

    return "healthy", "healthy"


def _serialize_runtime_model(
    model: LLMModel,
    *,
    runtime_status: str,
    status_reason: str,
    total_requests: int,
    completed_requests: int,
    failed_requests: int,
    success_rate: float,
    avg_latency_ms: float,
    p95_latency_ms: float,
    total_tokens: int,
    total_cost: float,
    last_occurred_at: Optional[datetime],
) -> dict:
    provider = model.provider
    return {
        "id": str(model.id),
        "provider_id": str(provider.id),
        "provider_display_name": provider.display_name,
        "provider_runtime_status": provider.runtime_status,
        "model_name": model.model_name,
        "display_name": model.display_name,
        "capability_domain": model.capability_domain,
        "wave_status": model.wave_status,
        "runtime_status": runtime_status,
        "status_reason": status_reason,
        "total_requests": total_requests,
        "completed_requests": completed_requests,
        "failed_requests": failed_requests,
        "success_rate": round(success_rate, 2),
        "avg_latency_ms": round(avg_latency_ms, 2),
        "p95_latency_ms": round(p95_latency_ms, 2),
        "total_tokens": total_tokens,
        "total_cost": round(total_cost, 6),
        "last_occurred_at": last_occurred_at.isoformat() if last_occurred_at else None,
        "updated_at": model.updated_at.isoformat() if model.updated_at else None,
    }


def _parse_iso_datetime(value: Optional[str], *, field_name: str) -> Optional[datetime]:
    normalized = (value or "").strip()
    if not normalized:
        return None
    try:
        parsed = datetime.fromisoformat(normalized.replace("Z", "+00:00"))
    except ValueError as exc:
        raise HttpError(400, f"{field_name} 不是合法的 ISO 时间") from exc
    if timezone.is_naive(parsed):
        parsed = timezone.make_aware(parsed, timezone.get_current_timezone())
    return parsed


def _resolve_usage_time_window(start_time: Optional[str], end_time: Optional[str]) -> tuple[datetime, datetime]:
    now = timezone.now()
    resolved_end = _parse_iso_datetime(end_time, field_name="end_time") or now
    resolved_start = _parse_iso_datetime(start_time, field_name="start_time") or (resolved_end - timedelta(hours=24))
    if resolved_start > resolved_end:
        raise HttpError(400, "start_time 不能晚于 end_time")
    return resolved_start, resolved_end


_COST_STATUS_VALUES = {"platform_paid", "byok_self_paid", "n_a"}
_PROVIDER_SCOPE_VALUES = {"global", "organization", "user"}


def _build_usage_fact_queryset(
    *,
    start_at: datetime,
    end_at: datetime,
    scope: Optional[str],
    organization_id: Optional[str],
    user_id: Optional[str],
    provider_id: Optional[str],
    model_id: Optional[str],
    use_case: Optional[str] = None,
    source_app: Optional[str] = None,
    scene_key: Optional[str] = None,
    capability_domain: Optional[str] = None,
    cost_status: Optional[str] = None,
    effective_provider_scope: Optional[str] = None,
) -> Any:
    query = LLMUsageFact.objects.select_related("provider", "model").filter(
        occurred_at__gte=start_at,
        occurred_at__lte=end_at,
    )

    normalized_scope = (scope or "").strip().lower()
    if normalized_scope:
        if normalized_scope not in {"all", "global", "organization"}:
            raise HttpError(400, "scope 必须为 all/global/organization")
        if normalized_scope == "global":
            query = query.filter(Q(organization_id__isnull=True) | Q(organization_id=""))
        elif normalized_scope == "organization":
            if not organization_id:
                raise HttpError(400, "scope=organization 时 organization_id 必填")
            query = query.filter(organization_id=organization_id)

    if organization_id and normalized_scope != "organization":
        query = query.filter(organization_id=organization_id)
    if user_id:
        query = query.filter(user_id=user_id)
    if provider_id:
        query = query.filter(provider_id=provider_id)
    if model_id:
        query = query.filter(model_id=model_id)
    # v0.1：use_case / source_app 字段在 0022 已删，改用 scene_key / capability_domain。
    # 旧调用方传入 use_case / source_app 时 silently ignored（兼容期保留形参）。
    if scene_key:
        query = query.filter(scene_key=scene_key)
    if capability_domain:
        query = query.filter(capability_domain=capability_domain)

    normalized_cost_status = (cost_status or "").strip().lower()
    if normalized_cost_status:
        if normalized_cost_status not in _COST_STATUS_VALUES:
            raise HttpError(
                400,
                "cost_status 必须为 platform_paid / byok_self_paid / n_a",
            )
        query = query.filter(cost_status=normalized_cost_status)

    normalized_eff_scope = (effective_provider_scope or "").strip().lower()
    if normalized_eff_scope:
        if normalized_eff_scope not in _PROVIDER_SCOPE_VALUES:
            raise HttpError(
                400,
                "effective_provider_scope 必须为 global / organization / user",
            )
        query = query.filter(effective_provider_scope=normalized_eff_scope)

    return query


def _calculate_percentile(values: list[int], percentile: int) -> float:
    valid_values = sorted([value for value in values if value is not None])
    if not valid_values:
        return 0.0
    if len(valid_values) == 1:
        return float(valid_values[0])
    position = (len(valid_values) - 1) * (percentile / 100.0)
    lower = int(math.floor(position))
    upper = int(math.ceil(position))
    if lower == upper:
        return float(valid_values[lower])
    lower_value = valid_values[lower]
    upper_value = valid_values[upper]
    weight = position - lower
    return float(lower_value + (upper_value - lower_value) * weight)


def _safe_float(value: Any) -> float:
    if value is None:
        return 0.0
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _safe_int(value: Any) -> int:
    if value is None:
        return 0
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def _normalize_month_start(month: Optional[str]) -> datetime:
    """将 YYYY-MM 规范化为当月起始时刻。"""
    if not month:
        now = timezone.now()
        return now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    normalized = month.strip()
    try:
        parsed = datetime.strptime(normalized, "%Y-%m")
    except ValueError as exc:
        raise HttpError(400, "month 格式必须为 YYYY-MM") from exc
    return timezone.make_aware(datetime(parsed.year, parsed.month, 1, 0, 0, 0), timezone.get_current_timezone())


def _next_month_start(month_start: datetime) -> datetime:
    if month_start.month == 12:
        return month_start.replace(year=month_start.year + 1, month=1)
    return month_start.replace(month=month_start.month + 1)


def _safe_decimal(value: Any) -> Decimal:
    if value is None:
        return Decimal("0")
    try:
        return Decimal(str(value))
    except Exception:
        return Decimal("0")


def _resolve_budget_status(
    *,
    included_credits: Decimal,
    utilization_percent: Decimal,
    warning_threshold_percent: Decimal,
    critical_threshold_percent: Decimal,
    policy_active: bool,
) -> str:
    if not policy_active:
        return "disabled"
    if included_credits <= 0:
        return "no_budget"
    if utilization_percent >= critical_threshold_percent:
        return "critical"
    if utilization_percent >= warning_threshold_percent:
        return "warning"
    return "normal"


def _serialize_usage_budget_policy(policy: Optional[BillingBudgetPolicy]) -> dict:
    warning = _safe_decimal(getattr(policy, "warning_threshold_percent", Decimal("80")))
    critical = _safe_decimal(getattr(policy, "critical_threshold_percent", Decimal("100")))
    is_active = bool(getattr(policy, "is_active", True))
    return {
        "warning_threshold_percent": float(warning),
        "critical_threshold_percent": float(critical),
        "is_active": is_active,
        "updated_at": policy.updated_at.isoformat() if policy and policy.updated_at else None,
    }


def _validate_provider_scope(scope: str, organization_id: Optional[str], user_id: Optional[str]) -> None:
    if scope not in {"global", "organization", "user"}:
        raise HttpError(400, "scope 必须为 global / organization / user")
    if scope == "organization" and not organization_id:
        raise HttpError(400, "scope=organization 时 organization_id 必填")
    if scope == "user" and not user_id:
        raise HttpError(400, "scope=user 时 user_id 必填")
    if scope == "global" and (organization_id or user_id):
        raise HttpError(400, "scope=global 时不允许传 organization_id 或 user_id")


def _clear_organization_default_model_refs(model_ids: Iterable[str]) -> int:
    """
    清理组织 settings 中引用即将删除模型的主 / 子 Agent 默认模型。
    """
    normalized_ids = [str(model_id) for model_id in model_ids if model_id]
    if not normalized_ids:
        return 0

    updated_count = 0
    try:
        for model_id in normalized_ids:
            organizations = Organization.objects.filter(
                Q(settings__llm_default_model_id=model_id)
                | Q(settings__llm_subagent_model_id=model_id)
            )
            for organization in organizations:
                settings = organization.settings or {}
                changed = False
                if settings.get("llm_default_model_id") == model_id:
                    settings.pop("llm_default_model_id", None)
                    changed = True
                if settings.get("llm_subagent_model_id") == model_id:
                    settings.pop("llm_subagent_model_id", None)
                    changed = True
                if not changed:
                    continue
                organization.settings = settings
                organization.save(update_fields=["settings", "updated_at"])
                updated_count += 1
    except Exception as exc:
        logger.warning("清理组织默认模型引用失败（非阻断）: %s", exc)
    return updated_count


def _invalidate_provider_related_cache(provider: LLMProvider) -> None:
    invalidate_models_cache(organization_id=provider.organization_id, user_id=provider.user_id)
    invalidate_models_cache()
    try:
        from apps.services.llm.litellm_config import invalidate_litellm_config_cache
        model_ids = list(provider.models.values_list("id", flat=True))
        for mid in model_ids:
            invalidate_litellm_config_cache(str(mid))
    except Exception:
        logger.debug("litellm_config cache invalidation for provider failed", exc_info=True)
    _invalidate_speech_config_cache()


def _invalidate_model_related_cache(model: LLMModel) -> None:
    provider = model.provider
    invalidate_models_cache(organization_id=provider.organization_id, user_id=provider.user_id)
    invalidate_models_cache()
    try:
        from apps.services.llm.litellm_config import invalidate_litellm_config_cache
        invalidate_litellm_config_cache(str(model.id))
    except Exception:
        logger.debug("litellm_config cache invalidation failed", exc_info=True)
    # v0.1：mode 字段已删（0022），改用 capability_domain 判定语音模型。
    if model.capability_domain in ("asr", "tts"):
        _invalidate_speech_config_cache()


def _invalidate_speech_config_cache() -> None:
    """联动清除 Speech 模块的配置缓存，使 API key 等变更立即生效。"""
    try:
        from apps.services.speech._config_cache import invalidate
        invalidate()
    except Exception as exc:
        logger.debug("清除 speech config cache 失败（非阻断）: %s", exc)
