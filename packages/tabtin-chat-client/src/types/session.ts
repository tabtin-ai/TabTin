import type { GroupRuntimeConfig } from './context'

/**
 * 会话状态
 */
export type SessionStatus = 'active' | 'completed' | 'archived'

/** 读取会话内容时可选的入口权限上下文。 */
export interface SessionReadAccess {
  /** 当前共享卡 ID；携带后服务端只认这一张 active SessionShare。 */
  shareId: string
}

export type ModelParamValue = string | number | boolean | null
export type ModelParamOverrides = Record<string, ModelParamValue>
export type ModelRuntimeControlKind = 'select'

export interface ModelRuntimeControlOption {
  value: ModelParamValue
  label: string
  description?: string | null
}

export interface ModelRuntimeControl {
  key: string
  label: string
  description?: string | null
  kind: ModelRuntimeControlKind
  /**
   * canonical 请求参数名。为空时默认等于 key。
   *
   * **仅支持顶层字段名。** 客户端不做点分隔嵌套展开——服务端 proxy 用白名单
   * 构造上游请求体，嵌套键会被整条丢弃。厂商侧的嵌套形态
   * （如 Gemini 的 `extra_body.google.thinking_config`）由服务端 wire_adapter
   * 按模型能力生成，不由 catalog 配置直接表达。
   */
  param_path?: string | null
  default_value?: ModelParamValue
  options?: ModelRuntimeControlOption[]
  visibility?: 'model_menu' | 'advanced' | 'hidden'
}

/** Catalog 下发的 Canonical Runtime Profile capability（W2e；非 UI 控件）。 */
export type RuntimeProfileThinkingMode = 'off' | 'standard' | 'deep'

export interface ModelRuntimeProfileThinking {
  supported: boolean
  modes: RuntimeProfileThinkingMode[]
  default_mode: RuntimeProfileThinkingMode
  /** 始终开启且无可点档（如 Kimi K2.7 Code）；勿当成「不支持思考」。 */
  always_on?: boolean
}

export interface ModelRuntimeProfile {
  thinking: ModelRuntimeProfileThinking
}

export type RollbackCleanupStatus = 'not_started' | 'pending' | 'running' | 'done' | 'failed' | 'pending_retry' | 'abandoned'
export type RollbackApplyResult = 'success' | 'partial_success' | 'failed'
export type RollbackApplyLayerStatus = 'success' | 'partial_success' | 'failed' | 'pending' | 'not_applicable'
export type CheckpointRecordStatus = 'ready' | 'degraded' | 'unavailable' | 'superseded'
export type RevertHistoryEntryType = 'rollback' | 'resource_rollback' | 'unrevert'
export type CheckpointCapabilityKey =
  | 'message_preview'
  | 'file_diff'
  | 'file_restore'
  | 'resource_restore'
  | 'unrevert'
export type CheckpointDegradedReason =
  | 'missing_file_snapshot'
  | 'missing_resource_snapshot'
  | 'missing_effective_checkpoint'

export interface CheckpointCapabilityScope {
  message_preview: boolean
  file_diff: boolean
  file_restore: boolean
  resource_restore: boolean
  unrevert: boolean
}

export interface CheckpointResourceSnapshotRef {
  space_checkpoint_id?: string | null
  has_version_refs: boolean
  version_ref_count?: number
  agent_run_id?: string | null
}

export interface CheckpointConversationStateRef {
  checkpoint_state_index?: number | null
}

export interface CheckpointImpactSummary {
  file_summary?: {
    changed: number
    insertions: number
    deletions: number
  } | null
  resource_change_count?: number
  resource_restore_count?: number
  messages_to_remove?: number
}

export interface CheckpointImpactDetail {
  files?: string[] | null
  files_truncated?: boolean
  files_total_count?: number
  resources?: Array<{
    type: string
    id: string
    action: string
    summary: string
  }> | null
  resources_truncated?: boolean
  resources_total_count?: number
}

export interface SubConversationRef {
  session_id: string
  message_id: string
  label: string
  parent_message_id: string
}

export type DecisionSummaryStatus = 'ready' | 'pending' | 'basic' | 'failed'

export interface OutcomeResourceCount {
  type: string
  count: number
}

export interface OutcomeStructured {
  files_changed?: number
  insertions?: number
  deletions?: number
  resources?: OutcomeResourceCount[]
}

export interface DecisionSummary {
  intent: string
  outcome: string
  outcome_structured?: OutcomeStructured
  key_decisions?: string[]
  open_items?: string[]
  status: DecisionSummaryStatus
}

/**
 * 聊天面板消费的完整版决策上下文。
 *
 * 字段严格对齐后端 `apps.chat.conversation.schemas.CheckpointContextView`。
 * 版本面板使用的精简版见 `@tabtin/collab-core.VersionCheckpointContext`。
 */
export interface CheckpointContext {
  user_prompt?: string | null
  session_id?: string | null
  assistant_message_id?: string | null
  user_message_id?: string | null
  agent_run_id?: string | null
  intent_summary?: string | null
  decision_summary?: DecisionSummary | null
  sub_conversations?: SubConversationRef[] | null
  impact?: CheckpointImpactDetail | null
}

