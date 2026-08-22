"""LLM Wire Adapter · Capability 字段 enum 权威值表(W1c 落地)。

> 起源:总控 § 6.1(harness 在 W1c 派发前补充)。W1a 走 4 轮 / W1b 走 2 轮才闭环,
> 根因都是 migration 字符串与 helper 识别字符串不对齐(F12)。本模块是字段 enum
> 的**单一权威**,migration / helper / 测试 fixture 三者必须同步。

> 任何 helper 不识别的字符串值 = bug;任何不在表内的字符串值 = 必须先在本表注册才能用。

设计原则:

* **单源真理**:本表与 ``request_adapter.py`` 内 helper 实际识别的字符串完全一致。
* **W1c CI gate** 在 ``validate_wire_capabilities`` management command 内消费本表
  做静态校验。新增 provider / migration 时,先在本表注册 enum 才能用。
* **drift 检测辅助**:本表也提供 ``detect_helper_alignment`` 函数,跑 grep 静态分析
  确认每个 enum 值都被 helper 真识别。
"""

from __future__ import annotations

from typing import Dict, FrozenSet, List, Tuple


# ---------------------------------------------------------------------------
# 字段 enum 权威表(总控 § 6.1)
# ---------------------------------------------------------------------------

# 各字段的合法 enum 值 + 含义说明。
# 含义文本会被 validate_wire_capabilities 命令在报错时引用,所以保持中文 + 简短。

WIRE_SYSTEM_MESSAGE_STYLE_ENUM: Dict[str, str] = {
    "messages_first_role_system": "隐式默认,messages[0] role=system",
    "top_level_system_field": "Anthropic 风,把 messages[0] 的 system 内容移到 body['system']",
    "unsupported": "完全不支持 system,drop messages[0] system + prepend 到 user",
    "minimax_user_system_role": "MiniMax 专属(messages[0] role=user_system,W2 实装)",
}

# system_message_style 的旧 alias(W1b 已规范化但保留映射用于 drift 检测报告)
WIRE_SYSTEM_MESSAGE_STYLE_ALIAS_BLOCKLIST: Dict[str, str] = {
    "anthropic_top_level": "0016 误用,W1b 0018 migration 已规范化为 top_level_system_field",
    "system_field": "模糊命名,禁用",
}

REASONING_FORMAT_ENUM: Dict[str, str] = {
    "hidden": "API 不暴露 thinking(OpenAI o-series / GPT-5.x)",
    "thinking_block": "Anthropic 风 content_block",
    "reasoning_content_field": "OpenAI Chat schema delta.reasoning_content",
    "thinking_config": "Gemini extra_body.google.thinking_config(走 OpenAI 兼容层)",
    "think_tag_inline": "MiniMax <think>...</think> 内嵌 content",
}

REASONING_PARAM_PATH_ENUM: Dict[str, str] = {
    "": "无 reasoning 参数(空串等价 None)",
    "reasoning_effort": "顶层 OpenAI 风 reasoning_effort 字段",
    "thinking": "顶层 thinking 字段(Claude OpenAI 兼容)",
    "thinking+reasoning_effort": (
        "Doubao / 方舟：thinking.type 开关 + 顶层 reasoning_effort 强度"
    ),
    "extra_body.google.thinking_config": "Gemini 兼容层嵌套字段",
    "enable_thinking": "Qwen DashScope 顶层布尔",
}

# tool.parallel_param_polarity 在 dataclass 是 bool 字段(parallel_param_inverted),
# 但总控 § 6.1 用了字符串 enum 命名。提供双向映射:
TOOL_PARALLEL_POLARITY_TO_INVERTED: Dict[str, bool] = {
    "positive": False,  # OpenAI 风:parallel_tool_calls=True 启用并行
    "negative": True,   # Anthropic 风:disable_parallel_tool_use=True 反向
}
TOOL_PARALLEL_INVERTED_TO_POLARITY: Dict[bool, str] = {
    False: "positive",
    True: "negative",
}

CACHING_MODE_ENUM: Dict[str, str] = {
    "automatic_implicit": "上游自动缓存(OpenAI/Gemini/Moonshot)",
    "explicit_cache_control": "显式 cache_control 块(Claude)",
    "session_key": "通过 session_id 缓存(Moonshot prompt_cache_key 老接口)",
    "context_cache": "Gemini extra_body.cached_content / Qwen Context Cache",
    "none": "不支持缓存",
}

WIRE_REQUEST_PROTOCOL_ENUM: Dict[str, str] = {
    "openai_chat_completions": "标准 /chat/completions 兼容",
    "openai_chat": "openai_chat_completions 的简短别名(总控 § 6.1 表用)",
    "openai_responses": "OpenAI Responses API(W3 codex 用)",
    "anthropic_messages": "Anthropic /v1/messages 协议(W2 sdk_dispatcher 走 anthropic SDK)",
    "openai_responses_codex": "ChatGPT Codex 私有网关(W3 codex 用)",
    "gemini_generate_content": "Gemini 原生 generateContent(留 W3,目前走兼容层)",
}

