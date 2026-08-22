/**
 * 回归测试 IES-005
 *
 * 验证 resource-monitor:getSnapshot 在收到非信任来源调用时拒绝请求。
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

const mockSnapshot = {
  memory: { heapUsed: 100, heapTotal: 200 },
  cpu: { percentCPUUsage: 5 },
  renderers: [],
}

vi.mock('../ResourceMonitorService', () => ({
  getResourceMonitorService: () => ({
    getSnapshot: vi.fn(async () => mockSnapshot),
  }),
}))

function makeTrustedEvent() {
  return { senderFrame: { url: 'file:///app/index.html' } }
}

function makeUntrustedEvent() {
  return { senderFrame: { url: 'https://evil.example.com/attack.html' } }
}

describe('IES-005: resource-monitor:getSnapshot senderFrame guard', () => {
  beforeEach(async () => {
    handlers.clear()
    mockIsTrusted = true
    const mod = await import('../ipc')
    mod.registerResourceMonitorIpcHandlers()
  })

  afterEach(async () => {
    const mod = await import('../ipc')
    mod.unregisterResourceMonitorIpcHandlers()
  })

  it('拒绝非信任来源', async () => {
    mockIsTrusted = false
    const handler = handlers.get('resource-monitor:getSnapshot')
    expect(handler, 'handler should be registered').toBeDefined()

    const result = await handler!(makeUntrustedEvent())
    // Wave 0 contract: guardedHandle 改返 envelope 形状。
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'UNAUTHORIZED', message: expect.stringContaining('Unauthorized') },
    })
  })

  it('允许信任来源', async () => {
    mockIsTrusted = true
    const handler = handlers.get('resource-monitor:getSnapshot')
    expect(handler).toBeDefined()

    const result = await handler!(makeTrustedEvent())
    expect(result).toEqual(mockSnapshot)
  })
})
