import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type EventHandler = (...args: unknown[]) => void

const mocks = vi.hoisted(() => ({
  appOn: vi.fn(),
  appPrependListener: vi.fn(),
  appQuit: vi.fn(),
  appExit: vi.fn(),
  appWhenReady: vi.fn(),
  appIsReady: vi.fn(() => true),
  autoUpdaterOn: vi.fn(),
  setUserAgent: vi.fn(),
}))

vi.mock('electron', () => ({
  app: {
    on: mocks.appOn,
    prependListener: mocks.appPrependListener,
    quit: mocks.appQuit,
    exit: mocks.appExit,
    whenReady: mocks.appWhenReady,
    isReady: mocks.appIsReady,
  },
  autoUpdater: {
    on: mocks.autoUpdaterOn,
  },
  session: {
    defaultSession: {
      setUserAgent: mocks.setUserAgent,
    },
  },
}))

import { createAppLifecycleController } from './app-lifecycle'

function createTestOptions(overrides?: Record<string, unknown>) {
  return {
    isDev: false,
    systemUserAgent: 'TestAgent/1.0',
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    onReady: vi.fn(),
    onSecondInstance: vi.fn(),
    onActivate: vi.fn(),
    onBeforeQuit: vi.fn(),
    onWillQuit: vi.fn(),
    ...overrides,
  }
}

function getRegisteredHandler(eventName: string): EventHandler {
  const call = mocks.appOn.mock.calls.find(
    ([name]: [string]) => name === eventName,
  )
  if (!call) {
    throw new Error(`No handler registered for event: ${eventName}`)
  }
  return call[1] as EventHandler
}

function getAutoUpdaterHandler(eventName: string): EventHandler {
  const call = mocks.autoUpdaterOn.mock.calls.find(
    ([name]: [string]) => name === eventName,
  )
  if (!call) {
    throw new Error(`No autoUpdater handler registered for event: ${eventName}`)
  }
  return call[1] as EventHandler
}

