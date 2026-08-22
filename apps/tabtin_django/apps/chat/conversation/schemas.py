"""
Conversation Pydantic Schemas

定义API请求和响应的数据结构
"""

from typing import Any, Literal, Optional, List
from datetime import datetime
from pydantic import AliasChoices, BaseModel, ConfigDict, Field

from apps.chat.conversation._generated_context_fields import GeneratedContextFieldsMixin, GENERATED_CONTEXT_FIELDS  # noqa: F401


# ============ 共享子模型 ============


class DiffFileSummary(BaseModel):
    """单个文件的变更摘要"""
    file: str = Field(..., description="文件路径")
    changes: int = Field(0, description="变更行数")
    insertions: int = Field(0, description="新增行数")
    deletions: int = Field(0, description="删除行数")
    binary: bool = Field(False, description="是否为二进制文件")
    status: Optional[str] = Field(
        None,
        description="git name-status 归一（added/modified/deleted）；老数据缺失",
    )


class DiffSummary(BaseModel):
    """Shadow Git 文件变更摘要"""
    changed: int = Field(0, description="变更文件数")
    insertions: int = Field(0, description="总新增行数")
    deletions: int = Field(0, description="总删除行数")
    files: Optional[List[DiffFileSummary]] = Field(None, description="各文件变更详情")


# ============ 请求Schemas ============

class CreateSessionRequest(BaseModel):
    """创建会话请求"""
    model_config = ConfigDict(protected_namespaces=())
    session_id: Optional[str] = Field(
        None,
        description="客户端生成的会话 UUID；重试同一创建请求时复用，作为幂等键",
    )
    agent_id: str = Field(..., description="初始当前 Agent ID")
    workspace_id: Optional[str] = Field(None, description="执行 Workspace ID；空为 observer 会话")
    target_device_id: Optional[str] = Field(
        None,
        max_length=64,
        description="Daemon Control 目标设备 ID；创建后冻结",
    )
    project_id: Optional[str] = Field(None, description="协作 Project ID；个人会话不传")
    # 仅为已发布客户端保留一个发布周期。服务端会按真实 host 类型归一到
    # workspace_id / project_id，内部不再持久化这一多义输入。
    space_id: Optional[str] = Field(None, description="[兼容] 旧客户端的 Workspace/Project 作用域 ID")
    organization_id: Optional[str] = Field(None, description="组织ID（兼容字段，可选）")
    model_id: Optional[str] = Field(None, description="初始使用的模型 UUID")
    agent_mode: Optional[str] = Field(None, description="初始 AgentMode")
    approval_mode: Optional[Literal['always_ask', 'auto', 'full_access']] = Field(
        None,
        description="会话审批请求档位",
    )


class QuickStartSessionRequest(CreateSessionRequest):
    """草稿预建：创建会话并可选写入初始上下文（合并 create + context PUT + GET）。"""
    current_space_id: Optional[str] = Field(None, description="当前资源宿主 ID（非协作 Project）")
    current_project_id: Optional[str] = Field(None, description="当前协作 Project ID")
    current_app_type: Optional[str] = Field(None, description="当前 App 类型")
    open_tabs: Optional[list] = Field(None, description="当前打开的标签页")


class QuickStartSessionResponse(BaseModel):
    """quick-start 响应：session + group_runtime + 客户端指纹。"""
    session: dict
    group_runtime: Optional[dict] = None
    context_fingerprint: Optional[str] = None


class ForkSessionRequest(BaseModel):
    """Fork 会话请求"""
    fork_anchor_message_id: Optional[str] = Field(
        None,
        description="Agent Host transcript 中的分叉锚点消息 ID。客户端点击消息时优先传此字段。",
    )
    message_id: Optional[str] = Field(
        None,
        description="兼容旧客户端：服务端 ChatMessage PK。不指定则 fork 到最新消息。",
    )


class SharedForkRequest(BaseModel):
    """共享任务 fork 请求：把会话快照抄到接收人自己的 Agent × Workspace。"""
    agent_id: str = Field(..., description="接收人自己的 Agent ID")
    workspace_id: str = Field(..., description="接收人自己的执行 Workspace ID")
    share_id: Optional[str] = Field(
        None,
        description="当前共享卡的授权 ID；新客户端必传，旧客户端缺省时回退最新授权。",
    )


class SharedChatRequest(BaseModel):
    """共享对话请求（ can_chat 发言驱动）：grantee 在 owner 会话里发言。"""
    text: str = Field(..., min_length=1, max_length=8000, description="发言内容")
    share_id: Optional[str] = Field(
        None,
        description="当前共享卡授权 ID；新客户端必传，旧客户端缺省时回退最新授权。",
    )
    client_message_id: Optional[str] = Field(
        None,
        max_length=36,
        description="客户端消息 UUID；用于网络重试时复用同一次 Agent 驱动。",
    )


class SharedFilePreviewRequest(BaseModel):
    """共享会话本地文件按需预览。"""
    path: str = Field(..., min_length=1, max_length=1024, description="工作区相对路径")
    timeout_seconds: int = Field(25, ge=5, le=120, description="设备响应超时秒数")
    share_id: Optional[str] = Field(
        None,
        description="当前共享卡授权 ID；新客户端必传，旧客户端缺省时保留原访问语义。",
    )


class UpdateSessionRequest(BaseModel):
    """更新会话请求"""
    title: Optional[str] = Field(None, max_length=255, description="会话标题")
    status: Optional[str] = Field(None, description="会话状态：active/completed/archived")
    agent_id: Optional[str] = Field(None, description="下一轮默认 Agent")
    workspace_id: Optional[str] = Field(None, description="执行 Workspace；显式 null 切为 observer")
    # ：Composer「工作方式」跨端即时同步；与 SELECTABLE_AGENT_MODES 对齐。
    # 可选字段——旧客户端不传则行为不变。
    agent_mode: Optional[Literal['ask', 'agent', 'plan', 'group']] = Field(
        None,
        description="会话级 AgentMode（Composer 工作方式）；不传则不变",
    )
    approval_mode: Optional[Literal['always_ask', 'auto', 'full_access']] = None
    is_pinned: Optional[bool] = Field(None, description="当前用户是否置顶该会话；不传则不变")


# ============ 响应Schemas ============

