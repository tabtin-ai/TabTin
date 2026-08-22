"""
agent_wire — Python-side schema mirror of ``@tabtin/agent-wire``.

Provides Pydantic models that match the TypeScript Zod schemas defined in
``packages/agent-wire/src/``. Any change to the TS schemas **must** be
reflected here, and vice versa.

Usage
-----
Import payload models for validation::

    from apps.services.common.agent_protocol.agent_wire import PromptForwardPayload

完整的 ``agent.stream.*`` 事件注册表是 ``constants.py`` 的 ``AgentStreamEvent``
（TS 侧对应 ``packages/agent-wire/src/events.ts`` 的 ``StreamEvents``）。
"""

from __future__ import annotations

from enum import Enum
from typing import Any, Dict, List, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field


# ═══════════════════════════════════════════════════════════════════════
# Event Constants
# ═══════════════════════════════════════════════════════════════════════


class PromptEvent:
    """``agent.prompt.*`` / ``agent.permission.*`` — Backend → Daemon."""

    FORWARD = "agent.prompt.forward"
    ADMITTED = "agent.prompt.admitted"
    CANCEL = "agent.prompt.cancel"
    PAUSE = "agent.prompt.pause"
    RESUME = "agent.prompt.resume"
    PERMISSION_RESPONSE = "agent.permission.response"
    PERMISSION_RESET_SESSION = "agent.permission.reset_session"


# ═══════════════════════════════════════════════════════════════════════
# Common Types
# ═══════════════════════════════════════════════════════════════════════


class PermissionDecision(str, Enum):
    APPROVED = "approved"
    APPROVED_FOR_SESSION = "approved_for_session"
    DENIED = "denied"
    ABORT = "abort"


