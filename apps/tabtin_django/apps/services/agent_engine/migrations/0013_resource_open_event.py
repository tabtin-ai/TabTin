"""
专题"Agent 产物在 Space 内的打开" Wave 2 — ResourceOpenEvent 埋点表（PG，agent_engine app_label）。

业务目标（PRD §6 标准 1/2/3 + RFC v1.0 §8）：让上线 14 天后能用 SQL 跑出
  - 可见率：所有 trigger_source 的 outcome 分布
  - 异常 deny = 0 守门
  - resolve_source 5 层 + ⌘ 短路 6 个 tag 的分布

上报通路（W7 接通；W2 只落表）：
  renderer ResourceRouter.emitEvent → IPC → main 进程 telemetry queue
  → HTTP POST /api/services/telemetry/resource_open/batch
  → Django bulk_create 到 agent_engine_resource_open_event

双库迁移强约束（AGENTS.md 顶层）：必须走 ``bash scripts/backend/migrate-all.sh``；
裸跑 ``python manage.py migrate`` 不带 ``--database=postgresql`` 不会真执行 PG DDL。

NOTE: 本 migration 故意只含 ResourceOpenEvent CreateModel——不顺手做
``cliauditevent.inner_binary`` 的 help_text 漂移修复，那是其他 Wave 的待
提交项（见 0009_permission_audit_unique_request_id.py 注释里"existing
0009_alter_cliauditevent_inner_binary"）。W2 严格守 "不许只新增不收敛 ≠
顺手帮别人做事" 边界——别的 Wave 提交时再走 makemigrations 自然 alter。
"""

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("agent_engine", "0012_truncate_conversation_state_for_w3"),
    ]

    operations = [
        migrations.CreateModel(
            name="ResourceOpenEvent",
            fields=[
                (
                    "id",
                    models.BigAutoField(primary_key=True, serialize=False),
                ),
                (
                    "event_name",
                    models.CharField(
                        help_text=(
                            "resource_open.triggered / resource_open.resolved / "
                            "resource_open.failed"
                        ),
                        max_length=64,
                    ),
                ),
                (
                    "trigger_source",
                    models.CharField(
                        help_text=(
                            "chat_markdown / open_in_space_tool / rich_resource_card / "
                            "user_paste / window_open_fallback"
                        ),
                        max_length=32,
                    ),
                ),
                (
                    "pointer_scheme",
                    models.CharField(
                        help_text="tabtin / http / https / file / mailto / tel / 其他",
                        max_length=32,
                    ),
                ),
                (
                    "pointer_type",
                    models.CharField(
                        blank=True,
                        help_text="自有格式 ContextRefType；行业格式 NULL",
                        max_length=64,
                        null=True,
                    ),
                ),
                (
                    "pointer_id_hash",
                    models.CharField(
                        help_text=(
                            "16 hex 字符不可逆同步 hash（djb2 + FNV-1a 双轨；非 SHA256 —— "
                            "SubtleCrypto.digest 是 async 与 router emit 同步语义不兼容）。"
                            "隐私目标：避免泄露明文 url 路径 / 业务 ID；统计聚合用 "
                            "pointer_scheme + pointer_type 维度即可，不需要原文"
                        ),
                        max_length=16,
                    ),
                ),
                ("hint_app_id", models.CharField(blank=True, max_length=64, null=True)),
                (
                    "resolved_carrier_app_id",
                    models.CharField(blank=True, max_length=64, null=True),
                ),
                (
                    "resolve_source",
                    models.CharField(
                        help_text=(
                            "user_pref / session_override / agent_hint / "
                            "manifest_default / system_fallback / modifier_key"
                        ),
                        max_length=32,
                    ),
                ),
                (
                    "outcome",
                    models.CharField(
                        help_text=(
                            "in_space_opened / system_app_opened / denied_known_bad / error"
                        ),
                        max_length=32,
                    ),
                ),
                ("space_id", models.UUIDField(db_index=True)),
                ("user_id", models.UUIDField(db_index=True)),
                ("workteam_id", models.UUIDField(db_index=True)),
                ("agent_run_id", models.UUIDField(blank=True, null=True)),
                ("message_id", models.UUIDField(blank=True, null=True)),
                ("tool_call_id", models.CharField(blank=True, max_length=128, null=True)),
                ("duration_ms", models.IntegerField(default=0)),
                (
                    "ts",
                    models.DateTimeField(
                        db_index=True,
                        help_text="客户端事件发生时间（ms epoch 转换为 UTC datetime）",
                    ),
                ),
                ("error_message", models.TextField(blank=True, null=True)),
                (
                    "client",
                    models.CharField(
                        default="electron",
                        help_text="electron / daemon / ios / android",
                        max_length=16,
                    ),
                ),
                ("client_version", models.CharField(default="", max_length=32)),
                (
                    "created_at",
                    models.DateTimeField(
                        auto_now_add=True,
                        db_index=True,
                        help_text="服务端落表时间，便于排查上报延迟",
                    ),
                ),
            ],
            options={
                "db_table": "agent_engine_resource_open_event",
                "indexes": [
                    models.Index(
                        fields=["ts", "outcome"], name="idx_aeroe_ts_outcome"
                    ),
                    models.Index(
                        fields=["workteam_id", "ts"], name="idx_aeroe_workteam_ts"
                    ),
                    models.Index(
                        fields=["outcome", "ts"], name="idx_aeroe_outcome_ts"
                    ),
                    models.Index(
                        fields=["trigger_source", "ts"], name="idx_aeroe_trigger_ts"
                    ),
                ],
            },
        ),
    ]
