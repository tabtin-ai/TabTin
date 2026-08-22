/**
 * ViewStateRegistry 单元测试
 *
 * 覆盖核心状态管理路径：register / unregister / updateState / periodicCleanup
 * 以及查询接口：hasView / getState / getAllStates / findByMode / findByOwner
 *
 * 使用 vi.mock 隔离 Electron 和 autofill-service 依赖。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mocks — 必须在 import 目标模块之前声明
// ---------------------------------------------------------------------------

const faviconResolverMock = vi.hoisted(() => ({
  resolve: vi.fn(),
}))

vi.mock('electron', () => ({
  webContents: { fromId: vi.fn() },
  nativeTheme: { shouldUseDarkColors: false },
}))

vi.mock('../../credential-vault/autofill-service', () => ({
  onViewDomReady: vi.fn(),
}))

vi.mock('../favicon-resolver', () => ({
  getFaviconResolver: () => faviconResolverMock,
}))

vi.mock('../../services/AppDiscoveryService', () => ({
  getAppDiscoveryService: () => ({ checkUrl: vi.fn() }),
}))

// ---------------------------------------------------------------------------
// 被测模块
// ---------------------------------------------------------------------------

import { ViewStateRegistry } from '../ViewStateRegistry'
import type { ViewState } from '../ViewStateRegistryTypes'

// ---------------------------------------------------------------------------
// 工厂函数
// ---------------------------------------------------------------------------

function makeWebContents(overrides?: Partial<{
  isDestroyed: () => boolean
  getURL: () => string
  getTitle: () => string
  isLoading: () => boolean
  executeJavaScript: (code: string) => Promise<unknown>
}>) {
  return {
    isDestroyed: vi.fn().mockReturnValue(false),
    getURL: vi.fn().mockReturnValue('https://example.com'),
    getTitle: vi.fn().mockReturnValue('Example'),
    isLoading: vi.fn().mockReturnValue(false),
    executeJavaScript: vi.fn().mockResolvedValue(false),
    on: vi.fn(),
    off: vi.fn(),
    removeListener: vi.fn(),
    once: vi.fn(),
    ...overrides,
  }
}

// : register 参数已从 WebContentsView 收窄为 WebContents，
// mock 不再包 { webContents } 外壳，直接传 webContents mock。
function asRegistryWebContents(webContents = makeWebContents()) {
  return webContents as any
}

function makeInitialState(overrides?: Partial<ViewState>): Partial<ViewState> {
  return {
    url: 'https://example.com',
    status: 'idle',
    mode: 'preview',
    owner: 'shared',
    lastLoadTime: 0,
    loadHistory: [],
    reusable: true,
    metadata: { createdBy: 'test', createdAt: Date.now() },
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// 测试套件
// ---------------------------------------------------------------------------

describe('ViewStateRegistry', () => {
  let registry: ViewStateRegistry

  beforeEach(() => {
    // 强制重置单例以确保测试隔离
    faviconResolverMock.resolve.mockResolvedValue('https://example.com/favicon.ico')
    ;(ViewStateRegistry as any).instance = null
    registry = ViewStateRegistry.getInstance()
    vi.useFakeTimers()
  })

  afterEach(() => {
    registry.shutdown()
    ;(ViewStateRegistry as any).instance = null
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  // ==================== getInstance ====================

  describe('getInstance', () => {
    it('返回同一单例实例', () => {
      const a = ViewStateRegistry.getInstance()
      const b = ViewStateRegistry.getInstance()
      expect(a).toBe(b)
    })
  })

  // ==================== register ====================

  describe('register', () => {
    it('注册后 hasView 返回 true', () => {
      const view = asRegistryWebContents()
      registry.register('v1', view, makeInitialState())
      expect(registry.hasView('v1')).toBe(true)
    })

    it('注册后 getState 返回正确 URL', () => {
      const view = asRegistryWebContents()
      registry.register('v1', view, makeInitialState({ url: 'https://example.com/page' }))
      expect(registry.getState('v1')?.url).toBe('https://example.com/page')
    })

    it('注册后 mode 字段正确', () => {
      const view = asRegistryWebContents()
      registry.register('v1', view, makeInitialState({ mode: 'task' }))
      expect(registry.getState('v1')?.mode).toBe('task')
    })

    it('重复注册同一 ID 时自动先注销旧状态再注册新状态', () => {
      const view1 = asRegistryWebContents()
      const view2 = asRegistryWebContents()
      registry.register('v1', view1, makeInitialState({ url: 'https://old.com' }))
      registry.register('v1', view2, makeInitialState({ url: 'https://new.com' }))
      expect(registry.getState('v1')?.url).toBe('https://new.com')
    })

    it('注册时触发 view:registered 事件', () => {
      const handler = vi.fn()
      registry.on('view:registered', handler)
      const view = asRegistryWebContents()
      registry.register('v1', view, makeInitialState())
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ id: 'v1' }))
    })
  })

  // ==================== unregister ====================

  describe('unregister', () => {
    it('注销后 hasView 返回 false', () => {
      const view = asRegistryWebContents()
      registry.register('v1', view, makeInitialState())
      registry.unregister('v1')
      expect(registry.hasView('v1')).toBe(false)
    })

    it('注销不存在的 ID 不抛出错误', () => {
      expect(() => registry.unregister('nonexistent')).not.toThrow()
    })

    it('注销时触发 view:unregistered 事件', () => {
      const handler = vi.fn()
      registry.on('view:unregistered', handler)
      const view = asRegistryWebContents()
      registry.register('v1', view, makeInitialState())
      registry.unregister('v1')
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ id: 'v1' }))
    })

    it('注销后 getAllStates 中不再包含该条目', () => {
      const view = asRegistryWebContents()
      registry.register('v1', view, makeInitialState())
      registry.unregister('v1')
      expect(registry.getAllStates().has('v1')).toBe(false)
    })
  })

  // ==================== updateState ====================

  describe('updateState', () => {
    it('更新 status 字段', () => {
      const view = asRegistryWebContents()
      registry.register('v1', view, makeInitialState({ status: 'idle' }))
      registry.updateState('v1', { status: 'loaded' })
      expect(registry.getState('v1')?.status).toBe('loaded')
    })

    it('更新 url 字段', () => {
      const view = asRegistryWebContents()
      registry.register('v1', view, makeInitialState())
      registry.updateState('v1', { url: 'https://updated.com' })
      expect(registry.getState('v1')?.url).toBe('https://updated.com')
    })

    it('触发 view:updated 事件', () => {
      const handler = vi.fn()
      registry.on('view:updated', handler)
      const view = asRegistryWebContents()
      registry.register('v1', view, makeInitialState())
      registry.updateState('v1', { status: 'loading' })
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ id: 'v1' }))
    })

    it('status 变更时触发 state:changed 事件', () => {
      const handler = vi.fn()
      registry.on('state:changed', handler)
      const view = asRegistryWebContents()
      registry.register('v1', view, makeInitialState({ status: 'idle' }))
      registry.updateState('v1', { status: 'loaded' })
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ id: 'v1' }))
    })

    it('status 未变更时不触发 state:changed', () => {
      const handler = vi.fn()
      registry.on('state:changed', handler)
      const view = asRegistryWebContents()
      registry.register('v1', view, makeInitialState({ status: 'idle' }))
      registry.updateState('v1', { url: 'https://no-status-change.com' })
      expect(handler).not.toHaveBeenCalled()
    })

    it('子 frame 加载失败不会把 View 状态升级为 error', () => {
      const webContents = makeWebContents()
      registry.register('v1', asRegistryWebContents(webContents), makeInitialState({ status: 'loaded' }))
      const errorHandler = vi.fn()
      registry.on('view:error', errorHandler)
      const failLoad = webContents.on.mock.calls.find(([event]) => event === 'did-fail-load')?.[1]

      failLoad({}, -100, 'ERR_CONNECTION_CLOSED', 'https://ads.example.test/sync.html', false, 42, 84)

      expect(registry.getState('v1')?.status).toBe('loaded')
      expect(errorHandler).not.toHaveBeenCalled()
    })

    it('主文档加载失败仍把 View 状态升级为 error', () => {
      const webContents = makeWebContents()
      registry.register('v1', asRegistryWebContents(webContents), makeInitialState({ status: 'loaded' }))
      const errorHandler = vi.fn()
      registry.on('view:error', errorHandler)
      const failLoad = webContents.on.mock.calls.find(([event]) => event === 'did-fail-load')?.[1]

      failLoad({}, -100, 'ERR_CONNECTION_CLOSED', 'https://example.com', true, 42, 84)

      expect(registry.getState('v1')?.status).toBe('error')
      expect(errorHandler).toHaveBeenCalledWith({
        id: 'v1',
        errorCode: -100,
        errorDescription: 'ERR_CONNECTION_CLOSED',
      })
    })

    it.each([404, 500])('主文档 HTTP %s 有可见内容时保留站点页面', async (statusCode) => {
      const executeJavaScript = vi.fn().mockResolvedValue(true)
      const webContents = makeWebContents({
        executeJavaScript,
        getURL: vi.fn().mockReturnValue('https://example.com/missing'),
      })
      registry.register('v1', asRegistryWebContents(webContents), makeInitialState({ status: 'loading' }))
      const errorHandler = vi.fn()
      registry.on('view:error', errorHandler)
      const frameNavigate = webContents.on.mock.calls.find(([event]) => event === 'did-frame-navigate')?.[1]
      const finishLoad = webContents.on.mock.calls.find(([event]) => event === 'did-finish-load')?.[1]

      frameNavigate({}, 'https://example.com/missing', statusCode, 'HTTP error', true, 1, 1)
      finishLoad()
      await Promise.resolve()

      expect(executeJavaScript).toHaveBeenCalledTimes(1)
      expect(registry.getState('v1')?.status).toBe('loaded')
      expect(errorHandler).not.toHaveBeenCalled()
    })

    it.each([
      { statusCode: 404, probe: () => Promise.resolve(false) },
      { statusCode: 503, probe: () => Promise.resolve(false) },
      { statusCode: 404, probe: () => Promise.reject(new Error('probe failed')) },
    ])('HTTP $statusCode 没有可见内容时使用 TabWeb 兜底', async ({ statusCode, probe }) => {
      const executeJavaScript = vi.fn().mockImplementation(probe)
      const webContents = makeWebContents({
        executeJavaScript,
        getURL: vi.fn().mockReturnValue('https://example.com/missing'),
      })
      registry.register('v1', asRegistryWebContents(webContents), makeInitialState({ status: 'loading' }))
      const errorHandler = vi.fn()
      registry.on('view:error', errorHandler)
      const frameNavigate = webContents.on.mock.calls.find(([event]) => event === 'did-frame-navigate')?.[1]
      const finishLoad = webContents.on.mock.calls.find(([event]) => event === 'did-finish-load')?.[1]

      frameNavigate({}, 'https://example.com/missing', statusCode, 'HTTP error', true, 1, 1)
      finishLoad()
      await Promise.resolve()
      await Promise.resolve()

      expect(executeJavaScript).toHaveBeenCalledTimes(1)
      expect(registry.getState('v1')?.status).toBe('error')
      expect(registry.getState('v1')?.lastErrorDescription).toBe(`HTTP ${statusCode}`)
      expect(errorHandler).toHaveBeenCalledWith({
        id: 'v1',
        errorCode: statusCode,
        errorDescription: `HTTP ${statusCode}`,
      })
    })

    it('子 frame HTTP >=400 不改变主页面状态', () => {
      const webContents = makeWebContents()
      registry.register('v1', asRegistryWebContents(webContents), makeInitialState({ status: 'loaded' }))
      const errorHandler = vi.fn()
      registry.on('view:error', errorHandler)
      const frameNavigate = webContents.on.mock.calls.find(([event]) => event === 'did-frame-navigate')?.[1]

      frameNavigate({}, 'https://ads.example.test/x', 404, 'Not Found', false, 1, 1)

      expect(registry.getState('v1')?.status).toBe('loaded')
      expect(errorHandler).not.toHaveBeenCalled()
    })

    it('HTTP 403 保持现有立即错误处理且不探测页面内容', () => {
      const executeJavaScript = vi.fn().mockResolvedValue(true)
      const webContents = makeWebContents({ executeJavaScript })
      registry.register('v1', asRegistryWebContents(webContents), makeInitialState({ status: 'loading' }))
      const errorHandler = vi.fn()
      registry.on('view:error', errorHandler)
      const frameNavigate = webContents.on.mock.calls.find(([event]) => event === 'did-frame-navigate')?.[1]

      frameNavigate({}, 'https://example.com/forbidden', 403, 'Forbidden', true, 1, 1)

      expect(registry.getState('v1')?.status).toBe('error')
      expect(errorHandler).toHaveBeenCalledWith({
        id: 'v1',
        errorCode: 403,
        errorDescription: 'HTTP 403',
      })
      expect(executeJavaScript).not.toHaveBeenCalled()
    })

    it('主文档 HTTP <400 不标记 error', () => {
      const webContents = makeWebContents()
      registry.register('v1', asRegistryWebContents(webContents), makeInitialState({ status: 'loading' }))
      const errorHandler = vi.fn()
      registry.on('view:error', errorHandler)
      const frameNavigate = webContents.on.mock.calls.find(([event]) => event === 'did-frame-navigate')?.[1]

      frameNavigate({}, 'https://example.com/', 200, 'OK', true, 1, 1)

      expect(registry.getState('v1')?.status).toBe('loading')
      expect(errorHandler).not.toHaveBeenCalled()
    })

    it('HTTP 200 不探测页面内容', () => {
      const executeJavaScript = vi.fn().mockResolvedValue(false)
      const webContents = makeWebContents({ executeJavaScript })
      registry.register('v1', asRegistryWebContents(webContents), makeInitialState({ status: 'loading' }))
      const frameNavigate = webContents.on.mock.calls.find(([event]) => event === 'did-frame-navigate')?.[1]
      const finishLoad = webContents.on.mock.calls.find(([event]) => event === 'did-finish-load')?.[1]

      frameNavigate({}, 'https://example.com/', 200, 'OK', true, 1, 1)
      finishLoad()

      expect(registry.getState('v1')?.status).toBe('loaded')
      expect(executeJavaScript).not.toHaveBeenCalled()
    })

    it('旧 HTTP 探测结果不会污染同 URL 的新一轮导航', async () => {
      let resolveProbe: ((value: boolean) => void) | undefined
      const probe = new Promise<boolean>((resolve) => {
        resolveProbe = resolve
      })
      const executeJavaScript = vi.fn().mockReturnValue(probe)
      const webContents = makeWebContents({ executeJavaScript })
      registry.register('v1', asRegistryWebContents(webContents), makeInitialState({ status: 'loading' }))
      const errorHandler = vi.fn()
      registry.on('view:error', errorHandler)
      const frameNavigate = webContents.on.mock.calls.find(([event]) => event === 'did-frame-navigate')?.[1]
      const finishLoad = webContents.on.mock.calls.find(([event]) => event === 'did-finish-load')?.[1]
      const startLoad = webContents.on.mock.calls.find(([event]) => event === 'did-start-loading')?.[1]

      frameNavigate({}, 'https://example.com/missing', 404, 'Not Found', true, 1, 1)
      finishLoad()
      startLoad()
      resolveProbe?.(false)
      await Promise.resolve()
      await Promise.resolve()

      expect(errorHandler).not.toHaveBeenCalled()
      expect(registry.getState('v1')?.status).toBe('loading')
    })

    it('更新不存在的 View 时不抛出错误', () => {
      expect(() => registry.updateState('ghost', { status: 'loaded' })).not.toThrow()
    })

    it('主文档跨站导航开始时会清空旧 favicon，避免新 URL 沿用上一站图标', () => {
      const webContents = makeWebContents()
      const view = asRegistryWebContents(webContents)
      registry.register('v1', view, makeInitialState({
        url: 'https://www.baidu.com',
      }))
      registry.updateState('v1', { favicon: 'https://www.baidu.com/favicon.ico' })

      const handler = vi.fn()
      registry.on('view:updated', handler)
      const willNavigate = webContents.on.mock.calls.find(([event]) => event === 'will-navigate')?.[1]

      willNavigate({}, 'https://www.xiaohongshu.com/explore')

      const lastUpdate = handler.mock.calls.at(-1)?.[0]?.updates
      expect(registry.getState('v1')).toMatchObject({
        url: 'https://www.xiaohongshu.com/explore',
        favicon: undefined,
      })
      expect(Object.prototype.hasOwnProperty.call(lastUpdate, 'favicon')).toBe(true)
      expect(lastUpdate).toMatchObject({
        url: 'https://www.xiaohongshu.com/explore',
        favicon: undefined,
      })
    })

    it('同站点导航保留当前 favicon', () => {
      let currentUrl = 'https://www.xiaohongshu.com/explore'
      const webContents = makeWebContents({
        getURL: () => currentUrl,
      })
      const view = asRegistryWebContents(webContents)
      registry.register('v1', view, makeInitialState({
        url: currentUrl,
      }))
      registry.updateState('v1', { favicon: 'https://www.xiaohongshu.com/favicon.ico' })

      const handler = vi.fn()
      registry.on('view:updated', handler)
      const willNavigate = webContents.on.mock.calls.find(([event]) => event === 'will-navigate')?.[1]

      currentUrl = 'https://www.xiaohongshu.com/search'
      willNavigate({}, 'https://www.xiaohongshu.com/search')

      const lastUpdate = handler.mock.calls.at(-1)?.[0]?.updates
      expect(registry.getState('v1')).toMatchObject({
        url: 'https://www.xiaohongshu.com/search',
        favicon: 'https://www.xiaohongshu.com/favicon.ico',
      })
      expect(Object.prototype.hasOwnProperty.call(lastUpdate, 'favicon')).toBe(false)
    })

    it('旧页面 favicon 异步解析完成时不会覆盖已导航到的新页面', async () => {
      let currentUrl = 'https://www.baidu.com'
      let resolveFavicon!: (value: string | null) => void
      faviconResolverMock.resolve.mockReturnValue(new Promise(resolve => {
        resolveFavicon = resolve
      }))
      const view = asRegistryWebContents(makeWebContents({
        getURL: () => currentUrl,
        isLoading: () => false,
      }))
      registry.register('v1', view, makeInitialState({ url: currentUrl }))
      expect(faviconResolverMock.resolve).toHaveBeenCalledWith(expect.objectContaining({
        pageUrl: 'https://www.baidu.com',
      }))

      currentUrl = 'https://www.xiaohongshu.com/explore'
      registry.updateState('v1', { url: currentUrl })
      resolveFavicon('data:image/png;base64,baidu')
      await Promise.resolve()

      expect(registry.getState('v1')?.url).toBe('https://www.xiaohongshu.com/explore')
      expect(registry.getState('v1')?.favicon).toBeUndefined()
    })

    it('registry URL 已切换但 webContents 仍短暂停在旧页时也会拦截旧 favicon', async () => {
      let resolveFavicon!: (value: string | null) => void
      faviconResolverMock.resolve.mockReturnValue(new Promise(resolve => {
        resolveFavicon = resolve
      }))
      const view = asRegistryWebContents(makeWebContents({
        getURL: () => 'https://www.baidu.com',
        isLoading: () => false,
      }))
      registry.register('v1', view, makeInitialState({ url: 'https://www.baidu.com' }))

      registry.updateState('v1', { url: 'https://www.xiaohongshu.com/explore' })
      resolveFavicon('data:image/png;base64,baidu')
      await Promise.resolve()

      expect(registry.getState('v1')?.url).toBe('https://www.xiaohongshu.com/explore')
      expect(registry.getState('v1')?.favicon).toBeUndefined()
    })
  })

  // ==================== 查询接口 ====================

  describe('查询接口', () => {
    beforeEach(() => {
      const viewA = asRegistryWebContents()
      const viewB = asRegistryWebContents()
      const viewC = asRegistryWebContents()
      registry.register('a', viewA, makeInitialState({ mode: 'task', owner: 'embedded-crawl-view' }))
      registry.register('b', viewB, makeInitialState({ mode: 'preview', owner: 'shared' }))
      registry.register('c', viewC, makeInitialState({ mode: 'task', owner: 'electron-launcher' }))
    })

    it('findByMode 返回指定 mode 的 View', () => {
      const results = registry.findByMode('task')
      expect(results.map(s => s.id).sort()).toEqual(['a', 'c'])
    })

    it('findByOwner 返回指定 owner 的 View', () => {
      const results = registry.findByOwner('shared')
      expect(results.map(s => s.id)).toEqual(['b'])
    })

    it('getAllStates 返回全部注册的 View', () => {
      expect(registry.getAllStates().size).toBe(3)
    })
  })

  // ==================== cleanupOrphans (RF04) ====================

  describe('cleanupOrphans（孤儿清理）', () => {
    it('存活的 WebContents 不会被清理', () => {
      const view = asRegistryWebContents()
      registry.register('fresh', view, makeInitialState())

      const removed = registry.cleanupOrphans()

      expect(removed).toEqual([])
      expect(registry.hasView('fresh')).toBe(true)
    })

    it('已销毁的 WebContents 立即被移除并返回 id 列表', () => {
      const destroyedWc = makeWebContents({ isDestroyed: () => true })
      const view = asRegistryWebContents(destroyedWc)
      registry.register('stale', view, makeInitialState())

      const handler = vi.fn()
      registry.on('view:unregistered', handler)

      const removed = registry.cleanupOrphans()

      expect(removed).toEqual(['stale'])
      expect(registry.hasView('stale')).toBe(false)
      expect(handler).toHaveBeenCalledTimes(1)
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ id: 'stale' }))
    })

    it('混合存活与已销毁的 View 只清理已销毁的', () => {
      const alive = asRegistryWebContents()
      const destroyedWc = makeWebContents({ isDestroyed: () => true })
      const dead = asRegistryWebContents(destroyedWc)
      registry.register('alive-1', alive, makeInitialState())
      registry.register('dead-1', dead, makeInitialState())

      const removed = registry.cleanupOrphans()

      expect(removed).toEqual(['dead-1'])
      expect(registry.hasView('alive-1')).toBe(true)
      expect(registry.hasView('dead-1')).toBe(false)
    })

    it('提前 unregister 的 View 不会被重复清理', () => {
      const destroyedWc = makeWebContents({ isDestroyed: () => true })
      const view = asRegistryWebContents(destroyedWc)
      registry.register('v1', view, makeInitialState())

      registry.unregister('v1')
      const removed = registry.cleanupOrphans()

      expect(removed).toEqual([])
      expect(registry.hasView('v1')).toBe(false)
    })
  })

  // ==================== touch (VL-009) ====================

  describe('touch', () => {
    it('VL-009 回归: touch 应更新 lastAccessTime 并触发 view:touched 事件', () => {
      const handler = vi.fn()
      registry.on('view:touched', handler)
      const view = asRegistryWebContents()
      registry.register('v1', view, makeInitialState())

      const before = Date.now()
      registry.touch('v1')
      const after = Date.now()

      const state = registry.getState('v1')!
      expect(state.lastAccessTime).toBeGreaterThanOrEqual(before)
      expect(state.lastAccessTime).toBeLessThanOrEqual(after)
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'v1', lastAccessTime: state.lastAccessTime })
      )
    })

    it('touch 不存在的 View 不触发事件', () => {
      const handler = vi.fn()
      registry.on('view:touched', handler)
      registry.touch('nonexistent')
      expect(handler).not.toHaveBeenCalled()
    })
  })

  // ==================== shutdown ====================

  describe('shutdown', () => {
    it('shutdown 后所有状态被清空', () => {
      const view = asRegistryWebContents()
      registry.register('v1', view, makeInitialState())
      registry.shutdown()
      expect(registry.getAllStates().size).toBe(0)
    })
  })

  // ==================== getMetrics ====================

  describe('getMetrics', () => {
    it('注册后 statesCount 增加', () => {
      const view = asRegistryWebContents()
      registry.register('v1', view, makeInitialState())
      const metrics = registry.getMetrics()
      expect(metrics.statesCount).toBe(1)
    })
  })
})
