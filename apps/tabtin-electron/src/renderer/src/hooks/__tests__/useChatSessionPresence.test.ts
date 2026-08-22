/**
 * useChatSessionPresence — 前台会话 presence 上报
 *
 * 覆盖：session 切换、focus/blur、visibility、reconnect、30s heartbeat、unmount clear、
 * disabled 不发、WS 未 ready 不缓存伪造。纯逻辑见 services/__tests__/chatSessionPresence.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import {
  ChatSessionPresenceEvents,
  ChatSessionPresenceTiming,
} from '@tabtin/ws-gateway-client'

const mockRequest = vi.fn()
const mockIsConnected = vi.fn(() => true)
const mockOnReconnectedEvent = vi.fn()
const mockOffReconnectedEvent = vi.fn()

const chatState = vi.hoisted(() => ({
  currentSessionId: null as string | null,
  _subscribers: [] as Array<(
    state: { currentSessionId: string | null },
    prev: { currentSessionId: string | null },
  ) => void>,
}))

vi.mock('@/services/chatApi', () => ({
  getChatClient: () => ({
    getGateway: () => ({
      request: mockRequest,
      isConnected: mockIsConnected,
      onReconnectedEvent: mockOnReconnectedEvent,
      offReconnectedEvent: mockOffReconnectedEvent,
    }),
  }),
}))

vi.mock('@stores/chat/useChatStore', () => {
  const store = Object.assign(
    (selector: (state: { currentSessionId: string | null }) => unknown) =>
      selector({ currentSessionId: chatState.currentSessionId }),
    {
      getState: () => ({ currentSessionId: chatState.currentSessionId }),
      subscribe: (
        cb: (
          state: { currentSessionId: string | null },
          prev: { currentSessionId: string | null },
        ) => void,
      ) => {
        chatState._subscribers.push(cb)
        return () => {
          const idx = chatState._subscribers.indexOf(cb)
          if (idx >= 0) chatState._subscribers.splice(idx, 1)
        }
      },
      setState: (partial: { currentSessionId: string | null }) => {
        const prev = { currentSessionId: chatState.currentSessionId }
        chatState.currentSessionId = partial.currentSessionId
        const next = { currentSessionId: chatState.currentSessionId }
        for (const cb of [...chatState._subscribers]) {
          cb(next, prev)
        }
      },
    },
  )
  return { useChatStore: store }
})

vi.mock('@/utils/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    log: vi.fn(),
  }),
}))

function setDocumentFocus(focused: boolean) {
  vi.spyOn(document, 'hasFocus').mockReturnValue(focused)
}

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  })
}

function setCurrentSession(sessionId: string | null) {
  act(() => {
    const prev = { currentSessionId: chatState.currentSessionId }
    chatState.currentSessionId = sessionId
    const next = { currentSessionId: sessionId }
    for (const cb of [...chatState._subscribers]) {
      cb(next, prev)
    }
  })
}

function createDeferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('useChatSessionPresence', () => {
  let reconnectHandler: (() => void) | null = null

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    chatState.currentSessionId = null
    chatState._subscribers = []
    reconnectHandler = null
    mockIsConnected.mockReturnValue(true)
    mockRequest.mockResolvedValue({ ok: true })
    mockOnReconnectedEvent.mockImplementation((handler: () => void) => {
      reconnectHandler = handler
    })
    setDocumentFocus(true)
    setVisibility('visible')
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('enabled=false 时不订阅、不发 presence', async () => {
    const { useChatSessionPresence } = await import('../useChatSessionPresence')
    chatState.currentSessionId = 'sess-1'

    renderHook(() => useChatSessionPresence({ enabled: false }))

    expect(mockRequest).not.toHaveBeenCalled()
    expect(mockOnReconnectedEvent).not.toHaveBeenCalled()
    expect(chatState._subscribers).toHaveLength(0)
  })

  it('聚焦可见的 currentSession 立即报 active', async () => {
    const { useChatSessionPresence } = await import('../useChatSessionPresence')
    chatState.currentSessionId = 'sess-active'

    renderHook(() => useChatSessionPresence({ enabled: true }))

    await act(async () => {
      await Promise.resolve()
    })

    expect(mockRequest).toHaveBeenCalledWith(
      ChatSessionPresenceEvents.PRESENCE,
      { session_id: 'sess-active' },
    )
  })

  it('session 切换到另一 id 立即报新 active；切到 null 立即 clear', async () => {
    const { useChatSessionPresence } = await import('../useChatSessionPresence')
    chatState.currentSessionId = 'sess-a'

    renderHook(() => useChatSessionPresence({ enabled: true }))
    await act(async () => { await Promise.resolve() })
    mockRequest.mockClear()

    setCurrentSession('sess-b')
    await act(async () => { await Promise.resolve() })
    expect(mockRequest).toHaveBeenCalledWith(
      ChatSessionPresenceEvents.PRESENCE,
      { session_id: 'sess-b' },
    )

    mockRequest.mockClear()
    setCurrentSession(null)
    await act(async () => { await Promise.resolve() })
    expect(mockRequest).toHaveBeenCalledWith(
      ChatSessionPresenceEvents.PRESENCE,
      { session_id: null },
    )
  })

  it('window blur / focus 立即 clear / 再报 active', async () => {
    const { useChatSessionPresence } = await import('../useChatSessionPresence')
    chatState.currentSessionId = 'sess-1'

    renderHook(() => useChatSessionPresence({ enabled: true }))
    await act(async () => { await Promise.resolve() })
    mockRequest.mockClear()

    setDocumentFocus(false)
    await act(async () => {
      window.dispatchEvent(new Event('blur'))
      await Promise.resolve()
    })
    expect(mockRequest).toHaveBeenCalledWith(
      ChatSessionPresenceEvents.PRESENCE,
      { session_id: null },
    )

    mockRequest.mockClear()
    setDocumentFocus(true)
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      await Promise.resolve()
    })
    expect(mockRequest).toHaveBeenCalledWith(
      ChatSessionPresenceEvents.PRESENCE,
      { session_id: 'sess-1' },
    )
  })

  it('visibility hidden / visible 立即 clear / 再报', async () => {
    const { useChatSessionPresence } = await import('../useChatSessionPresence')
    chatState.currentSessionId = 'sess-1'

    renderHook(() => useChatSessionPresence({ enabled: true }))
    await act(async () => { await Promise.resolve() })
    mockRequest.mockClear()

    setVisibility('hidden')
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      await Promise.resolve()
    })
    expect(mockRequest).toHaveBeenCalledWith(
      ChatSessionPresenceEvents.PRESENCE,
      { session_id: null },
    )

    mockRequest.mockClear()
    setVisibility('visible')
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      await Promise.resolve()
    })
    expect(mockRequest).toHaveBeenCalledWith(
      ChatSessionPresenceEvents.PRESENCE,
      { session_id: 'sess-1' },
    )
  })

  it('pagehide 即使仍聚焦可见也直接 force clear', async () => {
    const { useChatSessionPresence } = await import('../useChatSessionPresence')
    chatState.currentSessionId = 'sess-1'

    renderHook(() => useChatSessionPresence({ enabled: true }))
    await act(async () => { await Promise.resolve() })
    mockRequest.mockClear()

    await act(async () => {
      window.dispatchEvent(new Event('pagehide'))
      await Promise.resolve()
    })
    expect(mockRequest).toHaveBeenCalledWith(
      ChatSessionPresenceEvents.PRESENCE,
      { session_id: null },
    )
  })

  it('blur 会排在未完成 set 之后，最终 clear 覆盖旧 session', async () => {
    const { useChatSessionPresence } = await import('../useChatSessionPresence')
    const firstResponse = createDeferred<{ ok: true }>()
    mockRequest.mockImplementationOnce(() => firstResponse.promise).mockResolvedValue({ ok: true })
    chatState.currentSessionId = 'sess-1'

    renderHook(() => useChatSessionPresence({ enabled: true }))
    await act(async () => { await Promise.resolve() })
    expect(mockRequest).toHaveBeenLastCalledWith(
      ChatSessionPresenceEvents.PRESENCE,
      { session_id: 'sess-1' },
    )

    setDocumentFocus(false)
    await act(async () => {
      window.dispatchEvent(new Event('blur'))
      await Promise.resolve()
    })
    expect(mockRequest).toHaveBeenCalledTimes(1)

    await act(async () => {
      firstResponse.resolve({ ok: true })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(mockRequest).toHaveBeenNthCalledWith(
      2,
      ChatSessionPresenceEvents.PRESENCE,
      { session_id: null },
    )
  })

  it('session 切换会排在未完成旧 set 之后，最终写入新 session', async () => {
    const { useChatSessionPresence } = await import('../useChatSessionPresence')
    const firstResponse = createDeferred<{ ok: true }>()
    mockRequest.mockImplementationOnce(() => firstResponse.promise).mockResolvedValue({ ok: true })
    chatState.currentSessionId = 'sess-old'

    renderHook(() => useChatSessionPresence({ enabled: true }))
    await act(async () => { await Promise.resolve() })

    setCurrentSession('sess-new')
    await act(async () => { await Promise.resolve() })
    expect(mockRequest).toHaveBeenCalledTimes(1)

    await act(async () => {
      firstResponse.resolve({ ok: true })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(mockRequest).toHaveBeenNthCalledWith(
      2,
      ChatSessionPresenceEvents.PRESENCE,
      { session_id: 'sess-new' },
    )
  })

  it('pending heartbeat 后 blur 最终仍以 clear 收敛', async () => {
    const { useChatSessionPresence } = await import('../useChatSessionPresence')
    const heartbeatResponse = createDeferred<{ ok: true }>()
    mockRequest
      .mockResolvedValueOnce({ ok: true })
      .mockImplementationOnce(() => heartbeatResponse.promise)
      .mockResolvedValue({ ok: true })
    chatState.currentSessionId = 'sess-1'

    renderHook(() => useChatSessionPresence({ enabled: true }))
    await act(async () => { await Promise.resolve() })

    await act(async () => {
      vi.advanceTimersByTime(ChatSessionPresenceTiming.RECOMMENDED_REFRESH_SECONDS * 1000)
      await Promise.resolve()
    })
    expect(mockRequest).toHaveBeenNthCalledWith(
      2,
      ChatSessionPresenceEvents.PRESENCE,
      { session_id: 'sess-1' },
    )

    setDocumentFocus(false)
    await act(async () => {
      window.dispatchEvent(new Event('blur'))
      await Promise.resolve()
    })
    expect(mockRequest).toHaveBeenCalledTimes(2)

    await act(async () => {
      heartbeatResponse.resolve({ ok: true })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(mockRequest).toHaveBeenNthCalledWith(
      3,
      ChatSessionPresenceEvents.PRESENCE,
      { session_id: null },
    )
  })

  it('StrictMode 等价 remount 中旧 cleanup clear 不会覆盖新 mount set', async () => {
    const { useChatSessionPresence } = await import('../useChatSessionPresence')
    const firstResponse = createDeferred<{ ok: true }>()
    mockRequest.mockImplementationOnce(() => firstResponse.promise).mockResolvedValue({ ok: true })
    chatState.currentSessionId = 'sess-strict'

    // React StrictMode 的 effect replay 本质是 mount → cleanup → mount。
    // 测试环境不保证自动 replay，显式卸载并重挂来稳定复现两个 effect 闭包。
    const firstMount = renderHook(() => useChatSessionPresence({ enabled: true }))
    await act(async () => { await Promise.resolve() })

    firstMount.unmount()
    const secondMount = renderHook(() => useChatSessionPresence({ enabled: true }))
    await act(async () => { await Promise.resolve() })

    // 旧 effect 的 set 尚未完成时，新 effect 不得抢先 set。
    expect(mockRequest).toHaveBeenCalledTimes(1)
    expect(mockRequest).toHaveBeenNthCalledWith(
      1,
      ChatSessionPresenceEvents.PRESENCE,
      { session_id: 'sess-strict' },
    )

    await act(async () => {
      firstResponse.resolve({ ok: true })
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(mockRequest).toHaveBeenNthCalledWith(
      2,
      ChatSessionPresenceEvents.PRESENCE,
      { session_id: null },
    )
    expect(mockRequest).toHaveBeenNthCalledWith(
      3,
      ChatSessionPresenceEvents.PRESENCE,
      { session_id: 'sess-strict' },
    )

    secondMount.unmount()
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
  })

  it('pagehide 后遗留 focus、visibility、session 和 reconnect 都不能复活 presence', async () => {
    const { useChatSessionPresence } = await import('../useChatSessionPresence')
    const clearResponse = createDeferred<{ ok: true }>()
    chatState.currentSessionId = 'sess-leaving'

    const { unmount } = renderHook(() => useChatSessionPresence({ enabled: true }))
    await act(async () => { await Promise.resolve() })
    mockRequest.mockClear()
    mockRequest.mockImplementationOnce(() => clearResponse.promise)

    await act(async () => {
      window.dispatchEvent(new Event('pagehide'))
      await Promise.resolve()
    })
    expect(mockRequest).toHaveBeenCalledWith(
      ChatSessionPresenceEvents.PRESENCE,
      { session_id: null },
    )

    setCurrentSession('sess-after-pagehide')
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      document.dispatchEvent(new Event('visibilitychange'))
      reconnectHandler?.()
      vi.advanceTimersByTime(ChatSessionPresenceTiming.RECOMMENDED_REFRESH_SECONDS * 1000)
      await Promise.resolve()
    })
    expect(mockRequest).toHaveBeenCalledTimes(1)

    await act(async () => {
      clearResponse.resolve({ ok: true })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(mockRequest).toHaveBeenCalledTimes(1)

    unmount()
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
  })

  it('Gateway readiness check 抛错后，后续 presence 任务仍可发送', async () => {
    const { useChatSessionPresence } = await import('../useChatSessionPresence')
    mockIsConnected
      .mockImplementationOnce(() => {
        throw new Error('gateway readiness failure')
      })
      .mockReturnValue(true)
    chatState.currentSessionId = 'sess-recover'

    const { unmount } = renderHook(() => useChatSessionPresence({ enabled: true }))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(mockRequest).not.toHaveBeenCalled()

    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(mockRequest).toHaveBeenCalledWith(
      ChatSessionPresenceEvents.PRESENCE,
      { session_id: 'sess-recover' },
    )

    unmount()
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
  })

  it('unmount 会在未完成 set 后补 force clear，不留下旧 session', async () => {
    const { useChatSessionPresence } = await import('../useChatSessionPresence')
    const firstResponse = createDeferred<{ ok: true }>()
    mockRequest.mockImplementationOnce(() => firstResponse.promise).mockResolvedValue({ ok: true })
    chatState.currentSessionId = 'sess-1'

    const { unmount } = renderHook(() => useChatSessionPresence({ enabled: true }))
    await act(async () => { await Promise.resolve() })
    expect(mockRequest).toHaveBeenCalledTimes(1)

    unmount()
    await act(async () => {
      firstResponse.resolve({ ok: true })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(mockRequest).toHaveBeenNthCalledWith(
      2,
      ChatSessionPresenceEvents.PRESENCE,
      { session_id: null },
    )
  })

  it('Gateway reconnect 后从真实状态重报；未 ready 时不发、不伪造', async () => {
    const { useChatSessionPresence } = await import('../useChatSessionPresence')
    chatState.currentSessionId = 'sess-1'
    mockIsConnected.mockReturnValue(false)

    renderHook(() => useChatSessionPresence({ enabled: true }))
    await act(async () => { await Promise.resolve() })
    expect(mockRequest).not.toHaveBeenCalled()

    mockIsConnected.mockReturnValue(true)
    setDocumentFocus(true)
    setVisibility('visible')
    await act(async () => {
      reconnectHandler?.()
      await Promise.resolve()
    })
    expect(mockRequest).toHaveBeenCalledWith(
      ChatSessionPresenceEvents.PRESENCE,
      { session_id: 'sess-1' },
    )
  })

  it('mount 未连接时，Gateway 就绪后立即上报而不等待 heartbeat', async () => {
    const { useChatSessionPresence } = await import('../useChatSessionPresence')
    chatState.currentSessionId = 'sess-1'
    mockIsConnected.mockReturnValue(false)

    renderHook(() => useChatSessionPresence({ enabled: true }))
    await act(async () => { await Promise.resolve() })
    expect(mockRequest).not.toHaveBeenCalled()

    mockIsConnected.mockReturnValue(true)
    await act(async () => {
      vi.advanceTimersByTime(1_000)
      await Promise.resolve()
    })
    expect(mockRequest).toHaveBeenCalledWith(
      ChatSessionPresenceEvents.PRESENCE,
      { session_id: 'sess-1' },
    )
  })

  it(`active 期间每 ${ChatSessionPresenceTiming.RECOMMENDED_REFRESH_SECONDS}s 续期`, async () => {
    const { useChatSessionPresence } = await import('../useChatSessionPresence')
    chatState.currentSessionId = 'sess-1'

    renderHook(() => useChatSessionPresence({ enabled: true }))
    await act(async () => { await Promise.resolve() })
    expect(mockRequest).toHaveBeenCalledTimes(1)
    mockRequest.mockClear()

    await act(async () => {
      vi.advanceTimersByTime(ChatSessionPresenceTiming.RECOMMENDED_REFRESH_SECONDS * 1000)
      await Promise.resolve()
    })
    expect(mockRequest).toHaveBeenCalledWith(
      ChatSessionPresenceEvents.PRESENCE,
      { session_id: 'sess-1' },
    )
  })

  it('unmount 时若曾上报 active 则 clear，并移除 reconnect listener', async () => {
    const { useChatSessionPresence } = await import('../useChatSessionPresence')
    chatState.currentSessionId = 'sess-1'

    const { unmount } = renderHook(() => useChatSessionPresence({ enabled: true }))
    await act(async () => { await Promise.resolve() })
    mockRequest.mockClear()

    unmount()
    await act(async () => { await Promise.resolve() })

    expect(mockRequest).toHaveBeenCalledWith(
      ChatSessionPresenceEvents.PRESENCE,
      { session_id: null },
    )
    expect(mockOffReconnectedEvent).toHaveBeenCalled()
  })
})
