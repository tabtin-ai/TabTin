"""Exact BYOK model resolution and source-locked Provider construction."""

from __future__ import annotations

import logging
from dataclasses import dataclass, replace
from typing import Any

from django.core.validators import URLValidator

from apps.services.llm.scenes.exceptions import (
    BYOKCapabilityMismatch,
    BYOKCredentialDecryptFailed,
    BYOKCredentialInvalid,
    BYOKCredentialMissing,
    BYOKEndpointInvalid,
    BYOKModelNotSelected,
    BYOKPolicyBlocked,
    BYOKProviderAuthFailed,
    BYOKProviderRateLimited,
    BYOKProviderScopeMismatch,
    BYOKProviderUnavailable,
    CapabilityMismatch,
    NoProviderHealthy,
)
from apps.services.llm.scenes.types import (
    FallbackPolicy,
    ModelSource,
    ScenePayer,
)

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class ResolvedSceneExecution:
    payer: ScenePayer
    model_source: ModelSource
    fallback_policy: FallbackPolicy
    source_locked: bool
    model: Any | None = None
    provider_scope: str = "global"
    provider_id: str = ""
    model_id: str = ""
    credential_ref: str = ""
    credential_version: str | None = None
    credential_version_supported: bool = False


@dataclass(frozen=True)
class ResolvedBYOKRuntime:
    execution: ResolvedSceneExecution
    service: Any


def resolve_scene_execution(
    *,
    scene_key: str,
    payer: ScenePayer,
    selected_model_id: str | None,
    organization_id: str,
    user_id: str,
    capability_domain: str,
    capability_requirements: dict | None,
) -> ResolvedSceneExecution:
    """Resolve selected source before any broad/official model pool is consulted."""
    from apps.services.llm.scenes.policy import (
        ScenePolicyMissingError,
        ScenePolicyResolver,
    )

    try:
        policy = ScenePolicyResolver.resolve(scene_key)
    except ScenePolicyMissingError as exc:
        if selected_model_id and payer is ScenePayer.USER:
            raise BYOKPolicyBlocked(
                "未纳管 Scene 不允许启用 BYOK",
                scene_key=scene_key,
            ) from exc
        return ResolvedSceneExecution(
            payer=payer,
            model_source=ModelSource.OFFICIAL,
            fallback_policy=FallbackPolicy.OFFICIAL_BINDING_ONLY,
            source_locked=True,
        )
    official = ResolvedSceneExecution(
        payer=payer,
        model_source=ModelSource.OFFICIAL,
        fallback_policy=policy.fallback_policy,
        source_locked=True,
    )
    if payer is ScenePayer.PLATFORM or not selected_model_id:
        return official

    from apps.services.llm.models import LLMModel

    try:
        model = LLMModel.objects.select_related("provider").get(id=selected_model_id)
    except (LLMModel.DoesNotExist, ValueError, TypeError) as exc:
        _record_resolution(scene_key, "blocked_model_not_selected")
        raise BYOKModelNotSelected(
            "选择的模型不存在或不可用",
            scene_key=scene_key,
            selected_model_id=str(selected_model_id),
        ) from exc

    provider = model.provider
    source = ModelSource.from_provider_scope(getattr(provider, "scope", None))
    if source is None or source not in policy.allowed_model_sources:
        _record_resolution(scene_key, "blocked_policy")
        raise BYOKPolicyBlocked(
            "Scene Policy 不允许所选模型来源",
            scene_key=scene_key,
            selected_model_id=str(selected_model_id),
        )
    if source is ModelSource.OFFICIAL:
        _validate_capability(
            model=model,
            capability_domain=capability_domain,
            requirements=capability_requirements or {},
            scene_key=scene_key,
            official=True,
        )
        _validate_endpoint(
            getattr(model, "base_url", ""),
            scene_key=scene_key,
            official=True,
        )
        if not getattr(provider, "routing_enabled", False) or getattr(
            provider, "runtime_status", "unknown"
        ) == "unhealthy" or getattr(model, "wave_status", "ready") != "ready":
            raise NoProviderHealthy(
                "选择的 Official 模型当前不可用",
                scene_key=scene_key,
            )
        return replace(
            official,
            model=model,
            provider_scope="global",
            provider_id=str(provider.id),
            model_id=str(model.id),
        )

    _validate_ownership(
        provider=provider,
        organization_id=organization_id,
        user_id=user_id,
        scene_key=scene_key,
    )
    _validate_capability(
        model=model,
        capability_domain=capability_domain,
        requirements=capability_requirements or {},
        scene_key=scene_key,
    )
    _validate_endpoint(getattr(model, "base_url", ""), scene_key=scene_key)
    if not getattr(provider, "routing_enabled", False) or getattr(
        provider, "runtime_status", "unknown"
    ) == "unhealthy" or getattr(model, "wave_status", "ready") != "ready":
        _record_resolution(scene_key, "blocked_provider_unavailable")
        raise BYOKProviderUnavailable(
            "选择的 BYOK Provider 当前不可用",
            scene_key=scene_key,
        )

    _record_resolution(scene_key, "resolved")
    return ResolvedSceneExecution(
        payer=payer,
        model_source=ModelSource.BYOK,
        fallback_policy=policy.fallback_policy,
        source_locked=True,
        model=model,
        provider_scope=provider.scope,
        provider_id=str(provider.id),
        model_id=str(model.id),
    )


