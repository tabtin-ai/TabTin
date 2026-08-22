import { EventEmitter } from 'node:events'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  nativeTheme: {
    on: vi.fn(),
    removeListener: vi.fn(),
  },
  runSessionManager: {
    getRunIdByView: vi.fn(() => null),
    addObservation: vi.fn(),
  },
  eventBridge: {
    push: vi.fn(),
  },
  faviconResolver: {
    resolve: vi.fn(() => Promise.resolve(null)),
  },
  extractThemeColor: vi.fn(async (webContents: { getURL: () => string }) => ({
    color: webContents.getURL().includes('view-1') ? '#111111' : '#222222',
    source: 'meta',
  })),
}))

vi.mock('electron', () => ({
  BrowserWindow: class {},
  app: { isPackaged: true },
  nativeTheme: mocks.nativeTheme,
}))

vi.mock('./run-session/RunSessionManager', () => ({
  getRunSessionManager: () => mocks.runSessionManager,
}))

vi.mock('./run-session/EventBridge', () => ({
  getEventBridge: () => mocks.eventBridge,
}))

vi.mock('./webcontents/favicon-resolver', () => ({
  getFaviconResolver: () => mocks.faviconResolver,
}))

vi.mock('./webcontents/theme-color-extractor', () => ({
  extractThemeColor: mocks.extractThemeColor,
}))

import { CrawlViewEventManager, CrawlViewEventType } from './crawl-view-events'

class FakeWebContents extends EventEmitter {
  constructor(
    private readonly url: string,
    private readonly title: string,
  ) {
    super()
  }

  isDestroyed() {
    return false
  }

  getURL() {
    return this.url
  }

  getTitle() {
    return this.title
  }

  isLoading() {
    return false
  }

  navigationHistory = {
    canGoBack: () => false,
    canGoForward: () => false,
  }
}

function createMainWindow() {
  return {
    isDestroyed: () => false,
    webContents: { send: vi.fn() },
  }
}

