from __future__ import annotations

import uuid
from django.db import models
from django.contrib.auth import get_user_model

from apps.tracker.constants import (
    TRACKER_TRIGGER_TYPE_CHOICES,
    TRACKER_STATUS_CHOICES,
    TRACKER_RUN_STATUS_CHOICES,
)

User = get_user_model()


# 2026-05-28 收编：ScheduledJob / ScheduledJobRun model（scheduler_job /
# scheduler_job_run 两张表）已随 table_automation 子系统整体下线，并入
# Tracker.trigger_type='table_event'（migration 0033 完成 DB drop，产品未上线
# 无数据归档）。表事件触发统一走 RecordService → EventBus（tabdata.record.*）
# → apps/extensions/consumers.py:_on_event_for_tracker → trigger_by_table_event。


# ═══════════════════════════════════════════════════════════════
# Tracker Models
# ═══════════════════════════════════════════════════════════════


class Tracker(models.Model):
    """Tracker（charter v1.8 § 7.1）：用户定义的自动化执行任务。

    Wave 2 (charter v1.8 §6.4 单 Skill 执行模型)：
    - Tracker 指向 Skill key，由 Agent 在 react 循环中根据 SKILL.md 完成任务。
    - 不再有多步骤 DAG（相关 model 已删除）。
    - 失败模式：charter §6.7 — Run 关联 ChatSession，transcript 即失败汇报。

    命名：所在 Django app 已统一为 ``apps.tracker``（app_label=``tracker``），
    model class 与 DB 表也已是 Tracker / TrackerRun（见 migration 0028）。
    HTTP 入口统一在 ``/api/tracker/*``；业务事件目录已归位 ``/api/registry/events``。
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    organization = models.ForeignKey(
        "tabtinspace.Organization",
        on_delete=models.CASCADE,
        related_name="trackers",
        verbose_name="所属组织",
    )
    #  终态：space FK 已 Drop（0042）；执行现场走 workspace。
    # Wave 1（charter v1.8 §7.1）：Tracker 必须绑定一个 Agent 来执行。
    # 本期 nullable=True 避免存量数据 migration 失败；应用层在 TrackerService.create_tracker()
    # 校验「创建时必填」（详见 charter §7.1 注释）。
    # FK 走 SET_NULL：Agent 删除时 Tracker 不连带删除，由用户后续重新指定 Agent 或归档。
    agent = models.ForeignKey(
        "agent.Agent",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="trackers",
        verbose_name="执行 Agent",
        help_text="执行该 Tracker 的 Agent。本期 nullable，应用层校验「创建时必填」。",
    )
    workspace = models.ForeignKey(
        "tabtinspace.Workspace",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="trackers",
        verbose_name="执行现场",
        help_text="自动化预授权的执行 Workspace；新建 Tracker 必填。",
    )

    name = models.CharField(max_length=200, verbose_name="Tracker 名称")
    description = models.TextField(blank=True, verbose_name="Tracker 描述")
    # Wave 1（charter v1.8 §7.1 / §4.1 / §6.6）：创建时的对话快照，Agent 对话路径填，
    # 表单 / CLI 路径可空。schema 由 Service 层定义（user_utterance / agent_proposal /
    # user_modifications / final_values 等），model 层不强制 schema。
    intent_snapshot = models.JSONField(
        null=True,
        blank=True,
        default=None,
        verbose_name="创建意图快照",
        help_text="对话路径下创建 Tracker 时的意图留痕；表单/CLI 路径为 NULL。",
    )

    skill_key = models.CharField(
        max_length=128, blank=True, default="",
        db_index=True,
        verbose_name="关联 Skill",
        help_text=(
            "指向要执行的 Skill（charter v1.8 §6.4 单 Skill 执行模型）。"
            "空值表示纯 Agent 触发模式。"
            "应用层 TrackerService.create_tracker 在创建时强制非空——历史 Tracker 行可能为空，"
            "为兼容存量数据保留 blank=True / default=\"\"。"
        ),
    )
    # Wave 1（charter v1.8 §7.1）：启动 Skill 时的初始参数，与 skill_key 配套。
    # schema 由 Service 层依据各 Skill 自身的 SKILL.md 入参定义校验，model 层不强制 schema
    # （同 intent_snapshot 模式）。Agent / 表单 / CLI 三条创建路径都可写入；为空表示无显式
    # 参数（Skill 用默认值或在 react 循环中向 Agent 索取）。
    skill_params = models.JSONField(
        null=True,
        blank=True,
        default=None,
        verbose_name="Skill 启动参数",
        help_text="启动 Skill 时的初始参数（charter v1.8 §7.1）。schema 由各 Skill 自定义，"
                  "Service 层校验；空值表示无显式参数。",
    )

    trigger_type = models.CharField(
        max_length=32,
        choices=TRACKER_TRIGGER_TYPE_CHOICES.as_choices(),
        default="manual",
        verbose_name="触发类型",
    )
    trigger_config = models.JSONField(default=dict, verbose_name="触发配置")

    # Wave 2 收尾 (charter v1.8 §7.1)：drop 4 个 [DEPRECATED] 字段——
    # ``execution_config`` / ``project_mode`` / ``token_budget`` / ``max_concurrent_runs``
    # 已在 migration 0023 移除并归档到 ``_archived_goal_deprecated_fields_v18``。
    # 启动 Skill 的所有参数统一存放在 ``skill_params``（charter §7.1 终局形态）。
    # 并发控制由 Redis 信号量（``goal_executor._RedisDistributedSemaphore``）+
    # 单 Tracker 单 active run 双层保证。

    status = models.CharField(
        max_length=16,
        choices=TRACKER_STATUS_CHOICES.as_choices(),
        default="draft",
        verbose_name="Tracker 状态",
    )

    total_runs = models.PositiveIntegerField(default=0, verbose_name="总执行次数")
    success_runs = models.PositiveIntegerField(default=0, verbose_name="成功次数")
    fail_runs = models.PositiveIntegerField(default=0, verbose_name="失败次数")
    last_run_at = models.DateTimeField(null=True, blank=True, verbose_name="上次执行时间")
    next_run_at = models.DateTimeField(null=True, blank=True, verbose_name="下次执行时间")

    # TS-6（软删）：归档时间戳。delete_tracker 不再物理删除，而是
    # status=archived + archived_at=now（保留 TrackerRun 审计历史，TS-15）。
    # NULL 表示未归档（活跃 Tracker）；非 NULL 即审计该 Tracker 何时被软删。
    archived_at = models.DateTimeField(
        null=True,
        blank=True,
        verbose_name="归档时间",
        help_text="软删（归档）时间。NULL 表示未归档；非 NULL 即 status=archived 的归档时刻（TS-6）。",
    )

    # Wave 1（charter v1.8 §7.1）：created_by nullable 化——未来 system_preset 时为 NULL。
    # 注：null=True 历史已存在，Wave 1 补 blank=True（应用层 / admin form 一致）。
    created_by = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="created_trackers",
        verbose_name="创建者",
    )
    created_at = models.DateTimeField(auto_now_add=True, verbose_name="创建时间")
    updated_at = models.DateTimeField(auto_now=True, verbose_name="更新时间")

    _ALLOWED_TRANSITIONS = {
        "draft":    {"active", "disabled"},
        "active":   {"paused", "disabled"},
        "paused":   {"active", "disabled"},
        "disabled": {"active"},
    }

    _TRANSITION_HINTS = {
        ("draft", "paused"): "草案状态的 Tracker 需要先激活才能暂停",
        ("disabled", "paused"): "已禁用的 Tracker 需要先重新激活才能暂停",
        ("disabled", "disabled"): "Tracker 已处于禁用状态",
        ("active", "active"): "Tracker 已处于激活状态",
    }

    _STATUS_LABELS = {
        "draft": "草案",
        "active": "已激活",
        "paused": "已暂停",
        "disabled": "已禁用",
        "archived": "已归档",
    }

    class Meta:
        db_table = "tracker"
        verbose_name = "Tracker"
        verbose_name_plural = "Tracker"
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["organization", "status"]),
            models.Index(fields=["workspace"]),
            models.Index(fields=["next_run_at"]),
        ]

    def transition_status(self, new_status: str) -> None:
        """状态转换守卫：仅允许合法的状态迁移路径。"""
        from django.core.exceptions import ValidationError
        if self.status == new_status:
            return
        allowed = self._ALLOWED_TRANSITIONS.get(self.status, set())
        if new_status not in allowed:
            hint = self._TRANSITION_HINTS.get((self.status, new_status), "")
            label = self._STATUS_LABELS.get(self.status, self.status)
            msg = hint or f"当前目标状态（{label}）不允许此操作"
            raise ValidationError(msg)
        self.status = new_status

    def save(self, *args, **kwargs):
        # Wave 1 (charter v1.8 §7.1): 旧字段 deprecation telemetry。
        # Wave 2 末尾通过 grep "tracker_deprecated_field_access" logs/ 确认 0 调用后 drop。
        # 详见 services/deprecation_logger.py。
        from apps.tracker.services.deprecation_logger import (
            log_deprecated_field_access,
            TRACKER_DEPRECATED_FIELDS,
        )
        log_deprecated_field_access("Tracker", TRACKER_DEPRECATED_FIELDS, self, context="save")
        super().save(*args, **kwargs)

    def __str__(self) -> str:
        return f"{self.name} ({self.status})"


# Wave 2 (charter v1.8 §6.4)：删除多步骤 step model —— DAG 已废弃，
# Tracker 通过单 Skill 执行。Migration 0021 完成 DB drop 并归档历史数据。


class TrackerRun(models.Model):
    """Tracker 执行实例：一次 Tracker 的完整执行记录。

    V2 简化：新增 progress_pct / progress_message 供 SDK 直接上报进度。
    Wave 2 续作 (charter v1.8 §6.4)：单 Skill 执行模型下不再有「步骤」概念，
    total_steps / completed_steps 已 [DEPRECATED]（计划 Wave 3 启动前 drop），
    通过 deprecation_logger 上报写入。
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tracker = models.ForeignKey(
        Tracker,
        on_delete=models.CASCADE,
        related_name="runs",
        verbose_name="所属 Tracker",
    )
    # Wave 1（charter v1.8 §7.2 / §6.7）：每次 Run 关联一段 ChatSession，transcript 即
    # 本次 react 循环完整记录。session_mode=per_run：每个 TrackerRun 对应一条
    # ChatSession；同 Run 的掉线重派 / 瞬态重试复用该 session，不再清空外键。
    # 字段 nullable=True 允许 Run 在 ChatSession 创建前先入库（先有 Run 记录、后链接 session）。
    #
    # 单库治理：tracker 与 conversation 同库（PG）后恢复为物理 FK。
    # db_column=chat_session_id 保列名不动数据；db_index=True 复用既有列索引（热查询
    # _batch_resolve_tracker_run_meta 依赖）；on_delete=SET_NULL 对齐原软引用语义——
    # ChatSession 删除时 Run 运行历史（审计资产）不连带删，仅把 chat_session_id 置 NULL。
    # （双库时代曾退化为 UUIDField + signal 清理，因 tracker/conversation 异库 Collector
    #  跨库反查失败；同库后 Collector 正常工作，softref + 信号一并退役。）
    chat_session = models.ForeignKey(
        "conversation.ChatSession",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        db_column="chat_session_id",
        db_index=True,
        related_name="+",
        verbose_name="关联 ChatSession",
        help_text="本次 Run 的 react 循环 transcript 所在 ChatSession（charter v1.8 §6.7）。",
    )

    trigger_type = models.CharField(max_length=32, verbose_name="触发类型")
    trigger_context = models.JSONField(default=dict, verbose_name="触发上下文")

    status = models.CharField(
        max_length=24,
        choices=TRACKER_RUN_STATUS_CHOICES.as_choices(),
        default="pending",
        verbose_name="执行状态",
    )

    # [DEPRECATED Wave 2 续作 → drop in Wave 3 启动前]
    # charter v1.8 §6.4 单 Skill 执行模型下不再有「步骤」概念。Wave 2 续作已
    # 把 TrackerNotificationService.notify_progress / notify_run_completed 推送的
    # WS payload 退出 total_steps / completed_steps 字段；deprecation_logger
    # 在 save() 时若发现写入非默认值会打 telemetry，0 写入后即可 drop。
    total_steps = models.PositiveSmallIntegerField(
        default=0, verbose_name="[DEPRECATED] 总步骤数",
        help_text="[DEPRECATED Wave 2 续作] 计划 Wave 3 启动前 drop。单 Skill 执行模型不再有步骤。",
    )
    completed_steps = models.PositiveSmallIntegerField(
        default=0, verbose_name="[DEPRECATED] 已完成步骤数",
        help_text="[DEPRECATED Wave 2 续作] 计划 Wave 3 启动前 drop。",
    )

    current_cycle = models.PositiveSmallIntegerField(default=1, verbose_name="当前回环轮次")
    max_cycles = models.PositiveSmallIntegerField(default=3, verbose_name="最大回环次数")
    # Wave 2 收尾 (charter v1.8 §7.2)：drop ``cycle_history`` —— 写入但无读取
    # 的死遗产，已在 migration 0023 移除并归档到 ``_archived_goalrun_cycle_history``。
    # 未来若引入「自修复 prompt 注入」可重新设计字段（charter §7.2 留有提示）。

    tokens_used = models.PositiveIntegerField(default=0, verbose_name="已用 Token 数")
    context = models.JSONField(default=dict, verbose_name="运行时上下文")

    progress_pct = models.PositiveSmallIntegerField(
        default=0, verbose_name="进度百分比",
        help_text="SDK 上报的执行进度（0-100）。V2 简化后替代 step 级别进度。",
    )
    progress_message = models.CharField(
        max_length=500, blank=True, default="",
        verbose_name="进度描述",
        help_text="SDK 上报的当前阶段描述，如「正在分析数据…」。",
    )

    started_at = models.DateTimeField(null=True, blank=True, verbose_name="开始时间")
    finished_at = models.DateTimeField(null=True, blank=True, verbose_name="结束时间")
    duration = models.FloatField(null=True, blank=True, verbose_name="耗时(秒)")
    error_summary = models.TextField(blank=True, verbose_name="错误摘要")

    created_at = models.DateTimeField(auto_now_add=True, verbose_name="创建时间")

    class Meta:
        db_table = "tracker_run"
        verbose_name = "Tracker 执行记录"
        verbose_name_plural = "Tracker 执行记录"
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["tracker", "created_at"]),
            models.Index(fields=["status"]),
        ]

    @property
    def progress(self) -> int:
        """运行进度百分比（0-100）。

        Wave 2 续作 (charter v1.8 §6.4)：单 Skill 执行模型下不再有「步骤」概念，
        progress 仅由 SDK 上报的 progress_pct 决定。原 fallback 到
        ``completed_steps / total_steps`` 的代码路径已删除——这两个字段已
        [DEPRECATED]，不再有写入路径，回退路径永远 0。
        """
        return self.progress_pct or 0

    def save(self, *args, **kwargs):
        # Wave 1 (charter v1.8 §7.2): cycle_history deprecation telemetry。
        # Wave 2 末尾通过 grep "tracker_deprecated_field_access" logs/ 确认 0 调用后 drop。
        from apps.tracker.services.deprecation_logger import (
            log_deprecated_field_access,
            TRACKER_RUN_DEPRECATED_FIELDS,
        )
        log_deprecated_field_access("TrackerRun", TRACKER_RUN_DEPRECATED_FIELDS, self, context="save")
        super().save(*args, **kwargs)

    def __str__(self) -> str:
        return f"TrackerRun {self.id} ({self.status})"


# Wave 2 (charter v1.8 §6.4)：step run model 已删除——多步骤执行记录不再存在。
# Migration 0021 drop 表 + 历史数据归档。

# Tracker 模块收敛波次 1（2026-05-20）：删除 GoalAgendaMeta / GoalAttendee /
# GoalReminderDelivery 三个日历模型 —— tabagenda 模块整体下线，日历功能未来
# 独立立项重做；migration 0027_drop_tabagenda_models 完成 DB drop。
