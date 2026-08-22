import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockList,
  mockGetUnreadCount,
  mockMarkRead,
  mockMarkAllRead,
  mockNavigateToTarget,
  mockRegisterResetAction,
  mockSetBadgeCount,
} = vi.hoisted(() => ({
  mockList: vi.fn(),
  mockGetUnreadCount: vi.fn(),
  mockMarkRead: vi.fn(),
  mockMarkAllRead: vi.fn(),
  mockNavigateToTarget: vi.fn().mockResolvedValue(undefined),
  mockRegisterResetAction: vi.fn(),
  mockSetBadgeCount: vi.fn(),
}))

vi.mock('@services/notificationApi', () => ({
  NotificationApiService: {
    list: mockList,
    getUnreadCount: mockGetUnreadCount,
    markRead: mockMarkRead,
    markAllRead: mockMarkAllRead,
  },
}))

vi.mock('@/services/notificationNavigation', () => ({
  navigateToTarget: mockNavigateToTarget,
}))

vi.mock('@/i18n', () => ({
  default: {
    t: (key: string) => key,
  },
}))

vi.mock('../sessionResetRegistry', () => ({
  registerResetAction: mockRegisterResetAction,
}))

let useNotificationStore: typeof import('../useNotificationStore').useNotificationStore
let capturedOnShown: ((data: Record<string, unknown>) => void) | null = null
const mockOnShownUnsubscribe = vi.fn()

function createDeferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function flushPromises() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function buildNotification(id: string, organizationId: string) {
  return {
    id,
    type: 'system',
    title: `notif-${id}`,
    body: '',
    metadata: {},
    organization_id: organizationId,
    is_read: false,
    read_at: null,
    created_at: '2026-03-09T00:00:00.000Z',
  }
}

beforeEach(async () => {
  vi.clearAllMocks()
  vi.resetModules()
  capturedOnShown = null

  ;(globalThis as any).window = {
    tabtin: {
      notification: {
        setBadgeCount: mockSetBadgeCount,
        onShown: (handler: typeof capturedOnShown) => {
          capturedOnShown = handler
          return mockOnShownUnsubscribe
        },
      },
    },
  }

  const mod = await import('../useNotificationStore')
  useNotificationStore = mod.useNotificationStore
  useNotificationStore.setState({
    currentOrganizationId: null,
    notifications: [],
    unreadCount: 0,
    isLoading: false,
    error: null,
    isPanelOpen: false,
  })
})

