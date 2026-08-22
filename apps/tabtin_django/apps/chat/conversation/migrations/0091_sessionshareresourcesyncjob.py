import uuid

from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):
    dependencies = [
        ("conversation", "0090_sessionshareevent_client_message_id"),
    ]

    operations = [
        migrations.CreateModel(
            name="SessionShareResourceSyncJob",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("content_digest", models.CharField(max_length=64)),
                ("status", models.CharField(choices=[("pending", "待处理"), ("processing", "处理中"), ("retry", "待重试"), ("done", "已完成"), ("dead", "已终止")], db_index=True, default="pending", max_length=16)),
                ("attempts", models.PositiveSmallIntegerField(default=0)),
                ("next_retry_at", models.DateTimeField(blank=True, db_index=True, null=True)),
                ("last_error", models.TextField(blank=True, default="")),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("message", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="share_resource_sync_jobs", to="conversation.chatmessage")),
            ],
            options={"db_table": "chat_session_share_resource_sync_job"},
        ),
        migrations.AddConstraint(
            model_name="sessionshareresourcesyncjob",
            constraint=models.UniqueConstraint(fields=("message", "content_digest"), name="uq_share_resource_sync_message_digest"),
        ),
        migrations.AddIndex(
            model_name="sessionshareresourcesyncjob",
            index=models.Index(fields=["status", "next_retry_at"], name="chat_ssrsj_status_retry_idx"),
        ),
    ]
