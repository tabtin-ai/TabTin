from django.db import migrations, models
import django.db.models.deletion
import uuid


class Migration(migrations.Migration):
    initial = True

    dependencies = [
        ("agent", "0002_restore_agent_indexes"),
    ]

    operations = [
        migrations.CreateModel(
            name="AgentMemory",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("organization_id", models.UUIDField(db_index=True, verbose_name="所属组织")),
                ("owner_id", models.UUIDField(blank=True, db_index=True, help_text="蒸馏输入来自该用户的交互；召回/合并按 (agent, owner) 隔离。", null=True, verbose_name="记忆涉及的用户")),
                ("content_json", models.JSONField(blank=True, default=dict, verbose_name="ProseMirror JSON")),
                ("content_plaintext", models.TextField(blank=True, default="", help_text="用于去重（Jaccard）、列表预览与关键字检索", verbose_name="纯文本")),
                ("content_markdown", models.TextField(blank=True, default="", help_text="记忆注入 / Agent 读取用", verbose_name="Markdown 副本")),
                (
                    "memo_type",
                    models.CharField(
                        choices=[
                            ("about_you", "关于你"),
                            ("insight", "洞察"),
                            ("task_summary", "任务摘要"),
                            ("diary", "工作日记"),
                        ],
                        db_index=True,
                        help_text="about_you/insight/task_summary/diary",
                        max_length=30,
                        verbose_name="记忆类型",
                    ),
                ),
                ("title", models.CharField(blank=True, default="", help_text="日记（diary）等面向用户展示的记忆行标题；蒸馏三型为空。", max_length=255, verbose_name="标题")),
                ("importance", models.PositiveSmallIntegerField(blank=True, help_text="重要程度 1-5，importance_adjust 动态调整", null=True, verbose_name="重要性")),
                ("access_count", models.PositiveIntegerField(default=0, help_text="召回命中次数，用于 importance 动态调整和过期归档判断", verbose_name="访问计数")),
                ("tags", models.JSONField(blank=True, default=list, verbose_name="标签")),
                ("ai_tags", models.JSONField(blank=True, default=list, help_text='蒸馏附带的结构化标记，如 ["emotion:neutral"]', verbose_name="AI 标签")),
                ("source_url", models.URLField(blank=True, default="", help_text="溯源标识（thread://<thread_id> 等）", max_length=2048, verbose_name="来源")),
                (
                    "status",
                    models.CharField(
                        choices=[("active", "活跃"), ("archived", "已归档")],
                        db_index=True,
                        default="active",
                        max_length=20,
                        verbose_name="状态",
                    ),
                ),
                ("forgotten_at", models.DateTimeField(blank=True, help_text="非空表示用户已要求忘记；所有默认读取必须排除此类记录。", null=True, verbose_name="忘记时间")),
                (
                    "agent",
                    models.ForeignKey(
                        db_column="agent_id",
                        help_text="记忆归属的 Agent（会话直挂执行分身优先，workspace 1:1 回退）。",
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="memories",
                        to="agent.agent",
                        verbose_name="所属 Agent",
                    ),
                ),
                (
                    "supersedes",
                    models.ForeignKey(
                        blank=True,
                        help_text="修正操作新建替代记录并归档原记录；该字段保留修订来源。",
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="revisions",
                        to="agent_memory.agentmemory",
                        verbose_name="被修正的记忆",
                    ),
                ),
            ],
            options={
                "verbose_name": "Agent 记忆",
                "verbose_name_plural": "Agent 记忆",
                "db_table": "agent_memory_entry",
                "ordering": ["-created_at"],
                "indexes": [
                    models.Index(fields=["agent", "memo_type", "status"], name="agent_memory_type_status_idx"),
                    models.Index(fields=["agent", "owner_id", "status", "-created_at"], name="agent_memory_owner_idx"),
                    models.Index(fields=["organization_id", "status"], name="agent_memory_org_status_idx"),
                ],
            },
        ),
        migrations.AddConstraint(
            model_name="agentmemory",
            constraint=models.CheckConstraint(
                check=(
                    models.Q(importance__isnull=True)
                    | models.Q(importance__gte=1, importance__lte=5)
                ),
                name="agent_memory_importance_range",
            ),
        ),
    ]
