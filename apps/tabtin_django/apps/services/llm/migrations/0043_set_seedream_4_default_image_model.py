"""Make Seedream 4.0 the deterministic default for text-to-image requests."""

from django.db import migrations


def set_seedream_default(apps, schema_editor):
    LLMProvider = apps.get_model("llm", "LLMProvider")
    LLMModel = apps.get_model("llm", "LLMModel")

    provider = LLMProvider.objects.filter(
        scope="global",
        provider_key="volcengine",
        organization_id__isnull=True,
        user_id__isnull=True,
    ).first()
    if provider is None:
        return

    seedream_models = LLMModel.objects.filter(
        provider=provider,
        capability_domain="image_gen",
        model_name__startswith="doubao-seedream-",
    )
    for model in seedream_models:
        capabilities = dict(model.capabilities_config or {})
        should_be_default = model.model_name == "doubao-seedream-4-0-250828"
        if capabilities.get("default_for_task_type") == should_be_default:
            continue
        capabilities["default_for_task_type"] = should_be_default
        model.capabilities_config = capabilities
        model.save(update_fields=["capabilities_config", "updated_at"])


class Migration(migrations.Migration):
    dependencies = [
        ("llm", "0042_add_volcengine_seedream_image_models"),
    ]

    operations = [
        migrations.RunPython(set_seedream_default, migrations.RunPython.noop),
    ]
