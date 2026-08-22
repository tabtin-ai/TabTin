"""Bind ASR/TTS scenes to ByteDance/Doubao speech models.

The speech scenes are database-driven through ``LLMSceneBinding``.  Updating the
seed command only helps fresh databases or manual reseeding; existing
deployments need a data migration so the five speech scenes resolve to the
right ByteDance model rows after ``migrate``.

No secret is written here.  Operators still provide the ByteDance access token
on the provider and ``app_id`` in the model ``capabilities_config`` through
AdminDash before enabling routing.
"""

from __future__ import annotations

from decimal import Decimal

from django.db import migrations


BYTEDANCE_PROVIDER_KEY = "bytedance_default"
BYTEDANCE_LEGACY_KEYS = {
    "bytedance_default",
    "bytedance_default_asr",
    "bytedance_default_tts",
}

ASR_CAPABILITIES = {
    "resource_ids": {
        "flash": "volc.bigasr.auc_turbo",
        "standard": "volc.bigasr.auc",
        "streaming": "volc.bigasr.sauc.duration",
    },
    "ws_endpoint": "bigmodel_async",
    "speech": {
        "supports_timestamps": True,
        "supports_diarization": True,
        "supports_emotion": False,
        "supported_resource_ids": [
            "volc.bigasr.auc_turbo",
            "volc.bigasr.auc",
            "volc.bigasr.sauc.duration",
        ],
        "supported_languages": ["zh", "en"],
    },
    "wire": {"stream_supported": True},
}

TTS_CAPABILITIES = {
    "resource_ids": {
        "http": "seed-tts-3.0",
        "ws_bidirectional": "seed-tts-3.0",
    },
    "resource_id": "seed-tts-3.0",
    "default_speaker": "zh_female_vv_uranus_bigtts",
    "speech": {
        "supports_emotion": True,
        "supports_voice_cloning": False,
        "supported_resource_ids": ["seed-tts-2.0", "seed-tts-3.0"],
        "supported_formats": ["mp3", "wav", "ogg", "pcm"],
        "supported_sample_rates": [24000],
    },
    "wire": {"stream_supported": True},
}

ASR_SCENES = {
    "asr_recognize_flash",
    "asr_transcribe_standard",
    "asr_realtime_stream",
}
TTS_SCENES = {
    "tts_synthesize_http",
    "tts_synthesize_stream",
}


def _merge_config(existing: dict | None, spec: dict) -> dict:
    if not isinstance(existing, dict):
        return dict(spec)
    merged = dict(existing)
    for key, spec_value in spec.items():
        current = merged.get(key)
        # Runtime resource ids are the actual binding requested here.  Preserve
        # other operator-entered fields such as app_id / secret_key.
        if key in {"resource_ids", "resource_id", "ws_endpoint"}:
            merged[key] = spec_value
        elif isinstance(current, dict) and isinstance(spec_value, dict):
            merged[key] = _merge_config(current, spec_value)
        elif key not in merged:
            merged[key] = spec_value
    return merged


def _ensure_domain(provider, domain: str) -> None:
    domains = list(provider.capability_domains or [])
    if domain not in domains:
        provider.capability_domains = domains + [domain]
        provider.save(update_fields=["capability_domains", "updated_at"])


def _should_rebind(current) -> bool:
    if current is None:
        return True
    provider = getattr(current, "provider", None)
    provider_key = getattr(provider, "provider_key", "") or ""
    return provider_key in BYTEDANCE_LEGACY_KEYS


def _upsert_speech_model(LLMModel, provider, model_name: str, defaults: dict, capabilities: dict):
    create_defaults = dict(defaults)
    create_defaults["capabilities_config"] = capabilities
    model, created = LLMModel.objects.get_or_create(
        provider=provider,
        model_name=model_name,
        defaults=create_defaults,
    )
    if created:
        return model

    changed = []
    for field_name, value in defaults.items():
        if getattr(model, field_name) != value:
            setattr(model, field_name, value)
            changed.append(field_name)

    merged_config = _merge_config(model.capabilities_config, capabilities)
    if model.capabilities_config != merged_config:
        model.capabilities_config = merged_config
        changed.append("capabilities_config")

    if changed:
        model.save(update_fields=changed + ["updated_at"])
    return model


