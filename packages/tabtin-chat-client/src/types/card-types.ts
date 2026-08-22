/* ─── Card Category & Risk ─────────────────────────────────────────── */

/** Top-level grouping for all interaction cards */
export type CardCategory = 'message' | 'tool' | 'reference' | 'interactive' | 'status'

/** Risk level controls grouping and approval behavior.
 *  Aligned with backend BaseTool.risk_level: safe / review / strict.
 *  Legacy values (low/medium/high) are accepted for backward compatibility.
 */
export type RiskLevel = 'safe' | 'review' | 'strict' | 'low' | 'medium' | 'high'

/* ─── Tool Output Data (Discriminated Union on `kind`) ─────────────── */

/** Terminal / shell command execution result */
export interface TerminalOutputData {
  kind: 'terminal'
  command: string
  stdout: string
  stderr: string
  exit_code: number | null
  cwd: string
  duration_ms?: number
  backgrounded?: boolean
  session_id?: string
  space_id?: string
}

/** File diff produced by a write / replace tool */
export interface DiffOutputData {
  kind: 'diff'
  file: string
  start_line: number
  end_line: number
  old_lines: string[]
  new_lines: string[]
  replacements: number
}

/** Structured SQL query result */
export interface SqlResultData {
  kind: 'sql_result'
  columns: string[]
  rows: unknown[][]
  total_rows?: number
}

/** File read operation result */
export interface FileReadData {
  kind: 'file_read'
  path: string
  offset?: number
  limit?: number
  /**
   * cat -n 风格的行号化内容（`${lineNum}\t${line}\n...`）。LLM 看的就是这个，
   * 前端展示时优先用 `contentRaw`，没有再 fallback 到本字段。
   */
  content?: string
  /** 不带行号前缀的纯内容。前端 CodeBlock 渲染应优先用此字段。 */
  contentRaw?: string
  /** 实际起始行号（1-indexed），来自 read_file 工具的 `start_line`。 */
  start_line?: number
  /** 整文件总行数（流式读取大文件时可能为 undefined）。 */
  total_lines?: number
  /** 实际返回的切片行数。 */
  num_lines?: number
}

/** Non-text files successfully materialized for the agent to inspect. */
export interface MaterializedFilesData {
  kind: 'materialized_files'
  file_count: number
}

/** Code search (grep / glob / semantic) result */
export interface CodeSearchData {
  kind: 'code_search'
  pattern?: string
  glob_pattern?: string
  query?: string
  matches?: Array<{ file: string; line: number; text: string }>
  match_count?: number
}

/** Web search result */
export interface WebSearchData {
  kind: 'web_search'
  query: string
  results?: Array<{ title: string; url: string; snippet: string }>
}

/** Single-page fetched content used by historical transcript display cards. */
export interface WebFetchData {
  kind: 'web_page_fetch'
  url: string
  title?: string
  content_preview?: string
}

/** File write operation result */
export interface FileWriteData {
  kind: 'file_write'
  path: string
  size?: number
  /** Whether this was a create (new file) or overwrite */
  created?: boolean
}

/** Record operation (create/update/delete) result */
export interface RecordOpData {
  kind: 'record_op'
  operation: 'create' | 'update' | 'delete'
  record_id?: string
  table_id?: string
  fields_count?: number
  message?: string
}

/** A3 update-by-filter preflight + commit result */
export interface UpdateByFilterPreviewData {
  kind: 'update_by_filter_preview'
  phase: 'preflight' | 'committed' | 'error'
  matched_total: number
  sample_records?: Array<Record<string, unknown>>
  confirm_token?: string
  estimated_duration_ms?: number
  requires_checkpoint?: boolean
  updated_count?: number
  operation_group_id?: string
  drift_warning?: boolean
  drift_ratio?: number
  drift_message_i18n_key?: string
  errors?: Array<{ record_id: string; reason: string }>
  failed_record_ids?: string[]
  duration_ms?: number
}

/** Fallback for tools without a dedicated output shape */
export interface GenericToolData {
  kind: 'generic'
  input?: unknown
  output?: unknown
}

