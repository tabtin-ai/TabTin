/**
 * Agent/CLI 通过 create_web_tab 打开网页时，只更新浏览器运行时目标，不抢占用户当前 App。
 * set_active_context_tab 仍是 Agent 明确要求展示浏览器标签的前台切换入口。
 *  / ：未传 / 传裸宿主 ID 时升到前台 scope，避免写进看不见的 legacy 桶。
 * ：显式 conversation:/desktop: scope 优先于前台 UI，避免并行多对话串桶。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const events: string[] = []

const mocks = vi.hoisted(() => ({
  buildTabKey: vi.fn((type: string, id: string) => `${type}:${id}`),
  setActiveKey: vi.fn(),
  openResourceTab: vi.fn(),
  closeTab: vi.fn(),
  createView: vi.fn(),
  setActiveView: vi.fn(),
  loadUrl: vi.fn(),
  closeCrawlspaceView: vi.fn(),
  ensureSpaceCrawlspace: vi.fn(),
  ensureScopedCrawlspace: vi.fn(),
  ensureNamedCrawlspace: vi.fn(),
  resolveForegroundTabScopeKey: vi.fn(),
  createViewFailure: { current: undefined as string | undefined },
  // ：webview 后台挂载
  getCrawlspaceConfig: vi.fn(),
  webviewEnsure: vi.fn(),
  webviewActivateKnownRun: vi.fn(),
  webviewContainerEnabled: { current: false },
}))

vi.mock('../../registry', () => ({
  contextRegistry: {
    buildTabKey: (type: string, id: string) => mocks.buildTabKey(type, id),
    parseTabKey: (key: string) => {
      const idx = key.indexOf(':')
      if (idx <= 0 || idx === key.length - 1) return null
      return { type: key.slice(0, idx), id: key.slice(idx + 1) }
    },
    getAllHandlers: () => [],
    buildCanvasContent: () => null,
  },
}))

vi.mock('@components/context-space/registry', () => ({
  contextRegistry: {
    buildTabKey: (type: string, id: string) => mocks.buildTabKey(type, id),
    parseTabKey: (key: string) => {
      const idx = key.indexOf(':')
      if (idx <= 0 || idx === key.length - 1) return null
      return { type: key.slice(0, idx), id: key.slice(idx + 1) }
    },
    getAllHandlers: () => [],
    buildCanvasContent: () => null,
  },
}))

vi.mock('../../registry/resolveUtils', () => ({
  resolveTabItemCore: () => null,
}))

vi.mock('@stores/useSpaceContextTabsStore', () => ({
  useSpaceContextTabsStore: {
    getState: () => ({
      activeKeyBySpace: { 'space-1': 'tabdata:old' },
      tabOrderBySpace: { 'space-1': ['tabdata:old'] },
      itemsBySpace: {},
      setActiveKey: (...args: unknown[]) => mocks.setActiveKey(...args),
      openResourceTab: (...args: unknown[]) => mocks.openResourceTab(...args),
      closeTab: (...args: unknown[]) => mocks.closeTab(...args),
      setTabOrder: vi.fn(),
    }),
  },
}))

vi.mock('@stores/useCanvasLayoutStore', () => ({
  useCanvasLayoutStore: {
    getState: () => ({
      spaceGroups: {},
      closePane: vi.fn(),
      splitPaneWithContent: vi.fn(),
      movePane: vi.fn(),
      dockPaneToOuter: vi.fn(),
    }),
  },
}))

vi.mock('@stores/useCrawlTabStore', () => ({
  useCrawlTabStore: {
    getState: () => ({
      tabs: [],
      crawlspaceContextCache: {},
      _recentlyClosedViewIds: new Set<string>(),
      ensureSpaceCrawlspace: (...args: unknown[]) => mocks.ensureSpaceCrawlspace(...args),
      ensureScopedCrawlspace: (...args: unknown[]) => mocks.ensureScopedCrawlspace(...args),
      ensureNamedCrawlspace: (...args: unknown[]) => mocks.ensureNamedCrawlspace(...args),
      getSpaceCrawlspace: () => null,
      closeCrawlspaceView: (...args: unknown[]) => mocks.closeCrawlspaceView(...args),
      getNamedCrawlspace: vi.fn(),
      getCrawlspaceViews: vi.fn(),
      purgeCrawlspaceData: vi.fn(),
      getSpaceSessionList: vi.fn(),
      getCrawlspaceConfig: (...args: unknown[]) => mocks.getCrawlspaceConfig(...args),
    }),
  },
}))

vi.mock('@/utils/browserContainerMode', () => ({
  getBrowserContainerMode: () => (mocks.webviewContainerEnabled.current ? 'webview' : 'wcv'),
  isWebviewContainerEnabled: () => mocks.webviewContainerEnabled.current,
}))

vi.mock('@/crawlspace/webview-manager/WebviewManager', () => ({
  getWebviewManager: () => ({
    ensure: (...args: unknown[]) => mocks.webviewEnsure(...args),
  }),
}))

vi.mock('@/crawlspace/webview-manager/webviewHostView', () => ({
  getWebviewKeepaliveController: () => ({
    activateKnownRun: (...args: unknown[]) => mocks.webviewActivateKnownRun(...args),
  }),
}))

vi.mock('@/crawlspace/electron/crawlspace-context-client', () => ({
  crawlspaceContextClient: {
    setActiveView: (...args: unknown[]) => mocks.setActiveView(...args),
  },
}))

vi.mock('@/crawlspace/electron/crawl-view-client', () => ({
  crawlViewClient: {
    loadUrl: (...args: unknown[]) => mocks.loadUrl(...args),
  },
}))

vi.mock('@components/crawlspace-workspace/hooks/useCrawlSpaceViewManagerAdapter', () => ({
  createElectronIpcAdapter: (
    _crawlspaceId: string,
    _spaceId?: string,
    options?: { onCreateViewFailure?: (message: string) => void },
  ) => ({
    createView: async (...args: unknown[]) => {
      const created = await mocks.createView(...args)
      if (!created && mocks.createViewFailure.current) {
        options?.onCreateViewFailure?.(mocks.createViewFailure.current)
      }
      return created
    },
  }),
}))

vi.mock('@components/chat/subagent/openSubagentTab', () => ({
  resolveForegroundTabScopeKey: (...args: unknown[]) => mocks.resolveForegroundTabScopeKey(...args),
}))

vi.mock('../../utils/canvasLayout', () => ({
  findGroupForTabKey: () => null,
  EMPTY_CANVAS_GROUPS: [],
}))

vi.mock('../../utils/activeKeyFallback', () => ({
  computeFallbackTabKeyFromStore: () => null,
}))

vi.mock('@stores/seed-manager', () => ({
  seedManager: {
    ensureSeed: vi.fn(),
  },
}))

import { invokeCreateWebTab, invokeSetActiveContextTab } from '../ContextSpaceToolHandler'
import { resetBrowserViewActivationStateForTests } from '@/services/browserViewActivation'

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => { resolve = res })
  return { promise, resolve }
}

beforeEach(() => {
  vi.restoreAllMocks()
  events.length = 0
  vi.clearAllMocks()
  mocks.createViewFailure.current = undefined
  mocks.webviewContainerEnabled.current = false
  mocks.getCrawlspaceConfig.mockReturnValue(null)
  mocks.webviewEnsure.mockResolvedValue({ created: true })
  resetBrowserViewActivationStateForTests()
  mocks.ensureSpaceCrawlspace.mockReturnValue({ id: 'cs-1' })
  mocks.ensureScopedCrawlspace.mockReturnValue({ id: 'cs-1' })
  mocks.ensureNamedCrawlspace.mockReturnValue({ id: 'cs-named' })
  mocks.resolveForegroundTabScopeKey.mockImplementation((spaceId: string) => spaceId)
  mocks.closeCrawlspaceView.mockResolvedValue({ ok: true })
  mocks.createView.mockImplementation(async () => {
    events.push('createView')
    return true
  })
  mocks.setActiveView.mockImplementation(async () => {
    events.push('setActiveView')
    return { success: true }
  })
  mocks.setActiveKey.mockImplementation(() => {
    events.push('setActiveKey')
  })
  mocks.loadUrl.mockImplementation(() => {
    events.push('loadUrl')
    return Promise.resolve({ success: true })
  })
})

describe('invokeCreateWebTab activation ordering', () => {
  it('set_active_context_tab 先由统一服务激活，成功后才提交目标 tabKey', async () => {
    const result = await invokeSetActiveContextTab({
      spaceId: 'space-1',
      tabScopeKey: 'scope-1',
      crawlspaceId: 'cs-1',
      tabKey: 'tabweb:view-old',
    })

    expect(result).toEqual({
      success: true,
      data: { activeTabKey: 'tabweb:view-old' },
    })
    expect(events).toEqual(['setActiveView', 'setActiveKey'])
    expect(mocks.setActiveView).toHaveBeenCalledWith('cs-1', 'view-old')
    expect(mocks.setActiveKey).toHaveBeenCalledWith(
      'scope-1',
      'tabweb:view-old',
      expect.objectContaining({ reason: 'browserViewActivation.complete' }),
    )
  })

  it('CLI 未传 scope 时跟随当前前台标签池，不误写 legacy Space ID 桶', async () => {
    mocks.resolveForegroundTabScopeKey.mockReturnValue('desktop:')

    const result = await invokeSetActiveContextTab({
      spaceId: 'space-1',
      crawlspaceId: 'cs-1',
      tabKey: 'tabweb:view-old',
    })

    expect(result).toEqual({
      success: true,
      data: { activeTabKey: 'tabweb:view-old' },
    })
    expect(mocks.setActiveView).toHaveBeenCalledWith('cs-1', 'view-old')
    expect(mocks.setActiveKey).toHaveBeenCalledWith(
      'desktop:',
      'tabweb:view-old',
      expect.objectContaining({ reason: 'browserViewActivation.complete' }),
    )
    expect(mocks.setActiveKey).not.toHaveBeenCalledWith('space-1', 'tabweb:view-old')
  })

  it('Agent/CLI 创建网页时只更新浏览器运行时目标，不切换工作台当前 App', async () => {
    const result = await invokeCreateWebTab({
      spaceId: 'space-1',
      runId: 'run-1',
      url: 'https://example.com/',
      title: 'Example',
    })

    expect(result.success).toBe(true)
    const viewId = (result.data as { viewId: string }).viewId
    expect(viewId).toMatch(/^view-cs-1-\d+-\d+$/)
    expect(events).toEqual(['createView', 'setActiveView'])
    expect(mocks.createView).toHaveBeenCalledWith(
      viewId,
      'https://example.com/',
      'run-1',
      'Example',
      undefined,
      undefined,
    )
    expect(mocks.setActiveView).toHaveBeenCalledWith('cs-1', viewId)
    expect(mocks.setActiveKey).not.toHaveBeenCalled()
    expect(mocks.loadUrl).not.toHaveBeenCalled()
  })

  it('#6538：显式 conversation scope 优先于前台 UI，后台 Agent 开网页不串到正在看的对话', async () => {
    const foregroundScope = 'conversation:session-2'
    const originatingScope = 'conversation:session-1'
    mocks.resolveForegroundTabScopeKey.mockReturnValue(foregroundScope)
    mocks.ensureScopedCrawlspace.mockImplementation((_spaceId: string, scopeKey: string) => ({
      id: scopeKey === originatingScope ? 'cs-session-1' : 'cs-session-2',
    }))

    const result = await invokeCreateWebTab({
      spaceId: 'space-1',
      workspaceScopeKey: originatingScope,
      url: 'https://36kr.com/',
      title: '36kr',
    })

    expect(result.success).toBe(true)
    const viewId = (result.data as { viewId: string }).viewId
    expect(viewId).toMatch(/^view-cs-session-1-\d+-\d+$/)
    expect(mocks.ensureScopedCrawlspace).toHaveBeenCalledWith('space-1', originatingScope, { title: '36kr' })
    expect(mocks.setActiveView).toHaveBeenCalledWith('cs-session-1', viewId)
    expect(mocks.setActiveKey).not.toHaveBeenCalled()
    expect(mocks.openResourceTab).toHaveBeenCalledWith(originatingScope, {
      type: 'tabweb',
      id: viewId,
      title: '36kr',
      meta: {
        url: 'https://36kr.com/',
        crawlspaceId: 'cs-session-1',
        spaceId: 'space-1',
      },
      silent: true,
    })
    expect(mocks.ensureScopedCrawlspace).not.toHaveBeenCalledWith(
      'space-1',
      foregroundScope,
      expect.anything(),
    )
  })

  it('未传 scope 时升到前台 scope，避免写进 legacy 宿主 ID 桶', async () => {
    const foregroundScope = 'desktop:organization:org-1:user:user-1'
    mocks.resolveForegroundTabScopeKey.mockReturnValue(foregroundScope)
    mocks.ensureScopedCrawlspace.mockImplementation((_spaceId: string, scopeKey: string) => ({
      id: scopeKey === foregroundScope ? 'cs-foreground' : 'cs-legacy',
    }))

    const result = await invokeCreateWebTab({
      spaceId: 'space-1',
      url: 'https://example.com/',
      title: 'Example',
    })

    expect(result.success).toBe(true)
    const viewId = (result.data as { viewId: string }).viewId
    expect(viewId).toMatch(/^view-cs-foreground-\d+-\d+$/)
    expect(mocks.ensureScopedCrawlspace).toHaveBeenCalledWith('space-1', foregroundScope, { title: 'Example' })
    expect(mocks.setActiveView).toHaveBeenCalledWith('cs-foreground', viewId)
    expect(mocks.setActiveKey).not.toHaveBeenCalled()
  })

  it('传裸宿主 ID 时升到前台 scope，不当作真实 conversation 归属', async () => {
    const foregroundScope = 'conversation:session-2'
    mocks.resolveForegroundTabScopeKey.mockReturnValue(foregroundScope)
    mocks.ensureScopedCrawlspace.mockImplementation((_spaceId: string, scopeKey: string) => ({
      id: scopeKey === foregroundScope ? 'cs-foreground' : 'cs-legacy',
    }))

    const result = await invokeCreateWebTab({
      spaceId: 'space-1',
      tabScopeKey: 'space-1',
      url: 'https://example.com/',
      title: 'Example',
    })

    expect(result.success).toBe(true)
    const viewId = (result.data as { viewId: string }).viewId
    expect(mocks.ensureScopedCrawlspace).toHaveBeenCalledWith('space-1', foregroundScope, { title: 'Example' })
    expect(mocks.setActiveView).toHaveBeenCalledWith('cs-foreground', viewId)
    expect(mocks.setActiveKey).not.toHaveBeenCalled()
  })

  it('命名浏览 session 保持显式 payload scope，不强行重路由到前台 scope', async () => {
    const foregroundScope = 'desktop:organization:org-1:user:user-1'
    mocks.resolveForegroundTabScopeKey.mockReturnValue(foregroundScope)
    mocks.ensureNamedCrawlspace.mockReturnValue({ id: 'cs-named-alpha' })

    const result = await invokeCreateWebTab({
      spaceId: 'space-1',
      workspaceScopeKey: 'conversation:session-1',
      sessionName: 'alpha',
      url: 'https://example.com/',
      title: 'Example',
    })

    expect(result.success).toBe(true)
    const viewId = (result.data as { viewId: string }).viewId
    expect(viewId).toMatch(/^view-cs-named-alpha-\d+-\d+$/)
    expect(mocks.ensureNamedCrawlspace).toHaveBeenCalledWith('space-1', 'alpha', { title: 'Example' })
    expect(mocks.ensureScopedCrawlspace).not.toHaveBeenCalled()
    expect(mocks.setActiveView).toHaveBeenCalledWith('cs-named-alpha', viewId)
    expect(mocks.setActiveKey).not.toHaveBeenCalled()
  })

  it('createView 失败时不临时切 active，避免回退到 home/旧 tab', async () => {
    mocks.createView.mockImplementation(async () => {
      events.push('createView')
      return false
    })

    const result = await invokeCreateWebTab({
      spaceId: 'space-1',
      url: 'https://example.com/',
      title: 'Example',
    })

    expect(result).toMatchObject({ success: false, error: 'IPC createView failed' })
    expect(events).toEqual(['createView'])
    expect(mocks.setActiveView).not.toHaveBeenCalled()
    expect(mocks.setActiveKey).not.toHaveBeenCalled()
    expect(mocks.loadUrl).not.toHaveBeenCalled()
  })

  it('createView 达到配额时透传真实原因，不误报为 IPC/浏览器崩溃', async () => {
    mocks.createViewFailure.current = '达到全局最大 View 数限制 (20)'
    mocks.createView.mockImplementation(async () => {
      events.push('createView')
      return false
    })

    const result = await invokeCreateWebTab({
      spaceId: 'space-1',
      url: 'https://example.com/',
      title: 'Example',
    })

    expect(result).toMatchObject({
      success: false,
      error: '达到全局最大 View 数限制 (20)',
    })
    expect(events).toEqual(['createView'])
    expect(mocks.setActiveView).not.toHaveBeenCalled()
    expect(mocks.loadUrl).not.toHaveBeenCalled()
  })

  it('setActiveView 失败时关闭已创建 view，且不切顶部 active tab', async () => {
    mocks.setActiveView.mockImplementation(async () => {
      events.push('setActiveView')
      return { success: false, error: 'switch failed' }
    })

    const result = await invokeCreateWebTab({
      spaceId: 'space-1',
      url: 'https://example.com/',
      title: 'Example',
    })

    expect(result).toMatchObject({ success: false, error: 'switch failed' })
    const viewId = mocks.createView.mock.calls[0]?.[0]
    expect(events).toEqual(['createView', 'setActiveView'])
    expect(mocks.closeCrawlspaceView).toHaveBeenCalledWith('cs-1', viewId)
    expect(mocks.closeTab).toHaveBeenCalledWith('space-1', `tabweb:${viewId}`)
    expect(mocks.setActiveKey).not.toHaveBeenCalled()
    expect(mocks.loadUrl).not.toHaveBeenCalled()
  })

  it('并发创建即使发生在同一毫秒也返回不同 viewId，较早 activation 被 supersede 不误报失败或删除', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
    const firstActivation = deferred<{ success: true }>()
    mocks.setActiveView.mockImplementation(async (_crawlspaceId: string, _viewId: string) => {
      events.push('setActiveView')
      if (mocks.setActiveView.mock.calls.length === 1) {
        return firstActivation.promise
      }
      return { success: true }
    })

    const first = invokeCreateWebTab({
      spaceId: 'space-1',
      url: 'https://a.example/',
      title: 'A',
    })
    const second = invokeCreateWebTab({
      spaceId: 'space-1',
      url: 'https://b.example/',
      title: 'B',
    })

    await Promise.resolve()
    await Promise.resolve()
    firstActivation.resolve({ success: true })
    const [firstResult, secondResult] = await Promise.all([first, second])

    expect(firstResult.success).toBe(true)
    expect(secondResult.success).toBe(true)
    const firstViewId = (firstResult.data as { viewId: string }).viewId
    const secondViewId = (secondResult.data as { viewId: string }).viewId
    expect(firstViewId).not.toBe(secondViewId)
    expect(mocks.closeCrawlspaceView).not.toHaveBeenCalled()
  })

  it('activation 失败且回滚返回 ok:false 时显式返回清理失败，不静默遗留空壳', async () => {
    mocks.setActiveView.mockImplementation(async () => {
      events.push('setActiveView')
      return { success: false, error: 'switch failed' }
    })
    mocks.closeCrawlspaceView.mockResolvedValue({
      ok: false,
      code: 'ipc_close_failed',
      message: 'close failed',
    })

    const result = await invokeCreateWebTab({
      spaceId: 'space-1',
      url: 'https://example.com/',
      title: 'Example',
    })

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining('close failed'),
    })
    expect(mocks.closeTab).not.toHaveBeenCalled()
  })
})

describe('invokeCreateWebTab webview 后台挂载（ 创建即有进程）', () => {
  it('webview 模式：创建成功后立即在隐藏层挂载 guest（对齐 WCV 契约）', async () => {
    mocks.webviewContainerEnabled.current = true
    mocks.getCrawlspaceConfig.mockReturnValue({
      profile: 'agent-workspace',
      partition: 'persist:agent-workspace',
    })

    const result = await invokeCreateWebTab({
      spaceId: 'space-1',
      runId: 'run-1',
      url: 'https://example.com/',
      title: 'Example',
    })

    expect(result.success).toBe(true)
    const viewId = (result.data as { viewId: string }).viewId
    expect(mocks.getCrawlspaceConfig).toHaveBeenCalledWith('cs-1')
    expect(mocks.createView).toHaveBeenCalledWith(
      viewId,
      'https://example.com/',
      'run-1',
      'Example',
      undefined,
      undefined,
    )
    expect(mocks.webviewEnsure).toHaveBeenCalledWith(viewId, {
      url: 'https://example.com/',
      profile: 'agent-workspace',
      partition: 'persist:agent-workspace',
      crawlspaceId: 'cs-1',
      kind: 'workspace-view',
      isPreview: false,
      runId: 'run-1',
    })
    expect(mocks.webviewActivateKnownRun).toHaveBeenCalledWith(viewId)
  })

  it('wcv 模式：不触发后台挂载（主进程 createView 已同步建 WebContents）', async () => {
    mocks.webviewContainerEnabled.current = false

    const result = await invokeCreateWebTab({
      spaceId: 'space-1',
      url: 'https://example.com/',
    })

    expect(result.success).toBe(true)
    expect(mocks.webviewEnsure).not.toHaveBeenCalled()
    expect(mocks.webviewActivateKnownRun).not.toHaveBeenCalled()
  })

  it('后台挂载失败不阻断创建（回落修复前行为：等显示时挂载）', async () => {
    mocks.webviewContainerEnabled.current = true
    mocks.getCrawlspaceConfig.mockReturnValue({
      profile: 'agent-workspace',
      partition: 'persist:agent-workspace',
    })
    mocks.webviewEnsure.mockRejectedValue(new Error('announce 被主进程拒绝'))

    const result = await invokeCreateWebTab({
      spaceId: 'space-1',
      url: 'https://example.com/',
    })

    expect(result.success).toBe(true)
    expect(mocks.webviewEnsure).toHaveBeenCalled()
  })

  it('缺少 crawlspace 配置时跳过挂载且创建不受影响', async () => {
    mocks.webviewContainerEnabled.current = true
    mocks.getCrawlspaceConfig.mockReturnValue(null)

    const result = await invokeCreateWebTab({
      spaceId: 'space-1',
      url: 'https://example.com/',
    })

    expect(result.success).toBe(true)
    expect(mocks.webviewEnsure).not.toHaveBeenCalled()
  })
})
