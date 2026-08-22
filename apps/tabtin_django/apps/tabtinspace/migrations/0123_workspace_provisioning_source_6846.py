# ：Workspace 供给来源字段（schema only）
#
# 侧栏隐藏依据改为系统供给来源，不再用 Project 关联关系推断。
# 数据回填见 0123a。

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('tabtinspace', '0122_project_task_assignment_language_6844'),
    ]

    operations = [
        migrations.AddField(
            model_name='workspace',
            name='provisioning_source',
            field=models.CharField(
                choices=[
                    ('user', '用户主动创建'),
                    ('system_project', '系统随 Project 自动供给'),
                    ('system_task', '系统随 Task 自动供给'),
                ],
                default='user',
                help_text=(
                    '决定普通 Workspace 导航是否默认隐藏。'
                    'system_project/system_task=系统自动供给的内部现场；'
                    'user=用户主动创建或主动新建的资产。'
                    '改绑 Project/Task 执行关联不得改写本字段。'
                ),
                max_length=32,
                verbose_name='供给来源',
            ),
        ),
    ]
