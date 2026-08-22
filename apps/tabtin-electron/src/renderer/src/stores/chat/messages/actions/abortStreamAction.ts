/**
 * Abort orchestration — 中止流的跨领域 use-case action（ 分层重构）。
 *
 * abortStream / abortStreamForUserEdit / abortStreamFromComposer / abortStreamAndWait
 * 一次触碰 message（interrupted 标记 / 截断）、dispatch（streaming 清理）、hitl
 * （面板墓碑清理）、runtime（cancel）、stream（supersede）多域，属编排层——
 * 从 useChatStore 抽出为独立工厂，仍通过 deps 复用 store 侧的原语与共享 helper
 * （_markLast* / cancelRuntimeIfNeeded / performCancelCleanup 等，interrupt 编排也用）。
 *
 * ：`abortStreamForUserEdit` 在本地乐观截断后，经 SessionController →
 * runtime IPC `withdraw-unanswered-turn` 做 transcript Unsend + 主进程投影；
 * 不在渲染进程直打 Django，也不做本地墓碑。
 */

import type { ChatSession } from '@tabtin/chat-client'
import { resolveSessionScopeId } from '@tabtin/app-shell'
import type { AbortRunResult } from '@/services/agentService'
import { getSessionController } from '@/services/agentService'
import { useSpaceStore } from '@stores/useSpaceStore'
import { logger, createLogger } from '@/utils/logger'
import { streamingContent } from '../../execution/streamingContent'
import { trackChatTelemetry } from '../../execution/chatTelemetry'
import {
  clearWithdrawalPending,
  markAbortRequested,
  markWithdrawalPending,
} from '../../stream/handlers/abortGrace'
import { getBusySessionIds } from '../../execution/sessionRunProjection'
import { resolveComposerStopMode } from './composerStopDecision'
import { releaseTitleGenerationDedupe } from './titleGenerationDedupe'
import { useChatRuntimeStore } from '../../../useChatRuntimeStore'
import { countSurvivingBackgroundSubagents, shouldNoteComposerStopBackgroundHint } from '../../subagent/survivingBackgroundSubagents'

const log = createLogger('Chat')

export interface AbortWaitResult {
  cancelRequested: boolean
  cancelCompleted: boolean
}

export interface AbortStreamStore {
  abortStream: (sessionId?: string) => void
  abortStreamForUserEdit: (sessionId: string) => Promise<void>
  abortStreamFromComposer: (sessionId: string) => Promise<void>
  abortStreamAndWait: (timeoutMs?: number, sessionId?: string | null) => Promise<AbortWaitResult>
}

/** 本编排读取的最小 root 形状 + 依赖它调用的 store 侧 action。 */
interface AbortRootState {
  currentSessionId: string | null
  messagesBySessionId: Record<string, import('@tabtin/chat-client').ChatMessage[]>
  sessions: Array<
    Pick<ChatSession, 'id' | 'space_id' | 'organization_id' | 'rollback_state'>
  >
  abortStream: (sessionId?: string) => void
  abortStreamForUserEdit: (sessionId: string) => Promise<void>
  truncateFromMessage: (sessionId: string, anchor: { localMessageId?: string; clientMessageId?: string }) => void
  updateSessionTitleInCaches: (
    sessionId: string,
    title: string,
    opts?: { bumpUpdatedAt?: boolean },
  ) => void
  updateSessionInCaches: (sessionId: string, patch: Partial<ChatSession>) => void
}

