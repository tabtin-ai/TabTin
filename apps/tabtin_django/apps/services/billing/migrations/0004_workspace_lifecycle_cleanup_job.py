from django.db import migrations, models
import uuid


class Migration(migrations.Migration):

    dependencies = [
        ("billing", "0003_billing_usage_event_idempotency_default"),
    ]

    operations = [
        migrations.CreateModel(
            name="WorkspaceLifecycleCleanupJob",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("workspace_id", models.CharField(db_index=True, max_length=100, unique=True, verbose_name="工作空间ID")),
                ("trigger_source", models.CharField(db_index=True, default="workspace_delete", max_length=50, verbose_name="触发来源")),
                ("status", models.CharField(choices=[("pending", "待执行"), ("running", "执行中"), ("succeeded", "已成功"), ("failed", "待重试"), ("permanently_failed", "永久失败")], db_index=True, default="pending", max_length=30, verbose_name="状态")),
                ("attempt_count", models.PositiveIntegerField(default=0, verbose_name="已尝试次数")),
                ("max_attempts", models.PositiveIntegerField(default=6, verbose_name="最大尝试次数")),
                ("last_error", models.TextField(blank=True, default="", verbose_name="最后一次错误")),
                ("next_retry_at", models.DateTimeField(blank=True, db_index=True, null=True, verbose_name="下次重试时间")),
                ("last_success_summary", models.JSONField(default=dict, verbose_name="最近成功清理摘要")),
                ("started_at", models.DateTimeField(blank=True, null=True, verbose_name="最近开始时间")),
                ("finished_at", models.DateTimeField(blank=True, null=True, verbose_name="最近完成时间")),
                ("created_at", models.DateTimeField(auto_now_add=True, verbose_name="创建时间")),
                ("updated_at", models.DateTimeField(auto_now=True, verbose_name="更新时间")),
            ],
            options={
                "db_table": "services_billing_workspace_lifecycle_cleanup_job",
                "verbose_name": "工作空间生命周期清理作业",
                "verbose_name_plural": "工作空间生命周期清理作业",
                "ordering": ["status", "next_retry_at", "-updated_at"],
            },
        ),
        migrations.AddIndex(
            model_name="workspacelifecyclecleanupjob",
            index=models.Index(fields=["status", "next_retry_at"], name="billing_cleanup_due_idx"),
        ),
        migrations.AddIndex(
            model_name="workspacelifecyclecleanupjob",
            index=models.Index(fields=["trigger_source", "created_at"], name="billing_cleanup_trigger_idx"),
        ),
    ]
