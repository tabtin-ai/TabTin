/**
 * chatMessageContextUsage —— 「上下文用量环」的 messages-as-truth 派生工具。
 *
 * ## 设计哲学（messages-as-truth）
 *
 * 上下文用量的真相**不在 ChatSession 字段里**，而在 **messages 数组的最后一条
 * 带真实 usage 的 assistant 消息上**。这是 `getCurrentUsage` 的核心设计原则——
 *
 *   1. ChatSession 字段（input_tokens / output_tokens）是 turn 累加值，
 *      跨多轮对话单调递增，**不能**作为「当前上下文规模」的代理；
 *   2. 最近一次 LLM provider 响应的 usage 才是「当前送进 LLM 的上下文有多大」
 *      ——这个值就是下一轮 LLM 调用要面对的窗口压力；
 *   3. messages 是持久化的（ChatMessage.metadata 由 RelayMessageWriter 幂等
 *      落库），所以无论刷新页面、切设备、还是历史会话恢复，都能算出正确值。
 *
 * 历史教训：之前我们把 `ChatSession.context_tokens` 字段当真理源，但
 * 「编排迁移到本地 agent-runtime」时漏迁了写入路径，结果 ring 永远不显示。
 * 改成 messages-as-truth 后，未来再次架构变迁也不会让 UI 失能——只要
 * `ChatMessage.metadata` 还在落库就行。
 *
 * ## 字段优先级（单一权威源 + 历史兜底）
 *
 * 一条 assistant 消息的 token 用量按下面的顺序取，**第一个命中的即权威**：
 *
 *   1. **`ChatMessage.usage_json`（权威源）**——服务端落库时由 6-piece
 *      reassembler / `_upsert_chat_message` 写入的 **per-LLM-call 真实 usage**
 *      （`input_tokens` / `cache_read_input_tokens` / `cache_creation_input_tokens`
 *      / `output_tokens`）。每条 assistant 消息天然对应**一次** LLM 调用，所以
 *      它的 `input_tokens` 就是那次调用喂进模型的真实上下文——不存在 turn 累加
 *      虚高的问题，也不需要单独的 `last_*` 字段。这个字段刷新页面 / 切设备 /
 *      历史恢复都在（持久化可靠），是「当前上下文规模」的根本来源。
 *
 *   2. **`ChatMessage.metadata` 的 token 字段（历史兜底）**——仅给两类消息用：
 *      (a) 活态内存消息在落库/回灌前由 `sendMessageAction.onDone` 写入的字段；
 *      (b) `usage_json` 出现之前的历史老消息。读取顺序 `last_*` > turn 累加
 *      `input_tokens`（后者多 LLM 调用 turn 会偏高，标记为 `turn_accum`）。
 *
 * 历史教训：早期实现自己另起炉灶只读 `metadata.last_input_tokens`，但那条
 * 字段**从未落库**（落库走 `usage_json`），导致重开历史对话时环永远回退到
 * 「可见文本粗估」（结构上看不到 system prompt + 工具定义，数字小到离谱）。
 * 收敛到 `usage_json` 后，读写两侧对齐到同一个字段，活态与落库形态一致。
 *
 * ## 百分比分子（只算输入侧）
 *
 * `getCurrentContextTokens` 返回 input + cache_creation + cache_read，**不含
 * output_tokens**——`calculateContextPercentages` 的分子公式。output 是
 * 当前轮模型刚生成的内容，要等下一轮 LLM 调用时才会进入 input。环显示的应该
 * 是「现在已经喂进 LLM 的上下文」而不是「本轮已经产生的 token 总量」。
 *
 * ## 防御式跳过
 *
 * `getCurrentUsage` 会跳过「全 0 的 placeholder usage」——某些第三方 LLM
 * provider 在 message_start 阶段会 emit 全零 usage 占位。如果不跳过，UI 会
 * 在流式开始的瞬间闪一下「ctx:0%」，再切回真实值，体验很糟。
 */

import type { ChatMessage } from '@tabtin/chat-client'
import {
  estimateTokens,
  estimateTextTokens,
  TokenEstimator,
} from '@tabtin/agent-runtime/compact'
import type { Message, ContentBlock, MessageRole } from '@tabtin/agent-runtime/engine'

