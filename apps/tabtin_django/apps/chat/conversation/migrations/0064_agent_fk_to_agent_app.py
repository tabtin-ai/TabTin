"""ChatSession / ChatMessage.agent FK 改指 agent.Agent。"""

import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('agent', '0001_move_agent_from_tabtinspace'),
        ('conversation', '0063_align_agent_workspace_models'),
    ]

    operations = [
        migrations.AlterField(
            model_name='chatsession',
            name='agent',
            field=models.ForeignKey(
                blank=True,
                db_column='agent_id',
                db_index=False,
                help_text='会话的执行 Agent（agent.Agent）；一 Agent 管多会话的直挂锚点。',
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name='+',
                to='agent.agent',
                verbose_name='执行 Agent',
            ),
        ),
        migrations.AlterField(
            model_name='chatmessage',
            name='agent',
            field=models.ForeignKey(
                blank=True,
                help_text='assistant/tool_artifact 消息的实际执行者；历史归属不随会话当前指针变化。',
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name='+',
                to='agent.agent',
                verbose_name='本轮执行 Agent',
            ),
        ),
    ]
