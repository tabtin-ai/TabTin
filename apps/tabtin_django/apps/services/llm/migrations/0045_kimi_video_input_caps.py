"""Enable native video_url input for Moonshot Kimi chat models .

Adds ``supports_video_input`` + ``wire_adapter.video`` so chat video attachments
can be sent as OpenAI-compat ``video_url`` parts instead of text placeholders.
"""

from __future__ import annotations

from django.db import migrations

# 初版仅 gate；upload_mode / files_api 由 0046 补齐（见 VideoCaps）。
KIMI_VIDEO_WIRE = {
    "enabled": True,
    "input_via": ["url"],
}

KIMI_MODEL_NAMES = ("kimi-k2.5", "kimi-k2.6")


def enable_kimi_video_caps(apps, schema_editor):
    LLMProvider = apps.get_model("llm", "LLMProvider")
    LLMModel = apps.get_model("llm", "LLMModel")

    providers = LLMProvider.objects.filter(
        provider_key="moonshot",
        scope="global",
    )
    if not providers.exists():
        return

    for model in LLMModel.objects.filter(
        provider__in=providers,
        model_name__in=KIMI_MODEL_NAMES,
    ):
        cfg = dict(model.capabilities_config or {})
        cfg["supports_video_input"] = True
        video_top = dict(cfg.get("video") or {})
        video_top["enabled"] = True
        cfg["video"] = video_top

        wire = dict(cfg.get("wire_adapter") or {})
        wire["video"] = dict(KIMI_VIDEO_WIRE)
        cfg["wire_adapter"] = wire

        model.capabilities_config = cfg
        model.save(update_fields=["capabilities_config", "updated_at"])


def noop_reverse(apps, schema_editor):
    pass


class Migration(migrations.Migration):

    dependencies = [
        ("llm", "0044_mark_seedream_negative_prompt_unsupported"),
    ]

    operations = [
        migrations.RunPython(enable_kimi_video_caps, noop_reverse),
    ]
