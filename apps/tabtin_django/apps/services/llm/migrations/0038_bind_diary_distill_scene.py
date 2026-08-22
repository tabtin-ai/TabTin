"""Bind diary_distill scene during normal migrations.

The registry entry for ``diary_distill`` must have a matching
LLMSceneBinding before daphne starts. Production web containers run
``safe_migrate`` and then start daphne directly, so relying on the
management-only ``seed_scene_bindings`` command leaves existing databases
unable to pass startup validation.
"""

from __future__ import annotations

from django.db import migrations


DIARY_DISTILL_REQUIREMENTS = {
    "requires_json_mode": True,
    "requires_vision": False,
    "requires_function_calling": False,
    "min_context_tokens": 16_000,
    "max_output_tokens": 1200,
    "latency_class": "batch",
    "cost_class": "cheap",
}

DIARY_DISTILL_PARAMS = {
    "temperature": 0.2,
    "max_tokens": 1024,
    "response_format": {"type": "json_object"},
    "timeout_sec": 120,
    "max_input_chars": 30000,
}


def _resolve_primary_chat_model(apps):
    LLMModel = apps.get_model("llm", "LLMModel")

    preferred = (
        LLMModel.objects
        .filter(
            provider__scope="global",
            provider__provider_key="moonshot",
            model_name="kimi-k2.6",
            capability_domain="chat",
        )
        .first()
    )
    if preferred is not None:
        return preferred

    return (
        LLMModel.objects
        .filter(
            provider__scope="global",
            capability_domain="chat",
        )
        .order_by("model_name")
        .first()
    )


def bind_diary_distill_scene(apps, schema_editor):
    LLMSceneBinding = apps.get_model("llm", "LLMSceneBinding")
    primary_model = _resolve_primary_chat_model(apps)

    values = {
        "display_name": "每日 Agent 日记蒸馏",
        "description": "从同一 Agent 当日会话小结生成一条用户可读的工作日记（JSON）",
        "capability_domain": "chat",
        "capability_requirements": DIARY_DISTILL_REQUIREMENTS,
        "default_params": DIARY_DISTILL_PARAMS,
        "timeout_sec": 120,
    }

    binding = LLMSceneBinding.objects.filter(scene_key="diary_distill").first()
    if binding is None:
        LLMSceneBinding.objects.create(
            scene_key="diary_distill",
            primary_model=primary_model,
            **values,
        )
        return

    changed_fields = []
    for field, value in values.items():
        if getattr(binding, field) != value:
            setattr(binding, field, value)
            changed_fields.append(field)

    # Preserve operator-managed model routing. Only fill primary_model when the
    # binding already existed but had no model configured.
    if binding.primary_model_id is None and primary_model is not None:
        binding.primary_model = primary_model
        changed_fields.append("primary_model")

    if changed_fields:
        binding.save(update_fields=changed_fields + ["updated_at"])


class Migration(migrations.Migration):

    dependencies = [
        ("llm", "0037_bind_bytedance_speech_scenes"),
    ]

    operations = [
        migrations.RunPython(bind_diary_distill_scene, migrations.RunPython.noop),
    ]
