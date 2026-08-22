/**
 * SC-002 回归测试：app-lifecycle 使用 prependListener 注册 will-quit
 * 确保 onWillQuit（IPC 注销）优先于 mainErrorReporter 等其他 handler 执行。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const registeredListeners: Array<{ method: string; event: string }> = []

vi.mock('electron', () => ({
  app: {
    on: vi.fn((event: string) => {
      registeredListeners.push({ method: 'on', event })
    }),
    prependListener: vi.fn((event: string) => {
      registeredListeners.push({ method: 'prependListener', event })
    }),
    whenReady: vi.fn(() => new Promise(() => {})),
  },
  session: {
    defaultSession: {
      setUserAgent: vi.fn(),
    },
  },
}))

import { createAppLifecycleController } from '../app-lifecycle'

describe('SC-002 回归：app-lifecycle will-quit 注册', () => {
  beforeEach(() => {
    registeredListeners.length = 0
    vi.clearAllMocks()
  })

  it('使用 prependListener 注册 will-quit，确保优先于其他 handler', () => {
    const onWillQuit = vi.fn()

    const controller = createAppLifecycleController({
      isDev: false,
      systemUserAgent: 'test-ua',
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      onReady: vi.fn(),
      onSecondInstance: vi.fn(),
      onActivate: vi.fn(),
      onBeforeQuit: vi.fn(),
      onWillQuit,
    })

    controller.start()

    const willQuitEntry = registeredListeners.find(
      (l) => l.event === 'will-quit',
    )
    expect(willQuitEntry).toBeDefined()
    expect(willQuitEntry!.method).toBe('prependListener')
  })

  it('will-quit handler 调用 onWillQuit 回调', async () => {
    const { app } = await import('electron')
    const onWillQuit = vi.fn()

    createAppLifecycleController({
      isDev: false,
      systemUserAgent: 'test-ua',
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      onReady: vi.fn(),
      onSecondInstance: vi.fn(),
      onActivate: vi.fn(),
      onBeforeQuit: vi.fn(),
      onWillQuit,
    }).start()

    const mockPrependListener = app.prependListener as unknown as ReturnType<typeof vi.fn>
    const willQuitCall = mockPrependListener.mock.calls.find(
      (call: unknown[]) => call[0] === 'will-quit',
    )
    expect(willQuitCall).toBeDefined()

    const willQuitHandler = willQuitCall![1] as () => void
    willQuitHandler()

    expect(onWillQuit).toHaveBeenCalledTimes(1)
  })
})
