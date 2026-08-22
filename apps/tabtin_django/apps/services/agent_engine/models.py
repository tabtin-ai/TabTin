"""
Agent Engine Models

用于持久化执行编排的 Trace、Run、SubtaskRun、对话状态、子 Agent 模板与监管任务。

Wave 11（2026-04-17）彻底删除 `apps.orchestration` 后，所有 model 归属
`app_label='agent_engine'`，表名以 `agent_engine_*` 为前缀，migrations 位于
`apps/services/agent_engine/migrations/`，路由通过 `DefaultDatabaseRouter._pg_app_labels`
分发到 PostgreSQL。
"""

import uuid
from django.conf import settings
from django.db import models
from django.utils import timezone


class ExecutionTrace(models.Model):
    """一次执行编排的 Trace 根记录"""

    trace_id = models.UUIDField(default=uuid.uuid4, unique=True, db_index=True)
    thread_id = models.CharField(max_length=128, db_index=True)
    graph_type = models.CharField(max_length=64, db_index=True)

    session_id = models.CharField(max_length=64, null=True, blank=True, db_index=True)
    instance_id = models.CharField(max_length=64, null=True, blank=True, db_index=True)
    organization_id = models.CharField(max_length=64, null=True, blank=True, db_index=True)
    user_id = models.CharField(max_length=64, null=True, blank=True, db_index=True)

    status = models.CharField(max_length=32, default="running")
    started_at = models.DateTimeField(auto_now_add=True)
    ended_at = models.DateTimeField(null=True, blank=True)
    error = models.TextField(null=True, blank=True)
    metadata = models.JSONField(default=dict, blank=True)

    last_event_seq = models.BigIntegerField(default=0)

    class Meta:
        db_table = "agent_engine_traces"
        indexes = [
            models.Index(fields=["thread_id", "graph_type"], name="idx_thread_graph"),
            models.Index(fields=["user_id", "started_at"], name="idx_user_started"),
            models.Index(fields=["session_id"], name="idx_session"),
        ]

    def __str__(self):
        return f"<ExecutionTrace {self.trace_id} {self.graph_type} {self.thread_id}>"


class TraceEvent(models.Model):
    """Trace 内部事件记录（节点/LLM/工具/前端/上下文）"""

    trace = models.ForeignKey(
        ExecutionTrace,
        on_delete=models.CASCADE,
        related_name="events",
    )
    parent_event = models.ForeignKey(
        "self",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="children",
    )
    event_uuid = models.UUIDField(default=uuid.uuid4, unique=True, db_index=True)

    event_type = models.CharField(max_length=64, db_index=True)
    name = models.CharField(max_length=128, blank=True)
    seq = models.BigIntegerField()

    started_at = models.DateTimeField(auto_now_add=True)
    ended_at = models.DateTimeField(null=True, blank=True)
    duration_ms = models.IntegerField(null=True, blank=True)

    input = models.JSONField(null=True, blank=True)
    output = models.JSONField(null=True, blank=True)
    error = models.TextField(null=True, blank=True)
    usage = models.JSONField(null=True, blank=True)

    class Meta:
        db_table = "agent_engine_trace_events"
        indexes = [
            models.Index(fields=["trace", "seq"], name="idx_trace_seq"),
            models.Index(fields=["event_type"], name="idx_event_type"),
        ]

    def __str__(self):
        return f"<TraceEvent {self.event_type} {self.name} {self.seq}>"