class ChatMessageSchema(BaseModel):
    """消息Schema（W3 §3.3.5 ContentBlock[] 改造版 + W4c 字段名收口 + W1b 协议层 message_kind）。

    W4c 字段重命名（收口 W3 留下的明示 TODO）：
    - `blocks_json` → `content_blocks_json`（与 W3 Model `ChatMessage.content_blocks_json`
      字段名对齐；前端 W4c 同步切换 `packages/tabtin-chat-client/src/types/message.ts`
      ChatMessage 接口字段名）

    W3 起源字段：
    - `content` 字段语义改为 `text_summary`（向后兼容，前端不需要改字段名）
    - `attachments_json` 已下线（始终返空数组），并入 `content_blocks_json` 的
      image/document/file 块；W4c 保留字段名兼容 user 消息的附件信息（Wave 8 全清）
    - `agent_type` / `intent` 已下线（始终返 None）
    - `text_summary`（新顶层字段，与 content 相同语义；前端可二选一读）
    - `stop_reason` / `usage_json` / `error_info_json` / `subagent_run_id` /
      `model_name_snapshot` / `checkpoint_anchor_block_id` / 等结构化新字段

    W1b 协议层 message_kind 新增字段（PRD §3.6.1 + §3.6.4）：
    - `message_kind`：三档 enum（llm / tool_artifact / error_envelope），让前端按字段
      switch 不同 UI 形态（LLM 主气泡 / 工具产物气泡 / 错误文案气泡）。default='llm'
      与 Model 字段一致，保证老消息 / 老客户端读取行为不变。
    - `has_artifacts`：仅 message_kind='llm' 主消息可能为 true——表示同 agent_run_id
      下有 tool_artifact ChatMessage 待懒加载。配合历史 API ?expand_artifacts=false
      默认懒加载策略，前端按需触发"展开产物气泡"。
    """
    model_config = ConfigDict(from_attributes=True, protected_namespaces=())
    id: str
    role: str
    agent_id: Optional[str] = None
    agent_name: Optional[str] = None
    agent_avatar: Optional[str] = None
    client_event_id: Optional[str] = None
    # W3：与新 ChatMessage.text_summary 字段语义一致；保留 content 字段名向后兼容
    content: str
    # W4c：字段名 `blocks_json` → `content_blocks_json`（对齐 W3 Model 字段名）
    content_blocks_json: Optional[List[dict]] = None
    attachments_json: Optional[List[dict]] = None
    agent_type: Optional[str] = None
    intent: Optional[str] = None
    trace_id: Optional[str] = None
    model_id: Optional[str] = None
    model_name: Optional[str] = None
    sender_user_id: Optional[str] = None
    sender_display_name: Optional[str] = None
    checkpoint_hash: Optional[str] = None
    checkpoint_state_index: Optional[int] = None
    diff_summary: Optional[DiffSummary] = None
    checkpoint_record: Optional['CheckpointRecordView'] = None
    agent_run_id: Optional[str] = None
    metadata: Optional[dict] = None
    # ── W3 §3.3.1 新顶层结构化字段（前端 W4c 起读这些字段，不再读 metadata 子键） ──
    text_summary: Optional[str] = None
    stop_reason: Optional[str] = None
    usage_json: Optional[dict] = None
    error_info_json: Optional[dict] = None
    subagent_run_id: Optional[str] = None
    model_name_snapshot: Optional[str] = None
    checkpoint_anchor_block_id: Optional[str] = None
    checkpoint_anchor_block_index: Optional[int] = None
    # ── W1b 协议层 message_kind 三档（PRD §3.6.1）────────────────────────────
    # default='llm' 与 Model 字段一致——新增字段时所有老消息自动覆盖；
    # 前端 fallback `message_kind ?? 'llm'` 兼容老 build（W2 起读此字段路由 UI 形态）。
    # ：environment_context —— 落库的 environment 快照块（role=system），UI 隐藏但喂 LLM。
    # ：agent_profile_context —— 落库的 agent-profile 块（role=system），UI 隐藏；LLM keep-latest。
    # system_prompt_context —— 落库的 system prompt 快照块（role=system），UI 隐藏；
    # ：仅审计 / AdminDash 回退，不进 LLM 历史（本轮规则走 system）。
    # ：hitl_interaction —— 审批 / 追问持久化事实（metadata.hitl 承载状态），UI 隐藏且不喂 LLM。
    message_kind: Literal[
        'llm',
        'tool_artifact',
        'error_envelope',
        'environment_context',
        'agent_profile_context',
        'system_prompt_context',
        'compaction_summary',
        'hitl_interaction',
        'external_archive_context',
    ] = 'llm'
    # 同 agent_run_id 下是否有 tool_artifact ChatMessage 等待懒加载（PRD §3.6.4）。
    # 仅 message_kind='llm' 主消息可能为 true；tool_artifact / error_envelope 始终 false。
    # 配合 API ?expand_artifacts=false 默认懒加载，前端按需"展开产物气泡"。
    has_artifacts: bool = False
    # ──  引用回复 ────────────────────────────────────────────────
    # reply_to_message_id：被引用消息 PK（同 session）；被引用消息删除后为 None。
    # reply_to_preview：被引用消息展示快照 { role, author, text }，气泡引用条渲染用。
    reply_to_message_id: Optional[str] = None
    reply_to_preview: Optional[dict] = None
    created_at: datetime
    updated_at: datetime


class ChatSessionSchema(BaseModel):
    """会话Schema"""
    id: str
    title: str
    status: str
    is_pinned: bool = False
    pinned_at: Optional[datetime] = None
    is_paused: bool = False
    organization_id: str
    project_id: Optional[str] = None
    # 过渡期 UI scope：Project 会话返回 project_id，个人会话返回 workspace_id。
    # 新建接口不再接收这个多义字段。
    space_id: Optional[str] = None
    workspace_id: Optional[str] = None
    execution_target: Optional[dict[str, Any]] = Field(
        None,
        description="服务端解析的执行设备目标；旧客户端可忽略",
    )
    target_device_id: Optional[str] = None
    agent_id: Optional[str] = None
    # 可公开展示的当前 Agent 快照。共享访问者无需读取 owner-only Agent 详情。
    agent_name: Optional[str] = None
    agent_avatar: Optional[str] = None
    agent_mode: str = ''
    approval_mode: Literal['always_ask', 'auto', 'full_access'] = 'always_ask'
    thread_id: Optional[str] = None
    current_model_id: Optional[str] = None
    current_model_name: Optional[str] = None
    default_model_id: Optional[str] = None
    default_model_name: Optional[str] = None
    context_tier_id: Optional[str] = None
    model_param_overrides: Optional[dict[str, Any]] = None
    created_at: datetime
    updated_at: datetime
    last_message_at: Optional[datetime] = None
    message_count: Optional[int] = None
    last_message_preview: Optional[str] = None
    has_active_task: bool = False
    last_run_failed: bool = False
    run_state: Optional['SessionRunStateSchema'] = None
    input_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0
    cache_read_input_tokens: int = 0
    cache_creation_input_tokens: int = 0
    # DEPRECATED (2026-05-10): messages-as-truth 改造后此字段始终为 0
    # —— renderer ring 用量改从 ChatMessage.metadata.last_input_tokens 派生。
    # 字段保留在 schema 仅为 wire 层向下兼容（避免老前端构建破坏）；
    # 下次 schema breaking change 时可一并删除。详见
    # `apps/tabtin_django/apps/chat/conversation/models.py` 的字段注释。
    context_tokens: int = 0
    compaction_count: int = 0
    last_compaction_at: Optional[datetime] = None
    revert_snapshot_hash: Optional[str] = None
    rollback_state: Optional['SessionRollbackStateView'] = None
    # 标题是否仍是默认值（"新对话"等各语言翻译）。前端用它决定是否要在打开会话时
    # 触发兜底 generate-title——单 source of truth 由后端 TitleGeneratorService 算，
    # 避免前端硬编码 i18n 字符串集合跟后端漂移。
    title_is_default: bool = False
    # 标题生成的后台状态；列表 UI 不展示 failed 徽标（详见 ChatSession.title_generation_status）。
    title_generation_status: Optional[Literal['pending', 'in_progress', 'done', 'failed']] = None
    forked_from_id: Optional[str] = None
    fork_point_message_id: Optional[str] = None
    fork_count: int = 0
    fork_copy_status: Optional[Literal['pending', 'complete', 'failed']] = None
    warnings: List[str] = []
    # ：同步 fork 完成后返回旧 tool id → tu_*，本机归档 remap 与云端共用。
    # 异步 fork 时复制尚未完成，此字段为 None。
    tool_id_remap: Optional[dict[str, str]] = None
    # Wave 5 (charter v1.8 §6.7): ChatSession 关联的 GoalRun 反向冗余字段（只读）。
    # 前端用此渲染 4 个 UI 表达点（breadcrumb / icon / system msg / status indicator）。
    # 非 Tracker Run 关联的 ChatSession 此字段为 None。
    tracker_run: Optional[dict] = None
    # 任务列表锚点主工作面（chat/doc/browser/code）；缺省 chat。
    primary_surface: Literal['chat', 'doc', 'browser', 'code'] = 'chat'
    # ：TabChat @Agent 内部执行会话。任务侧栏与 activity 共用此字段；
    # 旧客户端可忽略。真源是 AgentMentionJob.session_id / ChatContext._invoked_from。
    is_agent_mention_session: bool = False
    model_config = ConfigDict(from_attributes=True)


