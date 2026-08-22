"""
media capability_domain 业务入口（image_gen / video_gen / audio_gen）

三个 generate 函数分别对应 image_service / video_service / audio_service。

⚠️ v0.1 显式 stub：
    provider dispatch（fal/replicate/dashscope/minimax）尚未接入。
    入口仍走完完整治理链路：
      1. SceneCallContext（校验 scene_key 注册 / capability_domain 匹配 / organization_id 必填）
      2. ModelResolver（校验 LLMSceneBinding / scope='global' 路线 B / capability_requirements 兜底）
      3. BillingPrecheck（preview 模式，不真正扣减）
      4. record_usage_fact（status='failed' / cost_status='n_a' / error_code='FEATURE_NOT_IMPLEMENTED'）
      5. raise FeatureNotImplemented（HTTP 422）

    调用方拿到 FeatureNotImplemented 后审计链路完整：
      - 客户端可按 SceneCallError 子类统一处理（不会再静默挂在 NotImplementedError）
      - LLMUsageFact 真有一行 status=failed，运营在 AdminDash 能看到「v0.1 stub 调用」用量
      - BillingPrecheck 不会因为 stub 而漏跑，避免 v0.2 接入 provider 时遗漏配额校验

provider 接入留到下一波（按宪法 06 §6 ProviderRegistry 流程加 fal/replicate/dashscope/minimax）。
"""

from __future__ import annotations

import logging
import time
import uuid as _uuid_mod
from dataclasses import dataclass
from typing import Any, Literal, Mapping, Optional

from apps.services.llm.services.types import UsageBreakdown, CallTelemetry

logger = logging.getLogger(__name__)


# ── §3.6 image_gen ──────────────────────────────────────────────────

@dataclass(frozen=True)
class ImageAsset:
    url: str
    width_px: int
    height_px: int
    mime_type: str


@dataclass(frozen=True)
class ImageGenerateResult:
    assets: list[ImageAsset]
    usage: UsageBreakdown
    telemetry: CallTelemetry


# ── §3.7 video_gen ──────────────────────────────────────────────────

@dataclass(frozen=True)
class VideoAsset:
    url: str
    duration_sec: float
    width_px: int
    height_px: int
    mime_type: str


@dataclass(frozen=True)
class VideoGenerateResult:
    assets: list[VideoAsset]
    usage: UsageBreakdown
    telemetry: CallTelemetry


# ── §3.8 audio_gen ──────────────────────────────────────────────────

@dataclass(frozen=True)
class AudioAsset:
    url: str
    duration_sec: float
    mime_type: str


@dataclass(frozen=True)
class AudioGenerateResult:
    assets: list[AudioAsset]
    usage: UsageBreakdown
    telemetry: CallTelemetry


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 共享 stub helper —— 三个入口共用治理链路 + LLMUsageFact 写入
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

def _record_media_policy_shadow(
    *,
    scene_key: str,
    organization_id: str,
    request_id: str,
    model_info,
    effective_scope: str,
) -> None:
    from apps.services.llm.scenes.policy import FallbackPolicy, ScenePayer
    from apps.services.llm.scenes.shadow import (
        RuntimeScenePolicySnapshot,
        resolve_and_record_scene_policy_shadow,
    )

    resolve_and_record_scene_policy_shadow(
        scene_key=scene_key,
        runtime=RuntimeScenePolicySnapshot(
            payer=ScenePayer.USER,
            provider_scope=effective_scope,
            resolved_model=getattr(model_info, 'model_name', None),
            billing_required=True,
            fallback_policy=FallbackPolicy.OFFICIAL_BINDING_ONLY,
            execution_key=scene_key,
        ),
        request_id=request_id,
        organization_id=organization_id,
    )


