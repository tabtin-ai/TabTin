"""
asr + tts capability_domain 入口

委托给现有 apps.services.speech 服务，加 scene_key 解析 + LLMUsageFact 审计。
"""

from __future__ import annotations

import logging
import time
import uuid as _uuid_mod
from dataclasses import dataclass
from typing import Literal

from apps.services.llm.services.types import UsageBreakdown, CallTelemetry

logger = logging.getLogger(__name__)

_SCENE_TO_ASR_MODE = {
    "asr_recognize_flash": "flash",
    "asr_transcribe_standard": "standard",
    "asr_realtime_stream": "streaming",
}

_SCENE_TO_TTS_MODE = {
    "tts_synthesize_http": "http",
    # v0.1.x：TTS factory 只识别 "http" / "ws_bidirectional"（详见 tts/factory.py BYTEDANCE_MODES）。
    # 之前这里写 "streaming" 是 dead constant（synthesize 没真用 mode 时无害），
    # Phase 3 把 mode 真传给 factory 后激活了这个映射，必须跟 factory 同名。
    "tts_synthesize_stream": "ws_bidirectional",
}


@dataclass(frozen=True)
class TranscribeSegment:
    start_sec: float
    end_sec: float
    text: str
    speaker_id: str | None = None


@dataclass(frozen=True)
class TranscribeResult:
    text: str
    duration_sec: float
    language: str | None
    segments: list[TranscribeSegment] | None
    usage: UsageBreakdown
    telemetry: CallTelemetry


@dataclass(frozen=True)
class SynthesizeResult:
    audio: bytes | str
    duration_sec: float
    voice_used: str
    output_format: Literal["mp3", "wav", "ogg", "pcm"]
    usage: UsageBreakdown
    telemetry: CallTelemetry


def transcribe(
    *,
    scene_key: str,
    audio: bytes | str,
    organization_id: str,
    user_id: str = "",
    language_hint: str | None = None,
    request_id: str | None = None,
    timeout_sec: int | None = None,
) -> TranscribeResult:
    """asr capability_domain 入口，委托给现有 speech.asr 服务。"""
    from apps.services.llm.services._runtime.scene_call_context import build_scene_call_context
    from apps.services.llm.services._runtime.model_resolver import resolve_model
    from apps.services.llm.services._runtime.billing_precheck import check_billing
    from apps.services.llm.services._runtime.usage_recorder import record_usage_fact

    req_id = request_id or str(_uuid_mod.uuid4())
    t0 = time.monotonic()

    ctx = build_scene_call_context(
        scene_key=scene_key,
        expected_domain='asr',
        organization_id=organization_id,
        user_id=user_id or '',
        request_id=req_id,
    )

    model_info, effective_scope = resolve_model(
        scene_key=scene_key,
        capability_domain='asr',
        capability_requirements=ctx.scene_spec.capability_requirements,
    )

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
        request_id=req_id,
        organization_id=organization_id,
    )

    check_billing(
        organization_id=organization_id,
        user_id=user_id or '',
        scene_key=scene_key,
        capability_domain='asr',
    )

    from apps.services.speech.asr.factory import get_asr_service
    asr_mode = _SCENE_TO_ASR_MODE.get(scene_key, "flash")
    # v0.1.x 单源真理：透传 model_info 给 ASR 工厂，绕过老的 capability_domain 单值 DB 查询路径
    # 以及 settings.BYTEDANCE_* fallback。失败时下游会按 model_info.capabilities_config 报错，
    # 而不是悄悄回退到 env（v0.1 宪法明令禁止业务感 env）。
    asr_svc = get_asr_service(mode=asr_mode, model_info=model_info)

    result = asr_svc.recognize(audio=audio, language_hint=language_hint)

    elapsed_ms = int((time.monotonic() - t0) * 1000)
    duration = getattr(result, 'duration_sec', 0.0) or 0.0
    _text = getattr(result, 'text', '')

    from apps.services.llm.services._runtime.result_validator import validate_transcribe_result
    validate_transcribe_result(text=_text, duration_sec=duration, scene_key=scene_key)
    model_name = getattr(model_info, 'model_name', 'bytedance-asr') if hasattr(model_info, 'model_name') else 'bytedance-asr'
    provider_name = getattr(model_info, 'provider', 'bytedance') if hasattr(model_info, 'provider') else 'bytedance'

    fact = record_usage_fact(
        request_id=req_id,
        scene_key=scene_key,
        capability_domain='asr',
        effective_provider_scope='global',
        cost_status='platform_paid',
        status='completed',
        model_name=model_name,
        provider_key=provider_name,
        organization_id=organization_id,
        user_id=user_id or '',
        duration_sec=duration,
        latency_ms=elapsed_ms,
    )

    return TranscribeResult(
        text=getattr(result, 'text', ''),
        duration_sec=duration,
        language=getattr(result, 'language', None),
        segments=None,
        usage=UsageBreakdown(duration_sec=duration),
        telemetry=CallTelemetry(
            fact_id=str(fact.id),
            request_id=req_id,
            scene_key=scene_key,
            capability_domain='asr',
            model_used=model_name,
            provider_used=provider_name,
            effective_provider_scope='global',
            prompt_bundle_version=None,
            cost_status='platform_paid',
            latency_ms=elapsed_ms,
            attempt_count=1,
        ),
    )


