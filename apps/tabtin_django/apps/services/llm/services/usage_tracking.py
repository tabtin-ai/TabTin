"""LLM 用量事实埋点服务（v0.1 兼容）。

宪法 v0.1 §5.6 / §6 LLMUsageFact 写入规则：
- 必填字段：request_id / scene_key / capability_domain / effective_provider_scope
  / cost_status / status / occurred_at
- BYOK 主对话：cost_status='byok_self_paid'；total_cost 记"等价平台定价"
- 失败 / 未消耗：cost_status='n_a'

`record_usage_fact_from_dict` 是给业务侧（api.py / llm_tasks.py / agent_event_handler.py
等）的非阻断 wrapper；走 8 个 capability 入口的标准路径请用
`apps.services.llm.services._runtime.usage_recorder.record_usage_fact`。
"""

from __future__ import annotations

from decimal import Decimal
from typing import Optional, Tuple
import logging

from django.utils import timezone

from ..models import LLMModel, LLMUsageFact
from .billing import _safe_int, _safe_decimal

logger = logging.getLogger(__name__)


def classify_error_category(error_code: str, error_message: str) -> str:
    """将错误归类，便于统计报表聚合。"""
    normalized_code = (error_code or '').strip().upper()
    normalized_message = (error_message or '').strip().lower()

    if not normalized_code and not normalized_message:
        return ''

    if normalized_code.startswith('AUTH') or 'invalid api key' in normalized_message or 'unauthorized' in normalized_message:
        return 'auth'
    if normalized_code in {'RATE_LIMIT', '429', 'TOO_MANY_REQUESTS'} or 'rate limit' in normalized_message:
        return 'rate_limit'
    if (
        normalized_code in {'QUOTA_EXCEEDED', 'INSUFFICIENT_BALANCE', 'BILLING_ERROR'}
        or 'quota' in normalized_message
        or 'insufficient' in normalized_message
        or 'balance' in normalized_message
        or 'billing' in normalized_message
    ):
        return 'quota'
    if normalized_code.endswith('TIMEOUT') or 'timeout' in normalized_message or 'timed out' in normalized_message:
        return 'timeout'
    if (
        normalized_code.startswith('NETWORK')
        or 'connection' in normalized_message
        or 'network' in normalized_message
        or 'dns' in normalized_message
    ):
        return 'network'
    if normalized_code.startswith('5') or 'internal server error' in normalized_message:
        return 'provider_5xx'
    return 'other'


def derive_provider_scope(model_instance) -> str:
    """从 model_instance.provider.scope 取实际 provider scope。

    返回 'global' / 'organization' / 'user' 之一；解析失败兜底 'global'。
    """
    if model_instance is None:
        return 'global'
    try:
        scope = getattr(getattr(model_instance, 'provider', None), 'scope', '') or 'global'
        if scope in ('global', 'organization', 'user'):
            return scope
    except Exception:
        pass
    return 'global'


def derive_cost_status(provider_scope: str, status: str) -> str:
    """按 (provider_scope, status) 推断 LLMUsageFact.cost_status。

    宪法 §6.4 + §4.1：
    - status='failed' / 'cancelled' / 'budget_exceeded' → 'n_a'（未真实计费）
    - provider_scope != 'global' → 'byok_self_paid'
    - 其他（global + 成功）→ 'platform_paid'
    """
    if status not in ('completed', 'processing', 'pending'):
        return 'n_a'
    if provider_scope and provider_scope != 'global':
        return 'byok_self_paid'
    return 'platform_paid'


