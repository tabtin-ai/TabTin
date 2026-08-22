"""Ensure Volcengine Ark / Doubao Seed 2.0 Lite is a first-class chat model.

Creates the global ``volcengine`` provider if absent and upserts the
``doubao-seed-2-0-lite-260428`` model row with OpenAI-compatible wire metadata.

No secret is written here. Operators provide the Ark API key through AdminDash /
``.env.local`` (``ARK_API_KEY``) and enable routing via ``provision_dev_agent_ready``.
"""

from __future__ import annotations

from decimal import Decimal

from django.db import migrations


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
    "supports_prompt_caching": False,
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
            "context_window": 262_144,
            "context_window_tokens": 262_144,
            "max_output_tokens": 32_768,
            "request_payload_max_mb": 25,
            "max_documents_per_request": 0,
            "silent_drop_params": ["prompt_cache_key", "prompt_cache_retention"],
            "extra_routing_headers": {},
            "max_tool_recursion_depth": None,
        },
        "caching": {
            "mode": "disabled",
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
            "param_path": "thinking",
            "budget_param": None,
            "visible_to_client": True,
        },
    },
}


def ensure_volcengine_doubao_baseline(apps, schema_editor):
    LLMProvider = apps.get_model("llm", "LLMProvider")
    LLMModel = apps.get_model("llm", "LLMModel")

    provider = LLMProvider.objects.filter(
        scope="global",
        provider_key="volcengine",
        organization_id__isnull=True,
        user_id__isnull=True,
    ).first()
    if provider is None:
        provider = LLMProvider.objects.create(
            name="volcengine",
            provider_key="volcengine",
            display_name="火山引擎 / 豆包",
            encrypted_api_key="",
            capability_domains=["chat"],
            scope="global",
            organization_id=None,
            user_id=None,
            routing_enabled=False,
            routing_weight=100,
            runtime_status="unknown",
            health_check_enabled=True,
        )
    else:
        changed = []
        if provider.name != "volcengine":
            provider.name = "volcengine"
            changed.append("name")
        if provider.display_name != "火山引擎 / 豆包":
            provider.display_name = "火山引擎 / 豆包"
            changed.append("display_name")
        domains = list(provider.capability_domains or [])
        if "chat" not in domains:
            provider.capability_domains = domains + ["chat"]
            changed.append("capability_domains")
        if changed:
            provider.save(update_fields=changed + ["updated_at"])

    LLMModel.objects.update_or_create(
        provider=provider,
        model_name="doubao-seed-2-0-lite-260428",
        defaults={
            "display_name": "Doubao Seed 2.0 Lite",
            "description": "火山方舟豆包 Seed 2.0 Lite — 256K 上下文，多模态 + 工具",
            "base_url": "https://ark.cn-beijing.volces.com/api/v3",
            "capability_domain": "chat",
            "context_window_tokens": 262_144,
            "max_input_tokens": 262_144,
            "max_output_tokens": 32_768,
            "billing_type": "token",
            "input_price_per_1k": Decimal("0.000090"),
            "output_price_per_1k": Decimal("0.000510"),
            "price_per_request": Decimal("0"),
            "price_per_second": Decimal("0"),
            "custom_billing_config": {},
            "capabilities_config": DOUBAO_CHAT_CAPABILITIES,
            "wave_status": "ready",
        },
    )


class Migration(migrations.Migration):

    dependencies = [
        ("llm", "0038_bind_diary_distill_scene"),
    ]

    operations = [
        migrations.RunPython(ensure_volcengine_doubao_baseline, migrations.RunPython.noop),
    ]
