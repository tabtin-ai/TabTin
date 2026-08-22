/**
 * TL-001 / TL-010 回归测试
 * - TL-001: sync-page-context 协议白名单校验
 * - TL-010: 导航来源审计日志
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('electron', () => {
  const handlers = new Map<string, Function>()
  return {
    app: {
      isPackaged: false,
      getPath: vi.fn(() => '/tmp'),
      getVersion: vi.fn(() => '1.0.0-test'),
      getAppPath: vi.fn(() => '/tmp/app'),
    },
    BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
    webContents: { fromId: vi.fn() },
    ipcMain: {
      handle: vi.fn((channel: string, fn: Function) => {
        handlers.set(channel, fn)
      }),
      removeHandler: vi.fn(),
      _handlers: handlers,
    },
  }
})

vi.mock('../../utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('../../auth', () => ({
  isTrustedSender: vi.fn(() => true),
}))

vi.mock('../tin-sandbox', () => ({
  prepareSandbox: vi.fn(),
  cleanupSandbox: vi.fn(),
}))

vi.mock('../activation-matcher', () => ({
  matchActivationRules: vi.fn(() => false),
}))

import { ipcMain } from 'electron'
import { logger } from '../../utils/logger'

describe('TL-001: sync-page-context URL protocol whitelist', () => {
  let syncHandler: Function

  beforeEach(async () => {
    const handlers = (ipcMain as any)._handlers as Map<string, Function>
    handlers.clear()
    vi.clearAllMocks()

    const { TinManager } = await import('../tin-manager')
    const manager = new TinManager()

    syncHandler = handlers.get('tins:sync-page-context')!
    expect(syncHandler).toBeDefined()
  })

  afterEach(async () => {
    const { disposeTinManagerSingleton } = await import('../tin-manager')
    try { disposeTinManagerSingleton() } catch { /* ignore */ }
  })

  it('accepts http:// URLs', async () => {
    const mockEvent = { senderFrame: { url: 'app://tabtin' } }
    await syncHandler(mockEvent, { url: 'http://example.com/page', title: 'Test' })
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('Rejected sync-page-context'),
    )
  })

  it('accepts https:// URLs', async () => {
    const mockEvent = { senderFrame: { url: 'app://tabtin' } }
    await syncHandler(mockEvent, { url: 'https://example.com/page', title: 'Test' })
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('Rejected sync-page-context'),
    )
  })

  it('rejects javascript: protocol URLs', async () => {
    const mockEvent = { senderFrame: { url: 'app://tabtin' } }
    await syncHandler(mockEvent, { url: 'javascript:alert(1)', title: 'XSS' })
    expect(logger.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('Rejected sync-page-context'),
    )
  })

  it('rejects file: protocol URLs', async () => {
    const mockEvent = { senderFrame: { url: 'app://tabtin' } }
    await syncHandler(mockEvent, { url: 'file:///etc/passwd', title: 'Leak' })
    expect(logger.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('Rejected sync-page-context'),
    )
  })

  it('rejects data: protocol URLs', async () => {
    const mockEvent = { senderFrame: { url: 'app://tabtin' } }
    await syncHandler(mockEvent, { url: 'data:text/html,<h1>hi</h1>', title: 'Data' })
    expect(logger.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('Rejected sync-page-context'),
    )
  })

  it('rejects invalid / malformed URLs', async () => {
    const mockEvent = { senderFrame: { url: 'app://tabtin' } }
    await syncHandler(mockEvent, { url: 'not-a-valid-url', title: 'Bad' })
    expect(logger.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('Rejected sync-page-context'),
    )
  })

  it('silently ignores null/empty url', async () => {
    const mockEvent = { senderFrame: { url: 'app://tabtin' } }
    await syncHandler(mockEvent, { url: '', title: '' })
    expect(logger.warn).not.toHaveBeenCalled()
    expect(logger.debug).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('Page navigated'),
    )
  })

  it('silently ignores non-string url', async () => {
    const mockEvent = { senderFrame: { url: 'app://tabtin' } }
    await syncHandler(mockEvent, { url: 12345, title: '' })
    expect(logger.warn).not.toHaveBeenCalled()
  })
})

describe('TL-010: onPageNavigate source audit logging', () => {
  let syncHandler: Function

  beforeEach(async () => {
    const handlers = (ipcMain as any)._handlers as Map<string, Function>
    handlers.clear()
    vi.clearAllMocks()

    const { TinManager } = await import('../tin-manager')
    const manager = new TinManager()

    syncHandler = handlers.get('tins:sync-page-context')!
  })

  afterEach(async () => {
    const { disposeTinManagerSingleton } = await import('../tin-manager')
    try { disposeTinManagerSingleton() } catch { /* ignore */ }
  })

  it('logs source=renderer-sync when called via sync-page-context', async () => {
    const mockEvent = { senderFrame: { url: 'app://tabtin' } }
    await syncHandler(mockEvent, { url: 'https://example.com', title: 'Test' })
    expect(logger.debug).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('[source=renderer-sync]'),
    )
  })
})
