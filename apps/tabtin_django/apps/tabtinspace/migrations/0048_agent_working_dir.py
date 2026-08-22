# Generated for Agent working_dir minimal refactor (see docs/agent-working-dir-prd.md)

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('tabtinspace', '0047_soul_preset_v0_1_cleanup'),
    ]

    operations = [
        migrations.AddField(
            model_name='agent',
            name='working_dir',
            field=models.TextField(
                blank=True,
                default='',
                help_text='Agent 在 control_device 上的工作目录绝对路径。空值表示尚未设置，UI 应引导用户去 Agent 设置面板补齐。',
                verbose_name='运行目录',
            ),
        ),
        migrations.AddField(
            model_name='agent',
            name='working_dir_type',
            field=models.CharField(
                blank=True,
                choices=[
                    ('code', '代码项目'),
                    ('mixed', '混合项目'),
                    ('doc', '文档项目'),
                ],
                default='',
                help_text='code/mixed/doc 三档，决定默认 surface（code→TabCode，mixed/doc→TabFolder）。doc 类型现阶段与 mixed 行为一致，留位给将来文书工作专题。',
                max_length=10,
                verbose_name='运行目录类型',
            ),
        ),
    ]