class ChatSessionListResponse(BaseModel):
    """会话列表响应"""
    sessions: List[ChatSessionSchema]
    total: int
    excluded_agent_mention_session_ids: List[str] = Field(default_factory=list)
    # 隐患 5 / 方案 ①(charter v1.8 §6.7 主侧栏分桶):当 ``include_tracker_runs=False``
    # (默认)时,后端在 ``sessions`` 中已剔除关联 TrackerRun 的 ChatSession,
    # 这里附带"被剔除掉的 Tracker session 数量",供前端在「自动化任务执行记录」
    # 折叠分组 header 上展示 count badge,避免折叠状态下数字消失。
    # 不返回 sessions 本体——展开分组时前端再带 ``include_tracker_runs=true``
    # 单独 fetch。当 ``include_tracker_runs=True`` 或跨库查询失败回退到不分桶
    # 行为时,该字段为 None(前端 fallback "无法计数")。
    tracker_run_count: Optional[int] = None


class ChatSessionWithAgentSchema(BaseModel):
    """跨 Space 对话列表精简 Schema — 只含列表展示所需字段"""
    model_config = ConfigDict(from_attributes=True)
    id: str
    title: str
    status: str
    is_pinned: bool = False
    pinned_at: Optional[datetime] = None
    organization_id: str
    space_id: Optional[str] = None
    workspace_id: Optional[str] = None
    execution_target: Optional[dict[str, Any]] = Field(
        None,
        description="服务端解析的执行设备目标；旧客户端可忽略",
    )
    created_at: datetime
    updated_at: datetime
    last_message_at: Optional[datetime] = None
    message_count: Optional[int] = None
    last_message_preview: Optional[str] = None
    rollback_state: Optional['SessionRollbackStateView'] = None
    # 同 ChatSessionSchema.title_is_default 说明。
    title_is_default: bool = False
    # 同 ChatSessionSchema.title_generation_status 说明。
    title_generation_status: Optional[Literal['pending', 'in_progress', 'done', 'failed']] = None
    # Agent 元信息
    space_name: Optional[str] = None
    project_id: Optional[str] = None
    project_name: Optional[str] = None
    agent_id: Optional[str] = None
    agent_name: Optional[str] = None
    agent_icon: Optional[str] = None
    agent_avatar: Optional[str] = None
    agent_type: Optional[str] = None
    # 活跃状态
    has_active_task: bool = False
    has_unread_reply: bool = False
    read_state: Optional['SessionReadStateSchema'] = None
    last_run_failed: bool = False
    run_state: Optional['SessionRunStateSchema'] = None
    # 共享来源
    # 搜索命中上下文（仅 keyword 搜索时返回，展示命中的消息片段）
    search_match_context: Optional[str] = None
    # Wave 5 (charter v1.8 §6.7): GoalRun 反向冗余，跨 Space 主列表也需要 tracker_run
    # 才能让前端 SidebarConversationList → ChatSessionSwitcher 正确分组 trackerRuns。
    # 缺此字段会让 charter §6.7 表达点 #2(主列表 Tracker Runs 分组) 完全失效。
    tracker_run: Optional[dict] = None
    # 同 ChatSessionSchema.primary_surface。
    primary_surface: Literal['chat', 'doc', 'browser', 'code'] = 'chat'


class SessionRunStateSchema(BaseModel):
    """服务端权威的会话当前运行态。"""

    run_id: str
    sequence: int
    revision: int
    status: Literal[
        'queued',
        'running',
        'waiting_user',
        'paused',
        'cancelling',
        'completed',
        'failed',
        'cancelled',
        'interrupted',
    ]
    queue_depth: int
    started_at: Optional[datetime] = None
    state_changed_at: datetime
    ended_at: Optional[datetime] = None
    stop_reason: Optional[str] = None
    error_class: Optional[str] = None
    waiting_interaction_id: Optional[str] = None


class SessionReadAckRequest(BaseModel):
    through_run_id: str
    through_revision: int
    mutation_id: Optional[str] = None


class SessionReadStateSchema(BaseModel):
    last_read_run_sequence: int
    last_read_terminal_revision: int
    read_at: Optional[datetime] = None
    latest_completed_run_id: Optional[str] = None
    latest_completed_run_sequence: Optional[int] = None
    latest_completed_terminal_revision: Optional[int] = None


class AllSessionListResponse(BaseModel):
    """跨 Space 会话列表响应"""
    sessions: List[ChatSessionWithAgentSchema]
    total: int
    has_more: bool = False
    # 同 ChatSessionListResponse.tracker_run_count(隐患 5 / 方案 ①)。跨 Space
    # 主列表的 tracker_run_count 统计的是当前 organization 范围(已经按 user / agent
    # 过滤完)的"是 Tracker session 的 ChatSession 数量"。
    tracker_run_count: Optional[int] = None


class MessageListResponse(BaseModel):
    """消息列表响应"""
    messages: List[ChatMessageSchema]
    total: int
    has_more: bool = False
    oldest_id: Optional[str] = None
    newest_id: Optional[str] = None
    # 增量同步水位：客户端本轮分页必须固定此上界，完整拉完后再作为
    # 下一次 updated_after，避免查询过程中提交的新更新被游标跳过。
    server_timestamp: Optional[datetime] = None
    # PRD-04 Wave 5 任务 1：下发 BillingRuntimeConfig.show_per_message_cost。
    # 前端 useBillingStore.showPerMessageCost 默认 false，必须由此字段显式打开
    # MessageCostLabel；没有该字段等价于对所有用户隐藏费用标签。
    show_per_message_cost: bool = False


