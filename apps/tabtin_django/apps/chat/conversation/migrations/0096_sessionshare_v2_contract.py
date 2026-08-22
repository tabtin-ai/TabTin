import uuid

import django.db.models.deletion
import django.utils.timezone
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("conversation", "0093_chatmessagewithdrawevent"),
    ]

    operations = [
        migrations.CreateModel(
            name="SessionContinuation",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=uuid.uuid4,
                        primary_key=True,
                        serialize=False,
                        editable=False,
                    ),
                ),
                ("organization_id", models.CharField(db_index=True, max_length=100)),
                ("source_session_id", models.UUIDField()),
                ("sender_user_id", models.CharField(db_index=True, max_length=100)),
                ("recipient_user_id", models.CharField(db_index=True, max_length=100)),
                (
                    "title_snapshot",
                    models.CharField(blank=True, default="", max_length=255),
                ),
                (
                    "snapshot_schema_version",
                    models.PositiveSmallIntegerField(default=1),
                ),
                ("frozen_context_json", models.JSONField(default=list)),
                ("snapshot_turn_count", models.PositiveIntegerField(default=0)),
                (
                    "context_status",
                    models.CharField(
                        choices=[
                            ("complete", "完整"),
                            ("truncated", "已截断"),
                            ("empty", "空上下文"),
                        ],
                        default="complete",
                        max_length=16,
                    ),
                ),
                ("resources_json", models.JSONField(default=list)),
                ("resource_status", models.CharField(default="none", max_length=16)),
                (
                    "delivery_status",
                    models.CharField(
                        choices=[
                            ("pending", "待确认"),
                            ("confirmed", "已确认"),
                            ("unconfirmed", "未确认"),
                            ("rejected", "已拒绝"),
                        ],
                        default="pending",
                        max_length=16,
                    ),
                ),
                (
                    "creation_status",
                    models.CharField(
                        choices=[
                            ("available", "可创建"),
                            ("failed", "创建失败"),
                            ("created", "已创建"),
                        ],
                        default="available",
                        max_length=16,
                    ),
                ),
                ("version", models.PositiveBigIntegerField(default=1)),
                ("client_request_id", models.UUIDField(unique=True)),
                (
                    "card_conversation_id",
                    models.CharField(blank=True, default="", max_length=100),
                ),
                ("card_message_ref", models.UUIDField(unique=True)),
                (
                    "card_message_sequence",
                    models.BigIntegerField(blank=True, null=True),
                ),
                (
                    "materialize_request_id",
                    models.UUIDField(blank=True, null=True, unique=True),
                ),
                ("target_agent_id", models.UUIDField(blank=True, null=True)),
                ("target_workspace_id", models.UUIDField(blank=True, null=True)),
                (
                    "linked_session_id",
                    models.UUIDField(blank=True, null=True, unique=True),
                ),
                (
                    "last_error_code",
                    models.CharField(blank=True, default="", max_length=64),
                ),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("delivered_at", models.DateTimeField(blank=True, null=True)),
                ("materialized_at", models.DateTimeField(blank=True, null=True)),
            ],
            options={
                "db_table": "chat_session_continuation",
                "ordering": ["-created_at"],
            },
        ),
        migrations.CreateModel(
            name="SessionContinuationEvent",
            fields=[
                ("id", models.BigAutoField(primary_key=True, serialize=False)),
                (
                    "actor_user_id",
                    models.CharField(blank=True, default="", max_length=100),
                ),
                ("event_type", models.CharField(max_length=32)),
                ("payload_json", models.JSONField(blank=True, default=dict)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                (
                    "continuation",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="events",
                        to="conversation.sessioncontinuation",
                    ),
                ),
            ],
            options={"db_table": "chat_session_continuation_event"},
        ),
        migrations.AddConstraint(
            model_name="sessioncontinuation",
            constraint=models.CheckConstraint(
                check=~models.Q(
                    sender_user_id=models.F("recipient_user_id"),
                ),
                name="chat_cont_sender_ne_recipient",
            ),
        ),
        migrations.AddIndex(
            model_name="sessioncontinuationevent",
            index=models.Index(
                fields=["continuation", "-created_at"], name="chat_cont_evt_cont_idx"
            ),
        ),
        migrations.AlterField(
            model_name="sessionshare",
            name="status",
            field=models.CharField(
                choices=[
                    ("pending", "投递中"),
                    ("active", "生效中"),
                    ("revoked", "已撤销"),
                ],
                default="active",
                max_length=16,
                verbose_name="共享状态",
            ),
        ),
        migrations.AddField(
            model_name="sessionshare",
            name="card_contract",
            field=models.CharField(
                choices=[
                    ("session_share", "历史共享卡"),
                    ("session_share_v2", "共享卡 v2"),
                ],
                default="session_share",
                max_length=32,
                verbose_name="卡片契约",
            ),
        ),
        migrations.AddField(
            model_name="sessionshare",
            name="card_schema_version",
            field=models.PositiveSmallIntegerField(
                default=1, verbose_name="卡片结构版本"
            ),
        ),
        migrations.AddField(
            model_name="sessionshare",
            name="version",
            field=models.PositiveBigIntegerField(default=1, verbose_name="对象版本"),
        ),
        migrations.AddField(
            model_name="sessionshare",
            name="access_epoch",
            field=models.PositiveBigIntegerField(
                default=1,
                help_text="停止、恢复或资格失效时递增，使旧实时订阅立即失效。",
                verbose_name="访问纪元",
            ),
        ),
        migrations.AddField(
            model_name="sessionshare",
            name="delivery_status",
            field=models.CharField(
                choices=[
                    ("pending", "待确认"),
                    ("confirmed", "已确认"),
                    ("unconfirmed", "未确认"),
                    ("rejected", "已拒绝"),
                ],
                default="confirmed",
                max_length=16,
                verbose_name="卡片投递状态",
            ),
        ),
        migrations.AddField(
            model_name="sessionshare",
            name="eligibility_status",
            field=models.CharField(
                choices=[("eligible", "有效"), ("ineligible", "资格失效")],
                default="eligible",
                max_length=16,
                verbose_name="共享资格状态",
            ),
        ),
        migrations.AddField(
            model_name="sessionshare",
            name="ineligibility_reason",
            field=models.CharField(
                blank=True,
                default="",
                max_length=64,
                verbose_name="资格失效原因",
            ),
        ),
        migrations.AddField(
            model_name="sessionshare",
            name="updated_at",
            field=models.DateTimeField(
                auto_now=True,
                default=django.utils.timezone.now,
                verbose_name="更新时间",
            ),
            preserve_default=False,
        ),
    ]
