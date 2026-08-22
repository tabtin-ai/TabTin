"""
Provider capability profiles and matrix definitions for AdminDash.

This module provides:
- capability matrix metadata (UI schema for flags/limits/billing fields)
- provider-level default capability profiles (by provider name)
"""

from __future__ import annotations

from copy import deepcopy
from typing import Any, Dict, List, Optional


CAPABILITY_SCHEMA_VERSION = "2026-02-14"


_CAPABILITY_MATRIX: Dict[str, Any] = {
    "flags": [
        {
            "key": "supports_streaming",
            "label": "流式输出",
            "description": "是否支持流式响应。",
            "default_value": False,
        },
        {
            "key": "supports_function_calling",
            "label": "函数/工具调用",
            "description": "是否支持 tool/function call。",
            "default_value": False,
        },
        {
            "key": "supports_tool_choice",
            "label": "工具选择策略",
            "description": "是否支持 tool_choice 参数。",
            "default_value": False,
        },
        {
            "key": "supports_parallel_function_calling",
            "label": "并行函数调用",
            "description": "是否支持并行函数调用。",
            "default_value": False,
        },
        {
            "key": "supports_vision",
            "label": "图像输入",
            "description": "是否支持图片输入。",
            "default_value": False,
        },
        {
            "key": "supports_document_input",
            "label": "文档输入",
            "description": "是否支持文档/PDF输入。",
            "default_value": False,
        },
        {
            "key": "supports_prompt_caching",
            "label": "Prompt 缓存",
            "description": "是否支持上下文缓存读写计费。",
            "default_value": False,
        },
        {
            "key": "supports_reasoning",
            "label": "推理/Thinking",
            "description": "是否支持思维链输出或 reasoning 字段。",
            "default_value": False,
        },
        {
            "key": "supports_json_mode",
            "label": "JSON Mode",
            "description": "是否支持结构化 JSON 输出。",
            "default_value": True,
        },
        {
            "key": "supports_responses_api",
            "label": "Responses API",
            "description": "是否支持 OpenAI Responses API（Items 协议）。",
            "default_value": False,
        },
        {
            "key": "supports_token_estimate",
            "label": "Token 原生估算",
            "description": "是否支持渠道原生 token 估算接口。",
            "default_value": False,
        },
    ],
    "limits": [
        {
            "key": "max_documents_per_request",
            "label": "单次请求文档数上限",
            "description": "文档输入场景下每次请求允许的最大文档数。",
            "type": "integer",
            "min": 1,
            "max": 200,
        },
    ],
    "billing": [
        {
            "key": "cache_read_input_price_per_1k",
            "label": "缓存命中输入价格(每1K)",
            "description": "Prompt cache 读取命中的输入价格。",
            "type": "number",
            "min": 0,
            "step": 0.000001,
        },
        {
            "key": "cache_write_input_price_per_1k",
            "label": "缓存写入输入价格(每1K)",
            "description": "Prompt cache 写入的输入价格。",
            "type": "number",
            "min": 0,
            "step": 0.000001,
        },
    ],
}


_DEFAULT_PROVIDER_PROFILE: Dict[str, Any] = {
    "provider": "custom",
    "display_name": "Custom",
    "api_style": "openai_compatible",
    "recommended_base_url": "",
    "capabilities": {
        "supports_streaming": True,
        "supports_function_calling": True,
        "supports_tool_choice": True,
        "supports_parallel_function_calling": False,
        "supports_vision": False,
        "supports_document_input": False,
        "supports_prompt_caching": False,
        "supports_reasoning": False,
        "supports_json_mode": True,
        "supports_responses_api": False,
        "supports_token_estimate": False,
    },
    "limits": {
        "max_documents_per_request": None,
    },
    "billing_defaults": {
        "cache_read_input_price_per_1k": None,
        "cache_write_input_price_per_1k": None,
    },
    "parameter_support": {},
    "notes": [],
    "recommended_models": [],
}


