import django.db.models.deletion
import django.utils.timezone
from django.db import migrations, models


RUN_STATUS_CHOICES = [
    ("queued", "Queued"),
    ("running", "Running"),
    ("waiting_user", "Waiting for user"),
    ("paused", "Paused"),
    ("cancelling", "Cancelling"),
    ("completed", "Completed"),
    ("failed", "Failed"),
    ("cancelled", "Cancelled"),
    ("interrupted", "Interrupted"),
]


class Migration(migrations.Migration):
    dependencies = [
        ("conversation", "0071_chatmessage_agent_profile_context_kind"),
        ("agent_engine", "0019_permission_audit_workspace"),
    ]

    operations = [
        migrations.AddField(
            model_name="executionrun",
            name="error_class",
            field=models.CharField(blank=True, max_length=128, null=True),
        ),
        migrations.AddField(
            model_name="executionrun",
            name="revision",
            field=models.PositiveBigIntegerField(default=0),
        ),
        migrations.AddField(
            model_name="executionrun",
            name="sequence",
            field=models.PositiveBigIntegerField(default=1),
        ),
        migrations.AddField(
            model_name="executionrun",
            name="state_changed_at",
            field=models.DateTimeField(default=django.utils.timezone.now),
        ),
        migrations.AddField(
            model_name="executionrun",
            name="stop_reason",
            field=models.CharField(blank=True, max_length=128, null=True),
        ),
        migrations.AddField(
            model_name="executionrun",
            name="waiting_interaction_id",
            field=models.UUIDField(blank=True, null=True),
        ),
        migrations.AlterField(
            model_name="executionrun",
            name="started_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.SeparateDatabaseAndState(
            state_operations=[
                migrations.AlterField(
                    model_name="executionrun",
                    name="status",
                    field=models.CharField(
                        choices=RUN_STATUS_CHOICES,
                        db_index=True,
                        default="queued",
                        max_length=32,
                    ),
                ),
            ],
            database_operations=[],
        ),
        migrations.CreateModel(
            name="SessionRunProjection",
            fields=[
                (
                    "session",
                    models.OneToOneField(
                        on_delete=django.db.models.deletion.CASCADE,
                        primary_key=True,
                        related_name="run_state_projection",
                        serialize=False,
                        to="conversation.chatsession",
                    ),
                ),
                ("sequence", models.PositiveBigIntegerField()),
                ("revision", models.PositiveBigIntegerField()),
                (
                    "status",
                    models.CharField(
                        choices=RUN_STATUS_CHOICES,
                        max_length=32,
                    ),
                ),
                ("queue_depth", models.PositiveIntegerField(default=0)),
                ("started_at", models.DateTimeField(blank=True, null=True)),
                ("state_changed_at", models.DateTimeField()),
                ("ended_at", models.DateTimeField(blank=True, null=True)),
                (
                    "stop_reason",
                    models.CharField(blank=True, max_length=128, null=True),
                ),
                (
                    "error_class",
                    models.CharField(blank=True, max_length=128, null=True),
                ),
                ("waiting_interaction_id", models.UUIDField(blank=True, null=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                (
                    "current_run",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="+",
                        to="agent_engine.executionrun",
                    ),
                ),
            ],
            options={
                "db_table": "agent_engine_session_run_projection",
            },
        ),
        migrations.AddIndex(
            model_name="sessionrunprojection",
            index=models.Index(
                fields=["status"],
                name="idx_session_run_status",
            ),
        ),
    ]
