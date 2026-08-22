"""Do not advertise Seedream negative prompts before the Ark contract is verified."""

from django.db import migrations


def mark_negative_prompt_unsupported(apps, schema_editor):
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

    for model in LLMModel.objects.filter(
        provider=provider,
        capability_domain="image_gen",
        model_name__startswith="doubao-seedream-",
    ):
        capabilities = dict(model.capabilities_config or {})
        media_gen = dict(capabilities.get("media_gen") or {})
        if media_gen.get("supports_negative_prompt") is False:
            continue
        media_gen["supports_negative_prompt"] = False
        capabilities["media_gen"] = media_gen
        model.capabilities_config = capabilities
        model.save(update_fields=["capabilities_config", "updated_at"])


class Migration(migrations.Migration):
    dependencies = [
        ("llm", "0043_set_seedream_4_default_image_model"),
    ]

    operations = [
        migrations.RunPython(
            mark_negative_prompt_unsupported,
            migrations.RunPython.noop,
        ),
    ]