def create_exact_byok_runtime(
    execution: ResolvedSceneExecution,
    *,
    invocation_id: str,
    scene_key: str,
) -> ResolvedBYOKRuntime:
    """Decrypt the selected Provider credential only at the adapter boundary."""
    if execution.model_source is not ModelSource.BYOK or execution.model is None:
        raise ValueError("Exact BYOK runtime requires a BYOK execution")

    provider = execution.model.provider
    credential, credential_ref = _select_credential(
        provider,
        invocation_id=invocation_id,
        scene_key=scene_key,
    )
    encrypted_value = str(getattr(credential, "encrypted_api_key", "") or "")
    if not encrypted_value:
        _record_resolution(scene_key, "blocked_missing_credential")
        raise BYOKCredentialMissing("BYOK credential 不存在", scene_key=scene_key)
    if not encrypted_value.startswith("gAAAA"):
        _record_resolution(scene_key, "blocked_plaintext_credential")
        raise BYOKCredentialInvalid(
            "BYOK credential 不是受支持的加密格式，请重新录入",
            scene_key=scene_key,
        )
    try:
        api_key = str(credential.api_key or "").strip()
    except Exception as exc:
        from apps.services.llm.models import LLMCredentialDecryptionError

        if isinstance(exc, LLMCredentialDecryptionError):
            _record_resolution(scene_key, "blocked_decrypt_failed")
            raise BYOKCredentialDecryptFailed(
                "BYOK credential 无法解密，请重新录入",
                scene_key=scene_key,
            ) from exc
        raise
    if not api_key:
        _record_resolution(scene_key, "blocked_invalid_credential")
        raise BYOKCredentialInvalid("BYOK credential 为空", scene_key=scene_key)

    model = execution.model
    from apps.services.agent_engine.configuration import OrchestrationConfiguration
    from apps.services.llm.adapter_resolver import resolve_adapter_name
    from apps.services.llm.services.factory import LLMServiceFactory
    from apps.services.llm.utils.capabilities import resolve_model_capabilities

    resolved_caps = resolve_model_capabilities(model)
    orchestration = OrchestrationConfiguration.from_settings()
    config = {
        "name": provider.name,
        "api_key": api_key,
        "base_url": model.base_url,
        "model_name": model.model_name,
        "max_retries": 3,
        "retry_delay": 1,
        "context_window_tokens": model.context_window_tokens,
        "max_input_tokens": model.max_input_tokens_resolved,
        "max_output_tokens": model.max_output_tokens_resolved,
        "structured_output_retries": orchestration.structured_output_retries,
        "supports_function_calling": resolved_caps.get("supports_function_calling"),
        "input_price_per_1k": float(model.input_price_per_1k),
        "output_price_per_1k": float(model.output_price_per_1k),
        "custom_billing_config": model.custom_billing_config or {},
        "provider_obj": provider,
        "model_obj": model,
        "provider_key_obj": credential if credential is not provider else None,
    }
    service = LLMServiceFactory.create_service(
        resolve_adapter_name(provider),
        config,
    )
    return ResolvedBYOKRuntime(
        execution=replace(execution, credential_ref=credential_ref),
        service=service,
    )


