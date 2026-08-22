"""Background AI Scene invocation identity and retry contract."""

from __future__ import annotations

from apps.services.llm.scenes.exceptions import (
    BYOKProviderRateLimited,
    BYOKProviderUnavailable,
    BYOKSceneError,
)
from apps.services.llm.services._runtime.invocation import SceneInvocationContext


def build_background_scene_invocation(
    *,
    scene_key: str,
    business_identity: str,
    organization_id: str,
    user_id: str,
    selected_model_id: str = "",
    business_object_type: str = "",
    business_object_id: str = "",
    run_id: str = "",
    task_id: str = "",
    retry_source: str = "",
) -> SceneInvocationContext:
    """Bind one background business operation to one model snapshot."""
    from apps.services.llm.scenes.policy import ScenePolicyResolver

    normalized_identity = str(business_identity or "").strip()
    if not normalized_identity:
        raise ValueError("background business_identity 不能为空")
    invocation_id = f"{scene_key}:{normalized_identity}:v1"
    if len(invocation_id) > 180:
        raise ValueError("background invocation_id 不能超过 180 字符")
    policy = ScenePolicyResolver.resolve(scene_key)
    return SceneInvocationContext.stable(
        invocation_id=invocation_id,
        scene_key=scene_key,
        execution_key=policy.execution_key,
        organization_id=organization_id,
        user_id=user_id,
        selected_model_id=selected_model_id,
        business_object_type=business_object_type,
        business_object_id=business_object_id,
        run_id=run_id,
        task_id=task_id,
        retry_source=retry_source,
    )


def is_retryable_background_error(error: Exception) -> bool:
    """Retry transient Provider/network failures, never permanent BYOK guards."""
    if isinstance(error, (BYOKProviderRateLimited, BYOKProviderUnavailable)):
        return True
    if isinstance(error, BYOKSceneError):
        return False
    return isinstance(error, (TimeoutError, ConnectionError))


__all__ = [
    "build_background_scene_invocation",
    "is_retryable_background_error",
]
