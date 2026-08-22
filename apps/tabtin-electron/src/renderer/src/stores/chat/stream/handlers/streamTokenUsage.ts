/**
 * streamTokenUsage —— 流式期间 token 用量实时同步。
 *
 * ## 背景
 *
 * 一个 turn 内 runtime 每次 LLM 调用结束都会 emit `message_delta` + usage
 * （cumulative，Anthropic 语义），但此前展示层只在 `agent.stream.done` /
 * lifecycle.end 才写 `ChatMessage.usage_json` 与 session 累计字段——多轮
 * tool loop 的长 turn 里 TokenUsageRing 完全不动，直到整轮结束数字才一起跳。
 *
 * ## 两条同步路径（语义不同，分开处理）
 *
 * 1. **上下文用量环（per-call）**：`message_delta.usage` 就是该次 LLM 调用的
 *    真实用量，与服务端 relay 落库到 `ChatMessage.usage_json` 的是同一份数据
 *    （`relay_message_writer` 亦从 message_delta 写入）。这里把它实时写到活态
 *    assistant 消息的 `usage_json` 上，`chatMessageContextUsage` 的 anchor
 *    查找即刻命中——上下文环每次 LLM 调用结束就刷新，且活态与落库形态一致。
 *
 * 2. **会话累计（input/output/total）**：session 字段是跨 turn 的累加值。
 *    流式期间按 per-message 正向增量累加进 session 缓存（cumulative 语义下
 *    重复事件增量为 0，天然免疫 IPC+WS 双路重放）；DONE 到达时以
 *    `DONE.usage`（BudgetTracker per-run 权威值，含子 Agent 分摊）为准做
 *    差额校正——只补 `done - 流式已加` 的部分，不双计。
 *
 * ## DONE 幂等
 *
 * 发起端 DONE 会被处理两次（`sendMessageAction.onDone` 回调 + streamMessageHandler
 * → miscHandler），观察端只有 miscHandler 一次。两处统一调 `applyDoneUsage`，
 * 以 DONE payload 的 `trace_id`（与 run_id 同源，本地 runtime 所有终态路径都带）
 * 做幂等键，先到先处理。无 trace_id 的历史云端路径只由 onDone 调（不传 key），
 * 保持原单点行为。
 */

import type { MessageUsage } from '@tabtin/agent-wire'
import type { ChatMessage } from '@tabtin/chat-client'
import { useChatStore } from '@/stores/chat/useChatStore'
import { extractChatSessionTokenUsage } from '@/utils/chatSessionTokenUsage'

interface TokenTuple {
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
}

const ZERO_TUPLE: TokenTuple = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }

/** 每 session 保留的已处理 DONE 幂等键数量（同 session 短时间内 run 数远小于此）。 */
const APPLIED_DONE_KEYS_PER_SESSION = 8

/** per-message 最近一次看到的 cumulative usage（算正向增量用）。 */
const lastSeenByMessage = new Map<string, Map<string, TokenTuple>>()

/** 本 run 流式期间已实时累加进 session 缓存的量（DONE 校正时消费）。 */
const streamedBySession = new Map<string, TokenTuple>()

/** 已应用过 DONE 校正的幂等键（按 session 保留最近 N 个）。 */
const appliedDoneKeysBySession = new Map<string, string[]>()

function safeNonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

/**
 * 流式期间消费 `message_delta.usage`：
 *   1. 把 per-call usage 写到该 assistant 消息的 `usage_json`（驱动上下文环）；
 *   2. 按正向增量累加 session 缓存的 input/output/total（驱动会话累计）。
 *
 * usage 是单次 LLM 调用内的 cumulative 值——同一 message 的重复 / 乱序事件
 * 增量 ≤ 0，直接跳过，无需依赖上游去重。
 */
export function applyStreamingMessageDeltaUsage(
  sessionId: string,
  messageId: string,
  usage: MessageUsage,
): void {
  const inputTokens = safeNonNegative(usage.input_tokens)
  const outputTokens = safeNonNegative(usage.output_tokens)
  const cacheRead = safeNonNegative(usage.cache_read_input_tokens)
  const cacheCreation = safeNonNegative(usage.cache_creation_input_tokens)

  // ── 1) usage_json 实时写入（上下文环 anchor）──
  // 输入侧全 0 是 placeholder（部分 provider 在流开始时 emit 全零占位），
  // 与 `chatMessageContextUsage.isPlaceholderUsage` 同口径跳过，避免环闪 0。
  if (inputTokens + cacheRead + cacheCreation > 0) {
    useChatStore.getState().patchMessageById(sessionId, messageId, (msg): ChatMessage =>
        msg.role === 'assistant'
          ? {
              ...msg,
              usage_json: {
                input_tokens: inputTokens,
                cache_read_input_tokens: cacheRead,
                cache_creation_input_tokens: cacheCreation,
                output_tokens: outputTokens,
              },
            }
          : msg,
    )
  }

  // ── 2) session 累计增量（input / output / cache 各自单调累加，计费单价不同）──
  let perMessage = lastSeenByMessage.get(sessionId)
  if (!perMessage) {
    perMessage = new Map()
    lastSeenByMessage.set(sessionId, perMessage)
  }
  const lastSeen = perMessage.get(messageId) ?? ZERO_TUPLE
  const delta: TokenTuple = {
    input: Math.max(0, inputTokens - lastSeen.input),
    output: Math.max(0, outputTokens - lastSeen.output),
    cacheRead: Math.max(0, cacheRead - lastSeen.cacheRead),
    cacheCreation: Math.max(0, cacheCreation - lastSeen.cacheCreation),
  }
  perMessage.set(messageId, {
    input: Math.max(lastSeen.input, inputTokens),
    output: Math.max(lastSeen.output, outputTokens),
    cacheRead: Math.max(lastSeen.cacheRead, cacheRead),
    cacheCreation: Math.max(lastSeen.cacheCreation, cacheCreation),
  })
  if (delta.input === 0 && delta.output === 0 && delta.cacheRead === 0 && delta.cacheCreation === 0) return

  const streamed = streamedBySession.get(sessionId) ?? ZERO_TUPLE
  streamedBySession.set(sessionId, {
    input: streamed.input + delta.input,
    output: streamed.output + delta.output,
    cacheRead: streamed.cacheRead + delta.cacheRead,
    cacheCreation: streamed.cacheCreation + delta.cacheCreation,
  })
  addToSessionTokenCaches(sessionId, delta)
}