class TurnEndStatus(str, Enum):
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class RiskLevel(str, Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


class PerModelUsage(BaseModel):
    """Wave 3: per-model 分桶中每个模型的用量快照（snake_case 与顶层 UsageReport 对齐）。"""

    input_tokens: int
    output_tokens: int
    cache_read_tokens: Optional[int] = None
    cache_creation_tokens: Optional[int] = None
    reasoning_tokens: Optional[int] = None
    compact_input_tokens: Optional[int] = None
    compact_output_tokens: Optional[int] = None
    credits: Optional[float] = None


class UsageReport(BaseModel):
    """UsageReport — 一次 LLM 调用 / 一次 query 的累计用量。

    与 TS `@tabtin/contracts/agent` 的 `UsageReportSchema` 完全对齐。
    包含基础 token 计数、cost、cache 命中、reasoning、compact 分项、计费状态、
    per-model 分桶、context-ring 字段。runtime / Proxy billing 尾帧 / Wallet
    计费记账三条路径会消费这些字段。
    """

    input_tokens: Optional[int] = None
    output_tokens: Optional[int] = None
    total_tokens: Optional[int] = None
    cache_read_input_tokens: Optional[int] = None
    cache_creation_input_tokens: Optional[int] = None
    reasoning_tokens: Optional[int] = None
    model: Optional[str] = None
    cost_usd: Optional[float] = None
    charge_status: Optional[str] = None
    compact_input_tokens: Optional[int] = None
    compact_output_tokens: Optional[int] = None
    by_model: Optional[Dict[str, PerModelUsage]] = None
    # Context-ring messages-as-truth（2026-05-10 起）：来自 runtime
    # `state._lastUsageAnchor`（最近一次 LLM provider 响应的真实 usage）。
    # `last_input_tokens` 用于「上下文用量环」分子，避免 turn 累加值在多轮
    # tool_use 中线性虚高。详见 `packages/contracts/src/agent/index.ts`
    # `UsageReportSchema` 顶部注释。
    last_input_tokens: Optional[int] = None
    last_cache_read_input_tokens: Optional[int] = None
    last_cache_creation_input_tokens: Optional[int] = None


class PlanEntry(BaseModel):
    id: str
    title: str
    status: str


class SourceMeta(BaseModel):
    source: Literal["runtime"] = "runtime"
    backend_type: str = "runtime"
    task_id: str = ""


PermissionMode = Literal["default", "auto-approve-reads", "auto-approve-edits", "full-auto"]
AuthorizationPreset = Literal["cautious", "collaborative", "full_auto", "server_auto"]
# W4 (2026-05-13)：移除 `cloud_first` 死配置字面值（T8 / 总控 §三 F5）。旧
# `cloud_first` 与 `cloud_only` 在 ElectronAgentHost / DaemonAgentHost 代码里是
# 同一个 if 分支，从未真正实现"云端优先失败再本地"的差异语义。Backend 向
# Daemon 发 prompt.forward 时不再使用 `cloud_first`；Daemon 端 decoder 收到
# `cloud_first` 会返 undefined 走 env fallback（host-knobs.ts 同步说明）。
AttachmentStrategy = Literal["local_first", "cloud_only"]


# ═══════════════════════════════════════════════════════════════════════
# Prompt / Permission Payloads (Backend → Daemon)
# ═══════════════════════════════════════════════════════════════════════


class AgentBackendConfig(BaseModel):
    type: str
    disabled_apps: Optional[List[str]] = None
    disabled_tool_prefixes: Optional[List[str]] = None


class OperationSwitchValue(str, Enum):
    """W7b M3：operation_switches / device_permissions 的合法 value 值。

    与 packages/security-policy/src/types.ts SwitchAction 一致。Pydantic 严格
    枚举 — 任何写入非法 value（如旧版 'deny'）都会被 schema 拒绝，避免
    客户端解码时收到未知值时静默丢弃造成"配了不生效"的隐性 bug。
    """
    ALLOW = "allow"
    CONFIRM = "confirm"
    BLOCK = "block"


class AuthorizationActionValue(str, Enum):
    """W7b M3：authorization_rules 的合法 value 值（类别级，仅 auto / confirm）。"""
    AUTO = "auto"
    CONFIRM = "confirm"


class ExecutionLimits(BaseModel):
    """W7b M3：执行预算（最大迭代轮数 / 最大 credits）。

    与 packages/agent-wire/src/prompt.ts ExecutionLimitsSchema 镜像。
    `extra='allow'` 让未来新增字段（如 max_tools_per_run）不需要立即同步。
    """
    max_iterations_per_run: Optional[int] = None
    max_credits_per_run: Optional[float] = None

    class Config:
        extra = "allow"


class SubAgentTemplateDto(BaseModel):
    """子 Agent 模板 DTO — 与 TS ``SubAgentTemplateDtoSchema`` 镜像。

    每条记录对应用户在 Space Settings 里预配的一个子 Agent 角色模板。
    通过 ``prompt.forward`` 下发到客户端 runtime 供 ``agent`` 工具按名匹配。

    字段映射注意：``tool_whitelist`` / ``tool_blacklist`` 对应 model 层的
    ``SubAgentTemplate.allowed_tools`` / ``denied_tools``（PRD 06 §5.3.1 指定
    DTO 命名，从 model 转换时需要映射）。
    """

    template_id: str
    template_version: int
    name: str
    subagent_type: Literal["explore", "plan", "execute"]
    persona: str
    tools: List[str]
    model: Optional[str] = None
    display_color: Optional[str] = None
    max_turns: Optional[int] = 50

    model_config = ConfigDict(extra="allow")


class SubAgentPolicyDto(BaseModel):
    """子 Agent 全局工具策略 DTO — 与 TS ``SubAgentPolicyDtoSchema`` 镜像。

    字段映射注意：``tool_whitelist`` / ``tool_blacklist`` 对应 model 层的
    ``SubAgentTemplate.allowed_tools`` / ``denied_tools``。
    """

    tool_whitelist: List[str]
    tool_blacklist: List[str]
    model_override: Optional[str] = None
    thinking_config: Optional[Dict[str, Any]] = None

    model_config = ConfigDict(extra="allow")


class SubAgentRuntimeConfigDto(BaseModel):
    """子 Agent 运行时配置 DTO — 与 TS ``SubAgentRuntimeConfigDtoSchema`` 镜像。"""

    max_active_children: Optional[int] = 10
    max_queue_size: Optional[int] = 40

    model_config = ConfigDict(extra="allow")


class SubagentConfigDto(BaseModel):
    """子 Agent 配置总包 DTO — 与 TS ``SubagentConfigDtoSchema`` 镜像。

    通过 ``prompt.forward`` 传递到客户端 runtime，让主 Agent 知道
    Space 里配了哪些子 Agent 模板、工具策略和并发限制。
    """

    templates: List[SubAgentTemplateDto] = Field(default_factory=list)
    policy: Optional[SubAgentPolicyDto] = None
    runtime: Optional[SubAgentRuntimeConfigDto] = None

    model_config = ConfigDict(extra="allow")


class EnabledAppDto(BaseModel):
    """单个 App 的 Agent-facing 描述 — 与 TS ``EnabledAppDtoSchema`` 镜像。

    W7c · Stage 4 双路径对齐：Django 端 ``prompt_forward_service`` 从 manifest +
    ``AppSettings.resolve_enabled_app_ids`` 派生后透传到 Daemon，让本地 ``buildAppsSection``
    在 Daemon 路径上生效。形态对齐 ``@tabtin/agent-prompt`` 的 ``EnabledAppInfo``。
    """

    key: str
    cli_key: Optional[str] = None
    display_name: str
    capability: str
    aliases: Optional[List[str]] = None

    model_config = ConfigDict(extra="allow")


class PromptForwardPayload(BaseModel):
    task_id: str
    prompt: str
    attachments: List[Any] = Field(default_factory=list)
    agent_config: AgentBackendConfig
    model_id: Optional[str] = None
    system_prompt: Optional[str] = None
    agent_id: Optional[str] = None
    attachment_strategy: Optional[AttachmentStrategy] = None
    workspace_root: Optional[str] = None
    permission_mode: Optional[PermissionMode] = None
    # PD-1（W6 M5）：authorization_preset 字段已退场，v3 唯一安全开关是 allow_yolo_mode
    # （v3 PRD §5.1.1 字段改名）。
    # Hilt v3 / W6 M2：Settings 里 toggle 的"超级权限"。Django 从
    # ``Agent.agent_config.security.allow_yolo_mode`` 读出后透传，Daemon /
    # Electron-via-forward 解析后落到 ``agentConfigV3.security.allow_yolo_mode``。
    # 缺省视为 false（与默认 yolo 关一致）。
    # ⚠️ wire 字段名 ``yolo_mode`` 是 Daemon ↔ Django 协议名，**PR3 不改**——
    # 改 wire 协议名属 PR2 范围（agent-wire/prompt.ts 同步）。本字段映射到 DB
    # 的 ``security.allow_yolo_mode``。
    yolo_mode: Optional[bool] = None
    # Hilt v3 / W6 M2：客户端工作区快照（Space sandbox + TabCode/TabFolder + 附件）。
    # 主要给 Daemon 用 —— Daemon 没有自己的 TabCode UI，只能由主控端 Electron
    # 通过 prompt.forward 透传。形态参考 ``@tabtin/security-policy`` 的
    # ``WorkspaceSnapshot``；wire 这里用 ``Any`` 不强校验，Daemon 侧 type guard
    # + ``buildPolicyFromAgentConfigV2`` 兜底形态错误。
    workspace_snapshot: Optional[Any] = None
    runtime_mode: Optional[str] = None
    custom_rules: Optional[str] = None
    # 设置 IA Phase 3 §8.6 分层规则·个人基线层。Django prompt_forward_service
    # 从 Agent owner 的 UserProfile.personal_rules（per-User 全局跨 Organization）读出后
    # 透传（非空才写，同 custom_rules）。host 解包后随 custom_rules 一起交给
    # agent-prompt 组装 <custom_rules> 块，并在 prompt 内说明分类合并策略。镜像 prompt.ts
    # PromptForwardPayloadSchema.personal_rules。（团队基线层 team_rules 已下线。）
    personal_rules: Optional[str] = None
    agent_mode: Optional[str] = None
    # 交互档（HITL 四态：interactive/solo/scheduled/batch）。与上面 runtime_mode
    # （执行位置 local/cloud）区分。无人值守任务传 'scheduled'，host 据此让审批 +
    # ask 工具 fail-fast，不再干等 30 分钟。缺省 None → host 走 'interactive'。
    # 镜像 prompt.ts PromptForwardPayloadSchema.interaction_mode（enum 在 TS 侧校验）。
    interaction_mode: Optional[str] = None
    # PRD §1.4 + DR-15：当前 Space 是否 group 类型。TS schema 早就有
    # （prompt.ts ``is_group_space``），dispatcher / forward_runner 也始终在传，
    # 仅 Pydantic ``PromptForwardPayload`` 漏镜像 → ``check-agent-wire-sync`` 报警。
    # W7c · Stage 4 顺手补齐（纯类型补齐，零运行时行为变化）。
    is_group_space: Optional[bool] = None
    # ── W7b M3：授权策略 / 执行限制 / Skills 上下文完整传递 ────────────
    # 历史 payload 只传 authorization_preset 顶层标签（PRD 真相 A2-A3），
    # 客户端 ToolProvider 用 preset 兜底就万事大吉，但用户在 Settings 里
    # 配的 operation_switches / execution_limits 全部失效。本 Wave 把完整
    # 字段传到客户端 runtime，让 mergeOperationSwitches + maxTurns 生效。
    #
    # value 用严格 Enum 而非 `Dict[str, str]`：保持与 TS zod schema 一致，
    # 避免某个 Django 模块往 agent_config.operation_switches 写了 'deny'
    # 之类的非法值后整个 prompt.forward 在客户端 zod 校验直接失败 → 对话挂掉。
    space_id: Optional[str] = None
    # W7c · Stage 4 Daemon 路径对齐 ── Space / Organization 的人类可读名。
    # Django ``prompt_forward_service`` 从 ``Space.name`` / ``space.organization.name``
    # 派生后透传，Daemon ``runtimeIdentity.spaceName/organizationName`` 据此渲染
    # ``<environment>`` 段（治理 07 §F.1）。
    space_name: Optional[str] = None
    organization_name: Optional[str] = None
    # W7c · Stage 4 Daemon 路径对齐 ── 当前 Space 启用的 App 能力图谱（07 §F.7）。
    # 从 manifest + ``AppSettingsService.resolve_enabled_app_ids`` 派生；
    # Daemon ``buildAppsSection`` 据此渲染 ``<apps>`` 段。
    enabled_apps: Optional[List[EnabledAppDto]] = None
    # W7c · Stage 4 Daemon 路径对齐 ── CLI 工具命令清单。
    # 可选；缺省时 Daemon 自己 spawn ``tabtin capabilities tools`` 兜底。
    cli_reference: Optional[str] = None
    operation_switches: Optional[Dict[str, OperationSwitchValue]] = None
    authorization_rules: Optional[Dict[str, AuthorizationActionValue]] = None
    device_permissions: Optional[Dict[str, OperationSwitchValue]] = None
    execution_limits: Optional[ExecutionLimits] = None
    memory_capability: Optional[bool] = None
    # work_mode：Agent 工作目录类型（code/doc/mixed）。prompt_forward_service 从
    # Agent.working_dir_type 读出后透传，Daemon 据此注入 system prompt 的
    # `<work_mode>` 段。宽松 str（与 TS 侧 z.string().optional() 镜像）——
    # 合法性由 daemon.ts 解码时枚举守卫兜底。缺省时段不注入（向后兼容）。
    working_dir_type: Optional[str] = None
    # W7a：与 TS 侧 `PromptForwardPayloadSchema.app_context` / `history` 镜像。
    # 当前 Django 透传未 wire 上（由 W7c 补齐 chat_service → forward_prompt 的传递），
    # 但 schema 必须先就位避免协议漂移（check-agent-wire-sync 在 CI 对齐）。
    app_context: Optional[Any] = None
    # PRD 06 §5.3.1：子 Agent 配置（模板 + 策略 + 运行时参数）。
    # Django prompt_forward_service 从 SubAgentTemplate 表和 Agent 配置组装此字段。
    subagent_config: Optional[SubagentConfigDto] = None
    client_message_id: Optional[str] = None
    history: Optional[List[Any]] = None
    # PRD 05 v0.4 §7.1 W3-轮 1：crash resume 状态快照。
    #
    # 字段类型留 Any 避免前向引用（``InterruptState`` Pydantic 类定义在
    # ``ApprovalScope`` / ``RuntimeMode`` / ``ApprovalAllowedOutcome`` 之后；
    # 提前到此声明会触发 Pydantic v2 的循环依赖告警）。
    #
    # Django 实际填充时调 ``InterruptState.model_validate(state)`` 做形态校验，
    # 然后 ``model_dump`` 进 payload；客户端 host 收到后按
    # ``InterruptStatePendingApprovalSchema`` 解析转 ``SerializedPendingApproval``。
    #
    # 详见类定义：``InterruptStatePendingApproval`` / ``InterruptState``（位于
    # 下面 ApprovalScope 等 enum 之后）。
    interrupt_state: Optional[Any] = None


class PromptCancelPayload(BaseModel):
    task_id: str


class PermissionResponsePayload(BaseModel):
    request_id: str
    approved: bool
    decision: Optional[PermissionDecision] = None


# ═══════════════════════════════════════════════════════════════════════
# Approval Events (PRD 05 §7.4 / §7.5 / §7.6 · W1A-轮 2)
# ═══════════════════════════════════════════════════════════════════════
#
# 统一审批事件 approval_requested + approval_resolved（v0.4 唯一形态）。Python 侧
# 镜像 TS Zod schema（packages/agent-wire/src/approval.ts）。
#
# 修改本节字段必须同步 TS；`scripts/check-agent-wire-sync.py` 在 CI 对齐检测。


class PlanGuardDenyCode(str, Enum):
    PLAN_MODE_WRITE_FORBIDDEN = "plan_mode_write_forbidden"
    PLAN_APPROVAL_PENDING = "plan_approval_pending"


class ApprovalScope(str, Enum):
    """PRD v0.3 修订：session → thread（§7.2.2 命名去歧）。"""

    ONCE = "once"
    THREAD = "thread"
    ALWAYS = "always"


class RuntimeMode(str, Enum):
    """PRD §1.2 三维辨析 + DR-1：四态 runtime_mode。"""

    INTERACTIVE = "interactive"
    SOLO = "solo"
    SCHEDULED = "scheduled"
    BATCH = "batch"


class ApprovalType(str, Enum):
    """PRD §7.5.3：approval_requested 的 discriminator。

    v0.4 唯一值是 tool_permission（plan-approval 整套已下线，新链路走
    plan-execute-handler IPC，与 hitl 完全解耦）。保留 enum 给未来扩展
    （Skill 安装审批 / Organization admin 跨成员审批等）。
    """

    TOOL_PERMISSION = "tool_permission"


class ApprovalOutcome(str, Enum):
    """PRD §7.5.3：approval_resolved 五态 outcome。"""

    ALLOW = "allow"
    DENY = "deny"
    CANCELLED = "cancelled"
    EXPIRED = "expired"
    CANCELLED_BY_ROLLBACK = "cancelled_by_rollback"


class ApprovalAllowedOutcome(str, Enum):
    """approval_requested.allowed_outcomes 的值域（子集，不含 cancelled/expired/rollback）。"""

    ALLOW = "allow"
    DENY = "deny"


# ─── Crash Resume: interrupt_state.pending_approvals (PRD 05 v0.4 §7.1) ──
#
# W3-轮 1：runtime 进程崩溃后 ``prompt.forward.resume`` 路径携带的批量审批快照。
# 字段镜像 TS ``InterruptStatePendingApprovalSchema`` / ``InterruptStateSchema``。
# 实际写入由 ``apps/services/common/ws/handlers/relay_audit_writer.py`` 在收到
# ``approval_requested`` / ``approval_resolved`` 时维护——本类是
# ``prompt.forward.resume`` 透传时的 wire schema 校验入口（也用于客户端
# host 解析 + ``scripts/check-agent-wire-sync.py`` 卡门禁）。
#
# ``model_config = ConfigDict(extra="allow")`` 让 server 端可附加调试字段
# （譬如 ``tool_input_preview``）而不破坏客户端 schema 校验。


class InterruptStatePendingApproval(BaseModel):
    batch_id: str
    request_id: str
    tool_call_id: str
    tool_name: str
    tool_namespace: Optional[str] = None
    tool_input: Optional[Any] = None
    status: Literal["pending", "resolved", "expired"]
    outcome: Optional[
        Literal["allow", "deny", "cancelled", "expired", "cancelled_by_rollback"]
    ] = None
    scope: Optional[ApprovalScope] = None
    rejection_message: Optional[str] = None
    decision_reason: Optional[Any] = None
    ask_hint: Optional[Dict[str, Any]] = None
    allowed_scopes: Optional[List[ApprovalScope]] = None
    allowed_outcomes: Optional[List[ApprovalAllowedOutcome]] = None
    risk_level: Optional[Literal["low", "medium", "high"]] = None
    runtime_mode: Optional[RuntimeMode] = None
    expires_at: Optional[int] = None
    created_at: Optional[int] = None
    resolved_at: Optional[int] = None
    approver_user_id: Optional[str] = None
    approver_identity: Optional[Dict[str, Any]] = None
    tool_input_preview: Optional[str] = None

    model_config = ConfigDict(extra="allow")


class InterruptStatePendingSingleHitl(BaseModel):
    """：ask_choice / ask_form / permission_request 单 HITL 未决快照。

    与 ``InterruptStatePendingApproval`` 对称，但源不同——单 HITL 走
    ``PendingInteraction`` PG 表（``relay_handler`` 处理 ``ask_*_required``
    / ``single_hitl_resolved`` 时维护），``prompt_forward_service`` 在 resume
    路径上查询未闭合的 pending 行透传给 runtime。runtime
    ``pending-single-hitl-restorer`` 负责重挂 UI 卡片 + 挂起等待 or 直接注入
    终态 tool_result。
    """

    kind: Literal["ask_choice", "ask_form", "permission_request"]
    request_key: str
    thread_id: Optional[str] = None
    status: Literal["pending", "resolved", "expired", "cancelled"]
    payload: Optional[Any] = None
    result: Optional[Any] = None
    expires_at: Optional[int] = None
    created_at: Optional[int] = None
    resolved_at: Optional[int] = None
    runtime_mode: Optional[RuntimeMode] = None

    model_config = ConfigDict(extra="allow")


class InterruptState(BaseModel):
    """``ConversationState.interrupt_state`` 的 wire schema（PRD §7.1）。

    Django ``relay_audit_writer`` 会把 ``pending_approvals`` 写到 PG
    ``ConversationState.interrupt_state`` JSON 字段；``prompt.forward.resume``
    路径上 ``forward_runner`` / ``prompt_forward_service`` 把 PG JSON 透传到
    ``PromptForwardPayload.interrupt_state`` 字段（类型留 Any 避免循环依赖；
    Django 在赋值前调 ``InterruptState.model_validate(...)`` 做形态校验）。

    ：单 HITL（ask_* / permission_request）恢复走 ``pending_single_hitl``
    slot，与 ``pending_approvals`` 对称但源不同（PendingInteraction 表）。
    """

    version: Optional[int] = None
    pending_approvals: Optional[List[InterruptStatePendingApproval]] = None
    pending_single_hitl: Optional[List[InterruptStatePendingSingleHitl]] = None
    snapshot: Optional[Any] = None

    model_config = ConfigDict(extra="allow")


# ─── DecisionReason discriminated union ──────────────────────────────
#
# Pydantic 的 tagged union 用 `Field(discriminator='type')` + `Literal` 标签实现。
# 每个分支独立定义，Union 汇总。TS 端是 Zod discriminatedUnion，语义等价。
#
# 历史 19 种（W1A 轮 2，PRD 05 6 层 pipeline 时期）+ W6 M4 新增 16 种
# （2026-05-03 L-W6-16 扩展，mirror `@tabtin/security-policy` v3 judge emit）。
# 总计 35 种；字段命名与 TS 侧 `packages/agent-wire/src/approval.ts` 一字不差。
#
# 注意 memo_allow / memo_deny 的 `createdAt` **保持 camelCase**（非
# Python 常规 snake_case），以对齐 judge.ts 实际 emit 的字段名；避免 runtime
# 透传时多一层命名转换。


class DecisionReasonPlanGuard(BaseModel):
    type: Literal["plan_guard"]
    deny_code: PlanGuardDenyCode
    details: Any = None


class DecisionReasonHardlineBlock(BaseModel):
    type: Literal["hardline_block"]
    pattern_name: str
    matched_text: str


class DecisionReasonHardlineConfirm(BaseModel):
    type: Literal["hardline_confirm"]
    pattern_name: str
    matched_text: str


class DecisionReasonSkillNotApproved(BaseModel):
    type: Literal["skill_not_approved"]
    skill_id: str


class DecisionReasonSkillTrustDowngrade(BaseModel):
    type: Literal["skill_trust_downgrade"]
    skill_id: str
    from_preset: str
    to_preset: str


class DecisionReasonOperationSwitch(BaseModel):
    type: Literal["operation_switch"]
    switch_key: str
    switch_action: OperationSwitchValue


class DecisionReasonDenyReadPath(BaseModel):
    type: Literal["deny_read_path"]
    path: str
    matched_pattern: str


class DecisionReasonDenyWritePath(BaseModel):
    type: Literal["deny_write_path"]
    path: str
    matched_pattern: str


class DecisionReasonSandboxReadonly(BaseModel):
    type: Literal["sandbox_readonly"]
    path: str
    grant_path: str


class DecisionReasonBashTooComplex(BaseModel):
    type: Literal["bash_too_complex"]
    node: str


class DecisionReasonBashParseUnavailable(BaseModel):
    type: Literal["bash_parse_unavailable"]


class DecisionReasonMemoizedAlways(BaseModel):
    type: Literal["memoized_always"]
    previous_reason: Optional[Any] = None


class DecisionReasonMemoizedThread(BaseModel):
    type: Literal["memoized_thread"]
    previous_reason: Optional[Any] = None


class DecisionReasonClassifierLowConfidence(BaseModel):
    type: Literal["classifier_low_confidence"]
    confidence: float


class DecisionReasonClassifierDecided(BaseModel):
    type: Literal["classifier_decided"]
    confidence: float
    llm_reason: str


class DecisionReasonUserInteractive(BaseModel):
    type: Literal["user_interactive"]
    scope: ApprovalScope
    rejection_message: Optional[str] = None


class DecisionReasonUnknownTool(BaseModel):
    type: Literal["unknown_tool"]


class DecisionReasonFallbackPreset(BaseModel):
    type: Literal["fallback_preset"]
    preset: str


class DecisionReasonRuleHighRiskAllowlistMiss(BaseModel):
    """W1A-轮 2 Review P1-4：Layer 3 preset 规则判决（白名单外触发审批 / 高危类别）。"""

    type: Literal["rule_high_risk_allowlist_miss"]
    preset_name: str
    risk_signal: Literal["allowlist_miss", "high_risk_category"]
    matched_text: Optional[str] = None


# ─── W6 v3 judge 16 种（2026-05-03 L-W6-16 扩展） ─────────────────────
# SSoT: packages/security-policy/src/types-v3.ts DecisionReason union
#       packages/security-policy/src/judge.ts 实际 emit 字段。
#
# 字段名与 TS 侧 `DecisionReasonSchema` 一字不差；memo_allow / memo_deny 的
# `createdAt` 保持 camelCase（judge.ts 直接 emit 的字段名，避免 runtime 透传
# 时再做一层命名映射）。

MemoSpecificity = Literal["exact", "scoped", "wildcard"]


class DecisionReasonHardlineCommand(BaseModel):
    """绝对命令红线（yolo 也挡）——shell 命令命中 `ABSOLUTE_COMMAND_DENYLIST`。"""

    type: Literal["hardline_command"]
    pattern: str


class DecisionReasonHardlinePath(BaseModel):
    """绝对路径红线（写系统目录，yolo 也挡）。"""

    type: Literal["hardline_path"]
    pattern: str


class DecisionReasonSensitiveOutDeny(BaseModel):
    """敏感写 + 工作区外 → deny（见 spec §3.3 矩阵）。"""

    type: Literal["sensitive_out_deny"]
    path: str
    category: str


class DecisionReasonSensitiveInAsk(BaseModel):
    """敏感写 + 工作区内 → ask（即使 yolo 也敲门）。"""

    type: Literal["sensitive_in_ask"]
    path: str
    category: str


class DecisionReasonMemoAllow(BaseModel):
    """命中长期记忆 allow（SSoT: Agent.approval_memo）。"""

    type: Literal["memo_allow"]
    key: str
    createdAt: str  # judge.ts emit camelCase；跨端保持一致
    specificity: MemoSpecificity
    # M4.1 L-W6-24 扩展：携带记忆创建时的业务名；UI 优先展示，缺失时回退到 key
    scope_description: Optional[str] = None


class DecisionReasonMemoDeny(BaseModel):
    """命中长期记忆 deny。"""

    type: Literal["memo_deny"]
    key: str
    createdAt: str
    specificity: MemoSpecificity
    # M4.1 L-W6-24 扩展：携带记忆创建时的业务名；UI 优先展示，缺失时回退到 key
    scope_description: Optional[str] = None


class DecisionReasonYoloAllow(BaseModel):
    """超级权限模式放行（敏感路径已在 step 1 提前降级为 ask/deny）。"""

    type: Literal["yolo_allow"]


class DecisionReasonAutoAllow(BaseModel):
    """#3503 替我审批档旁路放行。"""

    type: Literal["auto_allow"]


class DecisionReasonFullAccessAllow(BaseModel):
    """#3503 完全访问档旁路放行。"""

    type: Literal["full_access_allow"]


class DecisionReasonPolicyRiskAsk(BaseModel):
    """#3503 替我审批档对非灾难级红线/敏感操作的 ask。"""

    type: Literal["policy_risk_ask"]
    pattern: Optional[str] = None
    category: Optional[str] = None


class DecisionReasonWorkspaceIn(BaseModel):
    """工作区内 → allow；kind 区分 file.path vs shell.cwd。"""

    type: Literal["workspace_in"]
    path: str
    kind: Literal["path", "cwd"]


class DecisionReasonWorkspaceOut(BaseModel):
    """工作区外 → ask；kind 区分 file.path vs shell.cwd。"""

    type: Literal["workspace_out"]
    path: str
    kind: Literal["path", "cwd"]


class DecisionReasonPlatformArtifactAllow(BaseModel):
    """平台自产产物目录只读放行（cli-outputs / tabtin-agent-tasks）。"""

    type: Literal["platform_artifact_allow"]
    path: str


class DecisionReasonPlatformGateDeferred(BaseModel):
    """#5643 平台受管 CLI 让位给 host ApprovalGate。"""

    type: Literal["platform_gate_deferred"]
    surface: str


class DecisionReasonDestructiveInWorkspaceAsk(BaseModel):
    """#985 工作区内破坏性写操作需确认。"""

    type: Literal["destructive_in_workspace_ask"]
    path: str


class DecisionReasonObjectDefaultAllow(BaseModel):
    """对象读类工具默认放行（不走工作区判决）。"""

    type: Literal["object_default_allow"]


class DecisionReasonObjectWriteAsk(BaseModel):
    """对象写类工具默认询问。"""

    type: Literal["object_write_ask"]


class DecisionReasonMcpDefaultAsk(BaseModel):
    """MCP 工具默认询问（除非 memo 命中）。"""

    type: Literal["mcp_default_ask"]
    server: Optional[str] = None


class DecisionReasonDeviceDefaultAsk(BaseModel):
    """设备交互类工具默认询问。"""

    type: Literal["device_default_ask"]
    device_action: Optional[str] = None


class DecisionReasonDeviceObserveAllow(BaseModel):
    """设备观察类工具（只读）直接放行。"""

    type: Literal["device_observe_allow"]


class DecisionReasonPlanBlocked(BaseModel):
    """Plan 模式硬闸门（由 orchestration 层产生，judge 本身不 emit）。"""

    type: Literal["plan_blocked"]
    mode: str


class DecisionReasonFallbackAsk(BaseModel):
    """judge step 5 兜底询问（未命中上述任何规则）。"""

    type: Literal["fallback_ask"]


DecisionReason = Union[
    # Legacy 19 种（W1A 轮 2）
    DecisionReasonPlanGuard,
    DecisionReasonHardlineBlock,
    DecisionReasonHardlineConfirm,
    DecisionReasonSkillNotApproved,
    DecisionReasonSkillTrustDowngrade,
    DecisionReasonOperationSwitch,
    DecisionReasonDenyReadPath,
    DecisionReasonDenyWritePath,
    DecisionReasonSandboxReadonly,
    DecisionReasonBashTooComplex,
    DecisionReasonBashParseUnavailable,
    DecisionReasonMemoizedAlways,
    DecisionReasonMemoizedThread,
    DecisionReasonClassifierLowConfidence,
    DecisionReasonClassifierDecided,
    DecisionReasonUserInteractive,
    DecisionReasonUnknownTool,
    DecisionReasonFallbackPreset,
    DecisionReasonRuleHighRiskAllowlistMiss,
    # W6 v3 judge 16 种（L-W6-16 扩展）
    DecisionReasonHardlineCommand,
    DecisionReasonHardlinePath,
    DecisionReasonSensitiveOutDeny,
    DecisionReasonSensitiveInAsk,
    DecisionReasonMemoAllow,
    DecisionReasonMemoDeny,
    DecisionReasonYoloAllow,
    DecisionReasonAutoAllow,
    DecisionReasonFullAccessAllow,
    DecisionReasonPolicyRiskAsk,
    DecisionReasonWorkspaceIn,
    DecisionReasonWorkspaceOut,
    DecisionReasonPlatformArtifactAllow,
    DecisionReasonPlatformGateDeferred,
    DecisionReasonDestructiveInWorkspaceAsk,
    DecisionReasonObjectDefaultAllow,
    DecisionReasonObjectWriteAsk,
    DecisionReasonMcpDefaultAsk,
    DecisionReasonDeviceDefaultAsk,
    DecisionReasonDeviceObserveAllow,
    DecisionReasonPlanBlocked,
    DecisionReasonFallbackAsk,
]


# ─── Approval Event Payload ─────────────────────────────────────────


class ApprovalAskHint(BaseModel):
    summary: str
    suggested_scope: ApprovalScope


class ApproverIdentity(BaseModel):
    user_id: str
    client_info: str
    timestamp: int


class ApprovalSkillContext(BaseModel):
    """W1A-轮 2 Review P1-2：供 UI 判断 Skill 降档 / 禁 always 按钮。"""

    skill_id: str
    source: Literal["manual", "builtin", "marketplace", "user_shared"]
    permissions_approved: bool


class ApprovalBatchContext(BaseModel):
    """W1A-轮 2 Review P1-7：batch 场景协议预留，M4-B 实装时扩展子字段。"""

    batch_id: str
    current_row_index: Optional[int] = None
    total_count: Optional[int] = None
    origin_column_id: Optional[str] = None
    memoization_hint: Optional[
        Literal["first_in_batch", "memo_hit", "memo_miss"]
    ] = None

    model_config = ConfigDict(extra="allow")


class ApprovalActionRequest(BaseModel):
    """v0.4：单条 ActionRequest（同 batch 多条共享 batch_id）。

    与 TS `ApprovalActionRequestSchema` 镜像；字段命名 snake_case 与 wire 协议
    对齐。runtime 内部 camelCase BatchActionRequest 由 channel 实现做命名映射。
    """

    request_id: str
    tool_call_id: str
    tool_name: str
    tool_namespace: Optional[str] = None
    tool_input: Any
    decision_reason: DecisionReason = Field(..., discriminator="type")
    ask_hint: Optional[ApprovalAskHint] = None
    allowed_scopes: List[ApprovalScope]
    allowed_outcomes: List[ApprovalAllowedOutcome]
    risk_level: Literal["low", "medium", "high"]
    skill_context: Optional[ApprovalSkillContext] = None
    batch_context: Optional[ApprovalBatchContext] = None

    model_config = ConfigDict(extra="allow")


class ApprovalRequestedPayload(BaseModel):
    """PRD §7.4（v0.4 升格 batch）：`agent.stream.approval_requested` 的 payload。

    v0.4 关键变更（与 TS `ApprovalRequestedPayloadSchema` 镜像）：
    - 单 request_id 形态 → batch_id + action_requests[] 数组
    - approval_type 仅保留 'tool_permission'（保留 discriminator 字段供未来扩展）
    - 一轮 LLM 输出多个并发审批工具时一次性 emit 单条事件，N 条 action_requests
      装在数组里；用户决策一次回灌，详见 §6.10 批量审批合并代数。
    """

    batch_id: str
    approval_type: Literal["tool_permission"]
    action_requests: List[ApprovalActionRequest] = Field(..., min_length=1)
    runtime_mode: RuntimeMode
    expires_at: int
    schema_version: Literal[1]
    # ：与 hitl_interaction ChatMessage.id 同源（可选，旧 runtime 可不填）
    message_id: Optional[str] = None

    model_config = ConfigDict(extra="allow")


class ApprovalDecision(BaseModel):
    """v0.4：批内单条决策结果（同 batch N 条独立 outcome / scope / rejection_message）。"""

    request_id: str
    tool_call_id: str
    outcome: ApprovalOutcome
    scope: Optional[ApprovalScope] = None
    rejection_message: Optional[str] = None
    approver_identity: Optional[ApproverIdentity] = None
    pattern_key: Optional[str] = None
    scope_description: Optional[str] = None
    decision_kind: Optional[str] = None

    model_config = ConfigDict(extra="allow")


class ApprovalResolvedPayload(BaseModel):
    """PRD §7.4 / §7.5 / §7.6（v0.4 升格 batch）：`agent.stream.approval_resolved` 的 payload。

    v0.4：批量决策回响。decisions 顺序与 ApprovalRequestedPayload.action_requests
    一致；每条独立 outcome / scope / rejection_message。
    """

    batch_id: str
    decisions: List[ApprovalDecision] = Field(..., min_length=1)
    rollback_event_id: Optional[str] = None
    schema_version: Literal[1]

    model_config = ConfigDict(extra="allow")


class LocalRtUserResponseDecision(BaseModel):
    """v0.4：上行 user_response 中的单条决策（客户端 → Django → runtime）。

    （第二刀）：outcome 扩到四档——``allow`` / ``deny`` 是用户主动
    判决；``cancelled`` 由 renderer dismiss / mode 切换 / rollback 走 cancel-hitl
    IPC 上行；``expired`` 由服务端过期扫描回灌（预留）。runtime 内部
    ``PermissionDecisionResult`` 仍是 allow/deny 二元。
    """

    request_id: str
    tool_call_id: str
    outcome: Literal["allow", "deny", "cancelled", "expired"]
    scope: Optional[ApprovalScope] = None
    rejection_message: Optional[str] = None

    model_config = ConfigDict(extra="allow")


class LocalRtUserResponsePayload(BaseModel):
    """v0.4：上行 user response payload（客户端 → Django → runtime）。

    WS envelope `localrt.user_response` 的 `payload.response` 使用此 schema；
    Django 网关层用 `batch_id` 作 Redis SETNX 仲裁键防重复消费（PRD §7.10）。
    """

    batch_id: str
    decisions: List[LocalRtUserResponseDecision] = Field(..., min_length=1)

    model_config = ConfigDict(extra="allow")


# ═══════════════════════════════════════════════════════════════════════
# Ask 三件套 wire schema（W4 R3 / 2026-05-11）
# ═══════════════════════════════════════════════════════════════════════
#
# 历史：W7 / B3 时期定义三件套 schema（AskChoiceRequest / AskFormRequest /
#   RequestApprovalRequest）。W4 一度合一为单 ``ask_user`` 工具；R3 复盘后
#   恢复三件套并存：
#     - ask_user（替代 ask_choice，AskUserQuestion 协议）
#     - ask_form（多字段填表，TabTin HITL 扩展）
#     - request_approval（已决方案审批，TabTin HITL 扩展，必带 risk_level）
#
# 与 TS Zod schema 严格对齐：
#   `packages/agent-wire/src/approval.ts`
#     - AskUserRequestSchema         → AskUserRequest
#     - AskFormRequestSchema         → AskFormRequest
#     - RequestApprovalRequestSchema → RequestApprovalRequest
#
# **跨端边界使用**：relay_handler 把 ask 三件套 wire payload 透传给客户端
# （Electron / mobile / cli-go）；本地不强校验（保持 dict 透传节流），但
# 当字段集偏离时给出 Pydantic ValidationError 让排障路径有 actionable 信息。
#
# 为什么 .strict() 模式：
#   - tool_name 必填（discriminator）—— LLM 误传 'ask_question' 等会被拒
#   - extra='forbid' 让 wire envelope 不可被 attacker 注入额外字段
#
# 与 TS schema 字段一字不差（包括 transport 字段 message_id / tool_call_id /
# interrupt_id / trace_id / preset_id 等）—— `scripts/check-agent-wire-sync.py`
# 跨端字段对齐校验。


class AskOption(BaseModel):
    """ask_user question option（schema 镜像 TS `AskOptionSchema`）"""

    id: str = Field(..., min_length=1)
    label: str = Field(..., min_length=1)
    description: str = Field(..., min_length=1)
    # W4 (2026-05-11): 可选预览内容（mockup / code snippet /
    # diagram 等），UI 在选项卡片下渲染。
    preview: Optional[str] = None

    model_config = ConfigDict(extra="forbid")


class AskOtherOption(BaseModel):
    """ask_user other_option（与 AskOption 同字段；id 可省略，runtime 补 ``__other__``）"""

    id: Optional[str] = Field(None, min_length=1)
    label: str = Field(..., min_length=1)
    description: str = Field(..., min_length=1)
    preview: Optional[str] = None

    model_config = ConfigDict(extra="forbid")


class AskUserQuestionModel(BaseModel):
    """ask_user question（schema 镜像 TS `AskUserQuestionSchema`）

    Pydantic class 名加 ``Model`` 后缀避免与 ``AskUserRequest.questions`` 字段
    名冲突；外部 import 时按需 alias。
    """

    id: str = Field(..., min_length=1)
    prompt: str = Field(..., min_length=1)
    # W4 (2026-05-11): 增加 ``header`` 字段（chip 标签）。
    # 极短标签（≤12 字符），UI 在问题旁显示。可选。
    header: Optional[str] = Field(None, max_length=12)
    options: List[AskOption] = Field(..., min_length=2, max_length=5)
    # 可选：定制本问「其他」入口文案（字段与普通 option 一致）；未传用内置文案。
    other_option: Optional[AskOtherOption] = None
    allow_multiple: Optional[bool] = None
    allow_free_text: Optional[bool] = None

    model_config = ConfigDict(extra="forbid")


# 三件套 transport 字段（runtime ask-tools.ts emit 的语义字段 + wire envelope 透传）
AskInteractionType = Literal["ask_user"]
AskBlockingPolicy = Literal["hard"]


class AskUserRequest(BaseModel):
    """`agent.stream.ask_user_required` payload（schema 镜像 TS `AskUserRequestSchema`）

    W4 R3 (2026-05-11)：替代旧 ``AskChoiceRequest``——`tool_name` 改为 ``"ask_user"``，
    AskUserQuestion 协议。Python 端 wire schema 与 TS Zod schema
    `.strict() + discriminated by tool_name` 严格对齐。
    """

    request_id: str = Field(..., min_length=1)
    tool_name: Literal["ask_user"]
    # W4：title 顶层可选——每个 question 自带 header；顶层 title 为可选汇总。
    # TabTin 历史用 title 作整组问题的卡片标题，保留作可选兜底。
    title: Optional[str] = None
    questions: List[AskUserQuestionModel] = Field(..., min_length=1, max_length=4)
    schema_version: Optional[Literal[1]] = None
    # W7 / A4 review 自修轮：runtime ask-tools.ts emit 的 4 个语义字段必填
    interaction_type: AskInteractionType
    blocking_policy: AskBlockingPolicy
    intent: Literal["choose"]
    form_mode: Literal["questions"]
    message: Optional[str] = None
    # wire envelope transport 字段
    message_id: Optional[str] = None
    tool_call_id: Optional[str] = None
    interrupt_id: Optional[str] = None
    trace_id: Optional[str] = None
    preset_id: Optional[str] = None

    model_config = ConfigDict(extra="forbid")


class AskFormField(BaseModel):
    """ask_form field（schema 镜像 TS `AskFormFieldSchema`，子字段保留 extra='allow'）"""

    key: str = Field(..., min_length=1)
    label: str = Field(..., min_length=1)
    type: Optional[str] = None
    description: Optional[str] = None
    placeholder: Optional[str] = None

    # 子 field schema 接收 composer-presets/registry 的额外字段（required / default /
    # options 等）—— 它们是 frontend SchemaFormRenderer 的契约，不在三件套 SSoT
    # 治理范围内（W5 决策）。
    model_config = ConfigDict(extra="allow")


class AskFormRequest(BaseModel):
    """`agent.stream.ask_form_required` payload（schema 镜像 TS `AskFormRequestSchema`）"""

    request_id: str = Field(..., min_length=1)
    tool_name: Literal["ask_form"]
    title: str = Field(..., min_length=1)
    fields: List[AskFormField] = Field(..., min_length=1)
    addons: Optional[List[Any]] = None
    submit_label: Optional[str] = None
    schema_version: Optional[Literal[1]] = None
    # W7 / A4 review 自修轮：runtime emit 的 4 个语义字段必填（与 TS 对齐）
    interaction_type: AskInteractionType
    blocking_policy: AskBlockingPolicy
    intent: Literal["collect"]
    form_mode: Literal["fields"]
    message: Optional[str] = None
    message_id: Optional[str] = None
    tool_call_id: Optional[str] = None
    interrupt_id: Optional[str] = None
    trace_id: Optional[str] = None
    preset_id: Optional[str] = None

    model_config = ConfigDict(extra="forbid")


class RequestApprovalRequest(BaseModel):
    """`agent.stream.request_approval_required` payload（schema 镜像 TS `RequestApprovalRequestSchema`）"""

    request_id: str = Field(..., min_length=1)
    tool_name: Literal["request_approval"]
    title: str = Field(..., min_length=1)
    rationale: str = Field(..., min_length=1)
    risk_level: Literal["safe", "review", "high"]
    details: Optional[Any] = None
    submit_label: Optional[str] = None
    decline_label: Optional[str] = None
    schema_version: Optional[Literal[1]] = None
    # W7 / A4 review 自修轮：runtime emit 的 4 个语义字段必填（与 TS 对齐）
    interaction_type: AskInteractionType
    blocking_policy: AskBlockingPolicy
    intent: Literal["approve"]
    form_mode: Literal["approval"]
    message: Optional[str] = None
    message_id: Optional[str] = None
    tool_call_id: Optional[str] = None
    interrupt_id: Optional[str] = None
    trace_id: Optional[str] = None
    preset_id: Optional[str] = None

    model_config = ConfigDict(extra="forbid")


# Ask 三件套顶层 discriminated union（与 TS `AskInteractionRequestSchema` 对齐）
AskInteractionRequest = Union[AskUserRequest, AskFormRequest, RequestApprovalRequest]


# ─── 完整事件 shape（type + payload） ────────────────────────────────


APPROVAL_REQUESTED_EVENT_TYPE = "agent.stream.approval_requested"
APPROVAL_RESOLVED_EVENT_TYPE = "agent.stream.approval_resolved"


class ApprovalRequestedEvent(BaseModel):
    type: Literal["agent.stream.approval_requested"]
    payload: ApprovalRequestedPayload


class ApprovalResolvedEvent(BaseModel):
    type: Literal["agent.stream.approval_resolved"]
    payload: ApprovalResolvedPayload


# ═══════════════════════════════════════════════════════════════════════
# Adaptation Helper
# ═══════════════════════════════════════════════════════════════════════


def build_source_meta(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Extract source_meta from an incoming agent runtime payload."""
    return {
        "source": "runtime",
        "backend_type": payload.get("backend_type", payload.get("agent_type", "runtime")),
        "task_id": payload.get("task_id", ""),
    }