def _select_credential(provider, *, invocation_id: str, scene_key: str):
    try:
        from apps.services.llm.services.key_manager import select_provider_key

        key = select_provider_key(str(provider.id), session_id=invocation_id)
    except Exception as exc:
        _record_resolution(scene_key, "blocked_credential_selection")
        raise BYOKCredentialInvalid(
            "BYOK credential 无法选择",
            scene_key=scene_key,
        ) from exc
    if key is not None:
        if str(getattr(key, "provider_id", provider.id)) != str(provider.id):
            raise BYOKCredentialInvalid(
                "BYOK credential 与所选 Provider 不匹配",
                scene_key=scene_key,
            )
        return key, f"provider_key:{key.id}"
    return provider, f"provider:{provider.id}"


def _validate_ownership(*, provider, organization_id: str, user_id: str, scene_key: str):
    scope = getattr(provider, "scope", "")
    if scope == "user" and str(getattr(provider, "user_id", "") or "") != str(user_id):
        _record_resolution(scene_key, "blocked_owner")
        raise BYOKProviderScopeMismatch(
            "所选 BYOK Provider 不属于当前用户",
            scene_key=scene_key,
        )
    if scope == "organization" and str(
        getattr(provider, "organization_id", "") or ""
    ) != str(organization_id):
        _record_resolution(scene_key, "blocked_owner")
        raise BYOKProviderScopeMismatch(
            "所选 BYOK Provider 不属于当前组织",
            scene_key=scene_key,
        )


def _validate_capability(
    *,
    model,
    capability_domain: str,
    requirements: dict,
    scene_key: str,
    official: bool = False,
):
    from apps.services.llm.scenes.capability_check import (
        check_model_capability_match,
    )

    mismatch = check_model_capability_match(
        model=model,
        capability_domain=capability_domain,
        requirements=requirements,
    )
    if mismatch:
        _raise_capability(scene_key, official=official)


def _raise_capability(scene_key: str, *, official: bool) -> None:
    _record_resolution(scene_key, "blocked_capability")
    if official:
        raise CapabilityMismatch(
            "选择的 Official 模型不满足 Scene capability",
            scene_key=scene_key,
        )
    raise BYOKCapabilityMismatch(
        "选择的 BYOK 模型不满足 Scene capability",
        scene_key=scene_key,
    )


def _validate_endpoint(
    base_url: str,
    *,
    scene_key: str,
    official: bool = False,
) -> None:
    try:
        URLValidator(schemes=["https", "http"])(str(base_url or ""))
    except Exception as exc:
        _record_resolution(scene_key, "blocked_endpoint")
        if official:
            raise CapabilityMismatch(
                "选择的 Official 模型 endpoint 无效",
                scene_key=scene_key,
            ) from exc
        raise BYOKEndpointInvalid(
            "选择的 BYOK 模型 endpoint 无效",
            scene_key=scene_key,
        ) from exc


def _record_resolution(scene_key: str, status: str) -> None:
    try:
        from apps.services.llm.services.llm_metrics import ai_scene_byok_resolution_total

        ai_scene_byok_resolution_total.labels(scene=scene_key, status=status).inc()
    except Exception:
        pass
    logger.info(
        "ai_scene_byok_resolution",
        extra={
            "event": "ai_scene_byok_resolution",
            "scene_key": scene_key,
            "byok_resolution_status": status,
            "source_lock": True,
        },
    )


def map_byok_provider_error(error: Any, *, scene_key: str) -> Exception:
    """Collapse adapter-specific failures into the stable BYOK taxonomy."""
    status = getattr(error, "status_code", None)
    response = getattr(error, "response", None)
    if status is None and response is not None:
        status = getattr(response, "status_code", None)
    if isinstance(error, dict):
        status = error.get("status_code") or error.get("status")
        detail = " ".join(
            str(error.get(key, "")) for key in ("error_code", "error", "message")
        )
    else:
        detail = f"{type(error).__name__} {error}"
    normalized = detail.lower()
    if status in (401, 403) or any(
        token in normalized for token in ("401", "unauthorized", "authentication")
    ):
        _record_resolution(scene_key, "provider_auth_failed")
        return BYOKProviderAuthFailed("BYOK Provider 鉴权失败", scene_key=scene_key)
    if status == 429 or "429" in normalized or "rate limit" in normalized:
        _record_resolution(scene_key, "provider_rate_limited")
        return BYOKProviderRateLimited("BYOK Provider 触发限流", scene_key=scene_key)
    _record_resolution(scene_key, "provider_unavailable")
    return BYOKProviderUnavailable("BYOK Provider 调用失败", scene_key=scene_key)


__all__ = [
    "ResolvedBYOKRuntime",
    "ResolvedSceneExecution",
    "create_exact_byok_runtime",
    "map_byok_provider_error",
    "resolve_scene_execution",
]
