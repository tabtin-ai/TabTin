"""embedding capability_domain 唯一业务入口。"""

from __future__ import annotations

import logging
import time
import uuid as _uuid_mod
from dataclasses import dataclass

from apps.services.llm.services.types import UsageBreakdown, CallTelemetry

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class EmbeddingResult:
    vectors: list[list[float]]
    dimensions: int
    usage: UsageBreakdown
    telemetry: CallTelemetry


def embed_text(
    *,
    scene_key: str,
    texts: list[str],
    user_id: str,
    organization_id: str,
    request_id: str | None = None,
    timeout_sec: int | None = None,
) -> EmbeddingResult:
    """
    embedding capability_domain 唯一业务入口。

    内部流程: SceneCallContext → ModelResolver → BillingPrecheck
              → Provider Call（委托 EmbeddingService） → ResultValidator → UsageRecorder → 返回
    """
    from apps.services.llm.services._runtime.scene_call_context import build_scene_call_context
    from apps.services.llm.services._runtime.model_resolver import resolve_model
    from apps.services.llm.services._runtime.billing_precheck import check_billing
    from apps.services.llm.services._runtime.result_validator import validate_embedding_result
    from apps.services.llm.services._runtime.usage_recorder import record_usage_fact

    req_id = request_id or str(_uuid_mod.uuid4())
    t0 = time.monotonic()

    ctx = build_scene_call_context(
        scene_key=scene_key,
        expected_domain='embedding',
        organization_id=organization_id,
        user_id=user_id,
        request_id=req_id,
    )

    model_info, effective_scope = resolve_model(
        scene_key=scene_key,
        capability_domain='embedding',
        capability_requirements=ctx.scene_spec.capability_requirements,
    )

    check_billing(
        organization_id=organization_id,
        user_id=user_id,
        scene_key=scene_key,
        capability_domain='embedding',
    )

    from apps.rag.services.embedding_service import get_embedding_service
    svc = get_embedding_service(model_info=model_info)

    # v0.1.x Phase 2.5 计费策略：
    # - EmbeddingService._charge_embedding_usage 负责扣 Credits + 写 BillingUsageEvent；
    # - 本入口的 record_usage_fact 只写 LLMUsageFact 审计；
    # - _runtime/usage_recorder._write_billing_event 对 embedding domain skip（详见该函数）。
    # 不再传 skip_charging（原参数会让计费完全消失，是 v0.1.x 初版的 P0 漏洞）。
    if len(texts) == 1:
        vectors = [svc.embed_text(
            texts[0], user_id=user_id, organization_id=organization_id,
        )]
    else:
        vectors = svc.embed_texts(
            texts, user_id=user_id, organization_id=organization_id,
        )

    expected_dim = (ctx.scene_spec.capability_requirements or {}).get('embedding_dimensions')
    validate_embedding_result(
        vectors=vectors,
        expected_dimensions=expected_dim,
        scene_key=scene_key,
    )

    elapsed_ms = int((time.monotonic() - t0) * 1000)
    model_name = getattr(model_info, 'model_name', '') or svc.model
    provider_obj = getattr(model_info, 'provider', None)
    provider_name = ''
    if provider_obj is not None:
        provider_name = (
            getattr(provider_obj, 'provider_key', '')
            or getattr(provider_obj, 'name', '')
        )
    if not provider_name:
        provider_name = svc.provider

    estimated_input_tokens = sum(len(t) // 4 for t in texts) or len(texts)

    model_id = str(getattr(model_info, 'id', '')) if getattr(model_info, 'id', None) else None
    provider_id = (
        str(getattr(provider_obj, 'id', '')) if provider_obj is not None and getattr(provider_obj, 'id', None) else None
    )

    fact = record_usage_fact(
        request_id=req_id,
        scene_key=scene_key,
        capability_domain='embedding',
        effective_provider_scope=effective_scope if isinstance(effective_scope, str) else 'global',
        cost_status='platform_paid',
        status='completed',
        model_id=model_id,
        model_name=model_name,
        provider_id=provider_id,
        provider_key=provider_name,
        organization_id=organization_id,
        user_id=user_id,
        input_tokens=estimated_input_tokens,
        total_tokens=estimated_input_tokens,
        usage_estimated=True,
        latency_ms=elapsed_ms,
    )

    return EmbeddingResult(
        vectors=vectors,
        dimensions=svc.dimensions,
        usage=UsageBreakdown(input_tokens=estimated_input_tokens, total_tokens=estimated_input_tokens, estimated=True),
        telemetry=CallTelemetry(
            fact_id=str(fact.id),
            request_id=req_id,
            scene_key=scene_key,
            capability_domain='embedding',
            model_used=model_name,
            provider_used=provider_name,
            effective_provider_scope=effective_scope if isinstance(effective_scope, str) else 'global',
            prompt_bundle_version=None,
            cost_status='platform_paid',
            latency_ms=elapsed_ms,
            attempt_count=1,
        ),
    )