# ============ 模型管理 Schemas（新增）============

class SwitchModelRequest(BaseModel):
    """切换模型请求"""
    model_config = ConfigDict(protected_namespaces=())
    model_id: str = Field(..., description="目标模型 UUID")
    context_tier_id: Optional[str] = Field(
        default=None,
        description=(
            "上下文档位 ID（如 'standard' / 'long_1m'），"
            "对应 LLMModel.custom_billing_config.tiered_pricing.tiers[].id；"
            "省略或空字符串 = 走模型默认档"
        ),
    )


class SwitchModelResponse(BaseModel):
    """切换模型响应"""
    success: bool
    session_id: str
    previous_model_id: Optional[str]
    previous_model_name: Optional[str]
    current_model_id: str
    current_model_name: str
    context_tier_id: Optional[str] = None
    message: str


class SwitchContextTierRequest(BaseModel):
    """切换上下文档位请求"""
    model_config = ConfigDict(protected_namespaces=())
    context_tier_id: Optional[str] = Field(
        default=None,
        description="目标档位 ID；空字符串或 null 表示重置为模型默认档",
    )


class SwitchContextTierResponse(BaseModel):
    """切换上下文档位响应"""
    success: bool
    session_id: str
    previous_tier_id: Optional[str]
    current_tier_id: Optional[str]
    message: str


class UpdateModelParamsRequest(BaseModel):
    """更新会话级 Runtime Profile 意图。

    接受 v2 ``{v:2, thinking_mode:...}`` 或旧客户端 v1 ``{reasoning_effort:...}``;
    服务端归一化为 v2 落库。不接受 / 不持久化 resolved。
    """
    model_config = ConfigDict(protected_namespaces=())
    model_param_overrides: dict[str, Any] = Field(default_factory=dict)


class UpdateModelParamsResponse(BaseModel):
    """模型运行参数更新响应(含旧客户端 reasoning_effort 兼容投影)。"""
    success: bool
    session_id: str
    model_param_overrides: dict[str, Any]


# ============ 上下文管理 Schema（阶段4.5）============


class GroupRuntimeRoleInput(BaseModel):
    """会话内协作角色（v1 直接引用 SubAgentTemplate）"""

    template_id: str = Field(..., description="SubAgentTemplate ID")
    enabled: bool = Field(default=True, description="该角色是否启用")


class GroupRuntimeConfig(BaseModel):
    """group 模式运行时配置"""

    enabled: bool = Field(default=False, description="是否启用 group runtime")
    orchestration_mode: Literal["parallel", "round_robin", "moderated", "free"] = Field(
        default="parallel",
        description="协作编排模式",
    )
    lead_role: Literal["lead_agent"] = Field(
        default="lead_agent",
        description="v1 固定由当前 Space 的当前 Agent 主持",
    )
    summary_style: Literal["summary_only", "summary_plus_details"] = Field(
        default="summary_only",
        description="当前 Agent 对外汇总粒度",
    )
    roles: List[GroupRuntimeRoleInput] = Field(default_factory=list, description="参与协作的角色模板")


class ContextResponse(BaseModel):
    """上下文响应"""
    current_space_id: str = ""
    current_project_id: str = ""
    current_table_id: str = ""
    current_view_id: str = ""
    recent_spaces: List[str] = []
    recent_tables: List[str] = []
    recent_views: List[str] = []
    context_data: dict[str, Any] = {}
    group_runtime: Optional[GroupRuntimeConfig] = None


class UpdateContextRequest(GeneratedContextFieldsMixin):
    """更新上下文请求

    前端可传任意字段：
    - current_space_id / current_project_id / current_table_id / current_view_id → 存专用列
    - current_app_type / current_doc_id / current_browser_url 等 → 存 context_data

    Per-app 字段由 GeneratedContextFieldsMixin 自动继承，无需手动维护。
    运行 `python scripts/generate-context-types.py` 可更新 mixin。
    """
    # ── 平台字段 ──
    current_space_id: Optional[str] = None
    current_project_id: Optional[str] = None
    current_app_type: Optional[str] = None
    sandbox_path: Optional[str] = None
    current_folder_path: Optional[str] = None
    # apphome 类 tab 聚焦时由前端注入：标记用户在哪个 App 的列表/首页（非具体资源）。
    # 跟 GeneratedContextFieldsMixin 区分开是因为 apphome 不是 App 而是平台级 tab 类型，
    # 不能放在 packages/apps/<app>/app.json 的 contextFields 里生成。
    current_app_home: Optional[str] = None
    open_tabs: Optional[list] = None
    group_runtime: Optional[GroupRuntimeConfig] = None


# ============ 会话压缩 Schema ============

class CompactSessionRequest(BaseModel):
    """会话压缩请求"""
    force: bool = Field(default=False, description="强制生成摘要（忽略是否超限）")
    keep_last_messages: int = Field(default=20, ge=0, description="保留最近消息数")
    summary_max_tokens: int = Field(default=800, ge=200, description="摘要最大 token 数")


class CompactSessionResponse(BaseModel):
    """会话压缩响应（仅成功路径）。

    Wave 1 A2 改造：去掉 ``success`` 字段——session 不存在走
    ``err_response('NOT_FOUND', ...)`` envelope，这里只承载"操作完成后的本轮结果"。
    ``compacted=False + reason`` 表示"操作完成但本轮没有真的压缩"（譬如未超 token
    预算 / 没消息），这是合法的 ok 路径。
    """
    compacted: bool
    summary: Optional[str] = None
    reason: Optional[str] = None
    message_count: Optional[int] = None
    keep_last_messages: Optional[int] = None
    compaction_count: Optional[int] = None
    last_compaction_at: Optional[datetime] = None


class CompactionCheckpointRequest(BaseModel):
    """把 runtime 生成的摘要持久化成会话历史检查点。"""
    summary: str = Field(..., min_length=1, description="压缩摘要正文")
    compacted_up_to_message_id: str = Field(..., description="该消息及之前的历史已被摘要覆盖")
    source: Literal['manual', 'auto'] = Field(default='manual', description="压缩来源")
    focus: Optional[str] = Field(default=None, description="手动 /compact 的用户侧重")
    stats: Optional[dict] = Field(default=None, description="压缩统计信息")
    client_event_id: Optional[str] = Field(default=None, description="幂等事件 id")


class CompactionCheckpointResponse(BaseModel):
    message: ChatMessageSchema


# ============ 检查点回滚 Schema ============

class CheckpointCapabilityScopeView(BaseModel):
    """Checkpoint 能力范围聚合。"""
    message_preview: bool = True
    file_diff: bool = False
    file_restore: bool = False
    resource_restore: bool = False
    unrevert: bool = False


class CheckpointResourceSnapshotRefView(BaseModel):
    """结构化资源快照引用。"""
    space_checkpoint_id: Optional[str] = None
    has_version_refs: bool = False
    version_ref_count: int = 0
    agent_run_id: Optional[str] = None


