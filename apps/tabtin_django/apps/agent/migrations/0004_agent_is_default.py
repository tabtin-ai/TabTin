"""#6184/#6353：默认 Agent 标记字段。

回填见 0004a，唯一约束见 0004b（ / ：回填与 DDL 分文件）。
"""

from __future__ import annotations

from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("agent", "0003_agent_goal_agent_settings_agent_template_id_and_more"),
    ]

    operations = [
        migrations.AddField(
            model_name="agent",
            name="is_default",
            field=models.BooleanField(
                default=False,
                help_text="每用户在组织内至多一个活跃默认 Agent；默认身份不可删除，缺失时幂等补建。",
                verbose_name="是否为默认 Agent",
            ),
        ),
    ]
