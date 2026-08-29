"""
模型能力解析工具。

将散落在字段/JSON 中的能力标识归一化，便于接口层直接做校验和展示。
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any, Dict, Iterable, Optional


@dataclass(frozen=True)
class ModelCapabilities:
    """模型/Provider 级别能力声明——标准化的 11 个维度。

    用于替代各 Service 子类中手写的 CAPABILITIES dict，
    确保所有维度都被显式声明，避免遗漏。

    典型用法::

        class OpenAIService(BaseLLMService):
            CAPABILITIES = ModelCapabilities(
                supports_streaming=True,
                supports_function_calling=True,
                ...
            ).to_dict()
    """

    supports_streaming: bool = True
    supports_function_calling: bool = False
    supports_vision: bool = False
    supports_video_input: bool = False
    supports_document_input: bool = False
    supports_prompt_caching: bool = False
    supports_reasoning: bool = False
    supports_json_mode: bool = True
    supports_responses_api: bool = False
    supports_token_estimate: bool = False
    supports_tool_choice: bool = False
    supports_parallel_function_calling: bool = False

    def to_dict(self) -> Dict[str, bool]:
        """转为 dict，兼容现有 CAPABILITIES 字典消费方式。"""
        return asdict(self)


_CAPABILITY_ALIASES = {
    "supports_streaming": ("supports_streaming", "streaming"),
    "supports_function_calling": (
        "supports_function_calling",
        "supports_tool_use",
        "supports_tools",
        "tool_calling",
    ),
    "supports_vision": ("supports_vision", "supports_image_input", "vision"),
    "supports_video_input": (
        "supports_video_input",
        "supports_video",
        "video_input",
        "video_in",
    ),
    "supports_document_input": ("supports_document_input", "supports_pdf_input"),
    "supports_prompt_caching": (
        "supports_prompt_caching",
        "supports_cache",
        "supports_context_caching",
        "prompt_caching",
    ),
    "supports_reasoning": ("supports_reasoning", "supports_thinking", "reasoning"),
    "supports_json_mode": (
        "supports_json_mode",
        "supports_response_schema",
        "structured_output",
        "json_mode",
    ),
    "supports_responses_api": (
        "supports_responses_api",
        "supports_response_api",
        "supports_openai_responses",
        "use_responses_api",
    ),
    "supports_token_estimate": (
        "supports_token_estimate",
        "supports_tokenizer_estimate",
    ),
    "supports_tool_choice": ("supports_tool_choice",),
    "supports_parallel_function_calling": ("supports_parallel_function_calling",),
}

# v0.1 capabilities_config 的结构化字段是真值来源；supports_* 仅为兼容旧客户端
# 保留的扁平镜像。两者发生漂移时必须以结构化字段为准。
_STRUCTURED_CAPABILITY_PATHS = {
    "supports_streaming": ("wire", "stream_supported"),
    "supports_function_calling": ("tool", "enabled"),
    "supports_vision": ("image", "enabled"),
}

_LIMIT_ALIASES = {
    "max_documents_per_request": (
        "max_documents_per_request",
        "max_pdf_per_request",
    ),
    "request_payload_max_mb": ("request_payload_max_mb",),
}


def _safe_bool(value: Any) -> Optional[bool]:
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"1", "true", "yes", "on"}:
            return True
        if normalized in {"0", "false", "no", "off"}:
            return False
    return None


def _safe_int(value: Any) -> Optional[int]:
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _iter_aliases(primary_key: str, alias_map: Dict[str, Iterable[str]]) -> Iterable[str]:
    aliases = alias_map.get(primary_key, ())
    seen = {primary_key}
    yield primary_key
    for item in aliases:
        if item in seen:
            continue
        seen.add(item)
        yield item


_SHORT_TO_CANONICAL: Dict[str, str] = {}
for _canonical, _aliases in _CAPABILITY_ALIASES.items():
    for _alias in _aliases:
        _SHORT_TO_CANONICAL[_alias] = _canonical
    _SHORT_TO_CANONICAL[_canonical] = _canonical


def normalize_service_capabilities(caps: Dict[str, Any]) -> Dict[str, bool]:
    """将 Service.CAPABILITIES 的短名 key 统一为标准名（supports_xxx）。"""
    result: Dict[str, bool] = {}
    for key, value in caps.items():
        canonical = _SHORT_TO_CANONICAL.get(key)
        if canonical:
            val = _safe_bool(value)
            if val is not None:
                result[canonical] = val
    return result


def get_capability_flag(
    model: Any,
    key: str,
    default: bool = False,
    service_capabilities: Optional[Dict[str, Any]] = None,
) -> bool:
    """
    读取模型能力布尔值。

    优先级：DB 字段 > capabilities_config > service_capabilities > default
    """
    field_value = _safe_bool(getattr(model, key, None))
    if field_value is not None:
        return field_value

    config = getattr(model, "capabilities_config", None) or {}
    if key == "supports_json_mode" and isinstance(config, dict):
        json_mode = config.get("json_mode")
        if isinstance(json_mode, dict) and "modes" in json_mode:
            modes = json_mode.get("modes")
            if isinstance(modes, (list, tuple, set)):
                return bool(modes)

    structured_path = _STRUCTURED_CAPABILITY_PATHS.get(key)
    if structured_path and isinstance(config, dict):
        section = config.get(structured_path[0])
        if isinstance(section, dict):
            structured_value = _safe_bool(section.get(structured_path[1]))
            if structured_value is not None:
                return structured_value

    for alias in _iter_aliases(key, _CAPABILITY_ALIASES):
        config_value = _safe_bool(config.get(alias))
        if config_value is not None:
            return config_value

    if service_capabilities:
        normalized = normalize_service_capabilities(service_capabilities)
        canonical = _SHORT_TO_CANONICAL.get(key, key)
        svc_value = _safe_bool(normalized.get(canonical))
        if svc_value is not None:
            return svc_value

    return default


def get_model_limit(model: Any, key: str, default: Optional[int] = None) -> Optional[int]:
    """
    读取模型限制值（multimodal_limits 优先，再读 capabilities_config）。
    """
    limits = getattr(model, "multimodal_limits", None) or {}
    config = getattr(model, "capabilities_config", None) or {}
    structured_limits = config.get("limits") or {} if isinstance(config, dict) else {}

    for alias in _iter_aliases(key, _LIMIT_ALIASES):
        value = _safe_int(limits.get(alias))
        if value is not None:
            return value
        value = _safe_int(config.get(alias))
        if value is not None:
            return value
        value = _safe_int(structured_limits.get(alias))
        if value is not None:
            return value

    return default


def resolve_model_capabilities(
    model: Any,
    service_capabilities: Optional[Dict[str, Any]] = None,
) -> Dict[str, bool]:
    """输出统一能力快照。"""
    return {
        key: get_capability_flag(model, key, default=False, service_capabilities=service_capabilities)
        for key in _CAPABILITY_ALIASES.keys()
    }


def resolve_model_limits(model: Any) -> Dict[str, Any]:
    """输出统一限制快照。"""
    return {
        "max_documents_per_request": get_model_limit(model, "max_documents_per_request"),
    }


# ---------------------------------------------------------------------------
# W1a: resolve_for_wire — LLMModel + Provider + 旧字段 → ResolvedCapabilities
# ---------------------------------------------------------------------------

# Provider 名 → 细分能力规则(W1a-fix-2 Block 3 细化)。仅当 service.CAPABILITIES
# 通过 _build_from_service_capabilities 兜底时使用,wire_adapter JSON 已配的不
# 用此表。
#
# - caching_mode:supports_prompt_caching=True 时该 provider 应该走的真实 cache 形态
# - json_modes:supports_json_mode=True 时该 provider 真实支持的 mode 集合
_PROVIDER_CACHING_MODE = {
    "claude": "explicit_cache_control",
    "anthropic": "explicit_cache_control",
    "gemini": "context_cache",
    "google": "context_cache",
    "moonshot": "automatic_implicit",  # Kimi 自动 + prompt_cache_key
    "kimi": "automatic_implicit",
    "openai": "automatic_implicit",
    "qwen": "context_cache",
    "minimax": "automatic_implicit",
    "zenmux": "automatic_implicit",
}

_PROVIDER_JSON_MODES = {
    "qwen": ("text", "json_object"),  # Qwen 不支持 json_schema
    "minimax": (),  # MiniMax 兼容端无 json_schema
    "claude": ("text", "json_object", "json_schema"),
    "anthropic": ("text", "json_object", "json_schema"),
    "openai": ("text", "json_object", "json_schema"),
    "gemini": ("text", "json_object", "json_schema"),
    "google": ("text", "json_object", "json_schema"),
    "moonshot": ("text", "json_object", "json_schema"),
    "kimi": ("text", "json_object", "json_schema"),
    "zenmux": ("text", "json_object", "json_schema"),
}


def _is_chat_capable(model_instance: Any) -> bool:
    """判定 model 是否真 chat-capable。

    v0.1：``LLMModel.mode`` 字段已删（0022），改用 ``capability_domain``：
    1. ``capability_domain == 'chat'`` → 是 chat。
    2. ``capability_domain`` 在 {embedding, vision, asr, tts, image_gen,
       video_gen, audio_gen} → 不是 chat。
    3. 旧记录可能仍带 ``mode`` 属性（runtime 透传 dict 等），保留旧逻辑兜底。
    4. 兜底:看 capabilities_config 中的 ``supports_streaming`` /
       ``supports_function_calling`` 真值信号。
    """
    domain = (getattr(model_instance, "capability_domain", None) or "").lower()
    if domain == "chat":
        return True
    if domain in {"embedding", "vision", "asr", "tts", "image_gen", "video_gen", "audio_gen"}:
        return False
    # 兼容旧实例:可能仍有 ``mode`` 属性（dict 透传 / 兼容路径）
    mode = (getattr(model_instance, "mode", None) or "").lower()
    if mode in {"chat", "completion"}:
        return True
    if mode and any(k in mode for k in ("image", "audio", "video", "speech", "transcription")):
        return False
    # mode/domain 都拿不到时兜底:看 capabilities_config 中的离散布尔信号
    config = getattr(model_instance, "capabilities_config", None) or {}
    streaming = _safe_bool(config.get("supports_streaming"))
    fc = _safe_bool(config.get("supports_function_calling"))
    if streaming is True or fc is True:
        return True
    # 实例属性兜底（dict 透传场景）
    streaming = _safe_bool(getattr(model_instance, "supports_streaming", None))
    fc = _safe_bool(getattr(model_instance, "supports_function_calling", None))
    if streaming is True or fc is True:
        return True
    return False


def _provider_name(provider: Any) -> str:
    """从 provider 入参提取小写 provider 名(支持实例 / str / None)。"""
    if provider is None:
        return ""
    if isinstance(provider, str):
        return provider.strip().lower()
    name = getattr(provider, "name", None)
    if not name:
        return ""
    return str(name).strip().lower()


def _deep_merge_resolved(base: Any, overlay: Any) -> Any:
    """Deep-merge 两个 ResolvedCapabilities 实例,base 字段优先(W1a-fix-2 Block 2)。

    规则:
    - base 字段是默认值(由 dataclass `field(default_factory=...)` 推断 sentinel)→
      用 overlay 值覆盖
    - base 字段非默认值 → 保留 base 值
    - nested dataclass 字段递归 merge

    判定"默认值"的策略:
    - bool 字段:base 仍是默认 False / True 时由 overlay 顶替(以 overlay 为权威)
      仅当 base 显式非默认设过(无法直接察觉)。这里对所有字段做"None / 空 tuple /
      空 dict / 空 str / dataclass 默认实例"判定为缺省。
    """
    from dataclasses import is_dataclass, fields as dc_fields

    if not is_dataclass(base) or not is_dataclass(overlay):
        return base

    base_cls = type(base)
    if type(overlay) is not base_cls:
        return base

    # 对每个 field
    for f in dc_fields(base_cls):
        base_v = getattr(base, f.name)
        overlay_v = getattr(overlay, f.name)

        # nested dataclass:递归
        if is_dataclass(base_v) and is_dataclass(overlay_v):
            _deep_merge_resolved(base_v, overlay_v)
            continue

        # base 已有"非缺省"值 → 保留
        if not _is_default_value(f, base_v):
            continue

        # base 是缺省 → 用 overlay 值替换(只有 overlay 也非缺省时)
        if not _is_default_value(f, overlay_v):
            setattr(base, f.name, overlay_v)

    return base


def _is_default_value(f: Any, value: Any) -> bool:
    """判定一个 dataclass field 当前值是否仍是"缺省态"。

    用 default_factory / default 还原默认值再比较。无法判定时(无 default)
    用启发式:None / 空 tuple / 空 list / 空 dict / 空 str 视为缺省。
    """
    from dataclasses import MISSING

    # default_factory(优先,因为大多数 nested dataclass / tuple 字段用它)
    factory = getattr(f, "default_factory", MISSING)
    if factory is not MISSING:
        try:
            sample = factory()
            return value == sample
        except Exception:
            pass

    # default(标量字段如 bool / str / Optional[int] 用它)
    default = getattr(f, "default", MISSING)
    if default is not MISSING:
        return value == default

    # 启发式兜底
    if value is None:
        return True
    if isinstance(value, (tuple, list, dict, str)) and len(value) == 0:
        return True
    return False


def resolve_for_wire(model_instance: Any, provider: Any = None) -> Any:
    """把 LLMModel + Provider + 旧 11 字段融合成 ``ResolvedCapabilities``(W1a)。

    Fallback 链(harness LLM WireAdapter 总控 § D5,W1a-fix-2 Block 2 修订):

    1. ``LLMModel.capabilities_config["wire_adapter"]``(W1a migration 0015/0016/
       0017 预填或 admin 手工补齐) — 优先级最高。命中后**仍跑第 2 级补缺失字段**
       (避免 admin 只配部分字段时其他 nested 走 dataclass 默认值)。
    2. Provider Service 类 ``CAPABILITIES`` dict(现有 11 字段 ``ModelCapabilities``)
       → 9 条细化映射规则,根据 provider 名进一步细分(claude/qwen/gemini 等)。
    3. LLMModel 离散布尔字段(``supports_function_calling`` / ``supports_vision`` /
       ``supports_streaming``,W3 末删除)。``get_capability_flag`` 已经覆盖了
       这一级,这里调用即可。
    4. ``ResolvedCapabilities()`` 默认值(全保守 + ``is_configured=False``)。

    Sanity:若 ``is_configured=False`` 且 ``model_instance.is_active=True`` 且
    ``_is_chat_capable(model)=True``,``logger.error`` 提示该 model 未配置;
    image/audio/video 非 chat-capable model 不报 error(避免 stderr 污染)。

    Args:
        model_instance: LLMModel 实例。
        provider: 可选,LLMProvider 实例。当 model_instance.provider 已加载时
                  可直接传入避免再次 DB 查询。

    Returns:
        ResolvedCapabilities 实例。
    """
    from apps.services.llm.wire_adapter.resolved_capabilities import (
        ResolvedCapabilities,
    )

    # ------------------------------------------------------------------
    # 第 1 级:capabilities_config["wire_adapter"]
    # ------------------------------------------------------------------
    config = getattr(model_instance, "capabilities_config", None) or {}
    from apps.services.llm.utils.known_byok_capabilities import (
        ensure_known_byok_wire_capability,
    )
    config = ensure_known_byok_wire_capability(
        provider_key=(
            str(getattr(provider, "provider_key", "") or "").strip().lower()
            or _provider_name(provider)
        ),
        model_name=str(getattr(model_instance, "model_name", "") or ""),
        capabilities_config=config,
    )
    wire_adapter_data = config.get("wire_adapter") if isinstance(config, dict) else None
    # 存量 W1a 数据曾把完整 capability 文档直接写在 capabilities_config
    # 顶层（wire/tool/... + is_configured），而新格式包在 wire_adapter 下。
    # 两者语义相同；只在显式声明已配置且含 wire 段时兼容读取，避免把普通离散
    # supports_* 字段误当成权威 wire 配置。
    if (
        not wire_adapter_data
        and isinstance(config, dict)
        and config.get("is_configured") is True
        and isinstance(config.get("wire"), dict)
    ):
        wire_adapter_data = config
    if wire_adapter_data:
        base = ResolvedCapabilities.from_json(wire_adapter_data)
        base.is_configured = True

        # W1a-fix-2 Block 2:用 service.CAPABILITIES 第 2 级补缺失字段
        try:
            service_fallback = _build_from_service_capabilities(model_instance, provider)
            _deep_merge_resolved(base, service_fallback)
        except Exception:
            # service caps 不可用时 base 仍可用,继续走
            pass

        # wave_status 优先取 model 字段(W1a 加),其次取 wire_adapter 子键里的值
        model_wave_status = getattr(model_instance, "wave_status", None)
        if model_wave_status:
            base.wave_status = model_wave_status
        return base

    # ------------------------------------------------------------------
    # 第 2 级:Provider Service.CAPABILITIES 映射(11 字段 → ResolvedCapabilities)
    # 第 3 级:离散字段 — 通过 get_capability_flag 让 service_caps 兜底
    # ------------------------------------------------------------------
    resolved = _build_from_service_capabilities(model_instance, provider)
    resolved.is_configured = False

    # === wave_status(model 字段) ===
    resolved.wave_status = getattr(model_instance, "wave_status", "ready") or "ready"

    # ------------------------------------------------------------------
    # Sanity:active 且 chat-capable model 但 is_configured=False → log error
    # 非 chat-capable(image/audio/video)model 走 debug,避免 stderr 污染
    # v0.1：LLMModel.is_active / mode 字段已删（0022），用 wave_status / capability_domain 等价替换。
    # ------------------------------------------------------------------
    is_active_v01 = (getattr(model_instance, "wave_status", "") or "") == "ready"
    if not resolved.is_configured and is_active_v01:
        import logging as _logging
        _logger = _logging.getLogger(__name__)
        try:
            model_label = getattr(model_instance, "model_name", None) or str(getattr(model_instance, "id", "?"))
        except Exception:
            model_label = "?"

        if _is_chat_capable(model_instance):
            _logger.error(
                "[wire_adapter] LLMModel %s capability 未配置(capabilities_config['wire_adapter'] 缺失),"
                "wire_adapter 走 service / 离散字段 fallback。请尽快通过 admin 或 W1a migration 补齐。",
                model_label,
            )
        else:
            # 非 chat-capable model(image/audio/video provider)走 debug,
            # 不污染 stderr。后续 wave 引入专门的 image/audio/video adapter
            # 后再视情况升级。
            _logger.debug(
                "[wire_adapter] LLMModel %s 非 chat-capable(capability_domain=%r),wire_adapter 不接管。",
                model_label,
                getattr(model_instance, "capability_domain", None),
            )

    return resolved


def _build_from_service_capabilities(model_instance: Any, provider: Any) -> Any:
    """根据 Service.CAPABILITIES + 离散字段 + provider 名构造 ResolvedCapabilities。

    第 2/3 级 fallback 实现(W1a-fix-2 Block 3 细化):

    9 条映射规则(harness 总控 § D5):
    1. ``supports_streaming=True`` → ``wire.stream_supported=True``
    2. ``supports_function_calling=True`` → ``tool.enabled=True`` +
       ``choice_modes=("auto","required","none")``(无条件 3 模式)
       若 ``supports_tool_choice=True`` 额外含 ``"specific"``;
       若 ``supports_tool_choice=False`` 仍保 3 模式(W1a-fix-2 修正:旧版本
       只给 ``("auto",)`` 太保守)。
    3. ``supports_vision=True`` → ``image.enabled=True`` + base64+url + 4 formats
    4. ``supports_document_input=True`` → ``limits.max_documents_per_request``
       透传 model.multimodal_limits / capabilities_config 真实值。
    5. ``supports_prompt_caching=True`` → 按 provider 细分:
       - claude/anthropic → ``explicit_cache_control``
       - gemini → ``context_cache``
       - moonshot/kimi → ``automatic_implicit`` + ``cache_ttl_param=prompt_cache_key``
       - 其他 → ``automatic_implicit``
    6. ``supports_reasoning=True`` → ``reasoning.enabled=True``
    7. ``supports_json_mode=True`` → 按 provider 细分:
       - qwen → ``modes=("text","json_object")`` 不含 schema
       - minimax → ``modes=()`` 兼容端无 schema
       - 其他 → ``modes=("text","json_object","json_schema")``
    8. ``supports_responses_api=True`` → 透传到 wire(暂记 quirks 标志)
    9. ``supports_token_estimate=True`` → 透传到 wire(暂记 quirks 标志)
    10. ``supports_tool_choice`` → tool.choice_modes 细化(见规则 2)
    11. ``supports_parallel_function_calling`` → tool.parallel_default + 按
        provider 反向参数(claude/anthropic ``disable_parallel_tool_use`` 反向)
    """
    from apps.services.llm.wire_adapter.resolved_capabilities import (
        DocumentCaps,
        ImageCaps,
        JsonModeCaps,
        LimitsCaps,
        ReasoningCaps,
        ResolvedCapabilities,
        ToolCaps,
        VideoCaps,
        WireFormatCaps,
    )

    service_caps = _get_service_capabilities(provider)
    pname = _provider_name(provider)

    def _flag(key: str, default: bool = False) -> bool:
        return get_capability_flag(model_instance, key, default=default,
                                   service_capabilities=service_caps)

    resolved = ResolvedCapabilities()

    # === image(规则 3) ===
    # v0.1：LLMModel.max_image_size / max_images_per_request / supported_image_formats 字段已删（0022），
    # 全部进 capabilities_config，按统一接入图兜底读取。
    if _flag("supports_vision"):
        capabilities_config = getattr(model_instance, "capabilities_config", None) or {}
        if not isinstance(capabilities_config, dict):
            capabilities_config = {}
        image_caps_cfg = capabilities_config.get("image") or {}
        max_count = (
            getattr(model_instance, "max_images_per_request", None)
            or image_caps_cfg.get("max_count_per_request")
            or capabilities_config.get("max_images_per_request")
        )
        max_size = (
            getattr(model_instance, "max_image_size", None)
            or image_caps_cfg.get("max_size_bytes")
            or capabilities_config.get("max_image_size")
        )
        formats = (
            tuple(image_caps_cfg.get("formats") or capabilities_config.get("supported_image_formats") or ())
            or ("jpeg", "png", "webp", "gif")
        )
        resolved.image = ImageCaps(
            enabled=True,
            input_via=("base64", "url"),
            formats=formats,
            max_count_per_request=max_count,
            max_size_bytes=max_size,
            request_shape="openai_image_url",
            # 本机不可达默认 inline_base64；files_api 等由 wire_adapter.image 覆盖
            upload_mode="inline_base64",
        )

    # === video(：fallback 仅 gate；upload_mode 必须由 wire_adapter.video 配置) ===
    if _flag("supports_video_input"):
        resolved.video = VideoCaps(
            enabled=True,
            input_via=("url",),
            upload_mode="none",
        )

    # === document(：fallback 仅 gate；file_extract 须由 wire_adapter.document 配置) ===
    if _flag("supports_document_input"):
        resolved.document = DocumentCaps(
            enabled=True,
            upload_mode="none",
        )

    # === tool(规则 2 / 10 / 11) ===
    tool_enabled = _flag("supports_function_calling")
    if tool_enabled:
        # W1a-fix-2 Block 3 修正:无条件给 3 模式(不再因 supports_tool_choice
        # 限制只 ``("auto",)``)。supports_tool_choice 进一步含 "specific"。
        choice_modes: tuple = ("auto", "required", "none")
        if _flag("supports_tool_choice"):
            choice_modes = ("auto", "required", "none", "specific")

        # parallel 反向参数(Anthropic 风:disable_parallel_tool_use)
        parallel_inverted = pname in ("claude", "anthropic")
        parallel_param_name = (
            "disable_parallel_tool_use" if parallel_inverted else "parallel_tool_calls"
        )

        # tool param_field(Anthropic 风用 input_schema)
        tool_param_field = "input_schema" if pname in ("claude", "anthropic") else "parameters"

        resolved.tool = ToolCaps(
            enabled=True,
            choice_modes=choice_modes,
            parallel_default=_flag("supports_parallel_function_calling"),
            parallel_param_name=parallel_param_name,
            parallel_param_inverted=parallel_inverted,
            param_field=tool_param_field,
        )

    # === wire(规则 1) ===
    # claude/anthropic 走 anthropic_messages 协议
    if pname in ("claude", "anthropic"):
        wire_protocol = "anthropic_messages"
        wire_system = "top_level_system_field"
    elif pname == "minimax":
        wire_protocol = "anthropic_messages"
        wire_system = "minimax_user_system_role"
    else:
        wire_protocol = "openai_chat_completions"
        wire_system = "messages_first_role_system"
    resolved.wire = WireFormatCaps(
        request_protocol=wire_protocol,
        response_protocol=wire_protocol,
        system_placement=wire_system,
        system_message_style=wire_system,
        system_quirks=(),
        stream_supported=_flag("supports_streaming", default=True),
    )

    # === reasoning(规则 6) ===
    if _flag("supports_reasoning"):
        # surface 按 provider 推:claude→thinking_block / openai→hidden /
        # gemini→extra_body_thinking_config / moonshot/qwen→delta_reasoning_content /
        # minimax→think_tag_inline / 其他默认 hidden
        if pname in ("claude", "anthropic"):
            r_surface = "thinking_block"
            r_format = "thinking_block"
            r_param_path = "thinking"
        elif pname in ("gemini", "google"):
            r_surface = "extra_body_thinking_config"
            r_format = "thinking_config"
            r_param_path = "extra_body.google.thinking_config"
        elif pname in ("moonshot", "kimi", "qwen"):
            r_surface = "delta_reasoning_content"
            r_format = "reasoning_content_field"
            r_param_path = None
        elif pname == "minimax":
            r_surface = "think_tag_inline"
            r_format = "think_tag_inline"
            r_param_path = None
        else:
            r_surface = "hidden"
            r_format = "hidden"
            r_param_path = None
        resolved.reasoning = ReasoningCaps(
            enabled=True,
            surface=r_surface,
            format=r_format,
            param_path=r_param_path,
            visible_to_client=pname not in ("openai",),
        )

    # === json_mode(规则 7,按 provider 细分) ===
    if _flag("supports_json_mode", default=True):
        json_modes = _PROVIDER_JSON_MODES.get(pname, ("text", "json_object", "json_schema"))
        # 主 mode 取 json_modes 里最强支持;空 → "none"
        if "json_schema" in json_modes:
            primary_mode = "json_schema"
        elif "json_object" in json_modes:
            primary_mode = "json_object"
        elif "text" in json_modes:
            primary_mode = "text_only"
        else:
            primary_mode = "none"
        resolved.json_mode = JsonModeCaps(
            mode=primary_mode,
            modes=json_modes,
            strict_supported=(pname == "openai"),
            schema_field=("response_format.json_schema.schema"
                          if "json_schema" in json_modes else None),
            schema_fallback=("json_schema" not in json_modes
                             and ("json_object" in json_modes or len(json_modes) == 0)),
        )

    # === caching(规则 5,按 provider 细分) ===
    if _flag("supports_prompt_caching"):
        cmode = _PROVIDER_CACHING_MODE.get(pname, "automatic_implicit")
        resolved.caching.mode = cmode
        if pname in ("claude", "anthropic"):
            resolved.caching.cache_ttl_param = "cache_control.ttl"
        elif pname in ("moonshot", "kimi"):
            resolved.caching.cache_ttl_param = "prompt_cache_key"

    # === limits(规则 4 + 通用) ===
    resolved.limits = LimitsCaps(
        context_window_tokens=getattr(model_instance, "max_tokens", None),
        context_window=getattr(model_instance, "max_tokens", None),
        max_output_tokens=getattr(model_instance, "max_output_tokens", None),
        max_documents_per_request=get_model_limit(model_instance, "max_documents_per_request"),
        max_tool_recursion_depth=None,
        request_payload_max_mb=get_model_limit(model_instance, "request_payload_max_mb"),
    )

    # 注:supports_responses_api / supports_token_estimate(规则 8/9)
    # 当前 ResolvedCapabilities schema 没有专属字段,W1b 路径不需要,先不映射。
    # 若 W2 需要,再追加 wire.responses_api_supported / token_estimate_supported 字段。

    return resolved


def _get_service_capabilities(provider: Any) -> Optional[Dict[str, Any]]:
    """从 Provider 拿到 Service 类的 ``CAPABILITIES`` dict(W1a 第 2 级 fallback)。

    Provider 可以是:
    - LLMProvider 实例:用统一 Resolver 查 Service 类。
    - str:直接当 adapter name。
    - None:返回 None(走第 3 级)。

    任何异常(Service 类未注册 / Registry 未初始化)都返回 None,确保 fallback 链
    继续往下走。
    """
    if provider is None:
        return None
    try:
        from apps.services.llm.adapter_resolver import (
            resolve_adapter_name,
            resolve_provider_adapter,
        )
        from apps.services.llm.registry import ProviderRegistry

        if isinstance(provider, str):
            adapter_name = str(provider or "").strip().lower()
            if not adapter_name:
                return None
            service_class = ProviderRegistry.get_service_class(adapter_name)
        else:
            adapter_name = resolve_adapter_name(provider)
            if not adapter_name:
                return None
            service_class = resolve_provider_adapter(provider)
        caps = getattr(service_class, "CAPABILITIES", None)
        if isinstance(caps, dict):
            return caps
        return None
    except Exception:
        return None