export interface CheckpointRecordView {
  checkpoint_id: string
  session_id: string
  anchor_type: string
  anchor_message_id?: string | null
  anchor_agent_run_id?: string | null
  created_at?: string | null
  file_snapshot_ref?: string | null
  resource_snapshot_ref?: CheckpointResourceSnapshotRef | null
  conversation_state_ref?: CheckpointConversationStateRef | null
  status: CheckpointRecordStatus
  capability_scope: CheckpointCapabilityScope
  degraded_reasons?: CheckpointDegradedReason[]
  impact_summary?: CheckpointImpactSummary | null
  context_summary?: CheckpointContext | null
  trigger?: string | null
  visible_in_history?: boolean | null
}

/** TD-3 / Charter §3.4：单表回滚预览（与 TableCollabAdapter.preview_restore 输出对齐）。 */
export interface RollbackTablePreviewView {
  records_to_restore: number
  records_to_create: number
  records_to_delete: number
  fields_to_restore: string[]
  estimated_duration_ms: number
}

/** TD-2 / Charter §3.3：单表的字段级变更摘要。 */
export interface RollbackTableImpactChangesView {
  records_inserted: number
  records_updated: number
  records_deleted: number
  fields_added: string[]
  fields_removed: string[]
}

export interface RollbackTableImpactEntryView {
  table_id: string
  table_name?: string
  changes: RollbackTableImpactChangesView
  /** TD-3：仅当 plan 中能解析出 target VersionHistory 时存在。 */
  preview?: RollbackTablePreviewView | null
}

/** DC-W0-1-1 / D15 方案 A / Wave 1.1：tabdata 维度影响摘要。 */
export interface RollbackTabdataImpactView {
  tables_affected: RollbackTableImpactEntryView[]
}

export interface RollbackImpactView {
  files: {
    available: boolean
    diff_available: boolean
  }
  resources: {
    available: boolean
    change_count: number
    restore_count: number
  }
  messages: {
    to_remove: number
  }
  /** Wave 1.1：tabdata 维度的「N 张表 / N 行 / 字段级 preview」摘要，
   *  来自 TableImpactContributor + TableAdapter.preview_restore 二阶段聚合。
   *  没有 tabdata 资源涉及的 turn 该字段省略。 */
  tabdata?: RollbackTabdataImpactView | null
}

export interface RollbackApplyLayerView {
  status: RollbackApplyLayerStatus
  reason?: string | null
  restored_count?: number
  failed_count?: number
  retryable?: RollbackRetryableResource[]
  warnings?: RollbackWarningView[]
}

export interface RollbackWarningView {
  resource?: string | null
  warning?: string | null
}

export interface RollbackRetryableResource {
  resource_type: string
  resource_id: string
  action?: 'restore_version' | 'trash' | 'skip'
  restore_to_version_id?: string | null
}

export interface RollbackWorkspaceFilesPartialDetail {
  success?: boolean
  status?: 'partial_success' | 'failed'
  reason?: string | null
}

export interface RollbackResourcesPartialDetail {
  restored_count?: number
  failed_count?: number
  failed_items?: Array<Record<string, unknown>>
  retryable?: RollbackRetryableResource[]
  collab_sync_warnings?: RollbackWarningView[]
}

export interface RollbackPartialSuccessDetails {
  workspace_files?: RollbackWorkspaceFilesPartialDetail | null
  resources?: RollbackResourcesPartialDetail | null
}

export interface SessionRollbackState {
  session_id: string
  revert_active: boolean
  target_message_id?: string | null
  target_checkpoint_id?: string | null
  /** ：保留的 LLM 消息条数，本地宿主据此截断 transcript（agent-engine:rollback-transcript）。 */
  revert_state_index?: number | null
  safety_snapshot_ref?: string | null
  cleanup_status: RollbackCleanupStatus
  can_unrevert: boolean
  last_apply_result?: RollbackApplyResult | null
  partial_success_details?: RollbackPartialSuccessDetails | null
  resource_restore_state?: Array<Record<string, unknown>> | null
  last_rollback_reason?: string | null
  /** 最近一次时间线改写的产品语义；旧服务端缺失时按普通回退处理。 */
  last_operation_mode?: 'rollback' | 'editAndResend'
  updated_at?: string | null
}

export interface RollbackApplyResultView {
  apply_id: string
  overall_status: RollbackApplyResult
  checkpoint_id?: string | null
  checkpoint_record?: CheckpointRecordView | null
  session_state: SessionRollbackState
  layers: {
    conversation: RollbackApplyLayerView
    workspace_files: RollbackApplyLayerView
    resources: RollbackApplyLayerView
    pg_state: RollbackApplyLayerView
  }
  collab_sync_warnings?: RollbackWarningView[]
}

export interface RevertHistoryResourceResultView {
  resource_type: string
  resource_id: string
  success: boolean
}

export interface RevertHistoryEntryView {
  type: RevertHistoryEntryType
  apply_id?: string | null
  target_message_id?: string | null
  snapshot_hash?: string | null
  messages_removed?: number
  restored_count?: number
  failed_count?: number
  resource_count?: number
  resources?: RevertHistoryResourceResultView[]
  reapply_resource_items?: RollbackRetryableResource[]
  apply_result?: RollbackApplyResult | null
  partial_success_details?: RollbackPartialSuccessDetails | null
  created_at: string
}

