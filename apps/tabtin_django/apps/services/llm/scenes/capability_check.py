"""capability_requirements 校验逻辑。

按 domain dispatch 到子函数。Wave 1 接受 dict 作为 capabilities_config（不直接依赖 LLMModel）。
"""

from __future__ import annotations

from copy import deepcopy
from typing import Any, Optional


def check_capability_match(
    *,
    capabilities_config: dict[str, Any],
    requirements: dict[str, Any],
    capability_domain: str,
    context_window_tokens: int = 0,
    max_output_tokens: int = 0,
) -> Optional[str]:
    """检查 capabilities_config 是否满足 requirements。

    返回 None=满足；返回 str=不满足原因。
    """
    if capability_domain == "chat":
        return _check_chat(capabilities_config, requirements, context_window_tokens, max_output_tokens)
    elif capability_domain == "embedding":
        return _check_embedding(capabilities_config, requirements)
    elif capability_domain == "vision":
        return _check_vision(capabilities_config, requirements, context_window_tokens, max_output_tokens)
    elif capability_domain == "asr":
        return _check_asr(capabilities_config, requirements)
    elif capability_domain == "tts":
        return _check_tts(capabilities_config, requirements)
    elif capability_domain == "image_gen":
        return _check_image_gen(capabilities_config, requirements)
    elif capability_domain == "video_gen":
        return _check_video_gen(capabilities_config, requirements)
    elif capability_domain == "audio_gen":
        return _check_audio_gen(capabilities_config, requirements)
    return f"未知 capability_domain: {capability_domain}"


def check_model_capability_match(
    *,
    model: Any,
    requirements: dict[str, Any],
    capability_domain: str,
) -> Optional[str]:
    """使用统一模型能力快照检查一个真实 ``LLMModel``。

    Candidate、Save 与 Runtime 共用本入口，避免分别解释结构化字段和历史
    ``supports_*`` 镜像。Provider/Model domain 也在这里统一 fail closed。
    """
    model_domain = str(getattr(model, "capability_domain", "") or "")
    if model_domain != capability_domain:
        return (
            f"model capability_domain={model_domain or '<empty>'} "
            f"!= required={capability_domain}"
        )

    provider = getattr(model, "provider", None)
    provider_domains = list(getattr(provider, "capability_domains", None) or [])
    if capability_domain not in provider_domains:
        return (
            f"provider capability_domains={provider_domains} "
            f"不包含 required={capability_domain}"
        )

    capabilities_config = _resolved_capabilities_config(model)
    context_window_tokens = int(
        getattr(model, "context_window_tokens", 0) or 0
    )
    max_output_tokens = getattr(model, "max_output_tokens_resolved", None)
    if max_output_tokens is None:
        max_output_tokens = (
            getattr(model, "max_output_tokens", None) or context_window_tokens
        )
    return check_capability_match(
        capabilities_config=capabilities_config,
        requirements=requirements,
        capability_domain=capability_domain,
        context_window_tokens=context_window_tokens,
        max_output_tokens=int(max_output_tokens or 0),
    )


def _resolved_capabilities_config(model: Any) -> dict[str, Any]:
    """把统一能力快照投影成 ``check_capability_match`` 的结构化输入。"""
    from apps.services.llm.utils.capabilities import resolve_model_capabilities

    config = deepcopy(getattr(model, "capabilities_config", None) or {})
    resolved = resolve_model_capabilities(model)

    wire = config.get("wire")
    wire_config = dict(wire) if isinstance(wire, dict) else {}
    wire_config["stream_supported"] = resolved["supports_streaming"]
    config["wire"] = wire_config

    tool = config.get("tool")
    tool_config = dict(tool) if isinstance(tool, dict) else {}
    tool_config["enabled"] = resolved["supports_function_calling"]
    config["tool"] = tool_config

    image = config.get("image")
    image_config = dict(image) if isinstance(image, dict) else {}
    image_config["enabled"] = resolved["supports_vision"]
    config["image"] = image_config

    json_mode = config.get("json_mode")
    json_mode_config = dict(json_mode) if isinstance(json_mode, dict) else {}
    existing_modes = json_mode_config.get("modes")
    modes = list(existing_modes) if isinstance(existing_modes, (list, tuple)) else []
    if resolved["supports_json_mode"]:
        if not modes:
            modes = ["json_object"]
    else:
        modes = []
    json_mode_config["modes"] = modes
    config["json_mode"] = json_mode_config
    return config


def _check_chat(
    cfg: dict, req: dict,
    context_window_tokens: int, max_output_tokens: int,
) -> Optional[str]:
    if req.get("requires_json_mode"):
        if not cfg.get("json_mode", {}).get("modes"):
            return "model 不支持 JSON Mode"
    if req.get("requires_vision"):
        if not cfg.get("image", {}).get("enabled"):
            return "model 不支持 vision"
    if req.get("requires_function_calling"):
        if not cfg.get("tool", {}).get("enabled"):
            return "model 不支持 function calling"
    if context_window_tokens < req.get("min_context_tokens", 0):
        return (
            f"context_window_tokens={context_window_tokens} "
            f"< required={req['min_context_tokens']}"
        )
    effective_max_out = max_output_tokens or context_window_tokens
    if effective_max_out < req.get("max_output_tokens", 0):
        return (
            f"max_output_tokens={effective_max_out} "
            f"< required={req['max_output_tokens']}"
        )
    return None


