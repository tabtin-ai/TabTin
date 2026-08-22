# Generated for external_agent capability sunset (2026-04-26)
#
# 仅修改 GoalStep.capability choices 元数据，不动存量数据。
# 历史 capability='external_agent' 的 GoalStep 行保留在 DB 中，但 step_executor
# 会把它们识别为已下线 capability 并把 StepRun 标记为 failed（与 group_chat
# 同样的 graceful failure 路径）。

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('tracker', '0018_alter_goalstep_capability'),
    ]

    operations = [
        migrations.AlterField(
            model_name='goalstep',
            name='capability',
            field=models.CharField(choices=[('agent', '通用 Agent'), ('browser', 'Browser / 采集'), ('table', 'TabData'), ('docs', 'TabDoc'), ('slide', 'TabSlide'), ('code', 'TabCode'), ('notification', '通知'), ('group_chat', '多 Agent 讨论（已下线）')], default='agent', max_length=32, verbose_name='能力类型'),
        ),
    ]
