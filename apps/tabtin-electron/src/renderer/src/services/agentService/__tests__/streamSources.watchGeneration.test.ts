/**
 * ：StrictMode / 重挂时旧 watch Promise 晚到，不得补偿 unwatch 拆掉新 live。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConversationStreamDeps } from '../streamSources'

const mockOnStreamEvent = vi.fn(() => vi.fn())
const mockUnwatchSession = vi.fn()
let watchResolvers: Array<(value: { success: boolean }) => void> = []

vi.mock('../index', () => ({
  getSessionController: () => ({
    attachStream: () => ({
      ingest: vi.fn(),
      dispatch: vi.fn(),
      hasPendingRunActiveSignal: vi.fn(() => false),
      detach: vi.fn(),
    }),
  }),
  __registerBusyRetainResetForTest: vi.fn(),
  __registerEnsureLiveStreamIpc: vi.fn(),
}))

vi.mock('@/stores/useChatRuntimeStore', () => ({
  useChatRuntimeStore: { getState: () => ({}), setState: vi.fn() },
}))

vi.mock('@/stores/chat/execution/sessionRunReconcile', () => ({
  reconcileSessionRunState: vi.fn(() => Promise.resolve(false)),
}))

function deps(): ConversationStreamDeps {
  return {
    getContext: () => ({}),
    client: { sessions: { get: vi.fn() } } as never,
    addStreamingSession: vi.fn(),
    removeStreamingSession: vi.fn(),
    updateSessionTokenUsageInCaches: vi.fn(),
    updateSessionInCaches: vi.fn(),
  }
}

describe('attachMainStream · watch 代次 ', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    watchResolvers = []
    mockOnStreamEvent.mockReturnValue(vi.fn())
    mockUnwatchSession.mockResolvedValue({ success: true })
    const { __resetBusyRetainForTest } = await import('../streamSources')
    __resetBusyRetainForTest()
    Object.defineProperty(window, 'tabtin', {
      configurable: true,
      value: {
        agentEngine: {
          onStreamEvent: mockOnStreamEvent,
          watchSession: vi.fn(
            () => new Promise<{ success: boolean }>((resolve) => {
              watchResolvers.push(resolve)
            }),
          ),
          unwatchSession: mockUnwatchSession,
        },
      },
    })
  })

  it('旧 watch resolve 晚于新 attach：不得 unwatch 拆掉新 live', async () => {
    const {
      attachMainStream,
      __isWatchConfirmedForTest,
    } = await import('../streamSources')

    const detach1 = attachMainStream('sess-gen', deps())
    expect(watchResolvers).toHaveLength(1)

    // StrictMode cleanup：拆 live1（会主动 unwatch 一次）
    detach1()
    expect(mockUnwatchSession).toHaveBeenCalledTimes(1)
    mockUnwatchSession.mockClear()

    // remount live2
    const detach2 = attachMainStream('sess-gen', deps())
    expect(watchResolvers).toHaveLength(2)

    // 先让新 live 的 watch 成功
    watchResolvers[1]!({ success: true })
    await vi.waitFor(() => expect(__isWatchConfirmedForTest('sess-gen')).toBe(true))

    // 旧 live1 的 watch 晚到 success——旧逻辑会 callUnwatch，拆掉 live2
    watchResolvers[0]!({ success: true })
    await Promise.resolve()
    await Promise.resolve()

    expect(mockUnwatchSession).not.toHaveBeenCalled()
    expect(__isWatchConfirmedForTest('sess-gen')).toBe(true)

    detach2()
  })

  it('teardown 后无新 live：旧 watch success 仍补偿 unwatch', async () => {
    const { attachMainStream } = await import('../streamSources')
    const detach = attachMainStream('sess-orphan', deps())
    expect(watchResolvers).toHaveLength(1)
    detach()
    mockUnwatchSession.mockClear()

    watchResolvers[0]!({ success: true })
    await Promise.resolve()
    await Promise.resolve()

    expect(mockUnwatchSession).toHaveBeenCalledWith('sess-orphan')
  })
})