export interface RollbackPreviewView {
  target_message_id: string
  target_timestamp?: string | null
  /** 绑定当前时间线边界、文件锚点与资源计划的修订指纹。 */
  preview_revision?: string | null
  /** 客户端执行回退时应回传的契约版本。 */
  rollback_contract_version?: number
  checkpoint_hash?: string | null
  /** per-file 文件历史锚点；本地宿主据此查询 IPC 预览。 */
  rewind_anchor_id?: string | null
  /** 已确认会被恢复或删除的文件路径；空数组只有在 preview 状态可用时才代表无影响。 */
  affected_paths?: string[]
  /** 文件恢复的权威执行宿主。 */
  file_restore_host?: 'daemon' | 'local'
  /** 旧客户端兼容字段；新代码优先读取 file_preview_status。 */
  file_preview_success?: boolean
  /** 文件影响预览是否已确认。 */
  file_preview_status?: 'available' | 'not_applicable' | 'unavailable'
  /** 预览不可用或不适用时的稳定原因码。 */
  file_preview_reason?: string | null
  /** 文件锚点、状态与受影响路径的修订指纹。 */
  file_preview_revision?: string | null
  /** 预览阶段已知无法恢复的文件与稳定原因。 */
  unrestorable_files?: Array<{ path: string; reason: string; detail?: string }>
  effective_checkpoint?: CheckpointRecordView | null
  messages_to_remove: number
  messages_preview: Array<{
    id: string
    role: string
    content_preview: string
    agent_run_id: string
    created_at: string | null
  }>
  resource_changes: Array<{
    resource_type: string
    resource_id: string
    resource_name: string
    change_type: string
    summary: string
    agent_run_id: string
  }>
  resource_restore_plan: Array<{
    resource_type: string
    resource_id: string
    resource_name: string
    action: 'restore_version' | 'trash' | 'no_version' | 'skip'
    action_label: string
    can_restore: boolean
    restore_to_version_id: string | null
    restore_to_version_time: string | null
    expected_current_state_revision?: string | null
    change_count: number
  }>
  /** 资源影响和恢复计划是否已完整计算。 */
  resource_preview_status?: 'available' | 'not_applicable' | 'unavailable'
  /** 资源预览不可用的稳定原因码。 */
  resource_preview_reason?: string | null
  unrestorable_items: string[]
  degraded_reasons?: CheckpointDegradedReason[]
  no_impact?: boolean
  impact?: RollbackImpactView | null
}

/**
 * 会话模型
 */
export type ChatSessionRunStatus =
  | 'queued'
  | 'running'
  | 'waiting_user'
  | 'paused'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

/**
 * 会话当前一轮的服务端权威运行投影。
 *
 * `sequence` 在同一会话内跨轮单调递增，`revision` 在同一轮内单调递增。
 * 客户端必须按这两个字段拒绝重复与乱序事件，不能用时间戳判断新旧。
 */
export interface ChatSessionRunState {
  run_id: string
  sequence: number
  revision: number
  status: ChatSessionRunStatus
  queue_depth: number
  started_at: string | null
  state_changed_at: string
  ended_at: string | null
  stop_reason: string | null
  error_class: string | null
  waiting_interaction_id: string | null
}

