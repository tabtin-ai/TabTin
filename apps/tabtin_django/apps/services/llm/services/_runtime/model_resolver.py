"""
ModelResolver — 读 LLMSceneBinding → 选模型

路线 B 硬约束：强制 provider.scope='global' → E14
primary → fallback chain
capability_requirements 兜底校验 → E16
provider 健康检查 → E15
就绪性检查（routing_enabled / placeholder api_key / capability_domains 集合）→ E15
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from apps.services.llm.scenes.exceptions import (
    SceneBindingUnavailable,
    SceneBindingViolatesByokBoundary,
    NoProviderHealthy,
    SceneRoutingDisabled,
    CapabilityMismatch,
)

if TYPE_CHECKING:
    from apps.services.llm.models import LLMModel
    from apps.services.llm.services.types import ProviderScope

logger = logging.getLogger(__name__)


def resolve_model(
    *,
    scene_key: str,
    capability_domain: str,
    capability_requirements: dict | None = None,
) -> tuple["LLMModel", "ProviderScope"]:
    """
    scene 化入口的模型解析。仅返回 scope='global' 的 provider 模型。

    Returns:
        (model, effective_scope) — scope 永远是 'global'

    Raises:
        SceneBindingUnavailable (E14)
        SceneBindingViolatesByokBoundary (E14)
        NoProviderHealthy (E15)
        CapabilityMismatch (E16)
    """
    from apps.services.llm.models import LLMSceneBinding

    try:
        binding = LLMSceneBinding.objects.select_related(
            'primary_model', 'primary_model__provider',
        ).get(scene_key=scene_key)
    except LLMSceneBinding.DoesNotExist:
        raise SceneBindingUnavailable(
            f"scene_key='{scene_key}' 无对应 LLMSceneBinding",
            scene_key=scene_key,
        )

    primary_model = binding.primary_model
    if primary_model is None:
        raise SceneBindingUnavailable(
            f"scene_key='{scene_key}' 尚未配置 primary_model",
            scene_key=scene_key,
        )
    if primary_model.provider.scope != 'global':
        raise SceneBindingViolatesByokBoundary(
            f"scene_key='{scene_key}' primary_model.provider.scope="
            f"'{primary_model.provider.scope}'，路线 B 强制 global",
            scene_key=scene_key,
            actual_scope=primary_model.provider.scope,
        )

    # v0.1.x：就绪性检查（fail-fast）。v0.1.0 的痛点是 placeholder Provider 仍能解析、
    # 把 <INSERT_VIA_ADMIN> 当 api_key 送到上游，得到一个普通 401，运营无法定位根因。
    # 本检查把"未就绪"提前到 resolve 阶段，给运营 actionable 错误。
    not_ready_reason = _check_provider_readiness(primary_model, capability_domain)
    if not_ready_reason:
        fallback = _try_fallback_chain(
            binding,
            scene_key,
            capability_domain=capability_domain,
            capability_requirements=capability_requirements,
        )
        if fallback is not None:
            return fallback, 'global'
        if _all_candidate_routes_disabled(binding):
            raise SceneRoutingDisabled(
                f"scene_key='{scene_key}' 的全部 Provider 路由均已关闭",
                scene_key=scene_key,
            )
        raise NoProviderHealthy(
            f"scene_key='{scene_key}' primary_model 未就绪：{not_ready_reason}",
            scene_key=scene_key,
        )

    if primary_model.provider.runtime_status == 'unhealthy':
        fallback = _try_fallback_chain(
            binding,
            scene_key,
            capability_domain=capability_domain,
            capability_requirements=capability_requirements,
        )
        if fallback is not None:
            return fallback, 'global'
        raise NoProviderHealthy(
            f"scene_key='{scene_key}' 所有 provider 均不可用",
            scene_key=scene_key,
        )

    if capability_requirements:
        _validate_capabilities(
            primary_model,
            capability_requirements,
            scene_key,
            capability_domain=capability_domain,
        )

    return primary_model, 'global'


def _all_candidate_routes_disabled(binding) -> bool:
    """仅当 primary 与所有 fallback 都被运营显式关路由时返回 True。"""
    from apps.services.llm.models import LLMModel

    if getattr(binding.primary_model.provider, 'routing_enabled', False):
        return False

    for entry in (binding.fallback_models or []):
        model_id = entry.get('model_id') if isinstance(entry, dict) else None
        if not model_id:
            return False
        try:
            model = LLMModel.objects.select_related('provider').get(id=model_id)
        except LLMModel.DoesNotExist:
            return False
        if model.provider.scope != 'global':
            return False
        if getattr(model.provider, 'routing_enabled', False):
            return False

    return True


def iter_ready_fallback_models(
    *,
    scene_key: str,
    capability_domain: str,
    capability_requirements: dict | None = None,
) -> list[tuple["LLMModel", "ProviderScope"]]:
    """Return fallback models that are ready for the scene capability domain."""
    from apps.services.llm.models import LLMSceneBinding

    binding = LLMSceneBinding.objects.filter(scene_key=scene_key).first()
    if not binding:
        return []

    models: list[tuple["LLMModel", "ProviderScope"]] = []
    for model in _iter_fallback_chain(
        binding,
        scene_key=scene_key,
        capability_domain=capability_domain,
        capability_requirements=capability_requirements,
    ):
        models.append((model, 'global'))
    return models


def _check_provider_readiness(model, capability_domain: str) -> str:
    """检查 model + provider 是否已就绪可用。

    Returns:
        空字符串表示就绪；非空字符串表示具体的未就绪原因（actionable 错误描述）。

    Side effects:
        埋 ``llm_provider_readiness_check_total{provider, capability_domain, reason}``
        Counter，让运营在 Grafana 上看到"哪个 provider 因为什么原因不就绪、QPS 多少"。
    """
    provider = model.provider
    provider_key = getattr(provider, 'provider_key', 'unknown')
    cap = capability_domain or 'unknown'

    reason_code = 'ready'
    reason_text = ''

    if not getattr(provider, 'routing_enabled', False):
        reason_code = 'routing_disabled'
        reason_text = (
            f"Provider '{provider_key}' routing_enabled=False，"
            f"请去 AdminDash → /ai/providers 编辑并打开 routing_enabled"
        )
    else:
        try:
            api_key = (getattr(provider, 'api_key', '') or '').strip()
        except Exception as exc:
            from apps.services.llm.models import LLMCredentialDecryptionError
            if isinstance(exc, LLMCredentialDecryptionError):
                reason_code = 'credential_decryption_failed'
                reason_text = (
                    f"Provider '{provider_key}' api_key 无法解密。"
                    f"请配置正确的 CREDENTIAL_ENCRYPTION_KEY，或去 AdminDash → /ai/providers 重新录入 api_key"
                )
            else:
                raise
        if reason_code == 'credential_decryption_failed':
            pass
        elif not api_key or api_key.startswith('<INSERT'):
            reason_code = 'placeholder_api_key'
            reason_text = (
                f"Provider '{provider_key}' api_key 仍是占位符（placeholder）。"
                f"请去 AdminDash → /ai/providers 编辑并填入真实 api_key"
            )
        else:
            model_base_url = (getattr(model, 'base_url', '') or '').strip()
            if not model_base_url:
                reason_code = 'empty_base_url'
                reason_text = (
                    f"Model '{model.model_name}' (id={model.id}) 的 base_url 为空。"
                    f"请去 AdminDash → /ai/models 编辑该模型并填入 endpoint URL"
                    f"（如 https://dashscope.aliyuncs.com/compatible-mode/v1）"
                )
            elif capability_domain:
                provider_caps = list(getattr(provider, 'capability_domains', None) or [])
                if provider_caps and capability_domain not in provider_caps:
                    reason_code = 'capability_mismatch'
                    reason_text = (
                        f"Provider '{provider_key}' 的 capability_domains={provider_caps} "
                        f"不包含本次请求的能力域 '{capability_domain}'。请去 AdminDash 编辑该 Provider，"
                        f"添加缺失的能力域；或更换 SceneBinding 的 primary_model"
                    )

    # 埋点（容错：metrics 失败不影响业务）
    try:
        from apps.services.llm.services.llm_metrics import (
            llm_provider_readiness_check_total,
        )
        llm_provider_readiness_check_total.labels(
            provider=provider_key,
            capability_domain=cap,
            reason=reason_code,
        ).inc()
    except Exception:  # pragma: no cover - metrics 永远不能挂热路径
        pass

    return reason_text


def _try_fallback_chain(
    binding,
    scene_key: str,
    *,
    capability_domain: str = '',
    capability_requirements: dict | None = None,
):
    """尝试 fallback_models 找到就绪的 global scope model。"""
    for model in _iter_fallback_chain(
        binding,
        scene_key=scene_key,
        capability_domain=capability_domain,
        capability_requirements=capability_requirements,
    ):
        return model

    return None


def _iter_fallback_chain(
    binding,
    *,
    scene_key: str,
    capability_domain: str = '',
    capability_requirements: dict | None = None,
):
    """Yield ready global fallback models in configured order."""
    from apps.services.llm.models import LLMModel

    for entry in (binding.fallback_models or []):
        model_id = entry.get('model_id') if isinstance(entry, dict) else None
        if not model_id:
            continue
        try:
            model = LLMModel.objects.select_related('provider').get(id=model_id)
        except LLMModel.DoesNotExist:
            continue

        if model.provider.scope != 'global':
            continue
        if model.provider.runtime_status == 'unhealthy':
            continue
        if _check_provider_readiness(model, capability_domain):
            continue
        if capability_requirements:
            try:
                _validate_capabilities(
                    model,
                    capability_requirements,
                    scene_key,
                    capability_domain=capability_domain,
                )
            except CapabilityMismatch:
                continue
        yield model


def _validate_capabilities(
    model,
    requirements: dict,
    scene_key: str,
    *,
    capability_domain: str,
) -> None:
    """统一校验 Official Binding model 的 Scene capability。"""
    from apps.services.llm.scenes.capability_check import (
        check_model_capability_match,
    )

    mismatch = check_model_capability_match(
        model=model,
        capability_domain=capability_domain,
        requirements=requirements,
    )
    if mismatch:
        raise CapabilityMismatch(
            f"scene_key='{scene_key}' capability mismatch: {mismatch}",
            scene_key=scene_key,
        )