def _check_embedding(cfg: dict, req: dict) -> Optional[str]:
    emb_cfg = cfg.get("embedding", {})
    if emb_cfg.get("dimensions") != req.get("embedding_dimensions"):
        return (
            f"embedding_dimensions={emb_cfg.get('dimensions')} "
            f"!= required={req.get('embedding_dimensions')}"
        )
    if req.get("requires_dimensions_reduction") and not emb_cfg.get("supports_dimensions_reduction"):
        return "model 不支持 dimensions reduction"
    if emb_cfg.get("max_batch_size", 0) < req.get("max_batch_size", 0):
        return "max_batch_size 不够"
    if emb_cfg.get("max_input_tokens_per_text", 0) < req.get("max_input_tokens", 0):
        return "max_input_tokens_per_text 不够"
    return None


def _check_vision(
    cfg: dict, req: dict,
    context_window_tokens: int, max_output_tokens: int,
) -> Optional[str]:
    if req.get("requires_json_mode"):
        if not cfg.get("json_mode", {}).get("modes"):
            return "VLM 不支持 JSON Mode"
    if context_window_tokens < req.get("min_context_tokens", 0):
        return f"context_window_tokens 不够"
    effective_max_out = max_output_tokens or context_window_tokens
    if effective_max_out < req.get("max_output_tokens", 0):
        return f"max_output_tokens 不够"
    return None


def _check_asr(cfg: dict, req: dict) -> Optional[str]:
    """ASR domain 校验（按 04 §1.4）。

    字段：requires_streaming / requires_speaker_diarization / requires_word_timestamps
          / max_audio_duration_sec / supported_languages
    """
    speech = cfg.get("speech", {})
    if not speech:
        return "ASR capabilities (speech) 未配置"
    wire = cfg.get("wire", {})
    if req.get("requires_streaming") and not wire.get("stream_supported"):
        return "ASR model 不支持流式 (wire.stream_supported=False)"
    if req.get("requires_speaker_diarization") and not speech.get("supports_diarization"):
        return "ASR model 不支持说话人分离 (speech.supports_diarization=False)"
    if req.get("requires_word_timestamps") and not speech.get("supports_timestamps"):
        return "ASR model 不支持 word timestamps (speech.supports_timestamps=False)"
    # supported_languages：req=[]/() 表示自动；非空时必须是 model 支持语言的子集
    req_langs = req.get("supported_languages")
    if req_langs:
        model_langs = set(speech.get("supported_languages") or [])
        missing = [lg for lg in req_langs if lg not in model_langs]
        if missing:
            return f"ASR model 不支持语言: {missing}"
    # max_audio_duration_sec：req=0 表示流式无上限；req>0 时 model 必须 ≥ req
    req_max_dur = req.get("max_audio_duration_sec", 0) or 0
    if req_max_dur > 0:
        model_max_dur = speech.get("max_audio_length_sec") or 0
        if model_max_dur and model_max_dur < req_max_dur:
            return (
                f"ASR model max_audio_length_sec={model_max_dur} "
                f"< required={req_max_dur}"
            )
    return None


def _check_tts(cfg: dict, req: dict) -> Optional[str]:
    """TTS domain 校验（按 04 §1.5）。

    字段：requires_streaming / requires_emotion / requires_voice_cloning
          / supported_formats / supported_sample_rates / max_text_chars
    """
    speech = cfg.get("speech", {})
    if not speech:
        return "TTS capabilities (speech) 未配置"
    wire = cfg.get("wire", {})
    if req.get("requires_streaming") and not wire.get("stream_supported"):
        return "TTS model 不支持流式 (wire.stream_supported=False)"
    if req.get("requires_emotion") and not speech.get("supports_emotion"):
        return "TTS model 不支持情感标签 (speech.supports_emotion=False)"
    if req.get("requires_voice_cloning") and not speech.get("supports_voice_cloning"):
        return "TTS model 不支持音色克隆 (speech.supports_voice_cloning=False)"
    req_formats = req.get("supported_formats") or ()
    if req_formats:
        model_formats = set(speech.get("supported_formats") or [])
        missing = [f for f in req_formats if f not in model_formats]
        if missing:
            return f"TTS model 不支持输出格式: {missing}"
    req_rates = req.get("supported_sample_rates") or ()
    if req_rates:
        model_rates = set(speech.get("supported_sample_rates") or [])
        missing = [r for r in req_rates if r not in model_rates]
        if missing:
            return f"TTS model 不支持采样率: {missing}"
    req_max_chars = req.get("max_text_chars", 0) or 0
    if req_max_chars > 0:
        model_max_chars = speech.get("max_text_chars") or 0
        if model_max_chars and model_max_chars < req_max_chars:
            return (
                f"TTS model max_text_chars={model_max_chars} "
                f"< required={req_max_chars}"
            )
    return None


