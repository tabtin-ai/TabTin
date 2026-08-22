import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createInterruptHostPendingActions } from '../interruptHostPendingAction'
import type { HostPendingSendItem } from '../../hostPending/hostPendingSendSlice'

vi.mock('../../../execution/sendCooldown', () => ({
  isSendOnCooldown: vi.fn(() => false),
  useSendCooldownStore: {
    getState: () => ({ beginSendCooldown: vi.fn() }),
  },
}))

vi.mock('../../../execution/chatTelemetry', () => ({
  trackChatTelemetry: vi.fn(),
}))

vi.mock('../../../execution/activeRunBinding', () => ({
  noteAbortedRunId: vi.fn(),
}))

vi.mock('../../runtime/applyLocalRuntimeSendAck', () => ({
  beginStartedTurnUi: vi.fn((_sessionId: string, addStreaming: (sid: string) => void) => {
    addStreaming(_sessionId)
  }),
}))

import { noteAbortedRunId } from '../../../execution/activeRunBinding'

function makeItem(runId: string, queuePosition: number): HostPendingSendItem {
  return {
    runId,
    sessionId: 'sess-1',
    queuePosition,
    createdAt: new Date().toISOString(),
    userMessage: {
      id: `m-${runId}`,
      role: 'user',
      content: runId,
      created_at: '',
    } as HostPendingSendItem['userMessage'],
    titleText: runId,
  }
}

describe('createInterruptHostPendingActions', () => {
  const promoteRun = vi.fn()
  const markActiveRunInterrupted = vi.fn()
  const markCurrentRunSuperseded = vi.fn()
  const removeHostPendingSend = vi.fn()
  const upsertObservedUserMessage = vi.fn()
  const addStreamingSession = vi.fn()
  const bumpSessionSidebarOnSend = vi.fn()

  let queue: HostPendingSendItem[]

  const promoteHostPendingSendToFront = (sessionId: string, runId: string) => {
    if (sessionId !== 'sess-1') return
    const index = queue.findIndex((p) => p.runId === runId)
    if (index <= 0) return
    const next = [...queue]
    const [item] = next.splice(index, 1)
    next.unshift(item)
    queue = next.map((p, i) => ({ ...p, queuePosition: i + 1 }))
  }

  beforeEach(() => {
    promoteRun.mockReset()
    markActiveRunInterrupted.mockReset()
    markCurrentRunSuperseded.mockReset()
    removeHostPendingSend.mockReset()
    upsertObservedUserMessage.mockReset()
    addStreamingSession.mockReset()
    bumpSessionSidebarOnSend.mockReset()
    vi.mocked(noteAbortedRunId).mockReset()
    queue = [makeItem('run-a', 1), makeItem('run-b', 2)]
    ;(window as unknown as { tabtin: { agentEngine: { promoteRun: typeof promoteRun } } }).tabtin = {
      agentEngine: { promoteRun },
    }
  })

  function createActions() {
    return createInterruptHostPendingActions({
      get: () => ({
        hostPendingSendsBySessionId: { 'sess-1': queue },
        promoteHostPendingSendToFront,
        removeHostPendingSend,
        upsertObservedUserMessage,
        addStreamingSession,
        interruptAndPromoteHostPending: async () => undefined,
        interruptAndPromoteLatestHostPending: async () => undefined,
      }),
      markActiveRunInterrupted,
      markCurrentRunSuperseded,
      bumpSessionSidebarOnSend,
    })
  }

  it('Host 确认 promoted 后按 abortedRunId 标记旧 run 并上主时间线', async () => {
    promoteRun.mockResolvedValue({
      success: true,
      promoted: true,
      abortedActive: true,
      abortedRunId: 'run-old',
      queuedRunIds: ['run-a'],
    })
    const actions = createActions()

    await actions.interruptAndPromoteHostPending('sess-1', 'run-b')

    expect(promoteRun).toHaveBeenCalledWith({ sessionId: 'sess-1', runId: 'run-b' })
    expect(promoteRun.mock.invocationCallOrder[0]).toBeLessThan(
      markActiveRunInterrupted.mock.invocationCallOrder[0],
    )
    expect(markActiveRunInterrupted).toHaveBeenCalledWith('sess-1', 'run-old')
    expect(markCurrentRunSuperseded).toHaveBeenCalledWith('sess-1', 'run-old')
    expect(queue.map((p) => p.runId)).toEqual(['run-b', 'run-a'])
    expect(queue.map((p) => p.queuePosition)).toEqual([1, 2])
    expect(upsertObservedUserMessage).toHaveBeenCalledWith('sess-1', expect.objectContaining({ id: 'm-run-b' }))
    expect(removeHostPendingSend).toHaveBeenCalledWith('sess-1', 'run-b')
    expect(addStreamingSession).toHaveBeenCalledWith('sess-1', 'run-b')
    expect(bumpSessionSidebarOnSend).toHaveBeenCalledWith('sess-1', 'run-b')
    expect(noteAbortedRunId).not.toHaveBeenCalled()
  })

  it('Host 未返回 abortedRunId 时不按当前 active 猜测中断目标', async () => {
    promoteRun.mockResolvedValue({
      success: true,
      promoted: true,
      abortedActive: false,
      abortedRunId: null,
      queuedRunIds: ['run-a'],
    })
    const actions = createActions()

    await actions.interruptAndPromoteHostPending('sess-1', 'run-b')

    expect(queue.map((p) => p.runId)).toEqual(['run-b', 'run-a'])
    expect(markActiveRunInterrupted).not.toHaveBeenCalled()
    expect(markCurrentRunSuperseded).not.toHaveBeenCalled()
    expect(upsertObservedUserMessage).toHaveBeenCalledWith('sess-1', expect.objectContaining({ id: 'm-run-b' }))
  })

  it.each([
    ['no-bridge', async () => {
      ;(window as unknown as { tabtin: { agentEngine?: { promoteRun?: typeof promoteRun } } }).tabtin = {
        agentEngine: {},
      }
    }],
    ['rejected', async () => {
      promoteRun.mockResolvedValue({ success: false, promoted: false, error: 'busy' })
    }],
    ['throw', async () => {
      promoteRun.mockRejectedValue(new Error('ipc down'))
    }],
  ] as const)('失败路径 %s：非队首项不重排、不上屏', async (_label, arrange) => {
    await arrange()
    const before = queue.map((p) => ({ runId: p.runId, queuePosition: p.queuePosition }))
    const actions = createActions()

    await actions.interruptAndPromoteHostPending('sess-1', 'run-b')

    expect(queue.map((p) => ({ runId: p.runId, queuePosition: p.queuePosition }))).toEqual(before)
    expect(markActiveRunInterrupted).not.toHaveBeenCalled()
    expect(upsertObservedUserMessage).not.toHaveBeenCalled()
    expect(removeHostPendingSend).not.toHaveBeenCalled()
  })
})
