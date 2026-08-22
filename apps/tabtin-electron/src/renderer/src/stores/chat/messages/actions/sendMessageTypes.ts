import type { ChatClient, ChatMessage, ChatSession } from '@tabtin/chat-client'
import type { ChatAttachment } from '../../../../components/chat/types'
import type {
  AgentModeName,
  ApprovalModeName,
  ApprovalRequestState,
  AskUserRequestState,
} from '../../shared/types'
import type { SendTimingTrace } from '../../execution/sendTimingTrace'
import type { ChatSessionTokenUsage } from '@/utils/chatSessionTokenUsage'

import type { HostPendingSendStore } from '../hostPending/hostPendingSendSlice'

export interface SendMessageStore extends HostPendingSendStore {
  currentSessionId: string | null
  agentMode: AgentModeName
  /**  历史兼容：旧版审批档全局默认；发送主路径读当前会话覆盖。 */
  approvalMode: ApprovalModeName
  /** ：当前会话审批档覆盖，随 ChatStore 持久化。 */
  approvalModeBySessionId?: Record<string, ApprovalModeName>
  pendingApprovalBySessionId: Record<string, ApprovalRequestState>
  approvalSubmittingBySessionId: Record<string, boolean>
  pendingAskUserBySessionId: Record<string, AskUserRequestState>
  askUserSubmittingBySessionId: Record<string, boolean>
  messagesBySessionId: Record<string, ChatMessage[]>
  sessions: ChatSession[]
  getSessionById?: (sessionId: string) => ChatSession | undefined
  checkpointsBySessionId: Record<string, Record<string, string>>
  restoringSessionId: string | null
  createCheckpoint: (
    sessionId: string,
    messageId: string,
    stateHint?: number,
    meta?: {
      spaceId?: string
      agentRunId?: string
      baselineHash?: string
      kind?: 'agent_turn_done' | 'error_compensation'
    },
  ) => Promise<void>
  setCheckpointPendingContext: (
    sessionId: string,
    ctx: {
      spaceId?: string
      baselineHashPromise: Promise<string | undefined>
      userLocalMessageId?: string
      userClientMessageId?: string
      userServerMessageId?: string
    },
  ) => void
  checkpointPendingContextBySessionId?: Record<
    string,
    Array<{
      spaceId?: string
      baselineHashPromise: Promise<string | undefined>
      userLocalMessageId?: string
      userClientMessageId?: string
      userServerMessageId?: string
    }>
  >
  consumeCheckpointPendingContext?: (sessionId: string) => {
    spaceId?: string
    baselineHashPromise: Promise<string | undefined>
    userLocalMessageId?: string
    userClientMessageId?: string
    userServerMessageId?: string
  } | undefined
  clearCheckpointPendingContext?: (sessionId: string) => void
}

export type SendMessageSetPartial = Partial<
  Pick<
    SendMessageStore,
    | 'pendingApprovalBySessionId'
    | 'approvalSubmittingBySessionId'
    | 'pendingAskUserBySessionId'
    | 'askUserSubmittingBySessionId'
    | 'checkpointsBySessionId'
  >
>

export interface SendMessageDeps {
  get: () => SendMessageStore
  set: (partial: SendMessageSetPartial) => void
  getChatClient: () => ChatClient
  updateSessionMessages: (
    sessionId: string,
    updater: (messages: ChatMessage[]) => ChatMessage[],
  ) => void
  addStreamingSession: (sessionId: string) => void
  removeStreamingSession: (
    sessionId: string,
    options?: { clearSeqGapSync?: boolean },
  ) => void
  updateSessionInCaches: (sessionId: string, patch: Partial<ChatSession>) => void
  updateSessionTokenUsageInCaches: (
    sessionId: string,
    usage: ChatSessionTokenUsage,
  ) => void
  /**
   * ：传入 `sessionId` 时按该会话的执行根解析（有活跃代码根绑定则用
   * 绑定根，否则回落全局 active Space 根）；缺省时行为与改动前一致。
   */
  resolveSpacePath: (sessionId?: string | null) => Promise<string | null>
  buildReviewMessage: (data: import('@tabtin/chat-client').ReviewRequiredEventData) => string
}

export type SendMessageSource =
  | 'widget'
  | 'project_orchestration'

export interface SendMessageOptions {
  source?: SendMessageSource
  displayMessage?: string
  /** 仅主 Composer 显式传入，允许用户 Stop 后恢复本轮原始输入。 */
  allowInterruptedEditRecovery?: boolean
  skillSlashInvoke?: {
    skillKey: string
    args?: string
  }
  spaceId?: string | null
  widgetId?: string
  widgetMeta?: unknown
  widgetTriggeredAt?: number
  tabScopeKey?: string | null
  replyTo?: {
    messageId: string
    preview: {
      role: 'user' | 'assistant' | 'system' | 'tool'
      author?: string
      text: string
    }
  }
  sendTimingTrace?: SendTimingTrace
  /**
   * ：首发已在 local-pending 挂过同 id 乐观用户气泡时传入，
   * sendMessage 跳过二次 insert，沿用该 client_message_id 继续派发。
   */
  existingClientMessageId?: string
  /**
   * ：首发/重试捕获的 DraftMessage；提供时 mismatch 必须 fail-closed。
   */
  expectedDraftMessageId?: string
  /**
   * 本轮触发来源。`continuation` 用于错误卡续跑：仍是新 turn，但对用户隐藏。
   */
  triggeredBy?: 'user' | 'push-notification' | 'continuation'
}
