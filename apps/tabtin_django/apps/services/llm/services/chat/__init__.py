"""chat capability_domain 唯一业务入口。"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Callable, Literal, Mapping

from apps.services.llm.services.types import UsageBreakdown, CallTelemetry

logger = logging.getLogger(__name__)

if TYPE_CHECKING:
    from apps.services.llm.services._runtime.invocation import SceneInvocationContext


@dataclass(frozen=True)
class LLMCallResult:
    content: str
    usage: UsageBreakdown
    telemetry: CallTelemetry
    finish_reason: Literal["stop", "length", "content_filter", "tool_calls", "error"]
    tool_calls: list[dict] | None = None
    raw_response: dict | None = None


def unified_llm_call(
    *,
    scene_key: str,
    variables: Mapping[str, Any] | None = None,
    mode: str | None = None,
    user_id: str,
    organization_id: str,
    override_params: Mapping[str, Any] | None = None,
    request_id: str | None = None,
    timeout_sec: int | None = None,
    invocation_context: "SceneInvocationContext | None" = None,
    result_validator: Callable[[str], None] | None = None,
    selected_model_id: str | None = None,
) -> LLMCallResult:
    """
    chat capability_domain 唯一业务入口。

    内部流程: Invocation → ScenePolicy payer → SceneCallContext → ModelResolver
              → user payer 才做 BillingPrecheck → Provider → UsageRecorder → 返回

    Args:
        mode: memory_capture 等含 mode_variants 的 scene 必传（"auto" / "selective"）。
    """
    from apps.services.llm.services._runtime.scene_call_context import build_scene_call_context
    from apps.services.llm.services._runtime.model_resolver import (
        iter_ready_fallback_models,
        resolve_model,
    )
    from apps.services.llm.services._runtime.invocation import prepare_scene_invocation
    from apps.services.llm.services._runtime.byok_resolver import (
        create_exact_byok_runtime,
        map_byok_provider_error,
        resolve_scene_execution,
    )
    from apps.services.llm.services._runtime.usage_recorder import (
        mark_usage_result,
        record_usage_fact,
        settle_usage_fact,
    )
    from apps.services.llm.scenes.policy import (
        FallbackPolicy,
        ScenePayer,
        resolve_runtime_scene_payer,
    )
    from apps.services.llm.prompts.registry import PromptRegistry

    t0 = time.monotonic()
    invocation = prepare_scene_invocation(
        scene_key=scene_key,
        organization_id=organization_id,
        user_id=user_id,
        selected_model_id=selected_model_id,
        invocation_context=invocation_context,
    )
    scene_payer = resolve_runtime_scene_payer(scene_key)
    is_platform_payer = scene_payer is ScenePayer.PLATFORM
    attempt = invocation.start_attempt(request_id=request_id)
    resolved_request_id = attempt.request_id

    ctx = build_scene_call_context(
        scene_key=scene_key,
        expected_domain='chat',
        organization_id=organization_id,
        user_id=user_id,
        request_id=resolved_request_id,
        variables=variables,
        override_params=override_params,
        timeout_sec=timeout_sec,
    )
    execution = resolve_scene_execution(
        scene_key=scene_key,
        payer=scene_payer,
        selected_model_id=selected_model_id,
        organization_id=organization_id,
        user_id=user_id,
        capability_domain="chat",
        capability_requirements=ctx.scene_spec.capability_requirements,
    )
    is_byok = execution.model_source.value == "byok"
    if is_byok:
        model = execution.model
        effective_scope = execution.provider_scope
    elif execution.model is not None:
        model = execution.model
        effective_scope = execution.provider_scope
    else:
        model, effective_scope = resolve_model(
            scene_key=scene_key,
            capability_domain='chat',
            capability_requirements=ctx.scene_spec.capability_requirements,
        )

    rendered = PromptRegistry.render(
        scene_key,
        variables=variables,
        mode=mode,
    )

    params = dict(rendered.default_params or {})
    if override_params:
        params.update(override_params)

    messages: list[dict[str, str]] = []
    if rendered.system:
        messages.append({"role": "system", "content": rendered.system})
    if rendered.user:
        messages.append({"role": "user", "content": rendered.user})

    effective_timeout = (
        timeout_sec
        or params.pop("timeout_sec", None)
        or _timeout_from_latency_class(ctx.scene_spec.capability_requirements)
    )
    max_tokens = params.pop("max_tokens", 4096)
    requested_temperature = params.pop("temperature", None)
    use_model_default_sampling = bool(
        params.pop("use_model_default_sampling", False)
    ) and requested_temperature is None
    temperature = (
        requested_temperature
        if requested_temperature is not None
        else (None if use_model_default_sampling else 0.3)
    )
    response_format = params.pop("response_format", None)
    thinking = params.pop("thinking", None)

    params.pop("keep_last_messages", None)
    params.pop("min_content_length", None)
    params.pop("max_input_chars", None)
    params.pop("max_memos", None)
    params.pop("min_group_size", None)
    params.pop("max_groups_per_run", None)
    params.pop("min_success_count", None)
    params.pop("min_pitfall_count", None)

    from apps.services.llm.services.factory import get_llm_service

    chat_kwargs: dict[str, Any] = {
        "max_tokens": max_tokens,
    }
    if temperature is not None:
        chat_kwargs["temperature"] = temperature
    if use_model_default_sampling:
        chat_kwargs["use_model_default_sampling"] = True
    if scene_key == "title_generation":
        chat_kwargs["rate_limit_service_tag"] = "title_generation"
    if response_format:
        chat_kwargs["response_format"] = response_format
    if effective_timeout:
        chat_kwargs["timeout"] = effective_timeout
    if thinking is not None:
        chat_kwargs["thinking"] = thinking

    estimated_input_tokens = max(
        0,
        sum(len(str(message.get("content", ""))) for message in messages) // 4,
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
            resolved_model=model.model_name,
            billing_required=not is_platform_payer,
            fallback_policy=execution.fallback_policy,
            execution_key=invocation.execution_key,
        ),
        request_id=resolved_request_id,
        organization_id=organization_id,
    )
    if not is_platform_payer and not is_byok:
        model, effective_scope = _select_billable_model(
            scene_key=scene_key,
            organization_id=organization_id,
            user_id=user_id,
            estimated_tokens=estimated_input_tokens + max_tokens,
            request_id=resolved_request_id,
            primary_model=model,
            primary_scope=effective_scope,
            fallback_models=(
                []
                if selected_model_id
                else iter_ready_fallback_models(
                    scene_key=scene_key,
                    capability_domain='chat',
                    capability_requirements=ctx.scene_spec.capability_requirements,
                )
            ),
            invocation_id=invocation.invocation_id,
            stable_invocation=invocation.stable_invocation,
            funding_mode=invocation.funding_mode,
            settlement_idempotency_key=attempt.settlement_identity.idempotency_key,
        )

    if is_byok:
        byok_runtime = create_exact_byok_runtime(
            execution,
            invocation_id=invocation.invocation_id,
            scene_key=scene_key,
        )
        execution = byok_runtime.execution
        llm_service = byok_runtime.service
    else:
        try:
            llm_service = get_llm_service(model_id=str(model.id))
        except Exception:
            llm_service = get_llm_service(model_name=model.model_name)

    try:
        result = llm_service.chat(messages=messages, **chat_kwargs)
    except Exception as provider_exc:
        latency_ms = int((time.monotonic() - t0) * 1000)
        try:
            record_usage_fact(
                request_id=resolved_request_id,
                invocation_id=invocation.invocation_id,
                attempt_id=attempt.attempt_id,
                stable_invocation=invocation.stable_invocation,
                scene_key=scene_key,
                execution_key=invocation.execution_key,
                capability_domain="chat",
                effective_provider_scope=effective_scope,
                cost_status="n_a",
                status="failed",
                model_id=str(model.id),
                model_name=model.model_name,
                provider_id=str(model.provider_id) if model.provider_id else None,
                organization_id=organization_id,
                user_id=user_id,
                latency_ms=latency_ms,
                prompt_bundle_version=rendered.bundle.version_hash or "",
                error_code=type(provider_exc).__name__,
                business_object_type=invocation.business_object_type,
                business_object_id=invocation.business_object_id,
                run_id=invocation.run_id,
                task_id=invocation.task_id,
                parent_invocation_id=invocation.parent_invocation_id,
                payer=scene_payer.value,
                model_source=_model_source(effective_scope),
                result_status="invalid",
                settlement_status=(
                    "not_required" if is_platform_payer or is_byok else "skipped"
                ),
                settlement_key_version=attempt.settlement_identity.version,
                retry_source=invocation.retry_source,
                settle=False,
            )
        except Exception as record_exc:
            logger.debug("[unified_llm_call] record_usage_fact failed: %s", record_exc)
        if is_byok:
            raise map_byok_provider_error(provider_exc, scene_key=scene_key) from provider_exc
        raise

    latency_ms = int((time.monotonic() - t0) * 1000)

    if not isinstance(result, dict) or not result.get("success"):
        error_msg = result.get("error", "unknown") if isinstance(result, dict) else "LLM call failed"
        logger.warning(
            "[unified_llm_call] scene=%s failed: %s", scene_key, error_msg,
        )
        try:
            record_usage_fact(
                request_id=resolved_request_id,
                invocation_id=invocation.invocation_id,
                attempt_id=attempt.attempt_id,
                stable_invocation=invocation.stable_invocation,
                scene_key=scene_key,
                execution_key=invocation.execution_key,
                capability_domain="chat",
                effective_provider_scope=effective_scope,
                cost_status="n_a",
                status="failed",
                model_id=str(model.id),
                model_name=model.model_name,
                provider_id=str(model.provider_id) if model.provider_id else None,
                organization_id=organization_id,
                user_id=user_id,
                latency_ms=latency_ms,
                prompt_bundle_version=rendered.bundle.version_hash or "",
                error_code=result.get("error_code", "") if isinstance(result, dict) else "",
                business_object_type=invocation.business_object_type,
                business_object_id=invocation.business_object_id,
                run_id=invocation.run_id,
                task_id=invocation.task_id,
                parent_invocation_id=invocation.parent_invocation_id,
                payer=scene_payer.value,
                model_source=_model_source(effective_scope),
                result_status="invalid",
                settlement_status=(
                    "not_required" if is_platform_payer or is_byok else "skipped"
                ),
                settlement_key_version=attempt.settlement_identity.version,
                retry_source=invocation.retry_source,
                settle=False,
            )
        except Exception as rec_exc:
            logger.debug("[unified_llm_call] record_usage_fact failed: %s", rec_exc)
        from apps.services.llm.scenes.exceptions import BYOKResultInvalid, SceneCallError
        if is_byok:
            mapped = map_byok_provider_error(result, scene_key=scene_key)
            if not (isinstance(result, dict) and result.get("error_code")):
                mapped = BYOKResultInvalid(
                    "BYOK Provider 返回无效结果", scene_key=scene_key
                )
            raise mapped
        raise SceneCallError(
            f"unified_llm_call(scene_key='{scene_key}') LLM 调用失败: {error_msg}",
            scene_key=scene_key,
            error_code=result.get("error_code", "") if isinstance(result, dict) else "",
        )

    content = result.get("content", "")
    raw_usage = result.get("usage") or {}
    # v0.1 修复（Wave B2）：必须读 result["cost"] 写 LLMUsageFact 的 input_cost /
    # output_cost / total_cost。底层 OpenAIService._do_chat 返回的是 dict，
    # `cost` 子 dict 含 input/output/total（按模型单价计算的等价定价）。
    # BYOK 路径走 cost_status='byok_self_paid' 时 total_cost 仍记录"等价平台
    # 定价"（节省 panel 用），由 cost_status 决定是否真扣钱包。
    raw_cost = result.get("cost") or {}

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

    usage = UsageBreakdown(
        input_tokens=raw_usage.get("prompt_tokens", 0) or raw_usage.get("input_tokens", 0),
        output_tokens=raw_usage.get("completion_tokens", 0) or raw_usage.get("output_tokens", 0),
        total_tokens=raw_usage.get("total_tokens", 0),
    )

    input_cost = _safe_money(raw_usage.get("input_cost"), raw_cost.get("input", 0))
    output_cost = _safe_money(raw_usage.get("output_cost"), raw_cost.get("output", 0))
    total_cost = _safe_money(raw_cost.get("total"), input_cost + output_cost)

    # v0.1 §3 BYOK 边界：unified_llm_call 强制 effective_provider_scope='global'
    # （ModelResolver 已校验 scope='global'）。少数平台基础体验 scene
    # 由平台吸收成本，只做审计不对用户组织结算。
    cost_status = (
        "n_a" if is_platform_payer else "byok_self_paid" if is_byok else "platform_paid"
    )
    fact_id = ""
    try:
        fact = record_usage_fact(
            request_id=resolved_request_id,
            invocation_id=invocation.invocation_id,
            attempt_id=attempt.attempt_id,
            stable_invocation=invocation.stable_invocation,
            scene_key=scene_key,
            execution_key=invocation.execution_key,
            capability_domain="chat",
            effective_provider_scope=effective_scope,
            cost_status=cost_status,
            status="completed",
            model_id=str(model.id),
            model_name=model.model_name,
            provider_id=str(model.provider_id) if model.provider_id else None,
            organization_id=organization_id,
            user_id=user_id,
            input_tokens=usage.input_tokens,
            output_tokens=usage.output_tokens,
            total_tokens=usage.total_tokens,
            input_cost=input_cost,
            output_cost=output_cost,
            total_cost=total_cost,
            latency_ms=latency_ms,
            prompt_bundle_version=rendered.bundle.version_hash or "",
            has_override_params=bool(override_params),
            business_object_type=invocation.business_object_type,
            business_object_id=invocation.business_object_id,
            run_id=invocation.run_id,
            task_id=invocation.task_id,
            parent_invocation_id=invocation.parent_invocation_id,
            payer=scene_payer.value,
            model_source=_model_source(effective_scope),
            result_status="unknown",
            settlement_status=(
                "not_required" if is_platform_payer or is_byok else "pending"
            ),
            settlement_key_version=attempt.settlement_identity.version,
            retry_source=invocation.retry_source,
            settle=False,
        )
        fact_id = str(fact.id) if fact else ""
    except Exception as rec_exc:
        logger.warning("[unified_llm_call] record_usage_fact failed: %s", rec_exc)
        from apps.services.llm.scenes.exceptions import SceneCallError
        raise SceneCallError(
            f"unified_llm_call(scene_key='{scene_key}') LLM 用量记录失败",
            scene_key=scene_key,
            error_code=type(rec_exc).__name__,
        ) from rec_exc

    telemetry = CallTelemetry(
        fact_id=fact_id or "",
        request_id=resolved_request_id,
        scene_key=scene_key,
        capability_domain="chat",
        model_used=model.model_name,
        provider_used=model.provider.name if model.provider else "",
        effective_provider_scope=effective_scope,
        prompt_bundle_version=rendered.bundle.version_hash,
        cost_status=cost_status,
        latency_ms=latency_ms,
        attempt_count=1,
        invocation_id=invocation.invocation_id,
        attempt_id=attempt.attempt_id,
        execution_key=invocation.execution_key,
        stable_invocation=invocation.stable_invocation,
        settlement_status=(
            "not_required" if is_platform_payer or is_byok else "settled"
        ),
    )

    _finish_reason = result.get("finish_reason", "stop")

    from apps.services.llm.services._runtime.result_validator import validate_chat_result
    try:
        validate_chat_result(
            content=content,
            finish_reason=_finish_reason,
            scene_key=scene_key,
        )
        if result_validator is not None:
            result_validator(content)
    except Exception as validation_exc:
        if is_platform_payer or is_byok:
            mark_usage_result(fact, result_status="invalid")
        else:
            mark_usage_result(
                fact,
                result_status="invalid",
                settlement_status="skipped",
            )
        if is_byok:
            from apps.services.llm.scenes.exceptions import BYOKResultInvalid

            raise BYOKResultInvalid(
                "BYOK Provider 结果未通过 Scene validator",
                scene_key=scene_key,
            ) from validation_exc
        raise

    mark_usage_result(fact, result_status="valid")
    if scene_payer is ScenePayer.USER and not is_byok:
        try:
            settle_usage_fact(
                fact=fact,
                settlement_identity=attempt.settlement_identity,
                funding_mode=attempt.funding_mode,
            )
        except Exception as settle_exc:
            logger.warning("[unified_llm_call] billing settlement failed: %s", settle_exc)
            from apps.services.llm.scenes.exceptions import SceneCallError
            raise SceneCallError(
                f"unified_llm_call(scene_key='{scene_key}') LLM 计费结算失败",
                scene_key=scene_key,
                error_code=type(settle_exc).__name__,
            ) from settle_exc

    return LLMCallResult(
        content=content,
        usage=usage,
        telemetry=telemetry,
        finish_reason=_finish_reason,
    )


def _model_source(provider_scope: str | None) -> str | None:
    from apps.services.llm.scenes.policy import ModelSource

    source = ModelSource.from_provider_scope(provider_scope)
    return source.value if source else None


def _select_billable_model(
    *,
    scene_key: str,
    organization_id: str,
    user_id: str,
    estimated_tokens: int,
    request_id: str,
    primary_model,
    primary_scope: str,
    fallback_models: list[tuple[Any, str]],
    invocation_id: str = "",
    stable_invocation: bool = False,
    funding_mode: str = "",
    settlement_idempotency_key: str = "",
) -> tuple[Any, str]:
    """Pick the first ready model whose billing precheck allows this scene call."""
    from apps.services.llm.scenes.exceptions import BudgetExceeded
    from apps.services.llm.services._runtime.billing_precheck import check_billing

    last_error: BudgetExceeded | None = None
    last_blocked_candidate: tuple[Any, str, bool] | None = None
    candidates: list[tuple[Any, str, bool]] = [
        (primary_model, primary_scope, False),
        *[(model, scope, True) for model, scope in fallback_models],
    ]

    for model, scope, is_fallback in candidates:
        try:
            check_billing(
                organization_id=organization_id,
                user_id=user_id,
                scene_key=scene_key,
                capability_domain='chat',
                estimated_tokens=estimated_tokens,
                model_id=str(model.id),
                context={
                    "request_id": request_id,
                    "idempotency_key": settlement_idempotency_key or f"llm_usage:{request_id}",
                    "source": "unified_llm_call",
                    "fallback_model": is_fallback,
                    "invocation_id": invocation_id,
                    "stable_invocation": stable_invocation,
                    "funding_mode": funding_mode,
                    "suppress_blocked_event": True,
                },
                perform_side_effects=True,
            )
        except BudgetExceeded as exc:
            last_error = exc
            last_blocked_candidate = (model, scope, is_fallback)
            logger.info(
                "[unified_llm_call] scene=%s model=%s billing precheck blocked; "
                "trying fallback=%s",
                scene_key,
                getattr(model, "model_name", model.id),
                not is_fallback,
            )
            continue

        if is_fallback:
            logger.info(
                "[unified_llm_call] scene=%s using fallback model=%s after "
                "primary billing block",
                scene_key,
                getattr(model, "model_name", model.id),
            )
        return model, scope

    if last_blocked_candidate:
        model, _, is_fallback = last_blocked_candidate
        check_billing(
            organization_id=organization_id,
            user_id=user_id,
            scene_key=scene_key,
            capability_domain='chat',
            estimated_tokens=estimated_tokens,
            model_id=str(model.id),
            context={
                "request_id": request_id,
                "idempotency_key": settlement_idempotency_key or f"llm_usage:{request_id}",
                "source": "unified_llm_call",
                "fallback_model": is_fallback,
                "invocation_id": invocation_id,
                "stable_invocation": stable_invocation,
                "funding_mode": funding_mode,
            },
            perform_side_effects=True,
        )

    if last_error:
        raise last_error
    raise BudgetExceeded(
        f"scene_key='{scene_key}' 无可计费模型",
        scene_key=scene_key,
    )


def _timeout_from_latency_class(reqs: dict | None) -> int:
    if not reqs:
        return 60
    lc = reqs.get("latency_class", "interactive")
    return {"realtime": 10, "interactive": 60, "batch": 300}.get(lc, 60)
