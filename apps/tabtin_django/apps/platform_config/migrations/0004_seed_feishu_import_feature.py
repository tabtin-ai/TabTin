from django.db import migrations


DEFAULT_FEISHU_IMPORT_FEATURE = {
    "enabled": True,
    "rollout": {
        "allow_user_ids": [],
        "allow_organization_ids": [],
        "percentage": 0,
        "percentage_unit": "organization",
    },
}


def seed_feishu_import_feature(apps, schema_editor):
    PlatformRuntimeConfigItem = apps.get_model(
        "platform_config",
        "PlatformRuntimeConfigItem",
    )
    PlatformRuntimeConfigItem.objects.get_or_create(
        key="feature_flags.feishu_import",
        defaults={
            "name": "飞书导入",
            "description": "按组织定向开放飞书授权、资源浏览与导入能力。",
            "category": "feature_flags",
            "value_type": "json",
            "value": DEFAULT_FEISHU_IMPORT_FEATURE,
            "default_value": DEFAULT_FEISHU_IMPORT_FEATURE,
            "is_active": True,
            "is_system": True,
            "sort_order": 30,
        },
    )


class Migration(migrations.Migration):
    dependencies = [
        ("platform_config", "0003_alter_platformruntimeconfigitem_key"),
    ]

    operations = [
        migrations.RunPython(seed_feishu_import_feature, migrations.RunPython.noop),
    ]
