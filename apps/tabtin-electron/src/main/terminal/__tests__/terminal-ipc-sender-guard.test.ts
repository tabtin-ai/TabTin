/**
 * 回归测试 SD-001, SD-002, SD-019, SD-020, SD-021, SD-048
 *
 * 验证 terminal IPC handler 在收到非信任来源调用时：
 * - ipcMain.handle 类 → 返回 envelope `{ ok:false, error:{ code:'UNAUTHORIZED', ... } }`
 *   （Wave 0 contract — guardedHandle 已收敛到 @tabtin/agent-wire 的 envelope 形状）
 * - ipcMain.on 类（subscribe/unsubscribe）→ 静默拒绝（不执行订阅）
 * - ipcMain.on 同步路径（pty:snapshot-save-sync）→ event.returnValue 为 envelope
 *   `{ ok:false, error:{ code:'UNAUTHORIZED', ... }, trace_id }`（Wave 2 W2-δ
 *   迁移完成，由 `terminal/ipc-sync-guard.ts::guardedSyncOn` 统一收口）。
 *   成功路径 returnValue 是 `{ ok:true, data:{ saved, failed }, trace_id }`，
 *   不再是 legacy `{ success, saved, failed }`。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

type IpcHandler = (event: any, ...args: any[]) => any
type IpcOnListener = (event: any, ...args: any[]) => void

const handlers = new Map<string, IpcHandler>()
const onListeners = new Map<string, IpcOnListener[]>()

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: vi.fn(() => '/tmp'),
    getVersion: vi.fn(() => '1.0.0-test'),
    getAppPath: vi.fn(() => '/tmp/app'),
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      handlers.set(channel, handler)
    }),
    on: vi.fn((channel: string, listener: IpcOnListener) => {
      const existing = onListeners.get(channel) || []
      existing.push(listener)
      onListeners.set(channel, existing)
    }),
    removeHandler: vi.fn(),
    removeAllListeners: vi.fn(),
  },
  webContents: { fromId: vi.fn() },
}))

let mockIsTrusted = true

vi.mock('../../auth', () => ({
  isTrustedSender: vi.fn(() => mockIsTrusted),
}))

const mockPtyManager = {
  spawn: vi.fn(() => true),
  write: vi.fn(() => true),
  resize: vi.fn(() => true),
  kill: vi.fn(() => true),
  has: vi.fn(() => true),
  getAllSessionIds: vi.fn(() => []),
  getAllSessionsWithStatus: vi.fn(() => []),
  getSessionOutput: vi.fn(() => ({ output: 'data', metadata: {} })),
  releaseThreadSession: vi.fn(),
  setRendererDataSubscription: vi.fn(),
  getAllPaneStatuses: vi.fn(() => []),
  getSession: vi.fn(() => null),
  on: vi.fn(),
  off: vi.fn(),
}

vi.mock('../PtyManager', () => ({
  getPtyManager: () => mockPtyManager,
}))

vi.mock('../PtyEventRouter', () => {
  return {
    PtyEventRouter: class {
      subscribe = vi.fn()
      unsubscribe = vi.fn()
      hasSubscribers = vi.fn(() => false)
      getSubscriberIds = vi.fn(() => [])
      removeWebContents = vi.fn()
    },
  }
})

vi.mock('../clipboard-image', () => ({
  saveClipboardImage: vi.fn(async () => ({ success: true, path: '/tmp/test.png' })),
  cleanupExpiredImages: vi.fn(async () => undefined),
}))

vi.mock('../snapshot', () => ({
  saveAllSnapshots: vi.fn(() => ({ saved: 0, failed: 0 })),
  saveAllSnapshotsAsync: vi.fn(async () => ({ saved: 0, failed: 0 })),
  loadSnapshot: vi.fn(() => null),
  loadManifest: vi.fn(() => ({})),
  deleteSnapshot: vi.fn(),
  clearAllSnapshotsAsync: vi.fn(async () => undefined),
  isValidSnapshot: vi.fn(() => false),
  listAutoCheckpoints: vi.fn(async () => []),
}))

vi.mock('@tabtin/pty-core', () => ({
  normalizeSize: vi.fn((cols?: number, rows?: number) => ({
    cols: cols ?? 80,
    rows: rows ?? 24,
  })),
}))

function makeTrustedEvent() {
  return { senderFrame: { url: 'file:///app/index.html' }, sender: { id: 1, once: vi.fn() } }
}

function makeUntrustedEvent() {
  return { senderFrame: { url: 'https://evil.example.com/attack.html' }, sender: { id: 999, once: vi.fn() } }
}

describe('SD-001/002/019/020/021: terminal IPC handle senderFrame guard', () => {
  beforeEach(async () => {
    handlers.clear()
    onListeners.clear()
    mockIsTrusted = true
    const mod = await import('../ipc')
    mod.registerTerminalIpcHandlers()
  })

  afterEach(async () => {
    const mod = await import('../ipc')
    mod.unregisterTerminalIpcHandlers()
  })

  const guardedChannels: Array<{ channel: string; issueId: string; args: any[] }> = [
    { channel: 'pty:kill', issueId: 'SD-001', args: ['session-1'] },
    { channel: 'pty:resize', issueId: 'SD-002', args: ['session-1', 80, 24] },
    { channel: 'pty:readOutput', issueId: 'SD-019', args: ['session-1'] },
    { channel: 'pty:listWithStatus', issueId: 'SD-020', args: [] },
    { channel: 'pty:paste-image', issueId: 'SD-021', args: [{ mimeType: 'image/png', spaceId: 'sp1', data: 'base64data' }] },
  ]

  for (const { channel, issueId, args } of guardedChannels) {
    it(`${issueId}: ${channel} — 拒绝非信任来源`, async () => {
      mockIsTrusted = false
      const handler = handlers.get(channel)
      expect(handler, `handler for ${channel} should be registered`).toBeDefined()

      const result = await handler!(makeUntrustedEvent(), ...args)
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'UNAUTHORIZED', message: expect.stringContaining('Unauthorized') },
      })
    })

    it(`${issueId}: ${channel} — 允许信任来源`, async () => {
      mockIsTrusted = true
      const handler = handlers.get(channel)
      expect(handler, `handler for ${channel} should be registered`).toBeDefined()

      const result = await handler!(makeTrustedEvent(), ...args)
      expect(result).not.toMatchObject({
        error: expect.objectContaining({ code: 'UNAUTHORIZED' }),
      })
    })
  }
})

describe('#4166: pty:spawn cwd fallback', () => {
  const tempDirs: string[] = []

  function makeTempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabtin-ipc-cwd-'))
    tempDirs.push(dir)
    return dir
  }

  beforeEach(async () => {
    handlers.clear()
    onListeners.clear()
    mockIsTrusted = true
    mockPtyManager.spawn.mockClear()
    const mod = await import('../ipc')
    mod.registerTerminalIpcHandlers()
  })

  afterEach(async () => {
    const mod = await import('../ipc')
    mod.unregisterTerminalIpcHandlers()
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('replaces a missing cwd with home before calling PtyManager.spawn', async () => {
    const home = makeTempDir()
    const missingCwd = path.join(home, 'deleted-space-root')
    const { app } = await import('electron')
    vi.mocked(app.getPath).mockReturnValue(home)

    const handler = handlers.get('pty:spawn')
    expect(handler).toBeDefined()

    const result = await handler!(makeTrustedEvent(), 'session-1', {
      cwd: missingCwd,
      spaceId: 'space-1',
    })

    expect(result).toEqual({ success: true })
    expect(mockPtyManager.spawn).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        cwd: home,
        spaceId: 'space-1',
      }),
    )
  })
})

describe('IES-010: PTY 快照/状态类 channel senderFrame guard', () => {
  beforeEach(async () => {
    handlers.clear()
    onListeners.clear()
    mockIsTrusted = true
    const mod = await import('../ipc')
    mod.registerTerminalIpcHandlers()
  })

  afterEach(async () => {
    const mod = await import('../ipc')
    mod.unregisterTerminalIpcHandlers()
  })

  const snapshotChannels: Array<{ channel: string; args: any[] }> = [
    { channel: 'pty:snapshot-save', args: [[]] },
    { channel: 'pty:snapshot-load', args: ['session-1'] },
    { channel: 'pty:snapshot-manifest', args: [] },
    { channel: 'pty:snapshot-delete', args: ['session-1'] },
    { channel: 'pty:snapshot-clear', args: [] },
    { channel: 'pty:auto-checkpoints-list', args: [] },
    { channel: 'pty:getPaneStatuses', args: [] },
    { channel: 'pty:releaseThreadSession', args: ['thread-1'] },
  ]

  for (const { channel, args } of snapshotChannels) {
    it(`IES-010: ${channel} — 拒绝非信任来源`, async () => {
      mockIsTrusted = false
      const handler = handlers.get(channel)
      expect(handler, `handler for ${channel} should be registered`).toBeDefined()

      const result = await handler!(makeUntrustedEvent(), ...args)
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'UNAUTHORIZED', message: expect.stringContaining('Unauthorized') },
      })
    })

    it(`IES-010: ${channel} — 允许信任来源`, async () => {
      mockIsTrusted = true
      const handler = handlers.get(channel)
      expect(handler, `handler for ${channel} should be registered`).toBeDefined()

      const result = await handler!(makeTrustedEvent(), ...args)
      // 受信路径不会返回 UNAUTHORIZED envelope。
      expect(result).not.toMatchObject({
        error: expect.objectContaining({ code: 'UNAUTHORIZED' }),
      })
    })
  }

  it('IES-010: pty:snapshot-save-sync — 拒绝非信任来源（envelope 形态 returnValue）', () => {
    mockIsTrusted = false
    const listeners = onListeners.get('pty:snapshot-save-sync')
    expect(listeners, 'listener for pty:snapshot-save-sync should be registered').toBeDefined()

    const event = { ...makeUntrustedEvent(), returnValue: undefined as any }
    listeners![listeners!.length - 1](event, [])

    // W2-δ 后：同步 IPC 也走 envelope（guardedSyncOn helper）。
    // 拒绝路径 returnValue 形状跟 ipcMain.handle 一致：
    //   { ok:false, error:{ code:'UNAUTHORIZED', message }, trace_id }
    expect(event.returnValue).toMatchObject({
      ok: false,
      error: { code: 'UNAUTHORIZED', message: expect.stringContaining('Unauthorized') },
    })
    expect(event.returnValue).toHaveProperty('trace_id')
    expect(typeof event.returnValue.trace_id).toBe('string')
  })

  it('IES-010: pty:snapshot-save-sync — 允许信任来源（envelope 成功路径）', () => {
    mockIsTrusted = true
    const listeners = onListeners.get('pty:snapshot-save-sync')
    expect(listeners).toBeDefined()

    const event = { ...makeTrustedEvent(), returnValue: undefined as any }
    listeners![listeners!.length - 1](event, [])

    expect(event.returnValue).toBeDefined()
    // W2-δ 后：成功路径 returnValue 是 envelope { ok:true, data:{...}, trace_id }
    expect(event.returnValue.ok).toBe(true)
    // 空数组路径：listener return { saved: 0, failed: 0 }，被 helper wrap 成 envelope.data
    expect(event.returnValue.data).toEqual({ saved: 0, failed: 0 })
    expect(event.returnValue).toHaveProperty('trace_id')
  })

  it('IES-010: pty:snapshot-save-sync — 非数组入参（VALIDATION_ERROR）', () => {
    // listener 内部 throw 'invalid params: snapshots must be an array'
    // 由 guardedSyncOn 自动转 errResponse('INTERNAL_ERROR', err.message) — 同步路径
    // 没有"业务校验码 vs 系统码"的隐藏区分，listener 抛错统一映射为 INTERNAL_ERROR。
    mockIsTrusted = true
    const listeners = onListeners.get('pty:snapshot-save-sync')
    expect(listeners).toBeDefined()

    const event = { ...makeTrustedEvent(), returnValue: undefined as any }
    listeners![listeners!.length - 1](event, 'not-an-array')

    expect(event.returnValue).toMatchObject({
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: expect.stringContaining('invalid params') },
    })
    expect(event.returnValue).toHaveProperty('trace_id')
  })
})

describe('IES-011: pty:has / pty:list senderFrame guard', () => {
  beforeEach(async () => {
    handlers.clear()
    onListeners.clear()
    mockIsTrusted = true
    const mod = await import('../ipc')
    mod.registerTerminalIpcHandlers()
  })

  afterEach(async () => {
    const mod = await import('../ipc')
    mod.unregisterTerminalIpcHandlers()
  })

  const readOnlyChannels: Array<{ channel: string; args: any[] }> = [
    { channel: 'pty:has', args: ['session-1'] },
    { channel: 'pty:list', args: [] },
  ]

  for (const { channel, args } of readOnlyChannels) {
    it(`IES-011: ${channel} — 拒绝非信任来源`, async () => {
      mockIsTrusted = false
      const handler = handlers.get(channel)
      expect(handler, `handler for ${channel} should be registered`).toBeDefined()

      const result = await handler!(makeUntrustedEvent(), ...args)
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'UNAUTHORIZED', message: expect.stringContaining('Unauthorized') },
      })
    })

    it(`IES-011: ${channel} — 允许信任来源`, async () => {
      mockIsTrusted = true
      const handler = handlers.get(channel)
      expect(handler, `handler for ${channel} should be registered`).toBeDefined()

      const result = await handler!(makeTrustedEvent(), ...args)
      expect(result).not.toMatchObject({
        error: expect.objectContaining({ code: 'UNAUTHORIZED' }),
      })
    })
  }
})

describe('SD-048: pty:subscribe-* / pty:unsubscribe-* senderFrame guard', () => {
  beforeEach(async () => {
    handlers.clear()
    onListeners.clear()
    mockIsTrusted = true
    const mod = await import('../ipc')
    mod.registerTerminalIpcHandlers()
  })

  afterEach(async () => {
    const mod = await import('../ipc')
    mod.unregisterTerminalIpcHandlers()
  })

  // WP2 P1-H：pty:subscribe-agent-session-title / pty:unsubscribe-agent-session-title
  // 已退役（agent-bridge.ts L168-174 硬契约）。
  const subscribeChannels = [
    'pty:subscribe-data',
    'pty:unsubscribe-data',
    'pty:subscribe-exit',
    'pty:unsubscribe-exit',
    'pty:subscribe-agent-session-created',
    'pty:unsubscribe-agent-session-created',
    'pty:subscribe-agent-session-closed',
    'pty:unsubscribe-agent-session-closed',
    'pty:subscribe-auto-respond-triggered',
    'pty:unsubscribe-auto-respond-triggered',
  ]

  for (const channel of subscribeChannels) {
    it(`${channel} — 已注册 handler`, () => {
      const listeners = onListeners.get(channel)
      expect(listeners, `listener for ${channel} should be registered`).toBeDefined()
      expect(listeners!.length).toBeGreaterThan(0)
    })

    it(`${channel} — 拒绝非信任来源（静默）`, () => {
      mockIsTrusted = false
      const listeners = onListeners.get(channel)!
      const listener = listeners[listeners.length - 1]

      // 调用不应抛出异常，而是静默拒绝
      expect(() => listener(makeUntrustedEvent(), 'some-scope')).not.toThrow()
    })

    it(`${channel} — 允许信任来源`, () => {
      mockIsTrusted = true
      const listeners = onListeners.get(channel)!
      const listener = listeners[listeners.length - 1]

      expect(() => listener(makeTrustedEvent(), 'some-scope')).not.toThrow()
    })
  }
})
