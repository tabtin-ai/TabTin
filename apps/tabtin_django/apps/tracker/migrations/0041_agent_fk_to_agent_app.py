"""Tracker.agent FK 改指 agent.Agent。"""

import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('agent', '0001_move_agent_from_tabtinspace'),
        ('tracker', '0040_tracker_workspace_binding'),
    ]

    operations = [
        migrations.AlterField(
            model_name='tracker',
            name='agent',
            field=models.ForeignKey(
                blank=True,
                help_text='执行该 Tracker 的 Agent。本期 nullable，应用层校验「创建时必填」。',
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name='trackers',
                to='agent.agent',
                verbose_name='执行 Agent',
            ),
        ),
    ]
