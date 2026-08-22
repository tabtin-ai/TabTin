from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('tabtinspace', '0105_project_task_run_result_items'),
    ]

    operations = [
        migrations.AlterField(
            model_name='projecttaskrun',
            name='status',
            field=models.CharField(
                choices=[
                    ('preparing', '准备中'),
                    ('pending', '等待执行'),
                    ('running', '执行中'),
                    ('completed', '执行完成'),
                    ('failed', '执行失败'),
                    ('cancelled', '已取消'),
                ],
                default='pending',
                max_length=16,
                verbose_name='执行状态',
            ),
        ),
        migrations.RemoveConstraint(
            model_name='projecttaskrun',
            name='ctx_ptr_task_active_unique',
        ),
        migrations.AddConstraint(
            model_name='projecttaskrun',
            constraint=models.UniqueConstraint(
                condition=models.Q(status__in=['preparing', 'pending', 'running']),
                fields=('task',),
                name='ctx_ptr_task_active_unique',
            ),
        ),
    ]