class CheckpointConversationStateRefView(BaseModel):
    """对话运行态锚点。"""
    checkpoint_state_index: Optional[int] = None


class CheckpointImpactSummaryView(BaseModel):
    """版本点影响摘要。"""
    file_summary: Optional[DiffSummary] = None
    resource_change_count: int = 0
    resource_restore_count: int = 0
    messages_to_remove: int = 0


class CheckpointImpactDetailView(BaseModel):
    """各 App 类型的变更影响详情（代码文件 + 结构化资源统一）。"""
    files: Optional[List[str]] = None
    files_truncated: bool = False
    files_total_count: int = 0
    resources: Optional[List[dict]] = None
    resources_truncated: bool = False
    resources_total_count: int = 0


class CheckpointContextView(BaseModel):
    """决策上下文——回答「这个版本点为什么产生」。

    字段对齐：本 schema 是后端 → 前端 `@tabtin/chat-client.CheckpointContext` 的契约。
    三端（Python Pydantic / TypeScript chat-client / VersionPanel item.checkpoint_context）
    字段名与语义必须严格一致；新增字段默认 `Optional` 以保证向后兼容。

    NOTE(Wave 13)：若后续新增 `GET /collab/v1/space-checkpoint/{id}/decision-context` API，
    可直接复用此 schema；如需聚合 `anchor_session_id` / `version_refs` 等 checkpoint 一等字段，
    再新建 `DecisionContextView`（见 PRD §4.3.3）。
    """
    user_prompt: Optional[str] = None
    session_id: Optional[str] = None
    assistant_message_id: Optional[str] = None
    user_message_id: Optional[str] = None
    agent_run_id: Optional[str] = None
    intent_summary: Optional[str] = None
    decision_summary: Optional[dict] = None
    sub_conversations: Optional[List[dict]] = None
    impact: Optional[CheckpointImpactDetailView] = None


class CheckpointRecordView(BaseModel):
    """用户可见的 checkpoint 聚合视图。"""
    checkpoint_id: str
    session_id: str
    anchor_type: str = "assistant_turn"
    anchor_message_id: Optional[str] = None
    anchor_agent_run_id: Optional[str] = None
    created_at: Optional[datetime] = None
    file_snapshot_ref: Optional[str] = None
    resource_snapshot_ref: Optional[CheckpointResourceSnapshotRefView] = None
    conversation_state_ref: Optional[CheckpointConversationStateRefView] = None
    status: Literal['ready', 'degraded', 'unavailable', 'superseded'] = 'ready'
    capability_scope: CheckpointCapabilityScopeView = Field(default_factory=CheckpointCapabilityScopeView)
    degraded_reasons: List[str] = Field(default_factory=list)
    impact_summary: Optional[CheckpointImpactSummaryView] = None
    context_summary: Optional[CheckpointContextView] = None
    trigger: Optional[str] = None
    visible_in_history: Optional[bool] = None


class RollbackImpactFilesView(BaseModel):
    available: bool = False
    diff_available: bool = False


class RollbackImpactResourcesView(BaseModel):
    available: bool = False
    change_count: int = 0
    restore_count: int = 0


class RollbackImpactMessagesView(BaseModel):
    to_remove: int = 0


class RollbackTableImpactChangesView(BaseModel):
    """单表的字段级变更摘要（来源 :class:`apps.tabdata.contributors.TableImpactContributor`）。"""
    records_inserted: int = 0
    records_updated: int = 0
    records_deleted: int = 0
    fields_added: list[str] = Field(default_factory=list)
    fields_removed: list[str] = Field(default_factory=list)


class RollbackTablePreviewView(BaseModel):
    """单表的回滚预览（来源 :meth:`apps.collab.adapters.table.TableCollabAdapter.preview_restore`）。

    与 Charter §3.4 schema 对齐。``records_to_restore`` 在大表（>50000 行）
    场景下是基于 count diff 的**保守上界**，前端展示时建议带「约」/「最多」字样。
    """
    records_to_restore: int = 0
    records_to_create: int = 0
    records_to_delete: int = 0
    fields_to_restore: list[str] = Field(default_factory=list)
    estimated_duration_ms: int = 0


class RollbackTableImpactEntryView(BaseModel):
    table_id: str
    table_name: str = ""
    changes: RollbackTableImpactChangesView = Field(default_factory=RollbackTableImpactChangesView)
    preview: Optional[RollbackTablePreviewView] = None


class RollbackTabdataImpactView(BaseModel):
    """tabdata 维度的影响摘要（DC-W0-1-1 / D15 方案 A）。"""
    tables_affected: list[RollbackTableImpactEntryView] = Field(default_factory=list)


class RollbackImpactView(BaseModel):
    """跨模块影响摘要。新增模块维度时应在此扩展独立字段（非 ``extra='allow'``），
    保证前端有静态契约 + i18n 字段命名稳定（避免「未声明字段被默默丢弃」）。
    """
    files: RollbackImpactFilesView = Field(default_factory=RollbackImpactFilesView)
    resources: RollbackImpactResourcesView = Field(default_factory=RollbackImpactResourcesView)
    messages: RollbackImpactMessagesView = Field(default_factory=RollbackImpactMessagesView)
    # DC-W0-1-1 / D15 方案 A / Wave 1.1：tabdata 维度的「N 张表 / N 行 / 字段级 preview」
    # 摘要，由 TableImpactContributor + TableAdapter.preview_restore 二阶段聚合得到，
    # 为 RewindPreviewPanel 渲染分支提供数据源。Optional —— 没有 tabdata 资源涉及的
    # turn 该字段省略。
    tabdata: Optional[RollbackTabdataImpactView] = None


class RollbackLayerWarningView(BaseModel):
    resource: Optional[str] = None
    warning: Optional[str] = None


class RollbackRetryableResourceView(BaseModel):
    resource_type: str
    resource_id: str
    action: Optional[Literal['restore_version', 'trash', 'skip']] = None
    restore_to_version_id: Optional[str] = None


class RollbackWorkspaceFilesPartialDetailView(BaseModel):
    # ``success`` 保留给已发布客户端；新客户端读 status 区分
    # 部分恢复与完全失败。历史记录缺 status 时仍安全默认为 failed。
    success: bool = False
    status: Literal['partial_success', 'failed'] = 'failed'
    reason: Optional[str] = None


class RollbackResourcesPartialDetailView(BaseModel):
    restored_count: int = 0
    failed_count: int = 0
    failed_items: List[dict[str, Any]] = Field(default_factory=list)
    retryable: List[RollbackRetryableResourceView] = Field(default_factory=list)
    collab_sync_warnings: List[RollbackLayerWarningView] = Field(default_factory=list)


class RollbackPartialSuccessDetailsView(BaseModel):
    workspace_files: Optional[RollbackWorkspaceFilesPartialDetailView] = None
    resources: Optional[RollbackResourcesPartialDetailView] = None


class RollbackApplyLayerView(BaseModel):
    """单层 rollback 执行结果。"""
    status: Literal['success', 'partial_success', 'failed', 'pending', 'not_applicable'] = 'not_applicable'
    reason: Optional[str] = None
    restored_count: int = 0
    failed_count: int = 0
    retryable: List[RollbackRetryableResourceView] = Field(default_factory=list)
    warnings: List[RollbackLayerWarningView] = Field(default_factory=list)


