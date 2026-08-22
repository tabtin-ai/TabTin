"""
UsageRecorder — Provider attempt fact 与最终用户结算

record_usage_fact(*) 必填参数签名
BYOK 路径不写 BillingUsageEvent
Legacy caller 的 BillingUsageEvent 继续使用 'llm_usage:{request_id}'；
stable invocation 使用统一的 ai-scene-settlement:v1 key。
"""

from __future__ import annotations

import logging
from decimal import Decimal
from typing import TYPE_CHECKING

from django.utils import timezone

from apps.services.llm.services.types import ProviderScope, CostStatus

if TYPE_CHECKING:
    from apps.services.llm.models import LLMUsageFact
    from apps.services.llm.services._runtime.invocation import SettlementIdentity

logger = logging.getLogger(__name__)


def record_usage_fact(
    *,
    request_id: str,
    scene_key: str,
    capability_domain: str,
    effective_provider_scope: ProviderScope,
    cost_status: CostStatus,
    status: str,
    provider_id: str | None = None,
    provider_key: str = '',
    model_id: str | None = None,
    model_name: str = '',
    organization_id: str = '',
    user_id: str = '',
    input_tokens: int = 0,
    output_tokens: int = 0,
    total_tokens: int = 0,
    cache_read_input_tokens: int = 0,
    cache_creation_input_tokens: int = 0,
    duration_sec: float = 0.0,
    asset_count: int = 0,
    usage_estimated: bool = False,
    input_cost: Decimal = Decimal('0'),
    output_cost: Decimal = Decimal('0'),
    total_cost: Decimal = Decimal('0'),
    latency_ms: int | None = None,
    attempt_count: int = 1,
    error_code: str = '',
    error_category: str = '',
    prompt_bundle_version: str = '',
    has_override_params: bool = False,
    invocation_id: str | None = None,
    attempt_id: str | None = None,
    stable_invocation: bool | None = None,
    execution_key: str = "",
    business_object_type: str = "",
    business_object_id: str = "",
    run_id: str = "",
    task_id: str = "",
    parent_invocation_id: str = "",
    payer: str | None = None,
    model_source: str | None = None,
    result_status: str | None = None,
    settlement_status: str | None = None,
    settlement_key_version: str | None = None,
    retry_source: str = "",
    settle: bool = True,
    settlement_identity: "SettlementIdentity | None" = None,
) -> "LLMUsageFact":
    """写入一次 Provider attempt；legacy caller 默认维持同步结算。"""
    from apps.services.llm.models import LLMUsageFact

    fact = LLMUsageFact.objects.create(
        request_id=request_id,
        scene_key=scene_key,
        capability_domain=capability_domain,
        effective_provider_scope=effective_provider_scope,
        cost_status=cost_status,
        status=status,
        provider_id=provider_id,
        provider_key=provider_key,
        model_id=model_id,
        model_name=model_name,
        organization_id=organization_id or None,
        user_id=user_id or None,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        total_tokens=total_tokens,
        cache_read_input_tokens=cache_read_input_tokens,
        cache_creation_input_tokens=cache_creation_input_tokens,
        duration_sec=duration_sec,
        asset_count=asset_count,
        usage_estimated=usage_estimated,
        input_cost=input_cost,
        output_cost=output_cost,
        total_cost=total_cost,
        latency_ms=latency_ms,
        attempt_count=attempt_count,
        error_code=error_code,
        error_category=error_category,
        prompt_bundle_version=prompt_bundle_version,
        has_override_params=has_override_params,
        invocation_id=invocation_id,
        attempt_id=attempt_id,
        stable_invocation=stable_invocation,
        execution_key=execution_key or "",
        business_object_type=business_object_type or "",
        business_object_id=business_object_id or "",
        run_id=run_id or "",
        task_id=task_id or "",
        parent_invocation_id=parent_invocation_id or "",
        payer=payer,
        model_source=model_source,
        result_status=result_status,
        settlement_status=settlement_status,
        settlement_key_version=settlement_key_version,
        retry_source=retry_source or "",
        occurred_at=timezone.now(),
    )
    _record_attempt_observability(fact)
    if settlement_status in {"not_required", "skipped"}:
        _record_settlement_observability(
            fact,
            status=settlement_status,
            key_version=settlement_key_version,
        )

    if settle and cost_status == 'platform_paid' and status != 'failed':
        if settlement_identity is None:
            from apps.services.llm.services._runtime.invocation import SettlementIdentity

            settlement_identity = SettlementIdentity(
                idempotency_key=f"llm_usage:{request_id}",
                version="legacy_request_id",
                stable=False,
            )
        settle_usage_fact(fact=fact, settlement_identity=settlement_identity)

    return fact


