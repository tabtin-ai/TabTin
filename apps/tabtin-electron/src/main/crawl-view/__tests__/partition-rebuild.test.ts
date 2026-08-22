/**
 * Wave 3 partition 重建路径回归测试。
 *
 * 业务场景：用户改 Space → BrowserEnvironment 绑定后，已打开的 workspace
 * tab 的 `partition` 与新绑定不一致 —— 历史上返回 `partition mismatch for
 * workspace view` 红条；本地化退役 Wave 3 收尾后，主进程主动销毁旧 view +
 * 用新 partition 重建 + 广播 `crawl-view:partition-rebuilt` 让 renderer 弹
 * 友好 toast。
 *
 * 这条路径同时是 L-W2-4 启动期 view 焊死的最后兜底——镜像就绪后 listener
 * 重新调用 `crawl-view:show` 时会撞 partition mismatch 触发重建。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockGetViewState,
  mockDestroyView,
  mockShowEmbeddedView,
  mockHideEmbeddedView,
  mockSyncIgnoreMouse,
  mockGetOrCreateViewForTab,
  mockCleanupStaleView,
  mockGetMainWindow,
  mockMainWindowSend,
  mockGetCurrentTabId,
  mockGetCacheStats,
  mockGetAllTabsInfo,
  mockDestroyTabView,
  mockGetResourceManagerAccessor,
  mockReconcileOrphans,
  mockGetRunIdByView,
  mockGetView,
  mockScheduleFitToWidth,
} = vi.hoisted(() => ({
  mockGetViewState: vi.fn(),
  mockDestroyView: vi.fn(),
  mockShowEmbeddedView: vi.fn(),
  mockHideEmbeddedView: vi.fn(),
  mockSyncIgnoreMouse: vi.fn(),
  mockGetOrCreateViewForTab: vi.fn(),
  mockCleanupStaleView: vi.fn(),
  mockGetMainWindow: vi.fn(),
  mockMainWindowSend: vi.fn(),
  mockGetCurrentTabId: vi.fn(),
  mockGetCacheStats: vi.fn(() => ({ total: 0, max: 50, idle: 0, inUse: 0, current: null })),
  mockGetAllTabsInfo: vi.fn(() => []),
  mockDestroyTabView: vi.fn(),
  mockGetResourceManagerAccessor: vi.fn(() => null),
  mockReconcileOrphans: vi.fn(async () => ({ success: true, removed: 0 })),
  mockGetRunIdByView: vi.fn((): string | undefined => undefined),
  mockGetView: vi.fn(),
  mockScheduleFitToWidth: vi.fn(),
}))

const ipcHandlerMap = new Map<string, (...args: any[]) => any>()

// 多窗口广播测试需要 mock BrowserWindow.getAllWindows()，让我们能在 mock
// 里塞主窗口实例（含已销毁场景）。
const mockBrowserWindowList: Array<{ isDestroyed: () => boolean; webContents: { send: (...args: any[]) => void } }> = []

vi.mock('electron', () => ({
  app: { isPackaged: false },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: any[]) => any) => {
      ipcHandlerMap.set(channel, handler)
    }),
    removeHandler: vi.fn((channel: string) => {
      ipcHandlerMap.delete(channel)
    }),
  },
  BrowserWindow: {
    getAllWindows: () => mockBrowserWindowList,
  },
}))

vi.mock('../../view-factory', () => ({
  getViewFactory: () => ({
    getViewState: mockGetViewState,
    destroyView: mockDestroyView,
    getView: mockGetView,
    getWebContents: vi.fn(),
    hasView: vi.fn(),
    triggerCleanup: vi.fn(),
  }),
}))

vi.mock('../../utils/guarded-handle', () => ({
  // 直接转发到 ipcMain.handle，跳过 sender 信任校验（本测试用 makeTrustedEvent）
  createGuardedTrackHandle: (channels: string[]) => (channel: string, handler: any) => {
    channels.push(channel)
    ipcHandlerMap.set(channel, handler)
  },
}))

vi.mock('../../organization/OrganizationTabManager', () => ({
  getOrganizationTabManager: () => ({}),
}))

vi.mock('../../run-session/RunSessionManager', () => ({
  getRunSessionManager: () => ({
    getRunIdByView: mockGetRunIdByView,
  }),
}))

vi.mock('../reconcile-orphans', () => ({
  reconcileOrphans: mockReconcileOrphans,
}))

vi.mock('../navigation', () => ({
  goBack: vi.fn(),
  goForward: vi.fn(),
  reload: vi.fn(),
  stop: vi.fn(),
  getNavigationState: vi.fn(() => ({ canGoBack: false, canGoForward: false })),
}))

vi.mock('../content-ops', () => ({
  executeScript: vi.fn(),
  loadUrl: vi.fn(),
  waitForSelector: vi.fn(),
  screenshot: vi.fn(),
  getCDPEndpoint: vi.fn(),
  getWebContentsId: vi.fn(),
  getHTML: vi.fn(),
  getPageInfo: vi.fn(),
  getProcessedContent: vi.fn(),
}))

vi.mock('../utils', () => ({
  hasAliveWebContents: vi.fn(() => true),
  isAliveWebContents: vi.fn(() => true),
}))

vi.mock('../fit-to-width', () => ({
  markManualZoom: vi.fn(),
  scheduleFitToWidth: mockScheduleFitToWidth,
}))

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}))

import { initIpcHandlers, registerEmbeddedCrawlViewHandlers, unregisterAllIpcHandlers } from '../ipc-handlers'
import { BROWSER_VIEW_BORDER_RADIUS_PX } from '@shared/browser-viewport-constraints'

function makeTrustedEvent() {
  return {
    senderFrame: { url: 'file:///app/index.html' },
    sender: { id: 1 },
  }
}

describe('Wave 3 — crawl-view:show partition mismatch 主动重建', () => {
  beforeEach(() => {
    ipcHandlerMap.clear()
    mockBrowserWindowList.length = 0
    vi.clearAllMocks()
    mockShowEmbeddedView.mockResolvedValue(undefined)
    mockDestroyView.mockResolvedValue(undefined)
    mockGetRunIdByView.mockReturnValue(undefined)  // 默认无 active run
    mockGetView.mockReturnValue(undefined)
    mockGetMainWindow.mockReturnValue({
      isDestroyed: () => false,
      webContents: { send: mockMainWindowSend },
    })
    // 默认主窗口可用——broadcastBy default 包含主窗口
    mockBrowserWindowList.push({
      isDestroyed: () => false,
      webContents: { send: mockMainWindowSend },
    })

    initIpcHandlers({
      showEmbeddedView: mockShowEmbeddedView,
      hideEmbeddedView: mockHideEmbeddedView,
      destroyTabView: mockDestroyTabView,
      syncIgnoreMouseEventsForAttached: mockSyncIgnoreMouse,
      getOrCreateViewForTab: mockGetOrCreateViewForTab,
      cleanupStaleView: mockCleanupStaleView,
      getMainWindow: mockGetMainWindow,
      getCurrentTabId: mockGetCurrentTabId,
      getResourceManagerAccessor: mockGetResourceManagerAccessor,
      getCacheStats: mockGetCacheStats,
      getAllTabsInfo: mockGetAllTabsInfo,
    })
    registerEmbeddedCrawlViewHandlers()
  })

  afterEach(() => {
    unregisterAllIpcHandlers()
  })

  it('partition 不一致 → 销毁旧 view + 广播 partition-rebuilt + 重建 + 返回 rebuilt:true', async () => {
    mockGetViewState.mockReturnValue({
      config: {
        partition: 'persist:tabtin:env:default',
        metadata: { crawlspaceId: 'cs-1', kind: 'workspace-view' },
      },
    })

    const handler = ipcHandlerMap.get('crawl-view:show')
    expect(handler).toBeDefined()

    const result = await handler!(
      makeTrustedEvent(),
      'cs-1', // tabId（新接口风格）
      'https://baidu.com', // url
      { x: 0, y: 0, width: 100, height: 100 }, // bounds
      undefined, // runId
      {
        crawlspaceId: 'cs-1',
        kind: 'workspace-view',
        partition: 'persist:tabtin:env:work-uuid',
      },
    )

    expect(result).toEqual({ success: true, rebuilt: true })
    // 销毁旧 view，使用 force:true
    expect(mockDestroyView).toHaveBeenCalledWith('cs-1', { force: true })
    // 广播事件给主窗口让 renderer 弹 toast
    expect(mockMainWindowSend).toHaveBeenCalledWith('crawl-view:partition-rebuilt', {
      tabId: 'cs-1',
      oldPartition: 'persist:tabtin:env:default',
      newPartition: 'persist:tabtin:env:work-uuid',
      reason: 'env-binding-changed',
    })
    // 用新 partition 重建 view
    expect(mockShowEmbeddedView).toHaveBeenCalledTimes(1)
    const showArgs = mockShowEmbeddedView.mock.calls[0]
    expect(showArgs[4]).toMatchObject({ partition: 'persist:tabtin:env:work-uuid' })
  })

  it('partition 一致 → 不触发重建，正常 showEmbeddedView', async () => {
    mockGetViewState.mockReturnValue({
      config: {
        partition: 'persist:tabtin:env:default',
        metadata: { crawlspaceId: 'cs-1', kind: 'workspace-view' },
      },
    })

    const handler = ipcHandlerMap.get('crawl-view:show')
    const result = await handler!(
      makeTrustedEvent(),
      'cs-1',
      'https://baidu.com',
      { x: 0, y: 0, width: 100, height: 100 },
      undefined,
      {
        crawlspaceId: 'cs-1',
        kind: 'workspace-view',
        partition: 'persist:tabtin:env:default',
      },
    )

    expect(result).toEqual({ success: true })
    expect(mockDestroyView).not.toHaveBeenCalled()
    expect(mockMainWindowSend).not.toHaveBeenCalled()
    expect(mockShowEmbeddedView).toHaveBeenCalledTimes(1)
  })

  it('crawlspaceId 不一致仍然 hard error（数据完整性问题，不是合法 env 切换）', async () => {
    mockGetViewState.mockReturnValue({
      config: {
        partition: 'persist:tabtin:env:default',
        metadata: { crawlspaceId: 'cs-A', kind: 'workspace-view' },
      },
    })

    const handler = ipcHandlerMap.get('crawl-view:show')
    const result = await handler!(
      makeTrustedEvent(),
      'cs-A',
      'https://baidu.com',
      { x: 0, y: 0, width: 100, height: 100 },
      undefined,
      {
        crawlspaceId: 'cs-B', // 与 existing 的 cs-A 冲突
        kind: 'workspace-view',
        partition: 'persist:tabtin:env:default',
      },
    )

    expect(result).toEqual({
      success: false,
      error: 'crawlspaceId mismatch for workspace view',
    })
    expect(mockDestroyView).not.toHaveBeenCalled()
    expect(mockShowEmbeddedView).not.toHaveBeenCalled()
  })

  it('销毁旧 view 失败 → 返回 error 而非继续重建（避免后续 view-reuse 再撞一次）', async () => {
    mockGetViewState.mockReturnValue({
      config: {
        partition: 'persist:tabtin:env:default',
        metadata: { crawlspaceId: 'cs-1', kind: 'workspace-view' },
      },
    })
    mockDestroyView.mockRejectedValueOnce(new Error('view busy'))

    const handler = ipcHandlerMap.get('crawl-view:show')
    const result = await handler!(
      makeTrustedEvent(),
      'cs-1',
      'https://baidu.com',
      { x: 0, y: 0, width: 100, height: 100 },
      undefined,
      {
        crawlspaceId: 'cs-1',
        kind: 'workspace-view',
        partition: 'persist:tabtin:env:work-uuid',
      },
    )

    expect(result).toEqual({
      success: false,
      error: 'partition rebuild failed: view busy',
    })
    expect(mockShowEmbeddedView).not.toHaveBeenCalled()
    // 销毁失败不弹 toast（toast 应代表"成功完成切换"，半成品状态不应误导用户）
    expect(mockMainWindowSend).not.toHaveBeenCalledWith('crawl-view:partition-rebuilt', expect.anything())
    // B2：finally 仍发出 released 广播，但 actualPartition 仍是旧值（destroy 未成功）
    expect(mockMainWindowSend).toHaveBeenCalledWith('crawl-view:partition-rebuild-released', {
      tabId: 'cs-1',
      actualPartition: 'persist:tabtin:env:default',
    })
  })

  it('所有窗口都销毁时广播跳过，不影响重建主流程', async () => {
    mockGetViewState.mockReturnValue({
      config: {
        partition: 'persist:tabtin:env:default',
        metadata: { crawlspaceId: 'cs-1', kind: 'workspace-view' },
      },
    })
    // 把全部 BrowserWindow 标为已销毁
    mockBrowserWindowList.length = 0
    mockBrowserWindowList.push({
      isDestroyed: () => true,
      webContents: { send: mockMainWindowSend },
    })

    const handler = ipcHandlerMap.get('crawl-view:show')
    const result = await handler!(
      makeTrustedEvent(),
      'cs-1',
      'https://baidu.com',
      { x: 0, y: 0, width: 100, height: 100 },
      undefined,
      {
        crawlspaceId: 'cs-1',
        kind: 'workspace-view',
        partition: 'persist:tabtin:env:work-uuid',
      },
    )

    expect(result).toEqual({ success: true, rebuilt: true })
    // 所有窗口都销毁 → 没人 send
    expect(mockMainWindowSend).not.toHaveBeenCalled()
    expect(mockDestroyView).toHaveBeenCalled()
    expect(mockShowEmbeddedView).toHaveBeenCalled()
  })

  it('多 BrowserWindow 时广播给每个未销毁窗口', async () => {
    mockGetViewState.mockReturnValue({
      config: {
        partition: 'persist:tabtin:env:default',
        metadata: { crawlspaceId: 'cs-1', kind: 'workspace-view' },
      },
    })
    const send1 = vi.fn()
    const send2 = vi.fn()
    const send3 = vi.fn()
    mockBrowserWindowList.length = 0
    mockBrowserWindowList.push(
      { isDestroyed: () => false, webContents: { send: send1 } },
      { isDestroyed: () => true, webContents: { send: send2 } }, // 应跳过
      { isDestroyed: () => false, webContents: { send: send3 } },
    )

    const handler = ipcHandlerMap.get('crawl-view:show')
    const result = await handler!(
      makeTrustedEvent(),
      'cs-1',
      'https://baidu.com',
      { x: 0, y: 0, width: 100, height: 100 },
      undefined,
      {
        crawlspaceId: 'cs-1',
        kind: 'workspace-view',
        partition: 'persist:tabtin:env:work-uuid',
      },
    )

    expect(result).toEqual({ success: true, rebuilt: true })
    expect(send1).toHaveBeenCalledWith('crawl-view:partition-rebuilt', expect.objectContaining({
      tabId: 'cs-1', reason: 'env-binding-changed',
    }))
    expect(send2).not.toHaveBeenCalled()
    expect(send3).toHaveBeenCalledWith('crawl-view:partition-rebuilt', expect.objectContaining({
      tabId: 'cs-1',
    }))
  })

  it('showEmbeddedView 失败 → toast 不弹（保严格契约）', async () => {
    mockGetViewState.mockReturnValue({
      config: {
        partition: 'persist:tabtin:env:default',
        metadata: { crawlspaceId: 'cs-1', kind: 'workspace-view' },
      },
    })
    mockShowEmbeddedView.mockRejectedValueOnce(new Error('view init failed'))

    const handler = ipcHandlerMap.get('crawl-view:show')
    const result = await handler!(
      makeTrustedEvent(),
      'cs-1',
      'https://baidu.com',
      { x: 0, y: 0, width: 100, height: 100 },
      undefined,
      {
        crawlspaceId: 'cs-1',
        kind: 'workspace-view',
        partition: 'persist:tabtin:env:work-uuid',
      },
    )

    expect(result.success).toBe(false)
    expect(result.error).toContain('partition rebuild succeeded destroy but failed show')
    expect(result.rebuilt).toBe(true)
    // 关键契约：show 失败 → partition-rebuilt toast 不能弹（已经销毁旧 view 但新 view 没起，让用户感知失败）
    expect(mockMainWindowSend).not.toHaveBeenCalledWith('crawl-view:partition-rebuilt', expect.anything())
    expect(mockDestroyView).toHaveBeenCalled()
    // B2：finally 仍发出 released 广播，actualPartition 仍是旧值（show 失败未生效）
    expect(mockMainWindowSend).toHaveBeenCalledWith('crawl-view:partition-rebuild-released', {
      tabId: 'cs-1',
      actualPartition: 'persist:tabtin:env:default',
    })
  })

  it('同一 tabId 并发 partition rebuild → 第二次跳过返回 skipped', async () => {
    mockGetViewState.mockReturnValue({
      config: {
        partition: 'persist:tabtin:env:default',
        metadata: { crawlspaceId: 'cs-1', kind: 'workspace-view' },
      },
    })
    // showEmbeddedView 永不 resolve → 锁卡住第一次调用，让第二次撞锁
    const resolverRef: { current?: () => void } = {}
    mockShowEmbeddedView.mockImplementationOnce(() => new Promise<void>((r) => {
      resolverRef.current = r
    }))

    const handler = ipcHandlerMap.get('crawl-view:show')!
    const args: any[] = [
      makeTrustedEvent(),
      'cs-1',
      'https://baidu.com',
      { x: 0, y: 0, width: 100, height: 100 },
      undefined,
      {
        crawlspaceId: 'cs-1',
        kind: 'workspace-view',
        partition: 'persist:tabtin:env:work-uuid',
      },
    ]

    const firstPromise = handler!(...args)
    // 让第一次 promise 进 destroy → showEmbeddedView 阻塞
    await new Promise((r) => setImmediate(r))
    // 此时第二次 show 调用应该撞 _partitionRebuildInFlight 锁
    const secondResult = await handler!(...args)
    expect(secondResult).toEqual({ success: true, rebuilt: false, skipped: 'rebuild-in-flight' })

    // 释放第一次 show，让 firstPromise 完成
    if (!resolverRef.current) throw new Error('showEmbeddedView resolver was not captured')
    resolverRef.current()
    const firstResult = await firstPromise
    expect(firstResult).toEqual({ success: true, rebuilt: true })
  })

  it('无 existing view → 不走重建路径（first time show）', async () => {
    mockGetViewState.mockReturnValue(null)

    const handler = ipcHandlerMap.get('crawl-view:show')
    const result = await handler!(
      makeTrustedEvent(),
      'cs-1',
      'https://baidu.com',
      { x: 0, y: 0, width: 100, height: 100 },
      undefined,
      {
        crawlspaceId: 'cs-1',
        kind: 'workspace-view',
        partition: 'persist:tabtin:env:work-uuid',
      },
    )

    expect(result).toEqual({ success: true })
    expect(mockDestroyView).not.toHaveBeenCalled()
    expect(mockMainWindowSend).not.toHaveBeenCalled()
    expect(mockShowEmbeddedView).toHaveBeenCalledTimes(1)
  })

  it('setViewBounds 同步更新 bounds 并应用原生圆角', async () => {
    const bounds = { x: 4, y: 10, width: 792, height: 560 }
    const view = {
      setBounds: vi.fn(),
      setBorderRadius: vi.fn(),
      getBounds: vi.fn(() => bounds),
    }
    mockGetView.mockReturnValue(view)

    const handler = ipcHandlerMap.get('crawl-view:setViewBounds')
    expect(handler).toBeDefined()

    const result = await handler!(makeTrustedEvent(), 'view-1', bounds)

    expect(result).toEqual({ success: true, requested: bounds, applied: bounds })
    expect(view.setBounds).toHaveBeenCalledWith(bounds)
    expect(view.setBorderRadius).toHaveBeenCalledWith(BROWSER_VIEW_BORDER_RADIUS_PX)
    expect(mockScheduleFitToWidth).toHaveBeenCalledWith('view-1')
  })

  // ── B1 守卫：Agent run 期间不打断 view ──
  describe('Wave 3 B1 — active run 守卫', () => {
    it('view 绑定 active run → 拒绝重建，返回 deferred', async () => {
      mockGetViewState.mockReturnValue({
        config: {
          partition: 'persist:tabtin:env:default',
          metadata: { crawlspaceId: 'cs-1', kind: 'workspace-view' },
        },
      })
      mockGetRunIdByView.mockReturnValue('run-active-123')

      const handler = ipcHandlerMap.get('crawl-view:show')
      const result = await handler!(
        makeTrustedEvent(),
        'cs-1',
        'https://baidu.com',
        { x: 0, y: 0, width: 100, height: 100 },
        undefined,
        {
          crawlspaceId: 'cs-1',
          kind: 'workspace-view',
          partition: 'persist:tabtin:env:work-uuid',
        },
      )

      expect(result).toEqual({
        success: true,
        rebuilt: false,
        deferred: 'run-in-progress',
        activeRunId: 'run-active-123',
      })
      // 不 destroy / 不 show / 不广播任何事件 —— Agent run 完整性优先
      expect(mockDestroyView).not.toHaveBeenCalled()
      expect(mockShowEmbeddedView).not.toHaveBeenCalled()
      expect(mockMainWindowSend).not.toHaveBeenCalled()
    })

    it('view 无 active run → 正常进入重建路径（守卫放行）', async () => {
      mockGetViewState.mockReturnValue({
        config: {
          partition: 'persist:tabtin:env:default',
          metadata: { crawlspaceId: 'cs-1', kind: 'workspace-view' },
        },
      })
      mockGetRunIdByView.mockReturnValue(undefined)

      const handler = ipcHandlerMap.get('crawl-view:show')
      const result = await handler!(
        makeTrustedEvent(),
        'cs-1',
        'https://baidu.com',
        { x: 0, y: 0, width: 100, height: 100 },
        undefined,
        {
          crawlspaceId: 'cs-1',
          kind: 'workspace-view',
          partition: 'persist:tabtin:env:work-uuid',
        },
      )

      expect(result).toEqual({ success: true, rebuilt: true })
      expect(mockDestroyView).toHaveBeenCalled()
    })
  })

  // ── B2 收敛广播：锁释放时主动通知 renderer ──
  describe('Wave 3 B2 — partition-rebuild-released 广播', () => {
    it('重建成功 → 广播 released, actualPartition = newPartition', async () => {
      mockGetViewState.mockReturnValue({
        config: {
          partition: 'persist:tabtin:env:default',
          metadata: { crawlspaceId: 'cs-1', kind: 'workspace-view' },
        },
      })

      const handler = ipcHandlerMap.get('crawl-view:show')
      await handler!(
        makeTrustedEvent(),
        'cs-1',
        'https://baidu.com',
        { x: 0, y: 0, width: 100, height: 100 },
        undefined,
        {
          crawlspaceId: 'cs-1',
          kind: 'workspace-view',
          partition: 'persist:tabtin:env:work-uuid',
        },
      )

      // 同一个窗口收到两条广播：rebuilt + released
      expect(mockMainWindowSend).toHaveBeenCalledWith('crawl-view:partition-rebuilt', expect.objectContaining({
        tabId: 'cs-1', newPartition: 'persist:tabtin:env:work-uuid',
      }))
      expect(mockMainWindowSend).toHaveBeenCalledWith('crawl-view:partition-rebuild-released', {
        tabId: 'cs-1',
        actualPartition: 'persist:tabtin:env:work-uuid',
      })
    })

    it('skipped 路径下被锁住的请求自身不广播；锁释放后第一次 finally 广播一次', async () => {
      mockGetViewState.mockReturnValue({
        config: {
          partition: 'persist:tabtin:env:default',
          metadata: { crawlspaceId: 'cs-1', kind: 'workspace-view' },
        },
      })
      const resolverRef: { current?: () => void } = {}
      mockShowEmbeddedView.mockImplementationOnce(() => new Promise<void>((r) => {
        resolverRef.current = r
      }))

      const handler = ipcHandlerMap.get('crawl-view:show')
      const args: any[] = [
        makeTrustedEvent(),
        'cs-1',
        'https://baidu.com',
        { x: 0, y: 0, width: 100, height: 100 },
        undefined,
        {
          crawlspaceId: 'cs-1',
          kind: 'workspace-view',
          partition: 'persist:tabtin:env:work-uuid',
        },
      ]

      const firstPromise = handler!(...args)
      await new Promise((r) => setImmediate(r))
      const secondResult = await handler!(...args)
      expect(secondResult).toEqual({ success: true, rebuilt: false, skipped: 'rebuild-in-flight' })
      // 第二次 skipped 自身不广播 released
      expect(mockMainWindowSend).not.toHaveBeenCalledWith(
        'crawl-view:partition-rebuild-released',
        expect.anything(),
      )

      // 释放第一次 → finally 块发 released
      if (!resolverRef.current) throw new Error('showEmbeddedView resolver was not captured')
      resolverRef.current()
      await firstPromise

      expect(mockMainWindowSend).toHaveBeenCalledWith('crawl-view:partition-rebuild-released', {
        tabId: 'cs-1',
        actualPartition: 'persist:tabtin:env:work-uuid',
      })
    })

    it('多窗口场景下 released 广播也分发给每个未销毁窗口', async () => {
      mockGetViewState.mockReturnValue({
        config: {
          partition: 'persist:tabtin:env:default',
          metadata: { crawlspaceId: 'cs-1', kind: 'workspace-view' },
        },
      })
      const sendA = vi.fn()
      const sendB = vi.fn()
      mockBrowserWindowList.length = 0
      mockBrowserWindowList.push(
        { isDestroyed: () => false, webContents: { send: sendA } },
        { isDestroyed: () => false, webContents: { send: sendB } },
      )

      const handler = ipcHandlerMap.get('crawl-view:show')
      await handler!(
        makeTrustedEvent(),
        'cs-1',
        'https://baidu.com',
        { x: 0, y: 0, width: 100, height: 100 },
        undefined,
        {
          crawlspaceId: 'cs-1',
          kind: 'workspace-view',
          partition: 'persist:tabtin:env:work-uuid',
        },
      )

      expect(sendA).toHaveBeenCalledWith('crawl-view:partition-rebuild-released', expect.objectContaining({
        tabId: 'cs-1',
      }))
      expect(sendB).toHaveBeenCalledWith('crawl-view:partition-rebuild-released', expect.objectContaining({
        tabId: 'cs-1',
      }))
    })
  })
})
