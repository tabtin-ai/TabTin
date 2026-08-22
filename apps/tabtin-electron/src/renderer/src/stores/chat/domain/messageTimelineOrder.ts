import type { ChatMessage, MessageBlock } from '@tabtin/chat-client'
import type { ContentBlockEntry } from '@stores/useChatRuntimeStore'
import { appendMissingUserAttachmentMediaBlocks } from './userMediaMerge'
import { shouldHideLegacyWebSearchArtifactMessage } from './webSearchArtifactPolicy'

const EMPTY_ENTRIES: ContentBlockEntry[] = []

/** 消息的运行时块（ 单一读源）——入口反序列化已保证 live/历史都有值。 */
function messageEntries(message: ChatMessage): ContentBlockEntry[] {
  return message.blocks ?? EMPTY_ENTRIES
}

/** 取 entry 的 block 本体（携带 arrival_seq/arrived_at 排序键，运行时与落库同一份）。 */
function entryBlock(entry: ContentBlockEntry): MessageBlock {
  return entry.block as unknown as MessageBlock
}

/**
 * finalize 门控：一条消息只要有未 finalize 的块（正在流式的尾消息）→ 当整条 passthrough
 * （由 MessageBubble 的响应式 useMessageBlocksById 逐 token 刷新），不做块级拆分；全部
 * finalize（已完成 / 历史）→ 才拍平重排。等价于旧口径「content_blocks_json 只在 finalize
 * 写、流式期为空 → 走 passthrough」。
 */
function isBlockSplittable(entries: ContentBlockEntry[]): boolean {
  return entries.length > 0 && entries.every((e) => e.finalized)
}

/** 钉首序号：显式标记 `_timeline_pin_first` 的消息（如子代理任务气泡=run 输入）排在最前。 */
const PIN_FIRST_SEQ = Number.MIN_SAFE_INTEGER