export interface ChatSession {
  /** 会话ID（UUID） */
  id: string
  /** 会话标题 */
  title: string
  /** 会话状态 */
  status: SessionStatus
  /** 组织ID */
  organization_id: string
  /** 所属 Space ID */
  space_id?: string | null
  /** 可选协作 Project；不代表执行目录或设备。 */
  project_id?: string | null
  /** 当前 Agent 指针（下一轮默认执行者）。 */
  agent_id?: string
  /** Agent 名称（列表脸；activity / 列表 API 可选下发） */
  agent_name?: string | null
  /** Agent 头像 URL 或 preset key（与列表 avatar 口径一致） */
  agent_avatar?: string | null
  /** 会话级执行现场；为空表示 observer。 */
  workspace_id?: string | null
  /** 服务端解析的执行设备目标；缺失表示旧后端，客户端沿用兼容路由。 */
  execution_target?: {
    kind: 'bound_device'
    device_identity_key: string
  } | null
  /** 创建时冻结的执行设备；非空时后续发送始终经 Gateway 交给 Django 定向派发。 */
  target_device_id?: string | null
  agent_mode?: string
  approval_mode?: 'always_ask' | 'auto' | 'full_access'
  /** Agent 线程ID（格式: chat-session-{id}） */
  thread_id?: string | null
  /** 当前使用的模型ID（UUID） */
  current_model_id?: string | null
  /** 当前模型名称 */
  current_model_name?: string | null
  /** 会话默认模型ID（UUID） */
  default_model_id?: string | null
  /** 默认模型名称 */
  default_model_name?: string | null
  /**
   * 当前选择的上下文档位 ID（如 'long_1m'）。
   * 留空 / null = 走当前模型的默认档（`is_default=true` 或第一档）。
   * 详见 ContextTier 类型。
   */
  context_tier_id?: string | null
  /** 当前客户端选择的模型请求参数覆盖；空/缺省 = 使用模型默认。 */
  model_param_overrides?: ModelParamOverrides | null
  /** 创建时间（ISO 8601） */
  created_at: string
  /** 更新时间（ISO 8601） */
  updated_at: string
  /** 最后消息时间，新会话为 null */
  last_message_at?: string | null
  /** 当前用户对 Agent 会话的云端置顶偏好。 */
  is_pinned?: boolean
  pinned_at?: string | null
  /** 消息数量，新会话可能为 0 或 null */
  message_count?: number | null
  /**
   * 是否已有可见消息（ activity / 列表可见性契约）。
   * - `true`/`false`：权威布尔，侧栏空草稿滤镜优先信此字段
   * - 缺键：旧后端；回退 `message_count`，再回退 `last_message_at`
   */
  has_messages?: boolean | null
  /**
   * 是否为 TabChat `@Agent` 内部执行会话。
   * 后端按 Job / ChatContext 运行时派生，不是会话表列。
   * 任务侧栏与 `chat.session.activity.updated` 共用此字段；缺键视为否。
   */
  is_agent_mention_session?: boolean
  /**
   * 当前会话运行投影。
   *
   * - 缺键：旧后端，客户端保留既有本地运行态 / 消息错误兼容逻辑。
   * - `null`：新后端已支持该契约，但此历史会话尚无权威 run。
   * - 对象：以 `sequence` + `revision` 为版本的服务端权威状态。
   */
  run_state?: ChatSessionRunState | null
  /** 输入 tokens */
  input_tokens?: number
  /** 输出 tokens */
  output_tokens?: number
  /** 总 tokens */
  total_tokens?: number
  /** 会话累计缓存命中 input tokens */
  cache_read_input_tokens?: number
  /** 会话累计缓存写入 input tokens */
  cache_creation_input_tokens?: number
  /**
   * @deprecated 2026-05-10 起始终为 0 / 缺失。messages-as-truth 改造后
   * 「当前上下文规模」由 `chatMessageContextUsage.getCurrentContextTokens` 从
   * messages 派生（apps/tabtin-electron/.../utils/chatMessageContextUsage.ts），
   * 不再走 session 字段。字段保留仅为 wire 层向下兼容老构建；下次 schema
   * breaking change 时连同 backend `schemas.py` / yaml 契约一并删除。
   */
  context_tokens?: number
  /** 最后一条消息的预览文本 */
  last_message_preview?: string | null
  /** 是否处于已回滚状态 */
  is_reverted?: boolean
  /** 回滚前快照哈希，用于 unrevert 时恢复文件 */
  revert_snapshot_hash?: string | null
  /** 会话级回滚状态聚合视图 */
  rollback_state?: SessionRollbackState | null
  /**
   * 标题是否仍是各语言"新对话"默认值——server 端 TitleGeneratorService.should_generate_title
   * 算出来的权威结果。前端 selectSession 兜底 generate-title 时用这个字段决定要不要触发，
   * 不再用硬编码的"新对话"/"New chat"字面值集合（容易跟后端 i18n 配置漂移）。
   */
  title_is_default?: boolean
  /**
   * 标题生成的后台状态（pending / in_progress / done / failed）。
   * 供触发逻辑与 backfill 使用；列表 UI 不展示 failed 徽标（后台静默重试）。
   *
   * 详见 `ChatSession.title_generation_status` 后端字段。
   */
  title_generation_status?: 'pending' | 'in_progress' | 'done' | 'failed'
  /** Fork 来源会话 ID（非空表示由 fork 创建） */
  forked_from_id?: string | null
  /** Fork 分叉点消息 ID */
  fork_point_message_id?: string | null
  /** 从此会话 fork 出的分支数量 */
  fork_count?: number
  /** 大 fork 异步消息复制进度 */
  fork_copy_status?: 'pending' | 'complete' | 'failed' | null
  /** Fork / 状态复制时的非致命告警（截断失败、上下文缺失等） */
  warnings?: string[]
  /**
   * ：同步 fork 返回的旧 tool id → tu_*。本机归档 remap 应种子化此表，
   * 与云端 ConversationState / ChatMessage 保持同一命名空间。异步 fork 时为 null。
   */
  tool_id_remap?: Record<string, string> | null
  /**
   * Wave 5 (charter v1.8 §6.7): 当此 ChatSession 是 Tracker Run 的容器时,后端反向
   * 冗余 GoalRun 关联信息(只读)。前端用此渲染 4 个 UI 表达点:
   *  - 顶部 breadcrumb chip("📋 Tracker: {name} · Run #{n}")
   *  - 会话列表 icon(区分普通对话)
   *  - 首条 system 消息(渲染 trigger_context)
   *  - 末尾 Run 状态指示器
   *
   * 非 Tracker Run 关联的 ChatSession 此字段为 null/undefined。
   */
  tracker_run?: TrackerRunMeta | null
}

/**
 * Wave 5 (charter v1.8 §6.7): ChatSession 关联的 GoalRun 反向冗余信息。
 */
