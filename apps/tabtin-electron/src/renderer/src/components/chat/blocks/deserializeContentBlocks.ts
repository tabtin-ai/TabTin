/**
 * deserializeContentBlocks —— 落库序列化形态 `ChatMessage.content_blocks_json`
 * （`MessageBlock[]`）→ 运行时 SSoT `ContentBlockEntry[]` 的**入口反序列化边界**。
 *
 * 只在消息进入 store 的入口（`hydrateSessionBlocksFromJson`）调用一次，把落库形态
 * 归一成运行时形态灌进 `message.blocks`；之后所有块读路径只认 `message.blocks`，**不再于
 * 读时反序列化**。
 *
 * **支持的源格式**：
 *   1. Anthropic native ContentBlock（type='text' / 'tool_use' / 'tool_result' /
 *      'thinking' / 'tabtin_rich_content' 等）—— 当前落库主形态，原样包成 entry
 *      （保留 block 本体上的 arrival_seq 排序键）。
 *   2. 向后兼容的老 MessageBlock（type='tool_call' / 'rich_content' / 老 'thinking'）
 *      —— 仅存量旧行需要，按 type 转成 native ContentBlock。
 *
 * 老 MessageBlock 字段映射规则：
 *   - 'thinking' → ContentBlock thinking（content → thinking 字段，signature 缺失则空字符串）
 *   - 'tool_call' → ContentBlock tool_use + 紧跟 tool_result（成功）或省略（错误）
 *   - 'rich_content' → tabtin_rich_content（顶层字段聚合到 payload）
 *   - 'text' → text（直接）
 *   - 其他（composer_preset / ask_user_fields / etc）→ 跳过（user echo 在 user
 *     气泡渲染，不进 BlockTimeline）
 *
 * 不变量：返回的 ContentBlockEntry[] 全部 finalized=true（入口态），index 按
 * 输入顺序 0/1/2/...，block_id 来自原始字段 + 兜底 index。
 */

import { ALL_BLOCK_TYPE_SET } from '@tabtin/agent-wire'
import type {
  ContentBlock,
  TextBlock,
  ThinkingBlock,
  ToolUseBlock,
  ToolResultBlock,
  TabTinRichContentBlock,
} from '@tabtin/agent-wire'
import type { ContentBlockEntry } from '@stores/useChatRuntimeStore'

type AnyRecord = Record<string, unknown>

/**
 * Anthropic 原生 ContentBlock type 集合——由 wire 层 ALL_BLOCK_TYPE_SET 派生
 * （W4c · W4b-P1-1 子项 d 单源契约），避免本文件独立维护字符串列表导致漏写。
 *
 * @see packages/agent-wire/src/block-types.ts ALL_BLOCK_TYPES
 */
const ANTHROPIC_NATIVE_TYPES: ReadonlySet<string> = ALL_BLOCK_TYPE_SET

function isAnthropicNativeBlock(block: unknown): boolean {
  if (!block || typeof block !== 'object') return false
  const t = (block as AnyRecord).type
  return typeof t === 'string' && ANTHROPIC_NATIVE_TYPES.has(t)
}

function adaptThinking(block: AnyRecord, idx: number, mid: string): ContentBlockEntry | null {
  const content = typeof block.content === 'string' ? block.content
    : typeof block.text === 'string' ? block.text
    : typeof block.thinking === 'string' ? block.thinking
    : ''
  if (!content) return null
  const thinkingBlock: ThinkingBlock = {
    type: 'thinking',
    thinking: content,
    signature: typeof block.signature === 'string' ? block.signature : '',
  }
  return {
    index: idx,
    block_id: typeof block.block_id === 'string' ? block.block_id : `legacy-thinking-${mid}-${idx}`,
    block: thinkingBlock,
    finalized: true,
    partial: false,
  }
}

function adaptText(block: AnyRecord, idx: number, mid: string): ContentBlockEntry | null {
  const text = typeof block.text === 'string' ? block.text
    : typeof block.content === 'string' ? block.content
    : ''
  if (!text) return null
  const textBlock: TextBlock = { type: 'text', text }
  return {
    index: idx,
    block_id: typeof block.block_id === 'string' ? block.block_id : `legacy-text-${mid}-${idx}`,
    block: textBlock,
    finalized: true,
    partial: false,
  }
}