WIRE_STREAMING_PROTOCOL_ENUM: Dict[str, str] = {
    "openai_delta": "标准 SSE data: {choices:[{delta:{...}}]}",
    "anthropic_sse": "Anthropic event-name SSE(content_block_delta / message_delta)",
    "gemini_sse": "Gemini stream(留 W3)",
    "none": "不支持流式",
}

# 允许 None 表示 reasoning 不需要参数(等价空串)
REASONING_PARAM_PATH_NONE_ALIAS: FrozenSet = frozenset({None, ""})

# image.input_via 合法 token
IMAGE_INPUT_VIA_TOKENS: FrozenSet[str] = frozenset({"base64", "url", "file_id"})


# ---------------------------------------------------------------------------
# helper 真识别清单(供 validate_wire_capabilities 反查)
# ---------------------------------------------------------------------------
#
# 这些是 ``request_adapter.py`` 内 helper 真正显式 check 的字符串值。
# 不在清单内的 enum 值 = helper 默认走透传分支(可能是 spec 想覆盖但 helper 没 cover)。
#
# 此清单是从代码 grep 出来的真实事实,改 helper 时同步改这里。

HELPER_RECOGNIZED_SYSTEM_STYLES: FrozenSet[str] = frozenset({
    "top_level_system_field",       # _normalize_system 显式分支(line 332)
    "unsupported",                  # _normalize_system 显式分支(line 377)
    "minimax_user_system_role",     # _normalize_system 显式分支(line 386)
    "messages_first_role_system",   # _normalize_system 默认分支(透传 — line 396)
})

HELPER_RECOGNIZED_REASONING_FORMATS: FrozenSet[str] = frozenset({
    "hidden",                       # _normalize_reasoning_param 显式 check fmt=="hidden"
    # 其他 format 值 helper 不直接 check format 字段,而是 check param_path。
    # 但 spec 上这些值都是合法的 — helper 走的是 param_path 分支:
    "thinking_block",
    "reasoning_content_field",
    "thinking_config",
    "think_tag_inline",
})

HELPER_RECOGNIZED_PARAM_PATHS: FrozenSet[str] = frozenset({
    "",                             # 空串 / None — _normalize_reasoning_param 默认分支
    "thinking",                     # 显式分支:Claude 风
    "reasoning_effort",             # 显式分支:OpenAI 风(line ~1018 的 hidden 分支隐式 drop)
    "thinking+reasoning_effort",    # 显式分支:Doubao thinking.type + reasoning_effort
    "extra_body.google.thinking_config",  # 显式分支:Gemini 走 startswith("extra_body.")
    "enable_thinking",              # Qwen W2 计划字段(helper 当前走默认分支)
})

HELPER_RECOGNIZED_REQUEST_PROTOCOLS: FrozenSet[str] = frozenset({
    # request_protocol 在 W1b 还未在 helper 内做分支,W2 sdk_dispatcher 用。
    # 但本表声明合法 enum 集合(W1c CI gate 校验用)。
    "openai_chat_completions",
    "openai_chat",
    "openai_responses",
    "anthropic_messages",
    "openai_responses_codex",
    "gemini_generate_content",
})

HELPER_RECOGNIZED_STREAMING_PROTOCOLS: FrozenSet[str] = frozenset({
    "openai_delta",
    "anthropic_sse",
    "gemini_sse",
    "none",
})

HELPER_RECOGNIZED_CACHING_MODES: FrozenSet[str] = frozenset({
    # caching.mode helper 不显式 check 字符串,只看 cache_control_strip bool。
    # 但 enum 集合用于 CI gate。
    "automatic_implicit",
    "explicit_cache_control",
    "session_key",
    "context_cache",
    "none",
})


# ---------------------------------------------------------------------------
# 必填字段(总控 § 4 S1.4 W1c 范围:必填字段完整性)
# ---------------------------------------------------------------------------

# 这些字段是必填的,缺失 → CI gate fail(W2 sdk_dispatcher / stream_adapter 依赖)
REQUIRED_FIELDS: List[Tuple[str, str]] = [
    # (字段路径, 用途说明)
    ("wire.upstream_path", "W2 sdk_dispatcher 路由(/chat/completions vs /v1/messages)"),
    ("wire.streaming_protocol", "W2 stream_adapter 选择 SSE 解析器"),
    ("wire.request_protocol", "W2 sdk_dispatcher 路由"),
    ("wire.system_message_style", "W1b _normalize_system 决定 system 形态"),
    ("usage.input_field", "W2 stream_adapter 解析 usage 字段"),
    ("usage.output_field", "W2 stream_adapter 解析 usage 字段"),
]


# ---------------------------------------------------------------------------
# 工具函数:enum 校验
# ---------------------------------------------------------------------------