/**
 * 单一口径出口：文本 token 估算复用 runtime `context-pruning` 的实现
 * （CJK-aware + 4/3 padding），renderer 侧不再自维护一份公式。
 * ChatInput 的草稿增量估算从这里 re-export 取用。
 */
export { estimateTextTokens }

export interface MessageUsage {
  /** 最近一次 LLM 调用的 input tokens（含 system + tools + messages 全部贡献） */
  inputTokens: number
  /** 最近一次 LLM 调用的 cache 命中 input tokens */
  cacheReadInputTokens: number
  /** 最近一次 LLM 调用的 cache 写入 input tokens */
  cacheCreationInputTokens: number
  /** 本 turn / 本消息的 output tokens（只用于 tooltip 展示，不算入上下文窗口占比） */
  outputTokens: number
}

/** 把任意 record 里的数值字段安全取出（非法 / 负数 / NaN → 0）。 */
function safeNum(src: Record<string, unknown>, key: string): number {
  const v = src[key]
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0
}

/**
 * 输入侧全 0（input + cache_read + cache_creation 都是 0）视为无效 placeholder。
 * output 不参与——流式 partial 的 assistant 可能 output>0 但还没真实 input usage。
 */
function isPlaceholderUsage(u: MessageUsage): boolean {
  return (
    u.inputTokens === 0 &&
    u.cacheReadInputTokens === 0 &&
    u.cacheCreationInputTokens === 0
  )
}

function isMainConversationMessage(msg: ChatMessage): boolean {
  return !(msg as ChatMessage & { subagent_run_id?: unknown }).subagent_run_id
}

/**
 * 从 `ChatMessage.usage_json`（**权威源**）提取 usage。
 *
 * usage_json 是服务端落库时写入的 per-LLM-call 真实用量，字段名对齐 Anthropic
 * （snake_case）。每条 assistant 消息 = 一次 LLM 调用，所以 `input_tokens` 就是
 * 那次调用的真实输入侧规模，无需 `last_*` 区分。
 *
 * 返回 `null` 表示没有 usage_json 或它是全 0 placeholder（调用方回退 metadata）。
 */
function extractUsageFromUsageJson(
  usageJson: Record<string, unknown> | null | undefined,
): MessageUsage | null {
  if (!usageJson || typeof usageJson !== 'object') return null
  const usage: MessageUsage = {
    inputTokens: safeNum(usageJson, 'input_tokens'),
    cacheReadInputTokens: safeNum(usageJson, 'cache_read_input_tokens'),
    cacheCreationInputTokens: safeNum(usageJson, 'cache_creation_input_tokens'),
    outputTokens: safeNum(usageJson, 'output_tokens'),
  }
  return isPlaceholderUsage(usage) ? null : usage
}

/**
 * 从 `ChatMessage.metadata`（**历史兜底**）提取 usage：`last_*` 优先于 turn 累加。
 *
 * 仅给两类消息用：活态内存消息（onDone 写入但还没落库回灌）、`usage_json` 出现
 * 之前的老消息。新消息一律走 usage_json 权威源。
 *
 * 返回 `null` 表示无 metadata / 无 token 字段 / placeholder 全 0。
 */
function extractUsageFromMetadata(
  meta: Record<string, unknown> | null | undefined,
): MessageUsage | null {
  if (!meta) return null

  // 优先读 last_*（最近一次 LLM 调用），缺失才回退到 turn 累加值。
  // 注意：不是简单的 `||` 兜底——有 last_input_tokens=0 是 placeholder（应跳过）
  // 而非 fallback。这里用 `typeof === 'number'` 严格判断字段存在与否。
  const hasLastInput = typeof meta.last_input_tokens === 'number'
  const inputTokens = hasLastInput
    ? safeNum(meta, 'last_input_tokens')
    : safeNum(meta, 'input_tokens')

  // cache 字段：如果 last_input 存在但对应 cache 字段缺失，说明该次响应没 cache
  // （一致性来源原则——不能 last_input 用 last 路径、cache 又用 turn 累加）。
  const cacheReadInputTokens = hasLastInput
    ? safeNum(meta, 'last_cache_read_input_tokens')
    : safeNum(meta, 'cache_read_input_tokens')
  const cacheCreationInputTokens = hasLastInput
    ? safeNum(meta, 'last_cache_creation_input_tokens')
    : safeNum(meta, 'cache_creation_input_tokens')

  const usage: MessageUsage = {
    inputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    outputTokens: safeNum(meta, 'output_tokens'),
  }
  return isPlaceholderUsage(usage) ? null : usage
}

