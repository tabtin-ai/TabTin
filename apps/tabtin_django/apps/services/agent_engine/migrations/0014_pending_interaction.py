"""
通用 PendingInteraction 事实源。

Agent 等用户处理的事项不能只存在实时 stream 里。本表承载可查询、可恢复、
可过期、可跨端收敛的 pending 用户交互；审批只是第一批接入的 kind。
"""

import uuid

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("agent_engine", "0013_resource_open_event"),
    ]

    operations = [
        migrations.CreateModel(
            name="PendingInteraction",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=uuid.uuid4,
                        editable=False,
                        primary_key=True,
                        serialize=False,
                    ),
                ),
                (
                    "kind",
                    models.CharField(
                        choices=[
                            ("tool_approval", "Tool Approval"),
                            ("ask_choice", "Ask Choice"),
                            ("ask_form", "Ask Form"),
                            ("permission_request", "Permission Request"),
                            ("browser_action_approval", "Browser Action Approval"),
                        ],
                        db_index=True,
                        max_length=48,
                    ),
                ),
                (
                    "status",
                    models.CharField(
                        choices=[
                            ("pending", "Pending"),
                            ("resolved", "Resolved"),
                            ("expired", "Expired"),
                            ("cancelled", "Cancelled"),
                        ],
                        db_index=True,
                        default="pending",
                        max_length=24,
                    ),
                ),
                (
                    "thread_id",
                    models.CharField(
                        db_index=True,
                        help_text="会话 thread_id（chat-session-{uuid}）",
                        max_length=128,
                    ),
                ),
                (
                    "session_id",
                    models.UUIDField(
                        blank=True,
                        db_index=True,
                        help_text="ChatSession.id；可为空以兼容还未解析到会话的历史事件",
                        null=True,
                    ),
                ),
                ("workteam_id", models.CharField(db_index=True, max_length=100)),
                ("user_id", models.UUIDField(db_index=True)),
                (
                    "request_key",
                    models.CharField(
                        db_index=True,
                        help_text="通用请求键：approval batch_id / ask request_id 等；允许非 UUID",
                        max_length=160,
                    ),
                ),
                (
                    "source",
                    models.CharField(
                        choices=[
                            ("agent_stream", "Agent Stream"),
                            ("agent_action", "Agent Action"),
                            ("runtime", "Runtime"),
                        ],
                        db_index=True,
                        max_length=32,
                    ),
                ),
                (
                    "source_device_fingerprint",
                    models.CharField(blank=True, default="", max_length=255),
                ),
                ("payload", models.JSONField(blank=True, default=dict)),
                ("result", models.JSONField(blank=True, default=dict)),
                ("expires_at", models.DateTimeField(blank=True, db_index=True, null=True)),
                ("resolved_at", models.DateTimeField(blank=True, null=True)),
                ("created_at", models.DateTimeField(auto_now_add=True, db_index=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
            ],
            options={
                "verbose_name": "待处理用户交互",
                "verbose_name_plural": "待处理用户交互",
                "db_table": "agent_engine_pending_interactions",
                "indexes": [
                    models.Index(
                        fields=["user_id", "status", "expires_at"],
                        name="idx_pi_user_status_exp",
                    ),
                    models.Index(
                        fields=["thread_id", "status", "created_at"],
                        name="idx_pi_thread_status_time",
                    ),
                    models.Index(
                        fields=["workteam_id", "status", "created_at"],
                        name="idx_pi_workteam_status_time",
                    ),
                ],
                "constraints": [
                    models.UniqueConstraint(
                        fields=["kind", "thread_id", "request_key"],
                        name="uq_pi_kind_thread_key",
                    ),
                ],
            },
        ),
    ]
