"""``CliAuditEvent`` — CLI 调用审计事件（PRD-v3 §5.1 第 5 项 + N10 决策）。

每次 ``CliInvocationSpec`` 经 PermissionRule 通过 / HITL 拒绝 / 实际执行结束后，
落库一条 ``CliAuditEvent`` 记录，供：

- AdminDash CLI 审计页（Wave E-E3）
- ``cli_audit.risk_level_count`` / ``cli_audit.hitl_pending_seconds`` 等 metric 上报
- 合规追溯 / 治理对账 / 销售合规对话证据

字段设计要点（必读，区分顶层提级 vs spec_json 派生）：

- **顶层提级 + index**（PRD §5.1 第 5 项 N10 决策）：
  - ``binary``       — 用户调用入口（如 ``"tabtin"`` 或第三方 CLI 名）
  - ``inner_binary`` — fork 子进程实际 binary（wrapper 场景下的第三方 CLI 名）；非 fork 场景为 None
  - ``risk_level``   — ``safe`` / ``review`` / ``strict``，与 ``RegisteredTool.risk_level`` 三档对齐
  - 顶层化原因：① AdminDash SQL ``WHERE binary IN (...)`` 走 index；
                ② metric 上报无需 JSONB 解析；③ 跨表分析（与 RegisteredTool）便利

- **spec_json**：``CliInvocationSpec.to_dict()`` 完整序列化，保留全文便于审计反查
  （含 ``matched_rule_pattern`` / ``matched_rule_reason`` 让审计页能解释"为什么是这个 risk"）。
  写入前由 ``audit.py`` 根据 risk_level 二次脱敏 ``raw_args``（A1-L2 升级，三档 PII 策略）。

- **HITL 字段**：``hitl_required`` / ``hitl_user_decision`` / ``hitl_decided_by`` / ``hitl_decided_at``
  当 PermissionRule 输出 ``review`` 时 ``hitl_required=True``；用户决策后由
  ``update_hitl_decision`` 回填；A4 启动包将提供具体 UI 接入。

- **执行字段**：``executed_at`` / ``finished_at`` / ``exit_code`` 由 CLI 实际 fork 完成后回填
  （A5 启动包接入），A2 启动包默认 None 即可。

- **bypass**：默认 False，预留 N18 / H2-9 用，标记是否走绕过路径
  （未来第三方 CLI shim 主动上报 / shell 直跑被审计接管时为 True）。

- **跨库软引用**（thread_id / agent_id / user_id / hitl_decided_by）：
  全部 UUIDField + db_constraint=False，**严禁** ForeignKey（PRD §5.1 第 5 项 + 落地总控
  § 关键前提：跨库引用模式 = UUIDField 软引用，与 ``Skill.organization_id`` / Wave 1 之前的
  ``Package.organization_id`` 一致）。

- **复合 index**（验收必查）：
  - ``(binary, risk_level)`` — AdminDash 审计页过滤
  - ``(user_id, created_at)`` — 用户维度审计时间线
  - ``(thread_id, created_at)`` — 对话维度审计时间线

Wave 边界：
- A2 仅落 model + migration + 写入 helper；HITL UI / Agent system prompt / CLI fork 不在本启动包。
- 模型物理位置在 ``cli/models.py`` 是为了与 spec / parser / rules 同一目录内聚；
  通过显式 ``Meta.app_label='agent_engine'`` + ``agent_engine/models.py`` 末尾 import
  确保 Django app loader 能 discover（参见 ``agent_engine/models.py`` 末尾注释）。
"""

from __future__ import annotations

import uuid

from django.db import models