def synthesize(
    *,
    scene_key: str,
    text: str,
    voice: str,
    organization_id: str,
    user_id: str = "",
    output_format: Literal["mp3", "wav", "ogg", "pcm"] = "mp3",
    speed: float = 1.0,
    request_id: str | None = None,
    timeout_sec: int | None = None,
) -> SynthesizeResult:
    """tts capability_domain 入口，委托给现有 speech.tts 服务。"""
    from apps.services.llm.services._runtime.scene_call_context import build_scene_call_context
    from apps.services.llm.services._runtime.model_resolver import resolve_model
    from apps.services.llm.services._runtime.billing_precheck import check_billing
    from apps.services.llm.services._runtime.usage_recorder import record_usage_fact

    req_id = request_id or str(_uuid_mod.uuid4())
    t0 = time.monotonic()

    ctx = build_scene_call_context(
        scene_key=scene_key,
        expected_domain='tts',
        organization_id=organization_id,
        user_id=user_id or '',
        request_id=req_id,
    )

    model_info, effective_scope = resolve_model(
        scene_key=scene_key,
        capability_domain='tts',
        capability_requirements=ctx.scene_spec.capability_requirements,
    )

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
        request_id=req_id,
        organization_id=organization_id,
    )

    check_billing(
        organization_id=organization_id,
        user_id=user_id or '',
        scene_key=scene_key,
        capability_domain='tts',
    )

    from apps.services.speech.tts.factory import get_tts_service
    tts_mode = _SCENE_TO_TTS_MODE.get(scene_key, "http")
    tts_svc = get_tts_service(mode=tts_mode, model_info=model_info)

    result = tts_svc.synthesize(
        text=text,
        speaker=voice,
        output_format=output_format,
        speed_ratio=speed,
    )

    elapsed_ms = int((time.monotonic() - t0) * 1000)
    duration = getattr(result, 'duration_sec', 0.0) or 0.0
    audio_data = getattr(result, 'audio', b'') or b''

    from apps.services.llm.services._runtime.result_validator import validate_synthesize_result
    validate_synthesize_result(audio=audio_data, duration_sec=duration, scene_key=scene_key)
    model_name = getattr(model_info, 'model_name', 'bytedance-tts') if hasattr(model_info, 'model_name') else 'bytedance-tts'
    provider_name = getattr(model_info, 'provider', 'bytedance') if hasattr(model_info, 'provider') else 'bytedance'

    fact = record_usage_fact(
        request_id=req_id,
        scene_key=scene_key,
        capability_domain='tts',
        effective_provider_scope='global',
        cost_status='platform_paid',
        status='completed',
        model_name=model_name,
        provider_key=provider_name,
        organization_id=organization_id,
        user_id=user_id or '',
        duration_sec=duration,
        latency_ms=elapsed_ms,
    )

    return SynthesizeResult(
        audio=audio_data,
        duration_sec=duration,
        voice_used=voice,
        output_format=output_format,
        usage=UsageBreakdown(duration_sec=duration),
        telemetry=CallTelemetry(
            fact_id=str(fact.id),
            request_id=req_id,
            scene_key=scene_key,
            capability_domain='tts',
            model_used=model_name,
            provider_used=provider_name,
            effective_provider_scope='global',
            prompt_bundle_version=None,
            cost_status='platform_paid',
            latency_ms=elapsed_ms,
            attempt_count=1,
        ),
    )
