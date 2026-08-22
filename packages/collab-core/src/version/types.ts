/**
 * Collab Version Management Types
 *
 * 统一版本管理类型定义，所有模块共用。
 */

export interface VersionHistoryItem {
  id: string
  module: string
  is_snapshot: boolean
  is_named: boolean
  name: string
  pinned: boolean
  editor_type: string // "user" | "agent" | "system"
  editor_id: string
  editor_name?: string
  agent_run_id?: string | null
  blob_size: number
  created_at: string
  expired_at: string | null
  extra?: Record<string, unknown>
  /** checkpoint_context from SpaceCheckpoint.metadata (populated for agent edits) */
  checkpoint_context?: VersionCheckpointContext | null
}

// ── 对话追溯类型 ─────────────────────────────────────

/**
 * 子 Agent 对话引用。
 *
 * 对齐后端 `apps.collab.services.checkpoint_context._build_sub_conversations`
 * 返回的 dict 结构（session_id / message_id / label / parent_message_id）。
 */
export interface SubConversationRef {
  session_id: string
  message_id: string
  label: string
  parent_message_id: string
}

/**
 * 版本面板使用的精简决策上下文（从 `SpaceCheckpoint.metadata.checkpoint_context` 序列化而来）。
 *
 * 注意（Wave 12）：历史上本类型名曾为 `CheckpointContext`，与
 * `@tabtin/chat-client.CheckpointContext`（聊天面板用的完整版）同名但字段不同，
 * 易混淆。现重命名为 `VersionCheckpointContext` 以明确语义边界。
 *
 * 字段对齐 `apps.services.common.version_history.schemas.serialize_history_list`
 * 的输出：仅保留版本面板列表渲染所需字段；完整版见 chat-client。
 */
export interface VersionCheckpointContext {
  session_id?: string | null
  assistant_message_id?: string | null
  user_message_id?: string | null
  user_prompt?: string | null
  agent_run_id?: string | null
  /** 快速标记：Agent 这次执行派生了子会话（用于列表徽标） */
  has_sub_conversations?: boolean
  /** 子 Agent 对话引用列表（后端在 checkpoint 创建时固化到 metadata） */
  sub_conversations?: SubConversationRef[] | null
  /**
   * Wave 14 QC-12 / PRD §3.5：后端批量预检的"会话是否仍然存活"标记。
   *
   *   - true  — 会话仍可访问，"查看对话片段"按钮正常可点。
   *             **注意**：后端查询异常（数据库不可用等）时同样乐观返回 true，
   *             避免基础设施抖动把所有入口误置灰；此时依赖点击后 popover 404
   *             作为二次兜底（`segmentArchived` 路径）。
   *   - false — 会话不存在或已归档（ChatSession 不在 / status='archived'），
   *             前端将按钮置灰并提示"原始对话已归档"。
   *   - undefined — 后端未返回该字段（旧客户端/非 `serialize_history_list` 路径），
   *             降级为旧行为：按钮可点，靠点击后的 popover 404 反馈归档。
   */
  session_exists?: boolean
}

/**
 * @deprecated Wave 12 重命名为 `VersionCheckpointContext`。
 * 为保持外部消费方（如 Electron / 其它独立模块）的渐进迁移，
 * 保留类型别名。新代码请直接使用 `VersionCheckpointContext`。
 */
export type CheckpointContext = VersionCheckpointContext

export interface ConversationSegmentMessage {
  id: string
  role: 'user' | 'assistant' | string
  content: string
  created_at: string | null
  is_anchor?: boolean
  content_truncated?: boolean
}

export interface ConversationSegmentResponse {
  messages: ConversationSegmentMessage[]
  has_more_before: boolean
  has_more_after: boolean
  /** API returned 404 — the original session has been archived or deleted */
  session_archived?: boolean
}

export interface ViewConversationOptions {
  sessionId?: string
  messageId?: string
}

export interface VersionListResponse {
  status: string
  data: VersionHistoryItem[]
  total: number
}

export interface CreateNamedVersionRequest {
  name: string
}

export interface RestoreVersionRequest {
  version_id: string
}

export interface RenameVersionRequest {
  name: string
}

export interface TogglePinRequest {
  pinned: boolean
}

export interface AgentRunChangesResponse {
  status: string
  data: Array<{
    id: string
    resource_type: string
    resource_id: string
    change_type: string
    summary: string
    editor_type: string
    editor_name: string
    created_at: string
  }>
  total: number
}

/**
 * VersionAdapter — 各模块提供的差异化配置。
 *
 * VersionPanel 通过 adapter 获取数据和执行操作，
 * 不直接依赖任何模块的内部实现。
 */
export interface VersionAdapter {
  resourceType: string
  resourceId: string

