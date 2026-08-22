"""
PRD 05 v0.4 §7.7 — 审批审计 PermissionAudit 表（PG，agent_engine app_label）。

W2-轮 1：每条审批决议（含 hardline 拦截 /
规则拦 / Layer 4 memoization 命中 / classifier 兜底 / 用户批拒 / rollback cancel
等）写一行；同 batch 内 N 条 ActionRequest 共享 batch_id，AdminDash 回放可按
agent_id / thread_id / batch_id / workteam_id / decision 多维聚合。

双库迁移强约束（AGENTS.md 顶层）：必须走 ``bash scripts/backend/migrate-all.sh``；裸跑
``python manage.py migrate`` 不带 ``--database=postgresql`` 不会真执行 PG DDL。
"""

import uuid

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("agent_engine", "0007_prd06_subtaskrun_notification_fields"),
    ]

    operations = [
        migrations.CreateModel(
            name="PermissionAudit",
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
                ("workteam_id", models.UUIDField(db_index=True, help_text="所属 Workteam")),
                ("agent_id", models.UUIDField(db_index=True, help_text="决议关联的 Agent")),
                (
                    "thread_id",
                    models.CharField(
                        db_index=True,
                        help_text="会话 thread_id（chat-session-{uuid} 等）",
                        max_length=128,
                    ),
                ),
                (
                    "session_id",
                    models.UUIDField(
                        db_index=True,
                        help_text="ChatSession.id；与 thread_id 双索引便于跨索引回查",
                    ),
                ),
                (
                    "batch_id",
                    models.UUIDField(
                        db_index=True,
                        help_text=(
                            "同批 N 行共享 batch_id；单工具 N=1 退化时仍写非空 UUID。"
                            "rollback / 后台过期清理等非批量审计行允许 null。"
                        ),
                        null=True,
                    ),
                ),
                (
                    "request_id",
                    models.UUIDField(
                        db_index=True,
                        help_text="单条 ActionRequest 的 request_id（行级 audit / resume key）",
                    ),
                ),
                (
                    "tool_call_id",
                    models.CharField(
                        help_text="LLM tool_use_id（决策回灌索引键）",
                        max_length=128,
                    ),
                ),
                ("tool_name", models.CharField(max_length=128)),
                ("tool_namespace", models.CharField(blank=True, default="", max_length=128)),
                (
                    "tool_input_preview",
                    models.TextField(
                        help_text=(
                            "LocalPermissionHandler.SUMMARY_MAX (2000) 截断后的 input 摘要"
                        ),
                    ),
                ),
                (
                    "decision",
                    models.CharField(
                        choices=[
                            ("allow", "Allow"),
                            ("deny", "Deny"),
                            ("cancelled", "Cancelled"),
                            ("expired", "Expired"),
                            ("cancelled_by_rollback", "Cancelled By Rollback"),
                        ],
                        help_text="allow / deny / cancelled / expired / cancelled_by_rollback",
                        max_length=24,
                    ),
                ),
                (
                    "source",
                    models.CharField(
                        choices=[
                            ("plan_guard", "Plan Guard"),
                            ("hardline", "Hardline"),
                            ("rule", "Rule"),
                            ("memoization", "Memoization"),
                            ("classifier", "Classifier"),
                            ("user_interactive", "User Interactive"),
                            ("skill_trust", "Skill Trust"),
                            ("rollback", "Rollback"),
                        ],
                        help_text=(
                            "判决来源 Layer：plan_guard / hardline / rule / memoization "
                            "/ classifier / user_interactive / skill_trust / rollback"
                        ),
                        max_length=32,
                    ),
                ),
                (
                    "reason",
                    models.JSONField(
                        default=dict,
                        help_text="DecisionReason 19-tag discriminated union（PRD §8.4）",
                    ),
                ),
                (
                    "scope",
                    models.CharField(
                        blank=True,
                        choices=[
                            ("once", "Once"),
                            ("thread", "Thread"),
                            ("always", "Always"),
                        ],
                        default="",
                        help_text="用户决策的 scope；非 user_interactive source 留空字符串",
                        max_length=16,
                    ),
                ),
                ("approver_user_id", models.UUIDField(blank=True, null=True)),
                (
                    "approver_client_info",
                    models.CharField(
                        blank=True,
                        default="",
                        help_text="例：'Electron 0.12.3 on macOS 14.2' / 'iOS 1.0 build 42'",
                        max_length=256,
                    ),
                ),
                (
                    "runtime_mode",
                    models.CharField(
                        choices=[
                            ("interactive", "Interactive"),
                            ("solo", "Solo"),
                            ("scheduled", "Scheduled"),
                            ("batch", "Batch"),
                        ],
                        help_text="interactive / solo / scheduled / batch（PRD §1.2）",
                        max_length=16,
                    ),
                ),
                (
                    "skill_context",
                    models.JSONField(
                        blank=True,
                        help_text=(
                            "Skill 触发时的上下文 { skill_id, source, permissions_approved }"
                        ),
                        null=True,
                    ),
                ),
                (
                    "rejection_message",
                    models.TextField(
                        blank=True,
                        default="",
                        help_text="用户拒绝时填的理由（来自 ApprovalDecision.rejection_message）",
                    ),
                ),
                (
                    "created_at",
                    models.DateTimeField(auto_now_add=True, db_index=True),
                ),
            ],
            options={
                "verbose_name": "审批审计记录",
                "verbose_name_plural": "审批审计记录",
                "db_table": "agent_engine_permission_audit",
            },
        ),
        migrations.AddIndex(
            model_name="permissionaudit",
            index=models.Index(
                fields=["agent_id", "-created_at"],
                name="idx_permaudit_agent_time",
            ),
        ),
        migrations.AddIndex(
            model_name="permissionaudit",
            index=models.Index(
                fields=["thread_id", "-created_at"],
                name="idx_permaudit_thread_time",
            ),
        ),
        migrations.AddIndex(
            model_name="permissionaudit",
            index=models.Index(
                condition=models.Q(("batch_id__isnull", False)),
                fields=["batch_id"],
                name="idx_permaudit_batch",
            ),
        ),
        migrations.AddIndex(
            model_name="permissionaudit",
            index=models.Index(
                fields=["workteam_id", "-created_at"],
                name="idx_permaudit_workteam_time",
            ),
        ),
        migrations.AddIndex(
            model_name="permissionaudit",
            index=models.Index(
                fields=["decision", "-created_at"],
                name="idx_permaudit_decision_time",
            ),
        ),
    ]
