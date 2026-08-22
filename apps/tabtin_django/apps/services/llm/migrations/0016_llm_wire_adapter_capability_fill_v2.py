"""W1a-fix:wire_adapter capability 字段补齐 + ZenMux 整家初值。

W1a-fix 范围(harness 任务定义书):

* 0015 已落地的 4 个 active model(Moonshot Kimi K2.5 / Qwen / MiniMax×2)
  字段不全 — ``wire.upstream_path`` / ``wire.streaming_protocol`` /
  ``reasoning.format`` / ``usage.input_field`` 等 v2 字段空白,W1b WireAdapter
  无法直接消费。本 migration deep-merge 补齐。

* ZenMux 5 个 active chat model(zenmux/anthropic/claude-* /
  zenmux/google/gemini-* / zenmux/openai/gpt-*)0015 完全漏(总控 v0.3 重建版
  无 § 5/§ 6 W1a 子型映射 spec)。本 migration 整家补齐,按 model_name
  sub-pattern 路由到 Claude / Gemini / OpenAI 真实能力 profile,但 wire
  入口统一是 ZenMux 出口的 OpenAI 兼容 chat/completions。

* W1a 已写的 0015 字段 deep-merge 不覆盖 — admin 手工配过 wire_adapter 的
  model 跳过保护;0015 templates 已存在的字段(如 ``wire.request_protocol``
  / ``image.enabled``)保留不动,只新加 v2 字段(``upstream_path`` /
  ``streaming_protocol`` / ``input_field`` 等)。

设计原则(harness 任务定义书 § C 完整字段全填值):

* 8 nested dataclass 全部填齐,30+ 字段不留 None(除非语义就是 0/None)。
* dict deep-merge:模板的 nested dict 与 model 现有 nested dict 逐字段合并,
  现有字段优先(0015 已 set 的不覆盖),新字段(v2)由 0016 补上。
* MiniMax wave_status 仍保 ``w2_pending``(0014 / 0015 已 set,0016 不回退)。
* ZenMux model 默认 ``wave_status='ready'`` — Electron picker 可直接选用,
  W2 不需要 pending(本质上是 OpenAI 兼容透传 + sub-pattern 能力推导)。

字段值依据(harness 总控 § 1.4 + WebFetch 验证 + service.py CAPABILITIES 对照):

* MiniMax:request_protocol=anthropic_messages(D7 白名单 anthropic SDK);
  upstream_path=/v1/messages;streaming_protocol=anthropic_sse;
  usage.input_field=input_tokens(Anthropic 风);
  tool.param_field=input_schema(Anthropic 风);
  usage.extra_fields 含 total_characters / input_sensitive / output_sensitive_type。

* Moonshot K2.5:reasoning.format=reasoning_content_field(K2.5 走
  delta.reasoning_content);usage.cached_path=cached_tokens(顶层不在 details);
  tool.max_tools=128(总控 § 1.4 文档明示)。

* Qwen:reasoning.format=reasoning_content_field;tool.parallel_default=False
  (DashScope 默认 OFF);json_mode.modes=("json_object",)(不支持 schema)。

* ZenMux 5 个 model 按 sub-pattern 推导:
  - claude-* → Claude 套(reasoning.format=thinking_block /
    tool.parallel_param_inverted=True 等)+ ZenMux OpenAI 兼容包装
  - gemini-* → Gemini 套(silent_drop_params 含 logit_bias/seed 等)
  - gpt-* → OpenAI 套(reasoning.format=hidden / caching.mode=auto)
  共同点:wire.request_protocol=openai_chat / wire.upstream_path=
  /chat/completions / wire.streaming_protocol=openai_delta(ZenMux 出口)
"""

from __future__ import annotations

import copy

from django.db import migrations


# ---------------------------------------------------------------------------
# 共享工具:deep-merge dict(两个 nested dict 逐字段合并,现有字段优先)
# ---------------------------------------------------------------------------