/**
 * DONE 到达时以 per-run 权威 usage 做差额校正（幂等）。
 *
 * `DONE.usage` 是 BudgetTracker 的本 run 增量（含子 Agent / retry 等流式路径
 * 看不到的部分）；流式期间已实时加过的量从中扣除，只补差额——session 缓存
 * 最终值与「老行为一次性加 DONE.usage」一致，且不双计。
 *
 * @param doneKey DONE payload 的 `trace_id`。传入时做跨调用点幂等（onDone 与
 *   miscHandler 谁先到谁生效）；undefined 表示上游确认单点调用（历史云端路径），
 *   直接应用。
 */
export function applyDoneUsage(
  sessionId: string,
  doneKey: string | undefined,
  usage: {
    input_tokens?: unknown
    output_tokens?: unknown
    cache_read_input_tokens?: unknown
    cache_creation_input_tokens?: unknown
  },
): void {
  if (doneKey !== undefined) {
    const applied = appliedDoneKeysBySession.get(sessionId) ?? []
    if (applied.includes(doneKey)) return
    appliedDoneKeysBySession.set(
      sessionId,
      [...applied, doneKey].slice(-APPLIED_DONE_KEYS_PER_SESSION),
    )
  }

  // 消费并清空本 run 的流式累加记录。极端场景（DONE 丢失后下一 run 的 DONE
  // 才消费到残留）差额会偏小，由 lifecycle.end 的 GET session 服务端真值
  // 单调刷新兜底——不会虚高。
  const streamed = streamedBySession.get(sessionId) ?? ZERO_TUPLE
  streamedBySession.delete(sessionId)
  lastSeenByMessage.delete(sessionId)

  const add: TokenTuple = {
    input: Math.max(0, safeNonNegative(usage.input_tokens) - streamed.input),
    output: Math.max(0, safeNonNegative(usage.output_tokens) - streamed.output),
    cacheRead: Math.max(0, safeNonNegative(usage.cache_read_input_tokens) - streamed.cacheRead),
    cacheCreation: Math.max(0, safeNonNegative(usage.cache_creation_input_tokens) - streamed.cacheCreation),
  }
  if (add.input === 0 && add.output === 0 && add.cacheRead === 0 && add.cacheCreation === 0) return
  addToSessionTokenCaches(sessionId, add)
}

/** 读当前 session 缓存值 + 增量后走单调写入（`Math.max` 防 race 回滚）。 */
function addToSessionTokenCaches(sessionId: string, add: TokenTuple): void {
  const store = useChatStore.getState()
  const session = store.sessions.find(s => s.id === sessionId)
  const prev = session ? extractChatSessionTokenUsage(session) : {}
  const prevIn = safeNonNegative(prev.input_tokens)
  const prevOut = safeNonNegative(prev.output_tokens)
  const prevTotal = safeNonNegative(prev.total_tokens)
  const prevCacheRead = safeNonNegative(prev.cache_read_input_tokens)
  const prevCacheCreation = safeNonNegative(prev.cache_creation_input_tokens)
  store.updateSessionTokenUsageInCaches(sessionId, {
    input_tokens: prevIn + add.input,
    output_tokens: prevOut + add.output,
    // total 仅 input+output（非 cache）——cache 单价不同，单列不并入合计。
    total_tokens: prevTotal + add.input + add.output,
    cache_read_input_tokens: prevCacheRead + add.cacheRead,
    cache_creation_input_tokens: prevCacheCreation + add.cacheCreation,
  })
}

/**
 * 会话终态清理（`cleanupSessionOnTerminal` 调用）——兜住「run 没有 DONE 就
 * 终止」的残留：daemon crash / watchdog stall / stream 层 catch 等路径不会
 * 走 `applyDoneUsage`，`streamedBySession` 残留会让下一 run 的 DONE 差额被
 * 多扣（显示偏低）。正常路径 DONE 先于 lifecycle 终态到达、已消费并清空，
 * 本清理为 no-op。
 *
 * 不清 `appliedDoneKeysBySession`：幂等键要跨终态保留，拦迟到重放的 DONE。
 */
export function clearStreamTokenUsageForSession(sessionId: string): void {
  lastSeenByMessage.delete(sessionId)
  streamedBySession.delete(sessionId)
}

/** 单测专用：清空模块内状态。 */
export function __resetStreamTokenUsageForTests(): void {
  lastSeenByMessage.clear()
  streamedBySession.clear()
  appliedDoneKeysBySession.clear()
}
