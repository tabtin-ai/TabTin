/** @store-category session */

/**
 * Chat Runtime Store — 运行时执行状态
 *
 * 从 useChatStore 拆出的独立 store，管理 Agent 执行过程中的瞬态数据：
 * - Agent 步骤、工具事件、助手事件、子 Agent 运行
 * - RunState 生命周期
 * - TODO 列表
 * - 外部 Agent 信息、权限请求、Plan、AgentMode
 *
 * 这些数据的共同特点：
 * 1. 全部按 sessionId 隔离（*BySessionId map）
 * 2. 仅在流式执行期间写入，不持久化
 * 3. 主要由 streamMessageHandler 写入、组件层只读
 */

import { create } from 'zustand'
import type {
  AgentModeName,
  ApprovalModeName,
  AgentStep,
  ToolEvent,
  AssistantEvent,
  SubagentRun,
  RunState,
  LLMCallSnapshot,
  ChatReplyTarget,
} from './chat/shared/types'
import { ensureClosedFences } from './chat/execution/markdownStreamUtils'
import {
  clearToolCallArgsBufferByToolCallId,
  replayPendingInputJsonFragments,
} from './chat/stream/handlers/toolCallArgsBufferStore'
import type {
  ContentBlock,
  ContentBlockDeltaPayload,
  MessageStopReason,
  MessageUsage,
} from '@tabtin/agent-wire'
import type { GroupRuntimeConfig } from '@tabtin/chat-client'
import { INITIAL_RUN_STATE } from './chat/shared/types'
import { getContentBlocksBridge } from './chat/messages/contentBlocksMirrorRegistry'
import { deriveSubagentRunsFromMessages } from './chat/subagent/utils/subagentRunsFromMessages'
import { runtimeStoreAccess } from '../services/agentService/runtimeStoreAccess'
import { ensureLegacyOk } from '../services/legacy-result'
import { logger } from '@/utils/logger'
import type { MessageMeta, StreamHandlerStore, StreamHandlerDeps } from './chat/stream/handlers/streamHandlerTypes'

export type { MessageMeta } from './chat/stream/handlers/streamHandlerTypes'

// ---------------------------------------------------------------------------
// Prefill 相关类型 — 消息重发时保留完整上下文
// ---------------------------------------------------------------------------

export interface SerializableAttachment {
  id: string
  filename: string
  mimeType: string
  size: number
  type: 'image' | 'file' | 'video'
  fileId?: string
  remoteUrl?: string
  previewUrl?: string
}

export interface PrefillData {
  message: string
  attachments?: SerializableAttachment[]
  contextBlocks?: Array<Record<string, unknown>>
}

/**
 * 本窗口发起且正在执行的用户输入快照。
 *
 * 输入框在派发后立即清空，停止生成时不能从展示气泡反推原始参数（skill 展示文案、
 * 附件和上下文块都可能已被转换）。因此发送入口登记快照，持久化 ACK 仅更新其
 * 服务端身份，聊天输入区按需消费同一份原始输入。
 */
export interface SubmittedMessageSnapshot extends PrefillData {
  clientMessageId: string
  localMessageId: string
  replyTo?: ChatReplyTarget
}

function normalizePrefill(raw: string | PrefillData): PrefillData {
  if (typeof raw === 'string') return { message: raw }
  return raw
}

function isTerminalSubagentStatus(status: SubagentRun['status'] | undefined): boolean {
  return status === 'cancelled' || status === 'completed' || status === 'failed'
}

function isActiveSubagentStatus(status: SubagentRun['status'] | undefined): boolean {
  return status === 'running' || status === 'pending' || status === 'queued'
}

function canArchiveCompleteActiveRun(source: SubagentRun['archiveStatusSource']): boolean {
  return source !== 'legacy_background' && source !== 'presentation_dispatch'
}

function applyArchiveSubagentSnapshot(
  sessionId: string,
  snapshot: SubagentRun,
  get: () => { subagentRunsBySessionId: Record<string, SubagentRun[]> },
  upsert: (sessionId: string, run: SubagentRun) => void,
): void {
  const existingRuns = get().subagentRunsBySessionId[sessionId] ?? []
  const prevIndex = findSubagentRunIndex(existingRuns, snapshot)
  const prev = prevIndex >= 0 ? existingRuns[prevIndex] : undefined
  if (!prev) {
    upsert(sessionId, snapshot)
    return
  }
  const filled: SubagentRun = { ...prev }
  const archiveTerminal = isTerminalSubagentStatus(snapshot.status)
  const prevActive = isActiveSubagentStatus(prev.status)
  if (archiveTerminal && prevActive && canArchiveCompleteActiveRun(snapshot.archiveStatusSource)) {
    filled.status = snapshot.status
  }
  if (filled.task === undefined && snapshot.task !== undefined) filled.task = snapshot.task
  if (filled.label === undefined && snapshot.label !== undefined) filled.label = snapshot.label
  if (filled.role === undefined && snapshot.role !== undefined) filled.role = snapshot.role
  if (filled.model === undefined && snapshot.model !== undefined) filled.model = snapshot.model
  if (filled.parentToolCallId === undefined && snapshot.parentToolCallId !== undefined) {
    filled.parentToolCallId = snapshot.parentToolCallId
  }
  if (filled.startedAt === undefined && snapshot.startedAt !== undefined) filled.startedAt = snapshot.startedAt
  if (filled.endedAt === undefined && snapshot.endedAt !== undefined) filled.endedAt = snapshot.endedAt
  if (!filled.error && snapshot.error) filled.error = snapshot.error
  if (!filled.stats?.duration_ms && snapshot.stats?.duration_ms) {
    filled.stats = { ...(filled.stats ?? {}), duration_ms: snapshot.stats.duration_ms }
  }
  upsert(sessionId, filled)
}

async function loadIndexedSubagentSnapshots(
  sessionId: string,
  options?: { organizationId?: string; spaceId?: string },
): Promise<SubagentRun[]> {
  const listRuns = window.tabtin?.agentEngine?.listSubagentRuns
  if (typeof listRuns !== 'function') return []
  try {
    const result = await listRuns({
      parentSessionId: sessionId,
      organizationId: options?.organizationId,
      spaceId: options?.spaceId,
    })
    if (!result.ok) return []
    return result.runs.map((run) => ({
      subagentRunId: run.subagentRunId,
      parentToolCallId: run.parentToolCallId,
      task: run.task,
      label: run.label,
      role: run.role,
      model: run.model,
      status: run.status,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      error: run.error,
      stats: run.stats,
      archiveStatusSource: 'index_jsonl',
    }))
  } catch (err) {
    logger.warn('[ChatRuntime] listSubagentRuns failed', err)
    return []
  }
}

function normalizeSubagentOwner(owner: string | undefined): string {
  return owner ?? ''
}

function findSubagentRunIndex(prev: readonly SubagentRun[], run: SubagentRun): number {
  if (run.parentToolCallId) {
    const runOwner = normalizeSubagentOwner(run.dispatchedByRunId)
    const exact = prev.findIndex(item =>
      item.subagentRunId === run.subagentRunId
      && item.parentToolCallId === run.parentToolCallId
      && normalizeSubagentOwner(item.dispatchedByRunId) === runOwner,
    )
    if (exact >= 0) return exact

    const parentless = prev.findIndex(item =>
      item.subagentRunId === run.subagentRunId
      && !item.parentToolCallId
      && normalizeSubagentOwner(item.dispatchedByRunId) === runOwner
      && (!isTerminalSubagentStatus(item.status) || item.status === run.status)
    )
    if (parentless >= 0) return parentless

    return -1
  }

  for (let i = prev.length - 1; i >= 0; i -= 1) {
    if (prev[i].subagentRunId === run.subagentRunId) return i
  }
  return -1
}

const MAX_FULL_TOOL_EVENTS = 40

function _safeStringifyTruncate(value: unknown, maxLen: number): string {
  if (typeof value === 'string') return value.length > maxLen ? value.slice(0, maxLen) + '…' : value
  try {
    const raw = JSON.stringify(value)
    return raw.length > maxLen ? raw.slice(0, maxLen) + '…' : raw
  } catch {
    return '[unserializable]'
  }
}

function _trimToolEventsForSession(events: ToolEvent[]): ToolEvent[] {
  if (events.length <= MAX_FULL_TOOL_EVENTS) return events
  return events.map((ev, i) => {
    if (i >= events.length - MAX_FULL_TOOL_EVENTS) return ev
    const trimmed = { ...ev }
    if (trimmed.output != null) {
      if (!trimmed.outputSummary) {
        trimmed.outputSummary = _safeStringifyTruncate(trimmed.output, 200)
      }
      trimmed.output = undefined
    }
    if (trimmed.input != null) {
      if (!trimmed.inputSummary) {
        trimmed.inputSummary = _safeStringifyTruncate(trimmed.input, 120)
      }
      trimmed.input = undefined
    }
    return trimmed
  })
}

// ---------------------------------------------------------------------------
// Runtime keys — used for eviction
// ---------------------------------------------------------------------------

const RUNTIME_SESSION_KEYS = [
  'agentStepsBySessionId',
  'toolEventsBySessionId',
  'assistantEventsBySessionId',
  'subagentRunsBySessionId',
  'composerStopBackgroundHintBySessionId',
  'runStateBySessionId',
  'richContentBlocksBySessionId',
  'agentModeBySessionId',
  //  三档审批策略：当前会话审批档覆盖。
  'approvalModeBySessionId',
  'groupRuntimeBySessionId',
  'cancellingBySessionId',
  'uploadProgressBySessionId',
  'uploadAbortControllerBySessionId',
  'pendingPrefillBySessionId',
  'activeSubmittedMessageBySessionId',
  'pendingInterruptedMessageBySessionId',
  // Phase 3 · Debug Observability：LLM call snapshots
  'snapshotsBySessionId',
  // Wave 3：模型能力降级 banner（capability_downgrade / capability_warning）
  'capabilityBannersBySessionId',
  // Wave 4a：LLM message 元信息（per-message）。#3005 阶段 6：内容块已迁出 runtime
  // store（落 messages 层 messageBlocks._committedBlocks），evict 经 bridge.clearSession
  // 单独清；此处不再含 contentBlocksBySessionId。
  'messageMetaBySessionId',
  'contentBlocksLastSeqBySessionId',
  // ：会话执行态单一投影（busy / 排队），写入方见 sessionRunProjection.ts。
  'runProjectionBySessionId',
] as const

/**
 * Wave 3：模型能力降级 banner（per-session 持续展示）。
 *
 * 来源：`agent.stream.capability_event` 事件，由 wire_adapter 在请求适配阶段
 * 发现"该模型支持图片但不支持 4K 分辨率 / 不支持动 GIF / system message 被
 * 截断"等**软不匹配**时发出。banner 不打断对话流，但跨多 turn 持续显示直到
 * 用户主动 dismiss 或切换模型 / 新建会话时自动清空。
 *
 * **去重规则**：同 session 内 (kind, feature, fallback_to) 三元组等同的事件
 * 只保留 1 条——避免每轮都重复 banner，但允许同一 session 内出现 image 降级 +
 * tool 删减两条不同 feature 的 banner。
 *
 * 字段语义：
 * - `id`：自增 / 时间戳，前端 key 用，仅 in-memory 不持久化；
 * - `kind: 'downgrade'`：本次请求已实际降级处理（图片转码 / tool 删减等）；
 * - `kind: 'warning'`：仅提示但本轮未改写请求体（用于"下一轮该考虑换模型"）；
 * - `message`：后端预渲染的中文展示文案；缺省时前端按 feature + fallback_to
 *   兜底拼字符串，避免空 banner；
 * - `model`：触发降级的模型 ID，便于"看看哪个模型经常降级"；
 * - `extras`：透传给"查看详情"折叠面板（telemetry / debug 字段）。
 */
export interface CapabilityBanner {
  id: string
  kind: 'downgrade' | 'warning'
  feature?: string
  fallback_to?: string
  message?: string
  model?: string
  extras?: Record<string, unknown>
  /** 该事件第一次到达本 session 的时间戳，仅用于排序与排查。 */
  receivedAt: number
}

// ---------------------------------------------------------------------------
// Wave 4a · Anthropic ContentBlock 时间轴（client-side accumulator）
// ---------------------------------------------------------------------------
//
// 整体设计（v2 §3.5.1.b 6 类边角 case）：
//
// 1. **存储**：`contentBlocksBySessionId[sessionId][messageId]` 是有序的 `ContentBlockEntry[]`，
//    按 `index` 升序——index 是 daemon 在 message 内的 0/1/2/...，UI 用 index 排序，用 block_id 当 React key。
// 2. **元数据**：`messageMetaBySessionId[sessionId][messageId]` 记 role / model / stop_reason / usage / finalized。
//    `stop_reason` 来自 `message_delta`（**不是** `message_stop`，Anthropic schema 把 stop_reason 放前者）。
// 3. **去重**：`contentBlocksLastSeqBySessionId[sessionId][messageId]` 记当前 message 已处理的 max(_seq)。
//    每条事件 entry 前 `if seq <= prevSeq return` 直接 drop（IPC vs WS 双源 / 乱序兜底）。
// 4. **immutable**：三层 `{...}` shallow clone（sessionMap → messageMap → blocksArr），Zustand
//    selector 才能正确订阅到引用变化触发重渲染——W2 silent bypass 二代教训。
// 5. **rAF 不上**：W4a 先做正确性，UI 高频流畅性留 W4b 在 streamingContent.ts 路径处理。
//
// 6 类边角 case 落地点：
// - case 1（partial_json parse 失败）：`applyFinalizeFallback` 在 content_block_stop 兜底，
//   失败时 `block.input = {} + input_parse_error`。
// - case 2（delta 早于 start）：`contentBlockDelta` 检测 entryIdx<0 时调用 `createPlaceholderForDelta`
//   lazy 建空壳，后续真 start 会覆盖（warn）。
// - case 3（message_stop 时仍有 unfinalized block）：`messageStop` 内强制 finalize + partial=true。
// - case 4（abort 路径）：`sendMessageAction` 接 `message_stop(stop_reason='aborted')` 直接复用 messageStop。
// - case 5（多 message 并发）：messageId 已是隔离 key；不同 message 写入互不影响。
// - case 6（IPC vs WS 双源去重）：`contentBlocksLastSeqBySessionId` 按 _seq 严格单调递增 drop。

/**
 * 把一条 ContentBlockDelta 应用到 entry 上（字段级累积）。
 *
 * 6 种 delta（v2 §2.3.1）：
 * - text_delta → block.text += delta.text
 * - thinking_delta → block.thinking += delta.thinking
 * - signature_delta → block.signature += delta.signature
 * - input_json_delta → entry.pendingInputJson += delta.partial_json（finalize 时 parse）
 * - citations_delta → block.citations.push(delta.citation)
 * - connector_text_delta → 视为 text_delta 同样处理（connector_text feature 路径）
 *
 * **保持 entry immutable**：返回 new entry，不 mutate 入参（Zustand 触发重渲染契约）。
 */
function applyDeltaToEntry(entry: ContentBlockEntry, delta: ContentBlockDeltaPayload): ContentBlockEntry {
  switch (delta.type) {
    case 'text_delta':
    case 'connector_text_delta': {
      const block = entry.block
      // text / connector_text_delta 都只对 text 块有意义；其他块类型上漏来的 delta 静默忽略
      if (block.type !== 'text') return entry
      const incomingText = delta.type === 'text_delta' ? delta.text : delta.connector_text
      // W4a 三轮 W4a-L17 修复：raw 累积 + close-fenced 显示
      // `_rawText` 保留 LLM 原始 concat 文本（无 fence 闭合）；下次 delta
      // 来时基于它累积。block.text 是用 ensureClosedFences 包过的显示版本
      // —— W4b 渲染可直接当 markdown，流式中途代码块不断 fence。
      const nextRaw = (entry._rawText ?? block.text ?? '') + incomingText
      const displayText = ensureClosedFences(nextRaw)
      return {
        ...entry,
        _rawText: nextRaw,
        block: { ...block, text: displayText },
      }
    }
    case 'thinking_delta': {
      const block = entry.block
      if (block.type !== 'thinking') return entry
      return {
        ...entry,
        block: { ...block, thinking: (block.thinking ?? '') + delta.thinking },
      }
    }
    case 'signature_delta': {
      const block = entry.block
      if (block.type !== 'thinking') return entry
      return {
        ...entry,
        block: { ...block, signature: (block.signature ?? '') + delta.signature },
      }
    }
    case 'input_json_delta': {
      // tool_use / server_tool_use / mcp_tool_use 共享 input_json_delta 形态
      const accumulated = (entry.pendingInputJson ?? '') + delta.partial_json
      return { ...entry, pendingInputJson: accumulated }
    }
    case 'citations_delta': {
      const block = entry.block
      if (block.type !== 'text') return entry
      const prev = block.citations ?? []
      return {
        ...entry,
        block: { ...block, citations: [...prev, delta.citation] },
      }
    }
    default: {
      // forward-compat：未知 delta type 静默忽略（zod 已挡掉非法值；这里防御）
      return entry
    }
  }
}

/**
 * Finalize 兜底：tool_use 块的 pendingInputJson 在 content_block_stop 时尝试 parse 写到 block.input。
 *
 * 边角 case 1（v2 §3.5.1.b）：JSON.parse 失败时：
 * - block.input 保持空对象 `{}`（Anthropic API 要求 input 必须是 object）
 * - block.input_parse_error = { message, partial: partial_json.slice(0, 200) }
 * - UI 走 ToolUseErrorView 分支显示"工具调用参数损坏"
 *
 * **保持 entry immutable**。
 */
function applyFinalizeFallback(entry: ContentBlockEntry): ContentBlockEntry {
  // W4a 三轮 W4a-L17：text 块 finalize 时把 _rawText 写回 block.text
  // （LLM 原始未闭合 fence 版；finalize 后 LLM 通常已自带完整 fence——
  // 即使没有，ensureClosedFences 是幂等的，再走一次保险 + 清 _rawText）。
  if (entry.block.type === 'text' && entry._rawText !== undefined) {
    const block = entry.block
    return {
      ...entry,
      block: { ...block, text: ensureClosedFences(entry._rawText) },
      _rawText: undefined,
    }
  }
  const pending = entry.pendingInputJson
  if (pending === undefined || pending === '') return entry
  const block = entry.block
  // 只有 tool_use / server_tool_use / mcp_tool_use 才需要 parse input_json
  if (block.type !== 'tool_use' && block.type !== 'server_tool_use' && block.type !== 'mcp_tool_use') {
    // 非 tool_use 块上的 pendingInputJson 是协议噪声；清掉
    return { ...entry, pendingInputJson: undefined }
  }
  try {
    const parsed = JSON.parse(pending)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return {
        ...entry,
        block: { ...block, input: parsed as Record<string, unknown> },
        pendingInputJson: undefined,
      }
    }
    // parse 出来不是 object（譬如 "true" / "[1,2]"）→ 视为格式错误
    return {
      ...entry,
      block: {
        ...block,
        input: {},
        input_parse_error: {
          message: 'parsed value is not a JSON object',
          partial: pending.slice(0, 200),
        },
      } as ContentBlock,
      pendingInputJson: undefined,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'JSON.parse failed'
    return {
      ...entry,
      block: {
        ...block,
        input: {},
        input_parse_error: {
          message,
          partial: pending.slice(0, 200),
        },
      } as ContentBlock,
      pendingInputJson: undefined,
    }
  }
}

