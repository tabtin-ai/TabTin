/**
 * Agent Debug 类型定义
 * 基于 AgentDash API 文档
 */

// ============ Trace 相关类型 ============

export type TraceStatus = 'running' | 'completed' | 'error'

export type GraphType = 'tin' | string
export type DebugPayload = Record<string, unknown>

export interface Trace {
  id: number // 数据库主键 ID（用于分页游标）
  trace_id: string
  thread_id: string | null
  session_id: string | null
  instance_id?: string | null
  organization_id?: string | null
  user_id: string | null // API 使用 string 类型
  graph_type: GraphType
  status: TraceStatus
  started_at: string // API 字段名
  ended_at: string | null // API 字段名
  duration_ms?: number // 前端计算或后端提供的执行耗时
  error: string | null // API 字段名
  metadata: DebugPayload | null
}

export interface TraceFilter {
  graph_type?: GraphType
  thread_id?: string
  session_id?: string
  limit?: number
  cursor?: string // 游标分页（UUID）
}

export interface TraceListResponse {
  items: Trace[] // API 使用 items
  next_cursor: string | null // 游标分页（UUID）
  // 注意：API 不返回 total 字段，使用游标分页
}

export type ThreadStatusFilter = 'all' | 'error' | 'running' | 'completed'

export interface ThreadSummary {
  threadId: string
  sessionId: string | null
  sessionTitle: string | null
  userId: string | null
  userName: string | null
  userPhone: string | null
  organizationId: string | null
  organizationName: string | null
  traces: Trace[]
  traceCount: number
  firstStartedAt: string
  latestStartedAt: string
  totalDurationMs: number
  statusStats: {
    completed: number
    running: number
    error: number
  }
  totalToolCalls: number
  totalLLMCalls: number
}

export interface ThreadListFilter {
  keyword?: string
  /** 用户名或用户 ID（后端 OR 匹配） */
  user?: string
  /** 组织名或组织 ID（后端 OR 匹配） */
  organization?: string
  /** @deprecated 请用 user */
  userId?: string
  /** @deprecated 请用 user */
  userName?: string
  /** @deprecated 请用 organization */
  organizationId?: string
  /** @deprecated 请用 organization */
  organizationName?: string
  sessionTitle?: string
  status?: ThreadStatusFilter
  page?: number
  pageSize?: number
}

export interface ThreadListResponse {
  items: Array<{
    thread_id: string
    session_id: string | null
    session_title?: string | null
    user_id?: string | null
    user_name?: string | null
    user_phone?: string | null
    organization_id?: string | null
    organization_name?: string | null
    trace_count: number
    first_started_at: string
    latest_started_at: string
    total_duration_ms: number
    status_stats: {
      completed: number
      running: number
      error: number
    }
    total_tool_calls: number
    total_llm_calls: number
  }>
  pagination: {
    page: number
    page_size: number
    total: number
    total_pages: number
  }
}

/** overview / 导出里的附件摘要（不含完整 content_blocks） */
export interface ThreadMessageAttachment {
  kind: 'image' | 'file' | 'document' | 'table' | 'resource' | string
  filename: string
  source?: 'user' | 'agent' | string
  file_id?: string
  mime_type?: string
  size?: number
  url?: string
  preview_url?: string
  /** tabtin://resource/{type}/{id} 的 type */
  resource_type?: string
  /** 文档 / 表格 / 文件等资源 ID */
  resource_id?: string
}

export interface ThreadOverviewMessage {
  id: string
  role: string
  message_kind: string
  content: string
  /** 用户附件与 Agent 产物文件摘要；旧后端可能缺省 */
  attachments?: ThreadMessageAttachment[]
  /**
   * 落库 content_blocks（thinking / tool_use / tool_result / text…）。
   * overview 本身不带；由 chat-messages 导出合并后供「本轮运行诊断」展示。
   */
  content_blocks_json?: unknown[] | null
  trace_id: string | null
  agent_run_id: string | null
  model_name: string | null
  /** 运行时模型 ID 对应的运营可读名；旧后端可能缺省 */
  model_display_name?: string | null
  stop_reason: string | null
  usage: Record<string, number> | null
  error: Record<string, unknown> | null
  subagent_run_id: string | null
  created_at: string
}

