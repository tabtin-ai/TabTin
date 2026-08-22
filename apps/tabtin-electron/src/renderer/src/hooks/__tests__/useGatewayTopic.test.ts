import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

const mockConnect = vi.fn()
const mockAddListener = vi.fn()
const mockRemoveListener = vi.fn()
const mockOnReconnectedEvent = vi.fn()
const mockOffReconnectedEvent = vi.fn()
const mockSubscribe = vi.fn()
const mockUnsubscribe = vi.fn()
const mockRequest = vi.fn()

vi.mock('@/services/chatApi', () => ({
  getChatClient: () => ({
    getGateway: () => ({
      connect: mockConnect,
      addListener: mockAddListener,
      removeListener: mockRemoveListener,
      onReconnectedEvent: mockOnReconnectedEvent,
      offReconnectedEvent: mockOffReconnectedEvent,
      subscribe: mockSubscribe,
      unsubscribe: mockUnsubscribe,
      request: mockRequest,
    }),
  }),
}))

const mockOrganizationState: {
  selectedOrganization: { id: string } | null
  organizations: Array<{ id: string }>
} = {
  selectedOrganization: { id: 'ws-1' },
  organizations: [{ id: 'ws-1' }],
}

vi.mock('@/stores/useOrganizationStore', () => ({
  useOrganizationStore: (selector: (state: typeof mockOrganizationState) => unknown) =>
    selector(mockOrganizationState),
}))