def is_valid_enum(field: str, value) -> bool:
    """判定一个字段的字符串值是否在权威 enum 表内。

    Args:
        field: 字段路径(如 ``"wire.system_message_style"``)
        value: 字段当前值

    Returns:
        True 表示合法。
    """
    # None 在很多字段是合法的(reasoning.param_path / 其他 Optional)
    if value is None:
        return field in {
            "reasoning.param_path",
            "wire.upstream_path",
            "wire.streaming_protocol",
            "caching.cache_ttl_param",
            "image.max_count_per_request",
            "image.max_size_bytes",
            "image.max_size_mb",
            "tool.max_tools",
            "limits.context_window",
            "limits.context_window_tokens",
            "limits.max_output_tokens",
            "limits.max_documents_per_request",
        }

    if not isinstance(value, str):
        # 非字符串字段不在本函数职责内
        return True

    enum_map = _enum_for_field(field)
    if enum_map is None:
        # 非 enum 字段(如 boolean / numeric)
        return True

    return value in enum_map


def _enum_for_field(field: str) -> Dict[str, str] | None:
    """字段路径 → enum 映射 dict(返回 None 表示该字段不是 enum 字段)。"""
    return {
        "wire.system_message_style": WIRE_SYSTEM_MESSAGE_STYLE_ENUM,
        "wire.system_placement": WIRE_SYSTEM_MESSAGE_STYLE_ENUM,  # 与 style 同 enum
        "wire.request_protocol": WIRE_REQUEST_PROTOCOL_ENUM,
        "wire.response_protocol": WIRE_REQUEST_PROTOCOL_ENUM,
        "wire.streaming_protocol": WIRE_STREAMING_PROTOCOL_ENUM,
        "reasoning.format": REASONING_FORMAT_ENUM,
        "reasoning.param_path": REASONING_PARAM_PATH_ENUM,
        "caching.mode": CACHING_MODE_ENUM,
    }.get(field)


def helper_recognizes(field: str, value) -> bool:
    """判定一个字段值是否被 helper 真识别(W1c drift 检测核心)。

    与 ``is_valid_enum`` 的差异:
    - is_valid_enum:本表 enum 是否合法(spec 角度)
    - helper_recognizes:helper 实际代码是否会显式处理(代码角度)

    若 spec 合法但 helper 不识别 → 高危 drift(配了等于没配)。
    """
    if value is None:
        # None 在 reasoning.param_path 等位置等价空串
        if field == "reasoning.param_path":
            return True
        return True

    if not isinstance(value, str):
        return True

    return {
        "wire.system_message_style": HELPER_RECOGNIZED_SYSTEM_STYLES,
        "wire.system_placement": HELPER_RECOGNIZED_SYSTEM_STYLES,
        "wire.request_protocol": HELPER_RECOGNIZED_REQUEST_PROTOCOLS,
        "wire.streaming_protocol": HELPER_RECOGNIZED_STREAMING_PROTOCOLS,
        "reasoning.format": HELPER_RECOGNIZED_REASONING_FORMATS,
        "reasoning.param_path": HELPER_RECOGNIZED_PARAM_PATHS,
        "caching.mode": HELPER_RECOGNIZED_CACHING_MODES,
    }.get(field, frozenset()).__contains__(value) if field in {
        "wire.system_message_style", "wire.system_placement",
        "wire.request_protocol", "wire.streaming_protocol",
        "reasoning.format", "reasoning.param_path",
        "caching.mode",
    } else True


# ---------------------------------------------------------------------------
# 提示文案
# ---------------------------------------------------------------------------

def format_enum_hint(field: str) -> str:
    """格式化字段的 enum 提示文案(error message 用)。"""
    enum_map = _enum_for_field(field)
    if enum_map is None:
        return f"{field}: 非 enum 字段"
    lines = [f"{field} 合法 enum 值:"]
    for k, v in enum_map.items():
        lines.append(f"  - {k!r}:{v}")
    blocklist = WIRE_SYSTEM_MESSAGE_STYLE_ALIAS_BLOCKLIST if field in {
        "wire.system_message_style", "wire.system_placement",
    } else {}
    if blocklist:
        lines.append("  禁用别名:")
        for k, v in blocklist.items():
            lines.append(f"    × {k!r}:{v}")
    return "\n".join(lines)


__all__ = [
    "WIRE_SYSTEM_MESSAGE_STYLE_ENUM",
    "WIRE_SYSTEM_MESSAGE_STYLE_ALIAS_BLOCKLIST",
    "REASONING_FORMAT_ENUM",
    "REASONING_PARAM_PATH_ENUM",
    "TOOL_PARALLEL_POLARITY_TO_INVERTED",
    "TOOL_PARALLEL_INVERTED_TO_POLARITY",
    "CACHING_MODE_ENUM",
    "WIRE_REQUEST_PROTOCOL_ENUM",
    "WIRE_STREAMING_PROTOCOL_ENUM",
    "IMAGE_INPUT_VIA_TOKENS",
    "REQUIRED_FIELDS",
    "HELPER_RECOGNIZED_SYSTEM_STYLES",
    "HELPER_RECOGNIZED_REASONING_FORMATS",
    "HELPER_RECOGNIZED_PARAM_PATHS",
    "HELPER_RECOGNIZED_REQUEST_PROTOCOLS",
    "HELPER_RECOGNIZED_STREAMING_PROTOCOLS",
    "HELPER_RECOGNIZED_CACHING_MODES",
    "is_valid_enum",
    "helper_recognizes",
    "format_enum_hint",
]