describe('crawl-view-events (multi-view)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('多视图并行绑定：attach view2 不影响 view1 的事件', async () => {
    const mainWindow = createMainWindow()
    const manager = new CrawlViewEventManager(mainWindow as any)
    const view1 = { webContents: new FakeWebContents('https://example.com/view-1', 'View 1') }
    const view2 = { webContents: new FakeWebContents('https://example.com/view-2', 'View 2') }

    manager.attach(view1 as any, 'view-1')
    view1.webContents.emit('did-finish-load')

    manager.attach(view2 as any, 'view-2')

    await vi.advanceTimersByTimeAsync(300)

    const themeColorEvents = mainWindow.webContents.send.mock.calls
      .filter((call: any[]) => call[0] === 'crawl-view:event')
      .map((call: any[]) => call[1])
      .filter((event: any) => event.type === CrawlViewEventType.THEME_COLOR_CHANGED)

    expect(themeColorEvents.length).toBeGreaterThanOrEqual(1)
    const v1ThemeColor = themeColorEvents.find((e: any) => e.data.viewId === 'view-1')
    expect(v1ThemeColor).toBeTruthy()
  })

  it('detach 指定视图后停止接收事件', () => {
    const mainWindow = createMainWindow()
    const manager = new CrawlViewEventManager(mainWindow as any)
    const view1 = { webContents: new FakeWebContents('https://example.com/1', 'V1') }

    manager.attach(view1 as any, 'v1')
    manager.detach('v1')

    view1.webContents.emit('did-finish-load')

    const loadEvents = mainWindow.webContents.send.mock.calls
      .filter((call: any[]) => call[0] === 'crawl-view:event')
      .map((call: any[]) => call[1])
      .filter((event: any) => event.type === CrawlViewEventType.PAGE_LOADED)

    expect(loadEvents).toHaveLength(0)
  })

  it('external listener 收到来自多个视图的事件', () => {
    const mainWindow = createMainWindow()
    const manager = new CrawlViewEventManager(mainWindow as any)
    const events: any[] = []
    manager.addExternalListener((e) => events.push(e))

    const view1 = { webContents: new FakeWebContents('https://a.com', 'A') }
    const view2 = { webContents: new FakeWebContents('https://b.com', 'B') }

    manager.attach(view1 as any, 'a')
    manager.attach(view2 as any, 'b')

    view1.webContents.emit('did-start-loading')
    view2.webContents.emit('did-start-loading')

    const loadingEvents = events.filter((e) => e.type === CrawlViewEventType.PAGE_LOADING)
    expect(loadingEvents).toHaveLength(2)
    expect(loadingEvents.map((e: any) => e.data.viewId).sort()).toEqual(['a', 'b'])
  })

  it('子 frame 失败只保留主进程诊断，不派发全页错误事件', () => {
    const mainWindow = createMainWindow()
    const manager = new CrawlViewEventManager(mainWindow as any)
    const view = { webContents: new FakeWebContents('https://finance.yahoo.com/article', 'Yahoo') }

    manager.attach(view as any, 'yahoo')

    view.webContents.emit(
      'did-fail-load',
      {},
      -100,
      'ERR_CONNECTION_CLOSED',
      'https://ads.example.test/sync.html',
      false,
      42,
      84,
    )
    view.webContents.emit(
      'did-fail-provisional-load',
      {},
      -100,
      'ERR_CONNECTION_CLOSED',
      'https://ads.example.test/sync.html',
      false,
      42,
      84,
    )

    const errorEvents = mainWindow.webContents.send.mock.calls
      .filter((call: any[]) => call[0] === 'crawl-view:event')
      .map((call: any[]) => call[1])
      .filter((event: any) => [CrawlViewEventType.PAGE_ERROR, CrawlViewEventType.NAVIGATION_FAILED].includes(event.type))

    expect(errorEvents).toHaveLength(0)
  })

  it('主动取消的预提交失败不派发全页错误事件', () => {
    const mainWindow = createMainWindow()
    const manager = new CrawlViewEventManager(mainWindow as any)
    const view = { webContents: new FakeWebContents('https://finance.yahoo.com/article', 'Yahoo') }

    manager.attach(view as any, 'yahoo')
    view.webContents.emit(
      'did-fail-provisional-load',
      {},
      -3,
      'ERR_ABORTED',
      'https://finance.yahoo.com/article',
      true,
      42,
      84,
    )

    const errorEvents = mainWindow.webContents.send.mock.calls
      .filter((call: any[]) => call[0] === 'crawl-view:event')
      .map((call: any[]) => call[1])
      .filter((event: any) => [CrawlViewEventType.PAGE_ERROR, CrawlViewEventType.NAVIGATION_FAILED].includes(event.type))

    expect(errorEvents).toHaveLength(0)
  })

  it('主文档失败保留 frame 范围与来源，供错误链路诊断', () => {
    const mainWindow = createMainWindow()
    const manager = new CrawlViewEventManager(mainWindow as any)
    const view = { webContents: new FakeWebContents('https://finance.yahoo.com/article', 'Yahoo') }

    manager.attach(view as any, 'yahoo')

    view.webContents.emit(
      'did-fail-load',
      {},
      -100,
      'ERR_CONNECTION_CLOSED',
      'https://finance.yahoo.com/article',
      true,
      42,
      84,
    )
    view.webContents.emit(
      'did-fail-provisional-load',
      {},
      -105,
      'ERR_NAME_NOT_RESOLVED',
      'https://finance.yahoo.com/article',
      true,
      43,
      85,
    )

    const events = mainWindow.webContents.send.mock.calls
      .filter((call: any[]) => call[0] === 'crawl-view:event')
      .map((call: any[]) => call[1])

    expect(events.find((event: any) => event.type === CrawlViewEventType.PAGE_ERROR)?.data).toMatchObject({
      source: 'did-fail-load',
      isMainFrame: true,
      frameProcessId: 42,
      frameRoutingId: 84,
      currentMainUrl: 'https://finance.yahoo.com/article',
    })
    expect(events.find((event: any) => event.type === CrawlViewEventType.NAVIGATION_FAILED)?.data).toMatchObject({
      source: 'did-fail-provisional-load',
      isMainFrame: true,
      frameProcessId: 43,
      frameRoutingId: 85,
      currentMainUrl: 'https://finance.yahoo.com/article',
    })
  })

  it('WebContents 销毁时自动清理绑定', () => {
    const mainWindow = createMainWindow()
    const manager = new CrawlViewEventManager(mainWindow as any)
    const view1 = { webContents: new FakeWebContents('https://a.com', 'A') }

    manager.attach(view1 as any, 'auto-clean')

    view1.webContents.emit('destroyed')

    const sendCallsAfterDestroy = mainWindow.webContents.send.mock.calls.length
    view1.webContents.emit('did-start-loading')
    expect(mainWindow.webContents.send.mock.calls.length).toBe(sendCallsAfterDestroy)
  })

  it('cleanup 清除所有绑定和监听器', () => {
    const mainWindow = createMainWindow()
    const manager = new CrawlViewEventManager(mainWindow as any)
    const events: any[] = []
    manager.addExternalListener((e) => events.push(e))

    const view1 = { webContents: new FakeWebContents('https://a.com', 'A') }
    manager.attach(view1 as any, 'x')

    const eventsBeforeCleanup = events.length
    manager.cleanup()

    view1.webContents.emit('did-start-loading')
    expect(events.length).toBe(eventsBeforeCleanup)
  })

  it('导航开始时会先清空旧主题色，并在 SPA 路由跳转后重新提取', async () => {
    const mainWindow = createMainWindow()
    const manager = new CrawlViewEventManager(mainWindow as any)
    const view1 = { webContents: new FakeWebContents('https://example.com/view-1', 'View 1') }

    manager.attach(view1 as any, 'view-1')
    mainWindow.webContents.send.mockClear()

    view1.webContents.emit('did-start-navigation', {}, 'https://example.com/next', false, true)
    await vi.advanceTimersByTimeAsync(1)

    let themeColorEvents = mainWindow.webContents.send.mock.calls
      .filter((call: any[]) => call[0] === 'crawl-view:event')
      .map((call: any[]) => call[1])
      .filter((event: any) => event.type === CrawlViewEventType.THEME_COLOR_CHANGED)

    expect(themeColorEvents[0]?.data).toMatchObject({
      viewId: 'view-1',
      themeColor: null,
    })

    mainWindow.webContents.send.mockClear()
    view1.webContents.emit('did-navigate-in-page', {}, 'https://example.com/route-2', true)
    await vi.advanceTimersByTimeAsync(1000)

    themeColorEvents = mainWindow.webContents.send.mock.calls
      .filter((call: any[]) => call[0] === 'crawl-view:event')
      .map((call: any[]) => call[1])
      .filter((event: any) => event.type === CrawlViewEventType.THEME_COLOR_CHANGED)

    expect(themeColorEvents.some((event: any) => event.data.themeColor === '#111111')).toBe(true)
  })

  it('纯 hash 跳转不会先清空旧主题色', async () => {
    const mainWindow = createMainWindow()
    const manager = new CrawlViewEventManager(mainWindow as any)
    const view1 = { webContents: new FakeWebContents('https://example.com/view-1', 'View 1') }

    manager.attach(view1 as any, 'view-1')
    mainWindow.webContents.send.mockClear()

    view1.webContents.emit('did-navigate-in-page', {}, 'https://example.com/view-1#section', true)
    await vi.advanceTimersByTimeAsync(1000)

    const themeColorEvents = mainWindow.webContents.send.mock.calls
      .filter((call: any[]) => call[0] === 'crawl-view:event')
      .map((call: any[]) => call[1])
      .filter((event: any) => event.type === CrawlViewEventType.THEME_COLOR_CHANGED)

    expect(themeColorEvents.some((event: any) => event.data.themeColor === null)).toBe(false)
    expect(themeColorEvents.some((event: any) => event.data.themeColor === '#111111')).toBe(true)
  })
})
