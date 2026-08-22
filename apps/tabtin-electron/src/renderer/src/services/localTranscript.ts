/**
 * localTranscript ——  本机会话正文权威读取。
 *
 * 冷启动后，本机会话（盘上有非空 messages.jsonl）的对话正文以主进程 runtime
 * transcript 为**唯一权威**，不再被 Django DB 的滞后投影覆盖。本模块负责：
 *   1. 判据探盘 `hasLocalTranscript`——冷启动靠主进程探盘 messages.jsonl 区分本机会话
 *      与观察端；热路径按内容态保留未落库消息，不再依赖内存态来源标志。
 *   2. 读 + 薄适配 `readLocalTranscript`——把主进程重建的
 *      ReconstructedTranscriptMessage[]（messages.jsonl 6 件套重放）转成
 *      ChatMessage[]，交给现有冷路径（setSessionMessages →
 *      hydrateSessionBlocksFromJson）渲染。
 *
 * 适配只做「让 runtime 投影长得和 DB 冷消息一样」：产出 content_blocks_json，
 * 由 hydrate 建 `message.blocks`；并把 tool_result 块并回其 tool_use 所在
 * 消息（与 daemon reassembler / 主对话 BlockTimeline 同 message 配对口径一致）。
 */

import type { ChatMessage, MessageBlock } from '@tabtin/chat-client'
import {
  buildIdentityIndex,
  findByIdentity,
} from '@/stores/chat/domain/messageIdentity'
import {
  appendMissingUserMediaBlocks,
  isUserNonTextPreservedBlock,
} from '@/stores/chat/domain/userMediaMerge'
import { preferServerDisplayContent } from '@/stores/chat/domain/preferServerDisplayContent'

/** 主进程 read-session-transcript 返回的单条消息（跨 IPC 结构化克隆）。 */
export interface ReconstructedTranscriptMessage {
  role: 'user' | 'assistant' | 'system'
  /**
   * 本轮实际执行的 Agent（可选）。
   * 冷读徽章也可由 DB enrich 补齐。
   */
  agentId?: string
  /** user 消息真实发送者（本地 transcript 真源）。 */
  senderUserId?: string
  messageId?: string
  blocks: MessageBlock[]
  arrivalSeq?: number
  subagentRunId?: string
  messageKind?: string
  stopReason?: string
  timestamp?: string
  /** 触发来源（push-notification 等）；据此还原收敛卡（isPushNotificationMessage）。 */
  triggeredBy?: string
  /** 非正文 metadata（hitl 面板事实等）——冷读透出让 reconcile 恢复面板 / 状态。 */
  metadata?: Record<string, unknown>
  /** 终态错误结构化真相；空正文错误也必须保留。 */
  errorInfoJson?: Record<string, unknown>
}

interface SessionContext {
  spaceId?: string
  organizationId?: string
}

function getBridge(): NonNullable<typeof window.tabtin>['agentEngine'] | undefined {
  if (typeof window === 'undefined') return undefined
  return window.tabtin?.agentEngine
}

/** 判据探盘：该会话盘上是否有非空 messages.jsonl（本机会话 vs 观察端）。 */
export async function hasLocalTranscript(
  sessionId: string,
  ctx?: SessionContext,
): Promise<boolean> {
  const bridge = getBridge()
  if (!bridge?.hasLocalTranscript) return false
  const res = await bridge.hasLocalTranscript(sessionId, ctx)
  return res.success === true && res.hasLocal === true
}

/**
 * ：云端 fork 成功后，同步分叉本机 SessionStorage。
 * 失败不抛——云端已成功时本机缺失可回落 DB；调用方仅打日志。
 */
export async function forkLocalSessionArchive(
  sourceSessionId: string,
  newSessionId: string,
  ctx?: SessionContext & {
    forkAnchorMessageId?: string
    toolIdRemap?: Record<string, string>
  },
): Promise<{
  copied: boolean
  skipped: boolean
  remappedToolIds: number
  truncatedAtForkPoint: boolean
} | null> {
  const bridge = getBridge()
  if (!bridge?.forkLocalSession) return null
  const res = await bridge.forkLocalSession({
    sourceSessionId,
    newSessionId,
    spaceId: ctx?.spaceId,
    organizationId: ctx?.organizationId,
    forkAnchorMessageId: ctx?.forkAnchorMessageId,
    toolIdRemap: ctx?.toolIdRemap,
  })
  if (res.success !== true) return null
  return {
    copied: res.copied === true,
    skipped: res.skipped === true,
    remappedToolIds: res.remappedToolIds ?? 0,
    truncatedAtForkPoint: res.truncatedAtForkPoint === true,
  }
}

/**
 * 读本机 transcript 并薄适配成 ChatMessage[]。返回 null 表示无本地数据（调用方
 * 回落 DB 只读）。
 */