/**
 * 边角 case 2 兜底：content_block_delta 早于 content_block_start 时，根据 delta.type
 * 猜测一个最合理的空壳 block。
 *
/**
 * `__pending__` sentinel —— W4a 三轮 A-P0-2：tool_use placeholder 的临时 block.id。
 *
 * 用途：content_block_delta(input_json_delta) 早于 content_block_start 时 lazy
 * 创建的占位 tool_use 块，**绝不**用 `recovered-${messageId}-${index}` 当 block.id
 * （那个值会被 contentBlockHandler 当成真 toolCallId 喂给 feedInputJsonDelta，
 * 导致早期 token 写到孤儿 buffer）。改用全局 sentinel 让 handler 显式识别 +
 * 走 fragments 暂存路径。
 */
export const TOOL_USE_PENDING_TOOL_CALL_ID = '__pending__'

/**
 * 没有 block_id 可用 —— 临时生成 `recovered-{messageId}-{index}`，后续真正的 start 来了会覆盖（warn）。
 *
 * **W4a R1-P1-6 修复**：原 `recovered-${index}` 多 message 场景下 React key 撞车
 * （两个 message 的 index=0 placeholder block_id 相同，React diff 重 mount）。
 * 加上 messageId 后缀保证 (messageId, index) 二元组全 session 唯一。
 *
 * **W4a 三轮 A-P0-2**：input_json_delta 路径下，placeholder.block.id 改用
 * `__pending__` sentinel；同时初始化 `_pendingInputJsonFragments=[]`，handler
 * 走暂存路径，真 cb_start 到达时 replay 进真 toolCallId 的 buffer。
 */
function createPlaceholderForDelta(
  delta: ContentBlockDeltaPayload,
  index: number,
  messageId: string,
): ContentBlockEntry {
  const blockId = `recovered-${messageId}-${index}`
  let block: ContentBlock
  let pendingFragments: string[] | undefined
  switch (delta.type) {
    case 'text_delta':
    case 'connector_text_delta':
    case 'citations_delta':
      block = { type: 'text', text: '' }
      break
    case 'thinking_delta':
    case 'signature_delta':
      block = { type: 'thinking', thinking: '', signature: '' }
      break
    case 'input_json_delta':
      // W4a 三轮 A-P0-2：tool_use placeholder 的 block.id 用 sentinel 让
      // handler 走暂存路径，而**不**当真 toolCallId 喂 widget buffer。
      block = {
        type: 'tool_use',
        id: TOOL_USE_PENDING_TOOL_CALL_ID,
        name: '__recovered__',
        input: {},
      }
      pendingFragments = []
      break
    default:
      block = { type: 'text', text: '' }
  }
  return {
    index,
    block_id: blockId,
    block,
    finalized: false,
    partial: false,
    ...(pendingFragments !== undefined ? { _pendingInputJsonFragments: pendingFragments } : {}),
  }
}



/**
 * 单条 ContentBlock 在前端流式累积态。
 *
 * 字段语义（v2 §3.5.1.b）：
 * - `index`：daemon `content_block_start.index`（同 message 内 0/1/2/...）；UI 渲染按 index 升序。
 * - `block_id`：daemon `content_block_start.block_id`；用作 React key。
 * - `block`：标准 ContentBlock（22 case 之一），流式期间字段累积；finalized 后即 LLM 实际 message.content[i]。
 * - `finalized`：true 表示已收到 `content_block_stop`。
 * - `partial`：true 表示 stream 异常中断（message_stop 时仍 finalized=false 的兜底）。
 *
 * **W4c · W4a-L5 渲染契约（v2 §3.5.1.e）**：tool_use 流式期间 `block.input={}`
 * （Anthropic protocol 约定 cb_start 不带 input，input 通过 input_json_delta
 * 流式累积）；真实 partial JSON 在 `pendingInputJson` 字符串字段累积。
 *
 *   1. **流式期间（finalized=false）**：BlockRenderer 优先用 `pendingInputJson`
 *      走 `tryParsePartialJson` 兜底解析显示——尝试 JSON.parse → 失败补 `}`/`]`
 *      闭合再 parse → 都失败显示原始 partial_json 字符串 + "正在生成参数…"标签。
 *   2. **finalize 后（finalized=true）**：cb_stop 时 store 已经把 pendingInputJson
 *      JSON.parse 写到 `block.input`，BlockRenderer 直接用 `block.input` 即可。
 *   3. **parse 失败（parseError 存在）**：UI 走 `input_parse_error` 分支显示
 *      "工具调用参数损坏：${name}" + 展开 raw partial_json 让用户/开发排查。
 *
 *   实现样例：见 `components/chat/blocks/ToolUseBlockView.tsx` 的 `tryParsePartialJson`
 *   + `entry.parseError` 分支 + `effectiveInput` useMemo。MCP 工具走同款逻辑
 *   见 `McpToolBlockView.tsx`（W4c · W4b P1-c 对齐）。
 *
 * **不变量**：(message_id, index) 在 contentBlocksBySessionId 内唯一——
 * 同 index 的事件按 _seq 排序后只 apply 一次。
 */
export interface ContentBlockEntry {
  index: number
  block_id: string
  block: ContentBlock
  finalized: boolean
  partial: boolean
  /**
   * W4c · W4a-L12：当 partial=true 时区分"为何被打成 partial"，BlockRenderer
   * 据此渲染不同 UI 文案。
   *
   * - `'stream_interrupted'`：watchdog/timeout 路径——daemon 长时间无事件，UI
   *   显示"等待响应超时"
   * - `'message_stop_fallback'`：message_stop 到了但有 block 还没 finalize，
   *   被 messageStop 兜底打 partial（v2 §3.5.1.b 边角 case 3）。UI 显示
   *   "内容被截断"
   * - `'aborted'`：message_delta(stop_reason='aborted')——用户主动 cancel 或
   *   daemon 主动 abort。UI 显示"已中断"
   *
   * 老路径下默认 undefined（兼容已有 partial=true 但未带 reason 的 entry）。
   */
  partialReason?: 'stream_interrupted' | 'message_stop_fallback' | 'aborted'
  pendingInputJson?: string
  parseError?: { message: string; partial: string }
  /**
   * W4c · W4b-P1-1：thinking / tool_use / 等需要"显示运行耗时"的块——
   * `content_block_start` 时 stamp 当前时间（ms）。
   *
   * 仅 thinking / tool_use family 真正消费——避免给 22 case 全部块都强制
   * stamp 增大 entry 体积。其他类型默认 undefined，渲染端忽略即可。
   */
  startedAt?: number
  /**
   * W4c · W4b-P1-1：`content_block_stop` 到达时 stamp 当前时间（ms）。
   * thinking 块用 `stoppedAt - startedAt` 算 "Thought for Xs"；缺失时
   * （譬如 stream_interrupted）BlockRenderer 用 messageMeta.finalized 时刻
   * 兜底，最终缺失即不显示秒数（不是 NaN）。
   */
  stoppedAt?: number
  /**
   * W4a 三轮 W4a-L17 修复：text 块流式期间的 *raw* 累积值（无 fence 闭合）。
   *
   * 用途：`block.text` 字段在流式期间被 `ensureClosedFences()` 包过——
   * 渲染端拿到的是已闭合的 markdown，避免代码块中途渲染断 fence。但下次
   * delta 到达时累积必须基于 *raw* 文本（block.text 已含 `\n` + ``` 闭合
   * 后缀，直接 concat 会把"`""`"`"" 当真实文本接续）。
   *
   * 不变量：仅 text / connector_text 类块上存在；finalize 时（content_block_stop）
   * 一次性走 ensureClosedFences 把 raw 写回 block.text，本字段清空（block.text
   * 即 LLM 原始完整内容，markdown 通常自带闭合 fence）。
   */
  _rawText?: string
  /**
   * W4a 三轮 A-P0-2 修复：`__pending__` placeholder 暂存的 input_json_delta 片段。
   *
   * 触发场景：content_block_delta(input_json_delta) 早于 content_block_start
   * 到达（理论不应发生但要兜底）。此时 entry.block 是 placeholder（block.id
   * = '__pending__'，不是真 toolCallId），如果直接调 feedInputJsonDelta 会
   * 把 partial_json 写到 toolCallId='__pending__' 的孤儿 buffer——真 cb_start
   * 到达后这条 buffer 永远找不到，早期 token 全丢。
   *
   * 修法：placeholder 块上 delta 走"暂存到 fragments[]"路径；真 cb_start
   * 替换 placeholder 时调 `replayPendingInputJsonFragments(sessionId, 真toolCallId,
   * 真toolName, fragments)` 一次性回放进真 buffer。
   *
   * 不变量：仅 tool_use 类块的 placeholder 上存在；replay 后立刻清空。
   */
  _pendingInputJsonFragments?: string[]
}

/**
 * LLM message 元信息（per-message_id）。
 *
 * - `role`：assistant / user / system（来源 message_start.role）
 * - `started_at`：ISO8601 字符串（来源 message_start envelope）
 * - `finalized`：true 表示已收到 `message_stop`
 * - `stop_reason`：来自最后一条 `message_delta.delta.stop_reason`（Anthropic schema 把 stop_reason 放在 message_delta，**不在** message_stop）
 * - `usage`：来自 `message_delta.usage`，**cumulative**（不要累加，取最新即可——v2 §2.3.1）
 * - `subagent_run_id`：子 Agent 输出时非空；UI 路由到 subagent panel
 * - `text_summary`：W4a-L27 client 端派生——会话列表预览 / 兜底渲染用前 200 字
 *
 * **W4c · W4a-L19 / L25 订阅契约**（W4b BlockTimeline / MessageBubble 必读）：
 *
 * 1. **订阅形式**：通过 `useChatRuntimeStore` 直接订阅 `messageMetaBySessionId`
 *    Record。**不要**单独订阅 nested 字段（譬如 `s => s.messageMetaBySessionId[sid]?.[mid]?.stop_reason`）
 *    会撞 R3-P0-1 第二代性能问题（每次 set 全量重渲染）。
 *
 * 2. **稳定 API 字段**（消费方可信赖）：
 *    - `role`、`finalized`、`stop_reason`、`usage`、`persisted_id` —— wire 协议保证
 *    - `subagent_run_id` —— 由 messageStart envelope 透传，子 Agent message 必有
 *    - `started_at` / `model_id` / `model_name` —— 可选，缺失时 fallback 到 W3 默认
 *
 * 3. **subagent_run_id 订阅示例**（W4a-L25）：
 *    ```ts
 *    // 用法 A：取 message 是否属于子 Agent
 *    const isSubagentMsg = useChatRuntimeStore(
 *      s => !!s.messageMetaBySessionId[sid]?.[mid]?.subagent_run_id
 *    )
 *
 *    // 用法 B：按 subagent_run_id 找到所有子 Agent 输出（O(N) 扫描，N<50 时
 *    //         可接受；W4c-L6 在 dogfood 实测大于 50 时再加副索引）
 *    const subagentMessages = useChatRuntimeStore(s => {
 *      const sessionMap = s.messageMetaBySessionId[sid] ?? {}
 *      return Object.entries(sessionMap)
 *        .filter(([, meta]) => meta.subagent_run_id === targetRunId)
 *        .map(([msgId]) => msgId)
 *    })
 *    ```
 *
 * 4. **订阅选择器优化**（性能基线 ≥ 50fps）：使用 zustand `shallow` equality
 *    避免 Object.entries 每次返回新数组造成无谓重渲染：
 *    ```ts
 *    import { shallow } from 'zustand/shallow'
 *    const meta = useChatRuntimeStore(s => s.messageMetaBySessionId[sid]?.[mid], shallow)
 *    ```
 *    （per-(sid,mid) 引用相等是稳定的——只有 `_writePendingMeta` 写入时整对象
 *    替换。selector 返回的是同一引用直到下次写。）
 *
 * 5. **finalize 信号**（W4a-L19）：MessageBubble 切到"完成态"UI 必须订阅
 *    `meta.finalized`，**不要**直接读 `lastBlock.finalized`——message 层和 block
 *    层的 finalize 不同步（譬如 message_stop 兜底强制 finalize 所有 block 但
 *    最后一个 block 仍 partial=true 时，UI 应优先看 meta.finalized 决定是否
 *    显示 spinner）。
 */
// ---------------------------------------------------------------------------
// W4a-L27 · text_summary 派生：从 utils/contentBlockSummary.ts re-export
// ---------------------------------------------------------------------------
//
// 三视角 review 抽出来：deriveTextSummary / TEXT_SUMMARY_PLACEHOLDERS /
// isTextSummaryPlaceholder 都是纯函数，没有 store 依赖，但 UI 组件
// （MessageActions）需要消费——放在 store 文件里会让 UI 反向依赖 store，
// 违反 layering。本文件保留 re-export 让现有 store-internal caller
// （`messageStop` reducer 内部）继续无缝引用。
export {
  TEXT_SUMMARY_PLACEHOLDERS,
  isTextSummaryPlaceholder,
  deriveTextSummary,
  deriveTextClipboardContent,
} from '@/utils/contentBlockSummary'

// 内部 reducer 用的 import alias —— 单独 import 一次以避免下面的写入路径
// 反复触发 ESM live binding 解析。
import { deriveTextSummary as _deriveTextSummary } from '@/utils/contentBlockSummary'

// ---------------------------------------------------------------------------
// W4a-L23 · contentBlocks 内存 LRU trim（按 message_count 限额）
// ---------------------------------------------------------------------------

/**
 * W4a-L23：单 session 内 ContentBlock 数据保留上限（按 message_count 计）。
 *
 * 长会话不切走（用户在同一 session 持续对话）+ 不断滚出新 message 时
 * `contentBlocksBySessionId[sid]` 会无限增长。Electron desktop 1-4GB heap
 * 缓冲大不容易撞，但 W5 iOS foreground 200MB headroom 长会话直接 jetsam kill。
 *
 * 触发：单 session message 数 > MAX + BATCH（即 250）时 trim 最早 BATCH 个
 * finalized message 的 entries（active streaming 中的 message 不动）。
 */
const MAX_CONTENT_BLOCKS_PER_SESSION = 200

/**
 * W4a-L23：单次 trim 批量大小。
 *
 * 一次性 trim 50 个避免触发频率太高（每 50 message 才触发一次）+ 单次工作
 * 量可控（O(n) setState shallow clone + listener notify）。
 */
const MAX_CONTENT_BLOCK_TRIM_BATCH = 50

/**
 * W4a-L23：检查 session 是否需要 trim，超阈值则按 lastSeq 升序 trim 最早
 * BATCH 个 finalized message。
 *
 * **W4.5-A1 Review · P1-7 命名澄清**：函数名带 `LRU` 但**算法实际是 FIFO
 * 按 lastSeq 升序**——保留 LRU 命名是因为产品意图层面与 LRU 接近（"清掉最
 * 不活跃的"），但严格意义上不维护"最近读取时间"。命名保留以避免破坏 export
 * 接口（`__testTrimContentBlocksLRU` + `__MAX_CONTENT_BLOCKS_PER_SESSION`
 * 已被测试 import）；维护时认准 docstring 的算法描述。
 *
 * 算法：
 * 1. 合并 state + pending 双源的 messageId 集合（pending 中的还没 flush 的也算）
 * 2. message_count <= MAX + BATCH（250）→ noop（避免每次 messageStart 都做 O(n) 排序）
 * 3. 找出 finalized=true 的 message（active streaming 中的不动）
 * 4. 按 lastSeq 升序排（lastSeq 单调递增，越小越早）—— **FIFO**
 * 5. 取最早 BATCH 个 → setState 删除 state 三个 map + 清 pending Maps + 清
 *    _lastEventAtBySession + 通知 listener
 *
 * 不动 richContentBlocksBySessionId / agentStepsBySessionId / toolEventsBySessionId
 * —— 这些有独立的 trim / GC 路径（譬如 _trimToolEventsForSession），且不按
 * messageId 索引，本 trim 不强行串。**已知技术债**（W4.5-A1 Review · P1-8）：
 * 被 trim 的 message 含的 tool_use 块对应的 toolEvent / richContent widget
 * 仍挂在数组里成 dangling reference——dogfood 期间不暴露（用户不 inspect store），
 * 但长期内存上 toolEvents 由 _trimToolEventsForSession 上限 40 守住，richContent
 * 无 trim 是登记在 §0.6 的 Wave 8 收口项。
 *
 * 不动 _droppedEventCount —— 那是全局 metric 用于排障，不应被 trim 重置。
 */
function _trimContentBlocksLRU(sessionId: string): void {
  const state = useChatRuntimeStore.getState()
  const stateSession = state.messageMetaBySessionId[sessionId] ?? {}
  const pendingSession = _pendingMessageMeta.get(sessionId) ?? {}
  // 合并双源 messageId（pending 中可能有 state 还没看到的新 message）
  const allMessageIds = new Set<string>([
    ...Object.keys(stateSession),
    ...Object.keys(pendingSession),
  ])
  if (allMessageIds.size <= MAX_CONTENT_BLOCKS_PER_SESSION + MAX_CONTENT_BLOCK_TRIM_BATCH) {
    return
  }

  type Cand = { messageId: string; lastSeq: number }
  const candidates: Cand[] = []
  for (const mid of allMessageIds) {
    const meta = pendingSession[mid] ?? stateSession[mid]
    // active streaming 中的 message 不能 trim —— 否则 UI 上正在动的 spinner /
    // 正在累积的 text 会突然消失
    if (!meta?.finalized) continue
    const lastSeq = _readPendingLastSeq(sessionId, mid, state)
    candidates.push({ messageId: mid, lastSeq })
  }
  if (candidates.length === 0) {
    // 全在 active streaming（极不常见）→ 跳过本次，下次 messageStart 再试
    logger.debug('[contentBlocks] trimContentBlocksLRU skipped — all messages active', {
      sessionId, totalMessageCount: allMessageIds.size,
    })
    return
  }
  candidates.sort((a, b) => a.lastSeq - b.lastSeq)
  const toTrim = candidates.slice(0, MAX_CONTENT_BLOCK_TRIM_BATCH)
  const trimMids = new Set(toTrim.map(c => c.messageId))

  useChatRuntimeStore.setState(rs => {
    const mm = { ...rs.messageMetaBySessionId }
    const cs = { ...rs.contentBlocksLastSeqBySessionId }
    const mmSession = { ...(mm[sessionId] ?? {}) }
    const csSession = { ...(cs[sessionId] ?? {}) }
    for (const mid of trimMids) {
      delete mmSession[mid]
      delete csSession[mid]
    }
    mm[sessionId] = mmSession
    cs[sessionId] = csSession
    return {
      messageMetaBySessionId: mm,
      contentBlocksLastSeqBySessionId: cs,
    }
  })
  //  阶段 6：内容块在 messages 层，trim 一并清（内部逐条 notify，被 trim 的
  // (sid,mid) 订阅者重走 getSnapshot 拿空引用）。
  getContentBlocksBridge()?.clearMessages(sessionId, trimMids)

  // 清 pending Maps 中对应 messageId（避免 trim 后下次 flush 又把旧数据写回 state）
  const pcb = _pendingContentBlocks.get(sessionId)
  if (pcb) {
    for (const mid of trimMids) delete pcb[mid]
    if (Object.keys(pcb).length === 0) _pendingContentBlocks.delete(sessionId)
  }
  const pmm = _pendingMessageMeta.get(sessionId)
  if (pmm) {
    for (const mid of trimMids) delete pmm[mid]
    if (Object.keys(pmm).length === 0) _pendingMessageMeta.delete(sessionId)
  }
  const pcs = _pendingContentBlocksLastSeq.get(sessionId)
  if (pcs) {
    for (const mid of trimMids) delete pcs[mid]
    if (Object.keys(pcs).length === 0) _pendingContentBlocksLastSeq.delete(sessionId)
  }

  // 清 _lastEventAtBySession（watchdog 不再需要扫描已 trim 的 message）
  const sessionLastEvent = _lastEventAtBySession.get(sessionId)
  if (sessionLastEvent) {
    for (const mid of trimMids) sessionLastEvent.delete(mid)
    if (sessionLastEvent.size === 0) _lastEventAtBySession.delete(sessionId)
  }

  logger.info('[contentBlocks] trimContentBlocksLRU', {
    sessionId,
    trimmedCount: toTrim.length,
    activeMessageCount: allMessageIds.size - toTrim.length,
    threshold: MAX_CONTENT_BLOCKS_PER_SESSION,
    batch: MAX_CONTENT_BLOCK_TRIM_BATCH,
  })
}

