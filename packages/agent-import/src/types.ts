/**
 * @tabtin/agent-import 核心契约。
 *
 * 统一中间表示（UnifiedSession / UnifiedMessage）以 Anthropic ContentBlock 为
 * 消息体形态——与 Django `ChatMessage.content_blocks_json` 同族，上传层零翻译。
 * 各家 adapter 负责把私有格式翻到这里；翻译公共规则见 normalize.ts。
 *
 * 设计约束（PRD docs/prd/external-agent-import-onboarding-v1.md §3.3 / §5.2）：
 * - client_event_id 优先源生稳定 id，无源生 id 的老格式用内容 hash 派生（勿用行序）
 * - 未配对 tool_use 必须合成占位 tool_result（续聊重放的协议合法性）
 * - 非 Anthropic 来源的 thinking signature 一律剥离
 * - 内嵌 base64 图片抽出为附件文件，消息内以 image_ref 引用
 */

export type ImportSource = 'claude_code' | 'codex' | 'cursor' | 'workbuddy'

export const IMPORT_SOURCES: readonly ImportSource[] = [
  'claude_code',
  'codex',
  'cursor',
  'workbuddy',
]

// ── ContentBlock（Anthropic 形态子集 + image_ref 扩展）────────────────────

export interface TextBlock {
  type: 'text'
  text: string
}

export interface ThinkingBlock {
  type: 'thinking'
  thinking: string
  /** 仅 Anthropic 签发的 signature 保留（Claude Code 源）；其余来源剥离 */
  signature?: string
}

export interface ToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: unknown
}

export interface ToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content: string | Array<{ type: 'text'; text: string }>
  is_error?: boolean
  /** true = 源工具未保存结果，导入时合成的占位（PRD §3.3 统一规则） */
  synthesized?: boolean
}

/**
 * 图片引用块：base64 已抽出为本地文件，上传层负责转 TabTin 附件并改写为
 * 标准 image block。path 指向 extraction 输出目录内的文件。
 */
export interface ImageRefBlock {
  type: 'image_ref'
  path: string
  mimeType: string
  /** 源内嵌 base64 的字节数（观测/对账用） */
  byteSize?: number
}

export type UnifiedBlock =
  | TextBlock
  | ThinkingBlock
  | ToolUseBlock
  | ToolResultBlock
  | ImageRefBlock

// ── 统一消息 / 会话 ───────────────────────────────────────────────────────

export interface UnifiedUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

export interface UnifiedMessage {
  /**
   * 稳定幂等 id → Django `client_event_id`。
   * 源生优先：Claude uuid / Cursor bubbleId / Codex response_item.id /
   * WorkBuddy 记录 id；否则 contentHashId() 派生。
   */
  id: string
  role: 'user' | 'assistant'
  blocks: UnifiedBlock[]
  /** ISO8601；无逐条时间戳的层（Cursor jsonl）为内插值并置 timeEstimated */
  createdAt: string
  timeEstimated?: boolean
  model?: string
  usage?: UnifiedUsage
  stopReason?: string
}

export interface UnifiedSubagent {
  /** 源侧子 Agent 标识（agentId / task-composerId / agent-8hex …） */
  sourceId: string
  description?: string
  messages: UnifiedMessage[]
}

/** Cursor 三级正文可得性；其余源恒为 'full'（PRD §2.5） */
export type ContentLayer = 'full' | 'bubble' | 'jsonl' | 'header_only'

export interface UnifiedSession {
  source: ImportSource
  /** 源侧会话唯一 id → metadata.import.source_session_id */
  sourceSessionId: string
  /** 源数据文件/记录位置（取证与重跑定位） */
  sourcePath: string
  title: string
  titleSource: 'native' | 'custom' | 'derived'
  cwd: string | null
  createdAt: string
  updatedAt: string
  archived: boolean
  layer: ContentLayer
  /** jsonl-only 且存在未回填 REDACTED 时为 true（PRD §3.3 Cursor） */
  lossy: boolean
  messages: UnifiedMessage[]
  subagents: UnifiedSubagent[]
  totalTokens?: number
  model?: string
  gitBranch?: string
  /** 解析中遇到的未知记录类型计数（对账：不静默丢） */
  unknownRecords: Record<string, number>
}

// ── detect / scan ────────────────────────────────────────────────────────

export interface DetectResult {
  source: ImportSource
  /** 三级判定：目录存在 → 索引可读 → 计数>0 才 installed=true（PRD §5.3） */
  installed: boolean
  sessionCount: number
  workspaceCount: number
  newestActivityAt: string | null
  oldestActivityAt: string | null
  /** 索引存在但打不开等诊断信息 */
  note?: string
}

export interface SessionRef {
  source: ImportSource
  sourceSessionId: string
  sourcePath: string
  title: string
  /** 标题来源，scan 阶段已知则带上，parseSession 不再猜（custom vs native 区分） */
  titleSource?: UnifiedSession['titleSource']
  cwd: string | null
  createdAt: string
  updatedAt: string
  archived: boolean
  subagent: boolean
  layer: ContentLayer
}

export interface ScanWorkspace {
  cwd: string
  cwdExists: boolean
  sessions: SessionRef[]
}

export interface ScanResult {
  source: ImportSource
  workspaces: ScanWorkspace[]
  /** cwd 为空/异常的会话（归默认 Workspace） */
  orphanSessions: SessionRef[]
}

export interface ScanOptions {
  /** 只要 updatedAt 晚于该时刻的会话；undefined = 全量（PRD §4.2 默认近 30 天由上层传入） */
  since?: Date
  /** 是否包含源侧已归档会话（默认 true，落 TabTin archived 态） */
  includeArchived?: boolean
}

export interface ParseOptions {
  /** base64 抽出目录；未提供则 image 块降级为省略占位文本 */
  attachmentDir?: string
  /** secret 打码（默认 true） */
  redact?: boolean
}

// ── adapter 接口 ─────────────────────────────────────────────────────────

import type { ImportIO } from './io.js'

export interface SourceAdapter {
  readonly source: ImportSource
  detect(io: ImportIO): Promise<DetectResult>
  scan(io: ImportIO, opts?: ScanOptions): Promise<ScanResult>
  parseSession(io: ImportIO, ref: SessionRef, opts?: ParseOptions): Promise<UnifiedSession>
}
