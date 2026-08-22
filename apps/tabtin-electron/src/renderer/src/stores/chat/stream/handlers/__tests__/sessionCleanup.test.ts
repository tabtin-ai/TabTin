import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStep } from '../../../shared/types'
import type { SessionRunProjection } from '../../../execution/sessionRunProjection'

const runtimeState = {
  agentStepsBySessionId: {} as Record<string, AgentStep[]>,
  runStateBySessionId: {} as Record<string, Record<string, unknown>>,
  runProjectionBySessionId: {} as Record<string, SessionRunProjection>,
  toolEventsBySessionId: {} as Record<string, unknown[]>,
  setCancellingForSession: vi.fn(),
  updateRunStateForSession: vi.fn(),
  finalizeInFlightToolEventsForSession: vi.fn(),
}

vi.mock('../../../../useChatRuntimeStore', () => ({
  useChatRuntimeStore: {
    getState: () => runtimeState,
    setState: (partial: unknown) => {
      const next = typeof partial === 'function'
        ? (partial as (s: typeof runtimeState) => Partial<typeof runtimeState>)(runtimeState)
        : partial
      Object.assign(runtimeState, next)
    },
  },
  flushRuntimeBatch: vi.fn(),
}))

const mockMarkSessionSuspended = vi.fn()

vi.mock('@/services/sessionSuspended', () => ({
  markSessionSuspended: (...args: unknown[]) => mockMarkSessionSuspended(...args),
}))

vi.mock('../seqTracker', () => ({
  cleanupWithPendingSyncCheck: vi.fn(() => false),
}))

// syncMessageContent 涉及 useChatStore 的整条 import chain（chat store →
// askUser/approval/checkpoint/sendMessage 等等），测试不需要真跑这段——给个
// noop mock 让 cleanupSessionOnTerminal 主清理路径其他断言能独立验证。
const mockSyncDerivedContentToChatMessage = vi.fn()
vi.mock('../syncMessageContent', () => ({
  syncDerivedContentToChatMessage: (...args: unknown[]) => mockSyncDerivedContentToChatMessage(...args),
}))

import { cleanupSessionOnTerminal, endSessionRun, endSessionRunIfStarted } from '../sessionCleanup'
import { flushRuntimeBatch } from '../../../../useChatRuntimeStore'
import { cleanupWithPendingSyncCheck } from '../seqTracker'

