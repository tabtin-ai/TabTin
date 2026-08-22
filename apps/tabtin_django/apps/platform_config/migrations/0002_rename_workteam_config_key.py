"""workteam -> organization 重命名迁移。

0001 seed 的配置 key `product_limits.max_workteams_per_user` 已在代码中改为
`product_limits.max_organizations_per_user`（apps/platform_config/services.py）。
存量行不迁移会变孤儿：读取端落默认值、AdminDash 配置页留一条改不生效的旧行。
本迁移原地 UPDATE key 与展示文案，带 reverse。
"""

from django.db import migrations

OLD_KEY = "product_limits.max_workteams_per_user"
NEW_KEY = "product_limits.max_organizations_per_user"


def _rename_forward(apps, schema_editor):
    ConfigItem = apps.get_model("platform_config", "PlatformRuntimeConfigItem")
    ConfigItem.objects.filter(key=OLD_KEY).update(
        key=NEW_KEY,
        name="每个用户最多可创建组织数",
        description="限制普通用户可主动创建的 team 类型组织数量，不包含个人默认组织和加入的组织。",
    )
    ConfigItem.objects.filter(key=NEW_KEY, extra_schema__group="团队限制").update(
        extra_schema={
            "group": "组织限制",
            "min": 0,
            "max": 100,
            "unit": "个",
            "help": "0 表示禁止创建组织，-1 表示不限制。",
        },
    )


def _rename_reverse(apps, schema_editor):
    ConfigItem = apps.get_model("platform_config", "PlatformRuntimeConfigItem")
    ConfigItem.objects.filter(key=NEW_KEY).update(
        key=OLD_KEY,
        name="每个用户最多可创建团队数",
        description="限制普通用户可主动创建的 team 类型工作团队数量，不包含个人默认团队和加入的团队。",
    )
    ConfigItem.objects.filter(key=OLD_KEY, extra_schema__group="组织限制").update(
        extra_schema={
            "group": "团队限制",
            "min": 0,
            "max": 100,
            "unit": "个",
            "help": "0 表示禁止创建团队，-1 表示不限制。",
        },
    )


class Migration(migrations.Migration):

    dependencies = [
        ("platform_config", "0001_initial"),
    ]

    operations = [
        migrations.RunPython(_rename_forward, _rename_reverse),
    ]
