/**
 * Host 级插队编排（ 方案 A /  ActiveRunBinding）
 *
 * 只调 `agent-engine:promote-run`：Host 内 abort active + promote 排队项。
 * 禁止 abort 后再 sendMessage / flush（ 双发）。
 * Host 确认 promoted 后再重排镜像、冻中断身份并上主时间线；
 * 失败出口保持 HostPending 原顺序，不造孤儿气泡。
 */

import type { ChatMessage } from '@tabtin/chat-client'
import { createLogger } from '@/utils/logger'
import { isSendOnCooldown, useSendCooldownStore } from '../../execution/sendCooldown'
import { trackChatTelemetry } from '../../execution/chatTelemetry'
import type { HostPendingSendItem } from '../hostPending/hostPendingSendSlice'
import { promoteHostPendingOntoTimeline } from '../hostPending/promoteHostPendingOntoTimeline'

const log = createLogger('Chat')

interface InterruptHostPendingRoot {
  hostPendingSendsBySessionId: Record<string, HostPendingSendItem[] | undefined>
  promoteHostPendingSendToFront: (sessionId: string, runId: string) => void
  removeHostPendingSend: (sessionId: string, runId: string) => void
  upsertObservedUserMessage: (sessionId: string, message: ChatMessage) => void
  addStreamingSession: (sessionId: string, runId?: string | null) => void
  interruptAndPromoteHostPending: (sessionId: string, runId: string) => Promise<void>
  interruptAndPromoteLatestHostPending: (sessionId: string) => Promise<void>
}

export interface InterruptHostPendingStore {
  interruptAndPromoteHostPending: (sessionId: string, runId: string) => Promise<void>
  interruptAndPromoteLatestHostPending: (sessionId: string) => Promise<void>
}

interface InterruptHostPendingDeps {
  get: () => InterruptHostPendingRoot
  markActiveRunInterrupted: (sessionId: string, runId?: string | null) => void
  markCurrentRunSuperseded: (sessionId: string, runId?: string | null) => void
  bumpSessionSidebarOnSend?: (sessionId: string, displayMessage: string) => void
}

export function createInterruptHostPendingActions(
  deps: InterruptHostPendingDeps,
): InterruptHostPendingStore {
  const {
    get,
    markActiveRunInterrupted,
    markCurrentRunSuperseded,
    bumpSessionSidebarOnSend,
  } = deps

  const interruptAndPromoteHostPending = async (sessionId: string, runId: string) => {
    if (!sessionId || !runId) return
    if (isSendOnCooldown(sessionId)) return
    useSendCooldownStore.getState().beginSendCooldown(sessionId)

    trackChatTelemetry('queue.interrupt_promote.start', {
      runId,
      queueSize: get().hostPendingSendsBySessionId[sessionId]?.length ?? 0,
    }, {
      counterKey: 'queue.interrupt_promote.start',
      sessionId,
    })

    const promoteRun = window.tabtin?.agentEngine?.promoteRun
    if (typeof promoteRun !== 'function') {
      log.warn('[promoteRun] bridge unavailable')
      trackChatTelemetry('queue.interrupt_promote.no_bridge', { runId }, {
        counterKey: 'queue.interrupt_promote.no_bridge',
        sessionId,
      })
      return
    }

    try {
      const res = await promoteRun({ sessionId, runId })
      if (!res?.promoted) {
        log.warn('[promoteRun] host rejected', {
          sessionId: sessionId.slice(0, 8),
          runId: runId.slice(0, 8),
          error: res?.error,
        })
        trackChatTelemetry('queue.interrupt_promote.rejected', {
          runId,
          error: res?.error ?? 'not_promoted',
        }, {
          counterKey: 'queue.interrupt_promote.rejected',
          sessionId,
        })
        return
      }

      // Host 确认后再重排镜像 / 冻中断身份 / 上屏，失败出口保持原顺序。
      get().promoteHostPendingSendToFront(sessionId, runId)
      if (res.abortedRunId) {
        markActiveRunInterrupted(sessionId, res.abortedRunId)
        markCurrentRunSuperseded(sessionId, res.abortedRunId)
      }

      const snapshot = get().hostPendingSendsBySessionId[sessionId]?.find((p) => p.runId === runId) ?? null
      const ontoTimeline = promoteHostPendingOntoTimeline({
        sessionId,
        runId,
        getItem: () => snapshot,
        upsertObservedUserMessage: get().upsertObservedUserMessage,
        removeHostPendingSend: get().removeHostPendingSend,
        addStreamingSession: get().addStreamingSession,
        bumpSessionSidebarOnSend,
      })

      trackChatTelemetry('queue.interrupt_promote.ok', {
        runId,
        abortedActive: res.abortedActive,
        abortedRunId: res.abortedRunId ?? null,
        queued: res.queuedRunIds?.length ?? 0,
        ontoTimeline,
      }, {
        counterKey: 'queue.interrupt_promote.ok',
        sessionId,
      })
    } catch (err) {
      log.warn('[promoteRun] IPC failed', err)
      trackChatTelemetry('queue.interrupt_promote.error', {
        runId,
        error: err instanceof Error ? err.message : String(err),
      }, {
        counterKey: 'queue.interrupt_promote.error',
        sessionId,
      })
    }
  }

  const interruptAndPromoteLatestHostPending = async (sessionId: string) => {
    const queue = (get().hostPendingSendsBySessionId[sessionId] ?? [])
      .filter((item) => item.phase !== 'starting')
    if (queue.length === 0) return
    const latest = queue[queue.length - 1]
    await interruptAndPromoteHostPending(sessionId, latest.runId)
  }

  return {
    interruptAndPromoteHostPending,
    interruptAndPromoteLatestHostPending,
  }
}
