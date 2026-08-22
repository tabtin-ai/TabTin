/**
 *  本机待发 user 草稿 — 唯一 SSoT。
 *
 * 产品口径：点发送后正文留在发送区 loading，**不上**主时间线；
 * Host ACK `started` 才插入时间线并清空发送区；`queued` 进 HostPending 抽屉。
 * 复用已有 failed 气泡（existingClientMessageId）时除外——那条已在时间线上。
 */

import type { ChatClient, ChatMessage, ChatSession, MessageBlock } from '@tabtin/chat-client'
import type { ChatAttachment } from '../../../../components/chat/types'
import type { AgentModeName, LocalChatMessage } from '../../shared/types'
import { applyBlocksArrival } from '@/stores/chat/domain/messageTimelineOrder'
import { getClientMessageId } from '@/stores/chat/domain/messageIdentity'
import { buildUserVisibleBlocks } from '../actions/buildUserVisibleBlocks'
import { requestTitleGenerationOnSend } from '../actions/titleGenerationDedupe'
import { applyAttachmentsToHostPendingUserMessage } from '../hostPending/hostPendingSendSlice'
import type { SendMessageOptions } from '../actions/sendMessageTypes'
import { trackSendTimingTelemetry, type SendTimingTrace } from '../../execution/sendTimingTrace'
import i18n from '@/i18n'

export type PendingUserSend = {
  readonly clientMessageId: string
  readonly userMessageId: string
  readonly displayMessage: string
  readonly replyTo: SendMessageOptions['replyTo']
  /** 编辑重发等：时间线上已有同 id 气泡 */
  readonly reusedExisting: boolean
  get draft(): LocalChatMessage
  get onTimeline(): boolean
  /** 附件 ready 后只改内存 draft（发送区持稿期间不上时间线）。 */
  applyReadyAttachments: (ready: ChatAttachment[]) => void
  /** 解析后的 agentMode 写入 draft metadata。 */
  patchAgentMode: (agentMode: AgentModeName) => void
  /**
   * ACK 出口：
   * - started → 首次上屏（或同步已有气泡）
   * - queued → 不上主时间线，返回 draft 给 HostPending
   */
  applyAck: (
    disposition: 'started' | 'queued',
    agentMode: AgentModeName,
  ) => { kind: 'queued'; userMessage: LocalChatMessage } | { kind: 'started' }
}

type CreatePendingUserSendParams = {
  sessionId: string
  message: string
  visibleMessage: string
  attachments?: ChatAttachment[]
  contextBlocks?: Array<Record<string, unknown>>
  options?: SendMessageOptions
  existingMessages: ChatMessage[]
  sendTimingTrace?: SendTimingTrace
  updateSessionMessages: (
    sessionId: string,
    updater: (messages: ChatMessage[]) => ChatMessage[],
  ) => void
  getMessages: () => ChatMessage[]
  getChatClient: () => ChatClient
  getSession: () => ChatSession | null
}

function buildDraft(params: CreatePendingUserSendParams) {
  const {
    message,
    visibleMessage,
    attachments,
    contextBlocks,
    options,
    existingMessages,
  } = params

  const hasAttachments = Boolean(attachments && attachments.length > 0)
  const reusedClientMessageId = options?.existingClientMessageId
  const existingOptimistic = reusedClientMessageId
    ? existingMessages.find((m) => (
        m.id === reusedClientMessageId
        || getClientMessageId(m) === reusedClientMessageId
      ))
    : undefined
  // 已有气泡构造时盖 arrival；本机/远控首发等 applyAck('started') 上屏时再盖。
  const stampArrival = Boolean(existingOptimistic)
  const clientMessageId = existingOptimistic
    ? (getClientMessageId(existingOptimistic) ?? existingOptimistic.id)
    : crypto.randomUUID()
  const userMessageId = clientMessageId
  const isWidgetPrompt = options?.source === 'widget'
  const displayMessage = isWidgetPrompt
    ? i18n.t('chat:widgetSendPrompt.userMessagePrefix', {
        defaultValue: `用户点击 widget 发送：${visibleMessage}`,
        text: visibleMessage,
      })
    : visibleMessage

  const builtUserBlocks = buildUserVisibleBlocks(
    displayMessage,
    contextBlocks as MessageBlock[] | undefined,
  )
  const userBlocks = stampArrival
    ? applyBlocksArrival(builtUserBlocks)
    : builtUserBlocks

  const replyTo = options?.replyTo
  const userMessage: LocalChatMessage = {
    id: userMessageId,
    role: 'user',
    content: displayMessage,
    created_at: existingOptimistic?.created_at ?? new Date().toISOString(),
    sendStatus: 'sending',
    content_blocks_json: userBlocks,
    ...(replyTo ? {
      reply_to_message_id: replyTo.messageId,
      reply_to_preview: replyTo.preview,
    } : {}),
    attachments_json: hasAttachments
      ? attachments!.map(a => ({
          type: a.type as 'image' | 'file' | 'video',
          filename: a.filename,
          mime_type: a.mimeType,
          size: a.size,
        }))
      : undefined,
    metadata: {
      client_message_id: clientMessageId,
      ...(options?.triggeredBy ? { triggered_by: options.triggeredBy } : {}),
      ...(options?.source ? { source: options.source } : {}),
      ...(isWidgetPrompt ? {
        via_widget: true,
        widget_id: options?.widgetId,
        widget_meta: options?.widgetMeta,
        widget_triggered_at: options?.widgetTriggeredAt,
        raw_text: visibleMessage,
      } : {}),
      ...(options?.displayMessage && options.displayMessage !== message ? {
        raw_text: visibleMessage,
        effective_text_kind: 'skill_slash_command',
      } : {}),
    },
  }

  return {
    clientMessageId,
    userMessageId,
    displayMessage,
    existingOptimistic,
    userMessage,
    replyTo,
  }
}

