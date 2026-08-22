/**
 * 回归测试 IES-009
 *
 * W6 批次 1 迁移后：session:create / get / list / delete 已迁到
 * PlatformSurface（startup-services.ts 通过 registerSurfaceAsIpc 注册），
 * sender guard 由 registerSurfaceAsIpc 内的 guardedHandle 保证。
 *
 * 本测试验证 registerSessionIpcHandlers() 注册的**剩余** handler
 * （setCurrentTrace / addTrace / updateTraceStatus）仍然有 sender guard。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

type IpcHandler = (event: any, ...args: any[]) => any

const handlers = new Map<string, IpcHandler>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      handlers.set(channel, handler)
    }),
    removeHandler: vi.fn(),
  },
}))

let mockIsTrusted = true

vi.mock('../../auth', () => ({
  isTrustedSender: vi.fn(() => mockIsTrusted),
}))

vi.mock('../../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}))

const mockSessionManager = {
  createSession: vi.fn(() => ({ sessionId: 's1', name: 'test', mode: 'chat' })),
  getSession: vi.fn(() => ({ sessionId: 's1', name: 'test', mode: 'chat' })),
  listSessions: vi.fn(() => [{ sessionId: 's1' }]),
  deleteSession: vi.fn(() => true),
  setCurrentTrace: vi.fn(),
  addTrace: vi.fn(),
  updateTraceStatus: vi.fn(),
}

vi.mock('../SessionManager', () => ({
  getSessionManager: () => mockSessionManager,
}))

function makeUntrustedEvent() {
  return { senderFrame: { url: 'https://evil.example.com/attack.html' } }
}

describe('IES-009: session 剩余 handler senderFrame guard（W6 迁移后）', () => {
  beforeEach(async () => {
    handlers.clear()
    mockIsTrusted = true
    const mod = await import('../ipc')
    mod.registerSessionIpcHandlers()
  })

  afterEach(async () => {
    const mod = await import('../ipc')
    mod.unregisterSessionIpcHandlers()
  })

  // W6 迁移后 registerSessionIpcHandlers 只注册这 3 个 channel
  const remainingChannels = [
    'session:setCurrentTrace',
    'session:addTrace',
    'session:updateTraceStatus',
  ]

  for (const channel of remainingChannels) {
    it(`${channel} — 仍由 guardedHandle 注册`, () => {
      const handler = handlers.get(channel)
      expect(handler, `handler for ${channel} should be registered`).toBeDefined()
    })

    it(`${channel} — 拒绝非信任来源`, async () => {
      mockIsTrusted = false
      const handler = handlers.get(channel)
      expect(handler).toBeDefined()

      const result = await handler!(makeUntrustedEvent(), 'session-1', 'trace-1')
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'UNAUTHORIZED', message: expect.stringContaining('Unauthorized') },
      })
    })
  }

  // session:create/get/list/delete 不再由 registerSessionIpcHandlers 注册
  for (const channel of ['session:create', 'session:get', 'session:list', 'session:delete']) {
    it(`${channel} — 已迁到 PlatformSurface，不在此处注册`, () => {
      const handler = handlers.get(channel)
      expect(handler).toBeUndefined()
    })
  }
})
