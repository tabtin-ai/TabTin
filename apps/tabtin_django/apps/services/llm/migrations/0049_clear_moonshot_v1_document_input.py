"""#6945：关闭 moonshot-v1 的 supports_document_input。

v1 模型未配置 wire_adapter.document.file_extract；若仍声明支持文档，
Host 会放行 type:file，上游 chat/completions 直接 400。
仅 kimi-k2.x（0048）走 Files API extract。
"""

from __future__ import annotations

from django.db import migrations

V1_MODEL_NAMES = ("moonshot-v1-128k", "moonshot-v1-32k")


def clear_v1_document_input(apps, schema_editor):
    LLMProvider = apps.get_model("llm", "LLMProvider")
    LLMModel = apps.get_model("llm", "LLMModel")

    providers = LLMProvider.objects.filter(provider_key="moonshot")
    if not providers.exists():
        return

    for model in LLMModel.objects.filter(
        provider__in=providers,
        model_name__in=V1_MODEL_NAMES,
    ):
        cfg = dict(model.capabilities_config or {})
        changed = False
        if cfg.get("supports_document_input") is not False:
            cfg["supports_document_input"] = False
            changed = True
        if cfg.get("supports_pdf_input") is True:
            cfg["supports_pdf_input"] = False
            changed = True
        wire = dict(cfg.get("wire_adapter") or {})
        if "document" in wire:
            wire.pop("document", None)
            cfg["wire_adapter"] = wire
            changed = True
        if not changed:
            continue
        model.capabilities_config = cfg
        model.save(update_fields=["capabilities_config", "updated_at"])


def noop_reverse(apps, schema_editor):
    pass


class Migration(migrations.Migration):

    dependencies = [
        ("llm", "0048_kimi_document_file_extract"),
    ]

    operations = [
        migrations.RunPython(clear_v1_document_input, noop_reverse),
    ]