def _stub_record_and_raise(
    *,
    capability_domain: str,
    scene_key: str,
    organization_id: str,
    user_id: str,
    request_id: str,
    model_info,
    latency_ms: int,
) -> None:
    """走完治理链路后写 LLMUsageFact 并抛 FeatureNotImplemented。

    严格按宪法 06 §5.6 失败计费规则：
      - status='failed'
      - cost_status='n_a'
      - total_cost=0 / asset_count=0 / duration_sec=0
      - 不写 BillingUsageEvent（usage_recorder 内部根据 cost_status 跳过）
    """
    from apps.services.llm.services._runtime.usage_recorder import record_usage_fact
    from apps.services.llm.scenes.exceptions import FeatureNotImplemented

    record_usage_fact(
        request_id=request_id,
        scene_key=scene_key,
        capability_domain=capability_domain,
        effective_provider_scope='global',
        cost_status='n_a',
        status='failed',
        model_id=str(model_info.id) if model_info is not None else None,
        model_name=getattr(model_info, 'model_name', '') or '',
        provider_id=str(model_info.provider.id) if model_info is not None and getattr(model_info, 'provider', None) is not None else None,
        provider_key=getattr(getattr(model_info, 'provider', None), 'provider_key', '') or '',
        organization_id=organization_id,
        user_id=user_id,
        latency_ms=latency_ms,
        attempt_count=1,
        error_code='FEATURE_NOT_IMPLEMENTED',
        error_category='not_implemented',
    )

    raise FeatureNotImplemented(
        f"{capability_domain} generation is not implemented in v0.1 "
        f"(scene_key={scene_key!r}); provider dispatch will land in next wave",
        scene_key=scene_key,
    )


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# image_service
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

class image_service:

    @staticmethod
    def generate(
        *,
        scene_key: str,
        prompt: str,
        organization_id: str,
        user_id: str,
        n: int = 1,
        aspect_ratio: str = "1:1",
        seed: int | None = None,
        negative_prompt: str = "",
        options: Mapping[str, Any] | None = None,
        async_mode: bool = False,
        request_id: str | None = None,
        timeout_sec: int | None = None,
    ) -> ImageGenerateResult:
        """image_gen capability_domain 唯一业务入口。

        v0.1 显式 stub：走完治理链路 → 写 LLMUsageFact → 抛 FeatureNotImplemented (HTTP 422)。
        """
        from apps.services.llm.services._runtime.scene_call_context import build_scene_call_context
        from apps.services.llm.services._runtime.model_resolver import resolve_model
        from apps.services.llm.services._runtime.billing_precheck import check_billing

        req_id = request_id or str(_uuid_mod.uuid4())
        t0 = time.monotonic()

        from apps.services.llm.scenes.policy import require_scene_enabled

        require_scene_enabled(scene_key)

        ctx = build_scene_call_context(
            scene_key=scene_key,
            expected_domain='image_gen',
            organization_id=organization_id,
            user_id=user_id,
            request_id=req_id,
        )

        model_info, effective_scope = resolve_model(
            scene_key=scene_key,
            capability_domain='image_gen',
            capability_requirements=ctx.scene_spec.capability_requirements,
        )

        _record_media_policy_shadow(
            scene_key=scene_key,
            organization_id=organization_id,
            request_id=req_id,
            model_info=model_info,
            effective_scope=effective_scope,
        )

        check_billing(
            organization_id=organization_id,
            user_id=user_id,
            scene_key=scene_key,
            capability_domain='image_gen',
        )

        latency_ms = int((time.monotonic() - t0) * 1000)

        _stub_record_and_raise(
            capability_domain='image_gen',
            scene_key=scene_key,
            organization_id=organization_id,
            user_id=user_id,
            request_id=req_id,
            model_info=model_info,
            latency_ms=latency_ms,
        )


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# video_service
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