export async function readLocalTranscript(
  sessionId: string,
  ctx?: SessionContext,
): Promise<ChatMessage[] | null> {
  const bridge = getBridge()
  if (!bridge?.readSessionTranscript) return null
  const res = await bridge.readSessionTranscript(sessionId, ctx)
  if (res.success !== true || !Array.isArray(res.messages)) return null
  return adaptTranscriptToChatMessages(res.messages as ReconstructedTranscriptMessage[], sessionId)
}

function isToolResultBlock(block: MessageBlock): boolean {
  const type = (block as { type?: string }).type
  return type === 'tool_result' || type === 'mcp_tool_result'
}

function isToolUseBlock(block: MessageBlock): boolean {
  const type = (block as { type?: string }).type
  return type === 'tool_use' || type === 'server_tool_use' || type === 'mcp_tool_use'
}

function textOf(blocks: MessageBlock[]): string {
  return blocks
    .filter((b) => (b as { type?: string }).type === 'text')
    .map((b) => (b as { text?: string }).text ?? '')
    .join('\n')
}

/**
 * 纯函数：ReconstructedTranscriptMessage[] → ChatMessage[]。
 *
 * - content_blocks_json 直接用重建出的 native 块（tool_use.input 已 parse）；
 *   hydrateSessionBlocksFromJson 会据此建 message.blocks。
 * - tool_result 块并回**首个尚未配对**的同 tool_use_id 消息（跨轮同 id FIFO），
 *   与 daemon 冷消息「tool_use + tool_result 同 message」一致；承载它但自身
 *   变空的 user 消息被丢弃，避免工具调用间冒出空气泡。
 * - created_at 取 timestamp，缺失时向前继承上一条，保证时间线顺序稳定。
 */
export function adaptTranscriptToChatMessages(
  reconstructed: ReconstructedTranscriptMessage[],
  sessionId: string,
): ChatMessage[] {
  const messages: ChatMessage[] = reconstructed.map((rm, idx) => {
    const id = rm.messageId && rm.messageId.length > 0 ? rm.messageId : `local-${sessionId}-${idx}`
    return {
      id,
      role: rm.role,
      ...(rm.agentId ? { agent_id: rm.agentId } : {}),
      ...(rm.senderUserId ? { sender_user_id: rm.senderUserId } : {}),
      content: textOf(rm.blocks),
      content_blocks_json: rm.blocks.slice(),
      created_at: rm.timestamp ?? '',
      ...(rm.messageKind ? { message_kind: rm.messageKind as ChatMessage['message_kind'] } : {}),
      ...(rm.stopReason ? { stop_reason: rm.stopReason } : {}),
      ...(rm.errorInfoJson ? { error_info_json: rm.errorInfoJson } : {}),
      ...(rm.subagentRunId ? { subagent_run_id: rm.subagentRunId } : {}),
      // 非正文 metadata 合并：重建记录自带的 metadata（hitl 面板事实等）+ 触发来源
      // （push-notification → metadata.triggered_by，让 isPushNotificationMessage 命中，
      // 重载后 push 通知渲染成收敛卡；hitl_interaction → metadata.hitl 驱动面板恢复）。
      ...(rm.metadata || rm.triggeredBy
        ? { metadata: { ...(rm.metadata ?? {}), ...(rm.triggeredBy ? { triggered_by: rm.triggeredBy } : {}) } }
        : {}),
    }
  })

  relocateToolResults(messages)

  // created_at 向前继承：缺失时用上一条时间（保序）；全缺则给单调递增兜底。
  let last = ''
  messages.forEach((m, idx) => {
    if (!m.created_at) m.created_at = last || new Date(idx).toISOString()
    last = m.created_at
  })

  // 丢弃只承载 tool_result（已并回工具卡）而自身变空的 user 消息。
  return messages.filter((m) => {
    if (m.role !== 'user') return true
    const hasBlocks = (m.content_blocks_json?.length ?? 0) > 0
    return hasBlocks
  })
}

/** 把 tool_result 块从其所在消息移动到匹配的 tool_use 消息（FIFO 配对）。 */
function relocateToolResults(messages: ChatMessage[]): void {
  for (const carrier of messages) {
    const blocks = carrier.content_blocks_json
    if (!blocks || blocks.length === 0) continue
    const remaining: MessageBlock[] = []
    for (const block of blocks) {
      if (!isToolResultBlock(block)) {
        remaining.push(block)
        continue
      }
      const toolUseId = (block as { tool_use_id?: string }).tool_use_id
      if (!toolUseId || !attachToolResult(messages, toolUseId, block)) {
        // 找不到发起它的 tool_use（乱序 / id 不匹配）：保留在原地，至少不丢数据。
        remaining.push(block)
      }
    }
    carrier.content_blocks_json = remaining
  }
}