export interface TrackerRunMeta {
  /** GoalRun.id */
  run_id: string
  /** 该 Tracker 的第几次 Run(按 created_at 排序,从 1 开始) */
  run_index: number
  /** Run 当前状态: pending / running / success / failed / cancelled */
  run_status: string
  /** Tracker (Goal).id */
  tracker_id: string
  /** Tracker (Goal).name */
  tracker_name: string
  /**
   * Tracker 来源: user_created (本期固定) / system_preset (本期未启用)。
   * charter §7.1 origin 字段已移除,但本字段为前端区分预留(charter §6.7 第 2 表达点)。
   */
  tracker_origin: 'user_created' | 'system_preset'
  /** 本次 Run 的触发来源: manual / scheduled / retry / event */
  trigger_type: string
  /** 原 Tracker 的触发类型；可选以兼容尚未返回该字段的旧服务端。 */
  tracker_trigger_type?: string
  /** 触发上下文(trigger_context),首条 system msg 渲染用 */
  trigger_context: Record<string, unknown>
  /** Run 开始时间(ISO 8601) */
  started_at?: string | null
  /** Run 结束时间(ISO 8601) */
  finished_at?: string | null
  /**
   * Wave 6 (charter v1.8 §4.4): Tracker 引用的 Skill 标识。前端按
   * skill_key → app 映射决定"看产物"按钮跳转目标 app(TabMemo/TabCode/
   * TabData/TabDoc/TabSlide)。空串/缺失视为无产物可跳,降级到 Run 详情。
   */
  skill_key?: string
  /**
   * Wave 6 续作 P0-3 (charter §4.4 "看产物 1 步可达"):产物定位 ref。
   * 后端 ChatSessionSchema.tracker_run resolver 从 GoalRun.context 抽取——
   * agent_result 里的 artifact_id / memo_id / record_ids / doc_id / slide_id /
   * code_path 字段命中即透传(snake_case 在 schema 层,前端 navigator 转 camelCase)。
   * 用于 TrackerRunStatusIndicator 的"复制产物链接"按钮 + 跳产物深度路由。
   */
  artifact_ref?: {
    artifact_id?: string
    memo_id?: string
    record_ids?: string[]
    doc_id?: string
    slide_id?: string
    code_path?: string
  }
  /**
   * Wave 6 续作 P0-4 (charter §4.4 / plan §Phase 6 验收 #1):
   *   失败 Run 的"可点击恢复动作"。前端按 kind 渲染按钮,label 直接展示。
   *   只在 run_status=failed 时填充。
   */
  recovery_actions?: RecoveryAction[]
}

/**
 * Wave 6 续作 P0-4 (charter §4.4 / plan §Phase 6 验收 #1):结构化恢复动作。
 *
 * kind 枚举:
 *   - rerun:             重新运行(沿用原配置)
 *   - retry_with_model:  换模型重试(model 字段指定 model_id)
 *   - switch_agent:      换 Agent 重试
 *   - check_permission:  检查权限/资源后重试
 *   - adjust_budget:     调整预算/额度
 *   - wait_and_rerun:    稍等再试(冷却 1-2 分钟)
 */
export type RecoveryActionKind =
  | 'rerun'
  | 'retry_with_model'
  | 'switch_agent'
  | 'check_permission'
  | 'adjust_budget'
  | 'wait_and_rerun'

export interface RecoveryAction {
  kind: RecoveryActionKind
  label: string
  /** 仅 retry_with_model 时使用 */
  model?: string
}

/**
 * 待处理用户交互（HITL 权威事实）。
 *
 * 后端 `PendingInteraction` 的序列化视图（`serialize_interaction`）：实时 stream
 * 负责“快”，本记录负责“准”——晚进入、断网恢复、多端抢答、过期关闭都从这里收敛。
 * 客户端在进会话 / 重连 / seq-gap 补拉时拉取仍 `status='pending'` 的记录，作为
 * 追问 / 审批面板是否应保持打开的权威判据（消息与 HITL 同一条 sync 路径对账）。
 */
export interface PendingInteraction {
  id: string
  /** ask_choice / ask_form / permission_request（单 HITL）｜tool_approval（批量审批） */
  kind: string
  /** pending / resolved / expired / cancelled */
  status: string
  thread_id: string
  session_id?: string | null
  organization_id: string
  user_id: string
  /** 单 HITL = request_id；批量审批 = batch_id。与前端面板 interruptId / batchId 对齐。 */
  request_key: string
  source: string
  /** 原始 wire 事件 payload（upsert 时存入），字段结构与 stream *_required 事件一致。 */
  payload: Record<string, unknown>
  result: Record<string, unknown>
  expires_at?: number | null
  resolved_at?: number | null
  created_at?: number | null
  updated_at?: number | null
}

/**
 * `GET /sessions/{id}/pending-interactions` 响应。
 */
export interface PendingInteractionListResponse {
  interactions: PendingInteraction[]
}

/**
 * 创建会话请求
 */
export interface CreateSessionRequest {
  /** 初始当前 Agent 指针。 */
  agent_id: string
  /** 执行现场；为空创建 observer 会话。 */
  workspace_id?: string | null
  /** 可选协作 Project；不承载执行目录或设备。 */
  project_id?: string | null
  /** Daemon Control 设备 ID；必须与 workspace_id 的执行设备一致。 */
  target_device_id?: string | null
  agent_mode?: string
  approval_mode?: 'always_ask' | 'auto' | 'full_access'
  /** 组织ID（兼容字段，可选） */
  organization_id?: string
  /** 初始模型ID（可选，UUID） */
  model_id?: string
}