class CliAuditEvent(models.Model):
    """CLI 调用审计事件（PRD-v3 §5.1 第 5 项）。

    每次 CLI 调用通过 / 拒绝 / 执行完毕产生一条记录；写入入口见 ``cli/audit.py``。
    """

    # ─── 主键 ────────────────────────────────────────────────────────
    id = models.UUIDField(
        primary_key=True,
        default=uuid.uuid4,
        editable=False,
        help_text="审计事件主键（UUID）",
    )

    # ─── 跨库软引用（UUIDField + db_constraint=False，严禁 ForeignKey）──
    # 与 conversation / agent_engine.Agent / users_auth.User / tabtinspace.Organization
    # 跨库（MySQL ↔ PG），跨库 join 已被禁，因此用 UUIDField 软引用，
    # AdminDash 查询时按需多次查表组装。
    organization_id = models.UUIDField(
        null=True,
        blank=True,
        # 单列 index 由 (organization_id, created_at) 复合 index 覆盖前缀
        help_text=(
            "租户 ID（跨库软引用 tabtinspace.Organization.id）。"
            "PRD §5.5 「授权数据 PII 隔离」硬性要求：所有 admin 查询 API "
            "必须按 request.user.organization_id == row.organization_id 过滤，"
            "因此审计行必须含 organization_id 一等字段，避免 admin 通过 thread/user 反查跨库"
        ),
    )
    thread_id = models.UUIDField(
        null=True,
        blank=True,
        db_index=True,
        help_text="对话线程 ID（跨库软引用 conversation.Thread.id）",
    )
    agent_id = models.UUIDField(
        null=True,
        blank=True,
        db_index=True,
        help_text="发起调用的 Agent ID（跨库软引用 agent_engine.Agent.id）",
    )
    user_id = models.UUIDField(
        null=True,
        blank=True,
        # user_id 单独 index 由 (user_id, created_at) 复合 index 覆盖前缀
        help_text="实际用户 ID（跨库软引用 users_auth.User.id）",
    )

    # ─── 顶层提级字段（N10 + K7 决策，含 index）───────────────────────
    binary = models.CharField(
        max_length=64,
        db_index=True,
        help_text=(
            "用户调用入口可执行（K7：永远是用户最外层敲的 binary，如 'tabtin' / "
            "第三方 CLI 直跑场景）。AdminDash 主审计 SQL `WHERE binary IN (...)` 走该 index。"
            "通过 emit_cli_audit_event 的 entry_binary 参数显式传入；"
            "未传时 fallback 到 spec.binary"
        ),
    )
    inner_binary = models.CharField(
        max_length=64,
        null=True,
        blank=True,
        # P1 修复：加 db_index，让 AdminDash E3 能按 inner_binary 过滤
        # （落地总控 § E3 启动包 "binary/inner_binary/risk_level/hitl_user_decision 过滤"）
        db_index=True,
        help_text=(
            "fork 子进程实际 binary（顶层入口与子进程 binary 不同的场景，"
            "如 wrapper fork 第三方 CLI）；非 fork 场景为 NULL；K7 决策"
        ),
    )
    # ─── domain / verb 顶层提级（N10 延伸，避免审计统计走 JSONB 解析）─
    domain = models.CharField(
        max_length=64,
        db_index=True,
        help_text=(
            "spec.domain 顶层化（如 'im' / 'vc' / 'table'）。"
            "AdminDash 「按 domain 域统计」直接走 index，无需 spec_json->>'domain'"
        ),
    )
    verb = models.CharField(
        max_length=64,
        db_index=True,
        help_text=(
            "spec.verb 顶层化（如 'send' / 'delete' / 'create'）。"
            "AdminDash 「本周 delete 操作 TOP 10」走 index"
        ),
    )
    risk_level = models.CharField(
        max_length=16,
        db_index=True,
        help_text="safe / review / strict，与 RegisteredTool.risk_level 词表对齐（K8 决策）",
    )

    # ─── spec 完整序列化（CliInvocationSpec.to_dict 全文）─────────────
    spec_json = models.JSONField(
        default=dict,
        help_text=(
            "CliInvocationSpec.to_dict() 完整序列化（含 matched_rule_pattern / "
            "matched_rule_reason 便于审计反查）；写入前按 risk_level 二次脱敏 raw_args"
        ),
    )

    # ─── PermissionRule 决策结果 ──────────────────────────────────────
    rule_decision = models.CharField(
        max_length=16,
        help_text="PermissionRuleEngine 输出：allow / review / deny",
    )
    hitl_required = models.BooleanField(
        default=False,
        help_text="是否触发 HITL 二次确认（risk_level=review 时通常为 True）",
    )

    # ─── HITL 用户决策回填字段（review 路径必填，A4 启动包接入 UI）────
    hitl_user_decision = models.CharField(
        max_length=16,
        null=True,
        blank=True,
        help_text=(
            "HITL 路径最终结果：allow / deny / timeout（PRD §5.1 第 6 项）；"
            "allow / deny 是用户主动选择，timeout 是用户超时未响应（A4 注入）。"
            "review 路径完成后必填；非 review 路径保持 NULL"
        ),
    )
    hitl_decided_by = models.UUIDField(
        null=True,
        blank=True,
        help_text="HITL 决策的用户 ID（跨库软引用 users_auth.User.id）",
    )
    hitl_decided_at = models.DateTimeField(
        null=True,
        blank=True,
        help_text="HITL 决策时间（用于 cli_audit.hitl_pending_seconds metric）",
    )

    # ─── 执行结果回填字段（A5 启动包接入 fork 完成 hook）──────────────
    executed_at = models.DateTimeField(
        null=True,
        blank=True,
        help_text="实际 fork 子进程开始时间（HITL allow 后）",
    )
    finished_at = models.DateTimeField(
        null=True,
        blank=True,
        help_text="子进程结束时间（exit 后回填）",
    )
    exit_code = models.IntegerField(
        null=True,
        blank=True,
        help_text="子进程退出码；deny / 未执行时为 NULL",
    )

    # ─── 绕过路径标记（N18 / H2-9 预留）────────────────────────────────
    bypass = models.BooleanField(
        default=False,
        help_text=(
            "是否走绕过路径（第三方 CLI shim 主动上报 / shell 直跑被审计接管）；"
            "默认 False，N18 决策"
        ),
    )

    # ─── 时间戳 ──────────────────────────────────────────────────────
    created_at = models.DateTimeField(
        auto_now_add=True,
        db_index=True,
        help_text="审计事件落库时间（含 index 便于按时间窗查询）",
    )

    class Meta:
        # 物理位置在 cli/ 子目录，但归属 agent_engine app（PRD §5.1 第 5 项）。
        # 显式声明 app_label 让 Django app registry 把 model 挂到 agent_engine 下，
        # migrations 落在 apps/services/agent_engine/migrations/，
        # router 把读写指向 PostgreSQL（DefaultDatabaseRouter._pg_app_labels 已含 agent_engine）。
        app_label = "agent_engine"
        db_table = "cli_audit_event"
        indexes = [
            # AdminDash 审计页过滤主路径：先按 binary 圈定调用入口，再按 risk_level 分桶
            models.Index(
                fields=["binary", "risk_level"], name="idx_cliaudit_bin_risk"
            ),
            # 用户维度审计时间线（admin "查看张三本周的 CLI 调用"）
            models.Index(
                fields=["user_id", "created_at"], name="idx_cliaudit_user_created"
            ),
            # 对话维度审计时间线（点 thread 跳到所有 CLI 事件）
            models.Index(
                fields=["thread_id", "created_at"], name="idx_cliaudit_thread_created"
            ),
            # 租户维度审计时间线（PRD §5.5 PII 隔离主查询路径，
            # AdminDash 默认按 admin 自己 organization 过滤，加 created_at 排序）
            models.Index(
                fields=["organization_id", "created_at"],
                name="idx_cliaudit_wt_created",
            ),
            # 租户内按 risk_level 分桶（"我们 organization 这周 review 路径多少条"）
            models.Index(
                fields=["organization_id", "risk_level"],
                name="idx_cliaudit_wt_risk",
            ),
        ]

    def __str__(self) -> str:
        inner = f" → {self.inner_binary}" if self.inner_binary else ""
        return (
            f"<CliAuditEvent {self.id} {self.binary}{inner} "
            f"risk={self.risk_level} decision={self.rule_decision}>"
        )


__all__ = ["CliAuditEvent"]