function isPinnedFirst(message: ChatMessage): boolean {
  return (message.metadata as Record<string, unknown> | null | undefined)?._timeline_pin_first === true
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function createdAtMs(message: ChatMessage): number {
  const value = new Date(message.created_at).getTime()
  return Number.isFinite(value) ? value : 0
}

let localArrivalCounter = 0

export function nextLocalArrivalSeq(): number {
  localArrivalCounter = (localArrivalCounter + 1) % 1000
  return Date.now() * 1000 + localArrivalCounter
}

export function applyBlockArrival(block: MessageBlock, seq = nextLocalArrivalSeq()): MessageBlock {
  return {
    ...block,
    arrival_seq: finiteNumber(block.arrival_seq) ?? seq,
    arrived_at: typeof block.arrived_at === 'string' ? block.arrived_at : new Date().toISOString(),
  }
}

export function applyBlocksArrival(
  blocks: readonly MessageBlock[] | undefined,
  daemonArrivalSeq?: number,
): MessageBlock[] | undefined {
  if (!blocks) return undefined
  // arrival_seq 权威优先 daemon emit 值;缺失才用本地单调微秒兜底。
  const baseSeq = finiteNumber(daemonArrivalSeq) ?? nextLocalArrivalSeq()
  const arrivedAt = new Date().toISOString()
  return blocks.map((block, index) => ({
    ...block,
    arrival_seq: finiteNumber(block.arrival_seq) ?? (baseSeq + index),
    arrived_at: typeof block.arrived_at === 'string' ? block.arrived_at : arrivedAt,
  }))
}

function blockArrivedAtMs(block: MessageBlock | undefined, message: ChatMessage): number {
  const value = typeof block?.arrived_at === 'string'
    ? new Date(block.arrived_at).getTime()
    : NaN
  return Number.isFinite(value) ? value : createdAtMs(message)
}

// 时间线统一为微秒尺度（≈1.78e15，JS Number 安全整数 9e15 内）。
//
// 存量数据归一化：早期后端把 arrival_seq 以**纳秒**（time_ns ≈ 1.78e18）写死进
// content_blocks_json，与新数据 / 前端的微秒尺度差 1000 倍。若不归一，刷新后旧
// assistant 块（纳秒）会把所有 user 块（微秒）压到顶部、滚出可视区，表现为
// 「刷新后用户消息丢了」。读取时按量级把纳秒折算回微秒，新旧数据同尺度。
const NANOSECOND_SCALE_THRESHOLD = 1e16

function normalizeArrivalSeq(value: number): number {
  return value >= NANOSECOND_SCALE_THRESHOLD ? Math.floor(value / 1000) : value
}

export function blockTimelineSeq(block: MessageBlock | undefined, message: ChatMessage, index: number): number {
  // 仅 arrival_seq 是合法的全局时间线键(daemon emit 单调微秒,)。
  // **绝不能**用 block.seq —— 那是 envelope `_seq`,query 内局部、每轮从 0 重置;
  // 当作全局排序键会把多轮历史按局部序号打乱(user 的 seq:0 全挤到顶、各轮
  // assistant 交叉错排)。缺 arrival_seq 的老数据回落 created_at*微秒 + index,
  // 保持「按轮 created_at + 块数组序」的稳定时序。
  const raw = finiteNumber(block?.arrival_seq)
  if (raw !== null) return normalizeArrivalSeq(raw)
  return blockArrivedAtMs(block, message) * 1_000 + index
}

export function firstBlockTimelineSeq(message: ChatMessage): number {
  const entries = messageEntries(message)
  if (entries.length === 0) return createdAtMs(message) * 1_000
  let minSeq = Number.POSITIVE_INFINITY
  entries.forEach((entry, index) => {
    minSeq = Math.min(minSeq, blockTimelineSeq(entryBlock(entry), message, index))
  })
  return Number.isFinite(minSeq) ? minSeq : createdAtMs(message) * 1_000
}

export function compareMessagesForTimeline(a: ChatMessage, b: ChatMessage): number {
  const blockDelta = firstBlockTimelineSeq(a) - firstBlockTimelineSeq(b)
  if (blockDelta !== 0) return blockDelta

  const createdDelta = createdAtMs(a) - createdAtMs(b)
  if (createdDelta !== 0) return createdDelta

  return a.id.localeCompare(b.id)
}

export function sortMessagesForTimeline(messages: readonly ChatMessage[]): ChatMessage[] {
  return [...messages].sort(compareMessagesForTimeline)
}

const TOOL_USE_TYPES = new Set(['tool_use', 'mcp_tool_use'])
const TOOL_RESULT_TYPES = new Set(['tool_result', 'mcp_tool_result'])

function blockType(block: MessageBlock | undefined): string {
  return typeof block?.type === 'string' ? block.type : ''
}

interface ToolUseAnchor {
  /** 该 tool_use 的全局时间线序号(tool_result 继承之,排到紧邻位置)。 */
  seq: number
  /** 归属消息 id——tool_result 被拉回 tool_use 所在消息的段内渲染。 */
  ownerMessageId: string
  /** tool_use 在其源消息内的块序,用于同序号 tie-break 保持 use 在 result 前。 */
  index: number
}

/**
 * 跨所有消息建立 tool_use_id → 锚点(seq + 归属消息 + 块序)的全局索引。
 *
 * tool_result（含 mcp_tool_result）是惰性附属块(ToolResultBlockView 渲染 null,仅被
 * 工具卡 buildSiblingToolResultMap 按 tool_use_id 消费),它**不是独立时间线事件**。
 * 当前架构里 tool_result 可能与 tool_use 不在同一条消息(典型 ask_user_fields/HITL),
 * 后台子代理的迟到结果也可能晚到。让 tool_result **全局继承其 tool_use 的 seq+归属**,
 * 就能把结果稳定拉回 tool_use 的位置(普通工具→紧贴工具卡;子代理→收进聚合卡),
 * 既不散到主流、又不破坏块级时序。
 */
function buildToolUseAnchors(messages: readonly ChatMessage[]): Map<string, ToolUseAnchor> {
  const anchors = new Map<string, ToolUseAnchor>()
  for (const message of messages) {
    const entries = messageEntries(message)
    entries.forEach((entry, index) => {
      const block = entryBlock(entry)
      if (!TOOL_USE_TYPES.has(blockType(block))) return
      const id = (block as { id?: unknown }).id
      if (typeof id === 'string' && id && !anchors.has(id)) {
        anchors.set(id, { seq: blockTimelineSeq(block, message, index), ownerMessageId: message.id, index })
      }
    })
  }
  return anchors
}

interface TimelineBlockItem {
  ownerMessage: ChatMessage
  /** 块的真实来源消息 id(用于判定段内是否含外来块 → live 需用段自带 blocks)。 */
  sourceMessageId: string
  entry: ContentBlockEntry
  seq: number
  /** 同 seq tie-break:tool_use 的块序(tool_result 取其 tool_use 的块序)。 */
  anchorIndex: number
  /** tool_result 排在同序号 tool_use 之后。 */
  isToolResult: boolean
  /** 末级 tie-break:源消息内块序。 */
  sourceIndex: number
}

type TimelineItem =
  | { kind: 'message'; message: ChatMessage; seq: number }
  | ({ kind: 'block' } & TimelineBlockItem)

/**
 * 块级全局时间线物化:把所有消息的块拍平成一条全局块流,按 arrival_seq 排序,再把
 * **连续归属同一条消息**的块归并回一条渲染用 ChatMessage(段)。
 *
 * 设计取向(用户拍板「完全拆散」):块是时间线单位,而非消息。
 *   - tool_artifact / 独立 user 块等按真实抵达**内联**插进主代理文字块之间(段被拆开);
 *   - tool_result 继承其 tool_use 的 seq+归属(见 buildToolUseAnchors),被拉回工具卡
 *     位置——普通工具紧贴卡片、子代理收进聚合卡,绝不散到主流;
 *   - 段内块序稳定:同序号下先聚同归属、tool_use 在其 tool_result 前。
 *
 * 配合 BlockTimeline.groupConsecutiveSubagentBlocks(跳过惰性结果块)保证 subagent
 * tool_use 即便被结果块交错也仍聚成一张卡。每个段是合成 ChatMessage(可与源消息同 id,
 * 即一条源消息被独立块拆成多段);渲染层据 metadata._timeline_item_key 区分各段。
 */
export function materializeMessagesForTimeline(messages: readonly ChatMessage[]): ChatMessage[] {
  // 压缩只影响「发给 LLM 的上下文」（selectRecentHistoryForRuntime 路径），聊天
  // 时间线仍完整展示所有真实消息——compaction_summary 作为一条普通 system 分隔
  // 按时间顺序就地渲染，不隐藏边界前的用户消息 / 工具调用。
  const visibleMessages = messages.filter(message => !shouldHideLegacyWebSearchArtifactMessage(message))
  const anchors = buildToolUseAnchors(visibleMessages)
  const items: TimelineItem[] = []
  for (const message of visibleMessages) {
    const entries = messageEntries(message)
    // finalize 门控：空 / 有未 finalize 块（流式尾消息）→ 整条 passthrough（响应式渲染）。
    if (!isBlockSplittable(entries)) {
      items.push({
        kind: 'message',
        message,
        // 显式钉首（run 输入气泡）优先于时间排序；否则按首块时间线序号。
        seq: isPinnedFirst(message) ? PIN_FIRST_SEQ : firstBlockTimelineSeq(message),
      })
      continue
    }
    entries.forEach((entry, sourceIndex) => {
      const block = entryBlock(entry)
      const isToolResult = TOOL_RESULT_TYPES.has(blockType(block))
      const tuid = isToolResult ? (block as { tool_use_id?: unknown }).tool_use_id : undefined
      const anchor = typeof tuid === 'string' ? anchors.get(tuid) : undefined
      if (isToolResult && anchor) {
        items.push({
          kind: 'block',
          // 归属改写:跨消息结果归并到 tool_use 的消息段。
          ownerMessage: anchor.ownerMessageId !== message.id
            ? (messageById(visibleMessages, anchor.ownerMessageId) ?? message)
            : message,
          sourceMessageId: message.id,
          entry,
          seq: anchor.seq,
          anchorIndex: anchor.index,
          isToolResult: true,
          sourceIndex,
        })
        return
      }
      items.push({
        kind: 'block',
        ownerMessage: message,
        sourceMessageId: message.id,
        entry,
        seq: blockTimelineSeq(block, message, sourceIndex),
        anchorIndex: sourceIndex,
        isToolResult: false,
        sourceIndex,
      })
    })
  }

  items.sort((a, b) => {
    if (a.seq !== b.seq) return a.seq - b.seq
    const aOwner = a.kind === 'block' ? a.ownerMessage.id : a.message.id
    const bOwner = b.kind === 'block' ? b.ownerMessage.id : b.message.id
    const ownerDelta = aOwner.localeCompare(bOwner)
    if (ownerDelta !== 0) return ownerDelta
    const aAnchor = a.kind === 'block' ? a.anchorIndex : 0
    const bAnchor = b.kind === 'block' ? b.anchorIndex : 0
    if (aAnchor !== bAnchor) return aAnchor - bAnchor
    const aResult = a.kind === 'block' && a.isToolResult ? 1 : 0
    const bResult = b.kind === 'block' && b.isToolResult ? 1 : 0
    if (aResult !== bResult) return aResult - bResult
    const aSrc = a.kind === 'block' ? a.sourceIndex : 0
    const bSrc = b.kind === 'block' ? b.sourceIndex : 0
    return aSrc - bSrc
  })

  // 第一趟:把全局排序后的块流切成「连续同归属」的段(passthrough 直接进结果)。
  interface RawSegment {
    kind: 'segment'
    owner: ChatMessage
    blocks: ContentBlockEntry[]
    firstSeq: number
    lastSeq: number
    /** 段内是否含外来块(归并自其他消息的 tool_result)。 */
    hasForeign: boolean
  }
  type RawItem = RawSegment | { kind: 'passthrough'; message: ChatMessage }

  const raw: RawItem[] = []
  let seg: RawSegment | null = null
  const flush = () => {
    if (seg) raw.push(seg)
    seg = null
  }
  for (const item of items) {
    if (item.kind === 'message') {
      flush()
      raw.push({ kind: 'passthrough', message: item.message })
      continue
    }
    if (!seg || seg.owner.id !== item.ownerMessage.id) {
      flush()
      seg = { kind: 'segment', owner: item.ownerMessage, blocks: [], firstSeq: item.seq, lastSeq: item.seq, hasForeign: false }
    }
    seg.blocks.push(item.entry)
    seg.lastSeq = item.seq
    if (item.sourceMessageId !== item.ownerMessage.id) seg.hasForeign = true
  }
  flush()

  // 第二趟:统计每个 owner id 产出的段数——>1 即该源消息被独立块拆开。
  const segCountByOwner = new Map<string, number>()
  for (const r of raw) {
    if (r.kind !== 'segment') continue
    segCountByOwner.set(r.owner.id, (segCountByOwner.get(r.owner.id) ?? 0) + 1)
  }

  return raw.map((r) => {
    if (r.kind === 'passthrough') return r.message
    // partial:被拆成多段、或含归并进来的外来块。这类段渲染时必须用段自带 blocks
    // (而非按消息 id 取 runtime store 全量),否则 live 态会重复/串块。
    const isPartial = (segCountByOwner.get(r.owner.id) ?? 1) > 1 || r.hasForeign
    const segmentJson = r.blocks.map((e) => entryBlock(e)) as ChatMessage['content_blocks_json']
    // 用户附件以 content_blocks_json 为权威投影源；runtime blocks 若只含 text
    // （流式先落字、对账后补图），不得用残缺切片盖掉 owner 上的 image/file。
    const content_blocks_json = r.owner.role === 'user'
      ? appendMissingUserAttachmentMediaBlocks(
        segmentJson as unknown[],
        Array.isArray(r.owner.content_blocks_json) ? r.owner.content_blocks_json : [],
      ).blocks as ChatMessage['content_blocks_json']
      : segmentJson
    return {
      ...r.owner,
      // 段自带切片：blocks（运行时 SSoT，assistant 渲染读）+ content_blocks_json（同一
      // 切片的 block 本体，供 user 附件 / context ref 等序列化字段消费者）。
      blocks: r.blocks,
      content_blocks_json,
      metadata: {
        ...(r.owner.metadata ?? {}),
        _timeline_item_key: `${r.owner.id}:${r.firstSeq}-${r.lastSeq}`,
        ...(isPartial ? { _timeline_is_partial: true } : {}),
      },
    }
  })
}

function messageById(messages: readonly ChatMessage[], id: string): ChatMessage | undefined {
  return messages.find((m) => m.id === id)
}