function adaptToolCall(block: AnyRecord, idx: number, mid: string): ContentBlockEntry[] {
  const toolName = typeof block.tool_name === 'string' ? block.tool_name : 'unknown'
  const toolCallId = typeof block.tool_call_id === 'string'
    ? block.tool_call_id
    : `legacy-tc-${mid}-${idx}`
  const input = (block.input ?? block.args ?? block.data) as Record<string, unknown> | undefined
  const isError = !!block.error
  const output = block.output
  const useBlock: ToolUseBlock = {
    type: 'tool_use',
    id: toolCallId,
    name: toolName,
    input: (input && typeof input === 'object') ? input as Record<string, unknown> : {},
  }
  const useEntry: ContentBlockEntry = {
    index: idx,
    block_id: typeof block.block_id === 'string' ? block.block_id : `legacy-tooluse-${mid}-${idx}`,
    block: useBlock,
    finalized: true,
    partial: false,
  }
  // 老 tool_call block 既含 input 又含 output——拆成 use + result 两个 entry
  const out: ContentBlockEntry[] = [useEntry]
  const contentString = typeof output === 'string'
    ? output
    : (output != null ? safeStringify(output) : '')
  if (contentString || isError) {
    const resultBlock: ToolResultBlock = {
      type: 'tool_result',
      tool_use_id: toolCallId,
      content: contentString,
      is_error: isError,
    }
    out.push({
      index: idx,
      block_id: `legacy-toolresult-${mid}-${idx}`,
      block: resultBlock,
      finalized: true,
      partial: false,
    })
  }
  return out
}

