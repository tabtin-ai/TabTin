/**
 * ：新任务首发「立刻进对话布局」——在 ensureSession HTTP 之前同步挂
 * local-pending session + 乐观用户气泡；建会话成功后由
 * applyProvisionedSessionPointer 原子迁到真 session。
 *
 * 不变量：
 * - pending id **不得**写入 currentSessionIdBySpaceId（否则 ensure 会当 existing 短路）
 * - 不恢复草稿预建；侧栏靠 message_count + locallySubmittedSessionRegistry
 * - ：pending 归属由调用方按 episode 解析后传入，禁止跨 draft scope 复用全局 current
 * -  ownership：先 allocate + bind，成功后再 commit；禁止先写 UI 再判 ownership
 */

import type { ChatMessage, MessageBlock } from '@tabtin/chat-client'
import type { ChatAttachment } from '../../../../components/chat/types'
import type { LocalChatMessage } from '../../shared/types'
import { applyBlocksArrival } from '@/stores/chat/domain/messageTimelineOrder'
import { buildUserVisibleBlocks } from '../../messages/actions/buildUserVisibleBlocks'
import {
  trackSendTimingTelemetry,
  type SendTimingTrace,
} from '../../execution/sendTimingTrace'

export const LOCAL_PENDING_SESSION_PREFIX = 'local-pending-'

export function isLocalPendingSessionId(
  id: string | null | undefined,
): id is string {
  return typeof id === 'string' && id.startsWith(LOCAL_PENDING_SESSION_PREFIX)
}

export function createLocalPendingSessionId(): string {
  return `${LOCAL_PENDING_SESSION_PREFIX}${crypto.randomUUID()}`
}

export function buildPendingFirstSendUserMessage(input: {
  message: string
  contextBlocks?: Array<Record<string, unknown>>
  attachments?: ChatAttachment[]
  replyTo?: {
    messageId: string
    preview: {
      role: 'user' | 'assistant' | 'system' | 'tool'
      author?: string
      text: string
    }
  }
  clientMessageId?: string
}): LocalChatMessage {
  const clientMessageId = input.clientMessageId ?? crypto.randomUUID()
  const hasAttachments = Boolean(input.attachments && input.attachments.length > 0)
  const userBlocks = applyBlocksArrival(
    buildUserVisibleBlocks(
      input.message,
      input.contextBlocks as MessageBlock[] | undefined,
    ),
  )
  const replyTo = input.replyTo

  return {
    id: clientMessageId,
    role: 'user',
    content: input.message,
    created_at: new Date().toISOString(),
    sendStatus: 'sending',
    content_blocks_json: userBlocks,
    ...(replyTo
      ? {
          reply_to_message_id: replyTo.messageId,
          reply_to_preview: replyTo.preview,
        }
      : {}),
    attachments_json: hasAttachments
      ? input.attachments!.map((a) => ({
          type: a.type as 'image' | 'file' | 'video',
          filename: a.filename,
          mime_type: a.mimeType,
          size: a.size,
        }))
      : undefined,
    metadata: {
      client_message_id: clientMessageId,
    },
  }
}

export interface PendingFirstSendReplyTo {
  messageId: string
  preview: {
    role: 'user' | 'assistant' | 'system' | 'tool'
    author?: string
    text: string
  }
}

export interface PendingFirstSendBootstrapInput {
  spaceId: string
  message: string
  contextBlocks?: Array<Record<string, unknown>>
  attachments?: ChatAttachment[]
  replyTo?: PendingFirstSendReplyTo
  sendTimingTrace?: SendTimingTrace
  /**
   * ：预建已写入 Space 指针时传入真 session id，
   * 乐观气泡直接挂真会话（不再造 local-pending）。
   */
  existingSessionId?: string
  /**
   * ：调用方按 episode 解析出的本 Space 已绑定 local-pending。
   * 禁止用「全局 currentSessionId 是 local-pending」启发式跨 draft scope 复用。
   */
  ownedPendingSessionId?: string
  /**
   * 当前全局 current 若是其它 Space 的 local-pending，bootstrap 不得抢占。
   */
  preserveForeignGlobalCurrent?: boolean
}

export interface PendingFirstSendStoreSlice {
  currentSessionId: string | null
  draftSessionBySpaceId: Record<string, boolean>
  messagesBySessionId: Record<string, ChatMessage[]>
  currentSessionIdBySpaceId: Record<string, string | null>
}

/** allocate：纯分配，不写 store */
export type PendingFirstSendAllocation =
  | {
      kind: 'adopt_owned'
      pendingSessionId: string
      clientMessageId: string
      userMessage: null
      writesSpacePointer: false
    }
  | {
      kind: 'new_target'
      pendingSessionId: string
      clientMessageId: string
      userMessage: LocalChatMessage
      /** 真 session（预建）：commit 时写 Space 指针 */
      writesSpacePointer: boolean
    }

/**
 * 纯分配目标 session id + 乐观消息，不碰 store。
 * 调用方须先 ownership bind 成功，再 `commitPendingFirstSendState`。
 */
