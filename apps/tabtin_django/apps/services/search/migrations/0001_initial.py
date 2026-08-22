from __future__ import annotations

import uuid
from decimal import Decimal

from django.db import migrations, models
import django.core.validators
from django.utils import timezone


def seed_search_defaults(apps, schema_editor):
    SearchProvider = apps.get_model("search", "SearchProvider")
    SearchGlobalConfig = apps.get_model("search", "SearchGlobalConfig")
    MeterPricing = apps.get_model("billing", "MeterPricing")

    SearchProvider.objects.get_or_create(
        provider_key="bocha",
        defaults={
            "provider_type": "bocha",
            "display_name": "博查搜索",
            "base_url": "https://api.bocha.cn/v1/web-search",
            "api_key_env_name": "BOCHA_API_KEY",
            "request_timeout_sec": 30,
            "is_active": True,
            "priority": 100,
            "capabilities_config": {
                "summary": True,
                "freshness": True,
                "image": True,
                "video": False,
            },
            "extra_config": {},
        },
    )

    if not SearchGlobalConfig.objects.exists():
        SearchGlobalConfig.objects.create(
            default_provider_key="bocha",
            default_count=8,
            default_summary_enabled=True,
            default_freshness="noLimit",
        )

    # 注意（ 修复）：本 seed 跨 app 引用 billing.MeterPricing，但只声明了
    # billing/0001_squashed 依赖——全新库重放时执行点可能落在归属列还叫
    # workspace_id（<0007）、workteam_id（0007..0033）或 organization_id（>=0034）
    # 的任意时代，硬编码字段名必炸（pre-existing 缺陷，被 organization 改名放大）。
    # 动态探测当前历史状态的字段名做兼容；仅改 RunPython 函数体，不影响 schema
    # state，已应用过本迁移的库不受影响。
    pricing_fields = {f.name for f in MeterPricing._meta.get_fields()}
    owner_filter = {}
    for candidate in ("organization_id", "workteam_id", "workspace_id"):
        if candidate in pricing_fields:
            owner_filter[candidate] = None
            break

    MeterPricing.objects.get_or_create(
        meter_key="search.web.request",
        scope="global",
        provider_key="bocha",
        model_name="",
        **owner_filter,
        defaults={
            "unit": "request",
            "unit_price": Decimal("0"),
            "currency": "CREDITS",
            "precision": 4,
            "is_active": True,
            "priority": 100,
            "effective_from": timezone.now(),
            "effective_to": None,
        },
    )


class Migration(migrations.Migration):
    initial = True

    dependencies = [
        ("billing", "0001_squashed_0001_0014"),
    ]

    operations = [
        migrations.CreateModel(
            name="SearchProvider",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                (
                    "provider_type",
                    models.CharField(
                        choices=[("bocha", "博查搜索")],
                        db_index=True,
                        default="bocha",
                        max_length=50,
                        verbose_name="提供商类型",
                    ),
                ),
                ("provider_key", models.CharField(db_index=True, max_length=100, unique=True, verbose_name="提供商标识")),
                ("display_name", models.CharField(max_length=100, verbose_name="显示名称")),
                ("base_url", models.URLField(default="https://api.bocha.cn/v1/web-search", verbose_name="搜索接口地址")),
                ("api_key", models.CharField(blank=True, default="", max_length=500, verbose_name="API Key 覆盖值")),
                (
                    "api_key_env_name",
                    models.CharField(blank=True, default="BOCHA_API_KEY", max_length=100, verbose_name="API Key 环境变量名"),
                ),
                (
                    "request_timeout_sec",
                    models.PositiveIntegerField(
                        default=30,
                        validators=[
                            django.core.validators.MinValueValidator(1),
                            django.core.validators.MaxValueValidator(120),
                        ],
                        verbose_name="请求超时(秒)",
                    ),
                ),
                ("is_active", models.BooleanField(db_index=True, default=True, verbose_name="是否启用")),
                ("priority", models.IntegerField(default=100, verbose_name="优先级")),
                ("capabilities_config", models.JSONField(blank=True, default=dict, verbose_name="能力配置")),
                ("extra_config", models.JSONField(blank=True, default=dict, verbose_name="扩展配置")),
                ("created_at", models.DateTimeField(auto_now_add=True, verbose_name="创建时间")),
                ("updated_at", models.DateTimeField(auto_now=True, verbose_name="更新时间")),
            ],
            options={
                "verbose_name": "搜索提供商",
                "verbose_name_plural": "搜索提供商",
                "db_table": "services_search_provider",
                "ordering": ["-priority", "-created_at"],
            },
        ),
        migrations.CreateModel(
            name="SearchGlobalConfig",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("default_provider_key", models.CharField(default="bocha", max_length=100, verbose_name="默认搜索提供商")),
                (
                    "default_count",
                    models.PositiveSmallIntegerField(
                        default=8,
                        validators=[
                            django.core.validators.MinValueValidator(1),
                            django.core.validators.MaxValueValidator(50),
                        ],
                        verbose_name="默认返回条数",
                    ),
                ),
                ("default_summary_enabled", models.BooleanField(default=True, verbose_name="默认开启摘要")),
                ("default_freshness", models.CharField(default="noLimit", max_length=64, verbose_name="默认时间范围")),
                ("created_at", models.DateTimeField(auto_now_add=True, verbose_name="创建时间")),
                ("updated_at", models.DateTimeField(auto_now=True, verbose_name="更新时间")),
            ],
            options={
                "verbose_name": "搜索全局配置",
                "verbose_name_plural": "搜索全局配置",
                "db_table": "services_search_global_config",
                "ordering": ["-updated_at", "-created_at"],
            },
        ),
        migrations.AddIndex(
            model_name="searchprovider",
            index=models.Index(fields=["provider_type", "is_active"], name="srch_type_active_idx"),
        ),
        migrations.AddIndex(
            model_name="searchprovider",
            index=models.Index(fields=["provider_key", "is_active"], name="srch_key_active_idx"),
        ),
        migrations.RunPython(seed_search_defaults, migrations.RunPython.noop),
    ]
