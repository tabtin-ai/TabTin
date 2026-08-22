/**
 * SC-002 回归测试：mainErrorReporter 的 will-quit handler
 * 不得调用 e.preventDefault()，否则会阻塞后续 handler（如 IPC 注销）执行。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

type WillQuitHandler = (event: { preventDefault: () => void }) => void

const willQuitHandlers: WillQuitHandler[] = []

const mockApp = {
  on: vi.fn((event: string, handler: unknown) => {
    if (event === 'will-quit') {
      willQuitHandlers.push(handler as WillQuitHandler)
    }
  }),
  getVersion: vi.fn(() => '1.0.0'),
  getLocale: vi.fn(() => 'en'),
}

vi.mock('electron', () => ({
  app: mockApp,
}))

vi.mock('../../config/api.js', () => ({
  API_BASE_URL: 'http://localhost:6060',
}))

vi.mock('../../auth.js', () => ({
  TokenManager: {
    getAccessToken: vi.fn().mockResolvedValue(null),
  },
}))

vi.mock('@tabtin/config', () => ({
  joinApiPath: vi.fn((_base: string, path: string) => `http://localhost:6060${path}`),
}))

vi.mock('../../logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}))

vi.mock('../../utils/deviceFingerprint', () => ({
  getDeviceFingerprint: vi.fn(() => 'test-fp'),
}))

describe('SC-002 回归：mainErrorReporter will-quit handler', () => {
  beforeEach(() => {
    willQuitHandlers.length = 0
    vi.clearAllMocks()
    vi.resetModules()
  })

  it('will-quit handler 不调用 e.preventDefault()（不阻塞退出流程）', async () => {
    const { initMainErrorReporter, reportMainError } = await import('../mainErrorReporter')

    initMainErrorReporter()

    const handler = willQuitHandlers[0]
    expect(handler).toBeDefined()

    reportMainError(new Error('test error for flush'))

    const mockEvent = { preventDefault: vi.fn() }
    handler(mockEvent)

    expect(mockEvent.preventDefault).not.toHaveBeenCalled()
  })

  it('will-quit handler 在队列为空时不触发 flush', async () => {
    const { initMainErrorReporter } = await import('../mainErrorReporter')

    initMainErrorReporter()

    const handler = willQuitHandlers[0]
    expect(handler).toBeDefined()

    const mockEvent = { preventDefault: vi.fn() }
    handler(mockEvent)

    expect(mockEvent.preventDefault).not.toHaveBeenCalled()
  })
})
