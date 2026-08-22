"""#6554：默认 Agent 部分唯一约束（与 0004a 回填拆事务，避 ）。"""

from __future__ import annotations

from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("agent", "0004a_agent_is_default_backfill"),
    ]

    operations = [
        migrations.AddConstraint(
            model_name="agent",
            constraint=models.UniqueConstraint(
                condition=models.Q(is_default=True, is_active=True),
                fields=("organization", "owner_user"),
                name="agent_one_active_default_per_owner",
            ),
        ),
    ]