/**
 * 从单条 ChatMessage 提取 usage + 可信度来源，按权威源 → 兜底的顺序：
 *
 *   1. `usage_json`（权威，per-call 精确）→ source = 'last_call'
 *   2. `metadata.last_*`（活态/老消息，per-call 精确）→ 'last_call'
 *   3. `metadata.input_tokens`（turn 累加，可能虚高）→ 'turn_accum'
 *
 * 返回 `null` 表示这条消息没有任何真实 usage（非 assistant / 全 placeholder）。
 */
function extractMessageUsageWithSource(
  msg: ChatMessage,
): { usage: MessageUsage; source: 'last_call' | 'turn_accum' } | null {
  if (msg.role !== 'assistant') return null

  // 1) usage_json —— 落库可靠的权威源（per-LLM-call）。
  const fromUsageJson = extractUsageFromUsageJson(
    (msg as ChatMessage & { usage_json?: Record<string, unknown> | null }).usage_json,
  )
  if (fromUsageJson) return { usage: fromUsageJson, source: 'last_call' }

  // 2) metadata —— 历史兜底（活态内存消息 / usage_json 之前的老消息）。
  const meta = msg.metadata as Record<string, unknown> | null | undefined
  const fromMeta = extractUsageFromMetadata(meta)
  if (fromMeta) {
    const hasLastInput = !!meta && typeof meta.last_input_tokens === 'number'
    return { usage: fromMeta, source: hasLastInput ? 'last_call' : 'turn_accum' }
  }

  return null
}

/**
 * 从单条 ChatMessage 提取 usage（权威源 usage_json 优先，metadata 兜底）。
 *
 * 返回 `null` 表示这条消息没有真实 usage（比如不是 assistant、两个源都缺、
 * 或者 placeholder 全 0）。调用方应继续往前找。
 */
function extractMessageUsage(msg: ChatMessage): MessageUsage | null {
  return extractMessageUsageWithSource(msg)?.usage ?? null
}

/**
 * usage 数据的可信度来源——决定 UI 是否展示「估算偏差」提示。
 *
 *   - `last_call`：精确的 per-call usage，无失真。来源有二——权威源 `usage_json`
 *     （落库可靠，重开对话也在），或活态/老消息 `metadata.last_*`。
 *   - `turn_accum`：仅回退到 `metadata.input_tokens`（turn 累加值）。带 tool_use
 *     的多 LLM 调用 turn 中可能比真值高 2-3x。只有既无 usage_json 又无 last_* 的
 *     老消息才会走这条。
 *   - `post_compact`：刚压缩、还没发下一条消息时的即时估算（anchor − tokens_freed），
 *     口径与 anchor 一致（含 system + 工具 schema 开销）；下一次真实调用后自动校准。
 *   - `none`：完全没有 usage 数据（消息为空或仅 placeholder）。
 */
export type UsageSource = 'last_call' | 'turn_accum' | 'post_compact' | 'none'

/** 倒序找最近的压缩检查点（compaction_summary）下标，无则 -1。 */
function findLatestCompactionCheckpointIndex(messages: readonly ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.message_kind === 'compaction_summary') return i
  }
  return -1
}

/**
 * 从压缩检查点的 `metadata.stats` 读出 `tokens_freed` / `tokens_after`。
 *
 * `tokens_freed = tokens_before − tokens_after`（被摘要替换掉的那部分消息 token），
 * 由 runtime 压缩时按估算器算出、落在 compaction_summary 消息 metadata 上（手动
 * `/compact` 与自动压缩两条路径都写）。`tokens_freed <= 0` 视为无有效压缩、返回 null。
 */
function readCompactionStats(
  msg: ChatMessage | undefined,
): { tokensFreed: number; tokensAfter: number } | null {
  const meta = msg?.metadata
  if (!meta || typeof meta !== 'object') return null
  const stats = (meta as Record<string, unknown>).stats
  if (!stats || typeof stats !== 'object') return null
  const freed = (stats as Record<string, unknown>).tokens_freed
  const after = (stats as Record<string, unknown>).tokens_after
  if (typeof freed !== 'number' || !Number.isFinite(freed) || freed <= 0) return null
  const tokensAfter = typeof after === 'number' && Number.isFinite(after) && after >= 0 ? after : 0
  return { tokensFreed: freed, tokensAfter }
}