class RollbackApplyLayersView(BaseModel):
    """Rollback 各层执行结果。"""
    conversation: RollbackApplyLayerView = Field(default_factory=RollbackApplyLayerView)
    workspace_files: RollbackApplyLayerView = Field(default_factory=RollbackApplyLayerView)
    resources: RollbackApplyLayerView = Field(default_factory=RollbackApplyLayerView)
    pg_state: RollbackApplyLayerView = Field(default_factory=RollbackApplyLayerView)


class ResourceRestoreItem(BaseModel):
    """单个资源恢复指令"""
    resource_type: str
    resource_id: str
    action: Literal['restore_version', 'trash', 'skip'] = Field(..., description="restore_version / trash / skip")
    restore_to_version_id: Optional[str] = None


class ResourceRestoreRequest(BaseModel):
    """资源恢复请求"""
    items: List[ResourceRestoreItem] = Field(..., min_length=1)
    preview_revision: Optional[str] = Field(
        None,
        description="用户确认的回退预览修订指纹；v2 编辑重发必须回传",
    )
    rollback_contract_version: int = Field(
        1,
        ge=1,
        description="资源恢复契约版本；v2 必须覆盖已确认计划全集，逐项执行或显式 skip",
    )


class ResourceRestoreResult(BaseModel):
    """单个资源恢复结果"""
    resource_type: str
    resource_id: str
    success: bool
    error: str = ""


class ResourceRestoreResponse(BaseModel):
    """资源恢复响应"""
    success: bool
    results: List[ResourceRestoreResult] = Field(default_factory=list)
    restored_count: int = 0
    failed_count: int = 0
    overall_status: Literal['success', 'partial_success', 'failed'] = 'success'
    compensation_available: bool = False
    partial_success_details: Optional[RollbackPartialSuccessDetailsView] = None
    collab_sync_warnings: List[RollbackLayerWarningView] = Field(default_factory=list)
    rollback_state: Optional['SessionRollbackStateView'] = None
    apply_result: Optional['RollbackApplyResultView'] = None


class WithdrawUnansweredRequest(BaseModel):
    """#6154 撤回未答轮次：物理删除该 user（及之后半截），不进入 checkpoint 回退态。"""
    client_message_id: str = Field(..., description="客户端消息 ID（与 persist 同源 UUID）")
    runtime_withdraw_applied: bool = Field(
        False,
        description="agent-runtime 已对本轮 user 完成 rewind+commit",
    )


class WithdrawUnansweredResponse(BaseModel):
    """撤回未答轮次响应。"""
    success: bool
    deleted_count: int = 0
    message: str = ""
    # 撤回后会话已无 user 消息时：标题生成已取消并复位为默认标题。
    title_reset: bool = False
    title: Optional[str] = None
    title_generation_status: Optional[Literal['pending', 'in_progress', 'done', 'failed']] = None


class RollbackRequest(BaseModel):
    """回滚请求 — 软标记回滚点（不立即删除消息，发新消息时才物理清理）"""
    target_message_id: str = Field(..., description="目标消息 ID（user 或 assistant）")
    safety_snapshot_hash: Optional[str] = Field(None, description="前端回滚前创建的 safety checkpoint hash，用于 unrevert")
    rollback_reason: str = Field("", description="用户标注的回退原因（可选）")
    runtime_rewind_applied: bool = Field(False, description="agent-runtime 已先写入 rewind boundary")
    runtime_keep_message_count: Optional[int] = Field(None, description="agent-runtime 计算出的保留消息数")
    mode: Literal['rollback', 'editAndResend'] = Field(
        'rollback',
        description="普通回退或编辑重发时间线重写；旧客户端缺失时保持普通回退",
    )
    preview_revision: Optional[str] = Field(
        None,
        description="预览返回的影响修订指纹；editAndResend 必须回传",
    )
    file_preview_revision: Optional[str] = Field(
        None,
        description="预览返回的文件影响修订指纹；v2 editAndResend 必须回传",
    )
    acknowledged_file_preview_reason: Optional[str] = Field(
        None,
        description="v2 编辑重发中，用户明确接受仅重写对话时的文件预览原因码",
    )
    rollback_contract_version: int = Field(
        1,
        ge=1,
        description="回退执行契约版本；v2 开始强制预览修订指纹",
    )
    defer_local_file_restore_finalize: bool = Field(
        False,
        description="v2 Electron Host 在本机文件 CAS 完成前先把文件层记为 pending，随后用 finalize 接口回填真实结果",
    )


class FileRestoreFinalizeIssue(BaseModel):
    path: str
    reason: str


class FileRestoreFinalizeRequest(BaseModel):
    """Electron Host 完成本机文件 compare-and-rewind 后的单次结果确认。"""
    apply_id: str = Field(..., min_length=1)
    rollback_contract_version: int = Field(2, ge=2)
    preview_revision: str = Field(..., min_length=1)
    file_preview_revision: str = Field(..., min_length=1)
    file_restore_status: Literal['success', 'not_applicable', 'partial', 'failed', 'unavailable']
    file_restore_reason: Optional[str] = None
    failed_files: List[str] = Field(default_factory=list)
    unrestorable_files: List[FileRestoreFinalizeIssue] = Field(default_factory=list)


class FileRestoreFinalizeResponse(BaseModel):
    success: bool = True
    apply_id: str
    file_restore_success: bool
    file_restore_status: Literal['success', 'not_applicable', 'partial', 'failed', 'unavailable']
    file_restore_reason: Optional[str] = None
    failed_files: List[str] = Field(default_factory=list)
    unrestorable_files: List[FileRestoreFinalizeIssue] = Field(default_factory=list)
    overall_status: Literal['success', 'partial_success', 'failed'] = 'success'
    rollback_state: Optional['SessionRollbackStateView'] = None
    apply_result: Optional['RollbackApplyResultView'] = None


class RollbackExecuteRequest(BaseModel):
    """由非执行端发起的安全回退请求。

    移动端等观察/控制端没有本地 transcript，不能自行声明 runtime 已完成回退。
    服务端会把本请求转交给会话绑定的执行设备，收到真实的 rewind 确认后才写入
    会话回退投影。
    """

    target_message_id: str = Field(..., description="目标消息 ID（user 或 assistant）")
    safety_snapshot_hash: Optional[str] = Field(None, description="回退前 safety checkpoint hash，用于 unrevert")
    rollback_reason: str = Field("", description="用户标注的回退原因（可选）")
    mode: Literal['rollback', 'editAndResend'] = Field(
        'rollback',
        description="普通回退或编辑重发时间线重写；旧客户端缺失时保持普通回退",
    )
    preview_revision: Optional[str] = Field(
        None,
        description="预览返回的影响修订指纹；editAndResend 必须回传",
    )
    file_preview_revision: Optional[str] = Field(
        None,
        description="预览返回的文件影响修订指纹；v2 editAndResend 必须回传",
    )
    acknowledged_file_preview_reason: Optional[str] = Field(
        None,
        description="v2 编辑重发中，用户明确接受仅重写对话时的文件预览原因码",
    )
    rollback_contract_version: int = Field(
        1,
        ge=1,
        description="回退执行契约版本；v2 开始强制预览修订指纹",
    )


