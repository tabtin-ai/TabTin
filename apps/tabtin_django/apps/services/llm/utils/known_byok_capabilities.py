"""服务端已知 BYOK 套餐的权威模型能力。"""

from __future__ import annotations

from copy import deepcopy
from typing import Any


_KIMI_K27_CODING_MODELS = frozenset(
    {"kimi-for-coding", "kimi-for-coding-highspeed"}
)

_KIMI_CODING_WIRE_ADAPTER = {
    "wire": {
        "request_protocol": "openai_chat_completions",
        "response_protocol": "openai_chat_completions",
        "stream_supported": True,
        "streaming_protocol": "openai_delta",
        "streaming_emits_usage": True,
        "upstream_path": "/chat/completions",
        "system_placement": "messages_first_role_system",
        "system_message_style": "messages_first_role_system",
        "system_quirks": [],
    },
    "tool": {
        "enabled": True,
        "max_tools": 128,
        "param_field": "parameters",
        "choice_modes": ["auto", "required", "none", "specific"],
        "parallel_default": True,
        "parallel_param_name": "parallel_tool_calls",
        "parallel_param_inverted": False,
    },
    "reasoning": {
        "enabled": True,
        "format": "reasoning_content_field",
        "surface": "delta_reasoning_content",
        # Kimi K2.7 Code 始终思考，不接受 reasoning_effort 档位。
        "param_path": None,
        "budget_param": None,
        "visible_to_client": True,
    },
    "usage": {
        "input_field": "prompt_tokens",
        "output_field": "completion_tokens",
        "input_tokens_field": "prompt_tokens",
        "output_tokens_field": "completion_tokens",
        "cached_path": "cached_tokens",
        "cache_read_field": "cached_tokens",
        "cache_write_field": None,
        "cache_creation_path": None,
        "extra_fields": [],
        "extra_metrics": [],
    },
    "limits": {
        "context_window": 262_144,
        "context_window_tokens": 262_144,
        "max_output_tokens": None,
        "request_payload_max_mb": 25,
        "silent_drop_params": [],
        "extra_routing_headers": {},
    },
}


def _kimi_k3_256k_wire_adapter() -> dict[str, Any]:
    profile = deepcopy(_KIMI_CODING_WIRE_ADAPTER)
    profile["reasoning"].update(
        {
            "param_path": "reasoning_effort",
            "budget_param": "reasoning_effort",
        }
    )
    profile["limits"]["max_output_tokens"] = 131_072
    return profile


def ensure_known_byok_wire_capability(
    *,
    provider_key: str,
    model_name: str,
    capabilities_config: Any,
) -> dict[str, Any]:
    """为已知套餐补权威 wire 配置，保留调用方已有声明。"""
    current = capabilities_config if isinstance(capabilities_config, dict) else {}
    if current.get("wire_adapter"):
        return current
    if str(provider_key or "").strip().lower() != "kimi_coding":
        return current
    normalized_model_name = model_name.strip().lower()
    if (
        normalized_model_name not in _KIMI_K27_CODING_MODELS
        and normalized_model_name != "k3-256k"
    ):
        return current

    normalized = deepcopy(current)
    if normalized_model_name in _KIMI_K27_CODING_MODELS:
        normalized["wire_adapter"] = deepcopy(_KIMI_CODING_WIRE_ADAPTER)
    else:
        normalized["wire_adapter"] = _kimi_k3_256k_wire_adapter()
    return normalized


__all__ = ["ensure_known_byok_wire_capability"]