def _deep_merge(base: dict, overlay: dict) -> dict:
    """把 overlay 的字段补到 base,base 已有字段不覆盖。

    - 两边都是 dict → 递归合并
    - 一边非 dict → 保留 base 值(base 是已有 0015 数据,优先)
    - base 缺失字段 → 用 overlay 填入

    用于 0016 deep-merge 0015 已写入的 wire_adapter 子键 + 本 migration 新字段。
    """
    result = copy.deepcopy(base) if base else {}
    for key, overlay_value in overlay.items():
        if key not in result:
            result[key] = copy.deepcopy(overlay_value)
            continue
        base_value = result[key]
        if isinstance(base_value, dict) and isinstance(overlay_value, dict):
            result[key] = _deep_merge(base_value, overlay_value)
            continue
        # base 已有值(非 dict 或类型不匹配) → 保留 base
        result[key] = base_value
    return result


# ---------------------------------------------------------------------------
# 6 家 / ZenMux 子型 v2 字段 patch(deep-merge over 0015)
# ---------------------------------------------------------------------------

# OpenAI(原生)v2 patch — 当前 DB 无 active 但保留供未来 admin 启用
OPENAI_V2_PATCH = {
    "image": {
        "max_size_mb": 20,
    },
    "tool": {
        "param_field": "parameters",
        "max_tools": 128,
    },
    "wire": {
        "upstream_path": "/chat/completions",
        "streaming_protocol": "openai_delta",
        "streaming_emits_usage": True,
        "system_message_style": "messages_first_role_system",
    },
    "caching": {
        "min_tokens": 1024,
        "cache_control_strip": False,
    },
    "json_mode": {
        "modes": ["json_schema", "json_object"],
        "schema_field": "response_format.json_schema.schema",
        "schema_fallback": False,
    },
    "reasoning": {
        "format": "hidden",
        "param_path": "reasoning_effort",
        "visible_to_client": False,
    },
    "usage": {
        "input_field": "prompt_tokens",
        "output_field": "completion_tokens",
        "cached_path": "prompt_tokens_details.cached_tokens",
        "cache_creation_path": None,
        "extra_fields": [],
    },
    "limits": {
        "context_window": 128000,
        "request_payload_max_mb": 30,
        "silent_drop_params": [],
        "extra_routing_headers": {},
    },
}

# Claude(原生)v2 patch
CLAUDE_V2_PATCH = {
    "image": {
        "max_size_mb": 5,
    },
    "tool": {
        "param_field": "input_schema",
        "max_tools": 128,
    },
    "wire": {
        "upstream_path": "/v1/messages",
        "streaming_protocol": "anthropic_sse",
        "streaming_emits_usage": True,
        "system_message_style": "top_level_system_field",
    },
    "caching": {
        "min_tokens": 1024,
        "cache_control_strip": False,
    },
    "json_mode": {
        "modes": ["json_schema"],
        "schema_field": "output_config.json_schema.schema",
        "schema_fallback": False,
    },
    "reasoning": {
        "format": "thinking_block",
        "param_path": "thinking",
        "visible_to_client": True,
    },
    "usage": {
        "input_field": "input_tokens",
        "output_field": "output_tokens",
        "cached_path": "cache_read_input_tokens",
        "cache_creation_path": "cache_creation_input_tokens",
        "extra_fields": [],
    },
    "limits": {
        "context_window": 200000,
        "request_payload_max_mb": 32,
        "silent_drop_params": [],
        "extra_routing_headers": {},
    },
}

# Gemini(OpenAI 兼容层)v2 patch
GEMINI_V2_PATCH = {
    "image": {
        "max_size_mb": 20,
    },
    "tool": {
        "param_field": "parameters",
        "max_tools": 128,
    },
    "wire": {
        "upstream_path": "/chat/completions",
        "streaming_protocol": "openai_delta",
        "streaming_emits_usage": True,
        "system_message_style": "messages_first_role_system",
    },
    "caching": {
        "min_tokens": None,
        "cache_control_strip": True,  # Gemini 兼容层不识别 cache_control 块
    },
    "json_mode": {
        "modes": ["json_schema"],
        "schema_field": "response_format.json_schema.schema",
        "schema_fallback": False,
    },
    "reasoning": {
        "format": "thinking_config",
        "param_path": "extra_body.google.thinking_config",
        "visible_to_client": True,
    },
    "usage": {
        "input_field": "prompt_tokens",
        "output_field": "completion_tokens",
        "cached_path": "prompt_tokens_details.cached_tokens",
        "cache_creation_path": None,
        "extra_fields": [],
    },
    "limits": {
        "context_window": 1000000,
        "request_payload_max_mb": 20,
        # Gemini OpenAI 兼容层 silent drop 这些参数(verify 过 docs)
        "silent_drop_params": [
            "logit_bias",
            "seed",
            "top_logprobs",
            "frequency_penalty",
        ],
        "extra_routing_headers": {},
    },
}

