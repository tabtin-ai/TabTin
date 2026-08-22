"""#9614 未答轮次撤回审计表：只建表，无回填。"""

from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ("conversation", "0091_sessionshareresourcesyncjob"),
    ]

    operations = [
        migrations.CreateModel(
            name="ChatMessageWithdrawEvent",
            fields=[
                ("id", models.BigAutoField(primary_key=True, serialize=False)),
                (
                    "organization_id",
                    models.CharField(
                        db_index=True, max_length=100, verbose_name="组织ID",
                    ),
                ),
                (
                    "actor_user_id",
                    models.CharField(max_length=100, verbose_name="操作者用户ID"),
                ),
                (
                    "source",
                    models.CharField(
                        help_text="electron_runtime / mobile_cancel / daemon_runtime",
                        max_length=32,
                        verbose_name="来源",
                    ),
                ),
                (
                    "client_message_id",
                    models.CharField(
                        db_index=True,
                        max_length=64,
                        verbose_name="被撤轮次客户端消息ID",
                    ),
                ),
                (
                    "payload_json",
                    models.JSONField(
                        blank=True,
                        default=list,
                        help_text=(
                            "数组：每项含 id / role / text_summary / "
                            "content_blocks_json / created_at"
                        ),
                        verbose_name="被删消息快照",
                    ),
                ),
                (
                    "deleted_count",
                    models.IntegerField(default=0, verbose_name="实际删除行数"),
                ),
                (
                    "created_at",
                    models.DateTimeField(
                        auto_now_add=True, db_index=True, verbose_name="创建时间",
                    ),
                ),
                (
                    "session",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="withdraw_events",
                        to="conversation.chatsession",
                        verbose_name="所属会话",
                    ),
                ),
            ],
            options={
                "verbose_name": "未答轮次撤回审计事件",
                "verbose_name_plural": "未答轮次撤回审计事件",
                "db_table": "chat_message_withdraw_event",
            },
        ),
        migrations.AddIndex(
            model_name="chatmessagewithdrawevent",
            index=models.Index(
                fields=["session", "-created_at"],
                name="chat_withdraw_evt_sess_idx",
            ),
        ),
    ]