/**
 * 非正文增强字段：DB 作为「AI 存储」承载的计费 / checkpoint / 模型元信息。
 *
 * 本机会话正文以 runtime transcript 为准，但这些字段 transcript 不落盘、
 * 本就产于 DB（usage 由 done payload、checkpoint 由 Celery 异步写 SpaceCheckpoint、
 * model 快照落库），故按 identity 从 DB 行补到以 runtime 为准的消息上。
 *
 * **刻意不含**正文字段（content / role / message_kind / stop_reason 等）——那些是
 * runtime 权威。例外：image/file/video **附件块**可从 DB 补入——
 *  文本降级时 message-blocks 只落了正文，附件元数据在 Django
 * content_blocks_json，切会话后若不补回视频缩略图会消失。
 */
const SERVER_ENHANCEMENT_FIELDS = [
  'usage_json',
  'checkpoint_hash',
  'checkpoint_state_index',
  'checkpoint_record',
  'diff_summary',
  'checkpoint_anchor_block_id',
  'checkpoint_anchor_block_index',
  'model_id',
  'model_name',
  'model_name_snapshot',
  'agent_run_id',
  'error_code',
  'error_info_json',
  'sender_user_id',
  'sender_display_name',
  'reply_to_message_id',
  'reply_to_preview',
] as const

/** 读 metadata.hitl（面板事实：kind/request_key/status/...）；非 hitl 消息返回 undefined。 */
function readHitl(metadata: unknown): (Record<string, unknown> & { status?: string }) | undefined {
  if (!metadata || typeof metadata !== 'object') return undefined
  const hitl = (metadata as Record<string, unknown>).hitl
  if (!hitl || typeof hitl !== 'object' || Array.isArray(hitl)) return undefined
  return hitl as Record<string, unknown> & { status?: string }
}

/**
 * 本机 transcript 缺用户可见块时，从 DB content_blocks_json 补
 * image/file/video + 全部 ContextRef。
 * 不改动 text / tool 等正文块，也不新增 DB-only 消息。
 */
function mergeMissingMediaBlocksFromServer(
  local: ChatMessage,
  server: ChatMessage,
): ChatMessage | undefined {
  if (local.role !== 'user' || server.role !== 'user') return undefined
  const serverBlocks = Array.isArray(server.content_blocks_json)
    ? server.content_blocks_json
    : []
  const serverPreserved = serverBlocks.filter(isUserNonTextPreservedBlock)
  if (serverPreserved.length === 0) return undefined

  const localBlocks = Array.isArray(local.content_blocks_json)
    ? [...local.content_blocks_json]
    : []
  const { blocks, added } = appendMissingUserMediaBlocks(localBlocks, serverPreserved)
  if (!added) return undefined
  return {
    ...local,
    content_blocks_json: blocks as ChatMessage['content_blocks_json'],
  }
}

/**
 * 用 DB 行的非正文增强字段补齐以 runtime 为准的本机消息（正文不动、不增删消息）。
 *
 * - 匹配口径：messageIdentity 正典（id / client_* / metadata.message_id）。
 * - 只在 server 有值且与 local 不同才写；不引入 DB-only 消息（观察端才用 DB 全集）。
 * - 返回同一引用（无变更时）或全新数组（有变更），便于调用方判断是否需要重设。
 */
export function enrichWithServerMetadata(
  local: ChatMessage[],
  server: readonly ChatMessage[],
): ChatMessage[] {
  if (server.length === 0 || local.length === 0) return local
  const index = buildIdentityIndex(server)
  let changed = false
  const out = local.map((m) => {
    const matched = findByIdentity(index, m)
    if (!matched) return m
    const matchedRec = matched as unknown as Record<string, unknown>
    const localRec = m as unknown as Record<string, unknown>
    let patched: ChatMessage | undefined
    // 旧 message-blocks.jsonl 可能早于 agent_id 落盘；只在本地缺失时由 DB 历史行补齐。
    // 本地 runtime 已有值时它是本轮身份权威，不能被可能滞后的 DB 投影覆盖。
    if (
      typeof localRec.agent_id !== 'string'
      && typeof matchedRec.agent_id === 'string'
      && matchedRec.agent_id.length > 0
    ) {
      patched = { ...m, agent_id: matchedRec.agent_id }
    }
    for (const field of SERVER_ENHANCEMENT_FIELDS) {
      const sv = matchedRec[field]
      if (sv == null) continue
      if (localRec[field] === sv) continue
      patched = patched ?? { ...m }
      ;(patched as unknown as Record<string, unknown>)[field] = sv
    }
    // HITL 状态翻转（runtime 已死时由 Django 改 metadata.hitl.status：过期 / 取消）——
    // 本机会话正文以 runtime 为准，但 hitl 的 dead-runtime 终态只在 DB 上翻。定向合并
    // server 的 metadata.hitl（不整体覆盖 metadata，避免动其它字段），让重载后面板收敛。
    const serverHitl = readHitl(matchedRec.metadata)
    const localHitl = readHitl(localRec.metadata)
    if (serverHitl && (!localHitl || serverHitl.status !== localHitl.status)) {
      patched = patched ?? { ...m }
      const pm = (patched.metadata && typeof patched.metadata === 'object' ? patched.metadata : {}) as Record<string, unknown>
      patched.metadata = { ...pm, hitl: serverHitl }
    }
    // ：本机 transcript 在  降级路径可能只落了正文；DB 仍有视频/图片块。
    const withMedia = mergeMissingMediaBlocksFromServer(patched ?? m, matched)
    if (withMedia) {
      patched = withMedia
    }
    // ：本机曾把 Tracker 完整 prompt 写入 transcript；DB 是 display_message。
    // 本地更长且包着服务端正文（非截断前缀）时，冷读改以 DB 可见正文为准。
    const withDisplay = mergePreferredServerDisplayContent(patched ?? m, matched)
    if (withDisplay) {
      patched = withDisplay
    }
    if (patched) {
      changed = true
      return patched
    }
    return m
  })
  return changed ? out : local
}

