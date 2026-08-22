/**
 * Outgoing turn ledger——纯内存，无 IDB / 断网 flush。
 *
 * 记录“用户已发送、但尚未由 USER echo 接管时间线”的 payload。
 * Host 仍是执行态真相；本 ledger 只拥有用户消息 payload 与可操作 phase。
 * ：点发送 → 正文留在发送区 loading（`sendInFlight`）；ACK `started` 才上主时间线；
 * ACK `queued` 进本抽屉。成功 ACK 后通过 `composerClearNonce` 通知 Composer 清空。
 */

import type { ChatAttachment } from '@/components/chat/types'
import type { LocalChatMessage } from '../../shared/types'
import { getClientMessageId } from '@/stores/chat/domain/messageIdentity'

export type OutgoingTurnPhase = 'queued' | 'starting'

export interface HostPendingSendItem {
  runId: string
  sessionId: string
  queuePosition: number
  phase?: OutgoingTurnPhase
  hostQueuedObserved?: boolean
  createdAt: string
  userMessage: LocalChatMessage
  /** USER echo 收尾时 scheduleTitleGeneration 用 */
  titleText: string
  /** IPC ACK 前为 true；orphan 清理跳过 */
  ackPending?: boolean
}

export interface HostPendingSendStore {
  hostPendingSendsBySessionId: Record<string, HostPendingSendItem[]>
  /** ：会话是否处于「已点发送、等待 Host ACK」——驱动发送区 loading / 锁编辑 */
  sendInFlightBySessionId: Record<string, boolean>
  setSendInFlight: (sessionId: string, inFlight: boolean) => void
  /**
   * ACK started/queued 成功后递增，Composer 订阅后清空输入。
   * 失败不递增——正文留在发送区可改可重试。
   */
  composerClearNonceBySessionId: Record<string, number>
  /** 发起发送时实际使用的草稿键；ACK 后统一清理，跨草稿 → 正式会话切换仍可命中原键。 */
  composerDraftKeysPendingClearBySessionId: Record<string, string[]>
  registerComposerDraftKeyForSend: (sessionId: string, draftKey: string | null) => void
  clearComposerDraftKeysPendingClear: (sessionId: string) => void
  requestComposerClearAfterSend: (sessionId: string) => void
  enqueueHostPendingSend: (item: HostPendingSendItem) => void
  updateHostPendingSendDraft: (sessionId: string, runId: string, userMessage: LocalChatMessage) => void
  reconcileHostPendingSendAck: (
    sessionId: string,
    provisionalRunId: string,
    ack: { runId: string; queuePosition: number },
  ) => void
  removeHostPendingSend: (sessionId: string, runId: string) => void
  /** USER echo / promote 后按 client_event_id / runId / message.id 移除，返回被移除项 */
  removeHostPendingByClientEventId: (
    sessionId: string,
    clientEventId: string,
  ) => HostPendingSendItem | null
  clearHostPendingSends: (sessionId: string) => void
  reconcileHostPendingWithRunSync: (
    sessionId: string,
    queuedRunIds: readonly string[],
    activeRunId?: string | null,
  ) => void
  /** 乐观插队：把指定项移到镜像队首（与 Host promote 对齐） */
  promoteHostPendingSendToFront: (sessionId: string, runId: string) => void
}

type HostPendingRoot = HostPendingSendStore