  /** 自定义版本描述渲染（可选）。默认显示 editor_type + created_at。 */
  renderDescription?: (item: VersionHistoryItem) => string

  /** 自定义 diff 预览组件（可选）。默认不展示 diff。 */
  DiffPreview?: React.ComponentType<{ versionId: string; version?: VersionHistoryItem }>
}

/**
 * VersionPanel 可自定义文案，用于 i18n 支持。
 * 所有字段可选，未提供时使用中文默认值，保持向后兼容。
 */
export interface VersionPanelLabels {
  title?: string
  allVersions?: string
  namedVersions?: string
  save?: string
  restore?: string
  confirmRestore?: string
  cancel?: string
  loadMore?: string
  loading?: string
  nameVersion?: string
  unname?: string
  pin?: string
  unpin?: string
  preview?: string
  noVersions?: string
  /** 支持 {count} 占位符，如 "共 {count} 个版本" */
  versionCount?: string
  /** TTL 过期时间前缀 */
  expiresAt?: string
  /** 「过期于」行的 tooltip，说明到期自动清理规则 */
  expiresAtTooltip?: string
  /** 面板底部版本保留 / 自动清理说明；设为空字符串可隐藏 */
  versionRetentionHint?: string
  current?: string
  editorUser?: string
  editorSystem?: string
  editorAI?: string
  /**
   * QC-18 / PRD §3.5：纯用户编辑时显示"由你手动编辑"标签（editor_type === 'user'）。
   * 与 editor_type=system 的"系统"标签平级，用于区分三种编辑来源。
   */
  editorUserManual?: string
  /**
   * QC-02.A / PRD §3.4 US-1：Agent 编辑若派生了子会话，在版本条目上显示"含子任务"徽章。
   * 数据来源：`VersionCheckpointContext.has_sub_conversations`。
   */
  hasSubTasks?: string
  /**
   * 多个子任务时的带 count 文案，支持 {count} 占位符。
   * 如 "含 {count} 个子任务" / "{count} sub-tasks"。
   */
  hasSubTasksWithCount?: string
  viewConversation?: string
  /** "查看对话片段" 按钮文案 */
  viewConversationSegment?: string
  /** "在聊天面板中打开完整对话 →" 链接文案 */
  openFullConversation?: string
  /** 对话片段浮层标题 */
  conversationSegmentTitle?: string
  /** 对话片段加载失败 */
  conversationSegmentError?: string
  /** 对话片段为空（无消息） */
  conversationSegmentEmpty?: string
  /** 原始会话已归档/已删除 */
  conversationSessionArchived?: string
  /** 对话片段浮层中用户角色 */
  roleUser?: string
  /** 对话片段浮层中 AI 角色 */
  roleAssistant?: string
  /**
   * QC-02.B / PRD §3.4 US-3：浮层内子任务摘要卡片标题（label 前缀）。
   * 示例："子任务"→ 渲染为"子任务：代码审查"。
   */
  subTaskLabel?: string
  /** 子任务卡片"展开子任务对话 ↓" */
  subTaskExpand?: string
  /** 子任务卡片"收起子任务对话 ↑" */
  subTaskCollapse?: string
  /** 子任务深度超过 2 层时的提示链接（跳转查看完整对话） */
  subTaskViewMore?: string
  /** 子任务子 session 加载中 */
  subTaskLoading?: string
  /** 子任务无消息/加载失败 */
  subTaskEmpty?: string

  /** ⋯ 按钮 aria-label */
  actions?: string

  // ── 错误消息 ──
  saveVersionFailed?: string
  restoreFailed?: string
  renameFailed?: string
  pinFailed?: string
  unnameFailed?: string

  // ── 相对时间 ──
  justNow?: string
  minutesAgo?: (n: number) => string
  hoursAgo?: (n: number) => string
  daysAgo?: (n: number) => string
  lessThanMinuteFromNow?: string
  minutesFromNow?: (n: number) => string
  hoursFromNow?: (n: number) => string
  daysFromNow?: (n: number) => string

  // ── 时间分组标签 ──
  pinnedVersions?: string
  today?: string
  yesterday?: string
  earlierThisWeek?: string

  /**
   * 完全自定义相对时间格式化（优先级高于 justNow / minutesAgo 等单项 label）。
   * 传入 ISO 时间字符串，返回可读文案。
   */
  formatRelativeTime?: (isoString: string) => string
  /**
   * 完全自定义时间分组标签（优先级高于 today / yesterday 等单项 label）。
   * 传入 ISO 时间字符串，返回分组标签。
   */
  formatTimeSectionLabel?: (isoString: string) => string
}

/**
 * 统一操作结果。所有写操作都返回此类型，
 * 替代之前不一致的 throw / 静默忽略 / { success, error } 混合策略。
 */
export interface OperationResult {
  success: boolean
  error?: string
}
