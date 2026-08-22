/**
 * 跨 Agent 历史发言归属注解——会话策略，落在 host。
 *
 * 同会话换了执行者时，给「非当前 Agent」的历史 assistant **之前**插一条
 * 独立的 user-role `<system-reminder>`（含展示名），避免模型把别人的回复
 * 当成自己说的。
 *
 * **不做**：
 *  - 不改 assistant 正文；
 *  - 不把 agentId 写进 runtime blocks / 跨轮 history；
 *  - 不改 agent-runtime 的 reconstruct / replay（对齐逻辑全在本模块）；
 *  - 归属来自 host `message-agent-attribution-store`（persist 时记账）；
 *  - 展示名由 `resolveAgentName` 解析，缺省「另一位 Agent」。
 *
 * **对齐**：收集 meta 时用与 `buildReplayHistoryFromTranscript` 相同的
 * 「模型可见」过滤（跳过 thinking-only / 非模型块），再与 initialMessages
 * 的 assistant **按下标**对齐。条数不一致则 fail-closed（整批不注入）。
 *
 * 调用点在 `buildInitialMessages` 之后（host pipeline，非 runtime hook）。
 */

import type { ContentBlock, Message, MessageBlockRecord } from '@tabtin/agent-runtime'
import {
  EXCLUDED_FROM_LLM_HISTORY_MESSAGE_KINDS,
} from '@tabtin/agent-runtime/history'
import {
  INTERNAL_MESSAGE_MARKERS,
  setInternalMarker,
} from '@tabtin/agent-runtime/engine'
import { resolveMessageAgentAttribution } from './message-agent-attribution-store.js'

/** 本 host 注入文案的稳定短语（仅 host 拥有）。 */
const TURN_IDENTITY_REMINDER_PHRASE = '不代表当前执行者身份'

export interface InjectTurnIdentityOptions {
  /** 当前轮执行者。有值时只给 agentId ≠ 当前的历史 assistant 加注解。 */
  currentAgentId?: string
  /** 按历史 agentId 解析展示名；不传或解析失败 →「另一位 Agent」。 */
  resolveAgentName?: (agentId: string) => string | undefined
  /**
   * 按 message_id 取归属；默认读 host attribution store。
   * 测试可注入。
   */
  resolveAgentIdForMessage?: (messageId: string) => string | undefined
}

function shouldInjectTurnIdentity(
  historyAgentId: string | undefined,
  currentAgentId: string | undefined,
): historyAgentId is string {
  if (!historyAgentId) return false
  if (!currentAgentId) return true
  return historyAgentId !== currentAgentId
}

function buildTurnIdentityReminder(agentName?: string): Message {
  const trimmedName = typeof agentName === 'string' ? agentName.trim() : ''
  const attribution = trimmedName
    ? `「${trimmedName}」`
    : '另一位 Agent'
  return setInternalMarker(
    {
      role: 'user',
      content: [{
        type: 'text',
        text: [
          '<system-reminder>',
          `以下 assistant 历史回复由${attribution}生成，${TURN_IDENTITY_REMINDER_PHRASE}。`,
          '</system-reminder>',
        ].join('\n'),
      }],
    },
    INTERNAL_MESSAGE_MARKERS.HISTORICAL_CONTEXT,
  )
}

export interface AssistantIdentityMeta {
  messageId: string
  inject: boolean
  agentId?: string
}

/**
 * 与 replay `toModelVisibleBlock` + 丢 thinking 同口径：该 block 是否仍进 LLM 历史。
 * 只服务 host 对齐，不进 runtime。
 */
function isReplayVisibleAssistantBlock(block: ContentBlock): boolean {
  switch (block.type) {
    case 'text':
      return typeof (block as { text?: unknown }).text === 'string'
    case 'tool_use':
      return typeof (block as { id?: unknown }).id === 'string'
        && typeof (block as { name?: unknown }).name === 'string'
    case 'image':
    case 'video':
      return Boolean((block as { source?: unknown }).source)
        && typeof (block as { source?: unknown }).source === 'object'
    case 'thinking':
    case 'tool_result':
      return false
    default:
      return false
  }
}

/** 该 assistant record 经 reconstruct+replay 后是否仍会出现在 history。 */
function isReplayVisibleAssistantRecord(record: MessageBlockRecord): boolean {
  if (record.role !== 'assistant') return false
  return record.blocks_json.some(
    (block) => block.type !== 'tool_result' && isReplayVisibleAssistantBlock(block),
  )
}

/**
 * 按 reconstruct + replay 可见性扫描 records，用 host 索引取 agentId。
 * 序与 initialMessages 里的 assistant 对齐（条数须一致，否则 inject fail-closed）。
 */
export function collectAssistantIdentityMetaFromBlocks(
  records: MessageBlockRecord[],
  currentAgentId: string | undefined,
  resolveAgentId: (messageId: string) => string | undefined,
): AssistantIdentityMeta[] {
  const meta: AssistantIdentityMeta[] = []

  for (const record of records) {
    if (record.subagent_run_id) continue
    if (EXCLUDED_FROM_LLM_HISTORY_MESSAGE_KINDS.has(record.message_kind)) continue

    if (record.compaction_boundary) {
      meta.length = 0
      continue
    }

    if (!isReplayVisibleAssistantRecord(record)) continue

    const agentId = resolveAgentId(record.message_id)
    meta.push({
      messageId: record.message_id,
      inject: shouldInjectTurnIdentity(agentId, currentAgentId),
      agentId,
    })
  }

  return meta
}

/**
 * 在已拼装的 initialMessages 上注入跨 Agent 身份注解。
 *
 * @param messages `buildInitialMessages`（或等价）之后的 Message[]
 * @param records 同会话 block records（只用于可见性序 / message_id，不读 agent 字段）
 */
export function injectTurnIdentity(
  messages: Message[],
  records: MessageBlockRecord[],
  options?: InjectTurnIdentityOptions,
): Message[] {
  if (messages.length === 0 || records.length === 0) return messages

  const resolveAgentId = options?.resolveAgentIdForMessage
    ?? resolveMessageAgentAttribution
  const meta = collectAssistantIdentityMetaFromBlocks(
    records,
    options?.currentAgentId,
    resolveAgentId,
  )
  if (meta.length === 0 || !meta.some((m) => m.inject)) return messages

  const assistantCount = messages.reduce(
    (n, m) => (m.role === 'assistant' ? n + 1 : n),
    0,
  )
  // fail-closed：可见性过滤与真实 initialMessages 不一致时宁可不注，避免错标
  if (meta.length !== assistantCount) return messages

  const resolveName = options?.resolveAgentName
  const out: Message[] = []
  let assistantIdx = 0

  for (const msg of messages) {
    if (msg.role === 'assistant') {
      const info = meta[assistantIdx++]
      if (info?.inject) {
        const name = info.agentId && resolveName
          ? resolveName(info.agentId)
          : undefined
        out.push(buildTurnIdentityReminder(name))
      }
    }
    out.push(msg)
  }

  return out
}
