import { beforeEach, describe, expect, it, vi } from 'vitest'

const { appHandlers, captureClientError } = vi.hoisted(() => ({
  appHandlers: new Map<string, (...args: unknown[]) => void>(),
  captureClientError: vi.fn(),
}))

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getVersion: () => '1.0.0',
    getLocale: () => 'en',
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => appHandlers.set(event, handler)),
  },
}))
vi.mock('../../sentry', () => ({ captureClientError }))
vi.mock('../../config/api.js', () => ({ API_BASE_URL: 'http://localhost:6060' }))
vi.mock('../../auth.js', () => ({ TokenManager: { getAccessToken: vi.fn() } }))
vi.mock('@tabtin/config', () => ({ joinApiPath: (_base: string, path: string) => path }))
vi.mock('../../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}))
vi.mock('../../utils/deviceFingerprint', () => ({ getDeviceFingerprint: () => 'device-1' }))

describe('main error reporter renderer crash capture', () => {
  beforeEach(() => {
    appHandlers.clear()
    captureClientError.mockClear()
    vi.resetModules()
  })

  it('captures a real renderer process crash with a low-cardinality code', async () => {
    const { initMainErrorReporter } = await import('../mainErrorReporter')
    initMainErrorReporter()

    appHandlers.get('render-process-gone')?.({}, {}, { reason: 'oom', exitCode: 137 })

    expect(captureClientError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        handled_by: 'electron_render_process_gone',
        error_category: 'RENDERER_CRASH',
        error_code: 'RENDERER_OOM',
        severity: 'crash',
      }),
    )
  })

  it('does not report clean or explicitly killed renderer exits', async () => {
    const { initMainErrorReporter } = await import('../mainErrorReporter')
    initMainErrorReporter()

    appHandlers.get('render-process-gone')?.({}, {}, { reason: 'clean-exit', exitCode: 0 })
    appHandlers.get('render-process-gone')?.({}, {}, { reason: 'killed', exitCode: 0 })

    expect(captureClientError).not.toHaveBeenCalled()
  })
})
