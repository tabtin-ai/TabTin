"""Kimi 文档：wire_adapter.document 配置 file_extract（ 方案1）。

Moonshot chat/completions 拒绝 content 中的 ``type:file`` part。
官方路径：POST /files purpose=file-extract → GET /files/{id}/content →
把提取文本注入 role=system 消息。本 migration 给 Moonshot Kimi 写入
``DocumentCaps.upload_mode=file_extract``。
"""

from __future__ import annotations

from django.db import migrations

KIMI_DOCUMENT_WIRE = {
    "enabled": True,
    "upload_mode": "file_extract",
    "files_api": {
        "endpoint": "/files",
        "purpose": "file-extract",
        "url_scheme": "ms://",
        "id_field": "id",
        "timeout_s": 180.0,
    },
    "max_size_mb": 100,
    "max_extract_chars": 200000,
    "inject_role": "system",
    "cache_extracted_text": True,
}

KIMI_MODEL_NAMES = ("kimi-k2.5", "kimi-k2.6", "kimi-k2.7-code")


def enable_kimi_document_file_extract(apps, schema_editor):
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
        cfg["supports_document_input"] = True

        wire = dict(cfg.get("wire_adapter") or {})
        wire["document"] = dict(KIMI_DOCUMENT_WIRE)
        cfg["wire_adapter"] = wire

        model.capabilities_config = cfg
        model.save(update_fields=["capabilities_config", "updated_at"])


def noop_reverse(apps, schema_editor):
    pass


class Migration(migrations.Migration):

    dependencies = [
        ("llm", "0047_clear_claude_gemini_document_file_url_cap"),
    ]

    operations = [
        migrations.RunPython(enable_kimi_document_file_extract, noop_reverse),
    ]