class ExecutionRun(models.Model):
    """一次执行编排的生命周期记录（权威 run 视角）"""

    class Status(models.TextChoices):
        QUEUED = "queued", "Queued"
        RUNNING = "running", "Running"
        WAITING_USER = "waiting_user", "Waiting for user"
        PAUSED = "paused", "Paused"
        CANCELLING = "cancelling", "Cancelling"
        COMPLETED = "completed", "Completed"
        FAILED = "failed", "Failed"
        CANCELLED = "cancelled", "Cancelled"
        INTERRUPTED = "interrupted", "Interrupted"

    run_id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    thread_id = models.CharField(max_length=128, db_index=True)
    graph_type = models.CharField(max_length=64, db_index=True)

    session_id = models.CharField(max_length=64, null=True, blank=True, db_index=True)
    instance_id = models.CharField(max_length=64, null=True, blank=True, db_index=True)
    organization_id = models.CharField(max_length=64, null=True, blank=True, db_index=True)
    user_id = models.CharField(max_length=64, null=True, blank=True, db_index=True)
    trace_id = models.UUIDField(null=True, blank=True, db_index=True)

    sequence = models.PositiveBigIntegerField(default=1)
    revision = models.PositiveBigIntegerField(default=0)
    terminal_projection_revision = models.PositiveBigIntegerField(
        null=True,
        blank=True,
        help_text="该轮成为会话可见终态时冻结的投影 revision；用于跨设备已读 ACK。",
    )
    unread_eligible = models.BooleanField(
        default=False,
        help_text="仅新协议上线后完成的 run 可产生未读，避免迁移时点亮全部历史。",
    )
    status = models.CharField(
        max_length=32,
        choices=Status.choices,
        default=Status.QUEUED,
        db_index=True,
    )
    started_at = models.DateTimeField(null=True, blank=True)
    state_changed_at = models.DateTimeField(default=timezone.now)
    ended_at = models.DateTimeField(null=True, blank=True)
    stop_reason = models.CharField(max_length=128, null=True, blank=True)
    error_class = models.CharField(max_length=128, null=True, blank=True)
    waiting_interaction_id = models.UUIDField(null=True, blank=True)
    error = models.TextField(null=True, blank=True)
    metadata = models.JSONField(default=dict, blank=True)
    max_alive_seconds = models.IntegerField(
        default=1800,
        help_text="Run 最大存活时间（秒），超时后 Celery beat 自动取消",
    )
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "agent_engine_runs"
        indexes = [
            models.Index(fields=["thread_id", "status"], name="idx_run_thread_status"),
            models.Index(fields=["graph_type", "started_at"], name="idx_run_graph_started"),
            models.Index(fields=["trace_id"], name="idx_run_trace"),
            models.Index(fields=["session_id"], name="idx_run_session"),
        ]
        constraints = [
            models.UniqueConstraint(
                fields=["session_id", "sequence"],
                name="uq_run_session_sequence",
            ),
        ]

    def __str__(self):
        return f"<ExecutionRun {self.run_id} {self.status} {self.graph_type}>"