_PROVIDER_PROFILES: Dict[str, Dict[str, Any]] = {
    "openai": {
        **_DEFAULT_PROVIDER_PROFILE,
        "provider": "openai",
        "display_name": "OpenAI",
        "recommended_base_url": "https://api.openai.com/v1",
        "capabilities": {
            **_DEFAULT_PROVIDER_PROFILE["capabilities"],
            "supports_parallel_function_calling": True,
            "supports_vision": True,
            "supports_prompt_caching": True,
            "supports_responses_api": True,
        },
        "notes": ["OpenAI 兼容接口，能力以具体模型为准。"],
    },
    "codex": {
        **_DEFAULT_PROVIDER_PROFILE,
        "provider": "codex",
        "display_name": "OpenAI Codex",
        "recommended_base_url": "https://api.openai.com/v1",
        "capabilities": {
            **_DEFAULT_PROVIDER_PROFILE["capabilities"],
            "supports_parallel_function_calling": True,
            "supports_responses_api": True,
            "supports_reasoning": True,
            "supports_vision": True,
        },
        "notes": [
            "Codex 默认建议走 Responses API。",
            "当前按 API key/access token 方式接入，能力以实际网关返回为准。",
            "Responses API 支持 input_image；本机 ChatGPT 登录路径见 Electron LocalCodex。",
        ],
    },
    "qwen": {
        **_DEFAULT_PROVIDER_PROFILE,
        "provider": "qwen",
        "display_name": "Qwen",
        "recommended_base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "capabilities": {
            **_DEFAULT_PROVIDER_PROFILE["capabilities"],
            "supports_reasoning": True,
            "supports_vision": True,
            "supports_prompt_caching": True,
        },
        "notes": [
            "通义千问兼容 OpenAI 接口，能力按具体模型区分。",
            "百炼 Coding Plan 专用端点 https://coding.dashscope.aliyuncs.com/v1 与 sk-sp- Key 不互通于按量 dashscope。",
            "部分模型支持阶梯计费（按输入 token 总量分档），详见 custom_billing_config.tiered_pricing。",
        ],
        "recommended_models": [
            {
                "model_name": "qwen3.7-plus",
                "display_name": "Qwen 3.7 Plus",
                "context_window_tokens": 1048576,
                "max_output_tokens": 16384,
                "supports_streaming": True,
                "supports_function_calling": True,
                "supports_vision": True,
                "supports_reasoning": True,
            },
            {
                "model_name": "qwen3.6-plus",
                "display_name": "Qwen 3.6 Plus",
                "context_window_tokens": 1048576,
                "max_output_tokens": 16384,
                "supports_streaming": True,
                "supports_function_calling": True,
                "supports_vision": True,
                "supports_reasoning": True,
            },
            {
                "model_name": "kimi-k2.5",
                "display_name": "Kimi K2.5 (Coding Plan)",
                "context_window_tokens": 262144,
                "supports_streaming": True,
                "supports_function_calling": True,
                "supports_vision": True,
                "supports_reasoning": True,
            },
            {
                "model_name": "glm-5",
                "display_name": "GLM-5 (Coding Plan)",
                "context_window_tokens": 200000,
                "supports_streaming": True,
                "supports_function_calling": True,
            },
            {
                "model_name": "qwen3.5-plus",
                "display_name": "Qwen 3.5 Plus",
                "context_window_tokens": 1048576,
                "max_output_tokens": 16384,
                "input_price_per_1k": "0.0008",
                "output_price_per_1k": "0.0048",
                "supports_streaming": True,
                "supports_function_calling": True,
                "supports_vision": True,
                "supports_reasoning": True,
                "tiered_pricing": True,
            },
        ],
    },
    "claude": {
        **_DEFAULT_PROVIDER_PROFILE,
        "provider": "claude",
        "display_name": "Claude",
        "recommended_base_url": "https://api.anthropic.com/v1",
        "api_style": "anthropic",
        "capabilities": {
            **_DEFAULT_PROVIDER_PROFILE["capabilities"],
            "supports_vision": True,
            # ：聊天文档仅 Moonshot 经 wire_adapter file_extract；Claude 另立能力后再开
            "supports_document_input": False,
            "supports_prompt_caching": True,
            "supports_reasoning": True,
        },
        "notes": ["Anthropic 原生接口可支持更细粒度能力。"],
    },
    "gemini": {
        **_DEFAULT_PROVIDER_PROFILE,
        "provider": "gemini",
        "display_name": "Gemini",
        "recommended_base_url": "https://generativelanguage.googleapis.com/v1beta/openai",
        "capabilities": {
            **_DEFAULT_PROVIDER_PROFILE["capabilities"],
            "supports_vision": True,
            # ：聊天文档仅 Moonshot 经 wire_adapter file_extract；Gemini 另立能力后再开
            "supports_document_input": False,
            "supports_prompt_caching": True,
            "supports_reasoning": True,
            "supports_token_estimate": True,
        },
        "notes": ["Gemini 可通过原生 SDK 获取更完整多模态能力。"],
    },
    "moonshot": {
        **_DEFAULT_PROVIDER_PROFILE,
        "provider": "moonshot",
        "display_name": "Moonshot / Kimi",
        "recommended_base_url": "https://api.moonshot.cn/v1",
        "capabilities": {
            **_DEFAULT_PROVIDER_PROFILE["capabilities"],
            "supports_parallel_function_calling": True,
            "supports_vision": True,
            "supports_document_input": True,
            "supports_prompt_caching": True,
            "supports_reasoning": True,
            "supports_token_estimate": True,
        },
        "limits": {
            "max_documents_per_request": 20,
        },
        "billing_defaults": {
            "cache_read_input_price_per_1k": "0.0007",
            "cache_write_input_price_per_1k": None,
        },
        "notes": [
            "Kimi 支持 token 估算接口与自动上下文缓存，具体能力以模型版本为准。",
        ],
        "recommended_models": [
            {
                "model_name": "kimi-k3",
                "display_name": "Kimi K3",
                "context_window_tokens": 1048576,
                "max_input_tokens": 1048576,
                "max_output_tokens": 131072,
                "input_price_per_1k": "0.02",
                "output_price_per_1k": "0.1",
                "supports_streaming": True,
                "supports_function_calling": True,
                "supports_vision": True,
                "supports_reasoning": True,
            },
            {
                "model_name": "kimi-k2.6",
                "display_name": "Kimi K2.6",
                "context_window_tokens": 262144,
                "max_input_tokens": 262144,
                "max_output_tokens": 32768,
                "input_price_per_1k": "0.0065",
                "output_price_per_1k": "0.027",
                "supports_streaming": True,
                "supports_function_calling": True,
                "supports_vision": True,
                "supports_reasoning": True,
            },
            {
                "model_name": "kimi-k2.5",
                "display_name": "Kimi K2.5",
                "context_window_tokens": 262144,
                "max_input_tokens": 262144,
                "max_output_tokens": 32768,
                "input_price_per_1k": "0.004",
                "output_price_per_1k": "0.021",
                "supports_streaming": True,
                "supports_function_calling": True,
                "supports_vision": True,
                "supports_reasoning": True,
            },
        ],
    },
    "minimax": {
        **_DEFAULT_PROVIDER_PROFILE,
        "provider": "minimax",
        "display_name": "MiniMax",
        "recommended_base_url": "https://api.minimaxi.com/anthropic",
        "api_style": "anthropic_sdk_compatible",
        "capabilities": {
            **_DEFAULT_PROVIDER_PROFILE["capabilities"],
            "supports_parallel_function_calling": False,
            "supports_vision": True,
            "supports_document_input": False,
            "supports_prompt_caching": True,
            "supports_reasoning": True,
        },
        "parameter_support": {
            "model": "supported",
            "messages": "partial",
            "max_tokens": "supported",
            "stream": "supported",
            "system": "supported",
            "temperature": "supported",
            "tool_choice": "supported",
            "tools": "supported",
            "top_p": "supported",
            "thinking": "supported",
            "metadata": "supported",
            "top_k": "ignored",
            "stop_sequences": "ignored",
            "service_tier": "supported",
            "mcp_servers": "ignored",
            "context_management": "ignored",
            "container": "ignored",
            "image": "partial",
            "document": "unsupported",
        },
        "billing_defaults": {
            "cache_read_input_price_per_1k": "0.00042",
            "cache_write_input_price_per_1k": "0.002625",
        },
        "notes": [
            "Anthropic 兼容端点 https://api.minimaxi.com/anthropic；Token Plan 订阅 Key 与按量 API Key 不互通。",
            "MiniMax-M3 支持 1M 上下文与图片/视频输入；M2.7 系列为 256K 且仅文本与工具调用。",
            "Prompt 缓存为自动缓存，建议把静态上下文放在对话前缀。",
        ],
        "recommended_models": [
            {
                "model_name": "MiniMax-M3",
                "display_name": "MiniMax M3 (1M)",
                "context_window_tokens": 1000000,
                "max_output_tokens": 64000,
                "input_price_per_1k": "0.0021",
                "output_price_per_1k": "0.0084",
                "supports_streaming": True,
                "supports_function_calling": True,
                "supports_vision": True,
                "supports_reasoning": True,
            },
            {
                "model_name": "MiniMax-M2.7",
                "display_name": "MiniMax M2.7",
                "context_window_tokens": 204800,
                "input_price_per_1k": "0.0021",
                "output_price_per_1k": "0.0084",
            },
            {
                "model_name": "MiniMax-M2.7-highspeed",
                "display_name": "MiniMax M2.7 Highspeed",
                "context_window_tokens": 204800,
                "input_price_per_1k": "0.0042",
                "output_price_per_1k": "0.0168",
            },
            {
                "model_name": "MiniMax-M2.5",
                "display_name": "MiniMax M2.5",
                "context_window_tokens": 204800,
                "input_price_per_1k": "0.0021",
                "output_price_per_1k": "0.0084",
            },
            {
                "model_name": "MiniMax-M2.5-highspeed",
                "display_name": "MiniMax M2.5 Highspeed",
                "context_window_tokens": 204800,
                "input_price_per_1k": "0.0042",
                "output_price_per_1k": "0.0168",
            },
        ],
    },
    "zhipu": {
        **_DEFAULT_PROVIDER_PROFILE,
        "provider": "zhipu",
        "display_name": "智谱 GLM",
        "recommended_base_url": "https://open.bigmodel.cn/api/coding/paas/v4",
        "api_style": "openai_compatible",
        "capabilities": {
            **_DEFAULT_PROVIDER_PROFILE["capabilities"],
            "supports_reasoning": True,
            "supports_prompt_caching": False,
        },
        "notes": [
            "GLM Coding Plan 专用端点 https://open.bigmodel.cn/api/coding/paas/v4；套餐 Key 与按量 API 不互通。",
            "Anthropic 兼容端点可选 https://open.bigmodel.cn/api/anthropic。",
            "GLM-5.2 为 1M 上下文；GLM-5-Turbo / GLM-4.7 为 200K。",
        ],
        "recommended_models": [
            {
                "model_name": "glm-5.2",
                "display_name": "GLM-5.2 (1M)",
                "context_window_tokens": 1000000,
                "max_output_tokens": 65536,
                "supports_streaming": True,
                "supports_function_calling": True,
                "supports_reasoning": True,
            },
            {
                "model_name": "glm-5-turbo",
                "display_name": "GLM-5 Turbo",
                "context_window_tokens": 200000,
                "max_output_tokens": 65536,
                "supports_streaming": True,
                "supports_function_calling": True,
                "supports_reasoning": True,
            },
            {
                "model_name": "glm-4.7",
                "display_name": "GLM-4.7",
                "context_window_tokens": 200000,
                "max_output_tokens": 65536,
                "supports_streaming": True,
                "supports_function_calling": True,
                "supports_json_mode": True,
            },
        ],
    },
    "zenmux": {
        **_DEFAULT_PROVIDER_PROFILE,
        "provider": "zenmux",
        "display_name": "ZenMux",
        "recommended_base_url": "https://zenmux.ai/api/v1",
        "api_style": "openai_compatible",
        "capabilities": {
            **_DEFAULT_PROVIDER_PROFILE["capabilities"],
            "supports_parallel_function_calling": True,
            "supports_vision": True,
            "supports_document_input": True,
            "supports_prompt_caching": True,
            "supports_reasoning": True,
        },
        "billing_defaults": {
            "cache_read_input_price_per_1k": None,
            "cache_write_input_price_per_1k": None,
        },
        "notes": [
            "ZenMux 是聚合 API 网关，支持 OpenAI / Anthropic / Google 等多家模型。",
            "模型名使用 provider/model 格式（如 openai/gpt-5.2-pro）。",
            "也提供 Anthropic 兼容端点 https://zenmux.ai/api/anthropic 和 Vertex AI 兼容端点 https://zenmux.ai/api/vertex-ai。",
        ],
        "recommended_models": [
            {
                "model_name": "anthropic/claude-sonnet-4.6",
                "display_name": "Claude Sonnet 4.6",
                "context_window_tokens": 200000,
                "input_price_per_1k": "0.003",
                "output_price_per_1k": "0.015",
            },
            {
                "model_name": "anthropic/claude-opus-4.6",
                "display_name": "Claude Opus 4.6",
                "context_window_tokens": 200000,
                "input_price_per_1k": "0.005",
                "output_price_per_1k": "0.025",
            },
            {
                "model_name": "openai/gpt-5.2-pro",
                "display_name": "GPT-5.2 Pro",
                "context_window_tokens": 400000,
                "input_price_per_1k": "0.021",
                "output_price_per_1k": "0.168",
            },
            {
                "model_name": "openai/gpt-5.2-codex",
                "display_name": "GPT-5.2 Codex",
                "context_window_tokens": 400000,
                "input_price_per_1k": "0.00125",
                "output_price_per_1k": "0.01",
            },
            {
                "model_name": "google/gemini-3.1-pro-preview",
                "display_name": "Gemini 3.1 Pro Preview",
                "context_window_tokens": 1048576,
                "input_price_per_1k": "0.002",
                "output_price_per_1k": "0.012",
            },
            {
                "model_name": "qwen/qwen3.5-plus",
                "display_name": "Qwen 3.5 Plus",
                "context_window_tokens": 1000000,
                "input_price_per_1k": "0.0004",
                "output_price_per_1k": "0.0024",
            },
        ],
    },
    "local": {
        **_DEFAULT_PROVIDER_PROFILE,
        "provider": "local",
        "display_name": "Local",
        "recommended_base_url": "http://localhost:11434/v1",
        "capabilities": {
            **_DEFAULT_PROVIDER_PROFILE["capabilities"],
            "supports_vision": False,
            "supports_prompt_caching": False,
        },
        "notes": ["本地渠道能力差异较大，建议按具体模型手动校准。"],
    },
}


def get_capability_matrix() -> Dict[str, Any]:
    """Return capability matrix metadata for Admin UI rendering."""
    return deepcopy(_CAPABILITY_MATRIX)


def get_provider_profile(provider: str) -> Dict[str, Any]:
    """Return a single provider profile. Unknown provider returns a default template."""
    normalized = (provider or "").strip().lower()
    if not normalized:
        normalized = "custom"

    profile = _PROVIDER_PROFILES.get(normalized)
    if profile:
        return deepcopy(profile)

    fallback_profile = deepcopy(_DEFAULT_PROVIDER_PROFILE)
    fallback_profile["provider"] = normalized
    fallback_profile["display_name"] = normalized
    fallback_profile["notes"] = ["未内置该渠道模板，请按实际文档手动配置能力。"]
    return fallback_profile


def list_provider_profiles(provider: Optional[str] = None) -> List[Dict[str, Any]]:
    """
    List provider profiles.

    If provider is provided, return a single-item list (fallback template if unknown).
    """
    normalized = (provider or "").strip().lower()
    if normalized:
        return [get_provider_profile(normalized)]

    return [deepcopy(_PROVIDER_PROFILES[key]) for key in sorted(_PROVIDER_PROFILES.keys())]
