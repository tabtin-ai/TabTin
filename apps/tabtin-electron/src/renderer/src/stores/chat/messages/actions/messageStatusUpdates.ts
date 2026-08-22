/**
 * 发送生命周期里对消息列表的**状态写入**与终态判定（原 sendMessageHelpers 拆出）。
 *
 * 都是对 `ChatMessage[]` 做纯变换 / 通过注入的 updater 落地：标记发送成功 / 失败、
 * ACK 后回填服务端 id、拼接 assistant 错误详情、识别 abort 类错误。
 */
import type { ChatMessage } from '@tabtin/chat-client'
import { getClientMessageId } from '@/stores/chat/domain/messageIdentity'
import type { LocalChatMessage } from '../../shared/types'

export function appendAssistantErrorDetails(
  existingContent: string | undefined,
  details: Array<string | undefined>,
): string {
  const baseContent = existingContent ?? ''
  const normalizedBase = baseContent.trimEnd()
  const nextDetails = details
    .map(detail => detail?.trim())
    .filter((detail): detail is string => Boolean(detail))
    .filter(detail => !normalizedBase.includes(detail))

  if (!normalizedBase) {
    return nextDetails.join('\n\n')
  }
  if (nextDetails.length === 0) {
    return normalizedBase
  }
  return `${normalizedBase}\n\n---\n\n${nextDetails.join('\n\n')}`
}

export function markMessageFailed(
  sessionId: string,
  userMsgId: string,
  aiMsgId: string,
  currentStreamContent: string,
  updateMsgs: (
    sessionId: string,
    updater: (messages: ChatMessage[]) => ChatMessage[],
  ) => void,
  aiUpdate: (msg: ChatMessage) => ChatMessage,
  options?: {
    /**
     * 用户消息落什么状态。默认 'failed'（派发失败：runtime 从未接收，重试安全）。
     *  补充：runtime 已接收本条消息（收到过本 run 任何流事件）后的错误传
     * 'sent'——消息实际已送达执行，失败的是 Agent 回复（由 assistant 错误卡片
     * 表达）；标 failed 会诱导用户点「重试」重复执行已跑过的指令。
     */
    userSendStatus?: 'failed' | 'sent'
  },
): void {
  const userSendStatus = options?.userSendStatus ?? 'failed'
  updateMsgs(sessionId, prev => {
    const result: ChatMessage[] = []
    for (const m of prev) {
      if (m.id === userMsgId) {
        result.push({ ...m, sendStatus: userSendStatus } as ChatMessage)
      } else if (m.id === aiMsgId && m.role === 'assistant') {
        const hasContent = !!(currentStreamContent || m.content)
        if (!hasContent && m.id.startsWith('temp-ai-')) continue
        result.push(aiUpdate(m))
      } else {
        result.push(m)
      }
    }
    return result
  })
}

/** IPC / AbortController 取消：只认 Error.name，不认文案子串。 */
export function isAbortLikeError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const name = (error as { name?: unknown }).name
  return name === 'AbortError' || name === 'IpcStreamAbortedError'
}

/**
 * send() reject 后用户气泡 sendStatus 的决策点。
 * host `kind:aborted` → ACK `{ aborted:true }` → LocalAgentClient 抛
 * IpcStreamAbortedError；流侧 terminal aborted 同名。勿把空 error 的
 * Unknown error 当取消（那是旧 ACK 契约漏洞）。
 */
export function resolveUserSendStatusOnSendRejection(
  error: unknown,
  alreadyDelivered: boolean,
): 'sent' | 'failed' {
  if (alreadyDelivered || isAbortLikeError(error)) return 'sent'
  return 'failed'
}

export function markUserMessageSubmitted(
  sessionId: string,
  userMsgId: string,
  serverMsgId: string | null | undefined,
  updateMsgs: (
    sessionId: string,
    updater: (messages: ChatMessage[]) => ChatMessage[],
  ) => void,
): void {
  updateMsgs(sessionId, prev => prev.map(msg => {
    if (msg.id !== userMsgId) return msg
    const next = { ...msg, sendStatus: 'sent' } as ChatMessage
    return serverMsgId ? { ...next, id: serverMsgId } : next
  }))
}

/**
 * Host 焊在 lifecycle / DONE 上的用户提交身份。
 * 契约见 `packages/agent-host/src/delivery/source-event-correlation.ts`：
 * runtime 的 run_id / trace_id 是执行身份，不能用来匹配用户气泡。
 */
export function resolveSourceClientEventId(
  payload: Record<string, unknown> | null | undefined,
): string | undefined {
  const value = payload?.source_client_event_id
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * 用户消息已送达执行（lifecycle start / DONE）：按 client 身份键标 sent。
 * 单一入口，经公开 patchMessageById 写入，不碰私有 updateSessionMessages。
 * ：调用方必须传入 source_client_event_id，禁止传 run_id / trace_id。
 */
export function markUserMessageDelivered(
  sessionId: string,
  sourceClientEventId: string,
  deps: {
    getMessages: () => ChatMessage[]
    patchMessageById: (
      sessionId: string,
      messageId: string,
      patcher: (message: ChatMessage) => ChatMessage,
    ) => void
  },
): void {
  for (const msg of deps.getMessages()) {
    if (msg.role !== 'user') continue
    if (msg.id !== sourceClientEventId && getClientMessageId(msg) !== sourceClientEventId) {
      continue
    }
    if ((msg as LocalChatMessage).sendStatus === 'sent') continue
    deps.patchMessageById(sessionId, msg.id, (current) => (
      { ...current, sendStatus: 'sent' } as LocalChatMessage
    ))
  }
}

export function markPersistedUserMessage(
  messages: ChatMessage[],
  previousId: string,
  clientMessageId: string,
  serverId: string,
): ChatMessage[] {
  return messages.map((message) => {
    if (message.role !== 'user') return message
    const matchesClientMessage = message.id === clientMessageId
      || getClientMessageId(message) === clientMessageId
    if (message.id !== previousId && !matchesClientMessage) return message
    return { ...message, id: serverId, sendStatus: 'sent' } as LocalChatMessage
  })
}
