/**
 * pty:agent-detach — Agent 终端命令人工转后台 IPC
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

const mockRequestDetachAgentSession = vi.fn(() => true)

vi.mock('@tabtin/action-tools/runtime', () => ({
  resolvePtyManagerBridge: vi.fn(() => ({
    requestDetachAgentSession: mockRequestDetachAgentSession,
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

describe('pty:agent-detach IPC', () => {
  beforeEach(async () => {
    handlers.clear()
    mockRequestDetachAgentSession.mockClear()
    mockRequestDetachAgentSession.mockReturnValue(true)
    const { resolvePtyManagerBridge } = await import('@tabtin/action-tools/runtime')
    vi.mocked(resolvePtyManagerBridge).mockReturnValue({
      requestDetachAgentSession: mockRequestDetachAgentSession,
    } as never)
    const mod = await import('../ipc')
    mod.registerTerminalIpcHandlers()
  })

  afterEach(async () => {
    const mod = await import('../ipc')
    mod.unregisterTerminalIpcHandlers()
  })

  it('agent- 前缀 sessionId → 调 bridge.requestDetachAgentSession 并返回 success:true', async () => {
    const handler = handlers.get('pty:agent-detach')
    expect(handler).toBeDefined()

    const result = await handler!(makeTrustedEvent(), 'agent-space-1-1779005704948-1d1z')

    expect(result).toEqual({ success: true })
    expect(mockRequestDetachAgentSession).toHaveBeenCalledWith('agent-space-1-1779005704948-1d1z')
  })

  it('非 agent- 前缀 sessionId → 拒绝，不调 bridge', async () => {
    const handler = handlers.get('pty:agent-detach')
    const result = await handler!(makeTrustedEvent(), 'user-session-1')

    expect(result).toEqual({ success: false })
    expect(mockRequestDetachAgentSession).not.toHaveBeenCalled()
  })

  it('bridge 不可用 → 返回 success:false', async () => {
    const { resolvePtyManagerBridge } = await import('@tabtin/action-tools/runtime')
    vi.mocked(resolvePtyManagerBridge).mockReturnValue(null)

    const handler = handlers.get('pty:agent-detach')
    const result = await handler!(makeTrustedEvent(), 'agent-space-1-1779005704948-1d1z')

    expect(result).toEqual({ success: false })
    expect(mockRequestDetachAgentSession).not.toHaveBeenCalled()
  })

  it('requestDetachAgentSession 返回 false → success:false', async () => {
    mockRequestDetachAgentSession.mockReturnValueOnce(false)

    const handler = handlers.get('pty:agent-detach')
    const result = await handler!(makeTrustedEvent(), 'agent-space-1-1779005704948-1d1z')

    expect(result).toEqual({ success: false })
  })
})