export interface QuickStartSessionRequest extends CreateSessionRequest {
  /** 当前资源宿主；协作 Project 请用 current_project_id。 */
  current_space_id?: string | null
  /** 当前协作 Project。 */
  current_project_id?: string | null
  current_app_type?: string | null
  open_tabs?: Array<Record<string, unknown>> | null
}

export interface QuickStartSessionResponse {
  session: ChatSession
  group_runtime?: GroupRuntimeConfig | null
  context_fingerprint?: string | null
}

/**
 * 更新会话请求
 */
export interface UpdateSessionRequest {
  /** 会话标题 */
  title?: string
  /** 会话状态 */
  status?: SessionStatus
  /** 下一轮默认执行者；服务端记录切换事实 */
  agent_id?: string | null
  /** 执行现场；null 将会话切为 observer */
  workspace_id?: string | null
  /**  Composer 工作方式；不传则服务端不变 */
  agent_mode?: 'ask' | 'agent' | 'plan' | 'group'
  approval_mode?: 'always_ask' | 'auto' | 'full_access'
  /** 显式置顶值，避免跨端 toggle 竞态。 */
  is_pinned?: boolean
}

/**
 * 会话列表响应
 */
export interface SessionListResponse {
  /** 会话列表 */
  sessions: ChatSession[]
  /** 总数量 */
  total: number
  /** 服务端明确因 TabChat `@Agent` 来源策略排除的会话 ID */
  excluded_agent_mention_session_ids?: string[]
  /**
   * 隐患 5 / 方案 ①（charter v1.8 §6.7 主侧栏分桶）：
   * - 当 `include_tracker_runs=false`（默认）：后端已剔除关联 TrackerRun 的
   *   ChatSession，此字段为"被剔除掉的 Tracker session 数量"，供前端在
   *   「自动化任务执行记录」折叠分组 header 上显示 count badge。
   * - 当 `include_tracker_runs=true` 或后端跨库 PG 查询失败（fallback 到不分桶）：
   *   此字段为 `null`，前端 fallback 到"不显示 badge"。
   */
  tracker_run_count?: number | null
}

/**
 * 会话查询参数
 */
export interface SessionQueryParams {
  /** 只读兼容旧服务端；新调用请勿传。 */
  space_id?: string
  /** 执行现场 Workspace.id（ 正典参数） */
  workspace_id?: string
  /** 协作 Project.id。与 workspace_id 二选一。 */
  project_id?: string
  /** 组织ID（兼容字段，可选） */
  organization_id?: string
  /** 返回数量限制 */
  limit?: number
  /** 分页偏移量 */
  offset?: number
  /** 筛选状态 */
  status?: SessionStatus
  /** 是否排除由 TabChat `@Agent` 调用生成的内部会话 */
  exclude_agent_mention_sessions?: boolean
  /**
   * 隐患 5 / 方案 ①（charter v1.8 §6.7 主侧栏分桶）：
   * - `undefined` / `false`（默认）：返回不含 Tracker per_run session 的列表，
   *   响应附带 `tracker_run_count` 供折叠分组 header 显示数量。
   * - `true`：仅返回关联 TrackerRun 的 ChatSession（折叠分组展开时单独 fetch）。
   * 详见 `ChatSessionSwitcher.tsx` 的折叠分组懒加载逻辑。
   */
  include_tracker_runs?: boolean
}

/**
 * 跨 Space 对话列表精简会话（只含列表展示所需字段 + Agent 元信息）
 */
export interface ChatSessionWithAgent {
  id: string
  title: string
  status: string
  organization_id: string
  space_id?: string | null
  created_at: string
  updated_at: string
  last_message_at?: string | null
  message_count?: number | null
  /** 同 ChatSession.has_messages：列表可见性权威布尔（可选）。 */
  has_messages?: boolean | null
  /** 与 ChatSession.run_state 同形；缺键兼容旧后端，null 表示无历史 run。 */
  run_state?: ChatSessionRunState | null
  last_message_preview?: string | null
  is_reverted?: boolean
  rollback_state?: SessionRollbackState | null
  /** 同 ChatSession.title_is_default。 */
  title_is_default?: boolean
  /** 所属 Space 名称 */
  space_name?: string | null
  /** 关联的 Agent ID */
  agent_id?: string | null
  /** Agent 名称 */
  agent_name?: string | null
  /** Agent 图标 */
  agent_icon?: string | null
  /** Agent 头像 URL */
  agent_avatar?: string | null
  /** Agent 类型标签（如 bot/human/system） */
  agent_type?: string | null
  /** Agent 是否正在执行任务 */
  has_active_task?: boolean
  /** Agent 是否有用户未查看的新回复 */
  has_unread_reply?: boolean
  /** 搜索命中上下文（仅 keyword 搜索时返回，展示命中的消息片段） */
  search_match_context?: string | null
}

/**
 * 跨 Space 会话查询参数
 */