describe('useNotificationStore', () => {
  it('markAllRead 会携带当前 organization scope', async () => {
    mockMarkAllRead.mockResolvedValueOnce(2)
    useNotificationStore.setState({
      currentOrganizationId: 'ws-1',
      notifications: [buildNotification('n-1', 'ws-1'), buildNotification('n-2', 'ws-1')],
      unreadCount: 2,
      isLoading: false,
      error: null,
      isPanelOpen: false,
    })

    await useNotificationStore.getState().markAllRead()

    expect(mockMarkAllRead).toHaveBeenCalledWith('ws-1')
    expect(useNotificationStore.getState().unreadCount).toBe(0)
    expect(useNotificationStore.getState().notifications.every((item) => item.is_read)).toBe(true)
  })

  it('loadUnreadCount 忽略已过期 organization 请求结果', async () => {
    const first = createDeferred<number>()
    mockGetUnreadCount.mockReturnValueOnce(first.promise)
    mockGetUnreadCount.mockResolvedValueOnce(2)

    useNotificationStore.getState().setOrganizationScope('ws-1')
    const firstLoad = useNotificationStore.getState().loadUnreadCount()

    useNotificationStore.getState().setOrganizationScope('ws-2')
    await useNotificationStore.getState().loadUnreadCount()

    first.resolve(9)
    await firstLoad

    expect(useNotificationStore.getState().currentOrganizationId).toBe('ws-2')
    expect(useNotificationStore.getState().unreadCount).toBe(2)
  })

  it('loadNotifications 忽略已过期 organization 请求结果', async () => {
    const first = createDeferred<{
      items: ReturnType<typeof buildNotification>[]
      total: number
      page: number
      limit: number
    }>()
    mockList.mockReturnValueOnce(first.promise)
    mockList.mockResolvedValueOnce({
      items: [buildNotification('n-2', 'ws-2')],
      total: 1,
      page: 1,
      limit: 20,
    })

    useNotificationStore.getState().setOrganizationScope('ws-1')
    const firstLoad = useNotificationStore.getState().loadNotifications()

    useNotificationStore.getState().setOrganizationScope('ws-2')
    await useNotificationStore.getState().loadNotifications()

    first.resolve({
      items: [buildNotification('n-1', 'ws-1')],
      total: 1,
      page: 1,
      limit: 20,
    })
    await firstLoad

    expect(useNotificationStore.getState().currentOrganizationId).toBe('ws-2')
    expect(useNotificationStore.getState().notifications.map((item) => item.id)).toEqual(['n-2'])
  })

  it('loadNotifications 请求包含个人全局组织消息', async () => {
    mockList.mockResolvedValueOnce({
      items: [],
      total: 0,
      page: 1,
      limit: 20,
    })
    useNotificationStore.getState().setOrganizationScope('ws-current')

    await useNotificationStore.getState().loadNotifications()

    expect(mockList).toHaveBeenCalledWith(
      1,
      20,
      'ws-current',
      { includePersonalInvitations: true },
    )
  })

  it('markAllRead 在 organization 已切换时不会清空当前 scope', async () => {
    const deferred = createDeferred<number>()
    mockMarkAllRead.mockReturnValueOnce(deferred.promise)

    useNotificationStore.setState({
      currentOrganizationId: 'ws-1',
      notifications: [buildNotification('n-1', 'ws-1')],
      unreadCount: 1,
      isLoading: false,
      error: null,
      isPanelOpen: false,
    })

    const pending = useNotificationStore.getState().markAllRead()
    useNotificationStore.getState().setOrganizationScope('ws-2')
    useNotificationStore.setState({
      currentOrganizationId: 'ws-2',
      notifications: [buildNotification('n-2', 'ws-2')],
      unreadCount: 3,
      isLoading: false,
      error: null,
      isPanelOpen: false,
    })

    deferred.resolve(1)
    await pending

    expect(useNotificationStore.getState().currentOrganizationId).toBe('ws-2')
    expect(useNotificationStore.getState().unreadCount).toBe(3)
    expect(useNotificationStore.getState().notifications.map((item) => item.id)).toEqual(['n-2'])
  })

  it('markRead 在 organization 已切换时不会污染当前 scope', async () => {
    const deferred = createDeferred<void>()
    mockMarkRead.mockReturnValueOnce(deferred.promise)

    useNotificationStore.setState({
      currentOrganizationId: 'ws-1',
      notifications: [buildNotification('n-1', 'ws-1')],
      unreadCount: 1,
      isLoading: false,
      error: null,
      isPanelOpen: false,
    })

    const pending = useNotificationStore.getState().markRead('n-1')
    useNotificationStore.getState().setOrganizationScope('ws-2')
    useNotificationStore.setState({
      currentOrganizationId: 'ws-2',
      notifications: [buildNotification('n-2', 'ws-2')],
      unreadCount: 4,
      isLoading: false,
      error: null,
      isPanelOpen: false,
    })

    deferred.resolve(undefined)
    await pending

    expect(useNotificationStore.getState().currentOrganizationId).toBe('ws-2')
    expect(useNotificationStore.getState().unreadCount).toBe(4)
    expect(useNotificationStore.getState().notifications.map((item) => item.id)).toEqual(['n-2'])
  })

  it('切换 organization 时若面板已打开会立即刷新列表', async () => {
    const deferred = createDeferred<{
      items: ReturnType<typeof buildNotification>[]
      total: number
      page: number
      limit: number
    }>()
    mockList.mockReturnValueOnce(deferred.promise)
    useNotificationStore.setState({
      currentOrganizationId: 'ws-1',
      notifications: [buildNotification('n-1', 'ws-1')],
      unreadCount: 2,
      isLoading: false,
      error: null,
      isPanelOpen: true,
    })

    useNotificationStore.getState().setOrganizationScope('ws-2')

    expect(useNotificationStore.getState().isLoading).toBe(true)
    expect(mockList).toHaveBeenCalledWith(
      1,
      20,
      'ws-2',
      { includePersonalInvitations: true },
    )

    deferred.resolve({
      items: [buildNotification('n-2', 'ws-2')],
      total: 1,
      page: 1,
      limit: 20,
    })
    await flushPromises()

    expect(useNotificationStore.getState().notifications.map((item) => item.id)).toEqual(['n-2'])
  })

  it('markAllRead 不会把请求期间新到的通知一并本地置已读', async () => {
    const deferred = createDeferred<number>()
    mockMarkAllRead.mockReturnValueOnce(deferred.promise)
    useNotificationStore.setState({
      currentOrganizationId: 'ws-1',
      notifications: [buildNotification('n-1', 'ws-1')],
      unreadCount: 1,
      isLoading: false,
      error: null,
      isPanelOpen: false,
    })

    const pending = useNotificationStore.getState().markAllRead()
    useNotificationStore.getState().addNotification(buildNotification('n-2', 'ws-1'))

    deferred.resolve(1)
    await pending

    const notifications = useNotificationStore.getState().notifications
    expect(notifications.find((item) => item.id === 'n-1')?.is_read).toBe(true)
    expect(notifications.find((item) => item.id === 'n-2')?.is_read).toBe(false)
    expect(useNotificationStore.getState().unreadCount).toBe(1)
  })

  it('Agent 通知不进入本地通知中心状态', () => {
    useNotificationStore.setState({ currentOrganizationId: 'ws-1' })

    useNotificationStore.getState().addNotification({
      ...buildNotification('agent-1', 'ws-1'),
      type: 'agent.task.completed',
    })

    expect(useNotificationStore.getState().notifications).toHaveLength(0)
    expect(useNotificationStore.getState().unreadCount).toBe(0)
  })

  it('loadNotifications 会保留尚未落库的本地通知', async () => {
    mockList.mockResolvedValueOnce({
      items: [],
      total: 0,
      page: 1,
      limit: 20,
    })
    useNotificationStore.setState({
      currentOrganizationId: 'ws-1',
      notifications: [{
        ...buildNotification('local-1', 'ws-1'),
        id: 'local-1',
      }],
      unreadCount: 1,
      isLoading: false,
      error: null,
      isPanelOpen: true,
    })

    await useNotificationStore.getState().loadNotifications()

    expect(useNotificationStore.getState().notifications.map((item) => item.id)).toEqual(['local-1'])
  })

  it('replaceLocalNotifications 会以主窗口快照替换子窗口的本地通知并校正未读数', () => {
    useNotificationStore.setState({
      currentOrganizationId: 'ws-1',
      notifications: [
        buildNotification('server-1', 'ws-1'),
        buildNotification('local-stale-1', 'ws-1'),
        buildNotification('local-stale-2', 'ws-1'),
      ],
      unreadCount: 3,
      isLoading: false,
      error: null,
      isPanelOpen: false,
    })

    useNotificationStore.getState().replaceLocalNotifications([
      buildNotification('local-current', 'ws-1'),
    ])

    expect(useNotificationStore.getState().notifications.map((item) => item.id)).toEqual([
      'local-current',
      'server-1',
    ])
    expect(useNotificationStore.getState().unreadCount).toBe(2)
  })

  it('loadNotifications 会用服务端版本替换重复的本地通知', async () => {
    const createdAt = '2026-03-09T00:00:00.000Z'
    useNotificationStore.setState({
      currentOrganizationId: 'ws-1',
      notifications: [{
        ...buildNotification('local-1', 'ws-1'),
        id: 'local-1',
        title: 'same title',
        created_at: createdAt,
      }],
      unreadCount: 1,
      isLoading: false,
      error: null,
      isPanelOpen: true,
    })

    mockList.mockResolvedValueOnce({
      items: [{
        ...buildNotification('server-1', 'ws-1'),
        id: 'server-1',
        title: 'same title',
        created_at: '2026-03-09T00:00:01.000Z',
      }],
      total: 1,
      page: 1,
      limit: 20,
    })

    await useNotificationStore.getState().loadNotifications()

    expect(useNotificationStore.getState().notifications.map((item) => item.id)).toEqual(['server-1'])
  })

  it('实时服务端通知会替换同一条本地桌面镜像，避免已读后角标残留', () => {
    useNotificationStore.setState({
      currentOrganizationId: 'ws-1',
      notifications: [{
        ...buildNotification('local-1', 'ws-1'),
        id: 'local-1',
        type: 'tracker.run.completed',
        title: '自动化任务已完成',
      }],
      unreadCount: 1,
      isLoading: false,
      error: null,
      isPanelOpen: false,
    })

    useNotificationStore.getState().addNotification({
      ...buildNotification('server-1', 'ws-1'),
      id: 'server-1',
      type: 'tracker.run.completed',
      title: '自动化任务已完成',
      created_at: '2026-03-09T00:00:01.000Z',
    })

    expect(useNotificationStore.getState().notifications.map((item) => item.id)).toEqual(['server-1'])
    expect(useNotificationStore.getState().unreadCount).toBe(1)
  })

  it('navigateToNotification 会用通知本体的 space_id 回填跳转目标', async () => {
    await useNotificationStore.getState().navigateToNotification({
      ...buildNotification('n-1', 'ws-1'),
      space_id: 'as-1',
      navigate_to: { type: 'tracker', id: 'tracker-1' },
    } as any)

    await flushPromises()

    expect(mockNavigateToTarget).toHaveBeenCalledWith({
      type: 'tracker',
      id: 'tracker-1',
      organizationId: 'ws-1',
      spaceId: 'as-1',
    })
  })

  it('navigateToNotification 应等待目标导航完成', async () => {
    const targetNavigation = createDeferred<void>()
    mockNavigateToTarget.mockReturnValueOnce(targetNavigation.promise)
    let completed = false

    const navigateToNotification = useNotificationStore.getState().navigateToNotification
    const navigation = navigateToNotification({
      ...buildNotification('n-await', 'ws-1'),
      navigate_to: { type: 'tracker', id: 'tracker-await' },
    } as Parameters<typeof navigateToNotification>[0])
    void navigation.then(() => { completed = true })

    await flushPromises()
    expect(completed).toBe(false)

    targetNavigation.resolve(undefined)
    await navigation
    expect(completed).toBe(true)
  })

  it('邮件通知不再深链到已下线的 TabMail', async () => {
    mockList.mockResolvedValueOnce({
      items: [{
        ...buildNotification('server-mail-1', 'ws-1'),
        type: 'extension_event',
        space_id: 'as-mail-1',
        metadata: {
          event_type: 'email.received',
          message_id: 'msg-1',
          thread_id: 'thread-1',
        },
      }],
      total: 1,
      page: 1,
      limit: 20,
    })

    useNotificationStore.setState({
      currentOrganizationId: 'ws-1',
      notifications: [],
      unreadCount: 0,
      isLoading: false,
      error: null,
      isPanelOpen: true,
    })

    await useNotificationStore.getState().loadNotifications()

    expect(useNotificationStore.getState().notifications[0]?.navigate_to).toBeUndefined()
  })

  it('navigateToNotification 会为通用 extension_event 兜底到扩展设置页', async () => {
    useNotificationStore.getState().navigateToNotification({
      ...buildNotification('server-ext-1', 'ws-1'),
      type: 'extension_event',
      source_extension_id: 'ext-mail',
      space_id: 'as-ext-1',
      metadata: {
        event_type: 'extension.custom_event',
      },
    } as any)

    await flushPromises()

    expect(mockNavigateToTarget).toHaveBeenCalledWith({
      type: 'settings',
      id: 'ext-mail',
      organizationId: 'ws-1',
      spaceId: 'as-ext-1',
      route: 'extensions',
    })
  })

  it('loadNotifications 会解析 metadata.navigate_to 并回填 organization/space scope', async () => {
    mockList.mockResolvedValueOnce({
      items: [{
        ...buildNotification('server-raw-1', 'ws-1'),
        space_id: 'as-raw-1',
        metadata: {
          navigate_to: { type: 'chat-session', id: 'sess-raw-1' },
        },
      }],
      total: 1,
      page: 1,
      limit: 20,
    })

    useNotificationStore.setState({
      currentOrganizationId: 'ws-1',
      notifications: [],
      unreadCount: 0,
      isLoading: false,
      error: null,
      isPanelOpen: true,
    })

    await useNotificationStore.getState().loadNotifications()

    expect(useNotificationStore.getState().notifications[0]?.navigate_to).toEqual({
      type: 'chat-session',
      id: 'sess-raw-1',
      organizationId: 'ws-1',
      spaceId: 'as-raw-1',
    })
  })

  it('initShownListener 会把本地桌面通知的 navigateTo 走统一 resolver 补齐 scope', async () => {
    const dispose = useNotificationStore.getState().initShownListener()

    capturedOnShown?.({
      type: 'tracker.run.completed',
      title: 'tracker done',
      organizationId: 'ws-local-1',
      spaceId: 'as-local-1',
      navigateTo: { type: 'tracker', id: 'tracker-local-1' },
    })

    const localNotification = useNotificationStore.getState().notifications[0]
    expect(localNotification?.navigate_to).toEqual({
      type: 'tracker',
      id: 'tracker-local-1',
      organizationId: 'ws-local-1',
      spaceId: 'as-local-1',
    })

    dispose()
    expect(mockOnShownUnsubscribe).toHaveBeenCalled()
  })

  it('initShownListener 不把 IM 桌面 toast 镜像进铃铛', () => {
    const dispose = useNotificationStore.getState().initShownListener()

    capturedOnShown?.({
      type: 'im.message',
      title: '新消息',
      organizationId: 'ws-1',
      navigateTo: { type: 'im-conversation', id: 'conv-1' },
    })

    expect(useNotificationStore.getState().notifications).toEqual([])
    dispose()
  })
})