function withAgentMode(msg: LocalChatMessage, agentMode: AgentModeName): LocalChatMessage {
  if (agentMode === 'agent') return msg
  return { ...msg, metadata: { ...msg.metadata, agentMode } }
}

/** 本轮发送的待发草稿：发送区持稿，ACK 后再上屏。 */
export function createPendingUserSend(
  params: CreatePendingUserSendParams,
): PendingUserSend {
  const built = buildDraft(params)
  const {
    sessionId,
    updateSessionMessages,
    attachments,
    contextBlocks,
    sendTimingTrace,
  } = params
  const { clientMessageId, userMessageId, displayMessage, existingOptimistic, replyTo } = built

  let draft: LocalChatMessage = built.userMessage
  // 复用已有气泡视为已在时间线；普通首发为 false，等 ACK started。
  let onTimeline = Boolean(existingOptimistic)

  const scheduleTitleGeneration = () => {
    const trimmed = displayMessage.trim()
    if (!trimmed) return
    requestTitleGenerationOnSend({
      sessionId,
      userMessage: trimmed,
      getMessages: params.getMessages,
      getChatClient: params.getChatClient,
      getSession: params.getSession,
    })
  }

  const insertOrReplace = (msg: LocalChatMessage) => {
    if (existingOptimistic) {
      updateSessionMessages(sessionId, (prev) => prev.map((m) => (
        m.id === existingOptimistic.id || getClientMessageId(m) === clientMessageId
          ? { ...msg, id: m.id }
          : m
      )))
      onTimeline = true
      scheduleTitleGeneration()
      return
    }

    let inserted = false
    updateSessionMessages(sessionId, (prev) => {
      const idx = prev.findIndex((m) => (
        m.id === clientMessageId || getClientMessageId(m) === clientMessageId
      ))
      if (idx >= 0) {
        const next = [...prev]
        next[idx] = { ...msg, id: prev[idx]!.id }
        return next
      }
      inserted = true
      return [...prev, msg]
    })
    if (inserted) {
      trackSendTimingTelemetry('message.send.user_visible', {
        sessionId,
        userMessageId,
        hasAttachments: Boolean(attachments && attachments.length > 0),
        hasContextBlocks: Boolean(contextBlocks && contextBlocks.length > 0),
      }, sendTimingTrace, {
        counterKey: 'message.send.user_visible',
        sessionId,
      })
    }
    onTimeline = true
    scheduleTitleGeneration()
  }

  const syncDraftOntoTimeline = () => {
    if (!onTimeline) return
    updateSessionMessages(sessionId, (prev) =>
      prev.map((msg) => {
        if (msg.id !== userMessageId && getClientMessageId(msg) !== clientMessageId) return msg
        return { ...draft, id: msg.id }
      }),
    )
  }

  return {
    clientMessageId,
    userMessageId,
    displayMessage,
    replyTo,
    reusedExisting: Boolean(existingOptimistic),
    get draft() {
      return draft
    },
    get onTimeline() {
      return onTimeline
    },
    applyReadyAttachments: (ready) => {
      draft = applyAttachmentsToHostPendingUserMessage(draft, ready)
      syncDraftOntoTimeline()
    },
    patchAgentMode: (agentMode) => {
      draft = withAgentMode(draft, agentMode)
      syncDraftOntoTimeline()
    },
    applyAck: (disposition, agentMode) => {
      draft = withAgentMode(draft, agentMode)
      if (disposition === 'queued') {
        // 不上主时间线；若曾复用已有气泡也不撤（编辑重发排队属罕见，保持原气泡）。
        return { kind: 'queued', userMessage: draft }
      }
      // 首次上屏盖 arrival（本机 / 远控均为 ACK started 后）。
      const blocks = draft.content_blocks_json
      if (blocks?.length && !blocks.some((b) => typeof (b as { arrival_seq?: unknown }).arrival_seq === 'number')) {
        draft = { ...draft, content_blocks_json: applyBlocksArrival(blocks) }
      }
      insertOrReplace(draft)
      return { kind: 'started' }
    },
  }
}

/** @deprecated 使用 createPendingUserSend */
export const createOptimisticUserSend = createPendingUserSend
export type OptimisticUserSend = PendingUserSend