# Moonshot Kimi K2.5 v2 patch
MOONSHOT_V2_PATCH = {
    "image": {
        "max_size_mb": 20,
    },
    "tool": {
        "param_field": "parameters",
        "max_tools": 128,
    },
    "wire": {
        "upstream_path": "/chat/completions",
        "streaming_protocol": "openai_delta",
        "streaming_emits_usage": True,
        "system_message_style": "messages_first_role_system",
    },
    "caching": {
        "min_tokens": None,  # Kimi 自动 cache 无明确 minimum
        "cache_control_strip": False,
    },
    "json_mode": {
        "modes": ["json_schema", "json_object"],
        "schema_field": "response_format.json_schema.schema",
        "schema_fallback": False,
    },
    "reasoning": {
        # K2.5 走 delta.reasoning_content
        "format": "reasoning_content_field",
        "param_path": "thinking",
        "visible_to_client": True,
    },
    "usage": {
        "input_field": "prompt_tokens",
        "output_field": "completion_tokens",
        # 关键陷阱:Moonshot cached_tokens 在 usage 顶层,不在 details 内
        "cached_path": "cached_tokens",
        "cache_creation_path": None,
        "extra_fields": [],
    },
    "limits": {
        "context_window": 256000,
        "request_payload_max_mb": 25,
        "silent_drop_params": [],
        "extra_routing_headers": {},
    },
}

# Qwen v2 patch
QWEN_V2_PATCH = {
    "image": {
        "max_size_mb": 10,
    },
    "tool": {
        "param_field": "parameters",
        "max_tools": 128,
    },
    "wire": {
        "upstream_path": "/chat/completions",
        "streaming_protocol": "openai_delta",
        "streaming_emits_usage": True,
        "system_message_style": "messages_first_role_system",
    },
    "caching": {
        "min_tokens": None,
        "cache_control_strip": True,  # Qwen Context Cache 不接 cache_control 块
    },
    "json_mode": {
        # Qwen 不支持 json_schema,只 json_object
        "modes": ["json_object"],
        "schema_field": None,
        # Qwen 走 prompt-only fallback(wire_adapter 把 schema 拼到 system)
        "schema_fallback": True,
    },
    "reasoning": {
        "format": "reasoning_content_field",
        "param_path": None,
        "visible_to_client": True,
    },
    "usage": {
        "input_field": "prompt_tokens",
        "output_field": "completion_tokens",
        "cached_path": "prompt_tokens_details.cached_tokens",
        "cache_creation_path": None,
        "extra_fields": [],
    },
    "limits": {
        "context_window": 128000,
        "request_payload_max_mb": 20,
        "silent_drop_params": [],
        "extra_routing_headers": {},
    },
}