describe('useGatewayTopic', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockConnect.mockResolvedValue(true)
    mockSubscribe.mockResolvedValue({ ok: true })
    mockUnsubscribe.mockResolvedValue({ ok: true })
    mockRequest.mockResolvedValue({ ok: true })
    mockOrganizationState.selectedOrganization = { id: 'ws-1' }
    mockOrganizationState.organizations = [{ id: 'ws-1' }]
  })

  afterEach(() => {
    vi.resetModules()
  })

  it('同一 topic 多个消费者并存时只订阅一次，并在最后一个卸载时才退订', async () => {
    const { useGatewayTopic } = await import('../useGatewayTopic')

    const first = renderHook(() => useGatewayTopic({ topic: 'tracker.events.ws-1' }))
    const second = renderHook(() => useGatewayTopic({ topic: 'tracker.events.ws-1' }))

    await waitFor(() => {
      expect(mockSubscribe).toHaveBeenCalledTimes(1)
    })

    first.unmount()
    expect(mockUnsubscribe).not.toHaveBeenCalled()

    second.unmount()

    await waitFor(() => {
      expect(mockUnsubscribe).toHaveBeenCalledTimes(1)
    })
    expect(mockUnsubscribe).toHaveBeenCalledWith(['tracker.events.ws-1'])
    expect(mockRequest).not.toHaveBeenCalled()
  })

  it('organization 未就绪时不尝试连接，状态保持 idle', async () => {
    mockOrganizationState.selectedOrganization = null
    mockOrganizationState.organizations = []

    const { useGatewayTopic } = await import('../useGatewayTopic')

    const { result } = renderHook(() =>
      useGatewayTopic({ topic: 'notifications.user-1' }),
    )

    // 给异步足够时间确认不发生连接
    await new Promise(r => setTimeout(r, 50))

    expect(mockConnect).not.toHaveBeenCalled()
    expect(mockSubscribe).not.toHaveBeenCalled()
    expect(result.current.status).toBe('idle')
  })

  it('topic 为 null 时不尝试连接', async () => {
    const { useGatewayTopic } = await import('../useGatewayTopic')

    const { result } = renderHook(() =>
      useGatewayTopic({ topic: null }),
    )

    await new Promise(r => setTimeout(r, 50))

    expect(mockConnect).not.toHaveBeenCalled()
    expect(result.current.status).toBe('idle')
  })

  it('enabled=false 时不尝试连接', async () => {
    const { useGatewayTopic } = await import('../useGatewayTopic')

    const { result } = renderHook(() =>
      useGatewayTopic({ topic: 'tracker.events.ws-1', enabled: false }),
    )

    await new Promise(r => setTimeout(r, 50))

    expect(mockConnect).not.toHaveBeenCalled()
    expect(result.current.status).toBe('idle')
  })

  it('限流(WS_1007)被判为可重试，会自动重订而不是永久放弃', async () => {
    // 回归：网关限流是 10s/100 条的滑动窗口，属于瞬态。漏进 TRANSIENT 集合会被
    // 当成 non-retryable —— 冷启动 space 一多（每 space 一条 tracker.events），
    // 被拒的 topic 直到下次重连都收不到事件。
    mockSubscribe
      .mockResolvedValueOnce({ ok: false, error: { code: 'WS_1007_RATE_LIMITED', message: 'too many messages, slow down' } })
      .mockResolvedValue({ ok: true })

    const { useGatewayTopic } = await import('../useGatewayTopic')
    const { result } = renderHook(() =>
      useGatewayTopic({ topic: 'tracker.events.ws-rate-limited' }),
    )

    // 首次被限流 → 退避后自动重试 → 第二次成功
    await waitFor(() => {
      expect(mockSubscribe.mock.calls.length).toBeGreaterThanOrEqual(2)
    }, { timeout: 8000 })
    await waitFor(() => {
      expect(result.current.status).toBe('connected')
    }, { timeout: 8000 })
  }, 15000)

  it('权限类失败(WS_1005)仍然不重试', async () => {
    mockSubscribe.mockResolvedValue({
      ok: false,
      error: { code: 'WS_1005_PERMISSION_DENIED', message: 'denied' },
    })

    const { useGatewayTopic } = await import('../useGatewayTopic')
    const { result } = renderHook(() =>
      useGatewayTopic({ topic: 'tracker.events.ws-denied' }),
    )

    await waitFor(() => {
      expect(result.current.status).toBe('error')
    })
    await new Promise(r => setTimeout(r, 300))
    expect(mockSubscribe).toHaveBeenCalledTimes(1)
  })

  it('connect 返回 false 时状态为 error', async () => {
    mockConnect.mockResolvedValue(false)
    const { useGatewayTopic } = await import('../useGatewayTopic')

    const { result } = renderHook(() =>
      useGatewayTopic({ topic: 'tracker.events.ws-1' }),
    )

    await waitFor(() => {
      expect(result.current.status).toBe('error')
    })
  })

  it('selectedOrganization 为 null 但 organizations 列表非空时仍可连接（fallback）', async () => {
    mockOrganizationState.selectedOrganization = null
    mockOrganizationState.organizations = [{ id: 'ws-fallback' }]

    const { useGatewayTopic } = await import('../useGatewayTopic')

    renderHook(() => useGatewayTopic({ topic: 'tracker.events.ws-1' }))

    await waitFor(() => {
      expect(mockConnect).toHaveBeenCalledTimes(1)
      expect(mockSubscribe).toHaveBeenCalledTimes(1)
    })
  })

  it('subscribe 失败时仍从本地重连清单退订', async () => {
    mockSubscribe.mockResolvedValue({
      ok: false,
      error: { code: 'WS_1005_PERMISSION_DENIED', message: 'denied' },
    })

    const { useGatewayTopic } = await import('../useGatewayTopic')

    const { result, unmount } = renderHook(() =>
      useGatewayTopic({ topic: 'billing.events.ws-1' }),
    )

    await waitFor(() => {
      expect(result.current.status).toBe('error')
    })

    expect(mockConnect).toHaveBeenCalledTimes(1)
    unmount()
    await waitFor(() => {
      expect(mockUnsubscribe).toHaveBeenCalledWith(['billing.events.ws-1'])
    })
  })

  it('只把当前 topic 的 envelope 交给业务回调', async () => {
    const { useGatewayTopic } = await import('../useGatewayTopic')
    const onEvent = vi.fn()

    renderHook(() =>
      useGatewayTopic({ topic: 'agent.stream.chat-session-a', onEvent }),
    )

    await waitFor(() => {
      expect(mockAddListener).toHaveBeenCalledTimes(1)
    })

    const listener = mockAddListener.mock.calls[0][0] as (envelope: Record<string, unknown>) => void
    listener({
      type: 'agent.stream.lifecycle',
      event_id: 'evt-other',
      _topic: 'agent.stream.chat-session-b',
      payload: { phase: 'start' },
    })
    listener({
      type: 'agent.stream.lifecycle',
      event_id: 'evt-current',
      _topic: 'agent.stream.chat-session-a',
      payload: { phase: 'start' },
    })

    expect(onEvent).toHaveBeenCalledTimes(1)
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({
      event_id: 'evt-current',
      _topic: 'agent.stream.chat-session-a',
    }))
  })

  it('#10899 重连后 WS_REQUEST_TIMEOUT 会退避重订', async () => {
    mockSubscribe
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({
        ok: false,
        error: { code: 'WS_REQUEST_TIMEOUT', message: 'timeout' },
      })
      .mockResolvedValue({ ok: true })

    const { subscribeGatewayTopic } = await import('../useGatewayTopic')
    const unsubscribe = subscribeGatewayTopic('chat.session.events.s1', {
      logPrefix: 'ChatSessionEventStream',
    })

    await waitFor(() => {
      expect(mockSubscribe).toHaveBeenCalledTimes(1)
    })
    const reconnect = mockOnReconnectedEvent.mock.calls[0]?.[0] as (() => void) | undefined
    expect(reconnect).toEqual(expect.any(Function))
    reconnect?.()

    await waitFor(() => {
      expect(mockSubscribe.mock.calls.length).toBeGreaterThanOrEqual(3)
    }, { timeout: 8000 })

    unsubscribe()
  }, 15000)

  it('不会把业务 payload.topic 误当作 Gateway 订阅 topic', async () => {
    const { envelopeMatchesGatewayTopic } = await import('../useGatewayTopic')

    expect(envelopeMatchesGatewayTopic({
      type: 'tracker.run.updated',
      payload: {
        topic: 'user-visible-business-topic',
      },
    }, 'tracker.events.ws-1')).toBe(true)
  })
})
