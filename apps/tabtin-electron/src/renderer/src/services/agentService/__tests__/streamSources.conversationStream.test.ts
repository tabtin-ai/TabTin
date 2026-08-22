import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConversationStreamDeps } from '../streamSources'

/**
 * ：来源区分下沉主进程后，渲染进程只挂一条常驻源 `attachMainStream`——订阅唯一 IPC
 * channel（`onStreamEvent`）+ 经 `watchSession` / `unwatchSession` 与主进程握手观察意图，
 * 不再自持 WS 订阅（`subscribeGatewayTopic`）。本测试覆盖该生命周期握手。
 */

const mockOnStreamEvent = vi.fn(() => vi.fn())
const mockUnsub = vi.fn()
const mockWatchSession = vi.fn()
const mockUnwatchSession = vi.fn()

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

describe('attachMainStream（常驻单源生命周期）', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    mockWatchSession.mockResolvedValue({ success: true })
    mockUnwatchSession.mockResolvedValue({ success: true })
    mockOnStreamEvent.mockReturnValue(mockUnsub)
    const { __resetBusyRetainForTest } = await import('../streamSources')
    __resetBusyRetainForTest()
    Object.defineProperty(window, 'tabtin', {
      configurable: true,
      value: {
        agentEngine: {
          onStreamEvent: mockOnStreamEvent,
          watchSession: mockWatchSession,
          unwatchSession: mockUnwatchSession,
        },
      },
    })
  })

  it('attach 订阅唯一 IPC channel 并向主进程声明观察意图', async () => {
    const { attachMainStream } = await import('../streamSources')
    const detach = attachMainStream('sess-1', deps())
    expect(mockOnStreamEvent).toHaveBeenCalled()
    expect(mockWatchSession).toHaveBeenCalledWith('sess-1')
    expect(typeof detach).toBe('function')
    detach()
  })

  it('共享入口 watchSession 携带当前 shareId', async () => {
    const { attachMainStream } = await import('../streamSources')
    const detach = attachMainStream('sess-shared', deps(), { shareId: 'share-1' })

    expect(mockWatchSession).toHaveBeenCalledWith(
      'sess-shared',
      { shareId: 'share-1' },
    )

    detach()
  })

  it('detach 撤销观察意图并解除 IPC 订阅', async () => {
    const { attachMainStream } = await import('../streamSources')
    const detach = attachMainStream('sess-1', deps())
    detach()
    expect(mockUnwatchSession).toHaveBeenCalledWith('sess-1')
    expect(mockUnsub).toHaveBeenCalled()
  })
})