export function allocatePendingFirstSendTarget(
  state: PendingFirstSendStoreSlice,
  input: PendingFirstSendBootstrapInput,
): PendingFirstSendAllocation {
  const ownedPending = input.ownedPendingSessionId
    && isLocalPendingSessionId(input.ownedPendingSessionId)
    ? input.ownedPendingSessionId
    : null
  if (ownedPending) {
    const existingMsgs = state.messagesBySessionId[ownedPending] ?? []
    const existingUser = existingMsgs.find((m) => m.role === 'user')
    const clientMessageId =
      (existingUser?.metadata as { client_message_id?: string } | undefined)?.client_message_id
      ?? existingUser?.id
      ?? crypto.randomUUID()
    return {
      kind: 'adopt_owned',
      pendingSessionId: ownedPending,
      clientMessageId,
      userMessage: null,
      writesSpacePointer: false,
    }
  }

  const isExistingReal = Boolean(
    input.existingSessionId && !isLocalPendingSessionId(input.existingSessionId),
  )
  const pendingSessionId = isExistingReal
    ? input.existingSessionId!
    : createLocalPendingSessionId()
  const userMessage = buildPendingFirstSendUserMessage({
    message: input.message,
    contextBlocks: input.contextBlocks,
    attachments: input.attachments,
    replyTo: input.replyTo,
  })
  return {
    kind: 'new_target',
    pendingSessionId,
    clientMessageId: userMessage.id,
    userMessage,
    writesSpacePointer: isExistingReal,
  }
}

/**
 * ownership bind 成功后原子写入 UI：清 draft、挂气泡、可选写指针。
 *
 *  / ：草稿 UI 旗标挂在产品宿主 A（`draftSpaceId`），会话指针写在
 * execution B（`spaceId`）。二者相同时行为与旧版一致。
 */
export function commitPendingFirstSendState(
  state: PendingFirstSendStoreSlice,
  input: {
    /** 会话指针 / sessions 桶（execution Space） */
    spaceId: string
    /**
     * 清 `draftSessionBySpaceId` 的 Space（conversation host）。
     * 缺省与 `spaceId` 相同；A≠B 时必须传 host，否则侧栏「新任务」会残留选中。
     */
    draftSpaceId?: string | null
    allocation: PendingFirstSendAllocation
    preserveForeignGlobalCurrent?: boolean
  },
): Partial<PendingFirstSendStoreSlice> {
  const { allocation, spaceId } = input
  const draftSpaceId = input.draftSpaceId || spaceId
  const nextDraft = { ...state.draftSessionBySpaceId }
  delete nextDraft[draftSpaceId]
  // 历史路径若误把 draft 写在 execution 上，一并清掉，避免双旗标
  if (draftSpaceId !== spaceId) {
    delete nextDraft[spaceId]
  }

  if (allocation.kind === 'adopt_owned') {
    const adoptGlobal =
      !state.currentSessionId
      || state.currentSessionId === allocation.pendingSessionId
    return {
      draftSessionBySpaceId: nextDraft,
      ...(adoptGlobal ? { currentSessionId: allocation.pendingSessionId } : {}),
    }
  }

  const existingOnTarget = state.messagesBySessionId[allocation.pendingSessionId] ?? []
  const nextCurrent = input.preserveForeignGlobalCurrent
    ? state.currentSessionId
    : allocation.pendingSessionId

  const nextPointers = allocation.writesSpacePointer
    ? {
        ...state.currentSessionIdBySpaceId,
        [spaceId]: allocation.pendingSessionId,
        // 侧栏 welcome 读 host 指针上的本地消息数；A≠B 时同步挂上真 session
        ...(draftSpaceId !== spaceId
          ? { [draftSpaceId]: allocation.pendingSessionId }
          : {}),
      }
    : null

  return {
    currentSessionId: nextCurrent,
    draftSessionBySpaceId: nextDraft,
    ...(nextPointers ? { currentSessionIdBySpaceId: nextPointers } : {}),
    messagesBySessionId: {
      ...state.messagesBySessionId,
      [allocation.pendingSessionId]: [...existingOnTarget, allocation.userMessage],
    },
  }
}

/**
 * @deprecated 兼容旧调用：allocate + commit 合并（无 ownership 门禁）。
 * 生产首发路径请用 allocate → bind → commit。
 */
export function bootstrapPendingFirstSendState(
  state: PendingFirstSendStoreSlice,
  input: PendingFirstSendBootstrapInput,
): {
  next: Partial<PendingFirstSendStoreSlice>
  pendingSessionId: string
  clientMessageId: string
  created: boolean
} {
  const allocation = allocatePendingFirstSendTarget(state, input)
  const next = commitPendingFirstSendState(state, {
    spaceId: input.spaceId,
    allocation,
    preserveForeignGlobalCurrent: input.preserveForeignGlobalCurrent,
  })
  return {
    next,
    pendingSessionId: allocation.pendingSessionId,
    clientMessageId: allocation.clientMessageId,
    created: allocation.kind === 'new_target',
  }
}

export function mergePendingMessagesIntoSession(
  messagesBySessionId: Record<string, ChatMessage[]>,
  pendingSessionId: string,
  realSessionId: string,
): Record<string, ChatMessage[]> {
  const pending = messagesBySessionId[pendingSessionId] ?? []
  const existing = messagesBySessionId[realSessionId] ?? []
  const seen = new Set(pending.map((m) => m.id))
  const merged = [
    ...pending,
    ...existing.filter((m) => !seen.has(m.id)),
  ]
  const next = { ...messagesBySessionId, [realSessionId]: merged }
  delete next[pendingSessionId]
  return next
}

export function trackPendingFirstSendUserVisible(
  pendingSessionId: string,
  clientMessageId: string,
  sendTimingTrace: SendTimingTrace | undefined,
  extras: {
    hasAttachments: boolean
    hasContextBlocks: boolean
  },
): void {
  trackSendTimingTelemetry('message.send.user_visible', {
    sessionId: pendingSessionId,
    userMessageId: clientMessageId,
    hasAttachments: extras.hasAttachments,
    hasContextBlocks: extras.hasContextBlocks,
    pendingFirstSend: true,
  }, sendTimingTrace, {
    counterKey: 'message.send.user_visible',
    sessionId: pendingSessionId,
  })
}
