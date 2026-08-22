/**
 * F07 修复回归测试（Part 1）
 *
 * CR-010: TinManager.dispose() 同步清理 TinBridge handler
 * CR-012: sendToRenderer 广播到所有 BrowserWindow
 * CR-021: disposeCrawlViewIntegration 调用 disposeTinBridge
 * SD-043: tins:cleanup-sandbox 使用 guardedHandle 防护
 *
 * CR-011 测试在 fix-f07-sandbox-security.test.ts 中
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const {
  mockDisposeTinBridge, mockRemoveHandler, handlers, mockWindows, mockIsTrustedSender,
} = vi.hoisted(() => {
  const handlers = new Map<string, Function>()
  const mockWindows: Array<{ isDestroyed: () => boolean; webContents: { send: any } }> = []
  return {
    mockDisposeTinBridge: vi.fn(),
    mockRemoveHandler: vi.fn((ch: string) => { handlers.delete(ch) }),
    handlers,
    mockWindows,
    mockIsTrustedSender: vi.fn(() => true),
  }
})

vi.mock('electron', () => ({
  BrowserWindow: Object.assign(vi.fn(), {
    getAllWindows: () => mockWindows,
    getFocusedWindow: () => null,
  }),
  webContents: { fromId: vi.fn() },
  ipcMain: {
    handle: vi.fn((channel: string, fn: Function) => { handlers.set(channel, fn) }),
    removeHandler: mockRemoveHandler,
  },
  dialog: { showMessageBox: vi.fn(() => Promise.resolve({ response: 1 })) },
  app: { getPath: () => '/tmp/mock-user-data' },
  session: { fromPartition: vi.fn(() => ({ clearStorageData: vi.fn(() => Promise.resolve()) })) },
}))

vi.mock('../../utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../../auth', () => ({
  isTrustedSender: (...args: unknown[]) => mockIsTrustedSender(...args),
}))

vi.mock('../activation-matcher', () => ({
  matchActivationRules: vi.fn(() => false),
}))

vi.mock('../tin-bridge', () => ({
  disposeTinBridge: (...args: unknown[]) => mockDisposeTinBridge(...args),
  generateTinPreloadScript: () => '/* preload script */',
}))

vi.mock('../tin-sandbox', () => ({
  prepareSandbox: vi.fn(),
  cleanupSandbox: vi.fn(() => Promise.resolve()),
}))

import { ipcMain } from 'electron'

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000'

// ── CR-010: TinManager.dispose() 清理 TinBridge ───────

describe('CR-010: TinManager.dispose() cleans up TinBridge handler', () => {
  beforeEach(() => {
    handlers.clear()
    vi.clearAllMocks()
    mockIsTrustedSender.mockReturnValue(true)
  })

  afterEach(async () => {
    const { disposeTinManagerSingleton } = await import('../tin-manager')
    try { disposeTinManagerSingleton() } catch { /* ignore */ }
  })

  it('calls disposeTinBridge when TinManager is disposed', async () => {
    const { TinManager } = await import('../tin-manager')
    const manager = new TinManager()
    manager.dispose()

    expect(mockDisposeTinBridge).toHaveBeenCalledOnce()
  })

  it('calls disposeTinBridge after cleaning tins:* channels', async () => {
    const { TinManager } = await import('../tin-manager')
    const callOrder: string[] = []

    mockRemoveHandler.mockImplementation((ch: string) => {
      callOrder.push(`removeHandler:${ch}`)
      handlers.delete(ch)
    })
    mockDisposeTinBridge.mockImplementation(() => {
      callOrder.push('disposeTinBridge')
    })

    const manager = new TinManager()
    manager.dispose()

    const bridgeIdx = callOrder.indexOf('disposeTinBridge')
    const tinsHandlerIdx = callOrder.findIndex(c => c.startsWith('removeHandler:tins:'))
    expect(tinsHandlerIdx).toBeGreaterThanOrEqual(0)
    expect(bridgeIdx).toBeGreaterThan(tinsHandlerIdx)
  })
})

// ── CR-012: sendToRenderer 广播所有窗口 ────────────────