/**
 * W4a-L23：测试用 —— 暴露内部 trim 触发，便于断言。生产代码请不要直接调，
 * 由 messageStart 自动触发。
 */
export function __testTrimContentBlocksLRU(sessionId: string): void {
  _trimContentBlocksLRU(sessionId)
}

/**
 * W4a-L23：测试用 —— 暴露常量值，便于断言阈值生效。
 */
export const __MAX_CONTENT_BLOCKS_PER_SESSION = MAX_CONTENT_BLOCKS_PER_SESSION
export const __MAX_CONTENT_BLOCK_TRIM_BATCH = MAX_CONTENT_BLOCK_TRIM_BATCH

// ---------------------------------------------------------------------------
// State interface
// ---------------------------------------------------------------------------

export interface ChatRuntimeState {
  // ── Agent 执行步骤 ──
  agentStepsBySessionId: Record<string, AgentStep[]>
  pushAgentStepForSession: (sessionId: string, step: AgentStep) => void
  updateAgentStepForSession: (sessionId: string, id: string, partial: Partial<AgentStep>) => void
  clearAgentStepsForSession: (sessionId: string) => void

  // ── 工具事件 ──
  toolEventsBySessionId: Record<string, ToolEvent[]>
  upsertToolEventForSession: (sessionId: string, event: ToolEvent) => void
  clearToolEventsForSession: (sessionId: string) => void
  /**
   * ：session 终态（cancel / error / terminated）收尾时，把所有
   * `phase='start'` 的 in-flight ToolEvent 强制收尾成 `phase='error'` +
   * `errorKind='aborted_by_user'`。
   *
   * **为什么需要**：abort 时 `StreamManager._doAbortSession` 先退订 WS，daemon
   * 随后 emit 的 `tool_failed` / `lifecycle.end` 在退订后到达会丢包，ToolEvent
   * 永远停在 `phase='start'` → ToolUseBlockView 持续显示 "tool in flight" /
   * partial。本方法在 `cleanupSessionOnTerminal` 里兜底收尾，让卡片立即切到
   * "已停止"态。
   *
   * **不伪造 output**：留 undefined，让后续真实 `tool_result`（re-sync 或迟到的
   * lifecycle notice）经 `upsertToolEventForSession` 的"新值覆盖"语义顶掉这条
   * 兜底——任何迟到的真实 notice 都会胜出。
   */
  finalizeInFlightToolEventsForSession: (sessionId: string) => void
  trimToolEventsForSession: (sessionId: string) => void
  retryTool: (sessionId: string, toolEvent: ToolEvent) => Promise<boolean>
  /**
   * 返回 toolEvent 的"effective"快照——包含 _pendingTools 中未 flush 的最新写入。
   *
   * **为什么需要**：`upsertToolEventForSession` 走 rAF 批量 flush；多个 stream
   * 事件在同一帧到达时（譬如 phase=start 与 phase=end 紧挨着），第二条 handler
   * 读 `state.toolEventsBySessionId` 拿不到第一条的写入，会让基于 existingTool
   * 的字段 fallback（durationMs / startedAt / inputSummary）失效。
   *
   * 业务侧调用方（toolHandler 等）应当用本 API 而不是直接读 store——确保
   * 任何 race 窗口都能拿到最新数据。返回的是只读引用，调用方不应 mutate。
   */
  getEffectiveToolEventForSession: (sessionId: string, eventId: string) => ToolEvent | undefined

  // ── 助手事件 ──
  assistantEventsBySessionId: Record<string, AssistantEvent[]>
  upsertAssistantEventForSession: (sessionId: string, event: AssistantEvent) => void
  resetAssistantDeltasForSession: (sessionId: string, runId?: string | null) => void

  // ── 子 Agent ──
  subagentRunsBySessionId: Record<string, SubagentRun[]>
  upsertSubagentRunForSession: (
    sessionId: string,
    run: SubagentRun,
    options?: { allowRevive?: boolean },
  ) => void
  markSubagentRunTerminalForSession: (
    sessionId: string,
    subagentRunId: string,
    status: Extract<SubagentRun['status'], 'completed' | 'failed' | 'cancelled'>,
    source: 'metadata' | 'child_stream' | 'archive',
  ) => void
  clearSubagentRunsForSession: (sessionId: string) => void
  cancelSubagentRun: (subagentRunId: string) => Promise<void>
  /**
   * ：主 Composer Stop 后仍存活的后台子数量（>0 时 PendingTasksNotice
   * 切换文案并自动展开）。子全部终态或用户清会话时清零。
   */
  composerStopBackgroundHintBySessionId: Record<string, number>
  noteComposerStopWithBackgroundSubagents: (sessionId: string, count: number) => void
  clearComposerStopBackgroundHint: (sessionId: string) => void
  reconcileSubagentRuns: (sessionId: string, threadId: string) => Promise<void>
  /**
   * 从父 session 的 `subagents.jsonl` 索引（archive）重建 SubagentRun 列表。
   *
   * **触发场景**：renderer 加载历史消息后（sessionCrudSlice.applyMessages
   * 路径）调用一次——SUBAGENT_* 事件不进父 events.jsonl / messages.jsonl，
   * 用户刷新 / 切走再回 / 重启 Electron 后内存 store 为空，卡片显示"状态
   * 同步中"。本 action 通过新增的 `agent-engine:list-subagent-runs` IPC
   * 把 status / task / parentToolCallId / startedAt / endedAt / duration
   * 五个字段 reconcile 回 store。
   *
   * **与 `reconcileSubagentRuns` 的区别**：后者走 REST API
   * `fetchSubagentRuns(threadId)`，仅 WS 重连时用；本 action 走本地 IPC
   * 读 archive，适配历史会话加载场景。两条路径互相补强（live 数据 + 历史
   * 数据），不冲突。
   *
   * **不恢复**实时态字段（toolHistory / stepCount / latestTool）—— 这些只
   * 在 SUBAGENT_PROGRESS 事件流里有，索引文件不持久化。展开历史卡片看不到
   * "每一步工具调用"是当前架构的妥协。
   *
   * 失败（IPC 不可用 / index missing / path traversal）silent log，不抛——
   * 历史回放不能因为 archive 损坏阻塞主消息加载。
   */
  reconcileSubagentRunsFromArchive: (
    sessionId: string,
    options?: { organizationId?: string; spaceId?: string },
  ) => Promise<void>

  /**
   * W4c · W4b P1-b："取消中"in-flight 状态——`cancelSubagentRun` 触发后到
   * 服务端 ACK / 失败之前的窗口期，UI 应显示"取消中..."而不是仍显示 X 按钮。
   *
   * 跟 `cancellingBySessionId`（主 session 级）正交：
   *   - `cancellingBySessionId[sid]` = 用户在主对话气泡点 stop，整个 turn 取消
   *   - `subagentCancellingByRunId[runId]` = 用户在 SubagentProgressCard 点 X，
   *     单独取消某个子 Agent
   *
   * SubagentProgressCard 同时读两侧——任一为真都走"取消中"状态，避免主会话
   * cancel 时子 Agent 卡片仍显示"运行中"误导用户。
   */
  subagentCancellingByRunId: Record<string, boolean>

  // ── Run 生命周期 ──
  runStateBySessionId: Record<string, RunState>
  updateRunStateForSession: (sessionId: string, partial: Partial<RunState>) => void

  // ── Rich Content (present_to_user 流式展示) ──
  richContentBlocksBySessionId: Record<string, unknown[]>
  appendRichContentBlocks: (sessionId: string, blocks: unknown[]) => void
  /**
   * Widget Wave 2.5（widget RFC §四 4.1 双协议）：按 `tool_call_id` upsert
   * rich_content blocks——专为 widget 流式渲染配套：
   *   - 首条 `tool_call_args_delta` 触发 streamMessageHandler 预创建 widget
   *     placeholder（带 tool_call_id），让 RichWidget 提前 mount 订阅 buffer
   *   - tool 真正 execute 时 emit RICH_CONTENT widget block（同 tool_call_id），
   *     这里**按 tool_call_id 找现有 placeholder 合并字段**——不重复 push，
   *     避免 iframe re-mount 闪烁、避免页面上同一 widget 出现两份。
   *
   * 与 `appendRichContentBlocks` 的关键区别：
   *   - append: 始终 push 到末尾（present_to_user 等无 tool_call_id 关联的多组件用）
   *   - upsert: 按 tool_call_id 索引，存在则 merge fields，不存在则 push
   *
   * incoming block 必须含 `tool_call_id` 字段——streamMessageHandler 的分流
   * 逻辑保证只有 widget kind + 有 tool_call_id 的 block 才走这条路径。
   */
  upsertRichContentBlocksByToolCallId: (sessionId: string, blocks: unknown[]) => void
  clearRichContentBlocks: (sessionId: string) => void
  /**
   * Widget Wave 3（RFC §五 3.6）：cancel / error / terminated / WS 死链时
   * **保留 widget kind block + 标记 interrupted_at**，**清空非 widget kind block**
   * （image / table_preview / file / resource_ref 走原 lifecycle 全清行为兼容）。
   *
   * 业务目的：用户主动 cancel 时已渲染的 widget SVG 不应消失，而是带"已中断"
   * 标识保留可见——让用户清楚地识别"这个图是中断的"，避免"突然消失"导致以为
   * 出错或者数据丢失。
   *
   * 幂等性：已带 `interrupted_at` 的 widget block 不覆盖（保留首次中断状态——
   * lifecycleHandler 路径先标记的具体 status 优先于 removeStreamingSession 路径
   * 的 'unknown' 兜底）。
   *
   * @param sessionId 当前会话
   * @param status    中断原因——决定 RichWidget UI badge 文案。lifecycle 终态
   *                  路径传 'cancelled' / 'error' / 'terminated'；WS 死链 / 重连
   *                  兜底路径传 'unknown'。
   */
  markStreamingWidgetsInterruptedAndClearOthers: (
    sessionId: string,
    status: 'cancelled' | 'error' | 'terminated' | 'unknown',
  ) => void

  // ── Agent Mode ──
  agentModeBySessionId: Record<string, AgentModeName>
  /**
   *  三档审批策略：当前会话审批档覆盖（always_ask/auto/full_access）。
   * UI 入口在 Agent 权限 drawer；Agent `approval_grant` 是授权上限。
   */
  approvalModeBySessionId: Record<string, ApprovalModeName>
  /** Session `/context` 返回的 group_runtime 快照（含 is_active）。 */
  groupRuntimeBySessionId: Record<string, GroupRuntimeConfig | null>
  setGroupRuntimeForSession: (sessionId: string, groupRuntime: GroupRuntimeConfig | null) => void

  // ── 附件上传进度 ──
  uploadProgressBySessionId: Record<string, number>
  uploadAbortControllerBySessionId: Record<string, AbortController>
  setUploadAbortController: (sessionId: string, controller: AbortController) => void
  abortUpload: (sessionId: string) => void
  clearUploadAbortController: (sessionId: string) => void

  // ── ：会话执行态单一投影（busy / runtime 排队）──
  // 写入方只有 sessionRunProjection.ts 的三类入口（乐观派发 / 流事件 / 对账）；
  // 消费方一律读 isSessionBusy / useSessionBusy，不再各自拼影子信号。
  runProjectionBySessionId: Record<string, import('./chat/execution/sessionRunProjection').SessionRunProjection>

  // ── 取消中状态（用户已点停止，等待后端确认） ──
  cancellingBySessionId: Record<string, boolean>
  setCancellingForSession: (sessionId: string, cancelling: boolean) => void

  // ── 失败消息编辑重发预填充 ──
  pendingPrefillBySessionId: Record<string, string | PrefillData>
  setPrefillForSession: (sessionId: string, content: string | PrefillData) => void
  consumePrefillForSession: (sessionId: string) => PrefillData | undefined

  // ── 用户主动停止后的二次编辑 ──
  activeSubmittedMessageBySessionId: Record<string, SubmittedMessageSnapshot>
  pendingInterruptedMessageBySessionId: Record<string, SubmittedMessageSnapshot>
  setActiveSubmittedMessageForSession: (
    sessionId: string,
    snapshot: SubmittedMessageSnapshot,
  ) => void
  clearActiveSubmittedMessage: (sessionId: string, clientMessageId?: string) => void
  moveActiveSubmittedMessageToInterruptedRecovery: (
    sessionId: string,
  ) => SubmittedMessageSnapshot | undefined
  consumeInterruptedMessageRecovery: (
    sessionId: string,
  ) => SubmittedMessageSnapshot | undefined
  discardInterruptedMessageRecovery: (sessionId: string) => void

  // ── LLM Call Snapshots (Phase 3 · Debug Observability) ──
  snapshotsBySessionId: Record<string, LLMCallSnapshot[]>
  pushSnapshotForSession: (sessionId: string, snapshot: LLMCallSnapshot) => void
  loadSnapshotsForSession: (
    sessionId: string,
    ctx?: { spaceId?: string; organizationId?: string },
  ) => Promise<void>

  // ── Wave 3：模型能力降级 / 能力警告 banner（per-session）──────────
  /** 当前 session 上仍未 dismiss 的降级 banner 列表（按 receivedAt 升序）。 */
  capabilityBannersBySessionId: Record<string, CapabilityBanner[]>
  /**
   * 写入一条降级 banner。
   * 同 session 内 (kind, feature, fallback_to) 三元组重复则**幂等忽略**——
   * 避免同一轮多次 yield 同一事件、或者前端订阅 IPC + WS 两路收到同一事件
   * 时 banner 数翻倍（W7c 观察端镜像场景）。
   */
  pushCapabilityBanner: (
    sessionId: string,
    banner: Omit<CapabilityBanner, 'id' | 'receivedAt'>,
  ) => void
  /** 用户点关闭按钮 → 移除该 banner（按 id）。 */
  dismissCapabilityBanner: (sessionId: string, bannerId: string) => void
  /**
   * 切模型 / 新建会话时调用——把 session 的 banner 列表整个清空。
   * 切模型后旧降级提示语不再适用，留着会误导用户（"这个模型也会降级吗？"）。
   */
  clearCapabilityBanners: (sessionId: string) => void

  // ── Wave 4a · ContentBlock 时间轴 ────────────────────────────
  //
  //  阶段 6：内容块的已提交存储已迁出 runtime store，落到 messages 层
  // （`stores/chat/messageBlocks.ts` 的 `_committedBlocks` + `ChatMessage.blocks`）。
  // runtime 只保留 pending 累积 + seq/replay/watchdog/LRU 引擎，flush 经 bridge
  // commit 进 messages 层。读单条块用 `useMessageBlocksById`，跨消息用
  // `useSessionBlocksRecord`（均在 messageBlocks.ts）。

  /** Per-session × per-message_id 的 LLM message 元信息。 */
  messageMetaBySessionId: Record<string, Record<string, MessageMeta>>

  /**
   * Per-session × per-message_id 已 apply 的最大 `_seq`。
   *
   * 用途：IPC vs WS 双源去重（v2 §3.5.1.c）+ 乱序事件丢弃——任何 event._seq <= lastSeq
   * 的事件视为重复或乱序，**drop 不抛错**（backend Redis INCR 保序，重复或乱序只可能来自
   * "IPC 主路径 + WS observer mirror 同收"或"内部 race"）。
   */
  contentBlocksLastSeqBySessionId: Record<string, Record<string, number>>

  /**
   * 处理 `content_block_start` —— 新建一条 entry（index/block_id/block 空壳/未 finalize）。
   * 若该 index 已存在 entry（"start 重发"）则覆盖；理论不应发生，记 warn。
   */
  contentBlockStart: (
    sessionId: string,
    messageId: string,
    index: number,
    blockId: string,
    block: ContentBlock,
    seq: number,
  ) => void

  /**
   * 处理 `content_block_delta` —— 按 index 找 entry，按 delta.type 累积字段。
   * 若 entry 不存在（"delta 早于 start"，理论不应发生），lazy 创建空壳 block 兜底。
   */
  contentBlockDelta: (
    sessionId: string,
    messageId: string,
    index: number,
    delta: ContentBlockDeltaPayload,
    seq: number,
  ) => void

  /**
   * 处理 `content_block_stop` —— 标记 finalized；若是 tool_use 块且累积了 pendingInputJson，
   * 尝试 JSON.parse 写入 block.input，失败则落 input_parse_error。
   */
  contentBlockStop: (
    sessionId: string,
    messageId: string,
    index: number,
    seq: number,
  ) => void

  /**
   * 处理 `message_start` —— 创建 messageMeta；同 sessionId 内 messageId 通常唯一，
   * 但 Subagent 嵌套 / 多轮 LLM call 时不同 message_id 各自独立。
   */
  messageStart: (
    sessionId: string,
    messageId: string,
    meta: Omit<MessageMeta, 'finalized'>,
    seq: number,
  ) => void