/** AdminDash 对话导出：落库 chat_message（含 content_blocks_json） */
export interface ThreadChatMessageExportItem {
  id: string
  role: string
  message_kind: string
  content: string
  text_summary?: string
  content_blocks_json?: unknown[] | null
  attachments?: ThreadMessageAttachment[]
  trace_id: string | null
  agent_run_id: string | null
  model_name: string | null
  model_display_name?: string | null
  stop_reason: string | null
  usage: Record<string, number> | null
  error: Record<string, unknown> | null
  subagent_run_id: string | null
  created_at: string
}

/**
 * 导出附带的 system（与 chat_llm_snapshot.system 对齐）。
 * snapshot 路径通常有完整 sections；system_prompt_context 回退多为单段。
 */
export interface ThreadChatExportSystemSection {
  name: string
  source?: string
  charCount?: number
  contentPreview?: string
}

export interface ThreadChatExportSystem {
  sections: ThreadChatExportSystemSection[]
  charCount?: number
}

/**
 * system 来源：
 * - chat_llm_snapshot：该 session 最近一次快照（非按 turn）
 * - system_prompt_context：无快照时的落库回退（单段形态）
 * - missing：两者都没有
 */
export type ThreadChatExportSystemSource =
  | {
      kind: 'chat_llm_snapshot'
      run_id?: string | null
      iteration?: number | null
      model?: string | null
      model_display_name?: string | null
      created_at?: string | null
      updated_at?: string | null
      truncated_for_relay?: boolean
    }
  | {
      kind: 'system_prompt_context'
      message_id: string
      created_at?: string | null
    }
  | {
      kind: 'missing'
      reason: string
    }

/** 后端保存的一次模型调用快照；snapshot 与 Electron 导出的 LLM 快照结构对齐。 */
export interface ThreadChatExportLLMSnapshot {
  run_id: string
  iteration: number
  model: string | null
  model_display_name: string | null
  created_at: string | null
  updated_at: string | null
  snapshot: Record<string, unknown>
}

export interface ThreadChatMessagesExport {
  thread_id: string
  session_id: string
  source: 'chat_message'
  message_count: number
  messages_truncated: boolean
  messages: ThreadChatMessageExportItem[]
  /** 会话最近一次实际运行模型；加性字段，旧后端可能缺省 */
  model?: {
    id: string | null
    display_name: string | null
    source: 'assistant_message' | 'llm_snapshot' | 'session_current_model' | 'missing'
  }
  /** session 级系统提示词；语义见 system_source */
  system: ThreadChatExportSystem | null
  system_source: ThreadChatExportSystemSource
  /** 本次导出的模型调用快照数量；旧后端可能缺省。 */
  llm_snapshot_count?: number
  /** 会话快照超过接口上限时为 true。 */
  llm_snapshots_truncated?: boolean
  /** 按调用时间排列，snapshot 字段可直接与客户端快照对比。 */
  llm_snapshots?: ThreadChatExportLLMSnapshot[]
}

export interface ThreadOverviewSession {
  id: string
  title: string
  status: string
  is_paused: boolean
  user_id: string
  user_name: string | null
  organization_id: string
  organization_name: string | null
  workspace_id: string | null
  workspace_name: string | null
  project_id: string | null
  project_name: string | null
  agent_id: string | null
  agent_name: string | null
  agent_mode: string
  approval_mode: string
  model_name: string | null
  context_tier_id: string | null
  created_at: string
  last_message_at: string | null
  message_count: number
  input_tokens: number
  output_tokens: number
  total_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  compaction_count: number
  forked_from_id: string | null
  revert_at: string | null
}

export interface ThreadOverview {
  thread_id: string
  session: ThreadOverviewSession | null
  messages: ThreadOverviewMessage[]
  messages_truncated: boolean
  trace_summary: {
    total: number
    completed: number
    running: number
    error: number
    latest_error: string | null
  }
}

// ============ Event 相关类型 ============

export type EventType =
  | 'node'
  | 'route'
  | 'tool'
  | 'action_result'
  | 'context'
  | 'prompt_snapshot'
  | 'error'

export type EventPhase = 'start' | 'end'

export interface Event {
  id: string // Event UUID（全局唯一）
  trace_id: string
  parent_event_id: string | null // 父事件 UUID
  seq: number
  // 文档枚举见 EventType；后端可能扩展类型（如 llm），前端保持兼容
  event_type: EventType | string
  name: string
  started_at: string // API 字段名
  ended_at: string | null // API 字段名，phase='end' 时有值
  duration_ms: number | null // phase='end' 时有值
  input: DebugPayload | null
  output: DebugPayload | null
  error: string | null // API 字段
  usage: {
    // LLM usage 独立字段，phase='end' 时有值
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
    estimated_cost_usd?: number
  } | null
}