function fullTextFromBlocks(blocks: unknown): string {
  if (!Array.isArray(blocks)) return ''
  const parts: string[] = []
  for (const block of blocks) {
    if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
      const text = (block as { text?: unknown }).text
      if (typeof text === 'string' && text.length > 0) parts.push(text)
    }
  }
  return parts.join('\n')
}

/** 运行时 SSoT `message.blocks`（ContentBlockEntry）里的 text 拼接。 */
function fullTextFromRuntimeBlocks(runtimeBlocks: unknown): string {
  if (!Array.isArray(runtimeBlocks)) return ''
  const parts: string[] = []
  for (const entry of runtimeBlocks) {
    if (!entry || typeof entry !== 'object') continue
    const block = (entry as { block?: unknown }).block
    if (!block || typeof block !== 'object') continue
    if ((block as { type?: unknown }).type !== 'text') continue
    const text = (block as { text?: unknown }).text
    if (typeof text === 'string' && text.length > 0) parts.push(text)
  }
  return parts.join('\n')
}

/** 本地执行 prompt 包着服务端 display 正文时，用服务端覆盖冷读气泡。 */
function mergePreferredServerDisplayContent(
  local: ChatMessage,
  server: ChatMessage,
): ChatMessage | undefined {
  if (local.role !== 'user' || server.role !== 'user') return undefined
  const serverContent = fullTextFromBlocks(server.content_blocks_json) || server.content || ''
  if (!serverContent) return undefined

  // 时间线物化读 message.blocks 再盖回 content_blocks_json；三处任一包着模板都要纠。
  const runtimeText = fullTextFromRuntimeBlocks(local.blocks)
  const jsonText = fullTextFromBlocks(local.content_blocks_json)
  const contentText = local.content || ''
  if (
    !preferServerDisplayContent(runtimeText, serverContent)
    && !preferServerDisplayContent(jsonText, serverContent)
    && !preferServerDisplayContent(contentText, serverContent)
  ) {
    return undefined
  }

  const serverJson = Array.isArray(server.content_blocks_json)
    ? [...server.content_blocks_json]
    : [{ type: 'text', text: serverContent }]
  const localJson = Array.isArray(local.content_blocks_json) ? local.content_blocks_json : []
  const { blocks } = appendMissingUserMediaBlocks(serverJson, localJson)
  // 丢掉陈旧 runtime blocks，让 setSessionMessages → hydrate 从新 json 重灌
  // （ensureMessageRuntimeBlocks 见非空 blocks 会跳过，不主动清就会继续渲染模板）。
  const { blocks: _staleRuntimeBlocks, ...withoutBlocks } = local as ChatMessage & {
    blocks?: unknown
  }
  return {
    ...withoutBlocks,
    content: serverContent,
    content_blocks_json: blocks as ChatMessage['content_blocks_json'],
  }
}

/** 把结果块 append 到首个「有该 tool_use 且尚无对应 tool_result」的消息；成功返回 true。 */
function attachToolResult(
  messages: ChatMessage[],
  toolUseId: string,
  resultBlock: MessageBlock,
): boolean {
  for (const target of messages) {
    const blocks = target.content_blocks_json
    if (!blocks) continue
    const hasUse = blocks.some((b) => isToolUseBlock(b) && (b as { id?: string }).id === toolUseId)
    if (!hasUse) continue
    const alreadyPaired = blocks.some(
      (b) => isToolResultBlock(b) && (b as { tool_use_id?: string }).tool_use_id === toolUseId,
    )
    if (alreadyPaired) continue
    blocks.push(resultBlock)
    return true
  }
  return false
}
