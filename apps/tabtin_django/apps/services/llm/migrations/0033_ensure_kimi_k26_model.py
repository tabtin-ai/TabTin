"""Idempotent ensure Kimi K2.6 exists (fixes 0032 no-op on some environments)."""

from __future__ import annotations

import copy

from decimal import Decimal

from django.db import migrations


def ensure_kimi_k26(apps, schema_editor):
    LLMModel = apps.get_model("llm", "LLMModel")
    LLMProvider = apps.get_model("llm", "LLMProvider")

    if LLMModel.objects.filter(model_name="kimi-k2.6").exists():
        return

    source = LLMModel.objects.filter(model_name="kimi-k2.5").first()
    if source is None:
        provider = LLMProvider.objects.filter(
            name="moonshot",
            scope="global",
            routing_enabled=True,
        ).first()
        if provider is None:
            return
        LLMModel.objects.create(
            provider=provider,
            model_name="kimi-k2.6",
            display_name="Kimi K2.6",
            description="Moonshot Kimi K2.6 — 262K 上下文，多模态 + 工具 + 推理",
            capability_domain="chat",
            base_url="https://api.moonshot.cn/v1",
            context_window_tokens=262144,
            max_input_tokens=262144,
            max_output_tokens=32768,
            billing_type="token",
            input_price_per_1k=Decimal("0.000950"),
            output_price_per_1k=Decimal("0.004000"),
            custom_billing_config={"cache_read_input_price_per_1k": "0.00016"},
            capabilities_config={},
            wave_status="ready",
        )
        return

    provider = LLMProvider.objects.filter(id=source.provider_id).first()
    if provider is None:
        return

    caps = copy.deepcopy(source.capabilities_config or {})
    wire = caps.setdefault("wire_adapter", {})
    limits = wire.setdefault("limits", {})
    limits["context_window"] = 262144
    limits["context_window_tokens"] = 262144
    wire["wave_status"] = "ready"
    wire["is_configured"] = True

    LLMModel.objects.create(
        provider=provider,
        model_name="kimi-k2.6",
        display_name="Kimi K2.6",
        description=source.description or "Moonshot Kimi K2.6 — 262K 上下文，多模态 + 工具 + 推理",
        capability_domain="chat",
        base_url=source.base_url or "https://api.moonshot.cn/v1",
        context_window_tokens=262144,
        max_input_tokens=262144,
        max_output_tokens=source.max_output_tokens or 32768,
        billing_type=source.billing_type or "token",
        input_price_per_1k=Decimal("0.000950"),
        output_price_per_1k=Decimal("0.004000"),
        price_per_request=source.price_per_request or Decimal("0"),
        price_per_second=source.price_per_second or Decimal("0"),
        custom_billing_config={"cache_read_input_price_per_1k": "0.00016"},
        capabilities_config=caps,
        wave_status="ready",
    )


class Migration(migrations.Migration):

    dependencies = [
        ("llm", "0032_add_kimi_k26_model"),
    ]

    operations = [
        migrations.RunPython(ensure_kimi_k26, migrations.RunPython.noop),
    ]