describe('app-lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    mocks.appWhenReady.mockReturnValue(new Promise(() => {}))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('macOS 自动更新退出回归', () => {
    it('before-quit-for-update 后应立即放行窗口关闭，但仍执行统一退出清理', async () => {
      let resolveCleanup!: () => void
      const cleanupPromise = new Promise<void>((resolve) => {
        resolveCleanup = resolve
      })
      const onBeforeQuit = vi.fn(() => cleanupPromise)
      const onExitGuard = vi.fn(async () => 'cancel' as const)
      const options = createTestOptions({ onBeforeQuit, onExitGuard })

      const controller = createAppLifecycleController(options)
      controller.start()

      getAutoUpdaterHandler('before-quit-for-update')()

      // 更新器先关闭窗口、后触发 app.before-quit；此间窗口必须看到 quitting=true，
      // 才不会被 macOS 托盘策略改成 hide。
      expect(controller.isQuitting()).toBe(true)

      const preventDefault = vi.fn()
      getRegisteredHandler('before-quit')({ preventDefault })

      expect(preventDefault).toHaveBeenCalledTimes(1)
      expect(onExitGuard).not.toHaveBeenCalled()
      expect(onBeforeQuit).toHaveBeenCalledTimes(1)
      expect(mocks.appQuit).not.toHaveBeenCalled()

      resolveCleanup()
      await vi.waitFor(() => {
        expect(mocks.appQuit).toHaveBeenCalledTimes(1)
      })
    })

    it('普通退出仍执行退出守卫，不受更新退出旁路影响', async () => {
      const onBeforeQuit = vi.fn(() => Promise.resolve())
      const onExitGuard = vi.fn(async () => 'cancel' as const)
      const options = createTestOptions({ onBeforeQuit, onExitGuard })

      const controller = createAppLifecycleController(options)
      controller.start()

      getRegisteredHandler('before-quit')({ preventDefault: vi.fn() })
      await vi.waitFor(() => {
        expect(onExitGuard).toHaveBeenCalledTimes(1)
      })

      expect(controller.isQuitting()).toBe(false)
      expect(onBeforeQuit).not.toHaveBeenCalled()
      expect(mocks.appQuit).not.toHaveBeenCalled()
    })
  })

  describe('SC-001 回归：before-quit async 拦截模式', () => {
    it('before-quit 应当 preventDefault 并异步等待 onBeforeQuit 完成后再 app.quit()', async () => {
      let resolveCleanup!: () => void
      const cleanupPromise = new Promise<void>((resolve) => {
        resolveCleanup = resolve
      })
      const onBeforeQuit = vi.fn(() => cleanupPromise)
      const options = createTestOptions({ onBeforeQuit })

      const controller = createAppLifecycleController(options)
      controller.start()

      const beforeQuitHandler = getRegisteredHandler('before-quit')
      const preventDefault = vi.fn()

      beforeQuitHandler({ preventDefault })

      expect(preventDefault).toHaveBeenCalledTimes(1)
      expect(controller.isQuitting()).toBe(true)
      expect(mocks.appQuit).not.toHaveBeenCalled()

      resolveCleanup()
      await vi.waitFor(() => {
        expect(mocks.appQuit).toHaveBeenCalledTimes(1)
      })
    })

    it('before-quit 清理异常时仍然调用 app.quit() 不阻塞退出', async () => {
      const onBeforeQuit = vi.fn(() => Promise.reject(new Error('cleanup failed')))
      const options = createTestOptions({ onBeforeQuit })

      const controller = createAppLifecycleController(options)
      controller.start()

      const beforeQuitHandler = getRegisteredHandler('before-quit')
      const preventDefault = vi.fn()

      beforeQuitHandler({ preventDefault })

      await vi.waitFor(() => {
        expect(mocks.appQuit).toHaveBeenCalledTimes(1)
      })
      expect(options.log.error).toHaveBeenCalledWith(
        'before-quit 清理异常:',
        expect.any(Error),
      )
    })

    it('before-quit 清理超时（10s）后强制调用 app.quit()', async () => {
      const onBeforeQuit = vi.fn(() => new Promise<void>(() => {}))
      const options = createTestOptions({ onBeforeQuit })

      const controller = createAppLifecycleController(options)
      controller.start()

      const beforeQuitHandler = getRegisteredHandler('before-quit')
      const preventDefault = vi.fn()

      beforeQuitHandler({ preventDefault })

      expect(mocks.appQuit).not.toHaveBeenCalled()

      vi.advanceTimersByTime(10_000)

      expect(mocks.appQuit).toHaveBeenCalledTimes(1)
      expect(options.log.error).toHaveBeenCalledWith(
        expect.stringContaining('清理超时'),
      )
    })

    it('重复触发 before-quit（第二次由 app.quit() 触发）时直接跳过不阻塞', () => {
      const onBeforeQuit = vi.fn(() => Promise.resolve())
      const options = createTestOptions({ onBeforeQuit })

      const controller = createAppLifecycleController(options)
      controller.start()

      const beforeQuitHandler = getRegisteredHandler('before-quit')
      const preventDefault1 = vi.fn()
      const preventDefault2 = vi.fn()

      beforeQuitHandler({ preventDefault: preventDefault1 })

      expect(preventDefault1).toHaveBeenCalledTimes(1)
      expect(controller.isQuitting()).toBe(true)

      beforeQuitHandler({ preventDefault: preventDefault2 })

      expect(preventDefault2).not.toHaveBeenCalled()
      expect(onBeforeQuit).toHaveBeenCalledTimes(1)
    })
  })

  describe('W2.5 T9 onExitGuard：退出守卫拦截', () => {
    // 守卫场景的 onExitGuard 是真实 async；切到 real timers 让 microtask 与 setTimeout 都按真实时序跑
    beforeEach(() => {
      vi.useRealTimers()
      vi.clearAllMocks()
      mocks.appWhenReady.mockReturnValue(new Promise(() => {}))
    })

    /** 用 setImmediate 等待所有 microtask 跑完（不会被 vi.useFakeTimers 影响） */
    const flushMicrotasks = () => new Promise<void>((resolve) => setImmediate(resolve))

    it('onExitGuard=continue 时正常进入清理 + app.quit()', async () => {
      const onBeforeQuit = vi.fn(() => Promise.resolve())
      const onExitGuard = vi.fn(async () => 'continue' as const)
      const options = createTestOptions({ onBeforeQuit, onExitGuard })

      const controller = createAppLifecycleController(options)
      controller.start()

      const beforeQuitHandler = getRegisteredHandler('before-quit')
      const preventDefault = vi.fn()
      beforeQuitHandler({ preventDefault })

      // exit-guard 正在运行时 isQuitting 仍为 false（用户可能 cancel）
      expect(preventDefault).toHaveBeenCalledTimes(1)
      expect(controller.isQuitting()).toBe(false)

      await flushMicrotasks()
      await flushMicrotasks()

      expect(onExitGuard).toHaveBeenCalledTimes(1)
      expect(controller.isQuitting()).toBe(true)
      expect(onBeforeQuit).toHaveBeenCalledTimes(1)
      expect(mocks.appQuit).toHaveBeenCalledTimes(1)
    })

    it('onExitGuard=cancel 时阻止退出，isQuitting 保持 false', async () => {
      const onBeforeQuit = vi.fn(() => Promise.resolve())
      const onExitGuard = vi.fn(async () => 'cancel' as const)
      const options = createTestOptions({ onBeforeQuit, onExitGuard })

      const controller = createAppLifecycleController(options)
      controller.start()

      const beforeQuitHandler = getRegisteredHandler('before-quit')
      const preventDefault = vi.fn()
      beforeQuitHandler({ preventDefault })

      expect(preventDefault).toHaveBeenCalledTimes(1)

      await flushMicrotasks()
      await flushMicrotasks()

      expect(onExitGuard).toHaveBeenCalledTimes(1)
      expect(controller.isQuitting()).toBe(false)
      expect(onBeforeQuit).not.toHaveBeenCalled()
      expect(mocks.appQuit).not.toHaveBeenCalled()
      expect(options.log.info).toHaveBeenCalledWith(expect.stringContaining('用户取消退出'))
    })

    it('onExitGuard 抛错时降级为 continue，仍然退出', async () => {
      const onBeforeQuit = vi.fn(() => Promise.resolve())
      const onExitGuard = vi.fn(async () => { throw new Error('guard crashed') })
      const options = createTestOptions({ onBeforeQuit, onExitGuard })

      const controller = createAppLifecycleController(options)
      controller.start()

      const beforeQuitHandler = getRegisteredHandler('before-quit')
      const preventDefault = vi.fn()
      beforeQuitHandler({ preventDefault })

      await flushMicrotasks()
      await flushMicrotasks()

      expect(onExitGuard).toHaveBeenCalledTimes(1)
      expect(options.log.error).toHaveBeenCalledWith(
        'exit-guard 异常，降级 continue:',
        expect.any(Error),
      )
      expect(onBeforeQuit).toHaveBeenCalledTimes(1)
      expect(mocks.appQuit).toHaveBeenCalledTimes(1)
    })

    it('onExitGuard=cancel 后下一次 before-quit 仍能重新询问', async () => {
      let cancelOnce = true
      const onExitGuard = vi.fn(async () => (cancelOnce ? 'cancel' as const : 'continue' as const))
      const onBeforeQuit = vi.fn(() => Promise.resolve())
      const options = createTestOptions({ onBeforeQuit, onExitGuard })

      const controller = createAppLifecycleController(options)
      controller.start()

      const beforeQuitHandler = getRegisteredHandler('before-quit')

      // 第一次：cancel
      beforeQuitHandler({ preventDefault: vi.fn() })
      await flushMicrotasks()
      await flushMicrotasks()
      expect(onExitGuard).toHaveBeenCalledTimes(1)
      expect(controller.isQuitting()).toBe(false)

      // 第二次：用户改主意，continue
      cancelOnce = false
      beforeQuitHandler({ preventDefault: vi.fn() })
      await flushMicrotasks()
      await flushMicrotasks()
      expect(onExitGuard).toHaveBeenCalledTimes(2)
      expect(mocks.appQuit).toHaveBeenCalledTimes(1)
    })
  })

  describe('dev 模式退出：清理完成后 app.exit(0) 硬退出（跳过 Chromium 原生 teardown）', () => {
    it('isDev=true 时正常完成走 app.exit(0)，不走 app.quit()', async () => {
      const onBeforeQuit = vi.fn(() => Promise.resolve())
      const options = createTestOptions({ isDev: true, onBeforeQuit })

      const controller = createAppLifecycleController(options)
      controller.start()

      const beforeQuitHandler = getRegisteredHandler('before-quit')
      beforeQuitHandler({ preventDefault: vi.fn() })

      await vi.waitFor(() => {
        expect(mocks.appExit).toHaveBeenCalledTimes(1)
      })
      expect(mocks.appExit).toHaveBeenCalledWith(0)
      expect(mocks.appQuit).not.toHaveBeenCalled()
    })

    it('isDev=true 清理超时（5s）后也走 app.exit(0)', () => {
      const onBeforeQuit = vi.fn(() => new Promise<void>(() => {}))
      const options = createTestOptions({ isDev: true, onBeforeQuit })

      const controller = createAppLifecycleController(options)
      controller.start()

      const beforeQuitHandler = getRegisteredHandler('before-quit')
      beforeQuitHandler({ preventDefault: vi.fn() })

      expect(mocks.appExit).not.toHaveBeenCalled()

      vi.advanceTimersByTime(5_000)

      expect(mocks.appExit).toHaveBeenCalledWith(0)
      expect(mocks.appQuit).not.toHaveBeenCalled()
      expect(options.log.error).toHaveBeenCalledWith(
        expect.stringContaining('清理超时'),
      )
    })
  })

  describe('#4449 回归：activate 在 app ready 前触发不建窗口（screen 崩溃防护）', () => {
    it('app 未 ready 时收到 activate 应忽略 onActivate（避免 screen 模块崩溃）', () => {
      mocks.appIsReady.mockReturnValue(false)
      const options = createTestOptions()

      const controller = createAppLifecycleController(options)
      controller.start()

      getRegisteredHandler('activate')()

      expect(options.onActivate).not.toHaveBeenCalled()
      expect(options.log.warn).toHaveBeenCalledWith(
        expect.stringContaining('activate 在 app ready 前触发'),
      )
    })

    it('app 已 ready 时收到 activate 正常调用 onActivate', () => {
      mocks.appIsReady.mockReturnValue(true)
      const options = createTestOptions()

      const controller = createAppLifecycleController(options)
      controller.start()

      getRegisteredHandler('activate')()

      expect(options.onActivate).toHaveBeenCalledTimes(1)
    })
  })

  describe('SC-006 回归：同步 onBeforeQuit 也能正常退出', () => {
    it('onBeforeQuit 返回 void（同步）时也能正常完成退出', async () => {
      const onBeforeQuit = vi.fn()
      const options = createTestOptions({ onBeforeQuit })

      const controller = createAppLifecycleController(options)
      controller.start()

      const beforeQuitHandler = getRegisteredHandler('before-quit')
      const preventDefault = vi.fn()

      beforeQuitHandler({ preventDefault })

      await vi.waitFor(() => {
        expect(mocks.appQuit).toHaveBeenCalledTimes(1)
      })
    })
  })
})