export function createHostPendingSendActions<RootState extends HostPendingRoot>(
  get: () => RootState,
  set: (partial: Partial<RootState> | ((state: RootState) => Partial<RootState>)) => void,
): HostPendingSendStore {
  return {
    hostPendingSendsBySessionId: {},
    sendInFlightBySessionId: {},
    composerClearNonceBySessionId: {},
    composerDraftKeysPendingClearBySessionId: {},

    setSendInFlight: (sessionId, inFlight) => {
      const prev = Boolean(get().sendInFlightBySessionId[sessionId])
      if (prev === inFlight) return
      set((state) => {
        const map = { ...state.sendInFlightBySessionId }
        if (inFlight) map[sessionId] = true
        else delete map[sessionId]
        return { sendInFlightBySessionId: map } as Partial<RootState>
      })
    },

    requestComposerClearAfterSend: (sessionId) => {
      set((state) => ({
        composerClearNonceBySessionId: {
          ...state.composerClearNonceBySessionId,
          [sessionId]: (state.composerClearNonceBySessionId[sessionId] ?? 0) + 1,
        },
      } as Partial<RootState>))
    },

    registerComposerDraftKeyForSend: (sessionId, draftKey) => {
      if (!draftKey) return
      const prev = get().composerDraftKeysPendingClearBySessionId[sessionId] ?? []
      if (prev.includes(draftKey)) return
      set((state) => ({
        composerDraftKeysPendingClearBySessionId: {
          ...state.composerDraftKeysPendingClearBySessionId,
          [sessionId]: [...prev, draftKey],
        },
      } as Partial<RootState>))
    },

    clearComposerDraftKeysPendingClear: (sessionId) => {
      if (!get().composerDraftKeysPendingClearBySessionId[sessionId]) return
      set((state) => {
        const map = { ...state.composerDraftKeysPendingClearBySessionId }
        delete map[sessionId]
        return { composerDraftKeysPendingClearBySessionId: map } as Partial<RootState>
      })
    },

    enqueueHostPendingSend: (item) => {
      const prev = get().hostPendingSendsBySessionId[item.sessionId] ?? []
      if (prev.some((p) => p.runId === item.runId)) return
      const nextItem = { ...item, phase: item.phase ?? 'queued' }
      set((state) => ({
        hostPendingSendsBySessionId: {
          ...state.hostPendingSendsBySessionId,
          [item.sessionId]: [...prev, nextItem],
        },
      } as Partial<RootState>))
    },

    updateHostPendingSendDraft: (sessionId, runId, userMessage) => {
      const prev = get().hostPendingSendsBySessionId[sessionId]
      if (!prev?.length) return
      const index = prev.findIndex((p) => p.runId === runId)
      if (index < 0) return
      set((state) => {
        const list = state.hostPendingSendsBySessionId[sessionId]
        if (!list?.length) return {} as Partial<RootState>
        const at = list.findIndex((p) => p.runId === runId)
        if (at < 0) return {} as Partial<RootState>
        const next = [...list]
        next[at] = { ...next[at], userMessage }
        return {
          hostPendingSendsBySessionId: {
            ...state.hostPendingSendsBySessionId,
            [sessionId]: next,
          },
        } as Partial<RootState>
      })
    },

    reconcileHostPendingSendAck: (sessionId, provisionalRunId, ack) => {
      const prev = get().hostPendingSendsBySessionId[sessionId]
      if (!prev?.length) return
      const index = prev.findIndex((p) => p.runId === provisionalRunId)
      if (index < 0) return
      set((state) => {
        const list = state.hostPendingSendsBySessionId[sessionId]
        if (!list?.length) return {} as Partial<RootState>
        const at = list.findIndex((p) => p.runId === provisionalRunId)
        if (at < 0) return {} as Partial<RootState>
        const reconciled = {
          ...list[at],
          runId: ack.runId,
          queuePosition: ack.queuePosition,
          phase: 'queued' as const,
          ackPending: false,
        }
        const next = list
          .map((p, i) => (i === at ? reconciled : p))
          .filter((p, i, arr) => arr.findIndex((x) => x.runId === p.runId) === i)
        return {
          hostPendingSendsBySessionId: {
            ...state.hostPendingSendsBySessionId,
            [sessionId]: next,
          },
        } as Partial<RootState>
      })
    },

    removeHostPendingSend: (sessionId, runId) => {
      const prev = get().hostPendingSendsBySessionId[sessionId]
      if (!prev?.length) return
      const next = prev.filter((p) => p.runId !== runId)
      if (next.length === prev.length) return
      set((state) => {
        const map = { ...state.hostPendingSendsBySessionId }
        if (next.length === 0) delete map[sessionId]
        else map[sessionId] = next
        return { hostPendingSendsBySessionId: map } as Partial<RootState>
      })
    },

    removeHostPendingByClientEventId: (sessionId, clientEventId) => {
      const prev = get().hostPendingSendsBySessionId[sessionId]
      if (!prev?.length) return null
      // 含 ackPending：测试/竞态下 USER 可能早于 IPC ACK reconcile
      const index = prev.findIndex((item) => {
        if (item.runId === clientEventId) return true
        if (item.userMessage.id === clientEventId) return true
        return getClientMessageId(item.userMessage) === clientEventId
      })
      if (index < 0) return null
      const removed = prev[index]!
      const next = prev.filter((_, i) => i !== index)
      set((state) => {
        const map = { ...state.hostPendingSendsBySessionId }
        if (next.length === 0) delete map[sessionId]
        else map[sessionId] = next
        return { hostPendingSendsBySessionId: map } as Partial<RootState>
      })
      return removed
    },

    clearHostPendingSends: (sessionId) => {
      if (!get().hostPendingSendsBySessionId[sessionId]?.length) return
      set((state) => {
        const map = { ...state.hostPendingSendsBySessionId }
        delete map[sessionId]
        return { hostPendingSendsBySessionId: map } as Partial<RootState>
      })
    },

    reconcileHostPendingWithRunSync: (sessionId, queuedRunIds, activeRunId = null) => {
      const prev = get().hostPendingSendsBySessionId[sessionId]
      if (!prev?.length) return
      const queued = new Set(queuedRunIds)
      const next = prev.map((item) => ({
        ...item,
        hostQueuedObserved: item.hostQueuedObserved || queued.has(item.runId),
        phase: queued.has(item.runId)
          ? 'queued' as const
          : item.runId === activeRunId || item.hostQueuedObserved
            ? 'starting' as const
            : (item.phase ?? 'queued' as const),
        queuePosition: queued.has(item.runId)
          ? queuedRunIds.indexOf(item.runId) + 1
          : item.queuePosition,
        // Keep historical position while starting so diagnostics and USER echo can still
        // tie the payload back to the queued turn without exposing queued actions.
      }))
      const changed = next.some((item, index) => (
        item.phase !== prev[index]?.phase
        || item.queuePosition !== prev[index]?.queuePosition
        || item.hostQueuedObserved !== prev[index]?.hostQueuedObserved
      ))
      if (!changed) return
      set((state) => ({
        hostPendingSendsBySessionId: {
          ...state.hostPendingSendsBySessionId,
          [sessionId]: next,
        },
      } as Partial<RootState>))
    },

    promoteHostPendingSendToFront: (sessionId, runId) => {
      const prev = get().hostPendingSendsBySessionId[sessionId]
      if (!prev?.length) return
      const index = prev.findIndex((p) => p.runId === runId)
      if (index <= 0) return
      const next = [...prev]
      const [item] = next.splice(index, 1)
      next.unshift(item)
      set((state) => ({
        hostPendingSendsBySessionId: {
          ...state.hostPendingSendsBySessionId,
          [sessionId]: next.map((p, i) => ({ ...p, queuePosition: i + 1 })),
        },
      } as Partial<RootState>))
    },
  }
}

