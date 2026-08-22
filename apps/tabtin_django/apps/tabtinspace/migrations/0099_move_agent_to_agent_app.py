"""从 tabtinspace 状态中删除 Agent，并把 FK 改指 agent.Agent。

物理表改名由 agent.0001 完成；本迁移仅改 Django 状态 / FK 元数据。
"""

import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('agent', '0001_move_agent_from_tabtinspace'),
        # 必须先把跨 app FK 改指 agent.Agent，再 DeleteModel，否则状态图会残留
        # 悬空的 tabtinspace.agent 引用。
        ('conversation', '0064_agent_fk_to_agent_app'),
        ('tracker', '0041_agent_fk_to_agent_app'),
        ('tabtinspace', '0098_strip_agent_approval_config'),
    ]

    operations = [
        migrations.SeparateDatabaseAndState(
            state_operations=[
                migrations.AlterField(
                    model_name='space',
                    name='agent',
                    field=models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name='spaces',
                        to='agent.agent',
                        verbose_name='兼容关联 Agent（可选）',
                    ),
                ),
                migrations.AlterField(
                    model_name='spacemembership',
                    name='agent',
                    field=models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name='space_memberships',
                        to='agent.agent',
                        verbose_name='Agent 身份',
                    ),
                ),
                migrations.DeleteModel(name='Agent'),
            ],
            database_operations=[],
        ),
    ]