export interface AllSessionQueryParams {
  /** 组织 ID（必填） */
  organization_id: string
  /** 返回数量限制 */
  limit?: number
  /** 分页偏移量 */
  offset?: number
  /** 筛选状态 */
  status?: SessionStatus
  /** 标题搜索关键词 */
  keyword?: string
  /** 按 Agent ID 筛选 */
  agent_id?: string
  /**
   * 隐患 5 / 方案 ①（charter v1.8 §6.7 主侧栏分桶）。
   * 语义同 {@link SessionQueryParams.include_tracker_runs}。
   */
  include_tracker_runs?: boolean
}

/**
 * 跨 Space 会话列表响应
 */
export interface AllSessionListResponse {
  /** 会话列表（含 Agent 信息） */
  sessions: ChatSessionWithAgent[]
  /** 总数量 */
  total: number
  /** 是否还有更多数据 */
  has_more: boolean
  /**
   * 隐患 5 / 方案 ①（charter v1.8 §6.7 主侧栏分桶）。
   * 语义同 {@link SessionListResponse.tracker_run_count}。
   */
  tracker_run_count?: number | null
}

/**
 * LLM 模型信息
 */
export interface PromotionCredit {
  /** 当前模型是否匹配可用 Provider Credit */
  eligible: true
  /** 稳定 Provider key */
  provider_key: string
  /** 当前匹配 Grant 的可用 credits 总额 */
  remaining_credits: number
  /** 发放总额（用于「赠享 剩余/总量」展示） */
  total_credits: number
  /** 最早到期时间；无固定到期时间时为 null */
  expire_at: string | null
  /** 服务端活动名称，不由客户端拼接供应商名 */
  label: string
}

export interface Model {
  /** 模型唯一标识符 */
  id: string
  /** 模型名称（用于 API 调用） */
  name: string
  /** 模型名称（兼容字段） */
  model_name?: string
  /** 用户界面显示的名称 */
  display_name: string
  /** 模型提供商标识 */
  provider: string
  /** 提供商显示名称 */
  provider_display_name: string
  /** 提供商ID */
  provider_id?: string
  /** 提供商渠道标识 */
  provider_key?: string
  /** 提供商作用范围 */
  provider_scope?: 'global' | 'organization' | 'user' | null
  /** 提供商是否参与路由（：false 时对话中不可选用） */
  provider_routing_enabled?: boolean
  /** 模型是否可路由（与 provider_routing_enabled 对齐） */
  routing_enabled?: boolean
  /** 模型描述 */
  description: string
  /** 模型模式 */
  mode?: string
  /** 最大 token 数 */
  max_tokens: number
  /** 上下文总容量（兼容字段） */
  context_window_tokens?: number
  /** 最大输入 token 数 */
  max_input_tokens?: number
  /** 最大输出 token 数 */
  max_output_tokens?: number
  /** 是否支持流式输出 */
  supports_streaming: boolean
  /** 是否支持视觉输入 */
  supports_vision: boolean
  /** 是否支持视频输入（原生 video_url，） */
  supports_video_input?: boolean
  /** 是否支持文档输入（原生 file_url，） */
  supports_document_input?: boolean
  /** 是否支持函数调用 */
  supports_function_calling?: boolean
  /** 每千 tokens 成本 */
  cost_per_1k_tokens: number
  /** 输入 Token 价格(每1K) */
  input_price_per_1k?: number
  /** 输出 Token 价格(每1K) */
  output_price_per_1k?: number
  /** 计费类型 */
  billing_type?: string
  /** 扩展能力配置 */
  capabilities_config?: Record<string, any>
  /** 归一化能力快照（catalog 顶层 supports_* 缺失时的兜底来源，） */
  resolved_capabilities?: Record<string, boolean>
  /** 多模态限制配置 */
  multimodal_limits?: Record<string, any>
  /** 是否为默认模型 */
  is_default: boolean
  /**
   * 上下文档位列表（如 ZenMux 1M 长上下文）。
   *
   * 后端以 `LLMModel.custom_billing_config.tiered_pricing.tiers[]` 为底层数据，
   * 通过 `_serialize_context_tiers_for_client` 脱敏后下发：
   * `extra_headers` 内容不下发，只标记 `has_extra_headers`。
   *
   * 仅当模型配置了多档时长度 > 1，单档或未配置时为空数组 / undefined，
   * 前端据此决定是否在 ChatInput 显示档位芯片。
   */
  context_tiers?: ContextTier[]
  /** 模型可供用户调节的运行时请求参数控件。 */
  runtime_controls?: ModelRuntimeControl[]
  /**
   * Canonical Runtime Profile capability（W2e）。
   * 与 `runtime_controls` 并存；不含 provider / wire 参数。
   */
  runtime_profile?: ModelRuntimeProfile
  /** Provider Sponsored Credit 展示能力；Feature Flag 关闭时字段缺失 */
  promotion_credit?: PromotionCredit | null
}

/**
 * 模型上下文档位（用户可主动选择的"上下文长度方案"）。
 *
 * 同一逻辑模型（如 Claude Opus 4.6）通过档位区分多种上下文长度 + 计费策略：
 *   - id 'standard'：默认 200K，标准价
 *   - id 'long_1m'：1M 长上下文（Beta），ZenMux 透传 anthropic-beta header，
 *                   超 200K 部分按更高单价
 */