  /**
   * 处理 `message_delta` —— 更新 messageMeta.stop_reason / usage（cumulative，直接覆盖）。
   *
   * 返回本条 delta 是否被接受：seq 倒退 / message_start 缺失 / finalized 防御
   * 三类 drop 返回 false。#3393：调用方（contentBlockHandler）据此决定是否把
   * usage 同步进 token 展示层——store 拒绝的事件不能再进 token 路径，两边
   * 对同一条事件的取舍必须一致。
   */
  messageDelta: (
    sessionId: string,
    messageId: string,
    delta: { stop_reason?: MessageStopReason; stop_sequence?: string | null },
    usage: MessageUsage | undefined,
    seq: number,
  ) => boolean

  /**
   * 处理 `message_stop` —— 标记 messageMeta.finalized；强制 finalize 所有未 finalize 的 block（标 partial=true）。
   *
   * W4c · W4a-L12：`opts.partialReason` 显式声明本次 stop 是哪类来源——
   *   - undefined（默认）：根据 prevMeta.stop_reason 自动推断
   *     - 'aborted' → 'aborted'
   *     - 其他 → 'message_stop_fallback'
   *   - 'stream_interrupted'：watchdog 路径显式传入（daemon 长时间无响应）
   * partialReason 只对未 finalize 的 block 起作用（已 finalize 的 block 不被
   * 重复打 partial）。
   */
  messageStop: (
    sessionId: string,
    messageId: string,
    seq: number,
    opts?: {
      persistedId?: string
      blockIdOverrides?: Record<string, string>
      partialReason?: ContentBlockEntry['partialReason']
    },
  ) => void

  /**
   * 清空某个 session 的全部 ContentBlock 数据（evict / 用户手动清屏 / reset 场景用）。
   * **不要**用在常规 abort 路径——abort 路径下 stop_reason='aborted' 已通过 messageMeta 表达，UI 看 finalized + stop_reason 即可。
   */
  clearContentBlocksForSession: (sessionId: string) => void

  // ── 生命周期 ──
  evictSession: (sessionId: string) => void
  evictSessionBatch: (sessionIds: string[]) => void
  reset: () => void
}

// ---------------------------------------------------------------------------
// Initial state (reusable for reset)
// ---------------------------------------------------------------------------

const INITIAL_RUNTIME_STATE = {
  agentStepsBySessionId: {} as Record<string, AgentStep[]>,
  toolEventsBySessionId: {} as Record<string, ToolEvent[]>,
  assistantEventsBySessionId: {} as Record<string, AssistantEvent[]>,
  subagentRunsBySessionId: {} as Record<string, SubagentRun[]>,
  composerStopBackgroundHintBySessionId: {} as Record<string, number>,
  // W4c · W4b P1-b：subagent cancel in-flight 状态（cancelSubagentRun 触发到
  // 服务端 ACK 之间）——SubagentProgressCard 据此显示"取消中..."。
  subagentCancellingByRunId: {} as Record<string, boolean>,
  // PRD §4.11 / §5：旧的 activeSubagentDrawer + subagentSessionDataBySubId 已
  // 整体迁出（详情 jsonl 三件套缓存搬到 useSubagentSessionStore；抽屉本身被
  // workbench `subagent_session` Context Tab 替代）。
  runStateBySessionId: {} as Record<string, RunState>,
  richContentBlocksBySessionId: {} as Record<string, unknown[]>,
  agentModeBySessionId: {} as Record<string, AgentModeName>,
  approvalModeBySessionId: {} as Record<string, ApprovalModeName>,
  groupRuntimeBySessionId: {} as Record<string, GroupRuntimeConfig | null>,
  uploadProgressBySessionId: {} as Record<string, number>,
  uploadAbortControllerBySessionId: {} as Record<string, AbortController>,
  cancellingBySessionId: {} as Record<string, boolean>,
  runProjectionBySessionId: {} as Record<string, import('./chat/execution/sessionRunProjection').SessionRunProjection>,
  pendingPrefillBySessionId: {} as Record<string, string | PrefillData>,
  activeSubmittedMessageBySessionId: {} as Record<string, SubmittedMessageSnapshot>,
  pendingInterruptedMessageBySessionId: {} as Record<string, SubmittedMessageSnapshot>,
  snapshotsBySessionId: {} as Record<string, LLMCallSnapshot[]>,
  capabilityBannersBySessionId: {} as Record<string, CapabilityBanner[]>,
  messageMetaBySessionId: {} as Record<string, Record<string, MessageMeta>>,
  contentBlocksLastSeqBySessionId: {} as Record<string, Record<string, number>>,
}

// ---------------------------------------------------------------------------
// rAF 批量合并 — 高频事件（tool/step/assistant）合并为每帧单次 set()
// ---------------------------------------------------------------------------

const _pendingSteps = new Map<string, AgentStep[]>()
const _pendingTools = new Map<string, ToolEvent[]>()
const _pendingAssistants = new Map<string, AssistantEvent[]>()
const _pendingRunStates = new Map<string, RunState>()
// ── Wave 4a R3-P0-1：ContentBlock 高频路径走 rAF batch ─────────────────
// 1000 token/s 流式下 content_block_delta 每秒上千条；同步 set 让 Zustand
// listener 单帧多次 schedule 重渲染，主线程 60-90% 占用 < 30fps（自跑实证）。
// 与 _pendingTools / _pendingAssistants 同模式：单层 Map<sessionId, Record<messageId, ...>>
// 让 flush 把整个 session 的 messages 一次性 patch 进 state（避免 messageId 粒
// 度 Map 在 flush 时遍历开销）。
//
// **读路径双源**：CRUD 入口先 `_pendingX.get(sid)?.[mid]` 再 fallback 到
// state.X[sid]?.[mid]，与 upsertToolEventForSession 同语义——单帧内"start
// 写 pending 还没 flush，下一条 delta 读 state 旧值"的 race 通过 pending 优
// 先解决。
const _pendingContentBlocks = new Map<string, Record<string, ContentBlockEntry[]>>()
const _pendingMessageMeta = new Map<string, Record<string, MessageMeta>>()
const _pendingContentBlocksLastSeq = new Map<string, Record<string, number>>()

/**
 * W4a 三轮 B-P1 metric：drop 事件计数（per type）。
 *
 * 用途：DevPanel 实测"流式中 X 条事件被 drop"的可见度——线上若投诉
 * "文字突然不显示" / "thinking 段没出来"，把 metric 截个图就能定位是
 * 协议 race、seq 倒退还是 finalized 防御被触发。
 *
 * 字段：
 *   - `finalizedAfterStop`: contentBlockDelta / Start 撞 finalized block
 *   - `seqDrop`: seq <= prevSeq 倒退/重复
 *   - `replayReset`: messageStart 检测 replay 走重置路径（功能性 + 统计）
 *   - `schemaParseFail`: zod 失败 + 不可恢复（essential 字段缺失）
 *   - `schemaParseDegraded`: zod 失败但 essential 通过 + 降级 stub
 *
 * 不持久化、不走 rAF——计数操作 < 1ns，纯 in-memory，DevPanel 直接读。
 */
/**
 * W4a 四轮 B-P1 + 五轮 R5-5：drop / 降级 / reconcile 计数器。
 *
 * 字段分组（重要：DevPanel 把这些 metric 展示给开发者作排障线索）：
 *
 * **drop 系列**（事件被丢弃，可能是 silent bug 警示）：
 *   - finalizedAfterStop：finalized 之后到达的非法 retry 事件被 drop
 *   - seqDrop：seq 倒退或重复被 drop
 *   - schemaParseFail：essential field 缺失整事件 drop
 *   - persistedIdConflict：messageStop reconcile 时 daemon 用了不同 UUID
 *     被 drop（first-persistedId-wins 守卫）。**daemon bug 信号**——
 *     正常运行时应恒为 0；非 0 即说明 daemon retry 路径误生成新 UUID。
 *
 * **降级系列**（事件保留但走 fallback）：
 *   - schemaParseDegraded：non-essential field 失败 stub fallback
 *   - replayReset：WS replay / daemon retry 触发的 messageStart 重置
 *
 * **reconcile 系列**（合法的后端回填，不是 drop——W4a 五轮 R5-5 拆分）：
 *   - reconcileMessageStop：W3 后端落库后回填 persistedId/blockIdOverrides
 *     走 messageStop reconcile-only 路径的次数。**正常运行时单调增长**，
 *     DevPanel 把此值与 drop 系列**分开显示**，避免开发者把"正常 reconcile"
 *     误判为"daemon retry race"。
 */
const _droppedEventCount = {
  finalizedAfterStop: 0,
  seqDrop: 0,
  replayReset: 0,
  schemaParseFail: 0,
  schemaParseDegraded: 0,
  /** W4a 五轮 R5-5：reconcile 路径单独计数（非 drop） */
  reconcileMessageStop: 0,
  /** W4a 六轮 R5-8 收尾：first-persistedId-wins 冲突 drop（daemon bug 信号） */
  persistedIdConflict: 0,
}

export function getDroppedEventCount(): Readonly<typeof _droppedEventCount> {
  return _droppedEventCount
}

/**
 * 内部写入入口：仅供本 store 模块和受信任 handler 调用，外部禁止写。
 * 公开 getter 返回 Readonly<...> 防止外部误改。
 */
export function incrementDroppedEventCount(
  key: keyof typeof _droppedEventCount,
): void {
  _droppedEventCount[key]++
}

export function resetDroppedEventCount(): void {
  _droppedEventCount.finalizedAfterStop = 0
  _droppedEventCount.seqDrop = 0
  _droppedEventCount.replayReset = 0
  _droppedEventCount.schemaParseFail = 0
  _droppedEventCount.schemaParseDegraded = 0
  _droppedEventCount.reconcileMessageStop = 0
  _droppedEventCount.persistedIdConflict = 0
}

let _batchRafId: number | null = null

function _scheduleBatchFlush() {
  if (_batchRafId !== null) return
  _batchRafId = requestAnimationFrame(() => {
    _batchRafId = null
    flushRuntimeBatch()
  })
}

function _clearSessionFromBatch(sessionId: string) {
  _pendingSteps.delete(sessionId)
  _pendingTools.delete(sessionId)
  _pendingAssistants.delete(sessionId)
  _pendingRunStates.delete(sessionId)
  _pendingContentBlocks.delete(sessionId)
  _pendingMessageMeta.delete(sessionId)
  _pendingContentBlocksLastSeq.delete(sessionId)
}

function _clearAllBatch() {
  _pendingSteps.clear()
  _pendingTools.clear()
  _pendingAssistants.clear()
  _pendingRunStates.clear()
  _pendingContentBlocks.clear()
  _pendingMessageMeta.clear()
  _pendingContentBlocksLastSeq.clear()
  if (_batchRafId !== null) {
    cancelAnimationFrame(_batchRafId)
    _batchRafId = null
  }
}

// ── ContentBlock pending-first read/write helpers（W4a R3-P0-1）──────
//
// 单帧内一条 message 的多条事件（譬如 start+delta+delta+stop）连续调用时，
// 这组 helper 让 set() 内部读到"已 pending 未 flush"的最新值，与单源
// 同步路径行为等价。flush 把 pending 一次性合并回 state。

function _readPendingBlocks(
  sessionId: string,
  messageId: string,
  _state: ChatRuntimeState,
): ContentBlockEntry[] {
  const pendingSession = _pendingContentBlocks.get(sessionId)
  if (pendingSession && messageId in pendingSession) return pendingSession[messageId]
  //  阶段 6：已提交块回到 messages 层（bridge）。pending 优先仍保证单帧多事件读一致。
  return getContentBlocksBridge()?.read(sessionId, messageId) ?? []
}

function _readPendingMeta(
  sessionId: string,
  messageId: string,
  state: ChatRuntimeState,
): MessageMeta | undefined {
  const pendingSession = _pendingMessageMeta.get(sessionId)
  if (pendingSession && messageId in pendingSession) return pendingSession[messageId]
  return state.messageMetaBySessionId[sessionId]?.[messageId]
}

function _readPendingLastSeq(
  sessionId: string,
  messageId: string,
  state: ChatRuntimeState,
): number {
  const pendingSession = _pendingContentBlocksLastSeq.get(sessionId)
  if (pendingSession && messageId in pendingSession) return pendingSession[messageId]
  return state.contentBlocksLastSeqBySessionId[sessionId]?.[messageId] ?? -1
}

function _writePendingBlocks(sessionId: string, messageId: string, blocks: ContentBlockEntry[]): void {
  const existing = _pendingContentBlocks.get(sessionId) ?? {}
  _pendingContentBlocks.set(sessionId, { ...existing, [messageId]: blocks })
}

function _writePendingMeta(sessionId: string, messageId: string, meta: MessageMeta): void {
  const existing = _pendingMessageMeta.get(sessionId) ?? {}
  _pendingMessageMeta.set(sessionId, { ...existing, [messageId]: meta })
  // lastEventAt 在 _writePendingLastSeq 里统一 stamp（messageStart/Delta/Stop
  // 都跟 _writePendingLastSeq 配对调用，覆盖全口径）。
}

/**
 * W4a 三轮 W4a-L7：lastEventAt 时间戳 Map（独立于 MessageMeta，不进 store state）。
 *
 * 为什么独立 Map：lastEventAt 每帧都更新，如果塞进 MessageMeta 会让
 * messageMetaBySessionId 引用每帧变 → 所有 selector 重渲染 → 性能崩。
 * 独立 Map 由 watchdog 模块直接读写，store 完全不感知。
 */
const _lastEventAtBySession = new Map<string, Map<string, number>>()
function _stampLastEventAt(sessionId: string, messageId: string): void {
  const sessionMap = _lastEventAtBySession.get(sessionId) ?? new Map<string, number>()
  sessionMap.set(messageId, Date.now())
  _lastEventAtBySession.set(sessionId, sessionMap)
}

/**
 * ContentBlock Watchdog—— 扫描未 finalize 且静默 ≥ 120s 的消息，
 * **只**触发 `reconcileSessionRunState`，不再本地 force finalize。
 *
 * 触发条件（&&）：
 *   ① state.messageMetaBySessionId[sid][mid].finalized === false
 *   ② _lastEventAtBySession[sid][mid] < now - WATCHDOG_TIMEOUT_MS（120s）
 *
 * 收口权归 Runtime（与  IPC stall /  reconcile 同哲学）：
 *   - 权威 busy（子 Agent / HITL / 长工具）→ reconcile 维持 busy，消息保持未 finalize
 *   - 本机权威 idle → reconcile 走 endSessionRun(cancelled) + hydrate
 *   - 无 bridge / 非本机托管 → reconcile 不误清
 *
 * 设计要点：
 *   - 单例 + setInterval 30s；按 session 去重，同 session 一次只 reconcile 一次
 *   - lastEventAt 独立 Map → 读不引发 React 重渲染
 *   - 权威仍 busy 时 stamp 续期，避免下一 tick 立刻再打 IPC（reconcile 另有 5s 节流）
 *   - 测试环境用 `__testTickWatchdog` / `stopContentBlockWatchdog` 显式控制
 */
const WATCHDOG_INTERVAL_MS = 30_000
const WATCHDOG_TIMEOUT_MS = 120_000
let _watchdogTimer: ReturnType<typeof setInterval> | null = null
let _watchdogStateGetter: (() => ChatRuntimeState) | null = null
const _watchdogReconcileInFlight = new Set<string>()

/**
 * 可注入的对账函数（生产走 sessionRunReconcile；测试可替换避免真 IPC）。
 */
export type WatchdogReconcileFn = (
  sessionId: string,
  reason: 'watchdog',
) => Promise<boolean> | boolean

let _watchdogReconcileFn: WatchdogReconcileFn | null = null

/** 测试用：注入 / 清除 reconcile 实现。传 null 恢复默认 dynamic import。 */
export function __setWatchdogReconcileFnForTest(fn: WatchdogReconcileFn | null): void {
  _watchdogReconcileFn = fn
}

async function _defaultWatchdogReconcile(sessionId: string): Promise<boolean> {
  const { reconcileSessionRunState } = await import('./chat/execution/sessionRunReconcile')
  return reconcileSessionRunState(sessionId, 'watchdog')
}

function _watchdogTick(): Promise<void> {
  if (!_watchdogStateGetter) return Promise.resolve()
  const state = _watchdogStateGetter()
  const now = Date.now()
  const timeoutThreshold = now - WATCHDOG_TIMEOUT_MS
  const staleMessageIdsBySession = new Map<string, string[]>()

  for (const [sessionId, sessionMessages] of Object.entries(state.messageMetaBySessionId)) {
    for (const [messageId, meta] of Object.entries(sessionMessages)) {
      if (meta.finalized) continue
      const lastAt = _lastEventAtBySession.get(sessionId)?.get(messageId) ?? 0
      if (lastAt > 0 && lastAt < timeoutThreshold) {
        const list = staleMessageIdsBySession.get(sessionId) ?? []
        list.push(messageId)
        staleMessageIdsBySession.set(sessionId, list)
      }
    }
  }

  if (staleMessageIdsBySession.size === 0) return Promise.resolve()

  const tasks: Promise<void>[] = []
  for (const [sessionId, messageIds] of staleMessageIdsBySession) {
    if (_watchdogReconcileInFlight.has(sessionId)) continue
    _watchdogReconcileInFlight.add(sessionId)
    logger.warn('[contentBlocks] watchdog silence — reconcile only ', {
      sessionId,
      staleMessageCount: messageIds.length,
      thresholdMs: WATCHDOG_TIMEOUT_MS,
    })
    const reconcile = _watchdogReconcileFn ?? _defaultWatchdogReconcile
    tasks.push(
      Promise.resolve(reconcile(sessionId, 'watchdog'))
        .then(async () => {
          const { isSessionBusy } = await import('./chat/execution/sessionRunProjection')
          if (!isSessionBusy(sessionId)) return
          const latest = _watchdogStateGetter?.()
          if (!latest) return
          for (const messageId of messageIds) {
            const meta = latest.messageMetaBySessionId[sessionId]?.[messageId]
            if (meta && !meta.finalized) _stampLastEventAt(sessionId, messageId)
          }
        })
        .catch((err) => {
          logger.warn('[contentBlocks] watchdog reconcile failed', {
            sessionId,
            err: err instanceof Error ? err.message : String(err),
          })
        })
        .finally(() => {
          _watchdogReconcileInFlight.delete(sessionId)
        }),
    )
  }
  return Promise.all(tasks).then(() => undefined)
}

/**
 * 启动 contentBlock 静默对账 timer。
 *
 * @returns 本次是否新启动（已在跑则 true 表示仍在跑）
 */
export function startContentBlockWatchdog(stateGetter: () => ChatRuntimeState): boolean {
  if (_watchdogTimer !== null) return true
  _watchdogStateGetter = stateGetter
  // setInterval 在 jsdom/happy-dom 环境也存在，但 unref 让 nodejs process
  // 退出时不被 timer 卡——test 友好；浏览器环境 unref 是 noop。
  _watchdogTimer = setInterval(() => {
    void _watchdogTick()
  }, WATCHDOG_INTERVAL_MS)
  const handle = _watchdogTimer as unknown as { unref?: () => void }
  if (typeof handle.unref === 'function') handle.unref()
  return true
}

