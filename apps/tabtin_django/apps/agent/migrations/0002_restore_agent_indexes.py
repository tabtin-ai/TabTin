"""在 tabtinspace 删除旧 Agent 状态后，把既有索引挂回 agent.Agent 状态。

物理索引已随 RenameTable 保留在 agent_agent 上，故 database_operations 为空。
"""

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('agent', '0001_move_agent_from_tabtinspace'),
        ('tabtinspace', '0099_move_agent_to_agent_app'),
    ]

    operations = [
        migrations.SeparateDatabaseAndState(
            state_operations=[
                migrations.AddIndex(
                    model_name='agent',
                    index=models.Index(
                        fields=['organization', 'type'],
                        name='ctx_agent_ws_type_idx',
                    ),
                ),
                migrations.AddIndex(
                    model_name='agent',
                    index=models.Index(
                        fields=['organization', 'owner_user'],
                        name='ctx_agent_ws_owner_idx',
                    ),
                ),
                migrations.AddIndex(
                    model_name='agent',
                    index=models.Index(
                        fields=['organization', 'is_active'],
                        name='ctx_agent_ws_active_idx',
                    ),
                ),
            ],
            database_operations=[],
        ),
    ]