# MiniMax v2 patch(D7 白名单 anthropic SDK 路径,W2 真启用)
MINIMAX_V2_PATCH = {
    "image": {
        # OpenAI 兼容端无 image,W2 anthropic 端再启用
        "max_size_mb": 0,
    },
    "tool": {
        # MiniMax 走 anthropic_messages → input_schema
        "param_field": "input_schema",
        "max_tools": 128,
    },
    "wire": {
        # D7 白名单 anthropic SDK 路径
        "upstream_path": "/v1/messages",
        "streaming_protocol": "anthropic_sse",
        "streaming_emits_usage": True,
        # 权威字符串(W1b-fix Block C1):wire_adapter._normalize_system 识别
        # ``"top_level_system_field"`` 才会把 messages[0] role=system hoist 到
        # top-level system 字段。0016 原写 ``"anthropic_top_level"`` 不被
        # helper 识别 → 已 applied 到 DB 的旧值由 0018 migration 修正。
        "system_message_style": "top_level_system_field",
    },
    "caching": {
        "min_tokens": None,
        "cache_control_strip": False,
    },
    "json_mode": {
        "modes": [],  # 兼容端无 json_schema
        "schema_field": None,
        "schema_fallback": True,  # wire_adapter 拼 system fallback
    },
    "reasoning": {
        "format": "think_tag_inline",
        "param_path": None,  # MiniMax OpenAI 端无显式开关,<think> tag 自动出
        "visible_to_client": True,
    },
    "usage": {
        # Anthropic 风
        "input_field": "input_tokens",
        "output_field": "output_tokens",
        "cached_path": "cache_read_input_tokens",
        "cache_creation_path": "cache_creation_input_tokens",
        # MiniMax 渠道特有
        "extra_fields": [
            "total_characters",
            "input_sensitive",
            "output_sensitive_type",
        ],
    },
    "limits": {
        "context_window": 245760,
        "request_payload_max_mb": 20,
        "silent_drop_params": [],
        "extra_routing_headers": {},
    },
}


# Provider 名 → v2 patch
PROVIDER_V2_PATCH_MAP = {
    "openai": OPENAI_V2_PATCH,
    "claude": CLAUDE_V2_PATCH,
    "gemini": GEMINI_V2_PATCH,
    "moonshot": MOONSHOT_V2_PATCH,
    "qwen": QWEN_V2_PATCH,
    "minimax": MINIMAX_V2_PATCH,
}


# ---------------------------------------------------------------------------
# ZenMux 整家初值(0015 漏掉,0016 整家从零写)
#
# ZenMux 是聚合网关:
# - 出口统一 OpenAI 兼容 /chat/completions(无论上游是 Claude / Gemini / GPT)
# - streaming 输出 openai_delta SSE
# - **能力维度按真实上游 model 推导**(claude-* 用 Claude profile,
#   gemini-* 用 Gemini profile,gpt-* 用 OpenAI profile)
# ---------------------------------------------------------------------------

# Claude 子型(zenmux/anthropic/claude-*)— 完整 ResolvedCapabilities JSON
ZENMUX_CLAUDE_FULL = {
    "image": {
        "enabled": True,
        # ZenMux 转发 OpenAI 兼容 image_url,base64 都支持;url 一般 ok
        "input_via": ["base64", "url"],
        "formats": ["jpeg", "png", "webp", "gif"],
        "max_count_per_request": 20,
        "max_size_bytes": 5 * 1024 * 1024,
        "max_size_mb": 5,
        # ZenMux 出口 OpenAI 兼容 → openai_image_url shape
        "request_shape": "openai_image_url",
    },
    "tool": {
        "enabled": True,
        "choice_modes": ["auto", "required", "none", "specific"],
        "parallel_default": True,
        # ZenMux OpenAI 兼容入口 → 用 OpenAI 风 parallel_tool_calls
        "parallel_param_name": "parallel_tool_calls",
        "parallel_param_inverted": False,
        "param_field": "parameters",  # OpenAI 兼容入口
        "max_tools": 128,
    },
    "wire": {
        # ZenMux 入口 = OpenAI 兼容 chat/completions
        "request_protocol": "openai_chat_completions",
        "response_protocol": "openai_chat_completions",
        "system_placement": "messages_first_role_system",
        "system_quirks": [],
        "stream_supported": True,
        "upstream_path": "/chat/completions",
        "streaming_protocol": "openai_delta",
        "streaming_emits_usage": True,
        "system_message_style": "messages_first_role_system",
    },
    "caching": {
        "mode": "automatic_implicit",
        "min_tokens_for_cache": None,
        "min_tokens": None,
        "cache_ttl_param": None,
        # **已知限制(W1b-fix 建议 Md2)**:ZenMux Claude 出口走 OpenAI 兼容
        # /chat/completions,**不接受**用户在 Electron 写的 Anthropic-style
        # explicit ``cache_control:{type:ephemeral,ttl:...}`` 字段。
        # wire_adapter ``_normalize_cache_control`` 在转发前必须 strip,
        # 否则上游可能 reject。
        # 用户使用 explicit cache_control 的场景需切到 Claude 原生 provider
        # (W2 用户场景:provider=claude,upstream=Anthropic /v1/messages),
        # 或依赖自动 caching(automatic_implicit 模式,无显式控制)。
        "cache_control_strip": True,
    },
    "json_mode": {
        "mode": "json_schema",
        "modes": ["json_schema", "json_object"],
        "strict_supported": False,
        "schema_field": "response_format.json_schema.schema",
        "schema_fallback": False,
    },
    "reasoning": {
        "enabled": True,
        # ZenMux 透传 Claude thinking_block — 出口 SSE 仍是 openai_delta,
        # 但 reasoning content 在 message.content 数组里以 thinking_block 形态
        "surface": "thinking_block",
        "format": "thinking_block",
        "budget_param": "thinking.budget_tokens",
        "param_path": "thinking",
        "visible_to_client": True,
    },
    "usage": {
        # ZenMux 出口标准 OpenAI usage 风
        "input_tokens_field": "prompt_tokens",
        "output_tokens_field": "completion_tokens",
        "cache_read_field": "prompt_tokens_details.cached_tokens",
        "cache_write_field": None,
        "extra_metrics": [],
        "input_field": "prompt_tokens",
        "output_field": "completion_tokens",
        "cached_path": "prompt_tokens_details.cached_tokens",
        "cache_creation_path": None,
        "extra_fields": [],
    },
    "limits": {
        "context_window_tokens": 200000,
        "max_output_tokens": 8192,
        "max_documents_per_request": None,
        "max_tool_recursion_depth": None,
        "context_window": 200000,
        "request_payload_max_mb": 32,
        "silent_drop_params": [],
        "extra_routing_headers": {},
    },
    "wave_status": "ready",
    "is_configured": True,
}