export interface ToolInjectionPayload {
  schema_tools_count?: number
  runtime_tools_count?: number
  runtime_tools_unique_count?: number
  runtime_tools_duplicate_count?: number
  registry_tools_count?: number
  runtime_domains?: string[]
  runtime_tool_names?: string[]
}

// LLM Event 特定字段
export interface LLMEvent extends Event {
  event_type: 'llm'
  input: {
    messages: Array<{
      role: 'system' | 'user' | 'assistant'
      content: string
    }>
    system_prompt?: string
    tools?: Array<{
      name?: string
      description?: string
      schema?: unknown
    }>
    tool_injection?: ToolInjectionPayload
    params?: {
      model: string
      temperature?: number
      max_tokens?: number
    }
  }
  output: {
    content: string
    usage?: {
      prompt_tokens: number
      completion_tokens: number
      total_tokens: number
    }
  }
  usage: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    estimated_cost_usd?: number
  }
}

// Tool Event 特定字段
export interface ToolEvent extends Event {
  event_type: 'tool'
  input: {
    args?: DebugPayload // API 使用 args
  }
  output: {
    result: unknown
    success?: boolean
  }
}

// Node Event 特定字段
export interface NodeEvent extends Event {
  event_type: 'node'
  input: {
    state: DebugPayload
  }
  output: {
    state: DebugPayload
  }
}

// Route Event 特定字段
export interface RouteEvent extends Event {
  event_type: 'route'
  input: {
    from_node: string
    condition: unknown
  }
  output: {
    to_node: string
    reason: string
  }
}

// Prompt Snapshot Event
export interface PromptSnapshotEvent extends Event {
  event_type: 'prompt_snapshot'
  input: {
    iteration: number
    messages_count: number
    total_chars: number
    role_breakdown: Record<string, number>
    tools_count: number
    tool_injection?: ToolInjectionPayload
  }
  output: {
    messages?: Array<{ role: string; content: string }>
    tools_schema?: unknown[]
  } | null
}

// Structured Error Event
export interface AgentErrorEvent extends Event {
  event_type: 'error'
  input: {
    category: string
    iteration?: number
    tool_name?: string
  }
  output: {
    stack_trace?: string
  } | null
}

export type AgentErrorCategory =
  | 'llm_call'
  | 'tool_exec'
  | 'tool_timeout'
  | 'middleware'
  | 'doom_loop'
  | 'context_overflow'
  | 'resume_failed'
  | 'cancelled'
  | 'max_iterations'
  | 'unknown'

export interface EventListResponse {
  items: Event[] // API 使用 items
  next_cursor: string | null
}

// ============ Event 树节点类型 ============

export interface EventNode extends Event {
  children: EventNode[]
  depth: number
  expanded?: boolean
}

// ============ SSE 事件类型 ============

export interface SSETraceEvent {
  phase: 'start' | 'end' | 'trace_end'
  event_id?: string
  parent_event_id?: string | null
  event_type?: EventType
  name?: string
  seq?: number
  duration_ms?: number
  status?: TraceStatus
  error?: string
  /**
   * LH2-A1（H3-C）：本 event 关联的子 Agent trace_id（仅 SUBAGENT_PROGRESS /
   * SUBAGENT_COMPLETED / SUBAGENT_FAILED 等父视角事件 payload 才会带）。
   * AdminDash 在父 trace events 时间线上提供"跳到子 trace"的快捷入口时使用。
   * 旧 trace（H3-C 之前）始终为 undefined；前端按 undefined 优雅降级。
   */
  child_trace_id?: string
  [key: string]: unknown
}

export interface SSEConnectedEvent {
  trace_id: string
  status: string
}

// ============ 性能统计类型 ============

export interface PerformanceStats {
  total_duration_ms: number
  total_tokens: number
  total_cost: number
  llm_call_count: number
  tool_call_count: number
  cache_hit_rate: number
  slowest_events: Array<{
    event_id: string
    name: string
    duration_ms: number
  }>
  token_distribution: Array<{
    event_id: string
    model: string
    tokens: number
    cost: number
  }>
}