/** Union of all structured tool output shapes */
export type ToolOutputData =
  | TerminalOutputData
  | DiffOutputData
  | SqlResultData
  | FileReadData
  | MaterializedFilesData
  | CodeSearchData
  | WebSearchData
  | WebFetchData
  | FileWriteData
  | RecordOpData
  | UpdateByFilterPreviewData
  | GenericToolData

/* ─── Interactive Card Data ────────────────────────────────────────── */

/** Status of a single to-do item */
export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled'

/** A single to-do entry inside a TodoCard */
export interface TodoItemData {
  id: string
  content: string
  status: TodoStatus
}

/** Card that renders an editable to-do list */
export interface TodoCardData {
  kind: 'todo'
  todos: TodoItemData[]
}

/** User decision on a review request */
export type ReviewDecision = 'approve' | 'reject'

/** How long the decision persists */
export type ReviewScope = 'once' | 'thread' | 'always'

/** A single action the agent is requesting approval for */
export interface ReviewActionData {
  tool_call_id?: string
  tool_name: string
  description?: string
  arguments?: Record<string, unknown>
}

/** Card that asks the user to approve / reject pending tool calls */
export interface ReviewCardData {
  kind: 'review'
  action_requests: ReviewActionData[]
  message?: string
}

/**
 * A selectable option inside an AskUser card.
 * W4 (2026-05-11): `description` 必填、`preview` 可选。
 */
export interface AskUserOption {
  id: string
  label: string
  description: string
  /** 可选预览内容（mockup / code snippet / diagram 等），UI 在选项卡片下渲染。 */
  preview?: string
}

/**
 * A single question item inside an AskUser card.
 * W4 (2026-05-11): 增加 `header` 字段（短标签 chip）。
 */
export interface AskUserQuestionItem {
  id: string
  prompt: string
  /** 极短标签（≤12 字符），UI 在问题旁显示。可选。 */
  header?: string
  options: AskUserOption[]
  /** 定制「其他」入口文案（与普通 option 同结构）；未传时前端走内置 i18n。 */
  other_option?: AskUserOption
  allow_multiple?: boolean
  allow_free_text?: boolean
}

/**
 * Structured form field definition (W4 R3 / ask_form 工具用)。
 * 用于 ask_form 工具让 LLM 收集多个具体字段值（vs ask_user choice 只能选选项）。
 */
export interface AskUserFieldDef {
  key: string
  label: string
  type?: string
  required?: boolean
  default?: unknown
  placeholder?: string
  options?: AskUserOption[]
  description?: string
  validation?: Record<string, unknown>
  group?: string
}

/**
 * Addon parameter definition (W4 R3 / ask_form 配套)。
 */
export interface AskUserAddonDef {
  key: string
  label: string
  type?: string
  default?: unknown
  options?: AskUserOption[]
  fields?: AskUserFieldDef[]
}

/**
 * Card that presents an ask interaction.
 *
 * W4 R3 (2026-05-11): ask 三件套并存——`ask_user`（multi-choice）/ `ask_form`
 * （多字段填表）/ `request_approval`（高风险方案审批）。卡片渲染按
 * `kind` discriminate（chat-client 层面仅 ask_user 有 card；form/approval
 * 走独立 panel 不进 card 渲染管线）。
 *
 * choice 形态字段：questions[] + title
 * （form / approval 通过独立的 wire payload 处理，不在 chat 卡片里渲染。）
 */
export interface AskUserCardData {
  kind: 'ask_user'
  questions: AskUserQuestionItem[]
  title?: string
}

/** Simple confirmation dialog card */
export interface ConfirmCardData {
  kind: 'confirm'
  title: string
  description?: string
  confirm_label?: string
  cancel_label?: string
}

/** Union of all interactive card data shapes */
export type InteractiveCardData =
  | TodoCardData
  | ReviewCardData
  | AskUserCardData
  | ConfirmCardData

/* ─── Status Card Data ─────────────────────────────────────────────── */

/** Extended thinking / reflection block */
export interface ThinkingCardData {
  kind: 'thinking'
  reflection: string
  duration_ms?: number
}

/** Lifecycle status of a sub-agent run */
export type SubagentStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'

/** A single tool step executed inside a sub-agent run */
export interface SubagentToolStep {
  tool_name: string
  tool_call_id?: string
  success: boolean
  elapsed_ms: number
  input_summary?: string
  output_summary?: string
  input_detail?: string
  output_detail?: string
  error?: string | null
}