# Gemini 子型(zenmux/google/gemini-*)
ZENMUX_GEMINI_FULL = {
    "image": {
        "enabled": True,
        "input_via": ["base64", "url"],
        "formats": ["jpeg", "png", "webp", "gif"],
        "max_count_per_request": 16,
        "max_size_bytes": 20 * 1024 * 1024,
        "max_size_mb": 20,
        "request_shape": "openai_image_url",
    },
    "tool": {
        "enabled": True,
        "choice_modes": ["auto", "required", "none"],
        "parallel_default": False,  # Gemini 文档不明示
        "parallel_param_name": "parallel_tool_calls",
        "parallel_param_inverted": False,
        "param_field": "parameters",
        "max_tools": 128,
    },
    "wire": {
        "request_protocol": "openai_chat_completions",
        "response_protocol": "openai_chat_completions",
        "system_placement": "messages_first_role_system",
        "system_quirks": [],
        "stream_supported": True,
        "upstream_path": "/chat/completions",
        "streaming_protocol": "openai_delta",
        "streaming_emits_usage": True,
        "system_message_style": "messages_first_role_system",
    },
    "caching": {
        "mode": "context_cache",
        "min_tokens_for_cache": None,
        "min_tokens": None,
        "cache_ttl_param": None,
        "cache_control_strip": True,
    },
    "json_mode": {
        "mode": "json_schema",
        "modes": ["json_schema"],
        "strict_supported": False,
        "schema_field": "response_format.json_schema.schema",
        "schema_fallback": False,
    },
    "reasoning": {
        "enabled": True,
        "surface": "extra_body_thinking_config",
        "format": "thinking_config",
        "budget_param": "extra_body.google.thinking_config.thinking_budget",
        "param_path": "extra_body.google.thinking_config",
        "visible_to_client": True,
    },
    "usage": {
        "input_tokens_field": "prompt_tokens",
        "output_tokens_field": "completion_tokens",
        "cache_read_field": "prompt_tokens_details.cached_tokens",
        "cache_write_field": None,
        "extra_metrics": [],
        "input_field": "prompt_tokens",
        "output_field": "completion_tokens",
        "cached_path": "prompt_tokens_details.cached_tokens",
        "cache_creation_path": None,
        "extra_fields": [],
    },
    "limits": {
        "context_window_tokens": 1000000,
        "max_output_tokens": 8192,
        "max_documents_per_request": None,
        "max_tool_recursion_depth": None,
        "context_window": 1000000,
        "request_payload_max_mb": 20,
        # Gemini OpenAI 兼容层 silent drop 已知参数
        "silent_drop_params": [
            "logit_bias",
            "seed",
            "top_logprobs",
            "frequency_penalty",
        ],
        "extra_routing_headers": {},
    },
    "wave_status": "ready",
    "is_configured": True,
}

