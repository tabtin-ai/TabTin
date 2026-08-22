from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ('tabtinspace', '0104_workspace_home_per_organization'),
    ]

    operations = [
        migrations.AddField(
            model_name='projecttaskrun',
            name='result_items',
            field=models.JSONField(
                blank=True,
                default=list,
                help_text='Agent 在本次执行中明确交付的云端资源快照；验收前仅责任人可见。',
                verbose_name='执行结果候选交付物',
            ),
        ),
    ]
