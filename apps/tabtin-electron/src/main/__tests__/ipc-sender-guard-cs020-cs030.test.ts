/**
 * 回归测试 CS-020 ~ CS-030
 *
 * 验证 crawl-view、tabsite、file-system、crawlspace、organization、
 * session、ipc-registry、run-session 模块的高危 IPC handler
 * 在收到非信任来源调用时返回 Unauthorized 错误。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── 收集 ipcMain.handle 注册的 handler ──────────────
type IpcHandler = (event: any, ...args: any[]) => any

const handlers = new Map<string, IpcHandler>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      handlers.set(channel, handler)
    }),
    removeHandler: vi.fn(),
    on: vi.fn(),
    removeAllListeners: vi.fn(),
  },
  BrowserWindow: vi.fn(),
  app: {
    getPath: (name: string) => `/tmp/mock-${name}`,
    isReady: () => true,
  },
  shell: { openPath: vi.fn(), openExternal: vi.fn(), showItemInFolder: vi.fn() },
  dialog: { showMessageBox: vi.fn(), showSaveDialog: vi.fn(), showOpenDialog: vi.fn() },
  webContents: { fromId: vi.fn() },
  powerSaveBlocker: { start: vi.fn(), stop: vi.fn() },
  session: { fromPartition: vi.fn() },
}))

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}))

vi.mock('../utils/logger', () => ({
  logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}))

let mockIsTrusted = true

vi.mock('../auth', () => ({
  isTrustedSender: vi.fn(() => mockIsTrusted),
}))

function makeTrustedEvent() {
  return { senderFrame: { url: 'file:///app/index.html' }, sender: { id: 1 } }
}

function makeUntrustedEvent() {
  return { senderFrame: { url: 'https://evil.example.com/attack.html' }, sender: { id: 999 } }
}

// ── CS-020: crawl-view:executeScript / loadUrl ──────

vi.mock('../view-factory', () => ({
  getViewFactory: () => ({
    getView: vi.fn(),
    getViewState: vi.fn(),
    hasView: vi.fn(() => false),
    createView: vi.fn(),
    destroyView: vi.fn(),
    triggerCleanup: vi.fn(async () => ({ message: 'ok' })),
  }),
}))

vi.mock('../organization/OrganizationTabManager', () => ({
  getOrganizationTabManager: () => null,
}))

vi.mock('../run-session/RunSessionManager', () => ({
  getRunSessionManager: () => ({
    createRun: vi.fn(() => ({ runId: 'r1', sessionId: 's1', profile: null })),
    getRun: vi.fn(() => null),
    addObservation: vi.fn(),
    checkQuotaForNewView: vi.fn(() => ({ allowed: true })),
    setActiveView: vi.fn(),
    registerViewLocked: vi.fn(async () => undefined),
    endRun: vi.fn(async () => {}),
    openTab: vi.fn(async () => ({ success: true })),
    switchTab: vi.fn(async () => ({ success: true })),
    closeTab: vi.fn(async () => ({ success: true })),
  }),
}))

vi.mock('../crawl-view/reconcile-orphans', () => ({
  reconcileOrphans: vi.fn(async () => ({ success: true })),
}))

vi.mock('../crawl-view/navigation', () => ({
  goBack: vi.fn(() => true),
  goForward: vi.fn(() => true),
  reload: vi.fn(() => true),
  stop: vi.fn(() => true),
  getNavigationState: vi.fn(() => ({ canGoBack: false, canGoForward: false })),
}))

vi.mock('../crawl-view/content-ops', () => ({
  executeScript: vi.fn(async () => 'result'),
  loadUrl: vi.fn(async () => ({ success: true })),
  waitForSelector: vi.fn(async () => ({ success: true })),
  screenshot: vi.fn(async () => Buffer.from('png')),
  getCDPEndpoint: vi.fn(() => null),
  getWebContentsId: vi.fn(() => null),
  getHTML: vi.fn(async () => '<html></html>'),
  getPageInfo: vi.fn(async () => ({})),
  getProcessedContent: vi.fn(async () => ({ success: true })),
}))

vi.mock('../crawl-view/utils', () => ({
  hasAliveWebContents: vi.fn(() => true),
}))

describe('CS-020: crawl-view:executeScript/loadUrl senderFrame guard', () => {
  beforeEach(async () => {
    handlers.clear()
    mockIsTrusted = true

    const mod = await import('../crawl-view/ipc-handlers')
    mod.initIpcHandlers({
      showEmbeddedView: vi.fn(async () => {}),
      hideEmbeddedView: vi.fn(),
      destroyTabView: vi.fn(async () => {}),
      syncIgnoreMouseEventsForAttached: vi.fn(),
      getOrCreateViewForTab: vi.fn(async () => ({}) as any),
      cleanupStaleView: vi.fn(),
      getMainWindow: vi.fn(() => null),
      getCurrentTabId: vi.fn(() => null),
      getResourceManagerAccessor: vi.fn(() => null),
      getCacheStats: vi.fn(() => ({ total: 0, max: 10, idle: 0, inUse: 0, current: null })),
      getAllTabsInfo: vi.fn(() => []),
    })
    mod.registerEmbeddedCrawlViewHandlers()
  })

  afterEach(async () => {
    const mod = await import('../crawl-view/ipc-handlers')
    mod.unregisterAllIpcHandlers()
  })

  for (const channel of ['crawl-view:executeScript', 'crawl-view:loadUrl']) {
    it(`${channel} — 拒绝非信任来源`, async () => {
      mockIsTrusted = false
      const handler = handlers.get(channel)
      expect(handler, `handler for ${channel} should be registered`).toBeDefined()
      const result = await handler!(makeUntrustedEvent(), 'script-or-url', 'tab1')
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'UNAUTHORIZED', message: expect.stringContaining('Unauthorized') },
      })
    })

    it(`${channel} — 允许信任来源`, async () => {
      mockIsTrusted = true
      const handler = handlers.get(channel)
      expect(handler, `handler for ${channel} should be registered`).toBeDefined()
      const result = await handler!(makeTrustedEvent(), 'script-or-url', 'tab1')
      expect(result).not.toMatchObject({ error: expect.stringContaining('Unauthorized') })
    })
  }

  it('crawl-view:show — 非信任来源会被 guardedHandle 拒绝', async () => {
    mockIsTrusted = false
    const handler = handlers.get('crawl-view:show')
    expect(handler).toBeDefined()
    const result = await handler!(makeUntrustedEvent(), 'tab1', 'https://example.com', { x: 0, y: 0, width: 800, height: 600 })
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'UNAUTHORIZED', message: expect.stringContaining('Unauthorized') },
    })
  })
})

// ── CS-022: fs:writeFile/writeBinaryFile/createDir/rename/deleteDir/deleteFile ──

vi.mock('../download-security', () => ({
  isPathSafe: vi.fn(() => true),
}))

vi.mock('@tabtin/terminal-core', () => ({
  resolveSpacesRoot: () => '/tmp/mock-sandbox',
  resolvePlatformDataRoot: () => '/tmp/mock-platform',
  computeSkillContentHash: vi.fn().mockResolvedValue('hash'),
  matchSensitivePath: vi.fn(() => null),
}))

// Wave 2：fs IPC handler 接 path-access-checker，sender guard 测试默认放行权限
vi.mock('../security/path-access-checker', () => ({
  getDefaultPathAccessChecker: () => ({
    check: vi.fn(() => ({ allowed: true })),
  }),
}))

vi.mock('../utils/path-sanitize', () => ({
  sanitizePathSegment: (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_'),
}))

describe('CS-022: fs write operations senderFrame guard', () => {
  beforeEach(async () => {
    handlers.clear()
    mockIsTrusted = true
    const mod = await import('../file-system/ipc')
    mod.registerFileSystemIpcHandlers()
  })

  afterEach(async () => {
    const mod = await import('../file-system/ipc')
    mod.unregisterFileSystemIpcHandlers()
  })

  const guardedChannels = [
    'fs:writeFile',
    'fs:writeBinaryFile',
    'fs:createDir',
    'fs:rename',
    'fs:deleteDir',
    'fs:deleteFile',
  ]

  for (const channel of guardedChannels) {
    it(`${channel} — 拒绝非信任来源`, async () => {
      mockIsTrusted = false
      const handler = handlers.get(channel)
      expect(handler, `handler for ${channel} should be registered`).toBeDefined()
      const result = await handler!(makeUntrustedEvent(), '/tmp/test', channel === 'fs:rename' ? '/tmp/test2' : 'content')
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'UNAUTHORIZED', message: expect.stringContaining('Unauthorized') },
      })
    })
  }

  const readOnlyChannels = ['fs:readDir', 'fs:readFilePreview']

  for (const channel of readOnlyChannels) {
    it(`${channel} — 只读 handler 不需要 guard（仍可注册）`, () => {
      const handler = handlers.get(channel)
      expect(handler, `handler for ${channel} should be registered`).toBeDefined()
    })
  }
})

// ── CS-024: organization:clearLocalCache ────────────────

describe('CS-024: organization:clearLocalCache senderFrame guard', () => {
  beforeEach(async () => {
    handlers.clear()
    mockIsTrusted = true
    const mod = await import('../organization-handler')
    mod.registerOrganizationHandlers()
  })

  it('organization:clearLocalCache — 拒绝非信任来源', async () => {
    mockIsTrusted = false
    const handler = handlers.get('organization:clearLocalCache')
    expect(handler).toBeDefined()
    const result = await handler!(makeUntrustedEvent(), 'ws-id')
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'UNAUTHORIZED', message: expect.stringContaining('Unauthorized') },
    })
  })

  it('organization:clearLocalCache — 允许信任来源', async () => {
    mockIsTrusted = true
    const handler = handlers.get('organization:clearLocalCache')
    expect(handler).toBeDefined()
    const result = await handler!(makeTrustedEvent(), 'ws-id')
    expect(result).not.toMatchObject({ error: expect.stringContaining('Unauthorized') })
  })
})

// ── CS-025: session:create/delete ────────────────────

vi.mock('../session/SessionManager', () => ({
  getSessionManager: () => ({
    createSession: vi.fn(() => ({ sessionId: 's1', name: 'test' })),
    getSession: vi.fn(() => null),
    listSessions: vi.fn(() => []),
    deleteSession: vi.fn(() => true),
    setCurrentTrace: vi.fn(),
    addTrace: vi.fn(),
    updateTraceStatus: vi.fn(),
  }),
}))

// W6 批次 1：session:create/get/list/delete 已迁到 PlatformSurface，
// sender guard 由 registerSurfaceAsIpc 内部 guardedHandle 保证。
// 此处仅验证 registerSessionIpcHandlers 不再注册这 4 个 channel。
describe('CS-025: session handler W6 迁移确认', () => {
  beforeEach(async () => {
    handlers.clear()
    mockIsTrusted = true
    const mod = await import('../session/ipc')
    mod.registerSessionIpcHandlers()
  })

  afterEach(async () => {
    const mod = await import('../session/ipc')
    mod.unregisterSessionIpcHandlers()
  })

  for (const channel of ['session:create', 'session:get', 'session:list', 'session:delete']) {
    it(`${channel} — 已迁到 PlatformSurface，不在 registerSessionIpcHandlers 注册`, () => {
      const handler = handlers.get(channel)
      expect(handler).toBeUndefined()
    })
  }
})

// ── CS-027/028: run-session:addEvent per-sender rate limit + senderFrame ──

describe('CS-027/028: run-session:addEvent per-sender rate limit + senderFrame guard', () => {
  beforeEach(async () => {
    handlers.clear()
    mockIsTrusted = true
    vi.resetModules()
    const mod = await import('../run-session/ipc')
    mod.registerRunSessionIpcHandlers()
  })

  afterEach(async () => {
    const mod = await import('../run-session/ipc')
    mod.unregisterRunSessionIpcHandlers()
  })

  it('run-session:addEvent — 拒绝非信任来源', async () => {
    mockIsTrusted = false
    const handler = handlers.get('run-session:addEvent')
    expect(handler).toBeDefined()
    const result = await handler!(makeUntrustedEvent(), { type: 'test' })
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'UNAUTHORIZED', message: expect.stringContaining('Unauthorized') },
    })
  })

  it('run-session:addEvent — 允许信任来源', async () => {
    mockIsTrusted = true
    const handler = handlers.get('run-session:addEvent')
    expect(handler).toBeDefined()
    const result = await handler!(makeTrustedEvent(), { type: 'test' })
    expect(result).toMatchObject({ success: true })
  })

  it('run-session:addEvent — per-sender 速率限制隔离', async () => {
    mockIsTrusted = true
    const handler = handlers.get('run-session:addEvent')!

    const sender1Event = { senderFrame: { url: 'file:///app/index.html' }, sender: { id: 100 } }
    const sender2Event = { senderFrame: { url: 'file:///app/index.html' }, sender: { id: 200 } }

    for (let i = 0; i < 100; i++) {
      await handler(sender1Event, { type: 'flood' })
    }

    const exhausted = await handler(sender1Event, { type: 'one-more' })
    expect(exhausted).toMatchObject({ success: false, error: 'rate limit exceeded' })

    const otherSender = await handler(sender2Event, { type: 'from-other' })
    expect(otherSender).toMatchObject({ success: true })
  })
})

// ── CS-029/030: run-session:setActiveView 已 guardedHandle ──

describe('CS-029/030: run-session:setActiveView senderFrame guard', () => {
  beforeEach(async () => {
    handlers.clear()
    mockIsTrusted = true
    const mod = await import('../run-session/ipc')
    mod.registerRunSessionIpcHandlers()
  })

  afterEach(async () => {
    const mod = await import('../run-session/ipc')
    mod.unregisterRunSessionIpcHandlers()
  })

  for (const channel of ['run-session:setActiveView']) {
    it(`${channel} — 拒绝非信任来源`, async () => {
      mockIsTrusted = false
      const handler = handlers.get(channel)
      expect(handler).toBeDefined()
      const result = await handler!(makeUntrustedEvent(), 'run-id', 'v1')
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'UNAUTHORIZED', message: expect.stringContaining('Unauthorized') },
      })
    })
  }
})