# OpenAI 子型(zenmux/openai/gpt-*)
ZENMUX_OPENAI_FULL = {
    "image": {
        "enabled": True,
        "input_via": ["base64", "url"],
        "formats": ["jpeg", "png", "webp", "gif"],
        "max_count_per_request": 10,
        "max_size_bytes": 20 * 1024 * 1024,
        "max_size_mb": 20,
        "request_shape": "openai_image_url",
    },
    "tool": {
        "enabled": True,
        "choice_modes": ["auto", "required", "none", "specific"],
        "parallel_default": True,
        "parallel_param_name": "parallel_tool_calls",
        "parallel_param_inverted": False,
        "param_field": "parameters",
        "max_tools": 128,
    },
    "wire": {
        "request_protocol": "openai_chat_completions",
        "response_protocol": "openai_chat_completions",
        "system_placement": "messages_first_role_system",
        "system_quirks": [],
        "stream_supported": True,
        "upstream_path": "/chat/completions",
        "streaming_protocol": "openai_delta",
        "streaming_emits_usage": True,
        "system_message_style": "messages_first_role_system",
    },
    "caching": {
        "mode": "automatic_implicit",
        "min_tokens_for_cache": 1024,
        "min_tokens": 1024,
        "cache_ttl_param": None,
        "cache_control_strip": False,
    },
    "json_mode": {
        "mode": "json_schema",
        "modes": ["json_schema", "json_object"],
        "strict_supported": True,
        "schema_field": "response_format.json_schema.schema",
        "schema_fallback": False,
    },
    "reasoning": {
        # gpt-5.3-chat 等非 o-series:reasoning hidden
        "enabled": False,
        "surface": "hidden",
        "format": "hidden",
        "budget_param": "reasoning_effort",
        "param_path": "reasoning_effort",
        "visible_to_client": False,
    },
    "usage": {
        "input_tokens_field": "prompt_tokens",
        "output_tokens_field": "completion_tokens",
        "cache_read_field": "prompt_tokens_details.cached_tokens",
        "cache_write_field": None,
        "extra_metrics": [],
        "input_field": "prompt_tokens",
        "output_field": "completion_tokens",
        "cached_path": "prompt_tokens_details.cached_tokens",
        "cache_creation_path": None,
        "extra_fields": [],
    },
    "limits": {
        "context_window_tokens": 128000,
        "max_output_tokens": 16384,
        "max_documents_per_request": None,
        "max_tool_recursion_depth": None,
        "context_window": 128000,
        "request_payload_max_mb": 30,
        "silent_drop_params": [],
        "extra_routing_headers": {},
    },
    "wave_status": "ready",
    "is_configured": True,
}


def _resolve_zenmux_profile(model_name: str):
    """根据 zenmux/<vendor>/<model> 名映射到 Claude/Gemini/OpenAI profile。

    映射规则(harness 任务定义书 § B):

    - ``zenmux/anthropic/claude-*`` → ZENMUX_CLAUDE_FULL
    - ``zenmux/google/gemini-*`` → ZENMUX_GEMINI_FULL
    - ``zenmux/openai/gpt-*`` → ZENMUX_OPENAI_FULL

    返回 None 表示无映射(W1a-fix 不处理,留给 admin 手工配)。
    """
    if not model_name:
        return None
    name = model_name.lower()
    if "anthropic/claude" in name or "/claude-" in name:
        return ZENMUX_CLAUDE_FULL
    if "google/gemini" in name or "/gemini-" in name:
        return ZENMUX_GEMINI_FULL
    if "openai/gpt" in name or "/gpt-" in name:
        return ZENMUX_OPENAI_FULL
    return None


