import type { ChatMessage } from '@tabtin/chat-client'
import type { AgentModeName } from '../../shared/types'
import { useChatRuntimeStore } from '../../../useChatRuntimeStore'
import { markSessionSuspended } from '@/services/sessionSuspended'
import type { PendingUserSend } from './optimisticUserSend'
import type { HostPendingSendItem } from '../hostPending/hostPendingSendSlice'

type SendAckLogger = {
  info: (...args: unknown[]) => void
}

export type ApplyLocalRuntimeSendAckParams = {
  sessionId: string
  disposition: 'started' | 'queued' | undefined
  runId?: string
  queuePosition?: number
  currentAgentMode: AgentModeName
  displayMessage: string
  pending: PendingUserSend
  get: () => {
    setSendInFlight: (sessionId: string, inFlight: boolean) => void
    requestComposerClearAfterSend: (sessionId: string) => void
    enqueueHostPendingSend: (item: HostPendingSendItem) => void
    hostPendingSendsBySessionId: Record<string, unknown[] | undefined>
    messagesBySessionId: Record<string, ChatMessage[] | undefined>
  }
  bumpSessionSidebarOnSend: () => void
  addStreamingSession: (sessionId: string) => void
  log: SendAckLogger
}

/** 本轮真正 started 时清理 steps/events（不清 subagent runs）。 */
export function prepareLocalRuntimeTurnState(sessionId: string): void {
  const runtime = useChatRuntimeStore.getState()
  runtime.clearAgentStepsForSession(sessionId)
  runtime.clearToolEventsForSession(sessionId)
  useChatRuntimeStore.setState(rs => {
    const nextAssistant = { ...rs.assistantEventsBySessionId }
    delete nextAssistant[sessionId]
    return {
      assistantEventsBySessionId: nextAssistant,
    }
  })
}

/** ACK started / promote 上屏：清上轮 UI 轨并进入 streaming。 */
export function beginStartedTurnUi(
  sessionId: string,
  addStreamingSession: (sessionId: string) => void,
): void {
  markSessionSuspended(sessionId, false)
  prepareLocalRuntimeTurnState(sessionId)
  useChatRuntimeStore.getState().clearRichContentBlocks(sessionId)
  addStreamingSession(sessionId)
}

/**
 * 本机 runtime send ACK：
 * - queued → HostPending 抽屉（发送区清空，主时间线仍无气泡）
 * - started → 主时间线上屏 + turn UI + 发送区清空
 */
export function applyLocalRuntimeSendAck(params: ApplyLocalRuntimeSendAckParams): void {
  const {
    sessionId,
    disposition,
    runId,
    queuePosition,
    currentAgentMode,
    displayMessage,
    pending,
    get,
    bumpSessionSidebarOnSend,
    addStreamingSession,
    log,
  } = params

  get().setSendInFlight(sessionId, false)

  if (disposition === 'queued') {
    if (!runId) {
      throw new Error('send ACK queued without runId')
    }
    if (queuePosition == null || queuePosition < 1) {
      throw new Error(`send ACK queued with invalid queuePosition: ${String(queuePosition)}`)
    }
    const ack = pending.applyAck('queued', currentAgentMode)
    if (ack.kind !== 'queued') {
      throw new Error('pending.applyAck queued returned unexpected kind')
    }
    get().enqueueHostPendingSend({
      runId,
      sessionId,
      queuePosition,
      phase: 'queued',
      createdAt: new Date().toISOString(),
      userMessage: ack.userMessage,
      titleText: displayMessage,
    })
    bumpSessionSidebarOnSend()
    get().requestComposerClearAfterSend(sessionId)
    log.info('[Local] query queued (host pending)', {
      runId: runId.slice(0, 8),
      queuePosition,
      pendingCount: get().hostPendingSendsBySessionId[sessionId]?.length ?? 0,
    })
    return
  }

  if (disposition !== 'started') {
    throw new Error(`send ACK unexpected disposition: ${String(disposition)}`)
  }

  pending.applyAck('started', currentAgentMode)
  bumpSessionSidebarOnSend()
  beginStartedTurnUi(sessionId, addStreamingSession)
  get().requestComposerClearAfterSend(sessionId)
  log.info('[Local] query started (timeline after ACK)', {
    runId: runId?.slice(0, 8),
    messagesCount: get().messagesBySessionId[sessionId]?.length ?? 0,
  })
}