def record_usage_fact_from_dict(
    *,
    request_id: str,
    scene_key: str,
    capability_domain: str = 'chat',
    effective_provider_scope: Optional[str] = None,
    cost_status: Optional[str] = None,
    user_id: str = "",
    organization_id: str = "",
    provider_key: str = "",
    model_name: str = "",
    input_tokens: int = 0,
    output_tokens: int = 0,
    total_tokens: int = 0,
    cache_read_input_tokens: int = 0,
    cache_creation_input_tokens: int = 0,
    duration_sec: float = 0.0,
    asset_count: int = 0,
    input_cost: Optional[object] = None,
    output_cost: Optional[object] = None,
    total_cost: Optional[object] = None,
    status: str = "completed",
    model_id: Optional[str] = None,
    provider_id: Optional[str] = None,
    latency_ms: Optional[int] = None,
    usage_estimated: bool = False,
    prompt_bundle_version: str = "",
    error_code: str = "",
    error_category: str = "",
    has_override_params: bool = False,
) -> LLMUsageFact:
    """以 dict 参数写入 LLMUsageFact，供 capability 入口 / billed_llm_call / 异步 task 等使用。

    必填：request_id / scene_key。其他字段缺失会按宪法 v0.1 兜底：
    - effective_provider_scope 缺失 → 从 model_id 反查 provider.scope（兜底 'global'）
    - cost_status 缺失 → 按 (effective_provider_scope, status) 推算
    - capability_domain 缺失 → 'chat'

    所有 LLMUsageFact 必填字段（scene_key / capability_domain /
    effective_provider_scope / cost_status / occurred_at）保证非空。
    """
    model_obj = None
    provider_obj = None

    if model_id:
        try:
            model_obj = LLMModel.objects.select_related("provider").filter(id=model_id).first()
            if model_obj:
                provider_obj = model_obj.provider
                if not provider_key:
                    provider_key = getattr(provider_obj, "provider_key", "") or ""
                if not model_name:
                    model_name = model_obj.model_name or ""
        except Exception:
            pass

    if not provider_obj and provider_id:
        try:
            from ..models import LLMProvider
            provider_obj = LLMProvider.objects.filter(id=provider_id).first()
        except Exception:
            pass

    safe_total = _safe_int(total_tokens) or (_safe_int(input_tokens) + _safe_int(output_tokens))

    resolved_scope = (effective_provider_scope or "").strip()
    if not resolved_scope:
        resolved_scope = derive_provider_scope(model_obj)
    if resolved_scope not in ("global", "organization", "user"):
        resolved_scope = "global"

    resolved_cost_status = (cost_status or "").strip()
    if not resolved_cost_status:
        resolved_cost_status = derive_cost_status(resolved_scope, status)
    if resolved_cost_status not in ("platform_paid", "byok_self_paid", "n_a"):
        resolved_cost_status = "platform_paid"

    resolved_domain = (capability_domain or "chat").strip() or "chat"

    resolved_input_cost = _safe_decimal(input_cost)
    resolved_output_cost = _safe_decimal(output_cost)
    resolved_total_cost = _safe_decimal(total_cost)

    if not error_category and error_code:
        error_category = classify_error_category(error_code, "")

    defaults = {
        "scene_key": (scene_key or "").strip(),
        "capability_domain": resolved_domain,
        "effective_provider_scope": resolved_scope,
        "cost_status": resolved_cost_status,
        "prompt_bundle_version": (prompt_bundle_version or "").strip(),
        "organization_id": (organization_id.strip() or None) if organization_id else None,
        "user_id": (user_id.strip() or None) if user_id else None,
        "provider": provider_obj,
        "provider_key": provider_key,
        "model": model_obj,
        "model_name": model_name,
        "status": status or "completed",
        "error_code": (error_code or "").strip(),
        "error_category": (error_category or "").strip(),
        "attempt_count": 1,
        "latency_ms": latency_ms,
        "input_tokens": _safe_int(input_tokens),
        "output_tokens": _safe_int(output_tokens),
        "total_tokens": safe_total,
        "cache_read_input_tokens": _safe_int(cache_read_input_tokens),
        "cache_creation_input_tokens": _safe_int(cache_creation_input_tokens),
        "duration_sec": float(duration_sec or 0.0),
        "asset_count": _safe_int(asset_count),
        "usage_estimated": bool(usage_estimated),
        "input_cost": resolved_input_cost,
        "output_cost": resolved_output_cost,
        "total_cost": resolved_total_cost,
        "has_override_params": bool(has_override_params),
        "occurred_at": timezone.now(),
    }

    usage_fact, _ = LLMUsageFact.objects.update_or_create(
        request_id=request_id,
        defaults=defaults,
    )
    return usage_fact


def record_usage_fact_from_dict_safely(
    **kwargs,
) -> None:
    """非阻断版本的 record_usage_fact_from_dict，失败仅记日志。

    business 侧调用方应显式传 scene_key + capability_domain；缺失会兜底但
    Cursor rule `.cursor/rules/ai-capability-discipline.mdc` 会报警。
    """
    if not kwargs.get("request_id"):
        return
    try:
        record_usage_fact_from_dict(**kwargs)
    except Exception as exc:
        logger.warning("写入 LLMUsageFact（from_dict）失败（非阻断）: %s", exc, exc_info=True)


def derive_scope_and_cost_status(
    model_instance, status: str = "completed",
) -> Tuple[str, str]:
    """组合 helper：传 (model_instance, status) 一次返回 (scope, cost_status)。

    业务调用方在已有 model_instance 时用这个最方便：
        scope, cost_status = derive_scope_and_cost_status(model_instance, status)
    """
    scope = derive_provider_scope(model_instance)
    return scope, derive_cost_status(scope, status)