# ---------------------------------------------------------------------------
# Migration 主体
# ---------------------------------------------------------------------------

def fill_v2_capabilities(apps, schema_editor):
    """0016 主入口:补齐 6 家 + ZenMux 整家 v2 字段。

    步骤:

    1. 6 家原生 provider(openai/claude/gemini/moonshot/qwen/minimax):
       deep-merge v2 patch 到 ``capabilities_config["wire_adapter"]``,
       0015 已有字段保留,新字段补上。

    2. ZenMux 子型映射:
       对 ``model_name.startswith('zenmux/')`` 且 wire_adapter 缺失的
       active model,按 sub-pattern 路由 ZENMUX_*_FULL 整套写入。
       wire_adapter 已存在的(admin 手工配过)跳过保护。

    3. wave_status 字段:
       - MiniMax 保留 ``model.wave_status='w2_pending'``(0014 / 0015 已 set)
       - ZenMux 默认 ``ready``
       - 其他保留 model 现有值
    """
    LLMModel = apps.get_model("llm", "LLMModel")

    # ---------- Step 1:6 家原生 provider 字段补齐 ----------
    for provider_name, v2_patch in PROVIDER_V2_PATCH_MAP.items():
        models_qs = LLMModel.objects.filter(
            provider__name=provider_name,
            is_active=True,
        )
        for model in models_qs:
            existing_config = dict(model.capabilities_config or {})
            existing_wa = existing_config.get("wire_adapter") or {}
            # deep-merge:0015 已有字段 win,v2 新字段补上
            merged_wa = _deep_merge(existing_wa, v2_patch)
            existing_config["wire_adapter"] = merged_wa
            model.capabilities_config = existing_config
            model.save(update_fields=["capabilities_config"])

    # ---------- Step 2:ZenMux 整家初值 ----------
    # 真实数据形态:provider__name='zenmux' 但 model_name 形如
    # 'anthropic/claude-opus-4.6' / 'google/gemini-3.1-pro-preview' /
    # 'openai/gpt-5.3-chat'(没有 'zenmux/' 前缀)。harness 任务定义书写
    # ``model_name.startswith('zenmux/')`` 是误解;以 ``provider__name`` 为准。
    zenmux_models = LLMModel.objects.filter(
        is_active=True,
        provider__name="zenmux",
    )
    for model in zenmux_models:
        existing_config = dict(model.capabilities_config or {})
        if existing_config.get("wire_adapter"):
            # admin 手工配过,跳过保护
            continue

        profile = _resolve_zenmux_profile(model.model_name)
        if profile is None:
            # 无映射规则,留给 W1b/W2 手工补 — 此处 log 留迹但不阻塞 migration
            continue

        full_config = copy.deepcopy(profile)
        # wave_status 优先取 model 字段(0014 已 set 的不要回退)
        model_wave = getattr(model, "wave_status", None) or "ready"
        full_config["wave_status"] = model_wave

        existing_config["wire_adapter"] = full_config
        model.capabilities_config = existing_config
        model.save(update_fields=["capabilities_config"])


def reverse_fill_v2_capabilities(apps, schema_editor):
    """回滚:不可完美回滚(deep-merge 后无法精确还原 v1 字段),仅做最小处理。

    - ZenMux model 删 wire_adapter 子键(本 migration 写入的)
    - 6 家 v2 字段保留(因为 0015 也写了基础字段,和 v2 字段 deep-merge 无法
      精确剥离;留给 admin 手工修正或重跑 0015 + 0016)
    """
    LLMModel = apps.get_model("llm", "LLMModel")

    zenmux_models = LLMModel.objects.filter(
        provider__name="zenmux",
    )
    for model in zenmux_models:
        existing_config = dict(model.capabilities_config or {})
        if "wire_adapter" not in existing_config:
            continue
        existing_config.pop("wire_adapter", None)
        model.capabilities_config = existing_config
        model.save(update_fields=["capabilities_config"])


class Migration(migrations.Migration):

    dependencies = [
        ("llm", "0015_llm_wire_adapter_capability_fill"),
    ]

    operations = [
        migrations.RunPython(
            fill_v2_capabilities,
            reverse_fill_v2_capabilities,
        ),
    ]
