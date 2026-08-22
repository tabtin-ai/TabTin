import django.conf
import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        migrations.swappable_dependency(django.conf.settings.AUTH_USER_MODEL),
        ("agent_engine", "0023_run_host_lease"),
    ]

    operations = [
        migrations.AddField(
            model_name="executionrun",
            name="terminal_projection_revision",
            field=models.PositiveBigIntegerField(
                blank=True,
                help_text="该轮成为会话可见终态时冻结的投影 revision；用于跨设备已读 ACK。",
                null=True,
            ),
        ),
        migrations.AddField(
            model_name="executionrun",
            name="unread_eligible",
            field=models.BooleanField(
                default=False,
                help_text="仅新协议上线后完成的 run 可产生未读，避免迁移时点亮全部历史。",
            ),
        ),
        migrations.CreateModel(
            name="SessionReadReceipt",
            fields=[
                (
                    "id",
                    models.BigAutoField(
                        auto_created=True,
                        primary_key=True,
                        serialize=False,
                        verbose_name="ID",
                    ),
                ),
                (
                    "last_read_run_sequence",
                    models.PositiveBigIntegerField(default=0),
                ),
                (
                    "last_read_terminal_revision",
                    models.PositiveBigIntegerField(default=0),
                ),
                ("read_at", models.DateTimeField(blank=True, null=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                (
                    "session",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="read_receipts",
                        to="conversation.chatsession",
                    ),
                ),
                (
                    "user",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="+",
                        to=django.conf.settings.AUTH_USER_MODEL,
                    ),
                ),
            ],
            options={
                "db_table": "agent_engine_session_read_receipts",
            },
        ),
        migrations.AddConstraint(
            model_name="sessionreadreceipt",
            constraint=models.UniqueConstraint(
                fields=("user", "session"),
                name="uq_session_read_receipt_user_session",
            ),
        ),
        migrations.AddIndex(
            model_name="sessionreadreceipt",
            index=models.Index(
                fields=["user", "session"],
                name="idx_read_receipt_user_session",
            ),
        ),
    ]
