/**
 * AppDiscoveryService — Wave B-B3 单元测试。
 *
 * 覆盖 PRD §5.4 B3 / N5 关键不变量：
 * 1. ``initAppDiscoveryPatterns()`` 不再硬编码任何 App。
 * 2. ``app-discovery:update-patterns`` IPC 通道能更新 patterns（renderer
 *    bootstrap 推送通道）。
 * 3. 多 source（marketplace-api / Space-级 useSpaceApps）合并去重。
 * 4. 无 patterns 时 ``checkUrl`` 静默不发送 ``marketplace:app-discovery``。
 * 5. 已安装 App / 已 dismissed App 走匹配后的 short-circuit。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

type IpcHandler = (event: unknown, ...args: unknown[]) => void

const ipcHandlers = new Map<string, IpcHandler>()

vi.mock('electron', () => ({
  ipcMain: {
    on: vi.fn((channel: string, handler: IpcHandler) => {
      ipcHandlers.set(channel, handler)
    }),
  },
  BrowserWindow: class MockBrowserWindow {},
}))

vi.mock('../MarketplaceAppInstaller', () => ({
  getMarketplaceAppInstaller: vi.fn(() => ({
    getInstalledVersion: vi.fn(() => null),
  })),
}))

interface MockMainWindow {
  webContents: { send: ReturnType<typeof vi.fn> }
}

function makeMainWindow(): MockMainWindow {
  return { webContents: { send: vi.fn() } }
}

async function freshModule() {
  vi.resetModules()
  ipcHandlers.clear()
  return await import('../AppDiscoveryService')
}

describe('AppDiscoveryService — initAppDiscoveryPatterns', () => {
  beforeEach(() => {
    ipcHandlers.clear()
  })

  it('does not seed any hardcoded patterns', async () => {
    const mod = await freshModule()
    mod.initAppDiscoveryPatterns()

    const service = mod.getAppDiscoveryService()
    const win = makeMainWindow()
    service.checkUrl('https://app.demo.example.com/path', win as never)
    service.checkUrl('https://www.example.com/x', win as never)
    expect(win.webContents.send).not.toHaveBeenCalled()
  })

  it('exposes singleton via getAppDiscoveryService (warmed by init)', async () => {
    const mod = await freshModule()
    const before = mod.getAppDiscoveryService()
    mod.initAppDiscoveryPatterns()
    const after = mod.getAppDiscoveryService()
    expect(before).toBe(after)
  })
})

describe('AppDiscoveryService — IPC bootstrap channel', () => {
  beforeEach(() => {
    ipcHandlers.clear()
  })

  afterEach(() => {
    ipcHandlers.clear()
  })

  it('app-discovery:update-patterns from marketplace-api populates urlPatterns', async () => {
    const mod = await freshModule()
    mod.registerAppDiscoveryIpc()

    const handler = ipcHandlers.get('app-discovery:update-patterns')
    expect(handler).toBeDefined()

    handler!(null, [
      { appId: 'demo-app', appName: 'Demo App', patterns: ['*.demo.example.com', '*.example.com'] },
    ], 'marketplace-api')

    const service = mod.getAppDiscoveryService()
    const win = makeMainWindow()
    service.checkUrl('https://docs.demo.example.com/x', win as never)

    expect(win.webContents.send).toHaveBeenCalledWith(
      'marketplace:app-discovery',
      expect.objectContaining({ appId: 'demo-app', appName: 'Demo App' }),
    )
  })

  it('multi-source merges by appId without losing entries from other sources', async () => {
    const mod = await freshModule()
    mod.registerAppDiscoveryIpc()
    const handler = ipcHandlers.get('app-discovery:update-patterns')!

    handler(null, [
      { appId: 'demo-app', appName: 'Demo App', patterns: ['*.demo.example.com'] },
    ], 'marketplace-api')

    handler(null, [
      { appId: 'demo-other', appName: 'Demo Other', patterns: ['*.other.local'] },
    ], 'space-current-space-id')

    const service = mod.getAppDiscoveryService()
    const win1 = makeMainWindow()
    service.checkUrl('https://x.demo.example.com', win1 as never)
    expect(win1.webContents.send).toHaveBeenCalledTimes(1)

    const win2 = makeMainWindow()
    service.checkUrl('https://app.other.local', win2 as never)
    expect(win2.webContents.send).toHaveBeenCalledWith(
      'marketplace:app-discovery',
      expect.objectContaining({ appId: 'demo-other' }),
    )
  })

  it('replacing patterns from same sourceId overrides previous entry', async () => {
    const mod = await freshModule()
    mod.registerAppDiscoveryIpc()
    const handler = ipcHandlers.get('app-discovery:update-patterns')!

    handler(null, [
      { appId: 'demo-app', appName: 'Demo App', patterns: ['*.demo.example.com'] },
    ], 'marketplace-api')
    handler(null, [], 'marketplace-api') // simulate API now returns empty

    const service = mod.getAppDiscoveryService()
    const win = makeMainWindow()
    service.checkUrl('https://x.demo.example.com', win as never)
    expect(win.webContents.send).not.toHaveBeenCalled()
  })

  it('empty patterns + empty source list ⇒ checkUrl silent (no fallback)', async () => {
    const mod = await freshModule()
    mod.initAppDiscoveryPatterns()

    const service = mod.getAppDiscoveryService()
    const win = makeMainWindow()
    service.checkUrl('https://anything.example.com', win as never)
    service.checkUrl('https://docs.demo.example.com', win as never)
    expect(win.webContents.send).not.toHaveBeenCalled()
  })

  it('marketplace:dismiss-discovery silences app for cooldown window', async () => {
    const mod = await freshModule()
    mod.registerAppDiscoveryIpc()
    const update = ipcHandlers.get('app-discovery:update-patterns')!
    const dismiss = ipcHandlers.get('marketplace:dismiss-discovery')!

    update(null, [
      { appId: 'demo-app', appName: 'Demo App', patterns: ['*.demo.example.com'] },
    ], 'marketplace-api')

    const win1 = makeMainWindow()
    mod.getAppDiscoveryService().checkUrl('https://x.demo.example.com', win1 as never)
    expect(win1.webContents.send).toHaveBeenCalledTimes(1)

    dismiss(null, 'demo-app')
    const win2 = makeMainWindow()
    mod.getAppDiscoveryService().checkUrl('https://y.demo.example.com', win2 as never)
    expect(win2.webContents.send).not.toHaveBeenCalled()
  })

  it('checkUrl skips already-installed apps', async () => {
    const installerMod = await import('../MarketplaceAppInstaller')
    const installerSpy = (installerMod.getMarketplaceAppInstaller as ReturnType<typeof vi.fn>)
      .mockReturnValue({
        getInstalledVersion: vi.fn(() => '1.0.0'),
      })
    const mod = await freshModule()
    mod.registerAppDiscoveryIpc()
    const handler = ipcHandlers.get('app-discovery:update-patterns')!

    handler(null, [
      { appId: 'demo-app', appName: 'Demo App', patterns: ['*.demo.example.com'] },
    ], 'marketplace-api')

    const win = makeMainWindow()
    mod.getAppDiscoveryService().checkUrl('https://x.demo.example.com', win as never)
    expect(win.webContents.send).not.toHaveBeenCalled()
    installerSpy.mockReset()
  })

  it('matchesHostname accepts both wildcard suffix and the bare apex domain', async () => {
    const mod = await freshModule()
    mod.registerAppDiscoveryIpc()
    const handler = ipcHandlers.get('app-discovery:update-patterns')!

    handler(null, [
      { appId: 'demo-app', appName: 'Demo App', patterns: ['*.demo.example.com'] },
    ], 'marketplace-api')

    const service = mod.getAppDiscoveryService()
    const win1 = makeMainWindow()
    ;(win1 as unknown as { webContents: { id: number } }).webContents.id = 101
    service.checkUrl('https://demo.example.com/landing', win1 as never)
    expect(win1.webContents.send).toHaveBeenCalledTimes(1)

    const win2 = makeMainWindow()
    ;(win2 as unknown as { webContents: { id: number } }).webContents.id = 102
    service.checkUrl('https://docs.demo.example.com', win2 as never)
    expect(win2.webContents.send).toHaveBeenCalledTimes(1)
  })
})

describe('AppDiscoveryService — patterns-after-checkUrl replay (F1 fix)', () => {
  beforeEach(() => {
    ipcHandlers.clear()
  })

  it('replays last checkUrl after patterns become available (cold-start race)', async () => {
    const mod = await freshModule()
    mod.registerAppDiscoveryIpc()
    const service = mod.getAppDiscoveryService()
    const handler = ipcHandlers.get('app-discovery:update-patterns')!

    // Step 1: TabWeb did-finish-load triggers checkUrl while patterns are still empty.
    const win = makeMainWindow()
    ;(win as unknown as { webContents: { id: number } }).webContents.id = 200
    ;(win as unknown as { isDestroyed: () => boolean }).isDestroyed = () => false
    service.checkUrl('https://docs.demo.example.com/x', win as never)
    expect(win.webContents.send).not.toHaveBeenCalled()

    // Step 2: bootstrap API arrives with patterns → registerPatterns → replay.
    handler(null, [
      { appId: 'demo-app', appName: 'Demo App', patterns: ['*.demo.example.com'] },
    ], 'marketplace-api')

    expect(win.webContents.send).toHaveBeenCalledWith(
      'marketplace:app-discovery',
      expect.objectContaining({ appId: 'demo-app', matchedUrl: 'https://docs.demo.example.com/x' }),
    )
  })

  it('replay skips destroyed windows and prunes them from pendingChecks', async () => {
    const mod = await freshModule()
    mod.registerAppDiscoveryIpc()
    const service = mod.getAppDiscoveryService()
    const handler = ipcHandlers.get('app-discovery:update-patterns')!

    const win = makeMainWindow()
    ;(win as unknown as { webContents: { id: number } }).webContents.id = 300
    let destroyed = false
    ;(win as unknown as { isDestroyed: () => boolean }).isDestroyed = () => destroyed
    service.checkUrl('https://docs.demo.example.com', win as never)

    destroyed = true
    handler(null, [
      { appId: 'demo-app', appName: 'Demo App', patterns: ['*.demo.example.com'] },
    ], 'marketplace-api')

    // Destroyed window must not receive IPC.
    expect(win.webContents.send).not.toHaveBeenCalled()

    // Subsequent valid window should still work normally (no global state corruption).
    const liveWin = makeMainWindow()
    ;(liveWin as unknown as { webContents: { id: number } }).webContents.id = 301
    ;(liveWin as unknown as { isDestroyed: () => boolean }).isDestroyed = () => false
    service.checkUrl('https://x.demo.example.com', liveWin as never)
    expect(liveWin.webContents.send).toHaveBeenCalled()
  })

  it('empty patterns update does not trigger replay (avoids meaningless work)', async () => {
    const mod = await freshModule()
    mod.registerAppDiscoveryIpc()
    const service = mod.getAppDiscoveryService()
    const handler = ipcHandlers.get('app-discovery:update-patterns')!

    const win = makeMainWindow()
    ;(win as unknown as { webContents: { id: number } }).webContents.id = 400
    ;(win as unknown as { isDestroyed: () => boolean }).isDestroyed = () => false
    service.checkUrl('https://docs.demo.example.com', win as never)

    // Push empty patterns — replay must short-circuit, no IPC sent.
    handler(null, [], 'marketplace-api')
    expect(win.webContents.send).not.toHaveBeenCalled()
  })

  it('checkUrl ignores destroyed mainWindow at call time', async () => {
    const mod = await freshModule()
    const service = mod.getAppDiscoveryService()

    const win = makeMainWindow()
    ;(win as unknown as { isDestroyed: () => boolean }).isDestroyed = () => true
    service.checkUrl('https://demo.example.com', win as never)
    expect(win.webContents.send).not.toHaveBeenCalled()
  })
})