/**
 * 内部版本——同时返回 usage 与 source。
 *
 * 上层 `getCurrentUsage` / `getCurrentUsageSource` 共享此实现，避免重复倒序遍历。
 *
 * 基线：指示器锚定「最近一次真实 LLM 调用的 input」（system prompt + 工具 schema
 * 是每次调用的固定大头，压缩压不动它）。**例外**：刚压缩、anchor 之后存在压缩检查点
 * 且还没发下一条消息时，标记为 `post_compact`——此时 ring 数字按 anchor − tokens_freed
 * 即时估算（见 `getCurrentContextTokens`），口径仍含固定开销、与下一次真实调用一致。
 */
function getCurrentUsageInternal(
  messages: readonly ChatMessage[],
): { usage: MessageUsage | null; source: UsageSource } {
  const mainMessages = messages.filter(isMainConversationMessage)
  let anchorIdx = -1
  let anchor: { usage: MessageUsage; source: UsageSource } | null = null
  for (let i = mainMessages.length - 1; i >= 0; i--) {
    const msg = mainMessages[i]
    if (!msg) continue
    const result = extractMessageUsageWithSource(msg)
    if (result) {
      anchorIdx = i
      anchor = result
      break
    }
  }
  if (!anchor) return { usage: null, source: 'none' }

  const checkpointIdx = findLatestCompactionCheckpointIndex(mainMessages)
  if (checkpointIdx > anchorIdx && readCompactionStats(mainMessages[checkpointIdx])) {
    return { usage: anchor.usage, source: 'post_compact' }
  }
  return anchor
}

/**
 * 倒序遍历 messages，返回最近一条带真实 usage 的 assistant 消息的 usage。
 *
 * 当前 usage 取值——UI（statusline / tooltip）的真实数据源。
 * 自动跳过 placeholder（全 0 input-side）和无 metadata 的消息。
 *
 * 返回 `null` 表示整个 messages 数组里都没有真实 usage（典型场景：
 * 全新会话尚未发出第一条消息，或所有 assistant 都被 abort 在 stream 开始前）。
 */
export function getCurrentUsage(messages: readonly ChatMessage[]): MessageUsage | null {
  return getCurrentUsageInternal(messages).usage
}

/**
 * 返回当前 ring 数据的来源——`last_call` 表示精确（2026-05-10+），`turn_accum`
 * 表示 fallback 到 turn 累加（老会话或老 runtime，可能偏高 2-3x）。
 *
 * UI 用此值决定是否在 tooltip 里展示「估算偏差」小字提示，以免老用户看到
 * 偏高的 ring 数字误判为「快爆了」就跑去手动压缩。
 */
export function getCurrentUsageSource(messages: readonly ChatMessage[]): UsageSource {
  return getCurrentUsageInternal(messages).source
}

/**
 * 「输入侧」token 总数 = input + cache_creation + cache_read。
 *
 * `calculateContextPercentages` 的分子公式——这是 ring 占用
 * 百分比要除以 `contextWindow` 的那个数。**不含 output_tokens**：output 是模型
 * 当前轮刚生成的内容，要等下一次 LLM 请求才会进入 input。
 */
export function inputSideTokens(usage: MessageUsage): number {
  return (
    usage.inputTokens +
    usage.cacheReadInputTokens +
    usage.cacheCreationInputTokens
  )
}

/** 把任意值安全序列化后追加到文本片段列表（不可序列化则忽略）。 */
function pushSerialized(parts: string[], value: unknown): void {
  if (value == null) return
  if (typeof value === 'string') {
    parts.push(value)
    return
  }
  try {
    parts.push(JSON.stringify(value))
  } catch {
    /* circular / 不可序列化 — 忽略 */
  }
}

