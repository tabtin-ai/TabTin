"""Ensure Moonshot / Kimi K2.6 is a first-class baseline chat model.

0032/0033 could only add Kimi K2.6 when a Moonshot provider already existed.
Fresh single-PG deployments only seed placeholder providers later via
``bootstrap_fresh_db``, so migrations finished with no real DB model for the
frontend's ``declared:moonshot:kimi-k2.6`` catalog entry.  This migration makes
the product baseline explicit at schema/data-migration time: create the global
Moonshot provider if absent, and upsert Kimi K2.5/K2.6 model rows with enough
capability metadata for scene binding validation.

No secret is written here. Operators still provide the Moonshot API key through
AdminDash / env and then enable routing.
"""

from __future__ import annotations

from decimal import Decimal

from django.db import migrations


KIMI_CHAT_CAPABILITIES = {
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
    "supports_document_input": True,
    "supports_token_estimate": True,
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
            "input_via": ["base64", "file_id"],
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
            "cached_path": "cached_tokens",
            "cache_read_field": "cached_tokens",
            "cache_write_field": None,
            "cache_creation_path": None,
            "extra_fields": [],
            "extra_metrics": [],
        },
        "limits": {
            "context_window": 256_000,
            "context_window_tokens": 256_000,
            "max_output_tokens": None,
            "request_payload_max_mb": 25,
            "max_documents_per_request": 20,
            "silent_drop_params": [],
            "extra_routing_headers": {},
            "max_tool_recursion_depth": None,
        },
        "caching": {
            "mode": "automatic_implicit",
            "cache_ttl_param": "prompt_cache_key",
            "cache_control_strip": False,
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


def ensure_moonshot_kimi_baseline(apps, schema_editor):
    LLMProvider = apps.get_model("llm", "LLMProvider")
    LLMModel = apps.get_model("llm", "LLMModel")
    LLMSceneBinding = apps.get_model("llm", "LLMSceneBinding")

    provider = LLMProvider.objects.filter(
        scope="global",
        provider_key="moonshot",
        workteam_id__isnull=True,
        user_id__isnull=True,
    ).first()
    if provider is None:
        provider = LLMProvider.objects.create(
            name="moonshot",
            provider_key="moonshot",
            display_name="Moonshot / Kimi",
            encrypted_api_key="",
            capability_domains=["chat"],
            scope="global",
            workteam_id=None,
            user_id=None,
            routing_enabled=False,
            routing_weight=100,
            runtime_status="unknown",
            health_check_enabled=True,
        )
    else:
        changed = []
        if provider.name != "moonshot":
            provider.name = "moonshot"
            changed.append("name")
        if provider.display_name != "Moonshot / Kimi":
            provider.display_name = "Moonshot / Kimi"
            changed.append("display_name")
        domains = list(provider.capability_domains or [])
        if "chat" not in domains:
            provider.capability_domains = domains + ["chat"]
            changed.append("capability_domains")
        # Preserve operator-managed api_key / routing_enabled / runtime status.
        if changed:
            provider.save(update_fields=changed + ["updated_at"])

    specs = [
        ("kimi-k2.5", "Kimi K2.5", Decimal("0.004000"), Decimal("0.021000")),
        ("kimi-k2.6", "Kimi K2.6", Decimal("0.000950"), Decimal("0.004000")),
    ]
    kimi_k26 = None
    for model_name, display_name, input_price, output_price in specs:
        model, _ = LLMModel.objects.update_or_create(
            provider=provider,
            model_name=model_name,
            defaults={
                "display_name": display_name,
                "description": "Moonshot Kimi — 262K 上下文，多模态 + 工具 + 推理",
                "base_url": "https://api.moonshot.cn/v1",
                "capability_domain": "chat",
                "context_window_tokens": 262_144,
                "max_input_tokens": 262_144,
                "max_output_tokens": 32_768,
                "billing_type": "token",
                "input_price_per_1k": input_price,
                "output_price_per_1k": output_price,
                "price_per_request": Decimal("0"),
                "price_per_second": Decimal("0"),
                "custom_billing_config": {"cache_read_input_price_per_1k": "0.00016"},
                "capabilities_config": KIMI_CHAT_CAPABILITIES,
                "wave_status": "ready",
            },
        )
        if model_name == "kimi-k2.6":
            kimi_k26 = model

    if kimi_k26 is None:
        return

    # Existing fresh DBs seeded before this migration have chat scene bindings
    # pointing at the old qwen_default placeholder. Move only those placeholder
    # bindings (and empty bindings) to the new product baseline; preserve any
    # operator-managed provider choice such as ZenMux/MiniMax/OpenAI.
    for binding in LLMSceneBinding.objects.select_related("primary_model__provider").filter(
        capability_domain="chat",
    ):
        current = binding.primary_model
        provider_key = getattr(getattr(current, "provider", None), "provider_key", "")
        if current is not None and provider_key != "qwen_default":
            continue
        binding.primary_model = kimi_k26
        binding.save(update_fields=["primary_model", "updated_at"])


class Migration(migrations.Migration):

    dependencies = [
        ("llm", "0033_ensure_kimi_k26_model"),
    ]

    operations = [
        migrations.RunPython(ensure_moonshot_kimi_baseline, migrations.RunPython.noop),
    ]