/** Card that tracks a sub-agent's progress and results */
export interface SubagentCardData {
  kind: 'subagent'
  subagent_run_id: string
  label: string
  task?: string
  status: SubagentStatus
  started_at?: number
  ended_at?: number
  step_count?: number
  latest_tool?: string
  tool_history?: SubagentToolStep[]
  summary?: string
  error?: string
  stats?: {
    duration_ms?: number
    input_tokens?: number
    output_tokens?: number
    total_tokens?: number
    /** PRD-04 Wave 5 任务 4：子 Agent 累计消耗积分（来自 BudgetTracker scope credits） */
    credits_consumed?: number
  }
}

/** Union of all status card data shapes */
export type StatusCardData =
  | ThinkingCardData
  | SubagentCardData

/* ─── Card Descriptor (Registry Interface) ─────────────────────────── */

/**
 * Platform-agnostic card descriptor.
 * Each tool / card type registers one of these.
 * Platform-specific renderers are injected at runtime.
 */
export interface CardDescriptor<TInput = unknown, TOutput = unknown> {
  /** Unique card type identifier */
  id: string
  /** Category for grouping and display logic */
  category: CardCategory
  /** i18n key for display label (format: chat.card.{id}) */
  labelKey: string
  /** Icon identifier (lucide icon name) */
  icon: string
  /** Risk level determines grouping behavior */
  riskLevel: RiskLevel
  /** Whether card starts collapsed */
  defaultCollapsed: boolean
  /** Extract compact summary text from tool input */
  compactSummary?: (input: TInput) => string | null
  /** Extract structured output data from raw tool output */
  extractOutput?: (output: TOutput) => ToolOutputData | null
}

/**
 * Tool card descriptor specifically for tool execution cards.
 * Maps a backend tool_name to its display configuration.
 */
export interface ToolCardDescriptor extends CardDescriptor {
  category: 'tool'
  /** The renderer component name to use (maps to a registered renderer) */
  renderer: string
}

/* ─── Utility Types ────────────────────────────────────────────────── */

/** Union of every card data shape */
export type CardData =
  | ToolOutputData
  | InteractiveCardData
  | StatusCardData

/** Type guard: narrows ToolOutputData to TerminalOutputData */
export function isTerminalOutput(data: ToolOutputData): data is TerminalOutputData {
  return data.kind === 'terminal'
}

/** Type guard: narrows ToolOutputData to DiffOutputData */
export function isDiffOutput(data: ToolOutputData): data is DiffOutputData {
  return data.kind === 'diff'
}

/** Type guard: narrows ToolOutputData to SqlResultData */
export function isSqlResult(data: ToolOutputData): data is SqlResultData {
  return data.kind === 'sql_result'
}

/** Type guard: narrows ToolOutputData to FileReadData */
export function isFileRead(data: ToolOutputData): data is FileReadData {
  return data.kind === 'file_read'
}

/** Type guard: narrows ToolOutputData to CodeSearchData */
export function isCodeSearch(data: ToolOutputData): data is CodeSearchData {
  return data.kind === 'code_search'
}

/** Type guard: narrows ToolOutputData to WebSearchData */
export function isWebSearch(data: ToolOutputData): data is WebSearchData {
  return data.kind === 'web_search'
}

/** Type guard: narrows ToolOutputData to WebFetchData */
export function isWebFetch(data: ToolOutputData): data is WebFetchData {
  return data.kind === 'web_page_fetch'
}

/** Type guard: narrows ToolOutputData to FileWriteData */
export function isFileWrite(data: ToolOutputData): data is FileWriteData {
  return data.kind === 'file_write'
}

/** Type guard: narrows ToolOutputData to RecordOpData */
export function isRecordOp(data: ToolOutputData): data is RecordOpData {
  return data.kind === 'record_op'
}

/** Type guard: narrows ToolOutputData to UpdateByFilterPreviewData */
export function isUpdateByFilterPreview(data: ToolOutputData): data is UpdateByFilterPreviewData {
  return data.kind === 'update_by_filter_preview'
}

/* ─── Re-exports ───────────────────────────────────────────────────── */

export type { MessageBlockType, MessageBlock, MessageAttachment } from './message'
