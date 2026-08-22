"""Add Doubao Seed Evolving to the global Volcengine model catalog.

Seed Evolving uses a stable model ID whose backing model is upgraded weekly.
Prices are the Volcengine China rates in CNY per 1K tokens, matching TabTin's
credits billing semantics.
"""

from __future__ import annotations

import copy
from decimal import Decimal

from django.db import migrations
MODEL_NAME = "doubao-seed-evolving"
SOURCE_MODEL_NAME = "doubao-seed-2-0-lite-260428"
CONTEXT_WINDOW_TOKENS = 1_048_576
MAX_OUTPUT_TOKENS = 262_144

DOUBAO_CHAT_CAPABILITIES = {
    "json_mode": {"modes": ["json_object", "json_schema"]},
    "image": {"enabled": True},
    "tool": {"enabled": True, "supports_parallel": True},
    "wire": {"stream_supported": True},
    "supports_streaming": True,
    "supports_function_calling": True,
    "supports_parallel_function_calling": True,
    "supports_tool_choice": True,
    "supports_json_mode": True,
    "supports_vision": True,
    "supports_reasoning": True,
    "supports_prompt_caching": True,
    "supports_document_input": False,
    "supports_token_estimate": False,
    "is_configured": True,
    "wave_status": "ready",
    "wire_adapter": {
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
            "choice_modes": ["auto", "required", "none"],
            "parallel_default": True,
            "parallel_param_name": "parallel_tool_calls",
            "parallel_param_inverted": False,
        },
        "image": {
            "enabled": True,
            "formats": ["jpeg", "png", "webp", "gif"],
            "input_via": ["base64", "url"],
            "request_shape": "openai_image_url",
            "max_count_per_request": 10,
            "max_size_mb": 20,
            "max_size_bytes": 20_971_520,
        },
        "usage": {
            "input_field": "prompt_tokens",
            "output_field": "completion_tokens",
            "input_tokens_field": "prompt_tokens",
            "output_tokens_field": "completion_tokens",
            "cached_path": None,
            "cache_read_field": None,
            "cache_write_field": None,
            "cache_creation_path": None,
            "extra_fields": [],
            "extra_metrics": [],
        },
        "limits": {
            "context_window": CONTEXT_WINDOW_TOKENS,
            "context_window_tokens": CONTEXT_WINDOW_TOKENS,
            "max_output_tokens": MAX_OUTPUT_TOKENS,
            "request_payload_max_mb": 25,
            "max_documents_per_request": 0,
            "silent_drop_params": [
                "prompt_cache_key",
                "prompt_cache_retention",
            ],
            "extra_routing_headers": {},
            "max_tool_recursion_depth": None,
        },
        "caching": {
            "mode": "automatic_implicit",
            "cache_ttl_param": None,
            "cache_control_strip": True,
            "min_tokens": None,
            "min_tokens_for_cache": None,
        },
        "json_mode": {
            "mode": "json_schema",
            "modes": ["json_schema", "json_object"],
            "schema_field": "response_format.json_schema.schema",
            "schema_fallback": False,
            "strict_supported": False,
        },
        "reasoning": {
            "enabled": True,
            "format": "reasoning_content_field",
            "surface": "delta_reasoning_content",
            "param_path": "reasoning_effort",
            "budget_param": "reasoning_effort",
            "visible_to_client": True,
        },
    },
}


def add_doubao_seed_evolving(apps, schema_editor):
    LLMModel = apps.get_model("llm", "LLMModel")
    LLMProvider = apps.get_model("llm", "LLMProvider")

    providers = LLMProvider.objects.filter(
        provider_key="volcengine",
        scope="global",
        organization_id__isnull=True,
        user_id__isnull=True,
    )
    for provider in providers:
        source = LLMModel.objects.filter(
            provider=provider,
            model_name=SOURCE_MODEL_NAME,
        ).first()

        capabilities = copy.deepcopy(
            source.capabilities_config
            if source is not None and source.capabilities_config
            else DOUBAO_CHAT_CAPABILITIES
        )
        capabilities["supports_prompt_caching"] = True
        wire = capabilities.setdefault("wire_adapter", {})
        limits = wire.setdefault("limits", {})
        limits.update(
            {
                "context_window": CONTEXT_WINDOW_TOKENS,
                "context_window_tokens": CONTEXT_WINDOW_TOKENS,
                "max_output_tokens": MAX_OUTPUT_TOKENS,
            }
        )
        wire.setdefault("caching", {}).update(
            {
                "mode": "automatic_implicit",
                "cache_ttl_param": None,
                "cache_control_strip": True,
                "min_tokens": None,
                "min_tokens_for_cache": None,
            }
        )
        wire.setdefault("reasoning", {}).update(
            {
                "enabled": True,
                "format": "reasoning_content_field",
                "surface": "delta_reasoning_content",
                "param_path": "reasoning_effort",
                "budget_param": "reasoning_effort",
                "visible_to_client": True,
            }
        )

        LLMModel.objects.update_or_create(
            provider=provider,
            model_name=MODEL_NAME,
            defaults={
                "display_name": "Doubao Seed Evolving",
                "description": (
                    "火山方舟豆包 Seed Evolving — 统一模型 ID，周级演进，"
                    "面向 Coding、Agent 与生产力场景"
                ),
                "base_url": (source.base_url if source is not None else "")
                or "https://ark.cn-beijing.volces.com/api/v3",
                "capability_domain": "chat",
                "context_window_tokens": CONTEXT_WINDOW_TOKENS,
                "max_input_tokens": CONTEXT_WINDOW_TOKENS,
                "max_output_tokens": MAX_OUTPUT_TOKENS,
                "billing_type": "token",
                "input_price_per_1k": Decimal("0.006"),
                "output_price_per_1k": Decimal("0.030"),
                "price_per_request": Decimal("0"),
                "price_per_second": Decimal("0"),
                "custom_billing_config": {
                    "cache_read_input_price_per_1k": "0.0012",
                    "cache_write_input_price_per_1k": "0.0075",
                },
                "capabilities_config": capabilities,
                "wave_status": "ready",
            },
        )


class Migration(migrations.Migration):

    dependencies = [
        ("llm", "0049_clear_moonshot_v1_document_input"),
    ]

    operations = [
        migrations.RunPython(
            add_doubao_seed_evolving,
            migrations.RunPython.noop,
        ),
    ]