def bind_bytedance_speech_scenes(apps, schema_editor):
    LLMProvider = apps.get_model("llm", "LLMProvider")
    LLMModel = apps.get_model("llm", "LLMModel")
    LLMSceneBinding = apps.get_model("llm", "LLMSceneBinding")

    provider = LLMProvider.objects.filter(
        scope="global",
        provider_key=BYTEDANCE_PROVIDER_KEY,
        organization_id__isnull=True,
        user_id__isnull=True,
    ).first()
    if provider is None:
        provider = LLMProvider.objects.create(
            name="bytedance",
            provider_key=BYTEDANCE_PROVIDER_KEY,
            display_name="字节 Speech（占位）",
            encrypted_api_key="",
            capability_domains=["asr", "tts"],
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
        if provider.name != "bytedance":
            provider.name = "bytedance"
            changed.append("name")
        if provider.display_name != "字节 Speech（占位）":
            provider.display_name = "字节 Speech（占位）"
            changed.append("display_name")
        domains = list(provider.capability_domains or [])
        for domain in ("asr", "tts"):
            if domain not in domains:
                domains.append(domain)
        if domains != list(provider.capability_domains or []):
            provider.capability_domains = domains
            changed.append("capability_domains")
        if changed:
            provider.save(update_fields=changed + ["updated_at"])

    asr_model = _upsert_speech_model(
        LLMModel,
        provider,
        "doubao-asr",
        {
            "display_name": "字节豆包 ASR（占位）",
            "description": "ByteDance/Doubao ASR for flash, standard, and streaming scenes",
            "base_url": "https://openspeech.bytedance.com",
            "capability_domain": "asr",
            "context_window_tokens": 1,
            "max_input_tokens": None,
            "max_output_tokens": None,
            "billing_type": "time",
            "input_price_per_1k": Decimal("0"),
            "output_price_per_1k": Decimal("0"),
            "price_per_request": Decimal("0"),
            "price_per_second": Decimal("0"),
            "custom_billing_config": {},
            "wave_status": "ready",
        },
        ASR_CAPABILITIES,
    )
    tts_model = _upsert_speech_model(
        LLMModel,
        provider,
        "seed-tts-3.0",
        {
            "display_name": "字节豆包 Seed-TTS 3.0（占位）",
            "description": "ByteDance/Doubao Seed-TTS 3.0 for HTTP and WS synthesis",
            "base_url": "https://openspeech.bytedance.com",
            "capability_domain": "tts",
            "context_window_tokens": 1,
            "max_input_tokens": None,
            "max_output_tokens": None,
            "billing_type": "time",
            "input_price_per_1k": Decimal("0"),
            "output_price_per_1k": Decimal("0"),
            "price_per_request": Decimal("0"),
            "price_per_second": Decimal("0"),
            "custom_billing_config": {},
            "wave_status": "ready",
        },
        TTS_CAPABILITIES,
    )

    # Preserve operator-managed credentials while still forcing the requested
    # resource-id binding on old placeholder rows.
    for legacy in LLMModel.objects.filter(
        provider=provider,
        capability_domain="asr",
    ).exclude(id=asr_model.id):
        legacy.capabilities_config = _merge_config(
            legacy.capabilities_config,
            ASR_CAPABILITIES,
        )
        legacy.save(update_fields=["capabilities_config", "updated_at"])
    for legacy in LLMModel.objects.filter(
        provider=provider,
        capability_domain="tts",
    ).exclude(id=tts_model.id):
        legacy.capabilities_config = _merge_config(
            legacy.capabilities_config,
            TTS_CAPABILITIES,
        )
        legacy.save(update_fields=["capabilities_config", "updated_at"])

    for scene_key in ASR_SCENES:
        binding = LLMSceneBinding.objects.select_related(
            "primary_model__provider",
        ).filter(scene_key=scene_key).first()
        if binding is None:
            continue
        if _should_rebind(binding.primary_model):
            binding.primary_model = asr_model
            binding.save(update_fields=["primary_model", "updated_at"])

    for scene_key in TTS_SCENES:
        binding = LLMSceneBinding.objects.select_related(
            "primary_model__provider",
        ).filter(scene_key=scene_key).first()
        if binding is None:
            continue
        if _should_rebind(binding.primary_model):
            binding.primary_model = tts_model
            binding.save(update_fields=["primary_model", "updated_at"])


class Migration(migrations.Migration):

    dependencies = [
        ("llm", "0036_rename_services_ll_worktea_e0bbd3_idx_services_ll_organiz_e2200e_idx_and_more"),
    ]

    operations = [
        migrations.RunPython(bind_bytedance_speech_scenes, migrations.RunPython.noop),
    ]
