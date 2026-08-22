from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('tabtinspace', '0080_backfill_team_space_execution_agents'),
    ]

    operations = [
        migrations.AlterField(
            model_name='spaceactivityevent',
            name='event_type',
            field=models.CharField(
                choices=[
                    ('space_created', '创建团队 Space'),
                    ('member_joined', '成员加入'),
                    ('member_left', '成员退出'),
                    ('member_role_changed', '成员角色变更'),
                    ('asset_created', '新增资产'),
                    ('asset_archived', '归档资产'),
                    ('asset_restored', '恢复资产'),
                    ('agent_run_started', 'Agent 任务开始'),
                    ('agent_run_completed', 'Agent 任务完成'),
                    ('agent_run_failed', 'Agent 任务失败'),
                    ('settings_updated', '设置变更'),
                    ('channel_created', '创建频道'),
                    ('channel_renamed', '重命名频道'),
                    ('channel_archived', '归档频道'),
                ],
                max_length=32,
                verbose_name='事件类型',
            ),
        ),
    ]
