/**
 * pty:agent-kill — Agent 终端命令人工停止 IPC
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown

const handlers = new Map<string, IpcHandler>()

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: vi.fn(() => '/tmp'),
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      handlers.set(channel, handler)
    }),
    on: vi.fn(),
    removeHandler: vi.fn(),
    removeAllListeners: vi.fn(),
  },
  webContents: { fromId: vi.fn() },
}))

vi.mock('../../auth', () => ({
  isTrustedSender: vi.fn(() => true),
}))

const mockKillAgentSession = vi.fn(async () => undefined)
const mockRequestKillAgentSession = vi.fn(() => true)
const mockNotifyAgentSessionUserInterrupted = vi.fn(() => true)

vi.mock('@tabtin/action-tools/runtime', () => ({
  resolvePtyManagerBridge: vi.fn(() => ({
    killAgentSession: mockKillAgentSession,
    requestKillAgentSession: mockRequestKillAgentSession,
    notifyAgentSessionUserInterrupted: mockNotifyAgentSessionUserInterrupted,
  })),
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

vi.mock('../PtyEventRouter', () => ({
  PtyEventRouter: class {
    subscribe = vi.fn()
    unsubscribe = vi.fn()
    hasSubscribers = vi.fn(() => false)
    getSubscriberIds = vi.fn(() => [])
    removeWebContents = vi.fn()
  },
}))

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

describe('pty:agent-kill IPC', () => {
  beforeEach(async () => {
    handlers.clear()
    mockKillAgentSession.mockClear()
    mockRequestKillAgentSession.mockClear()
    mockNotifyAgentSessionUserInterrupted.mockClear()
    const { resolvePtyManagerBridge } = await import('@tabtin/action-tools/runtime')
    vi.mocked(resolvePtyManagerBridge).mockReturnValue({
      killAgentSession: mockKillAgentSession,
      requestKillAgentSession: mockRequestKillAgentSession,
      notifyAgentSessionUserInterrupted: mockNotifyAgentSessionUserInterrupted,
    } as never)
    const mod = await import('../ipc')
    mod.registerTerminalIpcHandlers()
  })

  afterEach(async () => {
    const mod = await import('../ipc')
    mod.unregisterTerminalIpcHandlers()
  })

  it('agent- 前缀 sessionId → 调 bridge.killAgentSession(SIGTERM) 并返回 success:true', async () => {
    const handler = handlers.get('pty:agent-kill')
    expect(handler).toBeDefined()

    const result = await handler!(makeTrustedEvent(), 'agent-space-1-1779005704948-1d1z')

    expect(result).toEqual({ success: true })
    expect(mockRequestKillAgentSession).toHaveBeenCalledWith('agent-space-1-1779005704948-1d1z')
    expect(mockKillAgentSession).toHaveBeenCalledWith('agent-space-1-1779005704948-1d1z', 'SIGTERM')
    expect(mockNotifyAgentSessionUserInterrupted).toHaveBeenCalledWith('agent-space-1-1779005704948-1d1z')
  })

  it('非 agent- 前缀 sessionId → 拒绝，不调 bridge', async () => {
    const handler = handlers.get('pty:agent-kill')
    const result = await handler!(makeTrustedEvent(), 'user-session-1')

    expect(result).toEqual({ success: false })
    expect(mockRequestKillAgentSession).not.toHaveBeenCalled()
    expect(mockKillAgentSession).not.toHaveBeenCalled()
    expect(mockNotifyAgentSessionUserInterrupted).not.toHaveBeenCalled()
  })

  it('bridge 不可用 → 返回 success:false', async () => {
    const { resolvePtyManagerBridge } = await import('@tabtin/action-tools/runtime')
    vi.mocked(resolvePtyManagerBridge).mockReturnValue(null)

    const handler = handlers.get('pty:agent-kill')
    const result = await handler!(makeTrustedEvent(), 'agent-space-1-1779005704948-1d1z')

    expect(result).toEqual({ success: false })
    expect(mockRequestKillAgentSession).not.toHaveBeenCalled()
    expect(mockKillAgentSession).not.toHaveBeenCalled()
    expect(mockNotifyAgentSessionUserInterrupted).not.toHaveBeenCalled()
  })

  it('killAgentSession 抛错 → 返回 success:false', async () => {
    mockKillAgentSession.mockRejectedValueOnce(new Error('agent session not found'))

    const handler = handlers.get('pty:agent-kill')
    const result = await handler!(makeTrustedEvent(), 'agent-space-1-1779005704948-1d1z')

    expect(result).toEqual({ success: false })
    expect(mockNotifyAgentSessionUserInterrupted).not.toHaveBeenCalled()
  })
})
