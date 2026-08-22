"""创建 ``cli_audit_event`` 表（PRD-v3 §5.1 第 5 项 + N10 决策）。

落地 CLI 治理层审计事件的 PostgreSQL 持久化。每次 ``CliInvocationSpec`` 经
PermissionRule 通过 / HITL 拒绝 / 实际 fork 完成后，由 ``cli/audit.py`` 写一条记录。

字段总览：
- 主键 ``id``：UUID
- **跨库软引用**（UUIDField + db_constraint=False，**不**用 ForeignKey）：
  ``thread_id`` / ``agent_id`` / ``user_id`` / ``hitl_decided_by``。
  原因：PG 的 ``cli_audit_event`` 表 join 不到 MySQL 的 ``conversation`` /
  ``users_auth``，跨库 FK 既不能走数据库强约束又会让人误用 ``select_related``。
- **顶层提级**（含 index，N10）：``binary`` / ``inner_binary`` / ``risk_level``
  AdminDash 审计页主 SQL 直接 ``WHERE binary IN (...)`` 走 index，无需 JSONB 解析。
- **spec_json**：``CliInvocationSpec.to_dict()`` 全文（保留 ``matched_rule_pattern`` /
  ``matched_rule_reason`` 便于审计反查"为什么是这个 risk"）；写入前由 ``audit.py``
  按 risk_level 二次脱敏 ``raw_args``（A1-L2 三档 PII 升级）。
- HITL 字段：``hitl_required`` / ``hitl_user_decision`` / ``hitl_decided_by`` /
  ``hitl_decided_at``，A4 启动包接入 UI 时由 ``update_hitl_decision`` 回填。
- 执行结果字段：``executed_at`` / ``finished_at`` / ``exit_code``，A5 启动包接入
  CLI fork 完成 hook 后回填；A2 默认 NULL。
- ``bypass``：默认 False，N18 / H2-9 预留；标记第三方 CLI shim 主动上报 / shell 直跑
  被审计接管的"绕过路径"。
- ``created_at``：``auto_now_add`` + index，便于按时间窗查询。

复合 index（PRD §5.1 第 5 项验收必查）：
- ``(binary, risk_level)`` — AdminDash 审计页过滤主路径
- ``(user_id, created_at)`` — 用户维度审计时间线
- ``(thread_id, created_at)`` — 对话维度审计时间线

迁移命令（PRD §AGENTS.md PG 强制要求）：

    cd apps/tabtin_django && source venv/bin/activate
    DJANGO_SETTINGS_MODULE=tabtin.settings \\
        python manage.py migrate agent_engine --database=postgresql

`agent_engine` 已在 ``DefaultDatabaseRouter._pg_app_labels`` whitelist
（``apps/services/common/db_router.py:69-77``）+ ``AgentEngineRouter``
（``apps/services/agent_engine/db_router.py``）双重保障，故 model 自动路由 PG。
"""

from __future__ import annotations

