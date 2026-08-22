"""#6198：删除 Workspace.agent FK，完成 Agent × Workspace 解耦。

Refs 。#6254 将 Space.agent 迁入 Workspace.agent；本迁移拆除该临时锚点。
身份只留在 ChatSession.agent_id 与显式 API agent_id；SpaceMembership.agent 保留。
"""

from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ('tabtinspace', '0115_backfill_migrated_workspace_agent_3266'),
    ]

    operations = [
        migrations.RemoveField(
            model_name='workspace',
            name='agent',
        ),
    ]