export function stopContentBlockWatchdog(): void {
  if (_watchdogTimer !== null) {
    clearInterval(_watchdogTimer)
    _watchdogTimer = null
  }
  _watchdogStateGetter = null
  _watchdogReconcileInFlight.clear()
  _lastEventAtBySession.clear()
}

/** 测试用——手动 tick watchdog，并等待本轮 reconcile 结束。 */
export async function __testTickWatchdog(stateGetter: () => ChatRuntimeState): Promise<void> {
  _watchdogStateGetter = stateGetter
  await _watchdogTick()
}

/** 测试用——清 lastEventAt Map，避免上轮测试残留影响本轮。 */
export function __resetWatchdogState(): void {
  _lastEventAtBySession.clear()
  _watchdogReconcileInFlight.clear()
}

function _writePendingLastSeq(sessionId: string, messageId: string, seq: number): void {
  const existing = _pendingContentBlocksLastSeq.get(sessionId) ?? {}
  _pendingContentBlocksLastSeq.set(sessionId, { ...existing, [messageId]: seq })
  // W4a 三轮 W4a-L7：lastSeq 每条事件都写——这里 stamp lastEventAt 覆盖
  // cb_start/delta/stop 全路径。messageStart/Delta/Stop 路径也走这里，
  // 单点保证 watchdog 拿到全口径活信号。
  _stampLastEventAt(sessionId, messageId)
}

/**
 * 同步刷新所有待合并的运行时状态更新。
 * 在需要读取最新已提交状态前调用（如生命周期结束、evict 前）。
 */
/**
 * W4a 三轮 B-P1：performance.mark / measure helper —— 高频路径埋点。
 *
 * 用途：W4b dogfood 时用 chrome devtools performance panel 直接看 rAF flush
 * 耗时分布；线上崩盘投诉时让用户上传 `performance.getEntries()` 截图就能
 * 定位是 batch 太大、selector 重复评估还是 React commit 阶段卡。
 *
 * 生产构建保留 —— performance API native 调用 < 1µs，无可观测开销。
 * SSR / 无 performance API 环境（理论不应发生）下静默 noop。
 */
function _perfMark(name: string): void {
  if (typeof performance === 'undefined' || typeof performance.mark !== 'function') return
  try {
    performance.mark(name)
  } catch {
    /* defensive */
  }
}

