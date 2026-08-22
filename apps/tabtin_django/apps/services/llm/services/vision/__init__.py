"""vision capability_domain 唯一业务入口。"""

from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Callable, Literal, Mapping

from apps.services.llm.scenes.exceptions import InvalidVariables, SceneCallError
from apps.services.llm.services.types import UsageBreakdown, CallTelemetry

logger = logging.getLogger(__name__)

if TYPE_CHECKING:
    from apps.services.llm.services._runtime.invocation import SceneInvocationContext


@dataclass(frozen=True)
class VisionParseResult:
    content: str | dict
    usage: UsageBreakdown
    telemetry: CallTelemetry
    finish_reason: Literal["stop", "length", "content_filter", "error"]


def parse(
    *,
    scene_key: str,
    image: bytes | str | list[bytes | str],
    variables: Mapping[str, Any] | None = None,
    user_id: str,
    organization_id: str,
    response_format: Literal["text", "json_object"] = "text",
    request_id: str | None = None,
    timeout_sec: int | None = None,
    invocation_context: "SceneInvocationContext | None" = None,
    result_validator: Callable[[str | dict], None] | None = None,
    selected_model_id: str | None = None,
) -> VisionParseResult:
    """
    vision capability_domain 唯一业务入口。

    内部流程: Invocation/Attempt → ScenePolicy payer → ModelResolver
              → user payer 单次 BillingPrecheck → Provider → UsageRecorder
              → ResultValidator → user payer Settlement → 返回
    """
    from apps.services.llm.services._runtime.scene_call_context import build_scene_call_context
    from apps.services.llm.services._runtime.model_resolver import resolve_model
    from apps.services.llm.services._runtime.billing_precheck import check_billing
    from apps.services.llm.services._runtime.invocation import prepare_scene_invocation
    from apps.services.llm.services._runtime.result_validator import validate_vision_result
    from apps.services.llm.services._runtime.usage_recorder import (
        mark_usage_result,
        record_usage_fact,
        settle_usage_fact,
    )
    from apps.services.llm.scenes.policy import (
        ScenePayer,
        resolve_runtime_scene_payer,
    )

    t0 = time.monotonic()
    invocation = prepare_scene_invocation(
        scene_key=scene_key,
        organization_id=organization_id,
        user_id=user_id,
        selected_model_id=selected_model_id,
        invocation_context=invocation_context,
    )
    attempt = invocation.start_attempt(request_id=request_id)
    req_id = attempt.request_id
    scene_payer = resolve_runtime_scene_payer(scene_key)
    is_platform_payer = scene_payer is ScenePayer.PLATFORM

    ctx = build_scene_call_context(
        scene_key=scene_key,
        expected_domain='vision',
        organization_id=organization_id,
        user_id=user_id,
        request_id=req_id,
        variables=variables,
    )

    from apps.services.llm.services._runtime.byok_resolver import (
        create_exact_byok_runtime,
        map_byok_provider_error,
        resolve_scene_execution,
    )
    execution = resolve_scene_execution(
        scene_key=scene_key,
        payer=scene_payer,
        selected_model_id=selected_model_id,
        organization_id=organization_id,
        user_id=user_id,
        capability_domain="vision",
        capability_requirements=ctx.scene_spec.capability_requirements,
    )
    is_byok = execution.model_source.value == "byok"
    if is_byok:
        model_info, effective_scope = execution.model, execution.provider_scope
    else:
        model_info, effective_scope = resolve_model(
            scene_key=scene_key,
            capability_domain='vision',
            capability_requirements=ctx.scene_spec.capability_requirements,
        )

    from apps.services.llm.scenes.shadow import (
        RuntimeScenePolicySnapshot,
        resolve_and_record_scene_policy_shadow,
    )
    resolve_and_record_scene_policy_shadow(
        scene_key=scene_key,
        runtime=RuntimeScenePolicySnapshot(
            payer=scene_payer,
            provider_scope=effective_scope,
            resolved_model=getattr(model_info, 'model_name', None),
            billing_required=not is_platform_payer,
            fallback_policy=execution.fallback_policy,
            execution_key=invocation.execution_key,
        ),
        request_id=req_id,
        organization_id=organization_id,
    )

    image_input = image[0] if isinstance(image, list) else image

    if is_byok:
        byok_runtime = create_exact_byok_runtime(
            execution,
            invocation_id=invocation.invocation_id,
            scene_key=scene_key,
        )
        execution = byok_runtime.execution
        service = byok_runtime.service
    else:
        from apps.services.llm.services.factory import get_llm_service
        service = get_llm_service(
            model_id=str(model_info.id) if hasattr(model_info, 'id') else None,
            organization_id=organization_id,
            user_id=user_id,
        )

    if isinstance(image_input, bytes):
        import base64
        b64 = base64.b64encode(image_input).decode()
        image_url = f"data:image/jpeg;base64,{b64}"
    else:
        image_url = image_input

    from apps.services.llm.scenes.registry import SCENES
    scene_spec = SCENES.get(scene_key)
    prompt_text = ""
    # v0.1 §5.6：vision domain 也写 prompt_bundle_version。
    # 业务 scene（如 vision_parse_document）必有 bundle，system scene（理论上 vision
    # 没有 system scene）不要求；render 失败时 prompt_bundle_version='' 兜底。
    prompt_bundle_version = ""
    if scene_spec and not scene_spec.is_system:
        from apps.services.llm.prompts.registry import PromptRegistry
        rendered = PromptRegistry.render(scene_key, variables=variables or {})
        prompt_text = rendered.user or ""
        prompt_bundle_version = getattr(getattr(rendered, "bundle", None), "version_hash", "") or ""
        if not prompt_text:
            raise InvalidVariables(
                f"PromptRegistry.render 返回空 prompt: scene_key='{scene_key}'",
                scene_key=scene_key,
            )

    messages = [
        {
            "role": "user",
            "content": [
                {"type": "text", "text": prompt_text},
                {
                    "type": "image_url",
                    "image_url": {"url": image_url, "detail": "high"},
                },
            ],
        },
    ]

    model_name = model_info.model_name if hasattr(model_info, 'model_name') else str(model_info)
    provider_name = getattr(getattr(model_info, 'provider', None), 'provider_key', '') or ''
    _chat_kwargs = dict(
        messages=messages,
        model=model_name,
        max_tokens=8192,
        temperature=0.1,
    )

    image_count = len(image) if isinstance(image, list) else 1
    estimated_input_tokens = max(0, len(prompt_text or "") // 4) + image_count * 1024
    if not is_platform_payer and not is_byok:
        check_billing(
            organization_id=organization_id,
            user_id=user_id,
            scene_key=scene_key,
            capability_domain='vision',
            estimated_tokens=estimated_input_tokens + 8192,
            model_id=str(model_info.id) if hasattr(model_info, 'id') else None,
            context={
                "request_id": req_id,
                "idempotency_key": attempt.settlement_identity.idempotency_key,
                "source": "vision_parse",
                "invocation_id": invocation.invocation_id,
                "stable_invocation": invocation.stable_invocation,
                "funding_mode": invocation.funding_mode,
            },
        )

    try:
        response = service.chat(**_chat_kwargs)
        if is_byok and isinstance(response, dict) and response.get("success") is False:
            raise RuntimeError(
                f"{response.get('error_code', '')} {response.get('error', '')}".strip()
                or "BYOK vision provider failed"
            )
    except Exception as exc:
        elapsed_ms = int((time.monotonic() - t0) * 1000)
        logger.error("vision_service.parse failed: %s", exc)
        # v0.1 §3 BYOK 边界：vision 入口走 ModelResolver 强制 scope='global'，
        # effective_scope 由 ModelResolver 返回（始终是 'global'）。失败路径
        # cost_status='n_a' 不写 BillingUsageEvent。
        record_usage_fact(
            request_id=req_id,
            invocation_id=invocation.invocation_id,
            attempt_id=attempt.attempt_id,
            stable_invocation=invocation.stable_invocation,
            scene_key=scene_key,
            execution_key=invocation.execution_key,
            capability_domain='vision',
            effective_provider_scope=effective_scope,
            cost_status='n_a',
            status='failed',
            model_id=str(model_info.id) if hasattr(model_info, 'id') else None,
            model_name=model_name,
            provider_id=(
                str(model_info.provider_id)
                if getattr(model_info, "provider_id", None)
                else None
            ),
            provider_key=provider_name,
            organization_id=organization_id,
            user_id=user_id,
            latency_ms=elapsed_ms,
            prompt_bundle_version=prompt_bundle_version,
            error_code=type(exc).__name__,
            business_object_type=invocation.business_object_type,
            business_object_id=invocation.business_object_id,
            run_id=invocation.run_id,
            task_id=invocation.task_id,
            parent_invocation_id=invocation.parent_invocation_id,
            payer=scene_payer.value,
            model_source="byok" if is_byok else "official",
            result_status="invalid",
            settlement_status=(
                "not_required" if is_platform_payer or is_byok else "skipped"
            ),
            settlement_key_version=attempt.settlement_identity.version,
            retry_source=invocation.retry_source,
            settle=False,
        )
        if is_byok:
            raise map_byok_provider_error(exc, scene_key=scene_key) from exc
        raise SceneCallError(
            f"vision provider call failed: {exc}",
            scene_key=scene_key,
        ) from exc

    elapsed_ms = int((time.monotonic() - t0) * 1000)

    cost_data: dict = {}
    if isinstance(response, dict):
        choices = response.get("choices", [])
        raw_content = ""
        usage_data = response.get("usage", {})
        cost_data = response.get("cost") or {}
        if choices:
            raw_content = choices[0].get("message", {}).get("content", "")
        elif "content" in response:
            raw_content = response["content"]
    elif hasattr(response, "content"):
        raw_content = response.content
        usage_data = getattr(response, "usage", {}) or {}
        cost_data = getattr(response, "cost", {}) or {}
    else:
        raw_content = str(response)
        usage_data = {}

    if response_format == "json_object" and isinstance(raw_content, str):
        try:
            parsed = json.loads(raw_content)
            content_out = parsed
        except json.JSONDecodeError:
            content_out = raw_content
    else:
        content_out = raw_content

    input_tokens = int(usage_data.get("prompt_tokens", 0) or usage_data.get("input_tokens", 0) or 0) if isinstance(usage_data, dict) else 0
    output_tokens = int(usage_data.get("completion_tokens", 0) or usage_data.get("output_tokens", 0) or 0) if isinstance(usage_data, dict) else 0

    # v0.1 修复（Wave B2）：必须读 response["cost"] 写 LLMUsageFact 的 input/output/total_cost
    from decimal import Decimal as _Decimal
    def _safe_money(value, fallback=None) -> _Decimal:
        try:
            if value is None or value == "":
                return _Decimal(str(fallback)) if fallback is not None else _Decimal("0")
            return _Decimal(str(value))
        except Exception:
            try:
                return _Decimal(str(fallback)) if fallback is not None else _Decimal("0")
            except Exception:
                return _Decimal("0")

    if not isinstance(cost_data, dict):
        cost_data = {}
    raw_input_cost = (usage_data.get("input_cost") if isinstance(usage_data, dict) else None) or cost_data.get("input")
    raw_output_cost = (usage_data.get("output_cost") if isinstance(usage_data, dict) else None) or cost_data.get("output")
    input_cost = _safe_money(raw_input_cost, 0)
    output_cost = _safe_money(raw_output_cost, 0)
    total_cost = _safe_money(cost_data.get("total"), input_cost + output_cost)

    cost_status = (
        "n_a" if is_platform_payer else "byok_self_paid" if is_byok else "platform_paid"
    )
    fact = record_usage_fact(
        request_id=req_id,
        invocation_id=invocation.invocation_id,
        attempt_id=attempt.attempt_id,
        stable_invocation=invocation.stable_invocation,
        scene_key=scene_key,
        execution_key=invocation.execution_key,
        capability_domain='vision',
        effective_provider_scope=effective_scope,
        cost_status=cost_status,
        status='completed',
        model_id=str(model_info.id) if hasattr(model_info, 'id') else None,
        model_name=model_name,
        provider_id=(
            str(model_info.provider_id)
            if getattr(model_info, "provider_id", None)
            else None
        ),
        provider_key=provider_name,
        organization_id=organization_id,
        user_id=user_id,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        total_tokens=input_tokens + output_tokens,
        input_cost=input_cost,
        output_cost=output_cost,
        total_cost=total_cost,
        latency_ms=elapsed_ms,
        prompt_bundle_version=prompt_bundle_version,
        business_object_type=invocation.business_object_type,
        business_object_id=invocation.business_object_id,
        run_id=invocation.run_id,
        task_id=invocation.task_id,
        parent_invocation_id=invocation.parent_invocation_id,
        payer=scene_payer.value,
        model_source="byok" if is_byok else "official",
        result_status="unknown",
        settlement_status=(
            "not_required" if is_platform_payer or is_byok else "pending"
        ),
        settlement_key_version=attempt.settlement_identity.version,
        retry_source=invocation.retry_source,
        settle=False,
    )

    try:
        validate_vision_result(
            content=content_out,
            scene_key=scene_key,
            response_format=response_format,
        )
        if result_validator is not None:
            result_validator(content_out)
    except Exception as validation_exc:
        mark_usage_result(
            fact,
            result_status="invalid",
            settlement_status=(
                "not_required" if is_platform_payer or is_byok else "skipped"
            ),
        )
        if is_byok:
            from apps.services.llm.scenes.exceptions import BYOKResultInvalid

            raise BYOKResultInvalid(
                "BYOK Vision 结果未通过 Scene validator",
                scene_key=scene_key,
            ) from validation_exc
        raise

    mark_usage_result(fact, result_status="valid")
    if not is_platform_payer and not is_byok:
        settle_usage_fact(
            fact=fact,
            settlement_identity=attempt.settlement_identity,
            funding_mode=attempt.funding_mode,
        )

    return VisionParseResult(
        content=content_out,
        usage=UsageBreakdown(
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            total_tokens=input_tokens + output_tokens,
        ),
        telemetry=CallTelemetry(
            fact_id=str(fact.id),
            request_id=req_id,
            scene_key=scene_key,
            capability_domain='vision',
            model_used=model_name,
            provider_used=provider_name,
            effective_provider_scope=effective_scope,
            prompt_bundle_version=prompt_bundle_version or None,
            cost_status=cost_status,
            latency_ms=elapsed_ms,
            attempt_count=1,
            invocation_id=invocation.invocation_id,
            attempt_id=attempt.attempt_id,
            execution_key=invocation.execution_key,
            stable_invocation=invocation.stable_invocation,
            settlement_status=(
                "not_required" if is_platform_payer or is_byok else "settled"
            ),
        ),
        finish_reason="stop",
    )