class video_service:

    @staticmethod
    def generate(
        *,
        scene_key: str,
        prompt: str,
        organization_id: str,
        user_id: str,
        duration_sec: float = 5.0,
        aspect_ratio: str = "16:9",
        seed_image: bytes | str | None = None,
        seed_audio: bytes | str | None = None,
        seed: int | None = None,
        options: Mapping[str, Any] | None = None,
        async_mode: bool = True,
        request_id: str | None = None,
        timeout_sec: int | None = None,
    ) -> VideoGenerateResult:
        """video_gen capability_domain 唯一业务入口。

        v0.1 显式 stub：走完治理链路 → 写 LLMUsageFact → 抛 FeatureNotImplemented (HTTP 422)。
        """
        from apps.services.llm.services._runtime.scene_call_context import build_scene_call_context
        from apps.services.llm.services._runtime.model_resolver import resolve_model
        from apps.services.llm.services._runtime.billing_precheck import check_billing

        req_id = request_id or str(_uuid_mod.uuid4())
        t0 = time.monotonic()

        from apps.services.llm.scenes.policy import require_scene_enabled

        require_scene_enabled(scene_key)

        ctx = build_scene_call_context(
            scene_key=scene_key,
            expected_domain='video_gen',
            organization_id=organization_id,
            user_id=user_id,
            request_id=req_id,
        )

        model_info, effective_scope = resolve_model(
            scene_key=scene_key,
            capability_domain='video_gen',
            capability_requirements=ctx.scene_spec.capability_requirements,
        )

        _record_media_policy_shadow(
            scene_key=scene_key,
            organization_id=organization_id,
            request_id=req_id,
            model_info=model_info,
            effective_scope=effective_scope,
        )

        check_billing(
            organization_id=organization_id,
            user_id=user_id,
            scene_key=scene_key,
            capability_domain='video_gen',
        )

        latency_ms = int((time.monotonic() - t0) * 1000)

        _stub_record_and_raise(
            capability_domain='video_gen',
            scene_key=scene_key,
            organization_id=organization_id,
            user_id=user_id,
            request_id=req_id,
            model_info=model_info,
            latency_ms=latency_ms,
        )


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# audio_service
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

class audio_service:

    @staticmethod
    def generate(
        *,
        scene_key: str,
        prompt: str,
        organization_id: str,
        user_id: str,
        duration_sec: float = 30.0,
        style: str = "",
        bpm: int | None = None,
        output_format: Literal["wav", "mp3"] = "wav",
        options: Mapping[str, Any] | None = None,
        async_mode: bool = True,
        request_id: str | None = None,
        timeout_sec: int | None = None,
    ) -> AudioGenerateResult:
        """audio_gen capability_domain 唯一业务入口。

        v0.1 显式 stub：走完治理链路 → 写 LLMUsageFact → 抛 FeatureNotImplemented (HTTP 422)。
        """
        from apps.services.llm.services._runtime.scene_call_context import build_scene_call_context
        from apps.services.llm.services._runtime.model_resolver import resolve_model
        from apps.services.llm.services._runtime.billing_precheck import check_billing

        req_id = request_id or str(_uuid_mod.uuid4())
        t0 = time.monotonic()

        from apps.services.llm.scenes.policy import require_scene_enabled

        require_scene_enabled(scene_key)

        ctx = build_scene_call_context(
            scene_key=scene_key,
            expected_domain='audio_gen',
            organization_id=organization_id,
            user_id=user_id,
            request_id=req_id,
        )

        model_info, effective_scope = resolve_model(
            scene_key=scene_key,
            capability_domain='audio_gen',
            capability_requirements=ctx.scene_spec.capability_requirements,
        )

        _record_media_policy_shadow(
            scene_key=scene_key,
            organization_id=organization_id,
            request_id=req_id,
            model_info=model_info,
            effective_scope=effective_scope,
        )

        check_billing(
            organization_id=organization_id,
            user_id=user_id,
            scene_key=scene_key,
            capability_domain='audio_gen',
        )

        latency_ms = int((time.monotonic() - t0) * 1000)

        _stub_record_and_raise(
            capability_domain='audio_gen',
            scene_key=scene_key,
            organization_id=organization_id,
            user_id=user_id,
            request_id=req_id,
            model_info=model_info,
            latency_ms=latency_ms,
        )
