"""Wave 6 二次续作 NEW-P1-2:Goal 模型 verbose_name 由"目标"改为"Tracker"。

charter v1.8 §3.1:**所有用户可见处必须用 Tracker**——admin 显示用的
``Meta.verbose_name`` 也是用户可见,本次同步改为 "Tracker"。

本 migration 仅修改 Meta options,**不触及任何字段 / 索引 / 约束**——纯文案
变更,数据库零 DDL,可自由 reverse。
"""

from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ("tracker", "0023_drop_deprecated_v18_fields"),
    ]

    operations = [
        migrations.AlterModelOptions(
            name="goal",
            options={
                "ordering": ["-created_at"],
                "verbose_name": "Tracker",
                "verbose_name_plural": "Tracker",
            },
        ),
    ]