describe('CR-012: sendToRenderer broadcasts to all BrowserWindows', () => {
  beforeEach(() => {
    handlers.clear()
    mockWindows.length = 0
    vi.clearAllMocks()
    mockIsTrustedSender.mockReturnValue(true)
  })

  afterEach(async () => {
    const { disposeTinManagerSingleton } = await import('../tin-manager')
    try { disposeTinManagerSingleton() } catch { /* ignore */ }
  })

  it('sends activation changes to multiple windows', async () => {
    const { TinManager } = await import('../tin-manager')

    const sendA = vi.fn()
    const sendB = vi.fn()
    mockWindows.push(
      { isDestroyed: () => false, webContents: { send: sendA } },
      { isDestroyed: () => false, webContents: { send: sendB } },
    )

    const manager = new TinManager()
    manager.removeInstance(VALID_UUID)

    expect(sendA).toHaveBeenCalledWith('tins:activation-changed', expect.any(Object))
    expect(sendB).toHaveBeenCalledWith('tins:activation-changed', expect.any(Object))
  })

  it('skips destroyed windows gracefully', async () => {
    const { TinManager } = await import('../tin-manager')

    const sendDestroyed = vi.fn()
    const sendAlive = vi.fn()
    mockWindows.push(
      { isDestroyed: () => true, webContents: { send: sendDestroyed } },
      { isDestroyed: () => false, webContents: { send: sendAlive } },
    )

    const manager = new TinManager()
    manager.removeInstance(VALID_UUID)

    expect(sendDestroyed).not.toHaveBeenCalled()
    expect(sendAlive).toHaveBeenCalled()
  })
})

// ── CR-021: disposeCrawlViewIntegration 调用 disposeTinBridge ──

describe('CR-021: disposeCrawlViewIntegration calls disposeTinBridge', () => {
  beforeEach(() => {
    handlers.clear()
    vi.clearAllMocks()
  })

  it('calls disposeTinBridge when disposeCrawlViewIntegration is called', async () => {
    const { disposeCrawlViewIntegration } = await import('../crawlview-integration')

    disposeCrawlViewIntegration()

    expect(mockDisposeTinBridge).toHaveBeenCalledOnce()
  })

  it('also removes tins:inject-content-script handler', async () => {
    const { disposeCrawlViewIntegration } = await import('../crawlview-integration')

    disposeCrawlViewIntegration()

    expect(mockRemoveHandler).toHaveBeenCalledWith('tins:inject-content-script')
  })
})

// ── SD-043: tins:cleanup-sandbox guardedHandle 防护 ────

describe('SD-043: tins:cleanup-sandbox rejects untrusted senders', () => {
  beforeEach(() => {
    handlers.clear()
    vi.clearAllMocks()
    mockIsTrustedSender.mockReturnValue(true)
  })

  afterEach(async () => {
    const { disposeTinManagerSingleton } = await import('../tin-manager')
    try { disposeTinManagerSingleton() } catch { /* ignore */ }
  })

  it('blocks untrusted sender from calling cleanup-sandbox', async () => {
    const { TinManager } = await import('../tin-manager')
    new TinManager()

    const handler = handlers.get('tins:cleanup-sandbox')!
    expect(handler).toBeDefined()

    mockIsTrustedSender.mockReturnValue(false)
    const mockEvent = { senderFrame: { url: 'https://evil.com' } }
    const result = await handler(mockEvent, VALID_UUID)

    // Wave 0 + W1 D3 contract: envelope 形状 + per-call trace_id stamp。
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Unauthorized: untrusted origin',
        retryable: false,
      },
    })
    expect(result).toHaveProperty('trace_id')
  })

  it('allows trusted sender to call cleanup-sandbox', async () => {
    const { TinManager } = await import('../tin-manager')
    new TinManager()

    const handler = handlers.get('tins:cleanup-sandbox')!
    mockIsTrustedSender.mockReturnValue(true)
    const mockEvent = { senderFrame: { url: 'app://tabtin' } }

    const result = await handler(mockEvent, VALID_UUID)
    expect(result).not.toEqual(
      expect.objectContaining({ error: expect.stringContaining('Unauthorized') }),
    )
  })
})