interface AbortStreamDeps {
  get: () => AbortRootState
  getChatClient: () => {
    abortStream: () => void
    abortStreamForSession: (sessionId: string) => void
    abortStreamAndWait: (timeoutMs: number) => Promise<AbortWaitResult | undefined>
    abortStreamForSessionAndWait: (sessionId: string, timeoutMs: number) => Promise<AbortWaitResult | undefined>
  }
  removeStreamingSession: (sessionId: string, options?: { clearSeqGapSync?: boolean }) => void
  markActiveRunInterrupted: (sid: string) => void
  markCurrentRunSuperseded: (sid: string) => void
  cancelRuntimeIfNeeded: (sessionId: string) => Promise<AbortRunResult>
  toAbortWaitResult: (res: AbortRunResult) => AbortWaitResult
  performCancelCleanup: (
    sessionId: string,
    removeStreamingSession: (sid: string, options?: { clearSeqGapSync?: boolean }) => void,
    clearHitlState: (sessionId: string) => void,
  ) => void
  scheduleCancelSync: (sessionId: string) => void
  clearHitlOnAbort: (sid: string) => void
}

export function createAbortStreamActions(deps: AbortStreamDeps): AbortStreamStore {
  const {
    get, getChatClient, removeStreamingSession,
    markActiveRunInterrupted, markCurrentRunSuperseded,
    cancelRuntimeIfNeeded, toAbortWaitResult,
    performCancelCleanup, scheduleCancelSync, clearHitlOnAbort,
  } = deps

  /** ：全局 abort 对每个 busy session 走 cancel cleanup（写 endedAt）。 */
  const endAllBusySessions = (busyIds: string[]) => {
    for (const sid of busyIds) {
      performCancelCleanup(sid, removeStreamingSession, clearHitlOnAbort)
      scheduleCancelSync(sid)
    }
  }

  /**
   * 先登记用户中断屏障，再做任何异步撤回或本地截断。
   * 否则 withdraw 等待期间的 late content-block 会重建已删除的 assistant。
   */
  const beginSessionAbort = (sessionId: string) => {
    useChatRuntimeStore.getState().setCancellingForSession(sessionId, true)
    markAbortRequested(sessionId)
    markCurrentRunSuperseded(sessionId)
  }

  const abortStream = (sessionId?: string) => {
    // ：按 ActiveRunBinding 标被中断的 assistant，禁止扫最后一条。
    const targetSid = sessionId ?? get().currentSessionId
    if (targetSid) markActiveRunInterrupted(targetSid)
    try {
      const client = getChatClient()
      if (sessionId) {
        // 与 abortStreamAndWait 对齐：取消意图写进 cancelling，供 streamHandler
        // 在宽限期内丢弃尾部；#7669 cleanup 会 settle cancelling，不再用它禁 drain。
        beginSessionAbort(sessionId)
        client.abortStreamForSession(sessionId)
        removeStreamingSession(sessionId)
        void cancelRuntimeIfNeeded(sessionId)
        streamingContent.clear(sessionId)
      } else {
        const busyIds = getBusySessionIds()
        busyIds.forEach(beginSessionAbort)
        client.abortStream()
        //  + ：全局 abort 对每个 busy session 走 cancel cleanup 写 endedAt。
        // ：busy 由后续 run_sync idle / reconcile 收口，不再 markAllRunsEnded。
        endAllBusySessions(busyIds)
        streamingContent.clearAll()
        const sid = get().currentSessionId
        if (sid) void cancelRuntimeIfNeeded(sid)
      }
      trackChatTelemetry('stream.abort.requested', { sessionId: sessionId ?? 'all' }, { counterKey: 'stream.abort.requested' })
      logger.log('[Chat] 已中止流式输出', sessionId ? `session=${sessionId}` : 'all')
    } catch (error) {
      log.error('Failed to abort stream:', { sessionId: sessionId ?? 'all', error })
      trackChatTelemetry('stream.abort.failed', {
        message: error instanceof Error ? error.message : String(error),
      }, {
        counterKey: 'stream.abort.failed',
        level: 'error',
      })
    }
    if (sessionId) {
      performCancelCleanup(sessionId, removeStreamingSession, clearHitlOnAbort)
      scheduleCancelSync(sessionId)
    }
  }

  const abortStreamForUserEdit = async (sessionId: string) => {
    const runtime = useChatRuntimeStore.getState()
    // 先挪快照再 abort：abort 触发的 onError 会 clearActiveSubmitted，晚了就丢恢复材料。
    const recovery = runtime.moveActiveSubmittedMessageToInterruptedRecovery(sessionId)
    if (!recovery) {
      get().abortStream(sessionId)
      return
    }

    // ：撤回前先封住旧流。withdraw IPC 可能等待数百毫秒，期间不得让
    // late thinking / message_stop 重建 assistant，否则 user 边界已被截断后会并入上一轮。
    beginSessionAbort(sessionId)
    markWithdrawalPending(sessionId)

    // 乐观 UI：本地时间线先撤，Composer 消费 pending 快照回填。
    get().truncateFromMessage(sessionId, {
      localMessageId: recovery.localMessageId,
      clientMessageId: recovery.clientMessageId,
    })
    streamingContent.clear(sessionId)

    // ：权威 Unsend 走 runtime（abort + rewind commit + 主进程投影），再做 UI 流清理。
    // 顺序上先 await 投影，再 scheduleCancelSync，避免 1.5s sync 把已落库 user 拉回。
    const root = get()
    const currentSession = root.sessions.find((session) => session.id === sessionId)
    const selectedSpace = useSpaceStore.getState().selectedSpace
    try {
      const withdrawn = await getSessionController(sessionId).withdrawUnansweredTurn({
        clientMessageId: recovery.clientMessageId,
        localMessageId: recovery.localMessageId,
        targetContent: recovery.message,
        spaceId: resolveSessionScopeId(currentSession) ?? selectedSpace?.id,
        organizationId: currentSession?.organization_id ?? selectedSpace?.organization_id,
      })
      trackChatTelemetry('stream.abort.withdraw_unanswered', {
        sessionId,
        runtimeApplied: withdrawn?.runtimeApplied ?? false,
        backendProjected: withdrawn?.backendProjected ?? false,
        titleReset: withdrawn?.titleReset ?? false,
      }, {
        counterKey: 'stream.abort.withdraw_unanswered',
        sessionId,
      })
      // Unsend 后会话可能再次变「首条」：释放标题 dedupe，避免 5 分钟内重发被跳过。
      releaseTitleGenerationDedupe(sessionId)
      // 后端已取消标题生成并复位默认标题时，同步侧栏缓存（不必等 WS）。
      if (withdrawn?.titleReset && typeof withdrawn.title === 'string' && withdrawn.title) {
        root.updateSessionTitleInCaches(sessionId, withdrawn.title, {
          bumpUpdatedAt: false,
        })
        const titleStatus = withdrawn.titleGenerationStatus
        root.updateSessionInCaches(sessionId, {
          title: withdrawn.title,
          title_generation_status:
            titleStatus === 'pending'
            || titleStatus === 'in_progress'
            || titleStatus === 'done'
            || titleStatus === 'failed'
              ? titleStatus
              : 'pending',
        })
      }
      // Unsend 不是 checkpoint 回退：清掉误残留的 revert 横幅态（「恢复原状」等）。
      if (currentSession?.rollback_state?.revert_active) {
        root.updateSessionInCaches(sessionId, {
          rollback_state: {
            ...currentSession.rollback_state,
            revert_active: false,
            can_unrevert: false,
          },
        })
      }
    } catch (error) {
      log.warn('withdrawUnansweredTurn failed; falling back to local truncate + abortStream', {
        sessionId: sessionId.slice(0, 8),
        error,
      })
      trackChatTelemetry('stream.abort.withdraw_unanswered_failed', {
        sessionId,
        message: error instanceof Error ? error.message : String(error),
      }, {
        counterKey: 'stream.abort.withdraw_unanswered_failed',
        level: 'warn',
        sessionId,
      })
    } finally {
      clearWithdrawalPending(sessionId)
    }

    get().abortStream(sessionId)

    trackChatTelemetry('stream.abort.edit_recovery', { sessionId }, {
      counterKey: 'stream.abort.edit_recovery',
      sessionId,
    })
  }

  const abortStreamFromComposer = async (sessionId: string) => {
    const runtime = useChatRuntimeStore.getState()
    const mode = resolveComposerStopMode({
      sessionId,
      messages: get().messagesBySessionId[sessionId] ?? [],
      activeSubmitted: runtime.activeSubmittedMessageBySessionId[sessionId],
      toolEvents: runtime.toolEventsBySessionId[sessionId],
    })

    const survivingBackground = countSurvivingBackgroundSubagents(
      runtime.subagentRunsBySessionId[sessionId] ?? [],
    )

    trackChatTelemetry('stream.abort.composer_stop', {
      sessionId,
      mode,
      survivingBackgroundSubagents: survivingBackground,
    }, {
      counterKey: 'stream.abort.composer_stop',
      sessionId,
    })

    if (mode === 'withdraw_and_restore') {
      await get().abortStreamForUserEdit(sessionId)
    } else {
      runtime.clearActiveSubmittedMessage(sessionId)
      get().abortStream(sessionId)
    }

    // ：两种 ComposerStopMode 都只级联前台子；后台子仍存活时切换 Notice 文案。
    if (shouldNoteComposerStopBackgroundHint(survivingBackground)) {
      runtime.noteComposerStopWithBackgroundSubagents(sessionId, survivingBackground)
    }
  }

  const abortStreamAndWait = async (timeoutMs = 3_000, sessionId?: string | null): Promise<AbortWaitResult> => {
    // 与 abortStream 对齐：立即标记 intent='interrupted' 让 Pause 标签即时显示（幂等）。
    const targetSid = sessionId ?? get().currentSessionId
    const busyIds = getBusySessionIds()
    if (targetSid) {
      markActiveRunInterrupted(targetSid)
      if (sessionId || busyIds.includes(targetSid)) beginSessionAbort(targetSid)
    }
    if (!sessionId) {
      busyIds.forEach((sid) => {
        if (sid !== targetSid) beginSessionAbort(sid)
      })
    }
    const client = getChatClient()
    const runtimeCancelPromise = targetSid ? cancelRuntimeIfNeeded(targetSid) : null
    try {
      const streamResult = (
        sessionId
          ? await client.abortStreamForSessionAndWait(sessionId, timeoutMs)
          : await client.abortStreamAndWait(timeoutMs)
      ) ?? ({ cancelRequested: false, cancelCompleted: false } as const)
      const runtimeResult = runtimeCancelPromise ? toAbortWaitResult(await runtimeCancelPromise) : null
      const result = runtimeResult
        ? {
          cancelRequested: streamResult.cancelRequested || runtimeResult.cancelRequested,
          cancelCompleted: streamResult.cancelCompleted || runtimeResult.cancelCompleted,
        }
        : streamResult
      if (sessionId) {
        removeStreamingSession(sessionId)
        streamingContent.clear(sessionId)
      } else {
        // ：全局 abort 先对本轮 busy sessions 写 endedAt，再清空投影
        endAllBusySessions(getBusySessionIds())
        streamingContent.clearAll()
      }
      trackChatTelemetry('stream.abort.completed', {
        timeoutMs,
        sessionId: sessionId ?? 'all',
        ...result,
      }, {
        counterKey: 'stream.abort.completed',
      })
      return result
    } catch (error) {
      if (sessionId) {
        removeStreamingSession(sessionId)
        streamingContent.clear(sessionId)
      } else {
        endAllBusySessions(getBusySessionIds())
        streamingContent.clearAll()
      }
      trackChatTelemetry('stream.abort.failed', {
        message: error instanceof Error ? error.message : String(error),
        timeoutMs,
        sessionId: sessionId ?? 'all',
      }, {
        counterKey: 'stream.abort.failed',
        level: 'error',
      })
      return { cancelRequested: false, cancelCompleted: false }
    } finally {
      if (sessionId) {
        performCancelCleanup(sessionId, removeStreamingSession, clearHitlOnAbort)
        scheduleCancelSync(sessionId)
      }
    }
  }

  return { abortStream, abortStreamForUserEdit, abortStreamFromComposer, abortStreamAndWait }
}