export function applyAttachmentsToHostPendingUserMessage(
  userMessage: LocalChatMessage,
  attachments: ChatAttachment[] | undefined,
): LocalChatMessage {
  if (!attachments?.length) return userMessage
  const nextAttachments = attachments
    .filter((a) => a.status === 'ready')
    .map((a) => ({
      type: a.type as 'image' | 'file' | 'video',
      file_id: a.fileId,
      filename: a.filename,
      mime_type: a.mimeType,
      size: a.size,
      url: a.remoteUrl,
    }))
  const existingBlocks = Array.isArray(userMessage.content_blocks_json)
    ? [...userMessage.content_blocks_json]
    : []
  const seenFileIds = new Set(
    existingBlocks
      .map((b) => (b && typeof b === 'object' ? (b as { file_id?: unknown }).file_id : undefined))
      .filter((id): id is string => typeof id === 'string' && id.length > 0),
  )
  const mediaBlocks = nextAttachments
    .filter((a) => a.file_id && !seenFileIds.has(a.file_id))
    .map((a) => ({
      type: a.type,
      file_id: a.file_id,
      filename: a.filename,
      mime_type: a.mime_type,
      size: a.size,
      url: a.url,
    }))
  return {
    ...userMessage,
    attachments_json: nextAttachments.length > 0 ? nextAttachments : undefined,
    content_blocks_json: mediaBlocks.length > 0
      ? [...existingBlocks, ...mediaBlocks] as typeof userMessage.content_blocks_json
      : userMessage.content_blocks_json,
  }
}