describe('cleanupSessionOnTerminal', () => {
  const sessionId = 'test-session-1'
  const removeStreamingSession = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    runtimeState.agentStepsBySessionId = {}
    runtimeState.toolEventsBySessionId = {}
    runtimeState.runStateBySessionId = {}
    runtimeState.runProjectionBySessionId = {}
    runtimeState.setCancellingForSession = vi.fn()
    runtimeState.updateRunStateForSession = vi.fn()
    runtimeState.finalizeInFlightToolEventsForSession = vi.fn()
    vi.mocked(cleanupWithPendingSyncCheck).mockReturnValue(false)
  })

  it('calls removeStreamingSession', () => {
    cleanupSessionOnTerminal({ sessionId, status: 'done', removeStreamingSession })
    expect(removeStreamingSession).toHaveBeenCalledWith(sessionId, { clearSeqGapSync: false })
  })

  it('把 lifecycle runId 贯穿到 streaming cleanup', () => {
    cleanupSessionOnTerminal({
      sessionId,
      runId: 'run-terminal',
      status: 'done',
      removeStreamingSession,
    })
    expect(removeStreamingSession).toHaveBeenCalledWith(sessionId, {
      clearSeqGapSync: false,
      runId: 'run-terminal',
    })
  })

  it('旧 run 的迟到终态不会清理新 run 的任何 runtime 状态', () => {
    runtimeState.runProjectionBySessionId[sessionId] = {
      busy: true,
      queuedRunIds: [],
      source: 'runtime-sync',
      lastSyncAt: Date.now(),
      hasServerSnapshot: false,
      authoritativeRunState: null,
      localStatus: 'running',
      localRunId: 'run-new',
      localDispatchToken: 'dispatch-new',
      runtimeBusy: true,
      runtimeSyncSeq: 1,
    }

    const result = cleanupSessionOnTerminal({
      sessionId,
      runId: 'run-old',
      status: 'done',
      removeStreamingSession,
    })

    expect(result).toBe(false)
    expect(removeStreamingSession).not.toHaveBeenCalled()
    expect(cleanupWithPendingSyncCheck).not.toHaveBeenCalled()
    expect(runtimeState.updateRunStateForSession).not.toHaveBeenCalled()
    expect(flushRuntimeBatch).not.toHaveBeenCalled()
  })

  it('flushes runtime batch', () => {
    cleanupSessionOnTerminal({ sessionId, status: 'done', removeStreamingSession })
    expect(flushRuntimeBatch).toHaveBeenCalled()
  })

  it('marks running steps as the given status', () => {
    const step1: AgentStep = {
      id: 'step-1', type: 'thinking', title: 'Thinking',
      status: 'running', timestamp: Date.now() - 5000,
    }
    const step2: AgentStep = {
      id: 'step-2', type: 'tool_start', title: 'Tool',
      status: 'done', timestamp: Date.now() - 3000, durationMs: 1000,
    }
    runtimeState.agentStepsBySessionId = { [sessionId]: [step1, step2] }

    cleanupSessionOnTerminal({ sessionId, status: 'error', removeStreamingSession })

    const updated = runtimeState.agentStepsBySessionId[sessionId]
    expect(updated[0].status).toBe('error')
    expect(updated[0].durationMs).toBeGreaterThan(0)
    expect(updated[1].status).toBe('done')
  })

  it('sets cancelling to false', () => {
    cleanupSessionOnTerminal({ sessionId, status: 'done', removeStreamingSession })
    expect(runtimeState.setCancellingForSession).toHaveBeenCalledWith(sessionId, false)
  })

  it('updates run state with done phase', () => {
    cleanupSessionOnTerminal({ sessionId, status: 'done', removeStreamingSession })
    expect(runtimeState.updateRunStateForSession).toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({
        phase: 'done',
        endedAt: expect.any(Number),
        lastError: undefined,
      }),
    )
  })

  it('updates run state with error phase and message', () => {
    cleanupSessionOnTerminal({
      sessionId,
      status: 'error',
      errorMessage: 'something broke',
      removeStreamingSession,
    })
    expect(runtimeState.updateRunStateForSession).toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({
        phase: 'error',
        lastError: 'something broke',
      }),
    )
  })

  it('clears suspended flag (双 store) via markSessionSuspended utility', () => {
    cleanupSessionOnTerminal({ sessionId, status: 'done', removeStreamingSession })
    expect(mockMarkSessionSuspended).toHaveBeenCalledWith(sessionId, false)
  })

  it('returns pending sync status from seqTracker', () => {
    vi.mocked(cleanupWithPendingSyncCheck).mockReturnValue(true)
    const result = cleanupSessionOnTerminal({ sessionId, status: 'done', removeStreamingSession })
    expect(result).toBe(true)
  })

  it('checks pending seq sync before removing streaming state', () => {
    cleanupSessionOnTerminal({ sessionId, status: 'done', removeStreamingSession })
    const cleanupOrder = vi.mocked(cleanupWithPendingSyncCheck).mock.invocationCallOrder[0]
    const removeOrder = removeStreamingSession.mock.invocationCallOrder[0]
    expect(cleanupOrder).toBeLessThan(removeOrder)
  })

  it('does not modify steps when none are running', () => {
    const doneStep: AgentStep = {
      id: 'step-done', type: 'thinking', title: 'Done',
      status: 'done', timestamp: Date.now(), durationMs: 100,
    }
    runtimeState.agentStepsBySessionId = { [sessionId]: [doneStep] }

    cleanupSessionOnTerminal({ sessionId, status: 'error', removeStreamingSession })

    const updated = runtimeState.agentStepsBySessionId[sessionId]
    expect(updated[0].status).toBe('done')
  })

  // ：待办清单终态处理已移除——清单纯从 message.blocks 派生
  // （deriveTodoTimeline），cancel/error 后未收尾批保持原样，不再事件驱动改状态。

  // ─── 侧边栏 + footer 修复 v2（2026-05-17）─────────────────────────────────
  // cancel / hard error 路径 daemon 没机会 emit message_stop，runtime 内部
  // force-finalize 但 ChatMessage.content 不会被自动写入——必须主动调
  // syncDerivedContentToChatMessage 把 derived text 同步过去，否则 footer
  // 在被中断的消息上重新消失（回归到修复前 bug 状态）。
  describe('cancel/error 路径下的 footer content 同步', () => {
    interface MockMessageMeta {
      role: 'assistant' | 'user' | 'system'
      finalized: boolean
    }
    const runtimeWithMeta = runtimeState as typeof runtimeState & {
      messageMetaBySessionId: Record<string, Record<string, MockMessageMeta>>
      messageStop: ReturnType<typeof vi.fn>
    }

    beforeEach(() => {
      runtimeWithMeta.messageStop = vi.fn()
      runtimeWithMeta.messageMetaBySessionId = {}
    })

    it('cancel 时对每条未 finalize 的 assistant 消息调一次 syncDerivedContentToChatMessage', () => {
      runtimeWithMeta.messageMetaBySessionId[sessionId] = {
        'msg-1': { role: 'assistant', finalized: false },
        'msg-2': { role: 'assistant', finalized: false },
        'msg-3': { role: 'assistant', finalized: true }, // 已 finalize 跳过
      }

      cleanupSessionOnTerminal({ sessionId, status: 'cancelled', removeStreamingSession })

      // messageStop 被调 2 次（msg-1 / msg-2，msg-3 已 finalize 跳过）
      expect(runtimeWithMeta.messageStop).toHaveBeenCalledTimes(2)
      // syncDerivedContentToChatMessage 同步被调 2 次——这是修复 v2 关键断言
      expect(mockSyncDerivedContentToChatMessage).toHaveBeenCalledTimes(2)
      expect(mockSyncDerivedContentToChatMessage).toHaveBeenCalledWith(sessionId, 'msg-1')
      expect(mockSyncDerivedContentToChatMessage).toHaveBeenCalledWith(sessionId, 'msg-2')
    })

    it('error 时同样调 syncDerivedContentToChatMessage（不只是 cancel）', () => {
      runtimeWithMeta.messageMetaBySessionId[sessionId] = {
        'msg-1': { role: 'assistant', finalized: false },
      }

      cleanupSessionOnTerminal({ sessionId, status: 'error', removeStreamingSession })

      expect(mockSyncDerivedContentToChatMessage).toHaveBeenCalledTimes(1)
      expect(mockSyncDerivedContentToChatMessage).toHaveBeenCalledWith(sessionId, 'msg-1')
    })

    it('done 时不调 syncDerivedContentToChatMessage（正常路径走 contentBlockHandler.handleMessageStop）', () => {
      runtimeWithMeta.messageMetaBySessionId[sessionId] = {
        'msg-1': { role: 'assistant', finalized: false },
      }

      cleanupSessionOnTerminal({ sessionId, status: 'done', removeStreamingSession })

      // status='done' 不进 force-finalize 分支，不调 syncDerivedContentToChatMessage
      expect(mockSyncDerivedContentToChatMessage).not.toHaveBeenCalled()
    })

    it('messageStop 调用顺序在 syncDerivedContentToChatMessage 之前（依赖 meta.text_summary 已派生）', () => {
      runtimeWithMeta.messageMetaBySessionId[sessionId] = {
        'msg-1': { role: 'assistant', finalized: false },
      }

      cleanupSessionOnTerminal({ sessionId, status: 'cancelled', removeStreamingSession })

      const stopOrder = runtimeWithMeta.messageStop.mock.invocationCallOrder[0]
      const syncOrder = mockSyncDerivedContentToChatMessage.mock.invocationCallOrder[0]
      expect(stopOrder).toBeLessThan(syncOrder)
    })

    it('helper 抛错时 fail-soft 不阻塞主清理路径', () => {
      runtimeWithMeta.messageMetaBySessionId[sessionId] = {
        'msg-1': { role: 'assistant', finalized: false },
      }
      mockSyncDerivedContentToChatMessage.mockImplementationOnce(() => {
        throw new Error('store not initialized')
      })
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      // 不抛
      expect(() => {
        cleanupSessionOnTerminal({ sessionId, status: 'cancelled', removeStreamingSession })
      }).not.toThrow()

      // 但走了 console.warn 兜底
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('syncDerivedContentToChatMessage failed'),
        expect.any(Error),
      )

      // 主清理路径其他动作正常进行；#7669 cancelled 也会 settle cancelling
      expect(removeStreamingSession).toHaveBeenCalled()
      expect(runtimeState.setCancellingForSession).toHaveBeenCalledWith(sessionId, false)
      consoleWarnSpy.mockRestore()
    })

    it('#7669 cancelled 清除 cancelling（不再等 lifecycle settle）', () => {
      cleanupSessionOnTerminal({ sessionId, status: 'cancelled', removeStreamingSession })
      expect(runtimeState.setCancellingForSession).toHaveBeenCalledWith(sessionId, false)
    })
  })

  // ── ：abort / cancel 收尾 in-flight ToolEvent ────────────────
  // 现象：工具/终端执行中点停止后 UI 仍显示 "tool in flight" / partial。
  // 根因：StreamManager._doAbortSession 先退订 WS，daemon 的 tool_failed /
  // lifecycle.end 丢包 → ToolEvent 卡 phase='start'。cleanupSessionOnTerminal
  // 在 cancel/error 终态调 finalizeInFlightToolEventsForSession 兜底收尾。
  describe('#1332 abort 收尾 in-flight ToolEvent', () => {
    it('cancel 时调 finalizeInFlightToolEventsForSession', () => {
      cleanupSessionOnTerminal({ sessionId, status: 'cancelled', removeStreamingSession })
      expect(runtimeState.finalizeInFlightToolEventsForSession).toHaveBeenCalledWith(sessionId)
    })

    it('error 时同样调（覆盖 terminated → error 映射路径）', () => {
      cleanupSessionOnTerminal({ sessionId, status: 'error', removeStreamingSession })
      expect(runtimeState.finalizeInFlightToolEventsForSession).toHaveBeenCalledWith(sessionId)
    })

    it('done 时不调（正常完成路径由 tool_completed notice 收尾，无需兜底）', () => {
      cleanupSessionOnTerminal({ sessionId, status: 'done', removeStreamingSession })
      expect(runtimeState.finalizeInFlightToolEventsForSession).not.toHaveBeenCalled()
    })

    it('finalize 抛错时 fail-soft 不阻塞主清理路径', () => {
      runtimeState.finalizeInFlightToolEventsForSession.mockImplementationOnce(() => {
        throw new Error('store not initialized')
      })
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      expect(() => {
        cleanupSessionOnTerminal({ sessionId, status: 'cancelled', removeStreamingSession })
      }).not.toThrow()

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('finalizeInFlightToolEventsForSession failed'),
        expect.any(Error),
      )
      // 主清理路径仍正常；#7669 cancelled 也会 settle cancelling
      expect(removeStreamingSession).toHaveBeenCalled()
      expect(runtimeState.setCancellingForSession).toHaveBeenCalledWith(sessionId, false)
      consoleWarnSpy.mockRestore()
    })
  })

  describe('#6529 endSessionRun seam', () => {
    it('endSessionRun 与 cleanupSessionOnTerminal 等价（写 endedAt + 清 busy）', () => {
      endSessionRun({ sessionId, status: 'cancelled', removeStreamingSession })
      expect(removeStreamingSession).toHaveBeenCalledWith(sessionId, { clearSeqGapSync: false })
      expect(runtimeState.updateRunStateForSession).toHaveBeenCalledWith(
        sessionId,
        expect.objectContaining({ phase: 'cancelled', endedAt: expect.any(Number) }),
      )
    })

    it('clearSeqGapSync=true 时透传给 removeStreamingSession', () => {
      endSessionRun({
        sessionId,
        status: 'cancelled',
        removeStreamingSession,
        clearSeqGapSync: true,
      })
      expect(removeStreamingSession).toHaveBeenCalledWith(sessionId, { clearSeqGapSync: true })
    })

    it('endSessionRunIfStarted：未开表时只清 busy，不写 endedAt', () => {
      runtimeState.runStateBySessionId = {}
      const result = endSessionRunIfStarted({
        sessionId,
        status: 'error',
        removeStreamingSession,
      })
      expect(result).toBe(false)
      expect(removeStreamingSession).toHaveBeenCalledWith(sessionId, { clearSeqGapSync: false })
      expect(runtimeState.updateRunStateForSession).not.toHaveBeenCalled()
    })

    it('endSessionRunIfStarted：已开表且 endedAt 空 → 完整收口', () => {
      vi.mocked(cleanupWithPendingSyncCheck).mockReturnValue(false)
      runtimeState.runStateBySessionId = {
        [sessionId]: { startedAt: Date.now() - 1000, endedAt: null },
      }
      const result = endSessionRunIfStarted({
        sessionId,
        status: 'error',
        errorMessage: 'boom',
        removeStreamingSession,
      })
      expect(result).toBe(false)
      expect(runtimeState.updateRunStateForSession).toHaveBeenCalledWith(
        sessionId,
        expect.objectContaining({ phase: 'error', endedAt: expect.any(Number), lastError: 'boom' }),
      )
    })

    it('endSessionRunIfStarted：已 endedAt → 只清 busy', () => {
      runtimeState.runStateBySessionId = {
        [sessionId]: { startedAt: Date.now() - 1000, endedAt: Date.now() },
      }
      endSessionRunIfStarted({ sessionId, status: 'cancelled', removeStreamingSession })
      expect(removeStreamingSession).toHaveBeenCalled()
      expect(runtimeState.updateRunStateForSession).not.toHaveBeenCalled()
    })
  })
})