/**
 * 把落库态 `ChatMessage` 映射成 runtime `Message`，**只服务 token 估算**。
 *
 * ## 为什么需要这层适配
 *
 * 「上下文用量」的计算公式（CJK 换算 + 4/3 padding + 每条消息固定开销 + 图片
 * token）是 runtime `context-pruning.ts` 的权威实现。要让界面和 agent-runtime
 * 用**同一个口径**，界面就不能再自己写一套字符→token 公式，而是把自己的持久化
 * 结构翻译成 runtime 能吃的 `Message`，交给 runtime 的 `estimateTokens` 算。
 *
 * 本函数是纯粹的**数据形态适配**，不含任何 token 公式——公式只存在于 runtime
 * 一处（改一次，环和压缩判定同步变）。
 *
 * ## 映射规则
 *
 *   - `text` / `thinking` → 文本片段（thinking 文本兼容 `content` 字段位置）。
 *   - `tool_call` / `tool_result` → 工具名 + input + output/content 序列化进文本
 *     （它们都会进下一轮 LLM input）。
 *   - `image` → runtime `ImageBlock`（保留 width/height 供模型族图片 token 估算；
 *     source 仅占位，`rawTokensForMessage` 不读取像素数据）。
 *   - 其余装饰 block（rich_content / file / doc_selection 等）忽略——它们不进
 *     LLM context（widget 的 code 在 runtime 侧也走 llmStripKeys 剥离），忽略
 *     反而与 runtime 的真实 `state.messages` 更对齐。
 *
 * 所有文本片段合并成**单个** text block，让整条消息级别只算一次 CJK 比例，
 * 避免逐 block 混合误差；runtime 的每条消息固定 +4 overhead 仍然生效。
 */
function chatMessageToRuntimeMessage(msg: ChatMessage): Message {
  const role: MessageRole = msg.role === 'assistant' ? 'assistant' : 'user'
  const textParts: string[] = []
  const imageBlocks: ContentBlock[] = []

  const blocks = msg.content_blocks_json
  if (Array.isArray(blocks) && blocks.length > 0) {
    for (const block of blocks) {
      const b = block as Record<string, unknown>
      switch (b.type) {
        case 'text': {
          if (typeof b.text === 'string') textParts.push(b.text)
          break
        }
        case 'thinking': {
          const t = typeof b.thinking === 'string'
            ? b.thinking
            : typeof b.content === 'string'
              ? b.content
              : ''
          if (t) textParts.push(t)
          break
        }
        case 'tool_call':
        case 'tool_result': {
          if (typeof b.tool_name === 'string') textParts.push(b.tool_name)
          pushSerialized(textParts, b.input)
          pushSerialized(textParts, b.output)
          pushSerialized(textParts, b.content)
          break
        }
        case 'image': {
          imageBlocks.push({
            type: 'image',
            source: { type: 'url', url: '' },
            width: typeof b.width === 'number' ? b.width : undefined,
            height: typeof b.height === 'number' ? b.height : undefined,
          })
          break
        }
        default:
          // 装饰 block 不进 LLM context，忽略以对齐 runtime state.messages。
          break
      }
    }
  } else if (typeof msg.content === 'string') {
    textParts.push(msg.content)
  }

  const content: ContentBlock[] = []
  const text = textParts.join('\n')
  if (text.length > 0) content.push({ type: 'text', text })
  content.push(...imageBlocks)
  return { role, content }
}

