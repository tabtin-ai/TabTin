"""新增 Moonshot 按量 API 旗舰模型 kimi-k3（Kimi K3）。

官方口径（核对 2026-07-31）：
  - model id: kimi-k3
  - 上下文 1,048,576 tokens；max_completion_tokens 默认 131072、上限 1048576
  - 始终推理；请求侧用顶层 reasoning_effort=low|high|max（默认 max）
  - **没有** K2.x 的 thinking 开关；temperature 等采样参数固定，应省略
  - 国内站人民币牌价（元 / 1M tokens）：
      输入缓存命中 ¥2 / 未命中 ¥20 / 输出 ¥100
    → 写入 TabTin 单价（元 / 1k）：0.002 / 0.02 / 0.1

能力声明从同 provider 的 kimi-k2.6（或 k2.7-code）克隆，再把
wire_adapter.reasoning.param_path 改为 reasoning_effort，并刷新 context 上限。
"""

from __future__ import annotations

import copy
from decimal import Decimal

from django.db import migrations
from django.db.models import Q


TAG = "0051_add_kimi_k3_model"
PROVIDER_NAME = "moonshot"
MODEL_NAME = "kimi-k3"
CLONE_CANDIDATES = ("kimi-k2.6", "kimi-k2.7-code", "kimi-k2.5")

CONTEXT_WINDOW_TOKENS = 1_048_576
MAX_OUTPUT_TOKENS = 131_072

# 国内站 https://platform.kimi.com/docs/pricing/chat-k3.md
INPUT_PRICE_PER_1K = Decimal("0.02")
OUTPUT_PRICE_PER_1K = Decimal("0.1")
CACHE_READ_PRICE_PER_1K = "0.002"

FALLBACK_BASE_URL = "https://api.moonshot.cn/v1"

# 无兄弟模型可克隆时的最小能力声明（与 0034 同形，但 reasoning 走 K3 口径）
KIMI_K3_FALLBACK_CAPABILITIES = {
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
    "reasoning_history_roundtrip": "preserve",
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
            "context_window": CONTEXT_WINDOW_TOKENS,
            "context_window_tokens": CONTEXT_WINDOW_TOKENS,
            "max_output_tokens": MAX_OUTPUT_TOKENS,
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
            "strict_supported": True,
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


def _patch_k3_capabilities(capabilities: dict) -> dict:
    caps = copy.deepcopy(capabilities or {})
    caps["supports_reasoning"] = True
    caps["supports_prompt_caching"] = True
    caps["supports_vision"] = True
    caps["wave_status"] = "ready"
    # K3 保留式思考始终开启：多轮 / 工具轮都必须回传 reasoning_content
    caps["reasoning_history_roundtrip"] = "preserve"

    wire = caps.setdefault("wire_adapter", {})
    limits = wire.setdefault("limits", {})
    limits.update(
        {
            "context_window": CONTEXT_WINDOW_TOKENS,
            "context_window_tokens": CONTEXT_WINDOW_TOKENS,
            "max_output_tokens": MAX_OUTPUT_TOKENS,
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
    # K3 支持 strict JSON Schema（官方 quickstart）
    json_mode = wire.setdefault("json_mode", {})
    if isinstance(json_mode, dict):
        json_mode["strict_supported"] = True
        modes = list(json_mode.get("modes") or [])
        for mode in ("json_schema", "json_object"):
            if mode not in modes:
                modes.append(mode)
        json_mode["modes"] = modes
    return caps


def forwards(apps, schema_editor):
    LLMProvider = apps.get_model("llm", "LLMProvider")
    LLMModel = apps.get_model("llm", "LLMModel")

    providers = LLMProvider.objects.filter(
        Q(provider_key=PROVIDER_NAME) | Q(name=PROVIDER_NAME)
    )
    if not providers.exists():
        print(f"[{TAG}] ⚠ 没有 moonshot provider，跳过（static_models 仍可展示）")
        return

    for provider in providers:
        template = None
        for candidate in CLONE_CANDIDATES:
            template = LLMModel.objects.filter(
                provider=provider, model_name=candidate,
            ).first()
            if template is not None:
                break

        if template is not None:
            capabilities = _patch_k3_capabilities(template.capabilities_config or {})
            base_url = getattr(template, "base_url", "") or FALLBACK_BASE_URL
        else:
            capabilities = copy.deepcopy(KIMI_K3_FALLBACK_CAPABILITIES)
            base_url = FALLBACK_BASE_URL
            print(
                f"[{TAG}] ⚠ provider id={provider.id} 无兄弟模型可克隆，"
                f"使用内置 fallback capabilities"
            )

        LLMModel.objects.update_or_create(
            provider=provider,
            model_name=MODEL_NAME,
            defaults={
                "display_name": "Kimi K3",
                "description": (
                    "Moonshot Kimi K3 — 1M 上下文旗舰模型，始终推理，"
                    "reasoning_effort=low|high|max，多模态 + 工具调用"
                ),
                "base_url": base_url,
                "capability_domain": "chat",
                "context_window_tokens": CONTEXT_WINDOW_TOKENS,
                "max_input_tokens": CONTEXT_WINDOW_TOKENS,
                "max_output_tokens": MAX_OUTPUT_TOKENS,
                "billing_type": "token",
                "input_price_per_1k": INPUT_PRICE_PER_1K,
                "output_price_per_1k": OUTPUT_PRICE_PER_1K,
                "price_per_request": Decimal("0"),
                "price_per_second": Decimal("0"),
                "custom_billing_config": {
                    "cache_read_input_price_per_1k": CACHE_READ_PRICE_PER_1K,
                },
                "capabilities_config": capabilities,
                "wave_status": "ready",
            },
        )
        print(f"[{TAG}] upserted {MODEL_NAME} on provider id={provider.id}")


def backwards(apps, schema_editor):
    LLMModel = apps.get_model("llm", "LLMModel")
    deleted, _ = LLMModel.objects.filter(
        Q(provider__provider_key=PROVIDER_NAME) | Q(provider__name=PROVIDER_NAME),
        model_name=MODEL_NAME,
    ).delete()
    if deleted:
        print(f"[{TAG}] reverse deleted={deleted}")


class Migration(migrations.Migration):

    dependencies = [
        ("llm", "0050_add_doubao_seed_evolving"),
    ]

    operations = [
        migrations.RunPython(forwards, backwards),
    ]