def settle_usage_fact(
    *,
    fact: "LLMUsageFact",
    settlement_identity: "SettlementIdentity",
    funding_mode: str | None = None,
) -> dict | None:
    """在结果有效后结算一个 attempt；原子幂等由 BillingGateway 继续负责。"""
    if fact.cost_status != "platform_paid" or fact.status == "failed":
        _update_settlement_status(
            fact,
            status="not_required",
            key_version=settlement_identity.version,
        )
        return None

    try:
        result = _settle_llm_billing(
            request_id=fact.request_id,
            idempotency_key=settlement_identity.idempotency_key,
            capability_domain=fact.capability_domain,
            scene_key=fact.scene_key,
            organization_id=fact.organization_id or "",
            user_id=fact.user_id or "",
            provider_id=str(fact.provider_id) if fact.provider_id else None,
            provider_key=fact.provider_key,
            model_id=str(fact.model_id) if fact.model_id else None,
            model_name=fact.model_name,
            input_tokens=fact.input_tokens,
            output_tokens=fact.output_tokens,
            input_cost=fact.input_cost,
            output_cost=fact.output_cost,
            total_cost=fact.total_cost,
            total_tokens=fact.total_tokens,
            duration_sec=fact.duration_sec,
            asset_count=fact.asset_count,
            funding_mode=funding_mode,
        )
    except Exception:
        _update_settlement_status(
            fact,
            status="failed",
            key_version=settlement_identity.version,
        )
        _record_settlement_observability(
            fact,
            status="failed",
            key_version=settlement_identity.version,
        )
        raise

    _update_settlement_status(
        fact,
        status="settled",
        key_version=settlement_identity.version,
    )
    _record_settlement_observability(
        fact,
        status="settled",
        key_version=settlement_identity.version,
    )
    return result


def mark_usage_result(
    fact: "LLMUsageFact",
    *,
    result_status: str,
    settlement_status: str | None = None,
) -> None:
    """记录已有 validator 的判定，不改变业务校验规则。"""
    fact.result_status = result_status
    update_fields = ["result_status"]
    if settlement_status is not None:
        fact.settlement_status = settlement_status
        update_fields.append("settlement_status")
    fact.save(update_fields=update_fields)
    if settlement_status in {"not_required", "skipped"}:
        _record_settlement_observability(
            fact,
            status=settlement_status,
            key_version=getattr(fact, "settlement_key_version", None),
        )


def _update_settlement_status(
    fact: "LLMUsageFact",
    *,
    status: str,
    key_version: str,
) -> None:
    fact.settlement_status = status
    fact.settlement_key_version = key_version
    fact.save(update_fields=["settlement_status", "settlement_key_version"])


def _record_attempt_observability(fact: "LLMUsageFact") -> None:
    try:
        from apps.services.llm.services.llm_metrics import ai_scene_attempt_total

        ai_scene_attempt_total.labels(scene=fact.scene_key, status=fact.status).inc()
    except Exception:
        pass
    logger.info(
        "ai_scene_attempt",
        extra={
            "event": "ai_scene_attempt",
            "scene_key": fact.scene_key,
            "execution_key": getattr(fact, "execution_key", None),
            "invocation_id": getattr(fact, "invocation_id", None),
            "attempt_id": getattr(fact, "attempt_id", None),
            "stable_invocation": getattr(fact, "stable_invocation", None),
            "provider_status": fact.status,
            "result_status": getattr(fact, "result_status", None),
            "settlement_status": getattr(fact, "settlement_status", None),
            "settlement_key_version": getattr(fact, "settlement_key_version", None),
            "retry_source": getattr(fact, "retry_source", None),
            "run_id": getattr(fact, "run_id", None),
            "task_id": getattr(fact, "task_id", None),
            "request_id": fact.request_id,
        },
    )


def _record_settlement_observability(
    fact: "LLMUsageFact",
    *,
    status: str,
    key_version: str | None,
) -> None:
    try:
        from apps.services.llm.services.llm_metrics import ai_scene_settlement_total

        ai_scene_settlement_total.labels(scene=fact.scene_key, status=status).inc()
    except Exception:
        pass
    logger.info(
        "ai_scene_settlement",
        extra={
            "event": "ai_scene_settlement",
            "scene_key": fact.scene_key,
            "execution_key": getattr(fact, "execution_key", None),
            "invocation_id": getattr(fact, "invocation_id", None),
            "attempt_id": getattr(fact, "attempt_id", None),
            "stable_invocation": getattr(fact, "stable_invocation", None),
            "settlement_key_version": key_version,
            "settlement_status": status,
            "provider_status": fact.status,
            "result_status": getattr(fact, "result_status", None),
            "retry_source": getattr(fact, "retry_source", None),
            "run_id": getattr(fact, "run_id", None),
            "task_id": getattr(fact, "task_id", None),
            "request_id": fact.request_id,
        },
    )


