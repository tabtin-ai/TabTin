from decimal import Decimal

from django.db import migrations, models
from django.utils import timezone


def seed_qianfan_provider(apps, schema_editor):
    SearchProvider = apps.get_model("search", "SearchProvider")
    SearchGlobalConfig = apps.get_model("search", "SearchGlobalConfig")
    MeterPricing = apps.get_model("billing", "MeterPricing")

    SearchProvider.objects.update_or_create(
        provider_key="qianfan",
        defaults={
            "provider_type": "qianfan",
            "display_name": "千帆百度搜索",
            "base_url": "https://qianfan.baidubce.com/v2/ai_search/web_search",
            "api_key": "",
            "api_key_env_name": "QIANFAN_API_KEY",
            "request_timeout_sec": 30,
            "is_active": True,
            "priority": 200,
            "capabilities_config": {"summary": True, "freshness": True, "image": False},
            "extra_config": {"search_source": "baidu_search_v2"},
        },
    )

    # 保留博查为可选回退，但默认切到千帆。
    SearchProvider.objects.filter(provider_key="bocha").update(is_active=False, priority=50)

    config = SearchGlobalConfig.objects.order_by("-updated_at", "-created_at").first()
    if config is None:
        SearchGlobalConfig.objects.create(
            default_provider_key="qianfan",
            default_count=8,
            default_summary_enabled=True,
            default_freshness="noLimit",
        )
    else:
        config.default_provider_key = "qianfan"
        config.save(update_fields=["default_provider_key", "updated_at"])

    pricing_fields = {f.name for f in MeterPricing._meta.get_fields()}
    owner_filter = {}
    for candidate in ("organization_id", "workteam_id", "workspace_id"):
        if candidate in pricing_fields:
            owner_filter[candidate] = None
            break

    bocha_price = (
        MeterPricing.objects.filter(
            meter_key="search.web.request",
            scope="global",
            provider_key="bocha",
            **owner_filter,
        )
        .order_by("-priority", "-created_at")
        .first()
    )
    unit_price = bocha_price.unit_price if bocha_price is not None else Decimal("0")

    MeterPricing.objects.get_or_create(
        meter_key="search.web.request",
        scope="global",
        provider_key="qianfan",
        model_name="",
        **owner_filter,
        defaults={
            "unit": "request",
            "unit_price": unit_price,
            "currency": "CREDITS",
            "precision": 4,
            "is_active": True,
            "priority": 100,
            "effective_from": timezone.now(),
            "effective_to": None,
        },
    )


def noop_reverse(apps, schema_editor):
    pass


class Migration(migrations.Migration):
    dependencies = [
        ("search", "0001_initial"),
        ("billing", "0001_squashed_0001_0014"),
    ]

    operations = [
        migrations.AlterField(
            model_name="searchprovider",
            name="provider_type",
            field=models.CharField(
                choices=[("qianfan", "千帆百度搜索"), ("bocha", "博查搜索")],
                db_index=True,
                default="qianfan",
                max_length=50,
                verbose_name="提供商类型",
            ),
        ),
        migrations.AlterField(
            model_name="searchprovider",
            name="base_url",
            field=models.URLField(
                default="https://qianfan.baidubce.com/v2/ai_search/web_search",
                verbose_name="搜索接口地址",
            ),
        ),
        migrations.AlterField(
            model_name="searchprovider",
            name="api_key_env_name",
            field=models.CharField(
                blank=True,
                default="QIANFAN_API_KEY",
                max_length=100,
                verbose_name="API Key 环境变量名",
            ),
        ),
        migrations.AlterField(
            model_name="searchglobalconfig",
            name="default_provider_key",
            field=models.CharField(
                default="qianfan",
                max_length=100,
                verbose_name="默认搜索提供商",
            ),
        ),
        migrations.RunPython(seed_qianfan_provider, noop_reverse),
    ]
