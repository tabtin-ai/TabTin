/**
 * Agent 会话终态铃铛 acknowledge —
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  acknowledgeDeferred,
  mockAcknowledgeAgentSession,
  mockWarn,
  notificationState,
  setState,
} = vi.hoisted(() => {
  const state = {
    currentOrganizationId: 'ws-a' as string | null,
    notifications: [] as Array<{
      id: string
      type: string
      title: string
      body: string
      metadata: Record<string, unknown>
      organization_id: string
      is_read: boolean
      read_at: string | null
      created_at: string
    }>,
    unreadCount: 0,
  }
  let resolveAcknowledge!: (count: number) => void
  const acknowledgePromise = new Promise<number>((resolve) => {
    resolveAcknowledge = resolve
  })
  return {
    acknowledgeDeferred: {
      promise: acknowledgePromise,
      resolve: resolveAcknowledge,
    },
    mockAcknowledgeAgentSession: vi.fn(() => acknowledgePromise),
    mockWarn: vi.fn(),
    notificationState: state,
    setState: vi.fn((updater: (s: typeof state) => typeof state | typeof state) => {
      const next = typeof updater === 'function' ? updater(state) : updater
      Object.assign(state, next)
    }),
  }
})

vi.mock('@services/notificationApi', () => ({
  NotificationApiService: {
    acknowledgeAgentSession: mockAcknowledgeAgentSession,
  },
}))

vi.mock('@stores/useNotificationStore', () => ({
  useNotificationStore: {
    setState,
    getState: () => notificationState,
  },
}))

vi.mock('@/utils/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: mockWarn,
    error: vi.fn(),
  }),
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

describe('agentSessionNotificationAck', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
    notificationState.currentOrganizationId = 'ws-a'
    notificationState.notifications = [
      {
        id: 'n-done',
        type: 'agent.task.completed',
        title: 'done',
        body: '',
        metadata: { session_id: 'sess-1' },
        organization_id: 'ws-a',
        is_read: false,
        read_at: null,
        created_at: '2026-07-21T00:00:00.000Z',
      },
      {
        id: 'n-hitl',
        type: 'agent.hitl.waiting',
        title: 'wait',
        body: '',
        metadata: { session_id: 'sess-1', interaction_id: 'ix-1' },
        organization_id: 'ws-a',
        is_read: false,
        read_at: null,
        created_at: '2026-07-21T00:01:00.000Z',
      },
      {
        id: 'n-session-interrupted',
        type: 'agent.task.session_interrupted',
        title: 'runtime restarted',
        body: '',
        metadata: { session_id: 'sess-1' },
        organization_id: 'ws-a',
        is_read: false,
        read_at: null,
        created_at: '2026-07-21T00:01:30.000Z',
      },
      {
        id: 'n-other',
        type: 'agent.task.error',
        title: 'err',
        body: '',
        metadata: { session_id: 'sess-2' },
        organization_id: 'ws-a',
        is_read: false,
        read_at: null,
        created_at: '2026-07-21T00:02:00.000Z',
      },
    ]
    notificationState.unreadCount = 4
  })

  it('acknowledge 调后端 API，并乐观清同 session 终态未读（不动 HITL）', async () => {
    const {
      ACKNOWLEDGE_AGENT_SESSION_COMPLETED_EVENT,
      acknowledgeAgentSessionNotifications,
    } = await import('../agentSessionNotificationAck')
    const completed = vi.fn()
    window.addEventListener(ACKNOWLEDGE_AGENT_SESSION_COMPLETED_EVENT, completed)

    acknowledgeAgentSessionNotifications('sess-1')

    expect(mockAcknowledgeAgentSession).toHaveBeenCalledWith('sess-1')
    expect(setState).toHaveBeenCalled()
    expect(notificationState.notifications.find((n) => n.id === 'n-done')?.is_read).toBe(true)
    expect(notificationState.notifications.find((n) => n.id === 'n-session-interrupted')?.is_read).toBe(true)
    expect(notificationState.notifications.find((n) => n.id === 'n-hitl')?.is_read).toBe(false)
    expect(notificationState.notifications.find((n) => n.id === 'n-other')?.is_read).toBe(false)
    expect(notificationState.unreadCount).toBe(2)
    expect(completed).not.toHaveBeenCalled()

    // 请求在 A 发起，返回前用户已切到 B；完成事件必须保留发起时的 A。
    notificationState.currentOrganizationId = 'ws-b'
    acknowledgeDeferred.resolve(1)
    await vi.waitFor(() => {
      expect(completed).toHaveBeenCalledTimes(1)
    })
    expect(completed.mock.calls[0]?.[0]).toMatchObject({
      detail: { sessionId: 'sess-1', organizationId: 'ws-a', count: 1 },
    })

    window.removeEventListener(ACKNOWLEDGE_AGENT_SESSION_COMPLETED_EVENT, completed)
  })

  it('空白 sessionId 不调 API', async () => {
    const { acknowledgeAgentSessionNotifications } = await import('../agentSessionNotificationAck')
    acknowledgeAgentSessionNotifications('   ')
    expect(mockAcknowledgeAgentSession).not.toHaveBeenCalled()
    expect(setState).not.toHaveBeenCalled()
  })

  it('发起时无法确定组织则完成事件明确携带 null，不猜后续当前组织', async () => {
    notificationState.currentOrganizationId = null
    const {
      ACKNOWLEDGE_AGENT_SESSION_COMPLETED_EVENT,
      acknowledgeAgentSessionNotifications,
    } = await import('../agentSessionNotificationAck')
    const completed = vi.fn()
    window.addEventListener(ACKNOWLEDGE_AGENT_SESSION_COMPLETED_EVENT, completed)

    acknowledgeAgentSessionNotifications('sess-1')
    notificationState.currentOrganizationId = 'ws-b'

    await vi.waitFor(() => {
      expect(completed).toHaveBeenCalledTimes(1)
    })
    expect(completed.mock.calls[0]?.[0]).toMatchObject({
      detail: { sessionId: 'sess-1', organizationId: null },
    })

    window.removeEventListener(ACKNOWLEDGE_AGENT_SESSION_COMPLETED_EVENT, completed)
  })

  it('API 失败保留本地已读视觉、记 warn 且不派发完成事件', async () => {
    mockAcknowledgeAgentSession.mockRejectedValueOnce(new Error('network down'))
    const {
      ACKNOWLEDGE_AGENT_SESSION_COMPLETED_EVENT,
      acknowledgeAgentSessionNotifications,
    } = await import('../agentSessionNotificationAck')
    const completed = vi.fn()
    window.addEventListener(ACKNOWLEDGE_AGENT_SESSION_COMPLETED_EVENT, completed)

    acknowledgeAgentSessionNotifications('sess-1')

    await vi.waitFor(() => {
      expect(mockWarn).toHaveBeenCalledWith(
        'acknowledgeAgentSession failed',
        expect.objectContaining({ sessionId: 'sess-1' }),
      )
    })
    expect(notificationState.notifications.find((n) => n.id === 'n-done')?.is_read).toBe(true)
    expect(completed).not.toHaveBeenCalled()

    window.removeEventListener(ACKNOWLEDGE_AGENT_SESSION_COMPLETED_EVENT, completed)
  })
})
