"""
PRD-06 §5.4.2 — SubtaskRun 新增通知幂等 + 发起者身份 + 模板版本字段。

历史数据回填策略：已处于终态（completed / error / failed / timeout / cancelled / archived）
的记录将 notified_at 设为 updated_at，避免已完成任务触发多余的 push 汇报。
"""

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("agent_engine", "0006_prd06_template_field_constraints"),
    ]

    operations = [
        migrations.AddField(
            model_name="subtaskrun",
            name="initiator_speaker_id",
            field=models.CharField(
                blank=True,
                db_index=True,
                help_text="发起者 speaker_id（agent-agnostic），为二期 Handoff 留路",
                max_length=64,
                null=True,
            ),
        ),
        migrations.AddField(
            model_name="subtaskrun",
            name="template_version",
            field=models.IntegerField(
                blank=True,
                help_text="子 Agent spawn 时的模板版本号，指向 SubAgentTemplateVersion",
                null=True,
            ),
        ),
        migrations.AddField(
            model_name="subtaskrun",
            name="notified_at",
            field=models.DateTimeField(
                blank=True,
                help_text="主 Agent push 汇报时间戳，幂等标记",
                null=True,
            ),
        ),
        migrations.AddField(
            model_name="subtaskrun",
            name="notification_retry_count",
            field=models.IntegerField(
                default=0,
                help_text="push 汇报重试次数",
            ),
        ),
        migrations.RunSQL(
            sql="""
                UPDATE agent_engine_subtask_runs
                SET notified_at = updated_at
                WHERE status IN ('completed', 'error', 'failed', 'timeout', 'cancelled', 'archived')
                  AND notified_at IS NULL;
            """,
            reverse_sql="""
                UPDATE agent_engine_subtask_runs
                SET notified_at = NULL
                WHERE notified_at IS NOT NULL;
            """,
        ),
        migrations.RunSQL(
            sql="""
                UPDATE agent_engine_subtask_runs
                SET notified_at = updated_at
                WHERE status = 'running'
                  AND updated_at < NOW() - INTERVAL '5 minutes'
                  AND notified_at IS NULL;
            """,
            reverse_sql=migrations.RunSQL.noop,
        ),
        migrations.AddIndex(
            model_name="subtaskrun",
            index=models.Index(
                condition=models.Q(notified_at__isnull=True),
                fields=["parent_thread_id", "status"],
                name="idx_subagent_pending_notify",
            ),
        ),
    ]
