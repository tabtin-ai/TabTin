/**
 * FR-05 回归测试：Runtime emit 的 compaction mode 前后端字符串对齐。
 *
 * 覆盖 5 个新 mode（auto / reactive / emergency_blocking / recovery_413 /
 * hard_trim）和 2 个历史 mode（auto_condense / emergency），确保每种
 * mode 都走到显式 i18n 文案分支，不再默认落到 compactionComplete。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentStreamEvents } from '@tabtin/ws-gateway-client'
import type { AgentStep } from '../../../shared/types'

const {
  mockFinalizeDoneEvent,
  mockRefreshPromotionCreditAfterDone,
} = vi.hoisted(() => ({
  mockFinalizeDoneEvent: vi.fn(),
  mockRefreshPromotionCreditAfterDone: vi.fn(),
}))

vi.mock('@/i18n', () => ({
  default: {
    // 返回 `${key}|${vars}` 方便断言调用参数
    t: (key: string, vars?: Record<string, unknown>) => {
      if (!vars) return key
      const entries = Object.entries(vars)
        .filter(([k]) => k !== 'defaultValue')
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(',')
      return entries ? `${key}|${entries}` : key
    },
  },
}))

vi.mock('@tabtin/ws-gateway-client', () => ({
  AgentStreamEvents: {
    DONE: 'agent.stream.done',
    TODO: 'agent.stream.todo',
    SSH_OUTPUT: 'agent.stream.ssh_output',
    COMPACTION: 'agent.stream.compaction',
  },
}))

vi.mock('@/stores/chat/useChatStore', () => ({
  useChatStore: Object.assign(vi.fn(), {
    getState: () => ({
      messagesBySessionId: {},
      upsertMessage: vi.fn(),
    }),
  }),
}))

vi.mock('@/services/chatApi', () => ({
  getChatClient: () => ({ sessions: { get: vi.fn() } }),
}))

vi.mock('../doneEventFinalizer', () => ({
  finalizeDoneEvent: mockFinalizeDoneEvent,
}))

vi.mock('../promotionCreditRefresh', () => ({
  refreshPromotionCreditAfterDone: mockRefreshPromotionCreditAfterDone,
}))

import { handleMiscEvent } from '../miscHandler'
import type { HandlerContext, StreamHandlerStore, AgentStreamMessage } from '../streamHandlerTypes'

function createHandlerContext(): {
  ctx: HandlerContext
  store: StreamHandlerStore
  pushAgentStepForSession: ReturnType<typeof vi.fn>
  updateAgentStepForSession: ReturnType<typeof vi.fn>
} {
  const steps: AgentStep[] = []
  const pushAgentStepForSession = vi.fn((_sid: string, step: AgentStep) => {
    steps.push(step)
  })
  const updateAgentStepForSession = vi.fn((_sid: string, id: string, partial: Partial<AgentStep>) => {
    const idx = steps.findIndex(s => s.id === id)
    if (idx >= 0) steps[idx] = { ...steps[idx], ...partial }
  })

  const store = {
    agentStepsBySessionId: { 's1': steps },
    toolEventsBySessionId: {},
    assistantEventsBySessionId: {},
    subagentRunsBySessionId: {},
    runStateBySessionId: {},
    agentModeBySessionId: {},
    cancellingBySessionId: {},

    updateRunStateForSession: vi.fn(),
    setCancellingForSession: vi.fn(),
    pushAgentStepForSession,
    updateAgentStepForSession,
    upsertToolEventForSession: vi.fn(),
    getEffectiveToolEventForSession: vi.fn(() => undefined),
    upsertAssistantEventForSession: vi.fn(),
    resetAssistantDeltasForSession: vi.fn(),
    upsertSubagentRunForSession: vi.fn(),
    appendRichContentBlocks: vi.fn(),
    clearRichContentBlocks: vi.fn(),
  } as unknown as StreamHandlerStore

  const ctx: HandlerContext = {
    sessionId: 's1',
    get: () => store,
    set: vi.fn(),
    addStreamingSession: vi.fn(),
    removeStreamingSession: vi.fn(),
    client: { sessions: { get: vi.fn() } } as unknown as HandlerContext['client'],
    updateSessionTokenUsageInCaches: vi.fn(),
    updateSessionInCaches: vi.fn(),
    onLifecycleEnd: vi.fn(),
    notifyPrefix: '',
  }
  return { ctx, store, pushAgentStepForSession, updateAgentStepForSession }
}

function makeCompactionEnd(mode: string, stats: Record<string, unknown> = {}): AgentStreamMessage {
  return {
    type: AgentStreamEvents.COMPACTION,
    payload: { phase: 'end', mode, stats },
  }
}

describe('miscHandler – DONE 终态收尾（ 单链路）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('DONE(error) 只走 finalizeDoneEvent，不再 inject', () => {
    const { ctx } = createHandlerContext()
    const message = {
      type: AgentStreamEvents.DONE,
      payload: {
        error: true,
        error_class: 'LLM_ERROR',
        error_message: '当前轮调用失败',
      },
    } as AgentStreamMessage

    handleMiscEvent(message, ctx)

    expect(mockFinalizeDoneEvent).toHaveBeenCalledOnce()
    expect(mockFinalizeDoneEvent).toHaveBeenCalledWith('s1', message.payload)
    expect(mockRefreshPromotionCreditAfterDone).toHaveBeenCalledWith('s1')
  })

  it('正常 DONE 仍 finalize + 刷新点券', () => {
    const { ctx } = createHandlerContext()

    handleMiscEvent({
      type: AgentStreamEvents.DONE,
      payload: {},
    } as AgentStreamMessage, ctx)

    expect(mockFinalizeDoneEvent).toHaveBeenCalledOnce()
    expect(mockFinalizeDoneEvent).toHaveBeenCalledWith('s1', {})
    expect(mockRefreshPromotionCreditAfterDone).toHaveBeenCalledWith('s1')
  })
})

describe('miscHandler – compaction mode mapping (FR-05)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('maps Runtime mode "auto" to compactionSmart', () => {
    const { ctx, pushAgentStepForSession } = createHandlerContext()
    handleMiscEvent(makeCompactionEnd('auto', { message_count_before: 12, message_count_after: 3 }), ctx)
    expect(pushAgentStepForSession).toHaveBeenCalledTimes(1)
    const step = pushAgentStepForSession.mock.calls[0][1] as AgentStep
    expect(step.title).toMatch(/^chat:agentSteps\.compactionSmart\|before=12,after=3$/)
  })

  it('maps Runtime mode "reactive" to compactionSmart', () => {
    const { ctx, pushAgentStepForSession } = createHandlerContext()
    handleMiscEvent(makeCompactionEnd('reactive', { message_count_before: 8, message_count_after: 2 }), ctx)
    const step = pushAgentStepForSession.mock.calls[0][1] as AgentStep
    expect(step.title).toMatch(/^chat:agentSteps\.compactionSmart\|before=8,after=2$/)
  })

  it('maps Runtime mode "emergency_blocking" to compactionEmergency', () => {
    const { ctx, pushAgentStepForSession } = createHandlerContext()
    handleMiscEvent(makeCompactionEnd('emergency_blocking', { message_count_after: 5 }), ctx)
    const step = pushAgentStepForSession.mock.calls[0][1] as AgentStep
    expect(step.title).toMatch(/^chat:agentSteps\.compactionEmergency\|kept=5$/)
  })

  it('maps Runtime mode "recovery_413" to compactionRecovery413 (dedicated key, not fallback)', () => {
    const { ctx, pushAgentStepForSession } = createHandlerContext()
    handleMiscEvent(makeCompactionEnd('recovery_413'), ctx)
    const step = pushAgentStepForSession.mock.calls[0][1] as AgentStep
    expect(step.title).toBe('chat:agentSteps.compactionRecovery413')
    expect(step.title).not.toBe('chat:agentSteps.compactionComplete')
  })

  it('maps Runtime mode "hard_trim" to compactionHardTrim (dedicated key, not fallback)', () => {
    const { ctx, pushAgentStepForSession } = createHandlerContext()
    handleMiscEvent(makeCompactionEnd('hard_trim'), ctx)
    const step = pushAgentStepForSession.mock.calls[0][1] as AgentStep
    expect(step.title).toBe('chat:agentSteps.compactionHardTrim')
    expect(step.title).not.toBe('chat:agentSteps.compactionComplete')
  })

  it('preserves legacy cloud-orchestration mode "auto_condense" → compactionSmart (backward compat)', () => {
    const { ctx, pushAgentStepForSession } = createHandlerContext()
    handleMiscEvent(makeCompactionEnd('auto_condense', { message_count_before: 10, message_count_after: 4 }), ctx)
    const step = pushAgentStepForSession.mock.calls[0][1] as AgentStep
    expect(step.title).toMatch(/^chat:agentSteps\.compactionSmart\|before=10,after=4$/)
  })

  it('preserves legacy cloud-orchestration mode "emergency" → compactionEmergency (backward compat)', () => {
    const { ctx, pushAgentStepForSession } = createHandlerContext()
    handleMiscEvent(makeCompactionEnd('emergency', { message_count_after: 7 }), ctx)
    const step = pushAgentStepForSession.mock.calls[0][1] as AgentStep
    expect(step.title).toMatch(/^chat:agentSteps\.compactionEmergency\|kept=7$/)
  })

  it('falls back to compactionComplete for internal-only modes (native / micro) and unknown', () => {
    const cases = ['native', 'micro', 'something-new']
    for (const mode of cases) {
      const { ctx, pushAgentStepForSession } = createHandlerContext()
      handleMiscEvent(makeCompactionEnd(mode), ctx)
      const step = pushAgentStepForSession.mock.calls[0][1] as AgentStep
      expect(step.title).toBe('chat:agentSteps.compactionComplete')
    }
  })

  it('start phase still triggers compactionInProgress regardless of mode', () => {
    const { ctx, pushAgentStepForSession } = createHandlerContext()
    handleMiscEvent({
      type: AgentStreamEvents.COMPACTION,
      payload: { phase: 'start', mode: 'recovery_413' },
    }, ctx)
    const step = pushAgentStepForSession.mock.calls[0][1] as AgentStep
    expect(step.title).toBe('chat:agentSteps.compactionInProgress')
    expect(step.status).toBe('running')
  })
})

// ─── W4.2 — emergency_blocking + tokens_freed === 0 静默守卫 ─────────
describe('miscHandler – W4.2 emergency_blocking with freed=0 silent guard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('emergency_blocking + tokens_freed=0: 不 push 新 step, 不显示"已截断"toast', () => {
    const { ctx, pushAgentStepForSession, updateAgentStepForSession } = createHandlerContext()
    handleMiscEvent(
      makeCompactionEnd('emergency_blocking', {
        messages_before: 5,
        messages_after: 5,
        tokens_before: 411_503,
        tokens_after: 411_503,
        tokens_freed: 0,
      }),
      ctx,
    )
    // 守卫触发：没有 running step → 不 push 任何新 step、不 update
    expect(pushAgentStepForSession).not.toHaveBeenCalled()
    expect(updateAgentStepForSession).not.toHaveBeenCalled()
  })

  it('emergency_blocking + tokens_freed=0: 有 running step 时改中性完成 title + status="done"', () => {
    const { ctx, store, updateAgentStepForSession } = createHandlerContext()
    // 模拟之前 phase=start 已经 push 一个 running step
    const runningStep: AgentStep = {
      id: 'compaction-s1',
      type: 'compaction',
      title: 'chat:agentSteps.compactionInProgress',
      detail: '',
      status: 'running',
      timestamp: 0,
    }
    ;(store.agentStepsBySessionId as Record<string, AgentStep[]>)['s1'] = [runningStep]

    handleMiscEvent(
      makeCompactionEnd('emergency_blocking', {
        messages_before: 5,
        messages_after: 5,
        tokens_freed: 0,
      }),
      ctx,
    )
    // update title (中性) + status='done'，避免"压缩中→done 但 title 没变"违和
    expect(updateAgentStepForSession).toHaveBeenCalledTimes(1)
    const updateArgs = updateAgentStepForSession.mock.calls[0]
    expect(updateArgs[1]).toBe('compaction-s1')
    expect(updateArgs[2]).toEqual({
      title: 'chat:agentSteps.compactionNoOp', // 中性完成态
      status: 'done',
    })
  })

  it('emergency_blocking + tokens_freed > 0: 正常显示 compactionEmergency 文案（不被守卫误捕）', () => {
    const { ctx, pushAgentStepForSession } = createHandlerContext()
    handleMiscEvent(
      makeCompactionEnd('emergency_blocking', {
        messages_before: 10,
        messages_after: 5,
        tokens_freed: 50_000,
      }),
      ctx,
    )
    expect(pushAgentStepForSession).toHaveBeenCalledTimes(1)
    const step = pushAgentStepForSession.mock.calls[0][1] as AgentStep
    expect(step.title).toMatch(/^chat:agentSteps\.compactionEmergency\|kept=5$/)
  })

  it('legacy "emergency" + tokens_freed=0: 同样静默（云端历史 mode 也保护）', () => {
    const { ctx, pushAgentStepForSession } = createHandlerContext()
    handleMiscEvent(
      makeCompactionEnd('emergency', {
        messages_before: 8,
        messages_after: 8,
        tokens_freed: 0,
      }),
      ctx,
    )
    expect(pushAgentStepForSession).not.toHaveBeenCalled()
  })

  it('其他 mode (auto / reactive / hard_trim) + tokens_freed=0: 不被守卫拦截（这些 mode 即使 freed=0 也是合理事件）', () => {
    const cases = ['auto', 'reactive', 'hard_trim', 'recovery_413', 'truncate_head']
    for (const mode of cases) {
      const { ctx, pushAgentStepForSession } = createHandlerContext()
      handleMiscEvent(
        makeCompactionEnd(mode, {
          messages_before: 5,
          messages_after: 5,
          tokens_freed: 0,
        }),
        ctx,
      )
      expect(pushAgentStepForSession, `mode=${mode}`).toHaveBeenCalledTimes(1)
    }
  })
})