export function flushRuntimeBatch() {
  if (_batchRafId !== null) {
    cancelAnimationFrame(_batchRafId)
    _batchRafId = null
  }
  _perfMark('[contentBlocks] rAF flush:start')


  const hasAny =
    _pendingSteps.size > 0 ||
    _pendingTools.size > 0 ||
    _pendingAssistants.size > 0 ||
    _pendingRunStates.size > 0 ||
    _pendingContentBlocks.size > 0 ||
    _pendingMessageMeta.size > 0 ||
    _pendingContentBlocksLastSeq.size > 0
  if (!hasAny) return

  const state = useChatRuntimeStore.getState()
  const patch: Record<string, unknown> = {}

  if (_pendingSteps.size > 0) {
    const merged = { ...state.agentStepsBySessionId }
    for (const [sid, steps] of _pendingSteps) merged[sid] = steps
    patch.agentStepsBySessionId = merged
    _pendingSteps.clear()
  }
  if (_pendingTools.size > 0) {
    const merged = { ...state.toolEventsBySessionId }
    for (const [sid, events] of _pendingTools) merged[sid] = events
    patch.toolEventsBySessionId = merged
    _pendingTools.clear()
  }
  if (_pendingAssistants.size > 0) {
    const merged = { ...state.assistantEventsBySessionId }
    for (const [sid, events] of _pendingAssistants) merged[sid] = events
    patch.assistantEventsBySessionId = merged
    _pendingAssistants.clear()
  }
  if (_pendingRunStates.size > 0) {
    const merged = { ...state.runStateBySessionId }
    for (const [sid, rs] of _pendingRunStates) merged[sid] = rs
    patch.runStateBySessionId = merged
    _pendingRunStates.clear()
  }

  // ContentBlock 三组 patch（W4a R3-P0-1）。每个 session 单独合并：与 state
  // 现有 session 数据 shallow-merge，避免清空别的 message。
  //
  //  阶段 6：内容块 commit 进 messages 层（SSoT）。收集 (sid,mid,entries)
  // 在 setState 之后统一 commit——commit 会读 useChatStore（就地写 message.blocks），
  // 与 runtime setState 解耦，且 commit 内部按 (sid,mid) + session 精准 notify。
  const _blockCommits: Array<[string, string, ContentBlockEntry[]]> = []
  if (_pendingContentBlocks.size > 0) {
    for (const [sid, msgMap] of _pendingContentBlocks) {
      for (const mid of Object.keys(msgMap)) {
        _blockCommits.push([sid, mid, msgMap[mid] ?? []])
      }
    }
    _pendingContentBlocks.clear()
  }
  if (_pendingMessageMeta.size > 0) {
    const merged = { ...state.messageMetaBySessionId }
    for (const [sid, msgMap] of _pendingMessageMeta) {
      merged[sid] = { ...(merged[sid] ?? {}), ...msgMap }
    }
    patch.messageMetaBySessionId = merged
    _pendingMessageMeta.clear()
  }
  if (_pendingContentBlocksLastSeq.size > 0) {
    const merged = { ...state.contentBlocksLastSeqBySessionId }
    for (const [sid, msgMap] of _pendingContentBlocksLastSeq) {
      merged[sid] = { ...(merged[sid] ?? {}), ...msgMap }
    }
    patch.contentBlocksLastSeqBySessionId = merged
    _pendingContentBlocksLastSeq.clear()
  }

  useChatRuntimeStore.setState(patch as Partial<ChatRuntimeState>)
  // 内容块提交到 messages 层（commit 内就地写 + per-(sid,mid)/session notify）。
  if (_blockCommits.length > 0) {
    const bridge = getContentBlocksBridge()
    if (bridge) {
      for (const [sid, mid, entries] of _blockCommits) bridge.commit(sid, mid, entries)
    }
  }
  _perfMark('[contentBlocks] rAF flush:end')
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useChatRuntimeStore = create<ChatRuntimeState>()((set, get) => ({
  ...INITIAL_RUNTIME_STATE,

  // ── Agent 步骤（rAF 批量合并）──────────────────────────────

  pushAgentStepForSession: (sessionId, step) => {
    const prev = _pendingSteps.get(sessionId) ?? get().agentStepsBySessionId[sessionId] ?? []
    // W4a 四轮 R4-4 + 五轮 R5-4：同 id upsert 语义 + **不降级守门**。
    //
    // 四轮 R4-4：stable id（thinking-placeholder-${messageId}）二次 push 走 update
    // 路径，避免 WS replay / daemon retry 重复堆积。
    //
    // 五轮 R5-4：四轮的"字段全覆盖"导致已 status='done' 的 step 被新 push
    // 的 status='running' 覆盖——WS replay 场景下"已完成 thinking step
    // spinner 又转一下又停"。修复：upsert 引入**不降级**语义——`done` /
    // `error` / `timeout` 等终态不被 `running` 覆盖（终态优先）。
    //
    // 不破坏现有调用方：用 anonymous random id push 的代码走原 append 路径；
    // 只有 stable id 调用方才命中 upsert + 不降级守门。
    const dupIndex = step.id ? prev.findIndex(s => s.id === step.id) : -1
    let next: AgentStep[]
    if (dupIndex >= 0) {
      const existing = prev[dupIndex]
      const isExistingTerminal = existing.status === 'done'
        || existing.status === 'error'
        || existing.status === 'cancelled'
      const isIncomingRunning = step.status === 'running'
      next = prev.slice()
      if (isExistingTerminal && isIncomingRunning) {
        // W4a 五轮 R5-4：终态不被 running 覆盖——保留 existing 完整不变
        // （不做字段 merge——避免新 step 的 title / detail 等运行时字段
        // 污染已完成 step 的最终展示）
        logger.debug('[runtime] pushAgentStepForSession upsert downgrade blocked', {
          sessionId, stepId: step.id, existingStatus: existing.status,
        })
        // next[dupIndex] 保持不变
      } else {
        // 正常 upsert：浅合并字段
        next[dupIndex] = { ...existing, ...step }
      }
    } else {
      next = [...prev, step].slice(-200)
    }
    _pendingSteps.set(sessionId, next)
    _scheduleBatchFlush()
  },

  updateAgentStepForSession: (sessionId, id, partial) => {
    const prev = _pendingSteps.get(sessionId) ?? get().agentStepsBySessionId[sessionId] ?? []
    const next = prev.map(s => s.id === id ? { ...s, ...partial } : s)
    _pendingSteps.set(sessionId, next)
    _scheduleBatchFlush()
  },

  clearAgentStepsForSession: (sessionId) => {
    _pendingSteps.delete(sessionId)
    set(state => {
      const next = { ...state.agentStepsBySessionId }
      delete next[sessionId]
      return { agentStepsBySessionId: next }
    })
  },

  // ── 工具事件（rAF 批量合并）────────────────────────────────

  upsertToolEventForSession: (sessionId, event) => {
    /**
     * **批量合并 + 字段级 merge（W14 race 修复）**
     *
     * 必须从 `_pendingTools` **和** `toolEventsBySessionId` 双源找 existing：
     * 单帧内 phase=start → phase=end 顺序到达时，rAF flush 可能还没跑——
     * 只读 store 会拿不到刚 set 的 phase=start 数据，让 phase=end merge 失效。
     *
     * **字段级 merge 语义**（不变量，跨 wave 守护）：
     *   - `id` / `toolName`：identity，新值覆盖
     *   - `phase` / `output` / `error` / `errorKind`：状态推进，新值覆盖
     *   - `input` / `inputSummary` / `runId` / `startedAt` / `presentation` /
     *     `budgetSkipped`：**若新事件里是 undefined，沿用旧值**——runtime stream
     *     protocol 在 phase=end 时不带 input，但持久化与 UI 都要求
     *     "toolEvent.input 始终是 phase=start 时 LLM 给的最终参数"。这是 stream
     *     protocol 与 UI 语义的**前端缝合层**，让协议演化在前端不漏。
     *
     * 历史 dogfood bug（会话 0b1b4ce4）：rAF race 让 input 被 phase=end 的
     * undefined 擦掉，FileWriteCard 显示"文件内容为空"；刷新后从 content_blocks_json
     * hydrate 走持久化路径才正确——根因是这条 merge 没在 store 内做。
     */
    const pending = _pendingTools.get(sessionId)
    const persisted = get().toolEventsBySessionId[sessionId]
    const prev = pending ?? persisted ?? []
    const existing = prev.find(i => i.id === event.id)

    // undefined-保留 merge：避免下游协议不规范（譬如 phase=end 不带 input）
    // 让此前 phase=start 攒下的字段被擦掉。
    const merged: ToolEvent = existing
      ? {
          ...existing,
          ...event,
          input: event.input !== undefined ? event.input : existing.input,
          inputSummary: event.inputSummary !== undefined ? event.inputSummary : existing.inputSummary,
          intent: event.intent !== undefined ? event.intent : existing.intent,
          runId: event.runId !== undefined ? event.runId : existing.runId,
          startedAt: event.startedAt !== undefined ? event.startedAt : existing.startedAt,
          presentation: event.presentation !== undefined ? event.presentation : existing.presentation,
          budgetSkipped: event.budgetSkipped !== undefined ? event.budgetSkipped : existing.budgetSkipped,
        }
      : event

    const filtered = prev.filter(i => i.id !== event.id)
    const next = [...filtered, merged].slice(-200)
    _pendingTools.set(sessionId, next)
    _scheduleBatchFlush()
  },

  clearToolEventsForSession: (sessionId) => {
    _pendingTools.delete(sessionId)
    set(state => {
      const next = { ...state.toolEventsBySessionId }
      delete next[sessionId]
      return { toolEventsBySessionId: next }
    })
  },

  finalizeInFlightToolEventsForSession: (sessionId) => {
    // ：见 interface doc-comment。abort / cancel / error 时 daemon 的
    // tool_failed / lifecycle.end 可能因 WS 已退订丢包，in-flight ToolEvent 永远
    // 卡 phase='start' → ToolUseBlockView 持续显示 "tool in flight" / partial。
    // 这里把 phase='start' 强制收尾成 phase='error'(aborted_by_user)，迟到的真实
    // lifecycle notice 仍会经 upsert 的"新值覆盖"语义顶掉这条兜底。
    //
    // 直接写 store（同步 set）而非走 rAF 批量 upsert——cleanupSessionOnTerminal
    // 是终态收尾路径，需要立即对外可见，不能等下一帧 flush。
    const pending = _pendingTools.get(sessionId)
    const persisted = get().toolEventsBySessionId[sessionId]
    const prev = pending ?? persisted ?? []
    const now = Date.now()
    let changed = false
    const next = prev.map((e) => {
      if (e.phase !== 'start') return e
      changed = true
      return {
        ...e,
        phase: 'error' as const,
        errorKind: e.errorKind ?? 'aborted_by_user',
        error: e.error ?? 'Tool execution aborted',
        progress: undefined,
        durationMs: e.startedAt ? now - e.startedAt : e.durationMs,
        timestamp: now,
      }
    })
    if (!changed) return
    _pendingTools.set(sessionId, next)
    set((state) => ({
      toolEventsBySessionId: { ...state.toolEventsBySessionId, [sessionId]: next },
    }))
  },

  trimToolEventsForSession: (sessionId) => {
    const events = _pendingTools.get(sessionId) ?? get().toolEventsBySessionId[sessionId]
    if (!events || events.length <= MAX_FULL_TOOL_EVENTS) return
    const trimmed = _trimToolEventsForSession(events)
    _pendingTools.set(sessionId, trimmed)
    _scheduleBatchFlush()
  },

  getEffectiveToolEventForSession: (sessionId, eventId) => {
    // 双源查找：_pendingTools（最新写入，未 flush）优先于已 flush 的 store。
    // _pendingTools 已经持有一个完整数组（每次 upsert 重写整组），所以查它就够，
    // 不必跨两源 merge。空时回退到 store。
    const events = _pendingTools.get(sessionId) ?? get().toolEventsBySessionId[sessionId]
    return events?.find(e => e.id === eventId)
  },

  retryTool: async (sessionId, toolEvent) => {
    const stepId = `tool-${toolEvent.id}`

    get().updateAgentStepForSession(sessionId, stepId, { status: 'running' })
    // **2026-05-17 dogfood Review P0-2**：原版 spread `...toolEvent` 会把
    // 上一轮的 `progress`（streaming partial stdout 快照）带进新一轮，
    // 让用户在 retry 第二轮起手期间看到上一轮的旧 partial body。显式清掉。
    // `output` / `error` 已经显式覆盖，progress 同款语义补齐。
    get().upsertToolEventForSession(sessionId, {
      ...toolEvent,
      phase: 'start',
      error: null,
      output: undefined,
      progress: undefined,
      timestamp: Date.now(),
    })

    try {
      const args = (toolEvent.input && typeof toolEvent.input === 'object')
        ? toolEvent.input as Record<string, unknown>
        : {}

      let result: unknown
      const { hasRuntimeBridge, getSessionController } = await import('../services/agentService')
      if (hasRuntimeBridge()) {
        // contract W2-β: channel `agent-engine:retry-tool` 在 LEGACY_HANDLERS 内
        // → 走 ensureLegacyOk 主动转 throw（main 端迁 envelope 后 invokeIpc 自身
        // throw，本调用退化为 identity）。外层 try/catch 已捕获 throw 并写入 step error。
        const resp = await getSessionController(sessionId).retryTool(toolEvent.toolName, args)
        ensureLegacyOk(resp, 'Retry tool')
        result = (resp as { result?: unknown }).result
      } else {
        const chatExtraApi = await import('../services/chatExtraApi')
        const resp = await chatExtraApi.retryToolCall(sessionId, toolEvent.id, toolEvent.toolName, args)
        result = resp.result
      }

      get().upsertToolEventForSession(sessionId, {
        ...toolEvent,
        phase: 'end',
        error: null,
        output: result,
        // P0-2 同款语义：retry 完成时确保 progress 不残留——上一轮的 partial
        // 中间帧已无意义（新一轮已重启，旧帧绝对过期）。
        progress: undefined,
        timestamp: Date.now(),
      })
      get().updateAgentStepForSession(sessionId, stepId, { status: 'done' })
      return true
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Retry failed'
      get().upsertToolEventForSession(sessionId, {
        ...toolEvent,
        phase: 'error',
        error: errorMsg,
        progress: undefined,
        timestamp: Date.now(),
      })
      get().updateAgentStepForSession(sessionId, stepId, { status: 'error' })
      logger.warn('[ChatRuntime] retryTool failed:', err)
      return false
    }
  },

  // ── 助手事件（rAF 批量合并）────────────────────────────────

  upsertAssistantEventForSession: (sessionId, event) => {
    const prev = _pendingAssistants.get(sessionId) ?? get().assistantEventsBySessionId[sessionId] ?? []
    const next = [event, ...prev.filter(i => i.id !== event.id)].slice(0, 20)
    _pendingAssistants.set(sessionId, next)
    _scheduleBatchFlush()
  },

  resetAssistantDeltasForSession: (sessionId, runId) => {
    const keepFn = runId
      ? (e: AssistantEvent) => !(e.runId === runId && e.phase === 'delta')
      : (e: AssistantEvent) => e.phase !== 'delta'
    const pending = _pendingAssistants.get(sessionId)
    if (pending) {
      const filtered = pending.filter(keepFn)
      if (filtered.length > 0) {
        _pendingAssistants.set(sessionId, filtered)
      } else {
        _pendingAssistants.delete(sessionId)
      }
    }
    set(state => {
      const prev = state.assistantEventsBySessionId[sessionId]
      if (!prev || prev.length === 0) return {}
      return {
        assistantEventsBySessionId: {
          ...state.assistantEventsBySessionId,
          [sessionId]: prev.filter(keepFn),
        },
      }
    })
  },

  // ── 子 Agent ────────────────────────────────────────────────

  upsertSubagentRunForSession: (sessionId, run, options) => {
    set(state => {
      const prev = state.subagentRunsBySessionId[sessionId] ?? []
      const idx = findSubagentRunIndex(prev, run)
      if (
        idx >= 0
        && isTerminalSubagentStatus(prev[idx].status)
        && run.status !== undefined
        && run.status !== prev[idx].status
        && options?.allowRevive !== true
      ) {
        return {}
      }
      // v3.3 dogfood 修（"主卡片连接中"根因）：merge 时**跳过 undefined 字段**。
      //
      // 原 `{ ...prev, ...run }` 会用 run 里的 undefined 覆盖 prev 已填好的值。
      // 典型踩雷：SUBAGENT_COMPLETED 的 payload 不带 parent_tool_call_id，
      // subagentHandler 传 `parentToolCallId: strOpt(payload.parent_tool_call_id)`
      // = undefined，spread 后把 SUBAGENT_STARTED 填的 'agent:0' 覆盖成
      // undefined → useSubagentRuns 按 parentToolCallId 反查落空 → 聚合卡退回
      // "连接中" skeleton。
      //
      // 跳过 undefined 后，任何事件不带某字段时都保留之前的值（语义上"部分
      // 更新"才是 upsert 的本意）。reconcileSubagentRunsFromArchive 里那段
      // 手工"只补缺值"的规避（同一陷阱）因此也成了双保险。
      const definedRun: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(run)) {
        if (v === undefined) continue
        // `isOptimistic` 只属于渲染期合成的乐观占位（BlockTimeline.SubagentAggregateGroup），
        // 永不入 store——否则真实 run 被标记成乐观会让 drill-in/cancel 误禁用。
        // 这里显式剥离，作为「乐观标记不泄漏进 store」契约的兜底（即便未来某 handler
        // 误把渲染层对象 spread 进来）。
        if (k === 'isOptimistic') continue
        definedRun[k] = v
      }
      const merged: SubagentRun = {
        ...(idx >= 0 ? prev[idx] : { subagentRunId: run.subagentRunId, status: run.status }),
        ...(definedRun as Partial<SubagentRun>),
        updatedAt: Date.now(),
      }
      let next: SubagentRun[]
      if (idx >= 0) {
        next = [...prev]
        next[idx] = merged
      } else {
        next = [...prev, merged].slice(-200)
      }
      return {
        subagentRunsBySessionId: { ...state.subagentRunsBySessionId, [sessionId]: next },
      }
    })
  },

  markSubagentRunTerminalForSession: (sessionId, subagentRunId, status, source) => {
    set(state => {
      const prev = state.subagentRunsBySessionId[sessionId] ?? []
      const idx = prev.findIndex(run => run.subagentRunId === subagentRunId)
      if (idx < 0) {
        logger.debug('[ChatRuntime] subagent terminal ignored: run not found', {
          sessionId,
          subagentRunId,
          status,
          source,
        })
        return {}
      }

      const current = prev[idx]
      if (isTerminalSubagentStatus(current.status)) {
        return {}
      }
      if (!isActiveSubagentStatus(current.status)) {
        return {}
      }

      const next = [...prev]
      next[idx] = {
        ...current,
        status,
        endedAt: current.endedAt ?? Date.now(),
        updatedAt: Date.now(),
      }
      logger.debug('[ChatRuntime] subagent terminal converged', {
        sessionId,
        subagentRunId,
        status,
        source,
      })
      return {
        subagentRunsBySessionId: { ...state.subagentRunsBySessionId, [sessionId]: next },
      }
    })
  },

  clearSubagentRunsForSession: (sessionId) => {
    set(state => {
      const next = { ...state.subagentRunsBySessionId }
      delete next[sessionId]
      return { subagentRunsBySessionId: next }
    })
  },

  noteComposerStopWithBackgroundSubagents: (sessionId, count) => {
    if (count <= 0) {
      get().clearComposerStopBackgroundHint(sessionId)
      return
    }
    set((state) => ({
      composerStopBackgroundHintBySessionId: {
        ...state.composerStopBackgroundHintBySessionId,
        [sessionId]: count,
      },
    }))
  },

  clearComposerStopBackgroundHint: (sessionId) => {
    set((state) => {
      if (!(sessionId in state.composerStopBackgroundHintBySessionId)) return state
      const next = { ...state.composerStopBackgroundHintBySessionId }
      delete next[sessionId]
      return { composerStopBackgroundHintBySessionId: next }
    })
  },

  cancelSubagentRun: async (subagentRunId: string) => {
    // 定位该 run 所在的 sessionId——cancelled 落标 + daemon 托管会话的 WS
    // 上行都要用（subagent.cancel 上行 payload 需要 session_id 才能让 Django
    // 解析出 thread → 路由到绑定设备）。
    const findSessionId = (): string | undefined => {
      const bySession = get().subagentRunsBySessionId
      for (const [sid, runs] of Object.entries(bySession)) {
        if (runs.some(r => r.subagentRunId === subagentRunId)) return sid
      }
      return undefined
    }
    const markCancelled = (sid?: string) => {
      const targetSid = sid ?? findSessionId()
      if (targetSid) {
        get().upsertSubagentRunForSession(targetSid, { subagentRunId, status: 'cancelled', error: 'cancelled_by_user' })
      }
    }

    // W4c · W4b P1-b：标记 in-flight"取消中"——SubagentProgressCard 据此
    // 显示"取消中..."避免请求 in-flight 期间用户重复点 X。
    set(state => ({
      subagentCancellingByRunId: { ...state.subagentCancellingByRunId, [subagentRunId]: true },
    }))
    try {
      const sessionId = findSessionId()
      // 子 Agent 取消同样只走 agent-host IPC：本机命中由主进程直接取消；
      // 本机 miss 且有 sessionId 时，由主进程代发远端 `subagent.cancel`。
      if (window.tabtin?.agentEngine?.cancelSubagent) {
        const accepted = await window.tabtin.agentEngine.cancelSubagent(
          sessionId ? { childId: subagentRunId, sessionId } : subagentRunId,
        )
        if (accepted) {
          markCancelled(sessionId)
          return
        }
        logger.warn('[ChatRuntime] agent-host subagent.cancel 未成功:', {
          subagentRunId,
          sessionId,
        })
      } else {
        logger.warn('[ChatRuntime] cancelSubagentRun: agentEngine IPC unavailable', subagentRunId)
      }
    } catch (err) {
      logger.warn('[ChatRuntime] Failed to cancel subagent:', err)
    } finally {
      // 清 in-flight：(a) 服务端 ACK 后 markCancelled 走 status='cancelled'
      // 路径，UI 已通过 STATUS_CONFIG 切到"已取消"；(b) 失败 / 超时下也清
      // 让用户能再次重试。
      set(state => {
        const next = { ...state.subagentCancellingByRunId }
        delete next[subagentRunId]
        return { subagentCancellingByRunId: next }
      })
    }
  },

  reconcileSubagentRuns: async (sessionId, threadId) => {
    try {
      const chatExtraApi = await import('../services/chatExtraApi')
      const runs = await chatExtraApi.fetchSubagentRuns(threadId)
      for (const run of runs) {
        get().upsertSubagentRunForSession(sessionId, run)
      }
    } catch (err) {
      logger.warn('[ChatRuntime] reconcileSubagentRuns 失败:', err)
    }
  },

  reconcileSubagentRunsFromArchive: async (sessionId, options) => {
    // 父消息 blocks 补元数据；本地 subagents.jsonl 才是后台子代理在父轮结束后的终态源。
    // dispatch 回执不能盖 live active；jsonl / presentation_result 终态可以。
    let snapshots: SubagentRun[] = []
    try {
      const { useChatStore } = await import('./chat/useChatStore')
      const messages = useChatStore.getState().messagesBySessionId[sessionId] ?? []
      snapshots = deriveSubagentRunsFromMessages(messages)
    } catch (err) {
      logger.warn('[ChatRuntime] reconcileSubagentRunsFromArchive: derive failed', err)
    }
    try {
      const indexed = await loadIndexedSubagentSnapshots(sessionId, options)
      snapshots = [...snapshots, ...indexed]
    } catch (err) {
      logger.warn('[ChatRuntime] reconcileSubagentRunsFromArchive: index failed', err)
    }
    if (snapshots.length === 0) return
    try {
      for (const snapshot of snapshots) {
        applyArchiveSubagentSnapshot(
          sessionId,
          snapshot,
          get,
          (sid, run) => get().upsertSubagentRunForSession(sid, run),
        )
      }
    } catch (err) {
      logger.warn('[ChatRuntime] reconcileSubagentRunsFromArchive 异常:', err)
    }
  },

  // PRD §4.11 / §5：原 setActiveSubagentDrawer + loadSubagentSession 已搬到
  // 独立的 useSubagentSessionStore（仅 jsonl 三件套缓存），抽屉本体由
  // workbench `subagent_session` Context Tab 替代。

  // ── Run 生命周期 ────────────────────────────────────────────

  updateRunStateForSession: (sessionId, partial) => {
    const prev = _pendingRunStates.get(sessionId) ?? get().runStateBySessionId[sessionId] ?? { ...INITIAL_RUN_STATE }
    const next = { ...prev, ...partial }
    _pendingRunStates.set(sessionId, next)
    _scheduleBatchFlush()
  },

  setGroupRuntimeForSession: (sessionId, groupRuntime) => {
    set(state => ({
      groupRuntimeBySessionId: {
        ...state.groupRuntimeBySessionId,
        [sessionId]: groupRuntime,
      },
    }))
  },

  // ── Rich Content (流式展示) ────────────────────────────────

  appendRichContentBlocks: (sessionId, blocks) => {
    set(state => {
      const existing = state.richContentBlocksBySessionId[sessionId] ?? []
      return {
        richContentBlocksBySessionId: {
          ...state.richContentBlocksBySessionId,
          [sessionId]: [...existing, ...blocks],
        },
      }
    })
  },

  // Widget Wave 2.5：按 tool_call_id upsert——见 ChatRuntimeState.upsertRichContentBlocksByToolCallId 的 docstring。
  upsertRichContentBlocksByToolCallId: (sessionId, blocks) => {
    if (!Array.isArray(blocks) || blocks.length === 0) return
    set(state => {
      const existing = (state.richContentBlocksBySessionId[sessionId] ?? []) as Array<unknown>
      const next = existing.slice()
      let changed = false
      for (const incoming of blocks) {
        if (!incoming || typeof incoming !== 'object') {
          next.push(incoming)
          changed = true
          continue
        }
        const inc = incoming as Record<string, unknown>
        const incTcId = typeof inc.tool_call_id === 'string' ? inc.tool_call_id : null
        if (!incTcId) {
          next.push(incoming)
          changed = true
          continue
        }
        const idx = next.findIndex((b) => {
          if (!b || typeof b !== 'object') return false
          const r = b as Record<string, unknown>
          return r.tool_call_id === incTcId
        })
        if (idx >= 0) {
          // merge: 把 incoming 的字段合并到 existing 上（incoming 字段覆盖；
          // 比如 placeholder 的空 summary 被 final block 的真 summary 覆盖；
          // placeholder 的 widget_id `pending:xxx` 被 final 的 `wgt_xxx` 覆盖）
          const prev = next[idx] as Record<string, unknown>
          next[idx] = { ...prev, ...inc }
          changed = true
        } else {
          next.push(incoming)
          changed = true
        }
      }
      if (!changed) return state
      return {
        richContentBlocksBySessionId: {
          ...state.richContentBlocksBySessionId,
          [sessionId]: next,
        },
      }
    })
  },

  clearRichContentBlocks: (sessionId) => {
    set(state => {
      const { [sessionId]: _, ...rest } = state.richContentBlocksBySessionId
      return { richContentBlocksBySessionId: rest }
    })
  },

  // Widget Wave 3（RFC §五 3.6）：cancel/error/terminated 时 widget 保留 + 标记
  // interrupted；非 widget kind 沿用全清行为。see ChatRuntimeState docstring。
  markStreamingWidgetsInterruptedAndClearOthers: (sessionId, status) => {
    if (!sessionId) return
    set(state => {
      const existing = state.richContentBlocksBySessionId[sessionId]
      if (!existing || existing.length === 0) return state
      const next: unknown[] = []
      let changed = false
      const now = Date.now()
      for (const b of existing) {
        if (!b || typeof b !== 'object') {
          // 异常 block——丢弃保持兼容旧 clear 行为
          changed = true
          continue
        }
        const r = b as Record<string, unknown>
        if (r.kind !== 'widget') {
          // 非 widget kind（image / table_preview / file / resource_ref）→ 清空
          changed = true
          continue
        }
        // widget kind: 保留 + 标记 interrupted（幂等不覆盖已 mark 的）
        if (r.interrupted_at) {
          next.push(b)
          continue
        }
        // Widget Wave 3（技术 Review MEDIUM 修复）：已带 finalCode 的 widget
        // **不**标记 interrupted——这是 phase=end 正常完成场景：tool execute()
        // 完成后 emit RICH_CONTENT 已通过 upsert 把 placeholder 替换为
        // 带 finalCode 的 widget block。此时 lifecycle phase=end 触发本函数
        // 是正常路径，widget 不该被加 interrupted_at（前端 isInterrupted 防御
        // `!finalCode` 也能挡，但 store 状态干净更值得 — 避免 dev 调试时
        // 看到所有完成 widget 都是"中断的"假象）。
        const finalCodeStr = typeof r.code === 'string' ? r.code : ''
        if (finalCodeStr) {
          next.push(b)
          continue
        }
        // placeholder（无 finalCode）+ cancel/error/terminated/unknown → mark
        next.push({
          ...r,
          interrupted_at: now,
          interrupted_status: status,
        })
        changed = true
      }
      if (!changed) return state
      // 全部丢弃 → 删 key（与 clearRichContentBlocks 行为一致）
      if (next.length === 0) {
        const { [sessionId]: _, ...rest } = state.richContentBlocksBySessionId
        return { richContentBlocksBySessionId: rest }
      }
      return {
        richContentBlocksBySessionId: {
          ...state.richContentBlocksBySessionId,
          [sessionId]: next,
        },
      }
    })
  },

  // ── 附件上传取消 ──────────────────────────────────────────

  setUploadAbortController: (sessionId, controller) => {
    set(state => ({
      uploadAbortControllerBySessionId: {
        ...state.uploadAbortControllerBySessionId,
        [sessionId]: controller,
      },
    }))
  },

  abortUpload: (sessionId) => {
    const controller = get().uploadAbortControllerBySessionId[sessionId]
    if (controller) {
      controller.abort()
      set(state => {
        const next = { ...state.uploadAbortControllerBySessionId }
        delete next[sessionId]
        const nextProgress = { ...state.uploadProgressBySessionId }
        delete nextProgress[sessionId]
        return {
          uploadAbortControllerBySessionId: next,
          uploadProgressBySessionId: nextProgress,
        }
      })
    }
  },

  clearUploadAbortController: (sessionId) => {
    set(state => {
      const next = { ...state.uploadAbortControllerBySessionId }
      delete next[sessionId]
      return { uploadAbortControllerBySessionId: next }
    })
  },

  // ── 取消中状态 ──────────────────────────────────────────────

  setCancellingForSession: (sessionId, cancelling) => {
    set(state => {
      if (cancelling) {
        return { cancellingBySessionId: { ...state.cancellingBySessionId, [sessionId]: true } }
      }
      const next = { ...state.cancellingBySessionId }
      delete next[sessionId]
      return { cancellingBySessionId: next }
    })
  },

  // ── 失败消息编辑重发预填充 ─────────────────────────────────

  setPrefillForSession: (sessionId, content) => {
    set(state => ({
      pendingPrefillBySessionId: { ...state.pendingPrefillBySessionId, [sessionId]: content },
    }))
  },

  consumePrefillForSession: (sessionId) => {
    const raw = get().pendingPrefillBySessionId[sessionId]
    if (raw === undefined) return undefined
    set(state => {
      const next = { ...state.pendingPrefillBySessionId }
      delete next[sessionId]
      return { pendingPrefillBySessionId: next }
    })
    return normalizePrefill(raw)
  },

  // ── 用户主动停止后的二次编辑 ─────────────────────────────────

  setActiveSubmittedMessageForSession: (sessionId, snapshot) => {
    set(state => ({
      activeSubmittedMessageBySessionId: {
        ...state.activeSubmittedMessageBySessionId,
        [sessionId]: snapshot,
      },
    }))
  },

  clearActiveSubmittedMessage: (sessionId, clientMessageId) => {
    set(state => {
      const current = state.activeSubmittedMessageBySessionId[sessionId]
      if (!current || (clientMessageId && current.clientMessageId !== clientMessageId)) {
        return state
      }
      const next = { ...state.activeSubmittedMessageBySessionId }
      delete next[sessionId]
      return { activeSubmittedMessageBySessionId: next }
    })
  },

  moveActiveSubmittedMessageToInterruptedRecovery: (sessionId) => {
    const snapshot = get().activeSubmittedMessageBySessionId[sessionId]
    if (!snapshot) return undefined
    set(state => {
      const active = { ...state.activeSubmittedMessageBySessionId }
      delete active[sessionId]
      return {
        activeSubmittedMessageBySessionId: active,
        pendingInterruptedMessageBySessionId: {
          ...state.pendingInterruptedMessageBySessionId,
          [sessionId]: snapshot,
        },
      }
    })
    return snapshot
  },

  consumeInterruptedMessageRecovery: (sessionId) => {
    const snapshot = get().pendingInterruptedMessageBySessionId[sessionId]
    if (!snapshot) return undefined
    set(state => {
      const next = { ...state.pendingInterruptedMessageBySessionId }
      delete next[sessionId]
      return { pendingInterruptedMessageBySessionId: next }
    })
    return snapshot
  },

  discardInterruptedMessageRecovery: (sessionId) => {
    set(state => {
      if (!(sessionId in state.pendingInterruptedMessageBySessionId)) return state
      const next = { ...state.pendingInterruptedMessageBySessionId }
      delete next[sessionId]
      return { pendingInterruptedMessageBySessionId: next }
    })
  },

  // ── LLM Call Snapshots (Phase 3 · Debug Observability) ──

  pushSnapshotForSession: (sessionId, snapshot) => {
    set(state => {
      const prev = state.snapshotsBySessionId[sessionId] ?? []
      // 按 (runId, iteration) upsert：同一次 LLM 调用先后会收到两条快照——调用前（无
      // response）与调用后（带模型输出 response）。后到的覆盖前者，让面板同时呈现
      // 「输入上下文 + 本轮模型输出」，且不会因补发而把列表撑出重复项。
      const idx = prev.findIndex(
        s => s.runId === snapshot.runId && s.iteration === snapshot.iteration,
      )
      const merged = idx >= 0
        ? prev.map((s, i) => (i === idx ? snapshot : s))
        : [...prev, snapshot]
      const next = merged.slice(-20)
      return {
        snapshotsBySessionId: { ...state.snapshotsBySessionId, [sessionId]: next },
      }
    })
  },

  loadSnapshotsForSession: async (sessionId, ctx) => {
    if (get().snapshotsBySessionId[sessionId]?.length) return
    try {
      // ctx (spaceId/organizationId) 由 caller 提供。caller 没传时 main 进程
      // 自己有 in-memory live session fallback（this.sessions.get(sessionId)
      // 拿 spaceId/organizationId）+ _unscoped bucket 二级兜底——见
      // ElectronAgentHost.ts 'agent-engine:read-snapshots' handler 注释。
      // renderer 这里**不再**反向 import useChatStore / useOrganizationStore
      // 推导（避免 chat ↔ runtime 静态循环；推导职责本就属于 main 进程）。
      // contract W2-β：旧 envelope `{success, snapshots}` 改为 invokeIpc 直接返
      // `{ snapshots }` 或 throw。snapshots 是 inspector 用的诊断数据，IPC 失败时
      // 静默 swallow——inspector 自然展示空状态，不影响主流程。
      const result = await window.tabtin?.agentEngine?.readSnapshots?.(sessionId, ctx)
      if (Array.isArray(result?.snapshots) && result.snapshots.length > 0) {
        set(state => ({
          snapshotsBySessionId: {
            ...state.snapshotsBySessionId,
            [sessionId]: result.snapshots as LLMCallSnapshot[],
          },
        }))
      }
    } catch { /* IPC not available (e.g. web mode) or read failed — silent */ }
  },

  // ── Wave 3：模型能力降级 banner ────────────────────────────

  pushCapabilityBanner: (sessionId, banner) => {
    if (!sessionId) return
    set(state => {
      const prev = state.capabilityBannersBySessionId[sessionId] ?? []
      // 同 (kind, feature, fallback_to) 三元组重复时幂等：保留先到的 banner
      // 避免观察端 IPC + WS 双订阅、或同一轮 chunk 重复 emit 时 banner 倍增。
      const dup = prev.find(b =>
        b.kind === banner.kind
        && b.feature === banner.feature
        && b.fallback_to === banner.fallback_to,
      )
      if (dup) return state
      const next: CapabilityBanner = {
        ...banner,
        id: `cap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        receivedAt: Date.now(),
      }
      return {
        capabilityBannersBySessionId: {
          ...state.capabilityBannersBySessionId,
          [sessionId]: [...prev, next].slice(-10), // 防御：单 session 最多 10 条，避免极端场景内存膨胀
        },
      }
    })
  },

  dismissCapabilityBanner: (sessionId, bannerId) => {
    if (!sessionId || !bannerId) return
    set(state => {
      const prev = state.capabilityBannersBySessionId[sessionId]
      if (!prev || prev.length === 0) return state
      const filtered = prev.filter(b => b.id !== bannerId)
      if (filtered.length === prev.length) return state
      const nextMap = { ...state.capabilityBannersBySessionId }
      if (filtered.length === 0) {
        delete nextMap[sessionId]
      } else {
        nextMap[sessionId] = filtered
      }
      return { capabilityBannersBySessionId: nextMap }
    })
  },

  clearCapabilityBanners: (sessionId) => {
    if (!sessionId) return
    set(state => {
      if (!state.capabilityBannersBySessionId[sessionId]) return state
      const next = { ...state.capabilityBannersBySessionId }
      delete next[sessionId]
      return { capabilityBannersBySessionId: next }
    })
  },

  // ── Wave 4a · ContentBlock 时间轴 ──────────────────────────────
  //
  // 设计要点（v2 §3.5.1.b + W2 silent bypass 二代教训 + W4a 二轮 R1-P0/R3-P0）：
  // 1) **rAF batch**：高频路径（contentBlockDelta 1000 token/s）走
  //    `_pendingContentBlocks` Map 合并，每帧 flush 一次（同 _pendingTools 模式）。
  //    单帧内同 message 多事件读路径用 `_readPendingX` 双源 lookup 避免 race。
  // 2) **三层 shallow clone**：flush 时 `{ ...state.X, [sid]: { ...sessionMap, [mid]: newArr } }`
  //    — Zustand selector 触发重渲染的硬底线，缺一层 React 不会重渲染。
  // 3) **lastSeq 去重**：每条事件 entry 前 `seq <= prevSeq` 直接 return（drop）。
  // 4) **finalized 防御**（W4a R1-P0-1）：contentBlockDelta / Start 检测 entry.finalized=true
  //    时 log.warn 并 drop，避免 daemon retry attempt 2 重发污染已完成 block。
  // 5) **msgId 复用重置**（W4a R1-P0-2）：messageStart 检测 prevSeq>=0 视为重放，
  //    显式重置该 messageId 的 blocks 槽位（防 WS 重连续传两轮混在一起）。

  messageMetaBySessionId: {} as Record<string, Record<string, MessageMeta>>,
  contentBlocksLastSeqBySessionId: {} as Record<string, Record<string, number>>,

  messageStart: (sessionId, messageId, meta, seq) => {
    if (!sessionId || !messageId) return
    const state = get()
    const prevSeq = _readPendingLastSeq(sessionId, messageId, state)
    const prevMeta = _readPendingMeta(sessionId, messageId, state)

    // ── W4a 三轮 C-P0-1：replay 判定重写 ─────────────────────────────
    //
    // 三种到达形态：
    //   ① `prevSeq === -1`（首见）：正常 message_start → 走 init 路径。
    //   ② `seq > prevSeq`（新更大 seq）：
    //      - prevSeq >= 0 → daemon retry 跨 attempt 新 envelope state → 重置
    //      - prevSeq === -1 → 首见（被 ① 覆盖）
    //   ③ `seq <= prevSeq`（同/倒退 seq）：
    //      - prevMeta?.finalized === true → **WS 重连 replay**（同 envelope
    //        发完后又重传一遍，daemon 内 _seq 不变）→ **走重置路径**
    //      - prevMeta?.finalized === false → 真乱序/重复（daemon 没重发）→ drop
    //
    // 二轮的"prevSeq >= 0 即重置"判定漏了 case ③——WS 重连 replay 的 seq
    // 跟原 emit 完全一样（_seq 在 EnvelopeEmitter 实例属性，不重置），第一行
    // `if (seq <= prevSeq) return` 直接 drop 掉了重连后的重传 → 用户切重连前
    // 看到的内容会被永远卡在那一刻。本次按 finalized 状态判定 replay。
    const isWsReplay = seq <= prevSeq && prevMeta?.finalized === true
    const isRetryReset = seq > prevSeq && prevSeq >= 0
    const isReplay = isWsReplay || isRetryReset

    if (seq <= prevSeq && !isWsReplay) {
      // 真乱序/重复 —— drop（保留二轮行为）
      _droppedEventCount.seqDrop++
      logger.debug('[contentBlocks] seq drop (message_start)', {
        sessionId, messageId, seq, prevSeq, prevFinalized: prevMeta?.finalized,
      })
      return
    }

    if (isReplay) {
      _droppedEventCount.replayReset++
      logger.warn('[contentBlocks] message_start replay detected — resetting message slot', {
        sessionId, messageId, prevSeq, newSeq: seq,
        cause: isWsReplay ? 'ws_replay' : 'daemon_retry',
      })

      // ── W4a 三轮 C-P0-2：旁路状态同步清理 ─────────────────────────
      //
      // (a) widget streaming buffer——遍历当前 contentBlocks 中所有 tool_use 块的
      //     id，逐一清 buffer（attempt 1 写入的 partial_json 残留不能污染 attempt 2）
      const existingBlocks = _readPendingBlocks(sessionId, messageId, state)
      for (const entry of existingBlocks) {
        if (
          entry.block.type === 'tool_use'
          || entry.block.type === 'server_tool_use'
          || entry.block.type === 'mcp_tool_use'
        ) {
          const toolCallId = entry.block.id
          if (toolCallId) {
            clearToolCallArgsBufferByToolCallId(sessionId, toolCallId, 'turn_gc')
          }
        }
      }
      // (b) richContentBlocks placeholder——按 tool_use 块的 id 反查 richContent
      //     里的 widget placeholder 删除（避免 attempt 1 的 pending: 占位永远残留）
      const sessionRichBlocks = state.richContentBlocksBySessionId[sessionId] ?? []
      const toolCallIds = new Set(
        existingBlocks
          .filter(e => e.block.type === 'tool_use' || e.block.type === 'server_tool_use' || e.block.type === 'mcp_tool_use')
          .map(e => (e.block as { id?: string }).id)
          .filter((id): id is string => !!id),
      )
      if (sessionRichBlocks.length > 0 && toolCallIds.size > 0) {
        const filtered = sessionRichBlocks.filter(blk => {
          const obj = blk as Record<string, unknown>
          const tcid = obj.tool_call_id
          return !(typeof tcid === 'string' && toolCallIds.has(tcid))
        })
        if (filtered.length !== sessionRichBlocks.length) {
          set(s => ({
            richContentBlocksBySessionId: {
              ...s.richContentBlocksBySessionId,
              [sessionId]: filtered,
            },
          }))
        }
      }
    }

    _writePendingMeta(sessionId, messageId, { ...meta, finalized: false })
    _writePendingLastSeq(sessionId, messageId, seq)
    // 初始化 / 重置 contentBlocks 槽位：重放时清空，首次到达时空数组占位
    // 让下游 selector `state.contentBlocksBySessionId[sid]?.[mid] ?? []` 始
    // 终拿到稳定引用。
    if (isReplay || _readPendingBlocks(sessionId, messageId, state).length === 0) {
      _writePendingBlocks(sessionId, messageId, [])
    }
    _scheduleBatchFlush()

    // ── W4a-L23：长会话内存 trim（按 message_count 限额 200，trim batch 50）──
    //
    // 触发时机：messageStart 末尾——新增 message 后立刻检查；超阈值则 trim
    // 最早 50 个 finalized message。算法详见 `_trimContentBlocksLRU` docstring。
    //
    // 不触发条件：单 session message ≤ 250 时直接 noop（_trimContentBlocksLRU
    // 内部判定）—— 避免每次 messageStart 都做 O(n) 排序。
    //
    // 不影响 active streaming：trim 候选只取 finalized=true 的 message，本次
    // 新建的 message（finalized=false）不会被自己 trim。
    _trimContentBlocksLRU(sessionId)
  },

  messageDelta: (sessionId, messageId, delta, usage, seq) => {
    if (!sessionId || !messageId) return false
    const state = get()
    const prevSeq = _readPendingLastSeq(sessionId, messageId, state)
    if (seq <= prevSeq) {
      _droppedEventCount.seqDrop++
      logger.debug('[contentBlocks] seq drop (message_delta)', {
        sessionId, messageId, seq, prevSeq,
      })
      return false
    }
    const prevMeta = _readPendingMeta(sessionId, messageId, state)
    if (!prevMeta) {
      // message_delta 早于 message_start —— 理论不应发生（backend 保序）
      logger.warn('[contentBlocks] message_delta before message_start', { sessionId, messageId, seq })
      return false
    }
    // W4a 三轮 C-P0-3：message 层 finalized 防御——已 finalized 的 message 不能
    // 再被 delta 覆盖 stop_reason/usage（譬如 retry 重发 message_delta）。
    if (prevMeta.finalized) {
      _droppedEventCount.finalizedAfterStop++
      logger.warn('[contentBlocks] message_delta after finalize — drop', {
        sessionId, messageId, seq, deltaStopReason: delta.stop_reason,
      })
      _writePendingLastSeq(sessionId, messageId, seq) // seq 仍前进
      _scheduleBatchFlush()
      return false
    }
    const nextMeta: MessageMeta = {
      ...prevMeta,
      ...(delta.stop_reason !== undefined ? { stop_reason: delta.stop_reason } : {}),
      ...(delta.stop_sequence !== undefined ? { stop_sequence: delta.stop_sequence } : {}),
      ...(usage !== undefined ? { usage } : {}),
    }
    _writePendingMeta(sessionId, messageId, nextMeta)
    _writePendingLastSeq(sessionId, messageId, seq)

    // W4c · W4a-L24：abort 时显式清 widget toolCallArgsDelta buffer——避免
    // 长会话累积"未完成 widget 的 partial_json 残留"。原 GC 路径只走
    // stop/timeout，aborted 路径未触发，长 dogfood 后内存里挂着大量孤儿 buffer。
    //
    // 触发条件：本次 delta 把 stop_reason 改成 'aborted'（用户主动 cancel /
    // 上游 retry / lifecycle terminated）。
    if (delta.stop_reason === 'aborted') {
      const messageBlocks = _readPendingBlocks(sessionId, messageId, get())
      for (const entry of messageBlocks) {
        if (
          entry.block.type === 'tool_use'
          || entry.block.type === 'server_tool_use'
          || entry.block.type === 'mcp_tool_use'
        ) {
          const toolCallId = (entry.block as { id?: string }).id
          if (toolCallId && toolCallId !== TOOL_USE_PENDING_TOOL_CALL_ID) {
            clearToolCallArgsBufferByToolCallId(sessionId, toolCallId, 'turn_gc')
          }
        }
      }
    }

    _scheduleBatchFlush()
    return true
  },

  messageStop: (sessionId, messageId, seq, opts) => {
    if (!sessionId || !messageId) return
    const state = get()
    const prevSeq = _readPendingLastSeq(sessionId, messageId, state)
    if (seq <= prevSeq) {
      _droppedEventCount.seqDrop++
      logger.debug('[contentBlocks] seq drop (message_stop)', {
        sessionId, messageId, seq, prevSeq,
      })
      return
    }
    const prevMeta = _readPendingMeta(sessionId, messageId, state)
    // W4a 四轮 R4-7：message_stop 漏 finalized 防御（与 messageDelta /
    // contentBlockStart / contentBlockDelta / contentBlockStop 4 个 CRUD 对齐）。
    // 已 finalized 的 message 再来 message_stop —— retry / WS replay 重发场景，
    // 不能重复执行 finalize map（触发 rAF + 覆盖 persisted_id / blockIdOverrides
    // 走完整 deepClone 路径，浪费一次唤醒）。
    //
    // 不 hard return —— seq 仍前进，避免后续 silent drop；但 opts.persistedId
    // 是合法 reconcile 信号（W3 后端落库后回填真 UUID），允许覆盖。
    // blockIdOverrides 同理是 reconcile 信号，允许覆盖（但只覆盖 block_id，
    // 不再走 finalize / partial=true 链路，避免重复刷 rAF）。
    if (prevMeta?.finalized) {
      // W4a 五轮 R5-5：reconcile 路径走单独计数器（非 drop）—— DevPanel 把此值
      // 与 drop 系列分开显示，避免开发者把"W3 后端正常落库"误判为"daemon retry race"。
      _droppedEventCount.reconcileMessageStop++
      logger.debug('[contentBlocks] message_stop after finalize — reconcile-only', {
        sessionId, messageId, seq,
        hasPersistedId: !!opts?.persistedId,
        hasOverrides: !!opts?.blockIdOverrides,
      })
      // W4a 五轮 R5-8：first-persistedId-wins 守卫——已有 persisted_id 时只接受
      // 同值的 reconcile（daemon retry 重发同一 envelope 是合法的），不同 UUID
      // 是 daemon bug（譬如 retry 时不应换 UUID），drop + logger.error 告警，
      // 避免 React key 切换让 MessageBubble 整列重 mount。
      if (opts?.persistedId) {
        if (!prevMeta.persisted_id) {
          // 首次 reconcile：接受
          _writePendingMeta(sessionId, messageId, { ...prevMeta, persisted_id: opts.persistedId })
        } else if (prevMeta.persisted_id === opts.persistedId) {
          // 同值重发：noop（合法 daemon retry）
        } else {
          // 不同 UUID：daemon bug —— drop + error log + metric 自增（让 DevPanel 可见）
          _droppedEventCount.persistedIdConflict++
          logger.error('[contentBlocks] message_stop reconcile persistedId conflict — drop', {
            sessionId, messageId,
            existingPersistedId: prevMeta.persisted_id,
            incomingPersistedId: opts.persistedId,
            hint: 'daemon bug: retry must reuse the same persisted_id; React key churn would re-mount MessageBubble',
          })
        }
      }
      if (opts?.blockIdOverrides) {
        const overrides = opts.blockIdOverrides
        const blocks = _readPendingBlocks(sessionId, messageId, state)
        let changed = false
        const reconciled = blocks.map(entry => {
          const overrideId = overrides[String(entry.index)]
          if (overrideId && overrideId !== entry.block_id) {
            changed = true
            return { ...entry, block_id: overrideId }
          }
          return entry
        })
        if (changed) _writePendingBlocks(sessionId, messageId, reconciled)
      }
      _writePendingLastSeq(sessionId, messageId, seq)
      _scheduleBatchFlush()
      return
    }

    // 边角 case 3（v2 §3.5.1.b）：message_stop 时仍有 finalized=false 的 block
    // → 强制 finalize 所有 active block + 标 partial=true（UI 显示"…内容被截断"）
    // 同时按 opts.blockIdOverrides[String(index)] 替换 block_id（W3 后端落库后
    // 的真 UUID reconcile，避免流式 → 持久化瞬间 React key 切换导致整列重 mount）。
    //
    // W4c · W4a-L12：partialReason 区分"为何被打成 partial"——
    //   - 来自 abort 路径：之前的 message_delta(stop_reason='aborted') 已写
    //     prevMeta.stop_reason='aborted'，此处沿用打 'aborted'
    //   - 其他常规 message_stop 兜底：打 'message_stop_fallback'
    //   - watchdog 触发的 message_stop（来自 startContentBlockWatchdog）：通过
    //     opts.partialReason 显式传入 'stream_interrupted'，覆盖默认值
    const messageBlocks = _readPendingBlocks(sessionId, messageId, state)
    let blocksChanged = false
    const overrides = opts?.blockIdOverrides
    const inferredPartialReason: ContentBlockEntry['partialReason'] =
      opts?.partialReason
      ?? (prevMeta?.stop_reason === 'aborted' ? 'aborted' : 'message_stop_fallback')
    const finalizedBlocks = messageBlocks.map(entry => {
      const overrideId = overrides?.[String(entry.index)]
      let next = entry
      if (overrideId && overrideId !== entry.block_id) {
        blocksChanged = true
        next = { ...next, block_id: overrideId }
      }
      if (!next.finalized) {
        blocksChanged = true
        const finalEntry = applyFinalizeFallback(next)
        next = {
          ...finalEntry,
          finalized: true,
          partial: true,
          partialReason: inferredPartialReason,
          ...(next.startedAt != null && next.stoppedAt == null ? { stoppedAt: Date.now() } : {}),
        }
      }
      return next
    })

    // W4a-L27：messageStop 时兜底派生 text_summary —— 此时所有 block 都
    // finalized（含 messageStop 兜底强制 finalize 的 partial block），是最稳
    // 的派生时机。即使前面 contentBlockStop 已经增量更新过，这里再派生一次
    // 用 finalizedBlocks（含 partial=true 的 fallback 文本），保证 finalize 后
    // 的 text_summary 与 Django reassembler 落库的 ChatMessage.text_summary 一致。
    const summaryBlocks = blocksChanged ? finalizedBlocks : messageBlocks
    const text_summary = _deriveTextSummary(summaryBlocks)

    const nextMeta: MessageMeta = prevMeta
      ? {
          ...prevMeta,
          finalized: true,
          ...(opts?.persistedId ? { persisted_id: opts.persistedId } : {}),
          ...(text_summary ? { text_summary } : {}),
        }
      : {
          role: 'assistant',
          finalized: true,
          ...(opts?.persistedId ? { persisted_id: opts.persistedId } : {}),
          ...(text_summary ? { text_summary } : {}),
        }
    _writePendingMeta(sessionId, messageId, nextMeta)
    _writePendingLastSeq(sessionId, messageId, seq)
    if (blocksChanged) {
      _writePendingBlocks(sessionId, messageId, finalizedBlocks)
    }
    _scheduleBatchFlush()
  },

  contentBlockStart: (sessionId, messageId, index, blockId, block, seq) => {
    if (!sessionId || !messageId) return
    const state = get()
    const prevSeq = _readPendingLastSeq(sessionId, messageId, state)
    if (seq <= prevSeq) {
      _droppedEventCount.seqDrop++
      logger.debug('[contentBlocks] seq drop (block_start)', {
        sessionId, messageId, index, seq, prevSeq,
      })
      return
    }
    const messageBlocks = _readPendingBlocks(sessionId, messageId, state)
    const existing = messageBlocks.find(e => e.index === index)
    // W4a R1-P0-1：finalized block 防御——retry attempt 2 重新发 start 时
    // 不能覆盖已完成 block，drop + log.warn。
    if (existing?.finalized) {
      _droppedEventCount.finalizedAfterStop++
      logger.warn('[contentBlocks] content_block_start after finalize — drop', {
        sessionId, messageId, index, blockType: existing.block.type,
      })
      _writePendingLastSeq(sessionId, messageId, seq) // seq 仍前进，防重复处理
      _scheduleBatchFlush()
      return
    }
    // W4c · W4b-P1-1：thinking / tool_use family stamp startedAt——ThinkingBlockView
    // 用 (stoppedAt-startedAt) 显示 "Thought for Xs"。其他 type 不 stamp，避免
    // 给 22 case 全部 block 都增大 entry 体积（startedAt 是 optional 字段，
    // 缺失时 BlockRenderer 默认不显示秒数）。
    const blockType = (block as { type?: string })?.type
    const needsTimestamp =
      blockType === 'thinking'
      || blockType === 'redacted_thinking'
      || blockType === 'tool_use'
      || blockType === 'server_tool_use'
      || blockType === 'mcp_tool_use'
    // arrival_seq 权威来自 daemon emit:若 block 已带(handler 从 envelope
    // event.arrival_seq 挂入)则沿用,让实时与历史用同一组数字;缺失才回落本地微秒。
    const incomingArrival = (block as Record<string, unknown>)?.arrival_seq
    const arrivalBlock = {
      ...(block as Record<string, unknown>),
      arrival_seq: typeof incomingArrival === 'number' ? incomingArrival : Date.now() * 1_000 + seq,
      arrived_at: new Date().toISOString(),
    } as unknown as ContentBlock
    const newEntry: ContentBlockEntry = {
      index,
      block_id: blockId,
      block: arrivalBlock,
      finalized: false,
      partial: false,
      ...(needsTimestamp ? { startedAt: Date.now() } : {}),
    }
    let nextBlocks: ContentBlockEntry[]
    if (existing) {
      // ── W4a 三轮 A-P0-2：__pending__ placeholder 替换 → replay 暂存 fragments ──
      //
      // existing 是个 input_json_delta 早到时 lazy 创建的 placeholder（block.id
      // = '__pending__'），现在真 cb_start 到达带真 toolCallId。把 placeholder
      // 暂存的 partial_json fragments 一次性灌进真 toolCallId 的 widget buffer——
      // 早期 token 不丢，RichWidget 流式渲染连续。
      const existingBlock = existing.block as { type?: string; id?: string }
      const isPendingPlaceholder =
        (existingBlock.type === 'tool_use'
          || existingBlock.type === 'server_tool_use'
          || existingBlock.type === 'mcp_tool_use')
        && existingBlock.id === TOOL_USE_PENDING_TOOL_CALL_ID
      if (isPendingPlaceholder) {
        const pendingFragments = existing._pendingInputJsonFragments ?? []
        const newToolUse = block as { type?: string; id?: string; name?: string }
        if (
          (newToolUse.type === 'tool_use'
            || newToolUse.type === 'server_tool_use'
            || newToolUse.type === 'mcp_tool_use')
          && newToolUse.id
          && newToolUse.id !== TOOL_USE_PENDING_TOOL_CALL_ID
          && pendingFragments.length > 0
        ) {
          replayPendingInputJsonFragments(
            sessionId,
            newToolUse.id,
            newToolUse.name ?? '',
            pendingFragments,
          )
        }
      } else {
        // "start 重发" / 乱序到达 → 覆盖（理论不应发生，记 warn）
        logger.warn('[contentBlocks] content_block_start duplicate for index', { sessionId, messageId, index })
      }
      // 替换 entry —— newEntry 自动清掉 _pendingInputJsonFragments（newEntry 未带）
      nextBlocks = messageBlocks.map(e => (e.index === index ? newEntry : e))
    } else {
      nextBlocks = [...messageBlocks, newEntry].sort((a, b) => a.index - b.index)
    }
    _writePendingBlocks(sessionId, messageId, nextBlocks)
    _writePendingLastSeq(sessionId, messageId, seq)
    _scheduleBatchFlush()
  },

  contentBlockDelta: (sessionId, messageId, index, delta, seq) => {
    if (!sessionId || !messageId) return
    const state = get()
    const prevSeq = _readPendingLastSeq(sessionId, messageId, state)
    if (seq <= prevSeq) {
      // W4a R3-P1-6：seq 倒退 silent drop 改成 log.debug——开发期排查"为啥
      // 文字突然不显示"时这一行是关键线索。生产构建 logger.debug 默认静音。
      _droppedEventCount.seqDrop++
      logger.debug('[contentBlocks] seq drop (block_delta)', {
        sessionId, messageId, index, seq, prevSeq, deltaType: delta.type,
      })
      return
    }
    const messageBlocks = _readPendingBlocks(sessionId, messageId, state)
    let entryIdx = messageBlocks.findIndex(e => e.index === index)
    let nextBlocks: ContentBlockEntry[]
    if (entryIdx < 0) {
      // 边角 case 2（v2 §3.5.1.b）：delta 早于 start → lazy 创建空壳兜底
      logger.warn('[contentBlocks] content_block_delta before start (lazy-create)', {
        sessionId, messageId, index, deltaType: delta.type,
      })
      const placeholder = createPlaceholderForDelta(delta, index, messageId)
      nextBlocks = [...messageBlocks, placeholder].sort((a, b) => a.index - b.index)
      entryIdx = nextBlocks.findIndex(e => e.index === index)
    } else {
      // W4a R1-P0-1：finalized block 防御——daemon retry attempt 2 重发 delta
      // 时，已完成 block 不能被污染（"Hello" 被刷成 "Helloattempt2content"）。
      if (messageBlocks[entryIdx].finalized) {
        _droppedEventCount.finalizedAfterStop++
        logger.warn('[contentBlocks] content_block_delta after finalize — drop', {
          sessionId, messageId, index, deltaType: delta.type,
        })
        _writePendingLastSeq(sessionId, messageId, seq) // seq 仍前进
        _scheduleBatchFlush()
        return
      }
      nextBlocks = messageBlocks.slice()
    }
    const target = nextBlocks[entryIdx]

    // ── W4a 三轮 A-P0-2：__pending__ placeholder 的 input_json_delta 暂存 ──
    //
    // placeholder 的 block.id 是 sentinel，不是真 toolCallId——把 partial_json
    // 累积到 entry._pendingInputJsonFragments 等待 cb_start 替换时 replay。
    // applyDeltaToEntry 同时把 partial_json 累到 entry.pendingInputJson（用于
    // finalize 时 JSON.parse 兜底；replace 路径 newEntry 自动清空）。
    const targetBlock = target.block as { type?: string; id?: string }
    const isPendingPlaceholder =
      (targetBlock.type === 'tool_use'
        || targetBlock.type === 'server_tool_use'
        || targetBlock.type === 'mcp_tool_use')
      && targetBlock.id === TOOL_USE_PENDING_TOOL_CALL_ID
    if (isPendingPlaceholder && delta.type === 'input_json_delta') {
      const fragments = [...(target._pendingInputJsonFragments ?? []), delta.partial_json]
      const updated: ContentBlockEntry = {
        ...applyDeltaToEntry(target, delta), // 继续累积 pendingInputJson 兜底
        _pendingInputJsonFragments: fragments,
      }
      nextBlocks[entryIdx] = updated
      _writePendingBlocks(sessionId, messageId, nextBlocks)
      _writePendingLastSeq(sessionId, messageId, seq)
      _scheduleBatchFlush()
      return
    }

    const merged = applyDeltaToEntry(target, delta)
    // W4a R3-P1-5：delta 类型与目标 block 类型错配时（譬如 text_delta 撞 tool_use），
    // applyDeltaToEntry 返回原 entry。此时如果继续写 pending 会触发空 setState、
    // 唤醒所有 subscriber（含 ChatPanel 重渲染）。引用相等短路掉。
    if (merged === target) {
      _writePendingLastSeq(sessionId, messageId, seq) // seq 仍前进，避免后续 silent drop
      return
    }
    nextBlocks[entryIdx] = merged
    _writePendingBlocks(sessionId, messageId, nextBlocks)
    _writePendingLastSeq(sessionId, messageId, seq)
    _scheduleBatchFlush()
  },

  contentBlockStop: (sessionId, messageId, index, seq) => {
    if (!sessionId || !messageId) return
    const state = get()
    const prevSeq = _readPendingLastSeq(sessionId, messageId, state)
    if (seq <= prevSeq) {
      _droppedEventCount.seqDrop++
      logger.debug('[contentBlocks] seq drop (block_stop)', { sessionId, messageId, index, seq, prevSeq })
      return
    }
    const messageBlocks = _readPendingBlocks(sessionId, messageId, state)
    const entryIdx = messageBlocks.findIndex(e => e.index === index)
    if (entryIdx < 0) {
      // content_block_stop 早于 start → 理论不应发生；记 warn 不抛错
      logger.warn('[contentBlocks] content_block_stop without matching start', { sessionId, messageId, index })
      return
    }
    const target = messageBlocks[entryIdx]
    // W4a 三轮 C-P0-3：entry 层 finalized 防御——已 finalized 的 entry 再来
    // content_block_stop（理论不应发生，但 retry 路径可能撞），noop 即可，
    // 但仍前进 seq 防后续 silent drop。
    if (target.finalized) {
      _droppedEventCount.finalizedAfterStop++
      logger.debug('[contentBlocks] content_block_stop after finalize — noop', {
        sessionId, messageId, index, blockType: target.block.type,
      })
      _writePendingLastSeq(sessionId, messageId, seq)
      _scheduleBatchFlush()
      return
    }
    // 边角 case 1（v2 §3.5.1.b）：tool_use 块的 pendingInputJson 在这里 JSON.parse
    // W4c · W4b-P1-1：stamp stoppedAt，ThinkingBlockView 据此算 "Thought for Xs"
    const finalEntry: ContentBlockEntry = {
      ...applyFinalizeFallback(target),
      finalized: true,
      ...(target.startedAt != null ? { stoppedAt: Date.now() } : {}),
    }
    const nextBlocks = messageBlocks.slice()
    nextBlocks[entryIdx] = finalEntry
    _writePendingBlocks(sessionId, messageId, nextBlocks)
    _writePendingLastSeq(sessionId, messageId, seq)

    // ── W4a-L27：text 块 finalize 时增量更新 text_summary ──────────────
    //
    // 仅 text 块 finalize 时派生（其他 block 类型变化不影响摘要值；占位文案
    // 由 messageStop 兜底派生）—— 把派生开销控制在"text block 数量 × 200 字
    // 截取"，长会话 100 messages × 5 text blocks = 500 次派生 < 1ms。
    //
    // 流式期间增量更新让会话列表预览不再空白：用户切走 active session 看其
    // 他列表时，已 finalize 的 text 内容立刻可见。messageStop 还会再兜底派
    // 生一次（含 partial fallback 文本），保证 finalize 后值与 Django 落库
    // 一致。
    const finalBlockType = (finalEntry.block as { type?: string })?.type
    if (finalBlockType === 'text') {
      const prevMeta = _readPendingMeta(sessionId, messageId, state)
      if (prevMeta) {
        const text_summary = _deriveTextSummary(nextBlocks)
        if (text_summary && text_summary !== prevMeta.text_summary) {
          _writePendingMeta(sessionId, messageId, { ...prevMeta, text_summary })
        }
      }
    }

    _scheduleBatchFlush()
  },

  clearContentBlocksForSession: (sessionId) => {
    if (!sessionId) return
    //  阶段 6：内容块已迁至 messages 层，单独清。
    getContentBlocksBridge()?.clearSession(sessionId)
    set(state => {
      const next: Record<string, unknown> = {}
      let changed = false
      if (state.messageMetaBySessionId[sessionId]) {
        const map = { ...state.messageMetaBySessionId }
        delete map[sessionId]
        next.messageMetaBySessionId = map
        changed = true
      }
      if (state.contentBlocksLastSeqBySessionId[sessionId]) {
        const map = { ...state.contentBlocksLastSeqBySessionId }
        delete map[sessionId]
        next.contentBlocksLastSeqBySessionId = map
        changed = true
      }
      return changed ? (next as Partial<ChatRuntimeState>) : state
    })
  },

  // ── 生命周期 ──────────────────────────────────────────────

  evictSession: (sessionId) => {
    _clearSessionFromBatch(sessionId)
    //  阶段 6：内容块已迁至 messages 层，随 session evict 一并清。
    getContentBlocksBridge()?.clearSession(sessionId)

    const controller = get().uploadAbortControllerBySessionId[sessionId]
    if (controller && !controller.signal.aborted) controller.abort()

    set(state => {
      const partial: Record<string, unknown> = {}
      for (const key of RUNTIME_SESSION_KEYS) {
        const map = state[key] as Record<string, unknown> | undefined
        if (map && sessionId in map) {
          const next = { ...map }
          delete next[sessionId]
          partial[key] = next
        }
      }
      return partial as Partial<ChatRuntimeState>
    })

    // W1c: speaker 身份数据随 session 一起清理，防止内存泄漏
    import('./useSpeakerRegistryStore').then(({ useSpeakerRegistryStore }) => {
      useSpeakerRegistryStore.getState().clearForSession(sessionId)
    }).catch(() => { /* store 尚未加载时静默忽略 */ })

    // PRD §4.17 / 红线 #6：subagentSession（独立 store）随父 session 一起清，
    // 避免父 session 走完但 jsonl 三件套缓存仍占内存 + 隐私残留
    import('./subagentSession').then(({ useSubagentSessionStore }) => {
      useSubagentSessionStore.getState().clearByParentSession(sessionId)
    }).catch(() => {})
  },

  evictSessionBatch: (sessionIds) => {
    for (const id of sessionIds) _clearSessionFromBatch(id)
    //  阶段 6：内容块随 session 一并清（messages 层）。
    const _bridge = getContentBlocksBridge()
    if (_bridge) for (const id of sessionIds) _bridge.clearSession(id)

    const controllerMap = get().uploadAbortControllerBySessionId
    for (const id of sessionIds) {
      const controller = controllerMap[id]
      if (controller && !controller.signal.aborted) controller.abort()
    }

    const idSet = new Set(sessionIds)
    set(state => {
      const partial: Record<string, unknown> = {}
      for (const key of RUNTIME_SESSION_KEYS) {
        const map = state[key] as Record<string, unknown> | undefined
        if (!map) continue
        const hasAny = sessionIds.some(id => id in map)
        if (!hasAny) continue
        const next = { ...map }
        for (const id of idSet) delete next[id]
        partial[key] = next
      }
      return partial as Partial<ChatRuntimeState>
    })

    // W1c: speaker 身份数据随 session 一起清理
    import('./useSpeakerRegistryStore').then(({ useSpeakerRegistryStore }) => {
      for (const id of sessionIds) {
        useSpeakerRegistryStore.getState().clearForSession(id)
      }
    }).catch(() => {})

    // PRD §4.17：批量也同步清理 subagentSession 缓存
    import('./subagentSession').then(({ useSubagentSessionStore }) => {
      const store = useSubagentSessionStore.getState()
      for (const id of sessionIds) store.clearByParentSession(id)
    }).catch(() => {})
  },

  reset: () => {
    _clearAllBatch()
    set({ ...INITIAL_RUNTIME_STATE })
    // logout / organization 切换：subagentSession 缓存全清（PRD §4.17）
    import('./subagentSession').then(({ useSubagentSessionStore }) => {
      useSubagentSessionStore.getState().clear()
    }).catch(() => {})
  },
}))

// Organization 切换/登出时清理所有运行时瞬态数据
import { registerResetAction } from './sessionResetRegistry'
registerResetAction('chat-runtime', 'reset', () => useChatRuntimeStore.getState().reset())

//  阶段 6：内容块的响应式读取（旧 useContentBlocks / per-(sid,mid) listener）
// 已迁至 messages 层——见 `stores/chat/messageBlocks.ts` 的 `useMessageBlocksById`
// （单消息）与 `useSessionBlocksRecord`（跨消息）。runtime store 不再持有内容块
// 存储与订阅机制。

// ── W4a 四轮 R4-12：自动启动 watchdog（守门强化）─────────────────────────
//
// 生产环境 module load 时立刻启动；test 环境跳过避免 setInterval 跨测试串扰。
//
// 守门策略——三层叠加，任何一层判定为"非真用户运行环境"就跳过：
//   1. **typeof window === 'undefined'**：跳过 nodejs SSR / daemon 进程
//   2. **import.meta.env.MODE === 'test'**：vite 静态编译时替换字面量，
//      vitest 自动设置 MODE='test'。这层 Electron renderer + jsdom + vitest
//      全场景生效，不依赖 process.env runtime 可见性（contextIsolation /
//      sandbox 全开时 process 对象在 renderer 可能是 {}，三轮的
//      `process.env.VITEST === 'true'` 守门会失效）
//   3. **process?.env?.VITEST**：兜底——storybook / 手动 jsdom / Node test
//      runner 入口绕过 vite 的场景仍能捕获，避免漏网
const __isTestEnv =
  (typeof import.meta !== 'undefined' && import.meta?.env?.MODE === 'test')
  || (typeof process !== 'undefined' && process?.env?.VITEST === 'true')
  || (typeof process !== 'undefined' && process?.env?.NODE_ENV === 'test')

if (typeof window !== 'undefined' && !__isTestEnv) {
  // ：contentBlock watchdog 仅定时扫静默消息并 reconcile，无额外依赖注入。
  startContentBlockWatchdog(() => useChatRuntimeStore.getState())
}

// ---------------------------------------------------------------------------
// 依赖倒置：把运行时 store 访问注入 agentService 的 leaf 注册表，
// 让 hub 不反向静态 import 本 store（方向恒为 store → hub）。本模块被 useChatStore
// 静态 import（app 启动即加载），注册早于任何用户触发的 attachStream / 后台 push。
// ---------------------------------------------------------------------------
runtimeStoreAccess.registerAccess({
  // zustand getState/setState 与 StreamHandler 读写签名运行时同引用，TS 下 cast。
  get: () => useChatRuntimeStore.getState() as unknown as StreamHandlerStore,
  set: useChatRuntimeStore.setState as unknown as StreamHandlerDeps['set'],
  flushRuntimeBatch,
  reconcileSubagentRunsFromArchive: (sessionId, options) =>
    useChatRuntimeStore.getState().reconcileSubagentRunsFromArchive(sessionId, options),
})