/**
 * 「当前会话上下文 token 数」（CANONICAL
 * `tokenCountWithEstimation`）：
 *
 *   anchor (最近一条 assistant 的 inputSideTokens)
 * + sum(anchor 之后所有消息的 rough estimate)
 * + draft 输入框未发草稿的 rough estimate（可选）
 *
 * 公式动机：
 *   - 用户刚打字但还没发出 → 已经能在环上看到压力；
 *   - tool_use 后还没等到下一次 LLM 响应 → tool_result 已经能算进去；
 *   - 历史会话恢复 → 直接拿最后一条 assistant 的 usage。
 *
 * 全 messages 都没真实 usage（全新会话）→ 返回纯 estimation，避免环空白。
 *
 * anchor 之后新消息 / 无 anchor 时的整段估算，统一委托 runtime
 * `context-pruning.estimateTokens`（先把 `ChatMessage` 经
 * `chatMessageToRuntimeMessage` 适配成 runtime `Message`）——与 agent-runtime
 * 压缩 / 压力判定同一口径（4/3 padding + 每条消息固定开销 + 模型族图片 token）。
 *
 * @param messages 会话内消息列表（按时间正序）
 * @param draftText 当前输入框未发出的草稿文本（可选）。**用法分工**：
 *   - 在 Electron renderer 中（React 数据流），ChatInput 拿到 input state、
 *     直接调 `estimateTextTokens(input)` 加到从本函数返回值再传给 ring；
 *     `useChatPanelLifecycle` 调本函数时**不传** draftText，避免 hook 强行
 *     往上抽 input state（破坏组件边界）。
 *   - 在 Daemon / CLI / mobile 这种一次性算总 context 的 host 里，调用方
 *     直接传 draftText 一次性拿 final 数值（公式与 ChatInput 等价）。
 *   - 两条路径用同一个 `estimateTextTokens`，CJK 公式一致、产出值等价。
 * @param modelId 当前模型 ID（可选）。用于让 runtime 估算器识别模型族，从而按
 *   OpenAI / Anthropic / Google 各自的算法估图片 token；缺省按 unknown 处理。
 */
export function getCurrentContextTokens(
  messages: readonly ChatMessage[],
  draftText?: string,
  modelId?: string,
): number {
  const mainMessages = messages.filter(isMainConversationMessage)
  // runtime 估算器：只设模型族（决定图片 token 算法）。renderer 是 messages-as-truth
  // 无会话级 EMA 校准态，factor 保持 1.0——anchor 已锚定主体真值，tail 增量对
  // factor 不敏感。
  const estimator = new TokenEstimator()
  if (modelId) estimator.setModel(modelId)

  // 倒序找 anchor（带真实 usage 的最后一条 assistant）。
  let anchorIdx = -1
  let anchorUsage: MessageUsage | null = null
  for (let i = mainMessages.length - 1; i >= 0; i--) {
    const msg = mainMessages[i]
    if (!msg) continue
    const usage = extractMessageUsage(msg)
    if (usage) {
      anchorIdx = i
      anchorUsage = usage
      break
    }
  }

  let total = 0
  if (anchorUsage) {
    let base = inputSideTokens(anchorUsage)
    // anchor 之后默认从 anchorIdx+1 起做增量估算。
    let tailStartIdx = anchorIdx + 1

    // 压缩即时反映：anchor 之后存在压缩检查点且还没发下一条真实消息时，
    // base 扣掉本次释放的 token（anchor − tokens_freed）。
    //   - anchor.input 已含 system+tools+压缩前全部消息；tokens_freed = 被摘要
    //     替换掉的那部分消息 token → 扣掉后 ≈ system+tools+摘要+保留消息，口径
    //     与下一次真实调用一致（不再是老 post_compact 那种 messages-only 估算）。
    //   - 检查点之前的消息（被压缩/被保留）已由 base 表达，tail 从检查点之后起算，
    //     避免把它们重复加回；检查点之后只有真正的新消息。
    //   - 下一次真实调用产生带 usage 的 assistant 后，anchor 越过检查点，此分支
    //     不再命中，自动切回真实值。
    const checkpointIdx = findLatestCompactionCheckpointIndex(mainMessages)
    if (checkpointIdx > anchorIdx) {
      const stats = readCompactionStats(mainMessages[checkpointIdx])
      if (stats) {
        base = Math.max(base - stats.tokensFreed, stats.tokensAfter)
        tailStartIdx = checkpointIdx + 1
      }
    }

    total += base
    // tail 段（用户新发的、tool_result、刚 stream 的 assistant 等）——委托 runtime
    // 估算，口径与压缩 / 压力判定一致。
    const tail = mainMessages.slice(tailStartIdx).map(chatMessageToRuntimeMessage)
    total += estimateTokens(tail, estimator)
  } else {
    // 没 anchor → 整个会话都走 runtime 估算。
    const all = mainMessages.map(chatMessageToRuntimeMessage)
    total += estimateTokens(all, estimator)
  }

  if (draftText) {
    total += estimateTextTokens(draftText)
  }

  return total
}

// ─── 内部测试导出 ──────────────────────────────────────────────────────
// 仅给单测用；不出现在公共 API 文档里
export const __testOnly = {
  extractMessageUsage,
  chatMessageToRuntimeMessage,
}
