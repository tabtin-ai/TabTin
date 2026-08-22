from decimal import Decimal

from django.db import migrations, models


def seed_doubao_provider(apps, schema_editor):
    SearchProvider = apps.get_model("search", "SearchProvider")
    MeterPricing = apps.get_model("billing", "MeterPricing")

    SearchProvider.objects.update_or_create(
        provider_key="doubao",
        defaults={
            "provider_type": "doubao",
            "display_name": "豆包搜索 Custom 版",
            "base_url": "https://open.feedcoopapi.com/search_api/web_search",
            "api_key": "",
            "api_key_env_name": "DOUBAO_SEARCH_API_KEY",
            "request_timeout_sec": 30,
            "is_active": False,
            "priority": 40,
            "capabilities_config": {"summary": True, "freshness": True, "image": False},
            "extra_config": {
                "variant": "custom",
                "need_content": False,
                "need_url": True,
                "auth_info_level": 0,
                "query_rewrite": False,
                "content_formats": "markdown",
                "max_content_chars": 4000,
            },
        },
    )

    pricing_fields = {f.name for f in MeterPricing._meta.get_fields()}
    pricing_attnames = {getattr(f, "attname", "") for f in MeterPricing._meta.get_fields()}
    owner_filter = {}
    for candidate in ("organization_id", "organization", "workteam_id", "workspace_id"):
        if candidate in pricing_fields or candidate in pricing_attnames:
            owner_filter[candidate] = None
            break

    source_price = (
        MeterPricing.objects.filter(
            meter_key="search.web.request",
            scope="global",
            provider_key="qianfan",
            **owner_filter,
        )
        .order_by("-priority", "-created_at")
        .first()
        or MeterPricing.objects.filter(
            meter_key="search.web.request",
            scope="global",
            provider_key="bocha",
            **owner_filter,
        )
        .order_by("-priority", "-created_at")
        .first()
    )
    unit_price = source_price.unit_price if source_price is not None else Decimal("0")

    MeterPricing.objects.get_or_create(
        meter_key="search.web.request",
        scope="global",
        provider_key="doubao",
        model_name="",
        **owner_filter,
        defaults={
            "unit": "request",
            "unit_price": unit_price,
            "currency": "CREDITS",
            "precision": 4,
            "is_active": True,
            "priority": 80,
        },
    )


def unseed_doubao_provider(apps, schema_editor):
    SearchProvider = apps.get_model("search", "SearchProvider")
    SearchGlobalConfig = apps.get_model("search", "SearchGlobalConfig")
    MeterPricing = apps.get_model("billing", "MeterPricing")

    SearchGlobalConfig.objects.filter(default_provider_key="doubao").update(
        default_provider_key="qianfan"
    )
    SearchProvider.objects.filter(provider_key="doubao").delete()
    MeterPricing.objects.filter(
        meter_key="search.web.request",
        scope="global",
        provider_key="doubao",
        model_name="",
        **_meter_pricing_owner_filter(MeterPricing),
    ).delete()


def _meter_pricing_owner_filter(MeterPricing):
    pricing_fields = {f.name for f in MeterPricing._meta.get_fields()}
    pricing_attnames = {getattr(f, "attname", "") for f in MeterPricing._meta.get_fields()}
    for candidate in ("organization_id", "organization", "workteam_id", "workspace_id"):
        if candidate in pricing_fields or candidate in pricing_attnames:
            return {candidate: None}
    return {}


class Migration(migrations.Migration):

    dependencies = [
        ("search", "0002_add_qianfan_search_provider"),
        ("billing", "0001_squashed_0001_0014"),
    ]

    operations = [
        migrations.AlterField(
            model_name="searchprovider",
            name="provider_type",
            field=models.CharField(
                choices=[
                    ("qianfan", "千帆百度搜索"),
                    ("bocha", "博查搜索"),
                    ("doubao", "豆包搜索"),
                ],
                db_index=True,
                default="qianfan",
                max_length=50,
                verbose_name="提供商类型",
            ),
        ),
        migrations.RunPython(seed_doubao_provider, reverse_code=unseed_doubao_provider),
    ]