class RollbackResponse(BaseModel):
    """回滚响应"""
    success: bool
    mode: Literal['rollback', 'editAndResend'] = 'rollback'
    checkpoint_hash: Optional[str] = None
    truncated_message_count: int = 0
    file_restore_success: bool = True
    # 新客户端使用分层状态，避免把 ``no file-history``（没有可恢复版本）和真实
    # 写盘失败都压成同一个 false。旧客户端继续读取上面的 bool。
    file_restore_status: Literal[
        'success', 'not_applicable', 'partial', 'failed', 'unavailable', 'pending'
    ] = 'success'
    file_restore_reason: Optional[str] = None
    failed_files: List[str] = Field(default_factory=list)
    # 宿主分流判据——告诉前端「本地文件恢复」由谁负责：
    #   'daemon': Daemon 宿主会话，后端已 per-file rewind 远端文件（结果见 file_restore_success），
    #             前端**不**应再本地 rewind（本进程无该 thread 账本，盲调必抛错假警报）。
    #   'local'（默认）: Electron 本地宿主，文件在本机，前端 fileHistoryIpc.rewind 负责。
    #             默认 'local' 向后兼容（老客户端忽略此字段，沿用本地 rewind 行为）。
    file_restore_host: Literal['daemon', 'local'] = 'local'
    overall_status: Literal['success', 'partial_success', 'failed'] = 'success'
    rollback_state: Optional['SessionRollbackStateView'] = None
    checkpoint_record: Optional['CheckpointRecordView'] = None
    apply_result: Optional['RollbackApplyResultView'] = None
    partial_success_details: Optional[RollbackPartialSuccessDetailsView] = None
    file_restore_finalize_required: bool = False
    file_restore_finalize_expires_at: Optional[str] = None
    message: str = ""


class UnrevertResponse(BaseModel):
    """撤销回滚响应"""
    success: bool
    snapshot_hash: Optional[str] = None
    file_restore_success: bool = True
    overall_status: Literal['success', 'partial_success', 'failed'] = 'success'
    rollback_state: Optional['SessionRollbackStateView'] = None
    checkpoint_record: Optional['CheckpointRecordView'] = None
    apply_result: Optional['RollbackApplyResultView'] = None
    partial_success_details: Optional[RollbackPartialSuccessDetailsView] = None
    reapply_resource_items: List[ResourceRestoreItem] = Field(default_factory=list)
    message: str = ""


class SessionRollbackStateView(BaseModel):
    """会话级回滚状态聚合视图。"""
    session_id: str
    revert_active: bool = False
    target_message_id: Optional[str] = None
    target_checkpoint_id: Optional[str] = None
    # ：保留的 LLM 消息条数（= ConversationState.messages_json 截断索引）。
    # 本地 Electron 宿主据此调 IPC agent-engine:rollback-transcript 截断本机 transcript。
    revert_state_index: Optional[int] = None
    safety_snapshot_ref: Optional[str] = None
    cleanup_status: Literal['not_started', 'pending', 'running', 'done', 'failed', 'pending_retry'] = 'not_started'
    can_unrevert: bool = False
    last_apply_result: Optional[Literal['success', 'partial_success', 'failed']] = None
    partial_success_details: Optional[RollbackPartialSuccessDetailsView] = None
    resource_restore_state: Optional[List[dict[str, Any]]] = None
    last_rollback_reason: Optional[str] = None
    last_operation_mode: Literal['rollback', 'editAndResend'] = 'rollback'
    updated_at: Optional[datetime] = None


class RollbackApplyResultView(BaseModel):
    """一次 rollback / resource restore / unrevert 的聚合结果。"""
    apply_id: str
    overall_status: Literal['success', 'partial_success', 'failed'] = 'success'
    checkpoint_id: Optional[str] = None
    checkpoint_record: Optional[CheckpointRecordView] = None
    session_state: SessionRollbackStateView
    layers: RollbackApplyLayersView
    collab_sync_warnings: List[RollbackLayerWarningView] = Field(default_factory=list)


class RevertHistoryResourceResultView(BaseModel):
    resource_type: str
    resource_id: str
    success: bool


class RevertHistoryEntryView(BaseModel):
    type: Literal['rollback', 'resource_rollback', 'unrevert']
    apply_id: Optional[str] = None
    target_message_id: Optional[str] = None
    snapshot_hash: Optional[str] = None
    messages_removed: Optional[int] = None
    restored_count: Optional[int] = None
    failed_count: Optional[int] = None
    resource_count: Optional[int] = None
    resources: List[RevertHistoryResourceResultView] = Field(default_factory=list)
    reapply_resource_items: List[ResourceRestoreItem] = Field(default_factory=list)
    apply_result: Optional[Literal['success', 'partial_success', 'failed']] = None
    partial_success_details: Optional[RollbackPartialSuccessDetailsView] = None
    created_at: str = ""


class RevertHistoryResponse(BaseModel):
    history: List[RevertHistoryEntryView] = Field(default_factory=list)


class RollbackPreviewRequest(BaseModel):
    """回滚预览请求 — dry-run，不实际执行"""
    target_message_id: str = Field(..., description="目标消息 ID（user 或 assistant）")


class ResourceChangePreview(BaseModel):
    """受影响资源摘要"""
    resource_type: str
    resource_id: str
    resource_name: str = ""
    change_type: str
    summary: str = ""
    agent_run_id: str = ""


class ResourceRestoreInfo(BaseModel):
    """单个资源的回退计划"""
    resource_type: str
    resource_id: str
    resource_name: str = ""
    action: str = Field(
        ...,
        description="restore_version: 恢复到历史版本; trash: 移入回收站(Agent 创建的资源); no_version: 无版本可恢复; skip: 无需操作"
    )
    action_label: str = ""
    can_restore: bool = False
    restore_to_version_id: Optional[str] = None
    restore_to_version_time: Optional[str] = None
    expected_current_state_revision: Optional[str] = Field(
        None,
        description="预览时资源当前态指纹；v2 执行前用于检测协作者并发编辑",
    )
    change_count: int = Field(0, description="该资源在被回退的消息范围内的变更次数")