# BillingUsageEvent 的 quantity/unit 按 capability_domain 决定计量口径。
# unit_price 由 amount/quantity 反推，仅用于 audit；正式定价应查 MeterPricing 表。
#
# v0.1.x Phase 2.5：embedding 不在本表——它走 EmbeddingService._charge_embedding_usage
# 单独记账（unit='k_tokens'），_write_billing_event 在入口处对 embedding domain 直接 return。
# 这里仅枚举 token 计量的两个域：chat / vision。
_TOKEN_DOMAINS = frozenset({'chat', 'vision'})
_DURATION_DOMAINS = frozenset({'asr', 'tts', 'video_gen', 'audio_gen'})
_ASSET_DOMAINS = frozenset({'image_gen'})


def _resolve_billing_metric(
    capability_domain: str,
    total_tokens: int,
    duration_sec: float,
    asset_count: int,
) -> tuple[Decimal, str]:
    """根据能力域返回 (quantity, unit) 二元组。"""
    if capability_domain in _TOKEN_DOMAINS:
        return Decimal(str(total_tokens or 0)), 'token'
    if capability_domain in _DURATION_DOMAINS:
        return Decimal(str(duration_sec or 0)), 'sec'
    if capability_domain in _ASSET_DOMAINS:
        return Decimal(str(asset_count or 0)), 'asset'
    return Decimal('0'), 'unit'


def _settle_llm_billing(
    *,
    request_id: str,
    idempotency_key: str | None = None,
    capability_domain: str,
    scene_key: str,
    organization_id: str,
    user_id: str,
    provider_id: str | None,
    provider_key: str,
    model_id: str | None,
    model_name: str,
    input_tokens: int,
    output_tokens: int,
    input_cost: Decimal,
    output_cost: Decimal,
    total_cost: Decimal,
    total_tokens: int,
    duration_sec: float,
    asset_count: int,
    funding_mode: str | None = None,
) -> dict | None:
    """按 domain 结算 LLM 用量；调用方负责提供业务稳定的幂等键。

    v0.1.x Phase 2.5：embedding domain 由 ``EmbeddingService._charge_embedding_usage``
    负责扣费 + 写 BillingUsageEvent（unit='k_tokens'），本函数对 embedding skip，
    避免双写形成"unit=token + unit=k_tokens"的口径错乱。
    """
    # v0.1.x Phase 2.5：embedding 走老路径单一记账，新流水线只做 LLMUsageFact 审计。
    if capability_domain == 'embedding':
        return
    if capability_domain not in _TOKEN_DOMAINS:
        logger.debug("非 LLM token domain 跳过 BillingGateway 结算: %s", capability_domain)
        return
    try:
        from apps.services.billing.services.gateway import BillingGateway

        resolved_idempotency_key = (
            str(idempotency_key or "").strip() or f"llm_usage:{request_id}"
        )
        if total_tokens > 0 and input_tokens <= 0 and output_tokens <= 0:
            input_tokens = total_tokens
            input_cost = total_cost
        input_price = (
            (input_cost / Decimal(input_tokens)) * Decimal(1000)
            if input_tokens > 0 and input_cost > 0
            else Decimal("0")
        )
        output_price = (
            (output_cost / Decimal(output_tokens)) * Decimal(1000)
            if output_tokens > 0 and output_cost > 0
            else Decimal("0")
        )
        return BillingGateway.settle_llm_usage(
            organization_id=organization_id,
            user_id=user_id,
            actual_tokens=total_tokens or input_tokens + output_tokens,
            model_id=model_id or "",
            provider_id=provider_id or "",
            idempotency_key=resolved_idempotency_key,
            model_config={
                "provider_key": provider_key,
                "model_name": model_name,
                "input_price_per_1k": str(input_price),
                "output_price_per_1k": str(output_price),
                "organization_id": organization_id,
                "model_id": model_id or "",
                "provider_id": provider_id or "",
            },
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            context={
                "biz_id": f"{scene_key}:{request_id}",
                "request_id": request_id,
                "scene_key": scene_key,
                "source": f"v01_{capability_domain}",
                "capability_domain": capability_domain,
                "total_cost": str(total_cost),
                "duration_sec": duration_sec,
                "asset_count": asset_count,
                "funding_mode": funding_mode or "",
            },
        )
    except ImportError:
        logger.exception("BillingGateway 未就绪，LLM 结算失败")
        raise
    except Exception as e:
        logger.warning("BillingGateway LLM 结算失败: %s", e)
        raise