def _check_image_gen(cfg: dict, req: dict) -> Optional[str]:
    """image_gen domain 校验（按 04 §1.6）。

    字段：requires_negative_prompt / requires_image_to_image / requires_seed_control
          / supported_sizes / max_n_per_request / max_prompt_chars
    """
    media = cfg.get("media_gen", {})
    if not media:
        return "image_gen capabilities (media_gen) 未配置"
    if req.get("requires_negative_prompt") and not media.get("supports_negative_prompt"):
        return "image_gen 不支持 negative prompt"
    if req.get("requires_image_to_image") and not media.get("supports_image_to_image"):
        return "image_gen 不支持 image-to-image"
    if req.get("requires_seed_control") and not media.get("supports_seed"):
        return "image_gen 不支持 seed 复现"
    req_sizes = req.get("supported_sizes") or ()
    if req_sizes:
        model_sizes = set(media.get("supported_sizes") or [])
        missing = [s for s in req_sizes if s not in model_sizes]
        if missing:
            return f"image_gen 不支持尺寸: {missing}"
    req_max_n = req.get("max_n_per_request", 0) or 0
    if req_max_n > 0:
        model_max_n = media.get("max_n_per_request") or 0
        if model_max_n and model_max_n < req_max_n:
            return (
                f"image_gen max_n_per_request={model_max_n} "
                f"< required={req_max_n}"
            )
    req_max_prompt = req.get("max_prompt_chars", 0) or 0
    if req_max_prompt > 0:
        model_max_prompt = media.get("max_prompt_chars") or 0
        if model_max_prompt and model_max_prompt < req_max_prompt:
            return (
                f"image_gen max_prompt_chars={model_max_prompt} "
                f"< required={req_max_prompt}"
            )
    return None


def _check_video_gen(cfg: dict, req: dict) -> Optional[str]:
    """video_gen domain 校验（按 04 §1.7）。

    字段：requires_image_to_video / requires_audio_input / requires_seed_control
          / supported_sizes / supported_durations_sec / max_prompt_chars
    """
    media = cfg.get("media_gen", {})
    if not media:
        return "video_gen capabilities (media_gen) 未配置"
    if req.get("requires_image_to_video") and not media.get("supports_seed_image"):
        return "video_gen 不支持 image-to-video (media_gen.supports_seed_image=False)"
    if req.get("requires_audio_input") and not media.get("supports_audio_input"):
        return "video_gen 不支持 audio input"
    if req.get("requires_seed_control") and not media.get("supports_seed"):
        return "video_gen 不支持 seed 复现"
    req_sizes = req.get("supported_sizes") or ()
    if req_sizes:
        model_sizes = set(media.get("supported_sizes") or [])
        missing = [s for s in req_sizes if s not in model_sizes]
        if missing:
            return f"video_gen 不支持尺寸: {missing}"
    req_durations = req.get("supported_durations_sec") or ()
    if req_durations:
        model_durations = set(media.get("supported_durations_sec") or [])
        missing = [d for d in req_durations if d not in model_durations]
        if missing:
            return f"video_gen 不支持时长: {missing}"
    req_max_prompt = req.get("max_prompt_chars", 0) or 0
    if req_max_prompt > 0:
        model_max_prompt = media.get("max_prompt_chars") or 0
        if model_max_prompt and model_max_prompt < req_max_prompt:
            return (
                f"video_gen max_prompt_chars={model_max_prompt} "
                f"< required={req_max_prompt}"
            )
    return None


def _check_audio_gen(cfg: dict, req: dict) -> Optional[str]:
    """audio_gen domain 校验（按 04 §1.8 BGM + 未来 SFX）。

    字段：requires_lyrics / requires_style_preset / max_target_duration_sec
          / output_formats
    """
    media = cfg.get("media_gen", {})
    if not media:
        return "audio_gen capabilities (media_gen) 未配置"
    if req.get("requires_lyrics") and not media.get("supports_lyrics"):
        return "audio_gen 不支持歌词输入 (media_gen.supports_lyrics=False)"
    if req.get("requires_style_preset") and not media.get("supports_style_preset"):
        return "audio_gen 不支持风格预设"
    req_max_dur = req.get("max_target_duration_sec", 0) or 0
    if req_max_dur > 0:
        model_max_dur = media.get("max_target_duration_sec") or 0
        if model_max_dur and model_max_dur < req_max_dur:
            return (
                f"audio_gen max_target_duration_sec={model_max_dur} "
                f"< required={req_max_dur}"
            )
    req_formats = req.get("output_formats") or ()
    if req_formats:
        model_formats = set(media.get("output_formats") or [])
        missing = [f for f in req_formats if f not in model_formats]
        if missing:
            return f"audio_gen 不支持输出格式: {missing}"
    return None