import uuid

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("agent_engine", "0001_initial"),
    ]

    operations = [
        migrations.CreateModel(
            name="CliAuditEvent",
            fields=[
                # ── 主键 ────────────────────────────────────────────
                (
                    "id",
                    models.UUIDField(
                        primary_key=True,
                        default=uuid.uuid4,
                        editable=False,
                        serialize=False,
                        help_text="审计事件主键（UUID）",
                    ),
                ),
                # ── 跨库软引用（UUIDField + db_constraint=False）────
                (
                    "thread_id",
                    models.UUIDField(
                        null=True,
                        blank=True,
                        db_index=True,
                        help_text=(
                            "对话线程 ID（跨库软引用 conversation.Thread.id，"
                            "MySQL 表，绝禁 JOIN）"
                        ),
                    ),
                ),
                (
                    "agent_id",
                    models.UUIDField(
                        null=True,
                        blank=True,
                        db_index=True,
                        help_text=(
                            "发起调用的 Agent ID（跨库软引用 agent_engine.Agent.id；"
                            "当前同库但保持 UUID 软引用风格便于未来拆分）"
                        ),
                    ),
                ),
                (
                    "user_id",
                    models.UUIDField(
                        null=True,
                        blank=True,
                        # user_id 单独 index 由复合 (user_id, created_at)
                        # 覆盖前缀，无需重复添加单列 index
                        help_text=(
                            "实际用户 ID（跨库软引用 users_auth.User.id，MySQL 表）"
                        ),
                    ),
                ),
                # ── 顶层提级（N10 决策，含 index）──────────────────
                (
                    "binary",
                    models.CharField(
                        max_length=64,
                        db_index=True,
                        help_text=(
                            "用户调用入口可执行（如 'tabtin' 或第三方 CLI），"
                            "AdminDash 主审计 SQL `WHERE binary IN (...)` 走该 index"
                        ),
                    ),
                ),
                (
                    "inner_binary",
                    models.CharField(
                        max_length=64,
                        null=True,
                        blank=True,
                        help_text=(
                            "fork 子进程实际 binary（顶层入口与子进程 binary 不同的场景）；"
                            "非 fork 场景为 NULL；K7 决策"
                        ),
                    ),
                ),
                (
                    "risk_level",
                    models.CharField(
                        max_length=16,
                        db_index=True,
                        help_text=(
                            "safe / review / strict（与 capabilities.RiskLevel "
                            "三档对齐，K8 决策）"
                        ),
                    ),
                ),
                # ── spec 完整序列化 ────────────────────────────────
                (
                    "spec_json",
                    models.JSONField(
                        default=dict,
                        help_text=(
                            "CliInvocationSpec.to_dict() 完整序列化（含 "
                            "matched_rule_pattern / matched_rule_reason 便于审计反查 "
                            "'为什么是这个 risk'）；写入前由 audit.py 按 risk_level "
                            "二次脱敏 raw_args（A1-L2 升级）"
                        ),
                    ),
                ),
                # ── PermissionRule 决策 ──────────────────────────────
                (
                    "rule_decision",
                    models.CharField(
                        max_length=16,
                        help_text="PermissionRuleEngine 输出：allow / review / deny",
                    ),
                ),
                (
                    "hitl_required",
                    models.BooleanField(
                        default=False,
                        help_text="是否触发 HITL 二次确认（risk_level=review 时通常为 True）",
                    ),
                ),
                # ── HITL 决策回填（A4 启动包接入）────────────────────
                (
                    "hitl_user_decision",
                    models.CharField(
                        max_length=16,
                        null=True,
                        blank=True,
                        help_text=(
                            "用户实际选择：allow / deny；review 路径完成后必填"
                        ),
                    ),
                ),
                (
                    "hitl_decided_by",
                    models.UUIDField(
                        null=True,
                        blank=True,
                        help_text="HITL 决策的用户 ID（跨库软引用 users_auth.User.id）",
                    ),
                ),
                (
                    "hitl_decided_at",
                    models.DateTimeField(
                        null=True,
                        blank=True,
                        help_text=(
                            "HITL 决策时间（用于 cli_audit.hitl_pending_seconds metric）"
                        ),
                    ),
                ),
                # ── 执行结果回填（A5 启动包接入）─────────────────────
                (
                    "executed_at",
                    models.DateTimeField(
                        null=True,
                        blank=True,
                        help_text="实际 fork 子进程开始时间（HITL allow 后）",
                    ),
                ),
                (
                    "finished_at",
                    models.DateTimeField(
                        null=True,
                        blank=True,
                        help_text="子进程结束时间（exit 后回填）",
                    ),
                ),
                (
                    "exit_code",
                    models.IntegerField(
                        null=True,
                        blank=True,
                        help_text="子进程退出码；deny / 未执行时为 NULL",
                    ),
                ),
                # ── 绕过路径标记（N18 / H2-9 预留）───────────────────
                (
                    "bypass",
                    models.BooleanField(
                        default=False,
                        help_text=(
                            "是否走绕过路径（第三方 CLI shim 主动上报 / "
                            "shell 直跑被审计接管）；默认 False，N18 决策"
                        ),
                    ),
                ),
                # ── 时间戳 ─────────────────────────────────────────
                (
                    "created_at",
                    models.DateTimeField(
                        auto_now_add=True,
                        db_index=True,
                        help_text="审计事件落库时间（含 index 便于按时间窗查询）",
                    ),
                ),
            ],
            options={
                "db_table": "cli_audit_event",
                # 复合 index（PRD §5.1 第 5 项验收必查）
                "indexes": [
                    # AdminDash 审计页过滤主路径：先按 binary 圈定调用入口，
                    # 再按 risk_level 分桶。配合顶层 binary/risk_level 各自的单列
                    # index，可同时支撑"按 binary 排序"和"按 (binary,risk) 过滤"。
                    models.Index(
                        fields=["binary", "risk_level"],
                        name="idx_cliaudit_bin_risk",
                    ),
                    # 用户维度审计时间线：admin "查看张三本周的 CLI 调用"
                    # 走 (user_id, created_at) 复合 index
                    models.Index(
                        fields=["user_id", "created_at"],
                        name="idx_cliaudit_user_created",
                    ),
                    # 对话维度审计时间线：点 thread 跳到所有 CLI 事件
                    models.Index(
                        fields=["thread_id", "created_at"],
                        name="idx_cliaudit_thread_created",
                    ),
                ],
            },
        ),
    ]