class RollbackPreviewView(BaseModel):
    """回滚预览聚合视图。"""
    target_message_id: str
    target_timestamp: Optional[str] = None
    preview_revision: Optional[str] = Field(
        None,
        description="绑定当前对话边界、文件锚点与资源计划的修订指纹",
    )
    rollback_contract_version: int = Field(
        2,
        description="回退预览/执行契约版本",
    )
    messages_to_remove: int = 0
    messages_preview: List[dict] = Field(default_factory=list, description="即将移除的消息摘要（最多5条）")
    checkpoint_hash: Optional[str] = None
    effective_checkpoint: Optional[CheckpointRecordView] = None
    resource_changes: List[ResourceChangePreview] = Field(default_factory=list)
    resource_restore_plan: List[ResourceRestoreInfo] = Field(default_factory=list, description="各资源的回退计划")
    resource_preview_status: Literal['available', 'not_applicable', 'unavailable'] = Field(
        'not_applicable',
        description="资源影响与恢复计划是否已完整计算；unavailable 时不得把空计划解释为无影响",
    )
    resource_preview_reason: Optional[str] = Field(
        None,
        description="资源预览不可用的稳定原因码",
    )
    unrestorable_items: List[str] = Field(default_factory=list, description="无法追踪恢复的历史消息提示")
    degraded_reasons: List[str] = Field(default_factory=list)
    no_impact: bool = False
    impact: Optional[RollbackImpactView] = None
    # ── FH-4：Daemon 宿主 per-file 回退预览──
    # Daemon 宿主会话的「将恢复哪些文件」此前用失真的 shadow-git checkpoint_hash 推断；
    # 现由后端 dispatch file_history_preview 取真实清单。前端据 file_restore_host==='daemon'
    # 用 affected_paths 渲染 per-file 文件区块，替代 shadow-git diff fallback。
    # affected_paths: anchor 那一轮回退将写/删的文件相对路径（仅 Daemon 宿主非空；
    #   Electron 本地宿主由前端 fileHistoryIpc.getAffectedPaths 本地算，此处恒空）。
    affected_paths: List[str] = Field(default_factory=list, description="Daemon 宿主回退将恢复的文件相对路径清单")
    # rewind_anchor_id: per-file 回退锚点（= 目标那一轮顶层 agentRunId，§3.9 规则 3），
    #   与执行端 file_history_rewind 入参一致，便于前端对账 / 诊断。
    rewind_anchor_id: Optional[str] = Field(None, description="per-file 回退锚点（目标那一轮 agentRunId）")
    # file_restore_host: 宿主分流判据（与 RollbackResponse 同义）——'daemon' = 文件层归后端
    #   per-file，前端用 affected_paths 渲染清单且不本地探测；'local'（默认）= Electron 本地宿主。
    file_restore_host: Literal['daemon', 'local'] = 'local'
    # file_preview_success（批次2 复核 P3#2）：仅 Daemon 宿主有意义——per-file 预览
    # dispatch 是否成功拿到清单。False = 预览失败（daemon 离线 / dispatch 错 / path guard
    # 拒），此时 affected_paths=[] 是「无法确定」而非「真 0 文件」，前端据此**不**把空清单
    # 当「无文件可恢复」展示（退回后端能力，避免预览失真）。默认 True（本地宿主 / 成功）。
    file_preview_success: bool = Field(True, description="Daemon per-file 预览是否成功拿到清单（False=预览失败，affected_paths 不可信）")
    file_preview_status: Literal['available', 'not_applicable', 'unavailable'] = Field(
        'not_applicable',
        description="文件影响是否已确认；unavailable 时空清单不能解释为无文件影响",
    )
    file_preview_reason: Optional[str] = Field(
        None,
        description="文件预览不可用或不适用的稳定原因码，供客户端生成可行动文案",
    )
    unrestorable_files: List[dict[str, str]] = Field(
        default_factory=list,
        description="预览阶段已知无法恢复的文件及原因；非空时不得解释为无文件影响",
    )
    file_preview_revision: Optional[str] = Field(
        None,
        description="文件锚点、状态与受影响路径的修订指纹",
    )


class RollbackPreviewResponse(RollbackPreviewView):
    """回滚预览响应。"""
    pass


class UpdateCheckpointRequest(BaseModel):
    """更新消息的检查点数据"""
    checkpoint_hash: str = Field(..., description="Shadow Git commit hash")
    checkpoint_state_index: Optional[int] = Field(None, description="ConversationState.messages_json 长度")
    diff_summary: Optional[DiffSummary] = Field(None, description="Shadow Git 文件变更摘要")


# ============ 标题生成 Schema ============

class GenerateTitleRequest(BaseModel):
    """生成标题请求（：正文随请求传入，与消息落库状态解耦）。"""
    force: bool = Field(default=False, description="是否强制重新生成标题（即使已有标题）")
    user_message: str = Field(..., min_length=1, description="用于生成标题的用户正文（必填，不读库）")
    model_id: Optional[str] = Field(
        default=None,
        validation_alias=AliasChoices("model_id", "modelId"),
        description="标题生成使用的模型 ID（兼容 modelId）",
    )


class GenerateTitleResponse(BaseModel):
    """生成标题响应（fire-and-forget 协议）。

    Wave 1（用户级事件治理）改造：``/sessions/{id}/generate-title`` 端点不再
    同步 await LLM——内部调度后台线程，LLM 完成时通过 ``publish_to_user``
    把 ``agent.user.title_updated`` 事件广播给用户所有在线设备；HTTP view
    立即返 ``{accepted, reason?}``。

    字段语义：

    - ``accepted=True`` → 已成功调度生成；标题最终通过 WS 投递。
    - ``accepted=False`` + ``reason='already_has_title'`` → 当前会话已有非
      默认标题且未带 ``force=True``。
    - ``accepted=False`` + ``reason='empty_user_message'`` → 请求未带有效正文。

    本响应**不再**返回 ``title`` 字段——HTTP 路径完成后标题尚未生成完毕，
    返回 stale 的 ``session.title``（可能仍是"新对话"）会让前端误以为
    生成成功（dogfood 4eb4a2f2 复盘的根因）。
    """
    accepted: bool
    reason: Optional[str] = None


class UpdateCheckpointResponse(BaseModel):
    """更新检查点响应"""
    message_id: str
    checkpoint_state_index: Optional[int] = None


class ResolveContextRequest(BaseModel):
    """@ 引用上下文解析请求"""
    blocks: List[dict] = Field(..., min_length=1, description="前端传来的 context blocks（@提及）")


class ResolveContextResponse(BaseModel):
    """@ 引用上下文解析响应"""
    context_text: str = Field("", description="解析后的上下文文本，可直接注入 LLM prompt")
    resolved_count: int = Field(0, description="成功解析的引用数量")


class GenerateCommitMessageRequest(BaseModel):
    """TabCode AI 生成 commit message 请求"""
    organization_id: str = Field(..., min_length=1, description="组织 ID")
    files: List[str] = Field(default_factory=list, description="已暂存文件路径")
    diff_excerpt: str = Field(..., min_length=1, description="截断后的 staged diff")
    truncated: bool = Field(False, description="客户端是否已截断 diff")


class GenerateCommitMessageResponse(BaseModel):
    """TabCode AI 生成 commit message 响应"""
    commit_message: str = Field(..., description="建议的 Conventional Commit 文本")


ChatSessionSchema.model_rebuild()
ChatSessionWithAgentSchema.model_rebuild()
ResourceRestoreResponse.model_rebuild()
RollbackResponse.model_rebuild()
UnrevertResponse.model_rebuild()
RollbackPreviewResponse.model_rebuild()
RollbackPreviewView.model_rebuild()
RollbackApplyResultView.model_rebuild()
