"""Scene Policy 的纯比较与旁路观测。"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from enum import Enum

from .policy import (
    FallbackPolicy,
    FundingPolicy,
    ModelSource,
    POLICY_VERSION,
    ResolvedScenePolicy,
    ScenePayer,
    ScenePolicyResolver,
)

logger = logging.getLogger(__name__)


class DriftCode(str, Enum):
    PAYER_DRIFT = "PAYER_DRIFT"
    SOURCE_DRIFT = "SOURCE_DRIFT"
    ENABLED_DRIFT = "ENABLED_DRIFT"
    FUNDING_DRIFT = "FUNDING_DRIFT"
    FALLBACK_DRIFT = "FALLBACK_DRIFT"
    EXECUTION_DRIFT = "EXECUTION_DRIFT"
    UNKNOWN_RUNTIME_SOURCE = "UNKNOWN_RUNTIME_SOURCE"
    POLICY_RESOLUTION_ERROR = "POLICY_RESOLUTION_ERROR"


class ShadowStatus(str, Enum):
    MATCH = "MATCH"
    DRIFT = "DRIFT"


@dataclass(frozen=True)
class RuntimeScenePolicySnapshot:
    payer: ScenePayer
    provider_scope: str | None
    resolved_model: str | None
    billing_required: bool
    fallback_policy: FallbackPolicy
    execution_key: str
    selected_model_source: ModelSource | None = None
    actually_invoked: bool = True


@dataclass(frozen=True)
class ShadowComparison:
    status: ShadowStatus
    drift_codes: tuple[DriftCode, ...]
    runtime_source: ModelSource | None


class ScenePolicyShadowComparator:
    @staticmethod
    def compare(
        policy: ResolvedScenePolicy,
        runtime: RuntimeScenePolicySnapshot,
    ) -> ShadowComparison:
        drift_codes: list[DriftCode] = []
        runtime_source = ModelSource.from_provider_scope(runtime.provider_scope)

        if policy.enabled != runtime.actually_invoked:
            drift_codes.append(DriftCode.ENABLED_DRIFT)
        if policy.payer != runtime.payer:
            drift_codes.append(DriftCode.PAYER_DRIFT)

        if runtime_source is None:
            drift_codes.append(DriftCode.UNKNOWN_RUNTIME_SOURCE)
        elif runtime_source not in policy.allowed_model_sources:
            drift_codes.append(DriftCode.SOURCE_DRIFT)

        if runtime.selected_model_source is not None:
            if (
                runtime.selected_model_source not in policy.allowed_model_sources
                or runtime.selected_model_source != runtime_source
            ):
                drift_codes.append(DriftCode.SOURCE_DRIFT)
        elif ModelSource.BYOK in policy.allowed_model_sources:
            drift_codes.append(DriftCode.UNKNOWN_RUNTIME_SOURCE)

        expected_billing = policy.funding_policy == FundingPolicy.EXISTING_USER_FUNDING
        if expected_billing != runtime.billing_required:
            drift_codes.append(DriftCode.FUNDING_DRIFT)
        if policy.fallback_policy != runtime.fallback_policy:
            drift_codes.append(DriftCode.FALLBACK_DRIFT)
        if policy.execution_key != runtime.execution_key:
            drift_codes.append(DriftCode.EXECUTION_DRIFT)

        unique_codes = tuple(dict.fromkeys(drift_codes))
        return ShadowComparison(
            status=ShadowStatus.DRIFT if unique_codes else ShadowStatus.MATCH,
            drift_codes=unique_codes,
            runtime_source=runtime_source,
        )


def _get_shadow_metric():
    from apps.services.llm.services.llm_metrics import ai_scene_policy_shadow_total

    return ai_scene_policy_shadow_total


def _record_shadow_failure(
    *,
    scene_key: str,
    request_id: str,
    organization_id: str,
    run_id: str | None,
    task_id: str | None,
    error: Exception,
) -> None:
    metric_error: Exception | None = None
    try:
        _get_shadow_metric().labels(
            scene=scene_key,
            drift_type=DriftCode.POLICY_RESOLUTION_ERROR.value,
        ).inc()
    except Exception as exc:
        metric_error = exc

    try:
        logger.warning(
            "ai_scene_policy_shadow resolution failed",
            extra={
                "event": "ai_scene_policy_shadow",
                "scene_key": scene_key,
                "policy_version": POLICY_VERSION,
                "drift_codes": [DriftCode.POLICY_RESOLUTION_ERROR.value],
                "shadow_policy_error_type": type(error).__name__,
                "shadow_metric_error_type": (
                    type(metric_error).__name__ if metric_error is not None else None
                ),
                "request_id": request_id,
                "organization_id": organization_id,
                "run_id": run_id,
                "task_id": task_id,
            },
        )
    except Exception:
        return


def resolve_and_record_scene_policy_shadow(
    *,
    scene_key: str,
    runtime: RuntimeScenePolicySnapshot,
    request_id: str,
    organization_id: str,
    run_id: str | None = None,
    task_id: str | None = None,
) -> ShadowComparison | None:
    """旁路解析并记录 Policy drift；任何失败都不影响 Legacy Runtime。"""
    from django.conf import settings

    try:
        shadow_enabled = getattr(settings, "AI_SCENE_POLICY_SHADOW_ENABLED", False)
    except Exception:
        return None
    if not shadow_enabled:
        return None

    try:
        policy = ScenePolicyResolver.resolve(scene_key)
        comparison = ScenePolicyShadowComparator.compare(policy, runtime)
    except Exception as exc:  # Shadow 必须 fail-open，Legacy Runtime 继续执行。
        _record_shadow_failure(
            scene_key=scene_key,
            request_id=request_id,
            organization_id=organization_id,
            run_id=run_id,
            task_id=task_id,
            error=exc,
        )
        return None

    try:
        shadow_metric = _get_shadow_metric()
        metric_codes = comparison.drift_codes or (comparison.status,)
        for drift_code in metric_codes:
            shadow_metric.labels(
                scene=scene_key,
                drift_type=drift_code.value,
            ).inc()

        logger.info(
            "ai_scene_policy_shadow",
            extra={
                "event": "ai_scene_policy_shadow",
                "scene_key": scene_key,
                "policy_version": policy.policy_version,
                "policy_enabled": policy.enabled,
                "policy_payer": policy.payer.value,
                "policy_allowed_sources": sorted(
                    source.value for source in policy.allowed_model_sources
                ),
                "policy_funding_policy": policy.funding_policy.value,
                "policy_fallback_policy": policy.fallback_policy.value,
                "policy_execution_key": policy.execution_key,
                "runtime_resolved_model": runtime.resolved_model,
                "runtime_provider_scope": runtime.provider_scope,
                "runtime_source": (
                    comparison.runtime_source.value if comparison.runtime_source else "unknown"
                ),
                "runtime_billing_required": runtime.billing_required,
                "drift_codes": [code.value for code in comparison.drift_codes],
                "request_id": request_id,
                "organization_id": organization_id,
                "run_id": run_id,
                "task_id": task_id,
            },
        )
        return comparison
    except Exception:
        return None
