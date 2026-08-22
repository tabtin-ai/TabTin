"""AI Scene 政策契约与纯内存 Resolver。"""

from __future__ import annotations

from .types import (
    FallbackPolicy,
    FundingPolicy,
    ModelSource,
    ResolvedScenePolicy,
    ScenePayer,
    ScenePolicy,
)

POLICY_VERSION = "ai_scene_policy_v1"

# PR1 首批纳管边界。列表的用途不是复制 Runtime routing，而是确保这些 Scene
# 的 Policy 被误删时 fail closed；尚未纳管的历史 Scene 仍显式维持 user payer。
PAYER_POLICY_MANAGED_SCENE_KEYS = frozenset({
    "title_generation",
    "commit_message_generation",
    "checkpoint_intent_summary",
    "checkpoint_decision_summary",
    "tool_risk_classify",
    "summarization",
    "task_summary",
    "user_portrait_distill",
    "memory_capture",
    "memory_flush",
    "diary_distill",
    "memory_compaction",
    "vision_parse_document",
    "media_image_generate",
    "tts_synthesize_stream",
    "tts_synthesize_http",
    "asr_realtime_stream",
    "asr_recognize_flash",
    "asr_transcribe_standard",
    "media_video_generate",
    "media_bgm_generate",
})


class ScenePolicyError(Exception):
    """Scene Policy 注册或解析失败。"""


class UnknownScenePolicyError(ScenePolicyError):
    """scene_key 未在现有 Scene Catalog 注册。"""


class ScenePolicyMissingError(ScenePolicyError):
    """Scene 已注册，但尚未配置 Policy。"""


class ScenePolicyRegistry:
    """现有 ``SCENES`` 的 Policy 视图，不维护第二份 Scene Catalog。"""

    @staticmethod
    def get(scene_key: str) -> ScenePolicy:
        from .registry import SCENES

        scene_spec = SCENES.get(scene_key)
        if scene_spec is None:
            raise UnknownScenePolicyError(f"未知 Scene Policy: {scene_key}")
        if scene_spec.policy is None:
            raise ScenePolicyMissingError(f"Scene 尚未配置 Policy: {scene_key}")
        return scene_spec.policy

    @staticmethod
    def configured() -> tuple[ScenePolicy, ...]:
        from .registry import SCENES

        return tuple(
            scene_spec.policy
            for scene_spec in SCENES.values()
            if scene_spec.policy is not None
        )


class ScenePolicyResolver:
    """将静态 Policy 解析为不可变的运行期快照。"""

    @staticmethod
    def resolve(scene_key: str) -> ResolvedScenePolicy:
        policy = ScenePolicyRegistry.get(scene_key)
        return ResolvedScenePolicy(
            scene_key=policy.scene_key,
            enabled=policy.enabled_default,
            payer=policy.payer,
            allowed_model_sources=policy.allowed_model_sources,
            funding_policy=policy.funding_policy,
            fallback_policy=policy.fallback_policy,
            execution_key=policy.execution_key,
            policy_version=POLICY_VERSION,
        )


def resolve_runtime_scene_payer(scene_key: str) -> ScenePayer:
    """解析 Runtime payer；只为尚未纳管的历史 Scene 保留 user 兼容。"""
    try:
        payer = ScenePolicyResolver.resolve(scene_key).payer
    except ScenePolicyMissingError:
        if scene_key in PAYER_POLICY_MANAGED_SCENE_KEYS:
            raise
        return ScenePayer.USER

    if not isinstance(payer, ScenePayer):
        raise ScenePolicyError(f"Scene payer 非法: {scene_key}")
    return payer


def require_scene_enabled(scene_key: str) -> ResolvedScenePolicy:
    """在 Billing/Provider/Usage/Asset 之前执行统一启停门禁。"""
    policy = ScenePolicyResolver.resolve(scene_key)
    if not policy.enabled:
        from .exceptions import SceneDisabled

        raise SceneDisabled(
            f"scene_key='{scene_key}' 已关闭",
            scene_key=scene_key,
        )
    return policy


__all__ = [
    "FallbackPolicy",
    "FundingPolicy",
    "ModelSource",
    "PAYER_POLICY_MANAGED_SCENE_KEYS",
    "POLICY_VERSION",
    "ResolvedScenePolicy",
    "ScenePayer",
    "ScenePolicy",
    "ScenePolicyError",
    "ScenePolicyMissingError",
    "ScenePolicyRegistry",
    "ScenePolicyResolver",
    "UnknownScenePolicyError",
    "resolve_runtime_scene_payer",
    "require_scene_enabled",
]
