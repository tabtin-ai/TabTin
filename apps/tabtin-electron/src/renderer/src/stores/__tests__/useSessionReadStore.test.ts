import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PERSIST_KEYS } from '../persist-key-registry'

const { mockAcknowledgeAgentSessionNotifications } = vi.hoisted(() => ({
  mockAcknowledgeAgentSessionNotifications: vi.fn(),
}))

vi.mock('@/services/agentSessionNotificationAck', () => ({
  acknowledgeAgentSessionNotifications: mockAcknowledgeAgentSessionNotifications,
}))

vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 })

describe('useSessionReadStore persist', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
    vi.resetModules()
  })

  it('只持久化 lastViewedAt，并写入 version', async () => {
    const { useSessionReadStore } = await import('../useSessionReadStore')

    useSessionReadStore.getState().markViewed('session-1')

    const raw = localStorage.getItem(PERSIST_KEYS.sessionRead)
    expect(raw).not.toBeNull()

    const persisted = JSON.parse(raw!)
    expect(persisted.version).toBe(1)
    expect(persisted.state.lastViewedAt['session-1']).toEqual(expect.any(String))
    expect(Object.keys(persisted.state)).toEqual(['lastViewedAt'])
  })

  it('同一账号登出再登录后恢复读态，不向另一账号泄露', async () => {
    const { useSessionReadStore } = await import('../useSessionReadStore')
    useSessionReadStore.setState({
      lastViewedAt: { 'session-1': '2026-07-15T00:00:00.000Z' },
    })

    useSessionReadStore.getState().preserveForAccount('user-1')
    // 另一窗口只带部分旧读态登出，不能覆盖本窗口更完整的新读态。
    useSessionReadStore.setState({
      lastViewedAt: { 'session-2': '2026-07-14T00:00:00.000Z' },
    })
    useSessionReadStore.getState().preserveForAccount('user-1')
    useSessionReadStore.getState().reset()
    useSessionReadStore.getState().restoreForAccount('user-2')
    expect(useSessionReadStore.getState().lastViewedAt).toEqual({})

    useSessionReadStore.getState().restoreForAccount('user-1')
    expect(useSessionReadStore.getState().lastViewedAt).toEqual({
      'session-1': '2026-07-15T00:00:00.000Z',
      'session-2': '2026-07-14T00:00:00.000Z',
    })
  })

  it('恢复账号快照时保留当前登录态中更近的读态', async () => {
    const { useSessionReadStore } = await import('../useSessionReadStore')
    useSessionReadStore.setState({
      lastViewedAt: { 'session-old': '2026-07-14T00:00:00.000Z' },
    })
    useSessionReadStore.getState().preserveForAccount('user-1')
    useSessionReadStore.setState({
      lastViewedAt: { 'session-new': '2026-07-15T00:00:00.000Z' },
    })

    useSessionReadStore.getState().restoreForAccount('user-1')

    expect(useSessionReadStore.getState().lastViewedAt).toEqual({
      'session-old': '2026-07-14T00:00:00.000Z',
      'session-new': '2026-07-15T00:00:00.000Z',
    })
  })

  it('#6179: markViewed 走统一 session acknowledge 入口', async () => {
    const { useSessionReadStore } = await import('../useSessionReadStore')
    useSessionReadStore.getState().markViewed('sess-ack-1')
    await vi.waitFor(() => {
      expect(mockAcknowledgeAgentSessionNotifications).toHaveBeenCalledWith('sess-ack-1')
    })
  })

  it('加载远程历史会话时可建立已读基线，避免侧栏默认显示蓝点', async () => {
    const { useSessionReadStore } = await import('../useSessionReadStore')
    const sessionId = 'remote-history-session'
    const lastMessageAt = '2026-07-20T10:00:00.000Z'

    expect(useSessionReadStore.getState().isUnread(sessionId, lastMessageAt)).toBe(true)

    useSessionReadStore.getState().markViewedAtIfAbsent(sessionId, lastMessageAt)

    expect(useSessionReadStore.getState().isUnread(sessionId, lastMessageAt)).toBe(false)
    expect(
      useSessionReadStore.getState().isUnread(sessionId, '2026-07-20T10:00:01.000Z'),
    ).toBe(true)
  })

  it('初始化远程历史已读基线时不覆盖已有读态', async () => {
    const { useSessionReadStore } = await import('../useSessionReadStore')
    const sessionId = 'remote-history-existing-read'

    useSessionReadStore.setState({
      lastViewedAt: { [sessionId]: '2026-07-21T00:00:00.000Z' },
    })
    useSessionReadStore.getState().markViewedAtIfAbsent(sessionId, '2026-07-20T00:00:00.000Z')

    expect(useSessionReadStore.getState().lastViewedAt[sessionId]).toBe('2026-07-21T00:00:00.000Z')
  })

  it('兼容旧版 version 0 快照并过滤无效时间戳', async () => {
    localStorage.setItem(PERSIST_KEYS.sessionRead, JSON.stringify({
      state: {
        lastViewedAt: {
          'session-1': '2026-01-01T00:00:00.000Z',
          invalid: 123,
          another: null,
        },
      },
      version: 0,
    }))

    const { useSessionReadStore } = await import('../useSessionReadStore')
    await useSessionReadStore.persist.rehydrate()

    expect(useSessionReadStore.getState().lastViewedAt).toEqual({
      'session-1': '2026-01-01T00:00:00.000Z',
    })
    expect(
      useSessionReadStore.getState().isUnread('session-1', '2026-01-02T00:00:00.000Z'),
    ).toBe(true)
  })
})
