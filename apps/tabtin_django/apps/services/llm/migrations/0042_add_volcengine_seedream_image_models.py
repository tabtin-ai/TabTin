"""Register the verified Ark Seedream image-generation baseline.

The Provider remains a single account-level entity for chat and image
generation.  Runtime model selection still happens through the media catalog;
no API credential or tenant-specific model choice is stored here.
"""

from __future__ import annotations

from decimal import Decimal

from django.db import migrations, models


ARK_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3"


SEEDREAM_MODELS = (
    {
        "model_name": "doubao-seedream-4-0-250828",
        "display_name": "Doubao Seedream 4.0",
        "description": "火山方舟 Seedream 4.0 文生图",
        "supported_sizes": ["1024*1024"],
        "min_pixels": 0,
        "is_default": True,
    },
    {
        "model_name": "doubao-seedream-4-5-251128",
        "display_name": "Doubao Seedream 4.5",
        "description": "火山方舟 Seedream 4.5 文生图（最小 3686400 像素）",
        "supported_sizes": ["2048*2048"],
        "min_pixels": 3_686_400,
        "is_default": False,
    },
    {
        "model_name": "doubao-seedream-5-0-260128",
        "display_name": "Doubao Seedream 5.0",
        "description": "火山方舟 Seedream 5.0 文生图（最小 3686400 像素）",
        "supported_sizes": ["2048*2048"],
        "min_pixels": 3_686_400,
        "is_default": False,
    },
    {
        "model_name": "doubao-seedream-5-0-pro-260628",
        "display_name": "Doubao Seedream 5.0 Pro",
        "description": "火山方舟 Seedream 5.0 Pro 文生图",
        "supported_sizes": ["1024*1024", "2048*2048"],
        "min_pixels": 0,
        "is_default": False,
    },
)


def _capabilities(*, supported_sizes: list[str], min_pixels: int, is_default: bool) -> dict:
    return {
        "default_task_type": "text2image",
        "default_for_task_type": is_default,
        "media_gen": {
            "supports_seed": True,
            "supports_negative_prompt": False,
            "supports_image_to_image": False,
            "supported_sizes": supported_sizes,
            "max_n_per_request": 1,
            "max_prompt_chars": 1500,
            "min_pixels": min_pixels,
        },
        # 方舟同步返回 URL；该配置让通用任务链路只作一次状态确认。
        "poll_interval_seconds": 1,
        "max_poll_count": 1,
    }


def add_seedream_models(apps, schema_editor):
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

    domains = list(provider.capability_domains or [])
    if "image_gen" not in domains:
        provider.capability_domains = domains + ["image_gen"]
        provider.save(update_fields=["capability_domains", "updated_at"])

    for definition in SEEDREAM_MODELS:
        LLMModel.objects.update_or_create(
            provider=provider,
            model_name=definition["model_name"],
            defaults={
                "display_name": definition["display_name"],
                "description": definition["description"],
                "base_url": ARK_BASE_URL,
                "capability_domain": "image_gen",
                "context_window_tokens": 1,
                "max_input_tokens": None,
                "max_output_tokens": None,
                "billing_type": "image_count",
                # Provider price is intentionally left to the configured media meter.
                "input_price_per_1k": Decimal("0"),
                "output_price_per_1k": Decimal("0"),
                "price_per_request": Decimal("0"),
                "price_per_second": Decimal("0"),
                "custom_billing_config": {},
                "capabilities_config": _capabilities(
                    supported_sizes=definition["supported_sizes"],
                    min_pixels=definition["min_pixels"],
                    is_default=definition["is_default"],
                ),
                "wave_status": "ready",
            },
        )


class Migration(migrations.Migration):
    dependencies = [
        ("llm", "0041_llmprovider_default_base_url"),
    ]

    operations = [
        migrations.AlterField(
            model_name="llmmodel",
            name="billing_type",
            field=models.CharField(
                choices=[
                    ("token", "Token"),
                    ("request", "Request"),
                    ("image_count", "Image Count"),
                    ("time", "Time"),
                    ("custom", "Custom"),
                ],
                default="token",
                max_length=20,
                verbose_name="计费类型",
            ),
        ),
        migrations.RunPython(add_seedream_models, migrations.RunPython.noop),
    ]