function safeStringify(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

const RICH_CONTENT_OMIT = new Set(['type', 'kind', 'summary', 'group_id', 'group_title'])

function adaptRichContent(block: AnyRecord, idx: number, mid: string): ContentBlockEntry | null {
  const kind = block.kind
  if (typeof kind !== 'string') return null
  const payload: AnyRecord = {}
  for (const k of Object.keys(block)) {
    if (!RICH_CONTENT_OMIT.has(k)) payload[k] = block[k]
  }
  const richBlock: TabTinRichContentBlock = {
    type: 'tabtin_rich_content',
    kind: kind as TabTinRichContentBlock['kind'],
    summary: typeof block.summary === 'string' ? block.summary : '',
    group_id: typeof block.group_id === 'string' ? block.group_id : undefined,
    payload,
  }
  return {
    index: idx,
    block_id: typeof block.block_id === 'string' ? block.block_id : `legacy-rich-${mid}-${idx}`,
    block: richBlock,
    finalized: true,
    partial: false,
  }
}

/**
 * partialReason 推断的输入信号集。
 *
 * 优先级（高→低）：
 *   1. `stop_reason` 顶层（W3 真正落库位置；'aborted' / 'error' / 'timeout' 等）
 *   2. `error_info_json.aborted` / `error_info_json.category`
 *   3. `metadata.aborted` / `metadata.errorClass` / `metadata.errorCategory`
 *      （旧 errorReporter 路径残留 / 老消息兼容）
 */
export interface MessageSignalsForPartialReason {
  /** ChatMessage.stop_reason 顶层字段（W3 §3.3.1） */
  stopReason?: string | null
  /** ChatMessage.error_info_json 顶层字段（W3 §3.3.1） */
  errorInfo?: Record<string, unknown> | null
  /** ChatMessage.metadata（旧 errorReporter 路径 / 兼容老消息） */
  metadata?: Record<string, unknown> | null
}

/**
 * 主入口：content_blocks_json -> ContentBlockEntry[]。
 *
 * 不变量：
 *   - 跳过 user echo 类（composer_preset / ask_user_fields）—— BlockTimeline
 *     仅用于 assistant 消息
 *   - 跳过 context_ref / document_ref / source_ref / 等顶层 user input 引用
 *     ——这些由 MessageBubble 自己渲染
 *   - 错误 block.type 整条跳过（不抛错）
 *
 * **W4c · R2-P1-4 + R6-P0-1**：从 `signals`（含 W3 顶层 stop_reason /
 * error_info_json + 老 metadata 兼容）推断 partial / partialReason，让历史
 * 回看的 BlockRenderer 显示"已中断 / 已截断"——避免直播时显示中断、历史
 * 回看时却"看起来正常完成"的体感分裂。
 *
 * 推断规则：
 *   - `stop_reason === 'aborted'` 或 `error_info_json.aborted === true` 或
 *     `error_info_json.category === 'aborted'` → partialReason='aborted'
 *   - `stop_reason === 'error' / 'timeout'` 或 `error_info_json.category` 非
 *     'aborted'（譬如 'tool_exec' / 'refusal'）→ partialReason='stream_interrupted'
 *   - 其他（正常 'end_turn' / 'tool_use' / 'stop_sequence'）→ partial=false
 *
 * 推断只在最后一个 entry 上设置——因为中断只能影响**末尾**那个未 finalize
 * 的 block，前面的 block 都已经 finalized 完成。
 *
 * **第 3 个参数兼容性**：保留接受 `Record<string, unknown> | null`（视为 metadata
 * 兼容老调用方）；推荐传入完整 `MessageSignalsForPartialReason`。
 */
export function deserializeContentBlocks(
  blocks: unknown[],
  messageId: string,
  signalsOrMetadata?: MessageSignalsForPartialReason | Record<string, unknown> | null,
): ContentBlockEntry[] {
  if (!Array.isArray(blocks) || blocks.length === 0) return []
  const out: ContentBlockEntry[] = []
  let idx = 0
  for (const rawBlock of blocks) {
    if (!rawBlock || typeof rawBlock !== 'object') continue
    const block = rawBlock as AnyRecord

    // 老 thinking block 用 content 字段不用 thinking 字段——强制走 legacy 路径
    const isOldThinking = block.type === 'thinking' && typeof block.thinking !== 'string' && typeof block.content === 'string'

    // 路径 1：Anthropic native ContentBlock（来自 lite-collector inject）—— 直接转 entry
    if (!isOldThinking && isAnthropicNativeBlock(block)) {
      const curIdx = idx++
      out.push({
        index: curIdx,
        block_id: typeof block.block_id === 'string'
          ? block.block_id
          : `legacy-native-${messageId}-${curIdx}`,
        block: block as unknown as ContentBlock,
        finalized: true,
        partial: false,
      })
      continue
    }

    // 路径 2：老 MessageBlock 格式 —— 按 type 单独转换
    const blockType = typeof block.type === 'string' ? block.type : ''
    switch (blockType) {
      case 'text': {
        const entry = adaptText(block, idx, messageId)
        if (entry) out.push({ ...entry, index: idx++ })
        break
      }
      case 'thinking': {
        const entry = adaptThinking(block, idx, messageId)
        if (entry) out.push({ ...entry, index: idx++ })
        break
      }
      case 'tool_call': {
        const entries = adaptToolCall(block, idx, messageId)
        for (const e of entries) out.push({ ...e, index: idx++ })
        break
      }
      case 'rich_content': {
        const entry = adaptRichContent(block, idx, messageId)
        if (entry) out.push({ ...entry, index: idx++ })
        break
      }
      // user echo / 引用块跳过——MessageBubble 在 user 分支单独渲染
      case 'composer_preset':
      case 'ask_user_fields':
      case 'context_ref':
      case 'document_ref':
      case 'source_ref':
      case 'metadata':
        break
      default:
        if (blockType) {
          const curIdx = idx++
          out.push({
            index: curIdx,
            block_id: `legacy-unknown-${messageId}-${curIdx}`,
            block: block as unknown as ContentBlock,
            finalized: true,
            partial: false,
          })
        }
        break
    }
  }

  // W4c · R2-P1-4 + R6-P0-1：把顶层 stop_reason / error_info_json / metadata
  // 信号合并推断映射到末尾 entry 的 partial + partialReason
  const signals = normalizeSignals(signalsOrMetadata)
  const partialFromSignals = inferPartialReasonFromSignals(signals)
  if (partialFromSignals && out.length > 0) {
    const lastIdx = out.length - 1
    out[lastIdx] = {
      ...out[lastIdx],
      partial: true,
      partialReason: partialFromSignals,
    }
  }

  return out
}

/** 兼容老调用：第 3 参数是普通 metadata 对象时包成 signals */
function normalizeSignals(
  input: MessageSignalsForPartialReason | Record<string, unknown> | null | undefined,
): MessageSignalsForPartialReason {
  if (!input || typeof input !== 'object') return {}
  // 区分新 signals 形态（含 stopReason/errorInfo/metadata 字段）vs 老 metadata 对象
  const obj = input as AnyRecord
  if ('stopReason' in obj || 'errorInfo' in obj || 'metadata' in obj) {
    return {
      stopReason: typeof obj.stopReason === 'string' ? obj.stopReason : undefined,
      errorInfo: obj.errorInfo as Record<string, unknown> | null | undefined,
      metadata: obj.metadata as Record<string, unknown> | null | undefined,
    }
  }
  // 老调用：当作 metadata
  return { metadata: input as Record<string, unknown> }
}

/**
 * W4c · R6-P0-1 修复 + W4c 联合 Review P2-1 三档对齐：从顶层 stop_reason /
 * error_info_json / metadata 三源合并推断 partialReason。优先级：
 * stop_reason > error_info_json > metadata（老 errorReporter 路径兼容）。
 *
 * **关键修复**：W3 后端把 `aborted` 写到 `error_info_json.aborted` + `stop_reason='aborted'`，
 * **不写**到 `metadata.aborted`（之前误判读位置导致历史回看显示"…内容被截断"
 * 而非"已中断"）。此函数读对位置——直播路径与历史路径用户感知一致。
 *
 * **W4c 联合 Review P2-1 三档对齐**：useChatRuntimeStore 的直播路径支持三档
 * `'aborted' | 'stream_interrupted' | 'message_stop_fallback'`，但 W3 协议层
 * 当前没有专属字段持久化区分"messageStop 兜底强制 finalize"vs"stream 异常中断"。
 * 历史回放只能根据现有信号近似推断：
 *   - `error_info_json.partial_reason === 'message_stop_fallback'`（W3 后续若加该字段）
 *     → 'message_stop_fallback'
 *   - 其他正常完成 stop_reason 但末尾 block 标 partial=true → 'message_stop_fallback'（保守）
 *
 * **已知局限**：W3 协议层不持久化"daemon 端 messageStop 兜底"信号——历史回放
 * 在该场景仍可能误判为 `stream_interrupted`。**登记 §0.6 W4c-L5 P2 → W7
 * 协议层增字段** `error_info_json.partial_reason` 持久化此区分。
 */
function inferPartialReasonFromSignals(
  signals: MessageSignalsForPartialReason,
): 'aborted' | 'stream_interrupted' | 'message_stop_fallback' | undefined {
  const stopReason = signals.stopReason
  // ── 优先级 1：顶层 stop_reason（W3 真正落库位置） ──
  if (stopReason === 'aborted') return 'aborted'
  if (stopReason === 'error' || stopReason === 'timeout' || stopReason === 'refusal') {
    return 'stream_interrupted'
  }
  // 'end_turn' / 'tool_use' / 'stop_sequence' / 'max_tokens' 都属正常完成

  // ── 优先级 2：error_info_json（W3 derive_error_info 派生） ──
  const errorInfo = signals.errorInfo
  if (errorInfo && typeof errorInfo === 'object') {
    if ((errorInfo as AnyRecord).aborted === true) return 'aborted'
    const cat = (errorInfo as AnyRecord).category
    if (cat === 'aborted') return 'aborted'
    // W4c 联合 Review P2-1：W7 后协议增 partial_reason 字段时，优先读 W3 持久化值
    const partialReason = (errorInfo as AnyRecord).partial_reason
    if (partialReason === 'message_stop_fallback') return 'message_stop_fallback'
    if (partialReason === 'stream_interrupted') return 'stream_interrupted'
    if (partialReason === 'aborted') return 'aborted'
    if (typeof cat === 'string' && cat.length > 0) return 'stream_interrupted'
  }

  // ── 优先级 3：老 metadata（旧 errorReporter 路径残留兼容） ──
  const meta = signals.metadata
  if (!meta || typeof meta !== 'object') return undefined
  const metaObj = meta as AnyRecord
  const aborted = metaObj.aborted === true
  const errorCategory = typeof metaObj.errorCategory === 'string' ? metaObj.errorCategory
    : typeof metaObj.error_category === 'string' ? metaObj.error_category as string
    : undefined
  if (aborted || errorCategory === 'aborted') return 'aborted'
  const errorClass = typeof metaObj.errorClass === 'string' ? metaObj.errorClass
    : typeof metaObj.error_class === 'string' ? metaObj.error_class as string
    : undefined
  if (errorClass || (errorCategory && errorCategory !== 'aborted')) {
    return 'stream_interrupted'
  }
  return undefined
}