export interface ContextTier {
  /** 档位唯一 ID（如 'standard' / 'long_1m'） */
  id: string
  /** 显示文案（已 i18n / 运营自填） */
  label: string
  /** 是否为默认档；同一模型最多一档为 true */
  is_default: boolean
  /** 该档允许的最大输入 token 数 */
  max_input_tokens: number | null
  /** 标签（前端用于显示 Beta / Preview 等小角标） */
  tags: string[]
  /** 是否会向上游注入额外 Header（如 anthropic-beta） */
  has_extra_headers: boolean
  /**
   * 整组档位是否属于「用户可切换」语义（而非纯自动阶梯计费）。
   *
   * 后端根据整组档位综合判断（详见
   * `_compute_tiers_user_selectable`）：仅当运营配了
   * extra_headers / tags / is_default 任一时才为 true，下发给同组每档。
   *
   * 前端决策：
   *   - true  → 在模型卡片上显示档位芯片，允许用户主动切档
   *   - false → 隐藏芯片（纯阶梯计费，运行时按 token 用量自动选档，
   *             用户不应感知多档存在，如旧数据或 Gemini/Qwen 的按长度阶梯价）
   */
  is_user_selectable: boolean
  /** 该档基础输入 Token 单价（每 1K） */
  input_price_per_1k?: number
  /** 该档基础输出 Token 单价（每 1K） */
  output_price_per_1k?: number
  /** 「档内分裂」阈值：超过此 token 数的部分按 over_*_price 计算 */
  applies_above_tokens?: number
  /** 超阈值后的输入单价 */
  over_input_price_per_1k?: number
  /** 超阈值后的输出单价 */
  over_output_price_per_1k?: number
}

/**
 * 模型列表响应
 */
export interface ModelsResponse {
  /** 可用模型列表 */
  models: Model[]
  /** 默认模型ID */
  default_model_id: string
  /** 默认模型名称 */
  default_model_name: string
  /** 显式配置的组织默认模型ID */
  organization_default_model_id?: string
  /** 显式配置的组织默认模型名称 */
  organization_default_model_name?: string
  /** 当前用户在该组织内的默认模型ID */
  user_default_model_id?: string
  /** 当前用户在该组织内的默认模型名称 */
  user_default_model_name?: string
  /** 新派发子 Agent 的默认模型策略 */
  subagent_model_policy?: 'inherit' | 'fixed'
  /** 新派发子 Agent 固定模型ID */
  subagent_model_id?: string | null
  /** 模型总数 */
  total: number
  /** Provider 元数据（Catalog API v2+） */
  providers?: Record<
    string,
    {
      display_name?: string
      icon_emoji?: string
      /** Django static 品牌标路径或绝对 URL */
      icon_url?: string
      color_class?: string
      default_base_url?: string
      supports_openai_compat?: boolean
    }
  >
}

export interface FundingPreviewAllocation {
  source_type: 'provider_credit' | 'monthly_budget' | 'organization_wallet'
  credits: string
  source_id?: string
  campaign_code?: string
  label?: string
  provider_key?: string
  expire_at?: string | null
}

export interface FundingPreviewResponse {
  allowed: boolean
  code: string | null
  message: string | null
  required_credits: string
  included_available: string
  wallet_available: string
  wallet_required: string
  charge_mode: string
  metadata: Record<string, unknown>
  /** PROVIDER_CREDIT_UI_ENABLED 关闭时字段缺失 */
  estimated_credits?: string
  /** PROVIDER_CREDIT_UI_ENABLED 关闭时字段缺失 */
  funding_preview?: FundingPreviewAllocation[]
}

/**
 * 切换模型请求
 */
export interface SwitchModelRequest {
  /** 目标模型ID（UUID） */
  model_id: string
  /**
   * 同时切换上下文档位 ID（可选）。
   *
   * 留空 / 缺省：保持当前档位，但若新模型上不存在原档位 ID，后端会清空。
   * 显式传值：必须存在于新模型 `context_tiers[].id`，否则 400。
   */
  context_tier_id?: string
}

/**
 * 切换模型响应
 */
export interface SwitchModelResponse {
  /** 成功标志 */
  success: boolean
  /** 会话ID */
  session_id: string
  /** 之前的模型ID */
  previous_model_id: string
  /** 之前的模型名称 */
  previous_model_name: string
  /** 当前模型ID */
  current_model_id: string
  /** 当前模型名称 */
  current_model_name: string
  /** 当前生效的上下文档位 ID（null = 默认档） */
  context_tier_id?: string | null
  /** 提示消息 */
  message: string

  // 兼容旧版本字段
  /** @deprecated 使用 previous_model_id */
  previous_model?: string
  /** @deprecated 使用 current_model_id */
  current_model?: string
}

/**
 * 切换上下文档位请求（不切换模型）
 */
export interface SwitchContextTierRequest {
  /** 目标档位 ID；空字符串 / null = 重置为默认档 */
  context_tier_id: string | null
}

/**
 * 切换上下文档位响应
 */
export interface SwitchContextTierResponse {
  success: boolean
  session_id: string
  previous_tier_id: string | null
  current_tier_id: string | null
  message: string
}

export interface UpdateModelParamsRequest {
  model_param_overrides: ModelParamOverrides
}

export interface UpdateModelParamsResponse {
  success: boolean
  session_id: string
  model_param_overrides: ModelParamOverrides
}
