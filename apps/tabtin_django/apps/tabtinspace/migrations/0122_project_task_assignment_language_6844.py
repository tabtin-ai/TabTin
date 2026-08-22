# Project Task 确认状态产品语言

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('tabtinspace', '0121_project_task_result_visibility'),
    ]

    operations = [
        migrations.AlterField(
            model_name='projecttask',
            name='assignment_status',
            field=models.CharField(
                choices=[
                    ('pending', '待确认'),
                    ('accepted', '已接受'),
                    ('rejected', '已拒绝'),
                ],
                default='pending',
                max_length=16,
                verbose_name='任务确认状态',
            ),
        ),
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
                    ('task_created', '创建任务'),
                    ('task_assigned', '指派任务'),
                    ('task_accepted', '接受任务'),
                    ('task_rejected', '拒绝任务'),
                    ('task_execution_configured', '确认任务执行配置'),
                    ('task_review_requested', '任务待验收'),
                    ('task_completed', '任务验收完成'),
                    ('task_result_preview_changed', '任务结果预览可见性变更'),
                ],
                max_length=32,
                verbose_name='事件类型',
            ),
        ),
    ]