class SessionRunProjection(models.Model):
    """对话当前执行态投影；列表读取只认这一行，不从消息时间猜状态。"""

    session = models.OneToOneField(
        "conversation.ChatSession",
        on_delete=models.CASCADE,
        related_name="run_state_projection",
        primary_key=True,
    )
    current_run = models.ForeignKey(
        ExecutionRun,
        on_delete=models.PROTECT,
        related_name="+",
    )
    sequence = models.PositiveBigIntegerField()
    revision = models.PositiveBigIntegerField()
    status = models.CharField(max_length=32, choices=ExecutionRun.Status.choices)
    queue_depth = models.PositiveIntegerField(default=0)
    started_at = models.DateTimeField(null=True, blank=True)
    state_changed_at = models.DateTimeField()
    ended_at = models.DateTimeField(null=True, blank=True)
    stop_reason = models.CharField(max_length=128, null=True, blank=True)
    error_class = models.CharField(max_length=128, null=True, blank=True)
    waiting_interaction_id = models.UUIDField(null=True, blank=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "agent_engine_session_run_projection"
        indexes = [
            models.Index(fields=["status"], name="idx_session_run_status"),
        ]


class RunHostLease(models.Model):
    """Host 对 active run 的显式存活租约。

    只有新 Host 主动 claim 后才有本行；过期巡检绝不根据 ExecutionRun 的更新时间
    猜测旧客户端是否失联。
    """

    run = models.OneToOneField(
        ExecutionRun,
        on_delete=models.CASCADE,
        related_name="host_lease",
        primary_key=True,
    )
    host_id = models.CharField(max_length=128, db_index=True)
    lease_token = models.UUIDField(default=uuid.uuid4, unique=True, editable=False)
    generation = models.PositiveBigIntegerField(default=1)
    claimed_at = models.DateTimeField(default=timezone.now)
    last_heartbeat_at = models.DateTimeField(default=timezone.now)
    lease_expires_at = models.DateTimeField(db_index=True)
    released_at = models.DateTimeField(null=True, blank=True)
    release_reason = models.CharField(max_length=64, null=True, blank=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "agent_engine_run_host_leases"
        indexes = [
            models.Index(
                fields=["host_id", "released_at"],
                name="idx_run_lease_host_open",
            ),
        ]


class SessionReadReceipt(models.Model):
    """用户在会话上的单调阅读水位；同一账号的所有设备共享。"""

    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="+",
    )
    session = models.ForeignKey(
        "conversation.ChatSession",
        on_delete=models.CASCADE,
        related_name="read_receipts",
    )
    last_read_run_sequence = models.PositiveBigIntegerField(default=0)
    last_read_terminal_revision = models.PositiveBigIntegerField(default=0)
    read_at = models.DateTimeField(null=True, blank=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "agent_engine_session_read_receipts"
        constraints = [
            models.UniqueConstraint(
                fields=["user", "session"],
                name="uq_session_read_receipt_user_session",
            ),
        ]
        indexes = [
            models.Index(
                fields=["user", "session"],
                name="idx_read_receipt_user_session",
            ),
        ]


class SubtaskRun(models.Model):
    """子任务运行记录（持久化）"""

    subagent_run_id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    parent_thread_id = models.CharField(max_length=128, db_index=True)
    child_thread_id = models.CharField(max_length=128, db_index=True)

    parent_agent_name = models.CharField(max_length=64, null=True, blank=True)
    parent_agent_type = models.CharField(max_length=32, null=True, blank=True)
    agent_name = models.CharField(max_length=64, null=True, blank=True)
    agent_type = models.CharField(max_length=32, default="react")
    subagent_type = models.CharField(
        max_length=32, null=True, blank=True,
        help_text="子 Agent 类型预设：explore/plan/execute",
    )

    app_id = models.CharField(max_length=64, null=True, blank=True, db_index=True)
    mode = models.CharField(max_length=32, default="background")
    cleanup = models.CharField(max_length=16, default="keep")
    status = models.CharField(max_length=32, default="pending", db_index=True)

    task = models.TextField(null=True, blank=True)
    label = models.CharField(max_length=128, null=True, blank=True)
    user_id = models.CharField(max_length=64, null=True, blank=True, db_index=True)
    organization_id = models.CharField(max_length=64, null=True, blank=True, db_index=True)
    session_id = models.CharField(max_length=64, null=True, blank=True, db_index=True)
    current_space_id = models.CharField(max_length=64, null=True, blank=True)
    current_table_id = models.CharField(max_length=64, null=True, blank=True)

    model_id = models.CharField(max_length=64, null=True, blank=True)
    thinking_level = models.CharField(max_length=32, null=True, blank=True)
    run_timeout_seconds = models.IntegerField(null=True, blank=True)

    tool_domains = models.JSONField(default=list, blank=True)
    action_app_ids = models.JSONField(default=list, blank=True)
    allowed_tools = models.JSONField(default=list, blank=True)
    input_state = models.JSONField(default=dict, blank=True)
    system_prompt = models.TextField(null=True, blank=True)

    result_summary = models.TextField(null=True, blank=True)
    error = models.TextField(null=True, blank=True)
    stats_json = models.JSONField(default=dict, blank=True)
    requester_origin_json = models.JSONField(default=dict, blank=True)
    metadata = models.JSONField(default=dict, blank=True)

    initiator_speaker_id = models.CharField(
        max_length=64, null=True, blank=True, db_index=True,
        help_text="发起者 speaker_id（agent-agnostic），为二期 Handoff 留路",
    )
    template_version = models.IntegerField(
        null=True, blank=True,
        help_text="子 Agent spawn 时的模板版本号，指向 SubAgentTemplateVersion",
    )
    notified_at = models.DateTimeField(
        null=True, blank=True,
        help_text="主 Agent push 汇报时间戳，幂等标记",
    )
    notification_retry_count = models.IntegerField(
        default=0,
        help_text="push 汇报重试次数",
    )

    created_at = models.DateTimeField(auto_now_add=True)
    started_at = models.DateTimeField(null=True, blank=True)
    ended_at = models.DateTimeField(null=True, blank=True)
    archive_at = models.DateTimeField(null=True, blank=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "agent_engine_subtask_runs"
        indexes = [
            models.Index(fields=["parent_thread_id", "status"], name="idx_subagent_parent_status"),
            models.Index(fields=["child_thread_id"], name="idx_subagent_child"),
            models.Index(fields=["app_id", "status"], name="idx_subagent_app_status"),
            models.Index(fields=["archive_at"], name="idx_subagent_archive"),
            models.Index(fields=["parent_thread_id", "created_at"], name="idx_subagent_parent_created"),
            models.Index(
                fields=["parent_thread_id", "status"],
                name="idx_subagent_pending_notify",
                condition=models.Q(notified_at__isnull=True),
            ),
        ]

    def __str__(self):
        return f"<SubtaskRun {self.subagent_run_id} {self.status}>"


class ConversationState(models.Model):
    """
    对话状态持久化模型。

    存储 ReAct 循环的对话消息和 HITL 中断状态。
    """

    thread_id = models.CharField(max_length=128, unique=True, db_index=True)

    messages_json = models.JSONField(default=list, help_text="OpenAI 格式消息列表")
    state_json = models.JSONField(default=dict, help_text="非消息状态字段")

    interrupt_state = models.JSONField(
        null=True, blank=True,
        help_text="HITL 中断时保存的完整状态快照"
    )

    version = models.BigIntegerField(default=0)

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "agent_engine_conversation_states"
        indexes = [
            models.Index(fields=["updated_at"], name="idx_convstate_updated"),
        ]

    def __str__(self):
        msg_count = len(self.messages_json) if isinstance(self.messages_json, list) else 0
        return f"<ConversationState {self.thread_id} msgs={msg_count}>"


class PendingInteraction(models.Model):
    """Agent 等用户处理事项的可靠事实源。

    这张表不是审批专表，而是把"Agent 暂停等待用户选择"抽象成可查询、
    可恢复、可过期的用户待办。实时 stream 仍负责当前会话即时展示；
    本表负责晚进入、断网恢复、多端收敛和过期关闭。
    """

    KIND_CHOICES = [
        ("tool_approval", "Tool Approval"),
        ("ask_choice", "Ask Choice"),
        ("ask_form", "Ask Form"),
        ("permission_request", "Permission Request"),
        ("browser_action_approval", "Browser Action Approval"),
    ]

    SOURCE_CHOICES = [
        ("agent_stream", "Agent Stream"),
        ("agent_action", "Agent Action"),
        ("runtime", "Runtime"),
    ]

    STATUS_CHOICES = [
        ("pending", "Pending"),
        ("resolved", "Resolved"),
        ("expired", "Expired"),
        ("cancelled", "Cancelled"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    kind = models.CharField(max_length=48, choices=KIND_CHOICES, db_index=True)
    status = models.CharField(
        max_length=24,
        choices=STATUS_CHOICES,
        default="pending",
        db_index=True,
    )

    thread_id = models.CharField(
        max_length=128,
        db_index=True,
        help_text="会话 thread_id（chat-session-{uuid}）",
    )
    session_id = models.UUIDField(
        null=True,
        blank=True,
        db_index=True,
        help_text="ChatSession.id；可为空以兼容还未解析到会话的历史事件",
    )
    organization_id = models.CharField(max_length=100, db_index=True)
    user_id = models.UUIDField(db_index=True)

    request_key = models.CharField(
        max_length=160,
        db_index=True,
        help_text="通用请求键：approval batch_id / ask request_id 等；允许非 UUID",
    )
    source = models.CharField(max_length=32, choices=SOURCE_CHOICES, db_index=True)
    source_device_fingerprint = models.CharField(max_length=255, blank=True, default="")

    payload = models.JSONField(default=dict, blank=True)
    result = models.JSONField(default=dict, blank=True)
    expires_at = models.DateTimeField(null=True, blank=True, db_index=True)
    resolved_at = models.DateTimeField(null=True, blank=True)

    created_at = models.DateTimeField(auto_now_add=True, db_index=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        app_label = "agent_engine"
        db_table = "agent_engine_pending_interactions"
        verbose_name = "待处理用户交互"
        verbose_name_plural = "待处理用户交互"
        indexes = [
            models.Index(
                fields=["user_id", "status", "expires_at"],
                name="idx_pi_user_status_exp",
            ),
            models.Index(
                fields=["thread_id", "status", "created_at"],
                name="idx_pi_thread_status_time",
            ),
            models.Index(
                fields=["organization_id", "status", "created_at"],
                name="idx_pi_organization_st_time",
            ),
        ]
        constraints = [
            models.UniqueConstraint(
                fields=["kind", "thread_id", "request_key"],
                name="uq_pi_kind_thread_key",
            ),
        ]

    def __str__(self):
        return f"<PendingInteraction {self.kind} {self.request_key} {self.status}>"


class SubAgentTemplate(models.Model):
    """用户自定义的子 Agent 模板（绑定到 Workspace，）。

    ``space_id`` 列名历史遗留，值为 Workspace.id（ id-reuse）。
    用户在 Workspace 设置中预定义子 Agent 角色，当前会话在该现场执行时
    可按名称调用这些预配置的子 Agent。
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    space_id = models.UUIDField(
        db_index=True,
        help_text='所属 Workspace.id（列名 space_id 为历史兼容，）',
    )

    name = models.CharField(max_length=64, help_text="子 Agent 名称（当前 Agent 通过此名称引用）")
    description = models.TextField(blank=True, default="", help_text="子 Agent 用途描述")
    icon = models.CharField(max_length=50, blank=True, default="")

    system_prompt = models.TextField(blank=True, default="", help_text="角色设定 / 系统提示")
    subagent_type = models.CharField(
        max_length=32, default="execute",
        help_text="任务角色：explore（只读探索）/ plan（只读规划）/ execute（可写执行）",
    )
    allowed_tools = models.JSONField(default=list, blank=True, help_text="工具白名单（空=不限制）")
    denied_tools = models.JSONField(default=list, blank=True, help_text="工具黑名单")
    model_id = models.CharField(max_length=64, blank=True, default="", help_text="首选模型 ID")
    thinking_level = models.CharField(max_length=32, blank=True, default="", help_text="思维级别")
    default_mode = models.CharField(
        max_length=32, default="wait",
        help_text="默认执行模式：wait（同步）/ background（异步）",
    )
    app_id = models.CharField(
        max_length=64, blank=True, default="",
        help_text="工具域来源 APP（决定子 Agent 可用的工具集，空=通用）",
    )
    reply_mode = models.CharField(
        max_length=32, blank=True, default="",
        help_text="回复模式（来自 agents/*.md 的 reply_mode 字段，空=由编排器决定）",
    )
    tool_domains = models.JSONField(
        default=list, blank=True,
        help_text="工具域标签列表（如 [\"rag\",\"browser\",\"tabdata\"]），来自 agents/*.md",
    )
    skill_key = models.CharField(
        max_length=128, blank=True, default="",
        help_text="来源 Skill 标识（从文件系统 agents/*.md 注册时回填）",
    )
    is_enabled = models.BooleanField(default=True, help_text="是否启用")
    order = models.IntegerField(default=0, help_text="排序权重")

    display_color = models.CharField(
        max_length=16, blank=True, default='',
        help_text="显示颜色 hex 值",
    )
    max_turns = models.PositiveIntegerField(default=50, help_text="子 Agent 最大迭代轮数")
    max_active = models.PositiveIntegerField(default=5, help_text="该模板并发上限")
    version = models.PositiveIntegerField(default=1, help_text="当前版本号，每次编辑自增")

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "agent_engine_subagent_templates"
        ordering = ["order", "created_at"]
        indexes = [
            models.Index(fields=["space_id", "is_enabled"], name="idx_tpl_space_enabled"),
        ]
        constraints = [
            models.UniqueConstraint(fields=["space_id", "name"], name="uq_tpl_space_name"),
        ]

    def __str__(self):
        return f"<SubAgentTemplate {self.name} space={self.space_id}>"


class SubAgentTemplateVersion(models.Model):
    """模板版本快照（引用式）。

    用户改模板时 version 自增 + 写一行 snapshot_json。
    子 Agent spawn 时记录 template_version，运行时用版本快照。
    """

    template = models.ForeignKey(
        SubAgentTemplate, on_delete=models.CASCADE, related_name='versions',
    )
    version = models.IntegerField()
    snapshot_json = models.JSONField(help_text="改动时刻的模板完整快照")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "agent_engine_subagent_template_versions"
        constraints = [
            models.UniqueConstraint(
                fields=["template", "version"], name="uq_tpl_version",
            ),
        ]

    def __str__(self):
        return f"<TemplateVersion {self.template_id} v{self.version}>"


class MonitorTask(models.Model):
    """进程监管任务 — 让 Agent 持续接收长驻进程的 stdout。

    与 SubtaskRun 并列的任务类型，但本质不同：MonitorTask 不做推理，
    不调工具，没有 LLM 循环——它是一个"传感器"，将进程输出实时推入
    Agent 的对话循环（通过 MonitorEventMiddleware）。
    """

    NOTIFY_ON_CHOICES = [
        ("every_line", "Every Line"),
        ("on_error", "On Error"),
        ("on_pattern", "On Pattern"),
        ("on_build", "On Build"),
    ]

    STATUS_CHOICES = [
        ("running", "Running"),
        ("stopped", "Stopped"),
        ("stream_ended", "Stream Ended"),
        ("failed", "Failed"),
    ]

    MAX_MONITORS_PER_THREAD = 5

    monitor_id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    thread_id = models.CharField(max_length=128, db_index=True)
    command = models.TextField()
    description = models.CharField(max_length=200)
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default="running")
    fail_reason = models.CharField(max_length=64, null=True, blank=True)
    notify_on = models.CharField(max_length=20, choices=NOTIFY_ON_CHOICES, default="every_line")
    pattern = models.CharField(max_length=500, null=True, blank=True)
    device_fingerprint = models.CharField(max_length=128)
    session_id = models.CharField(max_length=128, null=True, blank=True)
    parent_subagent_id = models.UUIDField(null=True, blank=True, db_index=True)
    last_heartbeat_at = models.DateTimeField(null=True, blank=True)
    working_directory = models.CharField(max_length=1024, null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "agent_engine_monitor_tasks"
        indexes = [
            models.Index(fields=["thread_id", "status"], name="idx_monitor_thread_status"),
            models.Index(fields=["parent_subagent_id"], name="idx_monitor_parent_subagent"),
        ]

    def __str__(self):
        return f'<MonitorTask {self.monitor_id} "{self.description}" {self.status}>'


class PermissionAudit(models.Model):
    """审批审计记录（PRD 05 v0.4 §7.7）。

    每条审批决议（包括 hardline 拦、规则拦、Layer 4 memoization 命中、
    classifier 兜底、用户交互批/拒、rollback cancel 等）写一行；
    一个 batch 内 N 条 ActionRequest 共享 ``batch_id``，单工具 ``N=1`` 退化形态
    也写 1 行（``batch_id`` 仍非空，方便统计聚合）。

    AdminDash 回放查询场景（PRD §7.7 + 北极星 §1.3）：

    * 单 Agent 时序回放：``filter(agent_id=, created_at__gte=).order_by('-created_at')``
    * 单会话回放：``filter(thread_id=, created_at__gte=).order_by('-created_at')``
    * 按批聚合：``filter(batch_id=)`` —— 同批 N 行
    * Organization 级审计：``filter(organization_id=, created_at__gte=)``
    * 按 outcome 统计：``values('decision').annotate(c=Count('id'))``

    PG 库（agent_engine app_label），由 ``DefaultDatabaseRouter._pg_app_labels``
    路由；每次 model 改动后**必须**走 ``bash scripts/backend/migrate-all.sh`` 双库迁移
    （AGENTS.md 顶层硬约束）。
    """

    DECISION_CHOICES = [
        ("allow", "Allow"),
        ("deny", "Deny"),
        ("cancelled", "Cancelled"),
        ("expired", "Expired"),
        ("cancelled_by_rollback", "Cancelled By Rollback"),
    ]

    SOURCE_CHOICES = [
        ("plan_guard", "Plan Guard"),
        ("hardline", "Hardline"),
        ("rule", "Rule"),
        ("memoization", "Memoization"),
        ("classifier", "Classifier"),
        ("user_interactive", "User Interactive"),
        ("skill_trust", "Skill Trust"),
        ("rollback", "Rollback"),
    ]

    SCOPE_CHOICES = [
        ("once", "Once"),
        ("thread", "Thread"),
        ("always", "Always"),
    ]

    RUNTIME_MODE_CHOICES = [
        ("interactive", "Interactive"),
        ("solo", "Solo"),
        ("scheduled", "Scheduled"),
        ("batch", "Batch"),
    ]

    id = models.UUIDField(
        primary_key=True, default=uuid.uuid4, editable=False,
    )

    # ── Tenancy / 路由维度（AdminDash 时序回放） ──────────────────────
    organization_id = models.UUIDField(db_index=True, help_text="所属 Organization")
    agent_id = models.UUIDField(db_index=True, help_text="决议关联的 Agent")
    workspace_id = models.UUIDField(
        null=True,
        blank=True,
        db_index=True,
        help_text="决议关联的 Workspace；历史记录可为空。",
    )
    thread_id = models.CharField(
        max_length=128, db_index=True,
        help_text="会话 thread_id（chat-session-{uuid} 等）",
    )
    session_id = models.UUIDField(
        db_index=True,
        help_text="ChatSession.id；与 thread_id 双索引便于跨索引回查",
    )

    # ── 批 + 行级 id（v0.4 batch HITL 一等公民） ──────────────────────
    batch_id = models.UUIDField(
        db_index=True, null=True,
        help_text="同批 N 行共享 batch_id；单工具 N=1 退化时仍写非空 UUID。"
                  "rollback / 后台过期清理等非批量审计行允许 null。",
    )
    request_id = models.UUIDField(
        db_index=True,
        help_text="单条 ActionRequest 的 request_id（行级 audit / resume key）",
    )
    tool_call_id = models.CharField(
        max_length=128,
        help_text="LLM tool_use_id（决策回灌索引键）",
    )

    # ── 工具维度 ─────────────────────────────────────────────────────
    tool_name = models.CharField(max_length=128)
    tool_namespace = models.CharField(max_length=128, blank=True, default="")
    tool_input_preview = models.TextField(
        help_text="LocalPermissionHandler.SUMMARY_MAX (2000) 截断后的 input 摘要",
    )

    # ── 判决结果 ─────────────────────────────────────────────────────
    decision = models.CharField(
        max_length=24, choices=DECISION_CHOICES,
        help_text="allow / deny / cancelled / expired / cancelled_by_rollback",
    )
    source = models.CharField(
        max_length=32, choices=SOURCE_CHOICES,
        help_text="判决来源 Layer：plan_guard / hardline / rule / memoization "
                  "/ classifier / user_interactive / skill_trust / rollback",
    )
    reason = models.JSONField(
        default=dict,
        help_text="DecisionReason 19-tag discriminated union（PRD §8.4）",
    )
    scope = models.CharField(
        max_length=16, choices=SCOPE_CHOICES, blank=True, default="",
        help_text="用户决策的 scope；非 user_interactive source 留空字符串",
    )

    # ── 审批者身份 ───────────────────────────────────────────────────
    initiator_user_id = models.UUIDField(
        null=True, blank=True,
        help_text="Team Space 中触发本次 AI run 的成员；个人 Space 为空。",
    )
    execution_owner_user_id = models.UUIDField(
        null=True, blank=True,
        help_text="Team Space 固定执行 Owner；个人 Space 为空。",
    )
    approver_user_id = models.UUIDField(null=True, blank=True)
    approver_client_info = models.CharField(
        max_length=256, blank=True, default="",
        help_text="例：'Electron 0.12.3 on macOS 14.2' / 'iOS 1.0 build 42'",
    )

    # ── 上下文 ──────────────────────────────────────────────────────
    runtime_mode = models.CharField(
        max_length=16, choices=RUNTIME_MODE_CHOICES,
        help_text="interactive / solo / scheduled / batch（PRD §1.2）",
    )
    skill_context = models.JSONField(
        null=True, blank=True,
        help_text="Skill 触发时的上下文 { skill_id, source, permissions_approved }",
    )

    rejection_message = models.TextField(
        blank=True, default="",
        help_text="用户拒绝时填的理由（来自 ApprovalDecision.rejection_message）",
    )

    created_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        app_label = "agent_engine"
        db_table = "agent_engine_permission_audit"
        verbose_name = "审批审计记录"
        verbose_name_plural = "审批审计记录"
        indexes = [
            # AdminDash 单 Agent 时序回放（北极星 §1.3 主查询）
            models.Index(
                fields=["agent_id", "-created_at"],
                name="idx_permaudit_agent_time",
            ),
            models.Index(
                fields=["workspace_id", "-created_at"],
                name="idx_permaudit_workspace_time",
            ),
            # 单会话回放
            models.Index(
                fields=["thread_id", "-created_at"],
                name="idx_permaudit_thread_time",
            ),
            # 按批聚合（同批 N 行同 batch_id）
            models.Index(
                fields=["batch_id"],
                name="idx_permaudit_batch",
                condition=models.Q(batch_id__isnull=False),
            ),
            # Organization 级审计（admin / 合规导出）
            models.Index(
                fields=["organization_id", "-created_at"],
                name="idx_permaudit_organization_ts",
            ),
            # 按 outcome 统计（"昨晚 23 次审批 / 18 allow / 5 deny"）
            models.Index(
                fields=["decision", "-created_at"],
                name="idx_permaudit_decision_time",
            ),
        ]
        # W2-轮 1 自修复：双广播（mirror publish + daemon→runtime→relay 转发）
        # 会让同一 batch 的 approval_resolved 事件在 relay_handler 重复触发，
        # 导致 _persist_approval_resolved 二次 bulk_create 双行。用唯一约束兜底，
        # 写入侧用 ``ignore_conflicts=True`` 静默去重，保证审计行幂等。
        constraints = [
            models.UniqueConstraint(
                fields=["request_id"],
                name="uq_permaudit_request_id",
            ),
        ]

    def __str__(self):
        return (
            f"<PermissionAudit {self.id} {self.decision}/{self.source} "
            f"tool={self.tool_name} agent={self.agent_id}>"
        )


# ── CLI 治理层模型（Wave A-A2，PRD-v3 §5.1 第 5 项）────────────────────
# 物理文件位于 ``cli/models.py`` 是为了与 spec / parser / rules 同一目录内聚；
# 通过本处显式 import 让 Django app registry 在 agent_engine app load 时
# 发现 ``CliAuditEvent``，确保 ``makemigrations agent_engine`` 与
# ``migrate agent_engine --database=postgresql`` 都能识别该模型。
# Meta.app_label='agent_engine' 已在 cli/models.py 内显式声明。
from apps.services.agent_engine.cli.models import CliAuditEvent  # noqa: E402,F401


# ─── 专题"Agent 产物在 Space 内的打开" Wave 2 埋点表 ──────────────────────────
#
# 业务目标（PRD §6 标准 1/2/3 + RFC v1.0 §8）：让上线 14 天后能用 SQL 跑出
#   - 可见率：所有 trigger_source 的 outcome 分布（在 Space 打开 vs 系统应用 vs 异常）
#   - 异常 deny = 0：denied_known_bad / error 数量必须为 0
#   - resolve_source 5 层 + ⌘ 短路 6 个 tag 的分布——给 PM 打分配套数据
#
# 上报通路（W7 接通；W2 只落表）：
#   renderer ResourceRouter.emitEvent → IPC → main 进程 telemetry queue
#   → HTTP POST /api/services/telemetry/resource_open/batch
#   → Django bulk_create 到本表
#
# pointer_id_hash 不是明文：用客户端的同步 hash（router.ts:hashPointerId）
# 保护 url / 业务 ID 隐私。详见 RFC §8.1 拒绝清单"写死 pointer_id 不 hash"。
class ResourceOpenEvent(models.Model):
    """ResourceRouter 派发事件埋点表（PRD §6 验收支撑）。"""

    id = models.BigAutoField(primary_key=True)

    event_name = models.CharField(
        max_length=64,
        help_text="resource_open.triggered / resource_open.resolved / resource_open.failed",
    )
    trigger_source = models.CharField(
        max_length=32,
        help_text=(
            "chat_markdown / open_in_space_tool / rich_resource_card / "
            "user_paste / window_open_fallback"
        ),
    )

    # ─── Pointer 维度 ──────────────────────────────────────────
    pointer_scheme = models.CharField(
        max_length=32,
        help_text="tabtin / http / https / file / mailto / tel / 其他",
    )
    pointer_type = models.CharField(
        max_length=64,
        null=True,
        blank=True,
        help_text="自有格式 ContextRefType；行业格式 NULL",
    )
    pointer_id_hash = models.CharField(
        max_length=16,
        help_text=(
            "16 hex 字符不可逆同步 hash（djb2 + FNV-1a 双轨；非 SHA256 —— "
            "SubtleCrypto.digest 是 async 与 router emit 同步语义不兼容）。"
            "隐私目标：避免泄露明文 url 路径 / 业务 ID；统计聚合用 "
            "pointer_scheme + pointer_type 维度即可，不需要原文"
        ),
    )

    # ─── D2 优先级 5 层各打 tag ──────────────────────────────
    hint_app_id = models.CharField(max_length=64, null=True, blank=True)
    resolved_carrier_app_id = models.CharField(max_length=64, null=True, blank=True)
    resolve_source = models.CharField(
        max_length=32,
        help_text=(
            "user_pref / session_override / agent_hint / manifest_default / "
            "system_fallback / modifier_key"
        ),
    )

    # ─── Outcome（PRD §6 标准 2 五分支 + 异常 deny） ────────
    outcome = models.CharField(
        max_length=32,
        help_text="in_space_opened / system_app_opened / denied_known_bad / error",
    )

    # ─── 上下文 ─────────────────────────────────────────────
    space_id = models.UUIDField(db_index=True)
    user_id = models.UUIDField(db_index=True)
    organization_id = models.UUIDField(db_index=True)
    agent_run_id = models.UUIDField(null=True, blank=True)
    message_id = models.UUIDField(null=True, blank=True)
    tool_call_id = models.CharField(max_length=128, null=True, blank=True)

    # ─── 性能 / 时间 ────────────────────────────────────────
    duration_ms = models.IntegerField(default=0)
    ts = models.DateTimeField(
        db_index=True,
        help_text="客户端事件发生时间（ms epoch 转换为 UTC datetime）",
    )

    # ─── 错误 / 客户端 ──────────────────────────────────────
    error_message = models.TextField(null=True, blank=True)
    client = models.CharField(
        max_length=16,
        default="electron",
        help_text="electron / daemon / ios / android",
    )
    client_version = models.CharField(max_length=32, default="")

    created_at = models.DateTimeField(
        auto_now_add=True,
        db_index=True,
        help_text="服务端落表时间，便于排查上报延迟",
    )

    class Meta:
        app_label = "agent_engine"
        db_table = "agent_engine_resource_open_event"
        indexes = [
            # PRD §6 标准 1 主查询：按 outcome × ts 聚合
            models.Index(
                fields=["ts", "outcome"],
                name="idx_aeroe_ts_outcome",
            ),
            # 单 organization 时序回放
            models.Index(
                fields=["organization_id", "ts"],
                name="idx_aeroe_organization_ts",
            ),
            # PRD §6 标准 2 异常 deny 抽样
            models.Index(
                fields=["outcome", "ts"],
                name="idx_aeroe_outcome_ts",
            ),
            # 触发源分布（D3 三种形式 + 用户主动 + window.open fallback）
            models.Index(
                fields=["trigger_source", "ts"],
                name="idx_aeroe_trigger_ts",
            ),
        ]

    def __str__(self):
        return (
            f"<ResourceOpenEvent {self.id} {self.outcome}/{self.resolve_source} "
            f"{self.pointer_scheme}:{self.pointer_type or '-'} ts={self.ts.isoformat()}>"
        )


__all__ = [
    "ExecutionTrace", "TraceEvent", "ExecutionRun", "RunHostLease",
    "SessionReadReceipt",
    "SubtaskRun",
    "ConversationState", "SubAgentTemplate", "SubAgentTemplateVersion",
    "MonitorTask", "PermissionAudit", "CliAuditEvent",
    "ResourceOpenEvent",
]
