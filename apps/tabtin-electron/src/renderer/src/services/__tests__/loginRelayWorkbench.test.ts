import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSpaceViewPrefsStore } from '@stores/useSpaceViewPrefsStore'

const mocks = vi.hoisted(() => ({
  createWorkspace: vi.fn(),
  closeCrawlspace: vi.fn(),
  openResourceTab: vi.fn(),
  closeTab: vi.fn(),
  createView: vi.fn(),
  createElectronIpcAdapter: vi.fn(),
  activateBrowserView: vi.fn(),
  ensureSeed: vi.fn(),
}))

vi.mock('@stores/useCrawlTabStore', () => ({
  useCrawlTabStore: {
    getState: () => ({
      createWorkspace: mocks.createWorkspace,
      closeCrawlspace: mocks.closeCrawlspace,
    }),
  },
}))

vi.mock('@stores/useSpaceContextTabsStore', () => ({
  useSpaceContextTabsStore: {
    getState: () => ({
      openResourceTab: mocks.openResourceTab,
      closeTab: mocks.closeTab,
    }),
  },
}))

vi.mock('@components/crawlspace-workspace/hooks/useCrawlSpaceViewManagerAdapter', () => ({
  createElectronIpcAdapter: (...args: unknown[]) => mocks.createElectronIpcAdapter(...args),
}))

vi.mock('@/services/browserViewActivation', () => ({
  activateBrowserView: (...args: unknown[]) => mocks.activateBrowserView(...args),
}))

vi.mock('@stores/seed-manager', () => ({
  seedManager: { ensureSeed: (...args: unknown[]) => mocks.ensureSeed(...args) },
}))

vi.mock('@/crawlspace/workspace-defaults', () => ({
  getAgentWorkspaceDefaults: () => ({
    profile: 'agent-workspace',
    runPrefix: 'agent',
    uiConfig: { enableMultiView: true, defaultTitle: 'Browser' },
  }),
}))

describe('loginRelayWorkbench', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useSpaceViewPrefsStore.setState({
      canvasCollapsedByScopeKey: { 'conversation:thread-1': true },
      taskViewModeByScopeKey: { 'conversation:thread-1': 'chat-focus' },
    })
    mocks.createWorkspace.mockReturnValue({ id: 'cs-login-relay-relay-1' })
    mocks.createView.mockResolvedValue(true)
    mocks.createElectronIpcAdapter.mockReturnValue({ createView: mocks.createView })
    mocks.activateBrowserView.mockResolvedValue({ ok: true, code: 'activated' })
    mocks.closeCrawlspace.mockResolvedValue(undefined)
  })

  it('opens a visible workbench Browser tab with the organization browser partition', async () => {
    const { openLoginRelayWorkbenchTab } = await import('../loginRelayWorkbench')

    await expect(openLoginRelayWorkbenchTab({
      tabScopeKey: 'conversation:thread-1',
      relayId: 'relay-1',
      organizationId: 'org-1',
      partition: 'persist:tabtin:organization:org-1:browser',
      loginUrl: 'https://example.com/',
      domain: 'example.com',
    })).resolves.toEqual({
      ok: true,
      handle: {
        crawlspaceId: 'cs-login-relay-relay-1',
        viewId: 'view-login-relay-relay-1',
        tabScopeKey: 'conversation:thread-1',
        tabKey: 'login_relay:view-login-relay-relay-1',
      },
    })

    expect(mocks.createWorkspace).toHaveBeenCalledWith(expect.objectContaining({
      crawlspaceId: 'cs-login-relay-relay-1',
      profile: 'agent-workspace',
      partition: 'persist:tabtin:organization:org-1:browser',
    }))
    expect(mocks.createWorkspace.mock.calls[0][0]).not.toHaveProperty('spaceId')
    expect(mocks.createView).toHaveBeenCalledWith(
      'view-login-relay-relay-1',
      'https://example.com/',
      undefined,
      '登录 example.com',
    )
    expect(mocks.openResourceTab).toHaveBeenCalledWith(
      'conversation:thread-1',
      expect.objectContaining({
        type: 'login_relay',
        id: 'view-login-relay-relay-1',
        silent: true,
      }),
    )
    expect(mocks.activateBrowserView).toHaveBeenCalledWith(
      'cs-login-relay-relay-1',
      'view-login-relay-relay-1',
      expect.objectContaining({
        selection: {
          tabScopeKey: 'conversation:thread-1',
          tabKey: 'login_relay:view-login-relay-relay-1',
        },
      }),
    )
    expect(
      useSpaceViewPrefsStore.getState().getCanvasCollapsed('conversation:thread-1'),
    ).toBe(false)
    expect(
      useSpaceViewPrefsStore.getState().getTaskViewMode('conversation:thread-1'),
    ).toBe('split')
  })

  it('rejects a mismatched partition before creating browser state', async () => {
    const { openLoginRelayWorkbenchTab } = await import('../loginRelayWorkbench')

    await expect(openLoginRelayWorkbenchTab({
      tabScopeKey: 'conversation:thread-1',
      relayId: 'relay-1',
      organizationId: 'org-1',
      partition: 'persist:tabtin:organization:another-org:browser',
      loginUrl: 'https://example.com/',
      domain: 'example.com',
    })).resolves.toEqual({ ok: false, error: '登录页面无效' })
    expect(mocks.createWorkspace).not.toHaveBeenCalled()
    expect(mocks.createView).not.toHaveBeenCalled()
  })

  it('closes the workbench tab and crawlspace when login finishes or is cancelled', async () => {
    const { closeLoginRelayWorkbenchTab } = await import('../loginRelayWorkbench')
    await closeLoginRelayWorkbenchTab({
      crawlspaceId: 'cs-login-relay-relay-1',
      viewId: 'view-login-relay-relay-1',
      tabScopeKey: 'conversation:thread-1',
      tabKey: 'login_relay:view-login-relay-relay-1',
    })

    expect(mocks.closeTab).toHaveBeenCalledWith(
      'conversation:thread-1',
      'login_relay:view-login-relay-relay-1',
    )
    expect(mocks.closeCrawlspace).toHaveBeenCalledWith(
      'cs-login-relay-relay-1',
      'login-relay-finished',
      { reason: 'login-relay-finished' },
    )
  })

  it('rolls back the login crawlspace when view creation fails', async () => {
    mocks.createView.mockResolvedValue(false)
    const { openLoginRelayWorkbenchTab } = await import('../loginRelayWorkbench')

    await expect(openLoginRelayWorkbenchTab({
      tabScopeKey: 'conversation:thread-1',
      relayId: 'relay-1',
      organizationId: 'org-1',
      partition: 'persist:tabtin:organization:org-1:browser',
      loginUrl: 'https://example.com/',
      domain: 'example.com',
    })).resolves.toEqual({ ok: false, error: '无法打开登录页面' })
    expect(mocks.openResourceTab).not.toHaveBeenCalled()
    expect(mocks.closeCrawlspace).toHaveBeenCalledWith(
      'cs-login-relay-relay-1',
      'login-relay-open-failed',
      { reason: 'login-relay-open-failed' },
    )
  })
})
