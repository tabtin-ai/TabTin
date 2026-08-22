from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


def seed_platform_config(apps, schema_editor):
    ConfigItem = apps.get_model("platform_config", "PlatformRuntimeConfigItem")
    ConfigItem.objects.update_or_create(
        key="product_limits.max_workteams_per_user",
        defaults={
            "name": "每个用户最多可创建团队数",
            "description": "限制普通用户可主动创建的 team 类型工作团队数量，不包含个人默认团队和加入的团队。",
            "category": "product_limits",
            "value_type": "integer",
            "value": 3,
            "default_value": 3,
            "is_active": True,
            "is_system": True,
            "sort_order": 10,
            "extra_schema": {
                "group": "团队限制",
                "min": 0,
                "max": 100,
                "unit": "个",
                "help": "0 表示禁止创建团队，-1 表示不限制。",
            },
        },
    )


class Migration(migrations.Migration):
    initial = True

    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name="PlatformRuntimeConfigItem",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                (
                    "key",
                    models.CharField(
                        help_text="建议使用命名空间格式，例如 product_limits.max_workteams_per_user",
                        max_length=120,
                        unique=True,
                        verbose_name="配置键",
                    ),
                ),
                ("name", models.CharField(max_length=120, verbose_name="配置名称")),
                ("description", models.TextField(blank=True, verbose_name="配置说明")),
                ("category", models.CharField(db_index=True, max_length=64, verbose_name="配置分类")),
                (
                    "value_type",
                    models.CharField(
                        choices=[
                            ("string", "字符串"),
                            ("integer", "整数"),
                            ("decimal", "小数"),
                            ("boolean", "布尔"),
                            ("json", "JSON"),
                        ],
                        default="string",
                        max_length=20,
                        verbose_name="值类型",
                    ),
                ),
                ("value", models.JSONField(default=dict, verbose_name="配置值")),
                ("default_value", models.JSONField(default=dict, verbose_name="默认值")),
                ("is_active", models.BooleanField(db_index=True, default=True, verbose_name="是否启用")),
                ("is_system", models.BooleanField(default=False, verbose_name="系统内置")),
                ("sort_order", models.IntegerField(default=0, verbose_name="排序")),
                (
                    "extra_schema",
                    models.JSONField(
                        blank=True,
                        default=dict,
                        help_text="用于描述 min/max/options/group 等 UI 元数据，不参与运行时判断。",
                        verbose_name="前端表单元数据",
                    ),
                ),
                ("created_at", models.DateTimeField(auto_now_add=True, verbose_name="创建时间")),
                ("updated_at", models.DateTimeField(auto_now=True, verbose_name="更新时间")),
                (
                    "updated_by",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="updated_platform_runtime_configs",
                        to=settings.AUTH_USER_MODEL,
                        verbose_name="最后修改人",
                    ),
                ),
            ],
            options={
                "verbose_name": "平台运行时配置",
                "verbose_name_plural": "平台运行时配置",
                "db_table": "platform_runtime_config_item",
                "ordering": ["category", "sort_order", "key"],
            },
        ),
        migrations.AddIndex(
            model_name="platformruntimeconfigitem",
            index=models.Index(fields=["category", "is_active"], name="plat_cfg_cat_active_idx"),
        ),
        migrations.AddIndex(
            model_name="platformruntimeconfigitem",
            index=models.Index(fields=["updated_at"], name="plat_cfg_updated_idx"),
        ),
        migrations.AddConstraint(
            model_name="platformruntimeconfigitem",
            constraint=models.CheckConstraint(check=~models.Q(key=""), name="plat_cfg_key_not_blank"),
        ),
        migrations.AddConstraint(
            model_name="platformruntimeconfigitem",
            constraint=models.CheckConstraint(
                check=~models.Q(category=""),
                name="plat_cfg_category_not_blank",
            ),
        ),
        migrations.RunPython(seed_platform_config, migrations.RunPython.noop),
    ]
