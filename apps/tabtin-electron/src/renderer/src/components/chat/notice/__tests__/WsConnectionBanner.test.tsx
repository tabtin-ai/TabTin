/**
 * NetworkConnectionIndicator / useWsConnectionStatus 测试
 *
 * 由原 NetworkConnectionIndicator 场景迁移：连接态改顶栏指示器 + Popover，恢复成功改 toast。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import React from 'react'
import { toast } from '@tabtin/smartsheet-ui'

// ── Hoisted mock state ──

const {
  mockGwConnect,
  mockGwClose,
  mockReconnectCentrifugo,
  mockRecoverFromInvalidOrganizationAccess,
  mockLoadOrganizations,
  mockLogout,
  mockClearAuthFailed,
  mockSetLastSyncCount,
  mockSetOrganizationAccessRecoveryInFlight,
  gwState,
  imStoreState,
  authState,
  organizationState,
  spaceState,
  agentGatewayState,
  runtimeVersionState,
} = vi.hoisted(() => ({
  mockGwConnect: vi.fn().mockResolvedValue(true),
  mockGwClose: vi.fn(),
  mockReconnectCentrifugo: vi.fn(),
  mockRecoverFromInvalidOrganizationAccess: vi.fn().mockResolvedValue(true),
  mockLoadOrganizations: vi.fn().mockResolvedValue(undefined),
  mockLogout: vi.fn().mockResolvedValue(undefined),
  mockClearAuthFailed: vi.fn(),
  mockSetLastSyncCount: vi.fn(),
  mockSetOrganizationAccessRecoveryInFlight: vi.fn((value: boolean) => {
    gwState.organizationAccessRecoveryInFlight = value
  }),
  gwState: {
    status: 'connected' as string,
    authFailed: false,
    reconnectAttempt: 0,
    lastSyncCount: 0,
    networkOnline: true,
    suspendedSessionIds: [] as string[],
    organizationAccessBlocked: false,
    organizationAccessBlockedName: null as string | null,
    organizationAccessRecoveryInFlight: false,
  },
  imStoreState: {
    connectionStatus: 'connected' as string,
    authFailed: false,
    sessionKicked: false,
  },
  authState: {
    authPhase: 'authenticated' as const,
  },
  organizationState: {
    selectedOrganization: { id: 'org-removed', name: 'Removed' } as { id: string; name: string } | null,
    lastOpenedOrganizationId: 'org-removed' as string | null,
    organizations: [{ id: 'org-removed', name: 'Removed' }] as Array<{ id: string; name: string }>,
    loadRetryCount: 0,
    lastLoadError: null as string | null,
  },
  spaceState: {
    spaces: [{ id: 'space-1', organization_id: 'org-removed' }] as Array<{ id: string; organization_id: string }>,
    isLoading: false,
    lastLoadError: null as string | null,
    error: null as string | null,
    loadErrorByOrganizationId: {} as Record<string, string>,
    lastLoadedOrganizationId: 'org-removed' as string | null,
    loadedOrganizationIds: ['org-removed'] as string[],
  },
  agentGatewayState: {
    status: 'ready' as string,
  },
  runtimeVersionState: {
    clientVersion: '0.2.1',
    clientSourceSha: 'client1234567890',
    serverVersion: '260812',
    serverSourceSha: 'server1234567890',
    serverAddress: 'https://api-test.example.com/api',
    serverLoading: false,
  },
}))

// ── vi.mock ──

vi.mock('@/stores/useWsConnectionStore', () => {
  const store = Object.assign(
    vi.fn((selector: (state: typeof gwState) => unknown) => selector(gwState)),
    {
      getState: () => ({
        ...gwState,
        clearAuthFailed: mockClearAuthFailed,
        setLastSyncCount: mockSetLastSyncCount,
        setOrganizationAccessRecoveryInFlight: mockSetOrganizationAccessRecoveryInFlight,
      }),
      subscribe: vi.fn(),
    },
  )
  return { useWsConnectionStore: store }
})

vi.mock('@/stores/useIMStore', () => {
  const store = Object.assign(
    vi.fn((selector: (state: typeof imStoreState) => unknown) => selector(imStoreState)),
    {
      getState: () => imStoreState,
      subscribe: vi.fn(),
    },
  )
  return { useIMStore: store }
})

vi.mock('@/stores/useAuthStore', () => {
  const store = Object.assign(
    vi.fn((selector: (state: typeof authState) => unknown) => selector(authState)),
    {
      getState: () => ({
        ...authState,
        logout: mockLogout,
      }),
      subscribe: vi.fn(),
    },
  )
  return {
    useAuthStore: store,
    selectIsAuthenticated: (state: typeof authState) => state.authPhase === 'authenticated',
  }
})

vi.mock('@/services/chatApi', () => ({
  getChatClient: () => ({
    getGateway: () => ({
      connect: mockGwConnect,
      close: mockGwClose,
    }),
  }),
}))

vi.mock('@/hooks/useCentrifugoClient', () => ({
  reconnectCentrifugo: mockReconnectCentrifugo,
}))

vi.mock('@/hooks/useAgentGatewayStatus', () => ({
  useAgentGatewayStatus: () => agentGatewayState.status,
}))

vi.mock('@/hooks/useRuntimeVersionInfo', () => ({
  useRuntimeVersionInfo: () => runtimeVersionState,
}))

vi.mock('@/stores/useOrganizationStore', () => {
  const store = Object.assign(
    vi.fn((selector: (state: typeof organizationState) => unknown) => selector(organizationState)),
    {
      getState: () => ({
        ...organizationState,
        loadOrganizations: mockLoadOrganizations,
      }),
      subscribe: vi.fn(),
    },
  )
  return { useOrganizationStore: store }
})

vi.mock('@/stores/useSpaceStore', () => {
  const store = Object.assign(
    vi.fn((selector: (state: typeof spaceState) => unknown) => selector(spaceState)),
    {
      getState: () => spaceState,
      subscribe: vi.fn(),
    },
  )
  return { useSpaceStore: store }
})

vi.mock('@/services/membershipEventHandler', () => ({
  recoverFromInvalidOrganizationAccess: mockRecoverFromInvalidOrganizationAccess,
}))

vi.mock('@/services/organizationAccessErrors', () => ({
  isOrganizationPermissionMessage: (message: string) => message.includes('access denied'),
}))

vi.mock('@/stores/useTableCollabStore', () => ({
  useTableCollabStore: (selector: (state: { tables: Record<string, never> }) => unknown) =>
    selector({ tables: {} }),
}))

vi.mock('@components/table/table-runtime-monitor', () => ({
  useTabDataRuntimeMonitorSnapshot: () => null,
}))

vi.mock('@components/context-space/tabdoc/tabdoc-runtime-monitor', () => ({
  useTabDocRuntimeMonitorSnapshot: () => null,
}))

vi.mock('@components/layout/sidebarUi', () => ({
  SIDEBAR_CHROME_ACTION: 'sidebar-chrome-action',
  SIDEBAR_CHROME_ICON_SIZE: 16,
  SIDEBAR_CHROME_ICON_STROKE: 1.75,
  TOPBAR_CHROME_ACTION: 'topbar-chrome-action',
  TOPBAR_CHROME_ICON_SIZE: 16,
  TOPBAR_CHROME_ICON_STROKE: 1.75,
}))

vi.mock('zustand/react/shallow', () => ({
  useShallow: (fn: any) => fn,
}))

vi.mock('@tabtin/smartsheet-ui', () => ({
  toast: vi.fn(),
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
  Popover: ({ children, open }: { children: React.ReactNode; open?: boolean }) => (
    <div data-popover-open={open ? 'true' : 'false'}>{children}</div>
  ),
  PopoverTrigger: ({ children }: { children: React.ReactElement }) => children,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

async function loadIndicator() {
  const { NetworkConnectionIndicator } = await import('../NetworkConnectionIndicator')
  return NetworkConnectionIndicator
}

function openNetworkPopover() {
  fireEvent.click(screen.getByTestId('shell-top-bar-network-indicator'))
}

function getPopoverAction(label: string) {
  openNetworkPopover()
  return screen.getByRole('button', { name: label })
}

function expectStatusText(key: string) {
  expect(screen.getAllByText(key).length).toBeGreaterThan(0)
}

function getSummaryStatusText(key: string) {
  const matches = screen.getAllByText(key)
  return matches.find((element) => element.tagName === 'P') ?? matches[0]
}

function querySummaryStatusText(key: string) {
  return screen.queryAllByText(key).find((element) => element.tagName === 'P') ?? null
}

// ── Helpers ──

function resetStates() {
  mockGwConnect.mockResolvedValue(true)
  mockGwClose.mockImplementation(() => undefined)
  gwState.status = 'connected'
  gwState.authFailed = false
  gwState.reconnectAttempt = 0
  gwState.lastSyncCount = 0
  gwState.networkOnline = true
  gwState.suspendedSessionIds = []
  gwState.organizationAccessBlocked = false
  gwState.organizationAccessBlockedName = null
  gwState.organizationAccessRecoveryInFlight = false
  mockSetOrganizationAccessRecoveryInFlight.mockImplementation((value: boolean) => {
    gwState.organizationAccessRecoveryInFlight = value
  })
  imStoreState.connectionStatus = 'connected'
  imStoreState.authFailed = false
  imStoreState.sessionKicked = false
  authState.authPhase = 'authenticated' as const
  organizationState.selectedOrganization = { id: 'org-removed', name: 'Removed' }
  organizationState.lastOpenedOrganizationId = 'org-removed'
  organizationState.organizations = [{ id: 'org-removed', name: 'Removed' }]
  organizationState.loadRetryCount = 0
  organizationState.lastLoadError = null
  spaceState.spaces = [{ id: 'space-1', organization_id: 'org-removed' }]
  spaceState.isLoading = false
  spaceState.lastLoadError = null
  spaceState.error = null
  spaceState.loadErrorByOrganizationId = {}
  spaceState.lastLoadedOrganizationId = 'org-removed'
  spaceState.loadedOrganizationIds = ['org-removed']
  mockLoadOrganizations.mockResolvedValue(undefined)
  mockRecoverFromInvalidOrganizationAccess.mockResolvedValue(true)
  agentGatewayState.status = 'ready'
}

// ══════════════════════════════════════════════════════════════════════
// TESTS
// ══════════════════════════════════════════════════════════════════════

beforeEach(() => {
  vi.clearAllMocks()
  resetStates()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('场景 1: GW+IM 都连接 → 指示器显示已连接', () => {
  it('双系统正常时显示已连接指示器', async () => {
    const { NetworkConnectionIndicator } = await import('../NetworkConnectionIndicator')
    render(<NetworkConnectionIndicator />)
    expect(screen.getByTestId('shell-top-bar-network-indicator')).toBeDefined()
    expect(screen.getByLabelText(/ws.connectedSummary/)).toBeDefined()
  })

  it('展开后显示客户端和服务端的版本及源码 SHA', async () => {
    const { NetworkConnectionIndicator } = await import('../NetworkConnectionIndicator')
    render(<NetworkConnectionIndicator />)
    openNetworkPopover()

    expect(screen.getByText('0.2.1')).toBeDefined()
    expect(screen.getByText('client12')).toBeDefined()
    expect(screen.getByText('260812')).toBeDefined()
    expect(screen.getByText('server12')).toBeDefined()
    expect(screen.getByText('https://api-test.example.com/api')).toBeDefined()
  })
})

describe('场景 2: GW 断连 → 红色"连接已断开" + 手动重连按钮', () => {
  it('显示断连提示和重连按钮', async () => {
    vi.useFakeTimers()
    gwState.status = 'disconnected'
    const { NetworkConnectionIndicator } = await import('../NetworkConnectionIndicator')
    render(<NetworkConnectionIndicator />)

    await act(async () => {
      vi.advanceTimersByTime(3100)
    })

    expectStatusText('ws.disconnected')
    expect(screen.getByRole('button', { name: 'ws.manualReconnect' })).toBeDefined()
    expect(getSummaryStatusText('ws.disconnected').className).toContain('text-destructive')
  })

  it('断连后自动展开重连面板，恢复后自动收起', async () => {
    vi.useFakeTimers()
    const { NetworkConnectionIndicator } = await import('../NetworkConnectionIndicator')
    const { container, rerender } = render(<NetworkConnectionIndicator />)
    const popover = () => container.querySelector('[data-popover-open]')

    expect(popover()?.getAttribute('data-popover-open')).toBe('false')

    gwState.status = 'disconnected'
    rerender(<NetworkConnectionIndicator />)
    await act(async () => {
      vi.advanceTimersByTime(3100)
    })
    expect(popover()?.getAttribute('data-popover-open')).toBe('true')

    gwState.status = 'connected'
    rerender(<NetworkConnectionIndicator />)
    expect(popover()?.getAttribute('data-popover-open')).toBe('false')
  })

  it('多端登录被踢时不与专用确认窗口重复弹出', async () => {
    const { NetworkConnectionIndicator } = await import('../NetworkConnectionIndicator')
    const { container, rerender } = render(<NetworkConnectionIndicator />)

    imStoreState.connectionStatus = 'disconnected'
    imStoreState.sessionKicked = true
    rerender(<NetworkConnectionIndicator />)

    expect(container.querySelector('[data-popover-open]')?.getAttribute('data-popover-open')).toBe('false')
  })
})

describe('场景 3: GW 重连中 → 黄色"正在重连 (第 N 次)"', () => {
  it('显示重连中状态及尝试次数', async () => {
    vi.useFakeTimers()
    gwState.status = 'reconnecting'
    gwState.reconnectAttempt = 3
    const { NetworkConnectionIndicator } = await import('../NetworkConnectionIndicator')
    render(<NetworkConnectionIndicator />)

    await act(async () => {
      vi.advanceTimersByTime(3100)
    })

    expectStatusText('ws.reconnecting')
    expect(getSummaryStatusText('ws.reconnecting').className).toContain('text-warning')
  })

  it('自动重连中仍允许用户点击手动重连', async () => {
    vi.useFakeTimers()
    gwState.status = 'reconnecting'
    gwState.reconnectAttempt = 2
    mockGwConnect.mockResolvedValue(true)

    const { NetworkConnectionIndicator } = await import('../NetworkConnectionIndicator')
    render(<NetworkConnectionIndicator />)

    await act(async () => {
      vi.advanceTimersByTime(3100)
    })

    const btn = screen.getByRole('button', { name: 'ws.manualReconnect' }) as HTMLButtonElement
    expect(btn.disabled).toBe(false)

    await act(async () => {
      fireEvent.click(btn)
    })

    expect(mockGwConnect).toHaveBeenCalledTimes(1)
    expect(mockReconnectCentrifugo).toHaveBeenCalledTimes(1)
  })
})

describe('场景 4: 认证失败 → 红色"登录已过期"', () => {
  it('GW authFailed 显示过期提示和重试按钮', async () => {
    gwState.authFailed = true
    const { NetworkConnectionIndicator } = await import('../NetworkConnectionIndicator')
    render(<NetworkConnectionIndicator />)

    expectStatusText('ws.authExpired')
    expect(screen.getByRole('button', { name: 'ws.retry' })).toBeDefined()
    expect(getSummaryStatusText('ws.authExpired').className).toContain('text-destructive')
  })

  it('IM authFailed 同样显示过期提示', async () => {
    imStoreState.authFailed = true
    const { NetworkConnectionIndicator } = await import('../NetworkConnectionIndicator')
    render(<NetworkConnectionIndicator />)

    expectStatusText('ws.authExpired')
  })
})

describe('场景 5: GW 正常但 IM 断连 → "消息服务连接中断"', () => {
  it('GW connected + IM disconnected + 曾连接过 → 显示 IM 中断提示', async () => {
    gwState.status = 'connected'
    imStoreState.connectionStatus = 'connected'

    const { NetworkConnectionIndicator } = await import('../NetworkConnectionIndicator')
    const { rerender } = render(<NetworkConnectionIndicator />)

    // IM 曾连接过，然后断连
    imStoreState.connectionStatus = 'disconnected'
    rerender(<NetworkConnectionIndicator />)

    expectStatusText('ws.imDisconnected')
  })

  it('IM 断连时发现当前组织已被移除，会自动触发组织恢复而不是只等手动重连', async () => {
    gwState.status = 'connected'
    imStoreState.connectionStatus = 'connected'
    organizationState.selectedOrganization = { id: 'org-removed', name: 'Removed' }
    organizationState.lastOpenedOrganizationId = 'org-removed'
    mockLoadOrganizations.mockImplementation(async () => {
      organizationState.organizations = [{ id: 'org-personal', name: 'Personal' }]
    })

    const { NetworkConnectionIndicator } = await import('../NetworkConnectionIndicator')
    const { rerender } = render(<NetworkConnectionIndicator />)

    imStoreState.connectionStatus = 'disconnected'
    rerender(<NetworkConnectionIndicator />)

    await waitFor(() => {
      expect(mockSetOrganizationAccessRecoveryInFlight).toHaveBeenCalledWith(true)
      expect(mockLoadOrganizations).toHaveBeenCalledTimes(1)
      expect(mockRecoverFromInvalidOrganizationAccess).toHaveBeenCalledWith('org-removed')
    })
    expect(mockGwConnect).not.toHaveBeenCalled()
    expect(mockReconnectCentrifugo).not.toHaveBeenCalled()
  })

  it('IM 断连触发组织可访问性检查期间，优先展示组织切换提示而不是消息服务中断', async () => {
    let resolveLoadOrganizations: () => void
    mockLoadOrganizations.mockReturnValue(new Promise<void>((resolve) => {
      resolveLoadOrganizations = resolve
    }))
    gwState.status = 'connected'
    imStoreState.connectionStatus = 'connected'

    const { NetworkConnectionIndicator } = await import('../NetworkConnectionIndicator')
    const { rerender } = render(<NetworkConnectionIndicator />)

    imStoreState.connectionStatus = 'disconnected'
    rerender(<NetworkConnectionIndicator />)

    await waitFor(() => {
      expect(mockSetOrganizationAccessRecoveryInFlight).toHaveBeenCalledWith(true)
    })
    rerender(<NetworkConnectionIndicator />)

    expectStatusText('ws.organizationSwitching')
    expect(querySummaryStatusText('ws.imDisconnected')).toBeNull()

    await act(async () => {
      resolveLoadOrganizations!()
    })
  })

  it('IM 普通断连但当前组织仍可访问时，不误触发组织恢复或重连', async () => {
    gwState.status = 'connected'
    imStoreState.connectionStatus = 'connected'
    organizationState.selectedOrganization = { id: 'org-active', name: 'Active' }
    organizationState.lastOpenedOrganizationId = 'org-active'
    organizationState.organizations = [{ id: 'org-active', name: 'Active' }]

    const { NetworkConnectionIndicator } = await import('../NetworkConnectionIndicator')
    const { rerender } = render(<NetworkConnectionIndicator />)

    imStoreState.connectionStatus = 'disconnected'
    rerender(<NetworkConnectionIndicator />)

    await waitFor(() => {
      expect(mockLoadOrganizations).toHaveBeenCalledTimes(1)
    })
    expect(mockRecoverFromInvalidOrganizationAccess).not.toHaveBeenCalled()
    expect(mockGwConnect).not.toHaveBeenCalled()
    expect(mockReconnectCentrifugo).not.toHaveBeenCalled()
  })

  it('当前组织没有可用工作空间时，不显示消息服务中断红条', async () => {
    gwState.status = 'connected'
    imStoreState.connectionStatus = 'connected'
    organizationState.selectedOrganization = { id: 'org-empty', name: 'Empty Org' }
    organizationState.lastOpenedOrganizationId = 'org-empty'
    organizationState.organizations = [{ id: 'org-empty', name: 'Empty Org' }]
    spaceState.spaces = []
    spaceState.isLoading = false
    spaceState.lastLoadedOrganizationId = 'org-empty'
    spaceState.loadedOrganizationIds = ['org-empty']

    const { NetworkConnectionIndicator } = await import('../NetworkConnectionIndicator')
    const { rerender, container } = render(<NetworkConnectionIndicator />)

    imStoreState.connectionStatus = 'disconnected'
    rerender(<NetworkConnectionIndicator />)

    expect(querySummaryStatusText('ws.imDisconnected')).toBeNull()
    expect(screen.getByLabelText(/ws.connectedSummary/)).toBeDefined()
  })

  it('当前空组织已加载成功但 lastLoaded 被其他组织覆盖时，仍不显示 IM 断连提示', async () => {
    gwState.status = 'connected'
    imStoreState.connectionStatus = 'connected'
    organizationState.selectedOrganization = { id: 'org-empty', name: 'Empty Org' }
    organizationState.lastOpenedOrganizationId = 'org-empty'
    organizationState.organizations = [{ id: 'org-empty', name: 'Empty Org' }]
    spaceState.spaces = [{ id: 'space-other', organization_id: 'org-other' }]
    spaceState.isLoading = false
    spaceState.lastLoadError = null
    spaceState.error = null
    spaceState.loadErrorByOrganizationId = {}
    spaceState.lastLoadedOrganizationId = 'org-other'
    spaceState.loadedOrganizationIds = ['org-empty', 'org-other']

    const { NetworkConnectionIndicator } = await import('../NetworkConnectionIndicator')
    const { rerender, container } = render(<NetworkConnectionIndicator />)

    imStoreState.connectionStatus = 'disconnected'
    rerender(<NetworkConnectionIndicator />)

    expect(querySummaryStatusText('ws.imDisconnected')).toBeNull()
    expect(screen.getByLabelText(/ws.connectedSummary/)).toBeDefined()
  })

  it('当前空组织已加载成功但其他组织加载失败时，仍不显示 IM 断连提示', async () => {
    gwState.status = 'connected'
    imStoreState.connectionStatus = 'connected'
    organizationState.selectedOrganization = { id: 'org-empty', name: 'Empty Org' }
    organizationState.lastOpenedOrganizationId = 'org-empty'
    organizationState.organizations = [{ id: 'org-empty', name: 'Empty Org' }]
    spaceState.spaces = []
    spaceState.isLoading = false
    spaceState.lastLoadError = 'other organization failed'
    spaceState.error = 'other organization failed'
    spaceState.loadErrorByOrganizationId = { 'org-other': 'request failed' }
    spaceState.lastLoadedOrganizationId = 'org-other'
    spaceState.loadedOrganizationIds = ['org-empty']

    const { NetworkConnectionIndicator } = await import('../NetworkConnectionIndicator')
    const { rerender, container } = render(<NetworkConnectionIndicator />)

    imStoreState.connectionStatus = 'disconnected'
    rerender(<NetworkConnectionIndicator />)

    expect(querySummaryStatusText('ws.imDisconnected')).toBeNull()
    expect(screen.getByLabelText(/ws.connectedSummary/)).toBeDefined()
  })

  it('当前组织没有可用工作空间时，也不显示消息服务重连中提示', async () => {
    gwState.status = 'connected'
    imStoreState.connectionStatus = 'connected'
    organizationState.selectedOrganization = { id: 'org-empty', name: 'Empty Org' }
    organizationState.lastOpenedOrganizationId = 'org-empty'
    organizationState.organizations = [{ id: 'org-empty', name: 'Empty Org' }]
    spaceState.spaces = []
    spaceState.isLoading = false
    spaceState.lastLoadedOrganizationId = 'org-empty'
    spaceState.loadedOrganizationIds = ['org-empty']

    const { NetworkConnectionIndicator } = await import('../NetworkConnectionIndicator')
    const { rerender, container } = render(<NetworkConnectionIndicator />)

    imStoreState.connectionStatus = 'connecting'
    rerender(<NetworkConnectionIndicator />)

    expect(querySummaryStatusText('ws.imReconnecting')).toBeNull()
    expect(screen.getByLabelText(/ws.connectedSummary/)).toBeDefined()
  })

  it('工作空间列表加载中时不按空组织压掉 IM 断连提示', async () => {
    gwState.status = 'connected'
    imStoreState.connectionStatus = 'connected'
    organizationState.selectedOrganization = { id: 'org-loading', name: 'Loading Org' }
    organizationState.lastOpenedOrganizationId = 'org-loading'
    organizationState.organizations = [{ id: 'org-loading', name: 'Loading Org' }]
    spaceState.spaces = []
    spaceState.isLoading = true
    spaceState.lastLoadedOrganizationId = null
    spaceState.loadedOrganizationIds = []

    const { NetworkConnectionIndicator } = await import('../NetworkConnectionIndicator')
    const { rerender } = render(<NetworkConnectionIndicator />)

    imStoreState.connectionStatus = 'disconnected'
    rerender(<NetworkConnectionIndicator />)

    expectStatusText('ws.imDisconnected')
  })

  it('工作空间加载失败时不按空组织压掉 IM 断连提示', async () => {
    gwState.status = 'connected'
    imStoreState.connectionStatus = 'connected'
    organizationState.selectedOrganization = { id: 'org-error', name: 'Error Org' }
    organizationState.lastOpenedOrganizationId = 'org-error'
    organizationState.organizations = [{ id: 'org-error', name: 'Error Org' }]
    spaceState.spaces = []
    spaceState.isLoading = false
    spaceState.lastLoadError = 'request failed'
    spaceState.loadErrorByOrganizationId = { 'org-error': 'request failed' }
    spaceState.lastLoadedOrganizationId = null
    spaceState.loadedOrganizationIds = []

    const { NetworkConnectionIndicator } = await import('../NetworkConnectionIndicator')
    const { rerender } = render(<NetworkConnectionIndicator />)

    imStoreState.connectionStatus = 'disconnected'
    rerender(<NetworkConnectionIndicator />)

    expectStatusText('ws.imDisconnected')
  })

  it('当前组织有工作空间时，IM 重连中提示仍正常显示', async () => {
    gwState.status = 'connected'
    imStoreState.connectionStatus = 'connected'
    organizationState.selectedOrganization = { id: 'org-active', name: 'Active' }
    organizationState.lastOpenedOrganizationId = 'org-active'
    organizationState.organizations = [{ id: 'org-active', name: 'Active' }]
    spaceState.spaces = [{ id: 'space-active', organization_id: 'org-active' }]
    spaceState.lastLoadedOrganizationId = 'org-active'
    spaceState.loadedOrganizationIds = ['org-active']

    const { NetworkConnectionIndicator } = await import('../NetworkConnectionIndicator')
    const { rerender } = render(<NetworkConnectionIndicator />)

    imStoreState.connectionStatus = 'connecting'
    rerender(<NetworkConnectionIndicator />)

    expectStatusText('ws.imReconnecting')
  })

  it('当前组织无工作空间但网络离线时仍显示网络断开提示', async () => {
    vi.useFakeTimers()
    gwState.networkOnline = false
    organizationState.selectedOrganization = { id: 'org-empty', name: 'Empty Org' }
    organizationState.lastOpenedOrganizationId = 'org-empty'
    organizationState.organizations = [{ id: 'org-empty', name: 'Empty Org' }]
    spaceState.spaces = []
    spaceState.isLoading = false
    spaceState.lastLoadedOrganizationId = 'org-empty'
    spaceState.loadedOrganizationIds = ['org-empty']

    const { NetworkConnectionIndicator } = await import('../NetworkConnectionIndicator')
    const { rerender } = render(<NetworkConnectionIndicator />)

    await act(async () => {
      vi.advanceTimersByTime(3100)
    })
    rerender(<NetworkConnectionIndicator />)

    expectStatusText('ws.networkOffline')
    expect(querySummaryStatusText('ws.imDisconnected')).toBeNull()
  })

  it('当前组织无工作空间但登录失效时仍显示登录过期提示', async () => {
    gwState.authFailed = true
    organizationState.selectedOrganization = { id: 'org-empty', name: 'Empty Org' }
    organizationState.lastOpenedOrganizationId = 'org-empty'
    organizationState.organizations = [{ id: 'org-empty', name: 'Empty Org' }]
    spaceState.spaces = []
    spaceState.isLoading = false
    spaceState.lastLoadedOrganizationId = 'org-empty'
    spaceState.loadedOrganizationIds = ['org-empty']

    const { NetworkConnectionIndicator } = await import('../NetworkConnectionIndicator')
    render(<NetworkConnectionIndicator />)

    expectStatusText('ws.authExpired')
    expect(querySummaryStatusText('ws.imDisconnected')).toBeNull()
  })

  it('同一组织 IM 持续 disconnected 时，只做一次自动组织可访问性检查', async () => {
    gwState.status = 'connected'
    imStoreState.connectionStatus = 'connected'
    organizationState.selectedOrganization = { id: 'org-active', name: 'Active' }
    organizationState.lastOpenedOrganizationId = 'org-active'
    organizationState.organizations = [{ id: 'org-active', name: 'Active' }]

    const { NetworkConnectionIndicator } = await import('../NetworkConnectionIndicator')
    const { rerender } = render(<NetworkConnectionIndicator />)

    imStoreState.connectionStatus = 'disconnected'
    rerender(<NetworkConnectionIndicator />)

    await waitFor(() => {
      expect(mockLoadOrganizations).toHaveBeenCalledTimes(1)
    })

    rerender(<NetworkConnectionIndicator />)
    rerender(<NetworkConnectionIndicator />)

    expect(mockLoadOrganizations).toHaveBeenCalledTimes(1)
    expect(mockRecoverFromInvalidOrganizationAccess).not.toHaveBeenCalled()
  })

  it('IM connecting 状态显示 "消息服务重连中"', async () => {
    gwState.status = 'connected'
    imStoreState.connectionStatus = 'connected'

    const { NetworkConnectionIndicator } = await import('../NetworkConnectionIndicator')
    const { rerender } = render(<NetworkConnectionIndicator />)

    imStoreState.connectionStatus = 'connecting'
    rerender(<NetworkConnectionIndicator />)

    expectStatusText('ws.imReconnecting')
  })
})

describe('场景 5b: 系统唤醒恢复中 → 降级为网络恢复提示', () => {
  it('recovering 优先于 IM 断连红色提示', async () => {
    gwState.status = 'connected'
    imStoreState.connectionStatus = 'connected'
    agentGatewayState.status = 'recovering'

    const { NetworkConnectionIndicator } = await import('../NetworkConnectionIndicator')
    const { rerender } = render(<NetworkConnectionIndicator />)

    imStoreState.connectionStatus = 'disconnected'
    rerender(<NetworkConnectionIndicator />)

    expectStatusText('ws.networkRecovering')
    expect(getSummaryStatusText('ws.networkRecovering').className).toContain('text-warning')
  })
})

describe('场景 6: 首次 IM 未连接过 → 不显示 IM 状态', () => {
  it('imWasConnectedRef=false 时 IM disconnected 仍显示已连接指示器', async () => {
    gwState.status = 'connected'
    imStoreState.connectionStatus = 'disconnected'

    const { NetworkConnectionIndicator } = await import('../NetworkConnectionIndicator')
    render(<NetworkConnectionIndicator />)

    expect(querySummaryStatusText('ws.imDisconnected')).toBeNull()
    expect(screen.getByLabelText(/ws.connectedSummary/)).toBeDefined()
  })
})

describe('场景 7: 手动重连同时触发 GW 和 Centrifugo', () => {
  it('点击手动重连后 GW 成功 → 触发 Centrifugo 重连', async () => {
    vi.useFakeTimers()
    gwState.status = 'disconnected'
    mockGwConnect.mockResolvedValue(true)

    const { NetworkConnectionIndicator } = await import('../NetworkConnectionIndicator')
    render(<NetworkConnectionIndicator />)

    await act(async () => {
      vi.advanceTimersByTime(3100)
    })

    const btn = screen.getByRole('button', { name: 'ws.manualReconnect' })

    await act(async () => {
      fireEvent.click(btn)
    })

    expect(mockGwClose).toHaveBeenCalledTimes(1)
    expect(mockGwConnect).toHaveBeenCalledTimes(1)
    expect(mockGwClose.mock.invocationCallOrder[0]).toBeLessThan(mockGwConnect.mock.invocationCallOrder[0])
    expect(mockReconnectCentrifugo).toHaveBeenCalledTimes(1)
    expect(mockSetOrganizationAccessRecoveryInFlight).not.toHaveBeenCalled()
  })

  it('关闭旧 GW 失败时仍继续尝试重新连接', async () => {
    vi.useFakeTimers()
    gwState.status = 'disconnected'
    mockGwClose.mockImplementationOnce(() => {
      throw new Error('close failed')
    })
    mockGwConnect.mockResolvedValue(true)

    const { NetworkConnectionIndicator } = await import('../NetworkConnectionIndicator')
    render(<NetworkConnectionIndicator />)

    await act(async () => {
      vi.advanceTimersByTime(3100)
    })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'ws.manualReconnect' }))
    })

    expect(mockGwClose).toHaveBeenCalledTimes(1)
    expect(mockGwConnect).toHaveBeenCalledTimes(1)
    expect(mockReconnectCentrifugo).toHaveBeenCalledTimes(1)
  })

  it('当前组织已不可访问时转入组织恢复，不误触发 IM 重连', async () => {
    gwState.status = 'connected'
    imStoreState.connectionStatus = 'connected'
    organizationState.selectedOrganization = { id: 'org-removed', name: 'Removed' }
    organizationState.lastOpenedOrganizationId = 'org-removed'
    mockLoadOrganizations.mockImplementation(async () => {
      organizationState.organizations = [{ id: 'org-personal', name: 'Personal' }]
    })

    const { NetworkConnectionIndicator } = await import('../NetworkConnectionIndicator')
    const { rerender } = render(<NetworkConnectionIndicator />)

    imStoreState.connectionStatus = 'disconnected'
    rerender(<NetworkConnectionIndicator />)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'ws.manualReconnect' }))
    })

    expect(mockLoadOrganizations).toHaveBeenCalled()
    expect(mockRecoverFromInvalidOrganizationAccess).toHaveBeenCalledWith('org-removed')
    expect(mockGwConnect).not.toHaveBeenCalled()
    expect(mockReconnectCentrifugo).not.toHaveBeenCalled()
  })

  it('手动重连刷新组织返回无权限且本地仍是旧组织时，按组织失效恢复而不是继续普通重连', async () => {
    vi.useFakeTimers()
    gwState.status = 'disconnected'
    organizationState.selectedOrganization = { id: 'org-removed', name: 'Removed' }
    organizationState.lastOpenedOrganizationId = 'org-removed'
    organizationState.organizations = [
      { id: 'org-removed', name: 'Removed' },
      { id: 'org-personal', name: 'Personal' },
    ]
    mockLoadOrganizations.mockImplementation(async () => {
      organizationState.loadRetryCount = 1
      organizationState.lastLoadError = 'organization access denied'
    })

    const { NetworkConnectionIndicator } = await import('../NetworkConnectionIndicator')
    render(<NetworkConnectionIndicator />)

    await act(async () => {
      vi.advanceTimersByTime(3100)
    })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'ws.manualReconnect' }))
    })

    expect(mockRecoverFromInvalidOrganizationAccess).toHaveBeenCalledWith('org-removed')
    expect(mockGwConnect).not.toHaveBeenCalled()
    expect(mockReconnectCentrifugo).not.toHaveBeenCalled()
  })

  it('手动重连刷新组织遇到普通网络错误时，不误判为组织失效', async () => {
    vi.useFakeTimers()
    gwState.status = 'disconnected'
    organizationState.selectedOrganization = { id: 'org-active', name: 'Active' }
    organizationState.lastOpenedOrganizationId = 'org-active'
    organizationState.organizations = [{ id: 'org-active', name: 'Active' }]
    mockLoadOrganizations.mockImplementation(async () => {
      organizationState.loadRetryCount = 1
      organizationState.lastLoadError = 'request timeout'
    })
    mockGwConnect.mockResolvedValue(true)

    const { NetworkConnectionIndicator } = await import('../NetworkConnectionIndicator')
    render(<NetworkConnectionIndicator />)

    await act(async () => {
      vi.advanceTimersByTime(3100)
    })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'ws.manualReconnect' }))
    })

    expect(mockRecoverFromInvalidOrganizationAccess).not.toHaveBeenCalled()
    expect(mockGwConnect).toHaveBeenCalledTimes(1)
    expect(mockReconnectCentrifugo).toHaveBeenCalledTimes(1)
  })
})

describe('场景 8: GW 重连失败时不触发 Centrifugo 重连', () => {
  it('GW connect 返回 false → 不调用 reconnectCentrifugo', async () => {
    vi.useFakeTimers()
    gwState.status = 'disconnected'
    mockGwConnect.mockResolvedValue(false)

    const { NetworkConnectionIndicator } = await import('../NetworkConnectionIndicator')
    render(<NetworkConnectionIndicator />)

    await act(async () => {
      vi.advanceTimersByTime(3100)
    })

    const btn = screen.getByRole('button', { name: 'ws.manualReconnect' })

    await act(async () => {
      fireEvent.click(btn)
    })

    expect(mockGwConnect).toHaveBeenCalledTimes(1)
    expect(mockReconnectCentrifugo).not.toHaveBeenCalled()
  })

  it('GW connect 抛异常 → 不调用 reconnectCentrifugo', async () => {
    vi.useFakeTimers()
    gwState.status = 'disconnected'
    mockGwConnect.mockRejectedValue(new Error('network error'))

    const { NetworkConnectionIndicator } = await import('../NetworkConnectionIndicator')
    render(<NetworkConnectionIndicator />)

    await act(async () => {
      vi.advanceTimersByTime(3100)
    })

    const btn = screen.getByRole('button', { name: 'ws.manualReconnect' })

    await act(async () => {
      fireEvent.click(btn)
    })

    expect(mockReconnectCentrifugo).not.toHaveBeenCalled()
  })
})

describe('场景 9: 认证重试 2 次后自动登出', () => {
  it('第 3 次点击重试按钮 → 调用 logout', async () => {
    gwState.authFailed = true

    const { NetworkConnectionIndicator } = await import('../NetworkConnectionIndicator')
    render(<NetworkConnectionIndicator />)

    // 第 1 次重试
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'ws.retry' }))
    })
    await waitFor(() => {
      expect((screen.getByRole('button', { name: 'ws.retry' }) as HTMLButtonElement).disabled).toBe(false)
    })
    expect(mockLogout).not.toHaveBeenCalled()
    expect(mockClearAuthFailed).toHaveBeenCalledTimes(1)

    // 第 2 次重试
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'ws.retry' }))
    })
    await waitFor(() => {
      expect((screen.getByRole('button', { name: 'ws.relogin' }) as HTMLButtonElement).disabled).toBe(false)
    })
    expect(mockLogout).not.toHaveBeenCalled()
    expect(mockClearAuthFailed).toHaveBeenCalledTimes(2)

    // 第 3 次重试 → 自动登出
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'ws.relogin' }))
    })
    expect(mockLogout).toHaveBeenCalledTimes(1)
  })
})

describe('场景 10: 恢复后 toast 提示连接已恢复', () => {
  it('从断连恢复到全连接 → toast 成功提示', async () => {
    gwState.status = 'disconnected'
    imStoreState.connectionStatus = 'connected'

    const { NetworkConnectionIndicator } = await import('../NetworkConnectionIndicator')
    const { rerender } = render(<NetworkConnectionIndicator />)

    gwState.status = 'connected'
    rerender(<NetworkConnectionIndicator />)

    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'ws.recovered' }))
  })

  it('有同步计数时 toast 显示同步信息', async () => {
    gwState.status = 'disconnected'
    gwState.lastSyncCount = 5
    imStoreState.connectionStatus = 'connected'

    const { NetworkConnectionIndicator } = await import('../NetworkConnectionIndicator')
    const { rerender } = render(<NetworkConnectionIndicator />)

    gwState.status = 'connected'
    rerender(<NetworkConnectionIndicator />)

    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'ws.recoveredWithSync' }))
  })
})

describe('场景 11: networkOnline=false → 显示网络断开 Banner', () => {
  it('网络断开时显示最高优先级的断网提示', async () => {
    vi.useFakeTimers()
    gwState.networkOnline = false
    const { NetworkConnectionIndicator } = await import('../NetworkConnectionIndicator')
    const { rerender } = render(<NetworkConnectionIndicator />)

    await act(async () => {
      vi.advanceTimersByTime(3100)
    })
    rerender(<NetworkConnectionIndicator />)

    expectStatusText('ws.networkOffline')
  })
})

describe('场景 12: suspendedSessionIds 非空 → 网络指示器仍显示已连接', () => {
  it('有挂起 session 时顶栏仍保留连接指示器', async () => {
    gwState.suspendedSessionIds = ['session-1']
    const { NetworkConnectionIndicator } = await import('../NetworkConnectionIndicator')
    render(<NetworkConnectionIndicator />)
    expect(screen.getByTestId('shell-top-bar-network-indicator')).toBeDefined()
  })
})

describe('场景 14: 短暂断连 (<3s) 不显示断开 Banner', () => {
  it('断连 2 秒内恢复不显示 Banner', async () => {
    vi.useFakeTimers()
    const { NetworkConnectionIndicator } = await import('../NetworkConnectionIndicator')
    const { rerender } = render(<NetworkConnectionIndicator />)

    gwState.status = 'disconnected'
    rerender(<NetworkConnectionIndicator />)

    await act(async () => {
      vi.advanceTimersByTime(2000)
    })
    rerender(<NetworkConnectionIndicator />)
    expect(querySummaryStatusText('ws.disconnected')).toBeNull()

    gwState.status = 'connected'
    rerender(<NetworkConnectionIndicator />)
    expect(querySummaryStatusText('ws.disconnected')).toBeNull()
  })
})

describe('场景 15: 持续断连 >3s 显示断开 Banner', () => {
  it('断连超过 3 秒后显示 Banner', async () => {
    vi.useFakeTimers()
    const { NetworkConnectionIndicator } = await import('../NetworkConnectionIndicator')
    const { rerender } = render(<NetworkConnectionIndicator />)

    gwState.status = 'disconnected'
    rerender(<NetworkConnectionIndicator />)

    await act(async () => {
      vi.advanceTimersByTime(3100)
    })
    rerender(<NetworkConnectionIndicator />)

    expectStatusText('ws.disconnected')
  })
})

describe('场景 16: 组织权限恢复中 → 显示切换组织提示', () => {
  it('organizationAccessRecoveryInFlight 显示黄色切换提示', async () => {
    gwState.organizationAccessRecoveryInFlight = true
    const { NetworkConnectionIndicator } = await import('../NetworkConnectionIndicator')
    render(<NetworkConnectionIndicator />)

    expectStatusText('ws.organizationSwitching')
    expect(getSummaryStatusText('ws.organizationSwitching').className).toContain('text-warning')
  })
})

describe('场景 17: 组织无权限且无法自动切换 → 显示组织访问受阻提示', () => {
  it('organizationAccessBlocked 显示组织名与手动切换指引', async () => {
    gwState.organizationAccessBlocked = true
    gwState.organizationAccessBlockedName = '7.12'
    const { NetworkConnectionIndicator } = await import('../NetworkConnectionIndicator')
    render(<NetworkConnectionIndicator />)

    expectStatusText('ws.organizationAccessBlocked')
    expect(getSummaryStatusText('ws.organizationAccessBlocked').className).toContain('text-destructive')
  })
})
