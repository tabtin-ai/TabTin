import uuid

from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ("conversation", "0080_sessionshareresourcegrant"),
    ]

    operations = [
        migrations.CreateModel(
            name="SessionWorkspaceFileReference",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("relative_path", models.CharField(max_length=1024, verbose_name="规范化相对路径")),
                ("path_key", models.CharField(help_text="relative_path 的小写形式，用于唯一约束。", max_length=1024, verbose_name="去重键")),
                ("filename", models.CharField(blank=True, default="", max_length=255)),
                (
                    "source_kind",
                    models.CharField(
                        choices=[
                            ("local_file", "local_file 产物卡"),
                            ("tool_mutation", "write/edit 工具产物"),
                            ("shell_history", "终端 file_history"),
                            ("resource_link", "tabtin://resource/file/ 链接"),
                            ("code_ref", "用户代码引用"),
                        ],
                        max_length=32,
                    ),
                ),
                ("source_block_index", models.IntegerField(blank=True, null=True)),
                ("file_type", models.CharField(blank=True, default="", max_length=64)),
                ("mime_type", models.CharField(blank=True, default="", max_length=128)),
                ("file_size", models.BigIntegerField(blank=True, null=True)),
                ("is_active", models.BooleanField(db_index=True, default=True)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("deactivated_at", models.DateTimeField(blank=True, null=True)),
                (
                    "session",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="workspace_file_refs",
                        to="conversation.chatsession",
                        verbose_name="所属会话",
                    ),
                ),
                (
                    "source_message",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="+",
                        to="conversation.chatmessage",
                    ),
                ),
            ],
            options={
                "verbose_name": "会话工作区文件引用",
                "verbose_name_plural": "会话工作区文件引用",
                "db_table": "chat_session_workspace_file_ref",
            },
        ),
        migrations.CreateModel(
            name="SessionWorkspaceFileSnapshot",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("content_version", models.CharField(max_length=128)),
                ("object_key", models.CharField(blank=True, default="", max_length=512)),
                ("size_bytes", models.BigIntegerField(blank=True, null=True)),
                ("mime_type", models.CharField(blank=True, default="", max_length=128)),
                ("preview_kind", models.CharField(blank=True, default="", max_length=32)),
                (
                    "status",
                    models.CharField(
                        choices=[
                            ("pending", "物化中"),
                            ("ready", "就绪"),
                            ("failed", "失败"),
                            ("revoked", "已撤销"),
                            ("expired", "已过期"),
                        ],
                        default="pending",
                        max_length=16,
                    ),
                ),
                ("error_code", models.CharField(blank=True, default="", max_length=64)),
                ("error_message", models.CharField(blank=True, default="", max_length=512)),
                ("expires_at", models.DateTimeField(blank=True, db_index=True, null=True)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("ready_at", models.DateTimeField(blank=True, null=True)),
                (
                    "reference",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="snapshots",
                        to="conversation.sessionworkspacefilereference",
                    ),
                ),
                (
                    "session",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="workspace_file_snapshots",
                        to="conversation.chatsession",
                    ),
                ),
            ],
            options={
                "verbose_name": "会话工作区文件快照",
                "verbose_name_plural": "会话工作区文件快照",
                "db_table": "chat_session_workspace_file_snapshot",
            },
        ),
        migrations.AddConstraint(
            model_name="sessionworkspacefilereference",
            constraint=models.UniqueConstraint(
                fields=("session", "path_key"),
                name="uq_session_workspace_file_ref",
            ),
        ),
        migrations.AddIndex(
            model_name="sessionworkspacefilereference",
            index=models.Index(
                fields=["session", "is_active"],
                name="chat_swfr_session_active_idx",
            ),
        ),
        migrations.AddConstraint(
            model_name="sessionworkspacefilesnapshot",
            constraint=models.UniqueConstraint(
                fields=("reference", "content_version"),
                name="uq_session_workspace_file_snapshot",
            ),
        ),
        migrations.AddIndex(
            model_name="sessionworkspacefilesnapshot",
            index=models.Index(
                fields=["session", "status"],
                name="chat_swfs_session_status_idx",
            ),
        ),
    ]
