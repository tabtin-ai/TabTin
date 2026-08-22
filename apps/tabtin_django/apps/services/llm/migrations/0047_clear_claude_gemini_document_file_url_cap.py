"""#6945：Claude/Gemini 关闭聊天 file_url 直传能力旗标。

本地 proxy 对 ``type:file`` + ``file_url`` 仅原样透传 OpenAI-compat body，
无 Anthropic document / Gemini file_data 改写。误开会导致客户端走原生直传后上游失败。
Moonshot/Kimi 保持 True（见 0034）。
"""

from __future__ import annotations

from django.db import migrations

PROVIDER_KEYS = ("claude", "gemini")


def clear_document_file_url_cap(apps, schema_editor):
    LLMProvider = apps.get_model("llm", "LLMProvider")
    LLMModel = apps.get_model("llm", "LLMModel")

    providers = LLMProvider.objects.filter(provider_key__in=PROVIDER_KEYS)
    if not providers.exists():
        return

    for model in LLMModel.objects.filter(provider__in=providers):
        cfg = dict(model.capabilities_config or {})
        if cfg.get("supports_document_input") is False:
            continue
        cfg["supports_document_input"] = False
        # 兼容别名，避免 get_capability_flag 仍读到 supports_pdf_input=True
        if "supports_pdf_input" in cfg:
            cfg["supports_pdf_input"] = False
        model.capabilities_config = cfg
        model.save(update_fields=["capabilities_config", "updated_at"])


def noop_reverse(apps, schema_editor):
    pass


class Migration(migrations.Migration):

    dependencies = [
        ("llm", "0046_kimi_video_upload_mode_files_api"),
    ]

    operations = [
        migrations.RunPython(clear_document_file_url_cap, noop_reverse),
    ]
