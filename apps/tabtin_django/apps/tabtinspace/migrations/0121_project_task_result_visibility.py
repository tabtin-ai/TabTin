# ProjectTask 验收前结果预览可见性

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        # release 已占用 0118–0120（ ContextItem organization）；本字段跟在其后。
        ('tabtinspace', '0120_contextitem_organization_host_exclusive_6603'),
    ]

    operations = [
        migrations.AddField(
            model_name='projecttask',
            name='result_visibility',
            field=models.CharField(
                choices=[
                    ('private', '仅责任人'),
                    ('project_preview', 'Project 预览'),
                ],
                default='private',
                help_text=(
                    '验收前默认仅责任人可见执行结果摘要与候选产物；'
                    '责任人可改为 project_preview，让同 Project 成员预览（不等于验收）。'
                ),
                max_length=32,
                verbose_name='结果可见性',
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
                    ('task_accepted', '接单'),
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
