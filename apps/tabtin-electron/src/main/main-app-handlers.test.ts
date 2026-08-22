import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getAllWindows: vi.fn(),
  getPath: vi.fn(() => '/tmp/tabtin-main-handlers'),
  initializeStartupServices: vi.fn(),
  consumePendingLocalDataWipe: vi.fn(async () => null),
  notificationDestroy: vi.fn(),
  clearMainWindow: vi.fn(),
  destroyPtyManager: vi.fn(),
  unregisterTerminalIpcHandlers: vi.fn(),
  unregisterMainProcessIPCHandlers: vi.fn(),
  flushRunningBackgroundTasksOnExit: vi.fn(),
  startupPerf: {
    sinceStart: vi.fn(),
    mark: vi.fn(),
    measure: vi.fn(),
    flush: vi.fn(),
  },
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('electron', () => ({
  app: {
    getPath: mocks.getPath,
  },
  BrowserWindow: {
    getAllWindows: mocks.getAllWindows,
  },
}))

vi.mock('./startup-services', () => ({
  initializeStartupServices: mocks.initializeStartupServices,
}))

vi.mock('./services/UninstallCleanupService', () => ({
  consumePendingLocalDataWipe: mocks.consumePendingLocalDataWipe,
}))

vi.mock('./services/notification', () => ({
  notificationService: {
    destroy: mocks.notificationDestroy,
  },
}))

vi.mock('./window-manager', () => ({
  clearMainWindow: mocks.clearMainWindow,
}))

vi.mock('./logger', () => ({
  startupPerf: mocks.startupPerf,
  createLogger: () => mocks.log,
}))

vi.mock('./terminal/PtyManager', () => ({
  destroyPtyManager: mocks.destroyPtyManager,
}))

vi.mock('./terminal/ipc', () => ({
  unregisterTerminalIpcHandlers: mocks.unregisterTerminalIpcHandlers,
}))

vi.mock('./ipc-registry', () => ({
  unregisterMainProcessIPCHandlers: mocks.unregisterMainProcessIPCHandlers,
}))

import { createMainAppLifecycleHandlers } from './main-app-handlers'

describe('main-app-handlers', () => {
  const originalAppId = process.env.TABTIN_APP_ID

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getAllWindows.mockReturnValue([])
    delete process.env.TABTIN_APP_ID
  })

  afterEach(() => {
    if (originalAppId === undefined) {
      delete process.env.TABTIN_APP_ID
    } else {
      process.env.TABTIN_APP_ID = originalAppId
    }
  })

  it('ready 时会注册启动服务并创建主窗口启动后台服务', async () => {
    const mainWindow = { id: 'main-window' }
    const createAndRegister = vi.fn(() => mainWindow)
    const ensureForNotification = vi.fn()
    const startBackgroundServices = vi.fn()
    const stop = vi.fn()

    const handlers = createMainAppLifecycleHandlers({
      isDev: true,
      rendererUrl: 'http://localhost:5173',
      displayMediaTrustedOrigins: ['http://localhost:5173'],
      log: mocks.log,
      ipcDependencies: {
        getUpdateManager: vi.fn(),
        getCapabilityDiscoveryService: vi.fn(),
        getCurrentAppearance: vi.fn(() => 'system'),
        getPrimaryWindow: vi.fn(),
        applyAppearance: vi.fn(),
      },
      mainWindowRegistry: {
        createAndRegister,
        ensureForNotification,
        restoreMainWindow: vi.fn(),
      },
      runtimeServices: {
        startBackgroundServices,
        stop,
      },
    })

    await handlers.onReady()

    expect(mocks.initializeStartupServices).toHaveBeenCalledWith(
      expect.objectContaining({
        isDev: true,
        appUserModelId: 'com.tabtin.app',
        rendererUrl: 'http://localhost:5173',
        displayMediaTrustedOrigins: ['http://localhost:5173'],
        log: mocks.log,
        ensureMainWindowForNotification: ensureForNotification,
      }),
    )
    expect(mocks.consumePendingLocalDataWipe).toHaveBeenCalledTimes(1)
    expect(mocks.initializeStartupServices.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.consumePendingLocalDataWipe.mock.invocationCallOrder[0]!,
    )
    expect(mocks.consumePendingLocalDataWipe.mock.invocationCallOrder[0]).toBeLessThan(
      createAndRegister.mock.invocationCallOrder[0]!,
    )
    expect(createAndRegister).toHaveBeenCalledTimes(1)
    expect(startBackgroundServices).toHaveBeenCalledWith(mainWindow)
    expect(mocks.startupPerf.sinceStart).toHaveBeenCalledWith('app.whenReady()')
    expect(mocks.startupPerf.mark).toHaveBeenCalledWith('IPC 注册')
    expect(mocks.startupPerf.measure).toHaveBeenCalledWith('createWindow')
  })

  it('activate 时会恢复已存在的隐藏/最小化主窗口', () => {
    const createAndRegister = vi.fn()
    const restoreMainWindow = vi.fn(() => ({
      id: 'main-window',
    }))
    const handlers = createMainAppLifecycleHandlers({
      isDev: false,
      log: mocks.log,
      ipcDependencies: {
        getUpdateManager: vi.fn(),
        getCapabilityDiscoveryService: vi.fn(),
        getCurrentAppearance: vi.fn(() => 'system'),
        getPrimaryWindow: vi.fn(),
        applyAppearance: vi.fn(),
      },
      mainWindowRegistry: {
        createAndRegister,
        ensureForNotification: vi.fn(),
        restoreMainWindow,
      },
      runtimeServices: {
        startBackgroundServices: vi.fn(),
        stop: vi.fn(),
      },
    })

    handlers.onActivate()

    expect(restoreMainWindow).toHaveBeenCalledTimes(1)
    expect(createAndRegister).not.toHaveBeenCalled()
  })

  it('activate 恢复不到窗口且没有任何窗口时会兜底补建主窗口', () => {
    const createAndRegister = vi.fn()
    const restoreMainWindow = vi.fn(() => null)
    const handlers = createMainAppLifecycleHandlers({
      isDev: false,
      log: mocks.log,
      ipcDependencies: {
        getUpdateManager: vi.fn(),
        getCapabilityDiscoveryService: vi.fn(),
        getCurrentAppearance: vi.fn(() => 'system'),
        getPrimaryWindow: vi.fn(),
        applyAppearance: vi.fn(),
      },
      mainWindowRegistry: {
        createAndRegister,
        ensureForNotification: vi.fn(),
        restoreMainWindow,
      },
      runtimeServices: {
        startBackgroundServices: vi.fn(),
        stop: vi.fn(),
      },
    })

    mocks.getAllWindows.mockReturnValueOnce([])
    handlers.onActivate()

    expect(restoreMainWindow).toHaveBeenCalledTimes(1)
    expect(createAndRegister).toHaveBeenCalledTimes(1)
  })

  it('before-quit 时会上报在线状态、关闭窗口并完成 IPC 清理', async () => {
    const executeJavaScript = vi.fn().mockResolvedValue(undefined)
    const stop = vi.fn()
    let onClosed: (() => void) | undefined
    const close = vi.fn(() => {
      onClosed?.()
    })
    const destroy = vi.fn()
    const handlers = createMainAppLifecycleHandlers({
      isDev: false,
      log: mocks.log,
      ipcDependencies: {
        getUpdateManager: vi.fn(),
        getCapabilityDiscoveryService: vi.fn(),
        getCurrentAppearance: vi.fn(() => 'system'),
        getPrimaryWindow: vi.fn(),
        applyAppearance: vi.fn(),
      },
      mainWindowRegistry: {
        createAndRegister: vi.fn(),
        ensureForNotification: vi.fn(),
        restoreMainWindow: vi.fn(),
      },
      runtimeServices: {
        startBackgroundServices: vi.fn(),
        stop,
      },
      flushRunningBackgroundTasksOnExit: mocks.flushRunningBackgroundTasksOnExit,
    })

    mocks.getAllWindows.mockReturnValue([
      {
        isDestroyed: () => false,
        once: vi.fn((event: string, cb: () => void) => {
          if (event === 'closed') onClosed = cb
        }),
        close,
        destroy,
        webContents: {
          executeJavaScript,
        },
      },
      {
        isDestroyed: () => true,
        webContents: {
          executeJavaScript: vi.fn(),
        },
      },
    ])

    await handlers.onBeforeQuit()

    expect(executeJavaScript).toHaveBeenCalledWith(
      'try { window.__tabtin_report_offline?.() } catch(e) {}',
    )
    expect(mocks.notificationDestroy).toHaveBeenCalledTimes(1)
    expect(mocks.destroyPtyManager).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
    expect(destroy).not.toHaveBeenCalled()
    expect(mocks.unregisterTerminalIpcHandlers).toHaveBeenCalledTimes(1)
    expect(mocks.unregisterMainProcessIPCHandlers).toHaveBeenCalledTimes(1)
    expect(mocks.clearMainWindow).toHaveBeenCalledTimes(1)
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('SC-001 回归：onBeforeQuit 必须 await runtimeServices.stop() 完成', async () => {
    let stopResolved = false
    const stop = vi.fn(() => new Promise<void>((resolve) => {
      setTimeout(() => {
        stopResolved = true
        resolve()
      }, 50)
    }))

    const handlers = createMainAppLifecycleHandlers({
      isDev: false,
      log: mocks.log,
      ipcDependencies: {
        getUpdateManager: vi.fn(),
        getCapabilityDiscoveryService: vi.fn(),
        getCurrentAppearance: vi.fn(() => 'system'),
        getPrimaryWindow: vi.fn(),
        applyAppearance: vi.fn(),
      },
      mainWindowRegistry: {
        createAndRegister: vi.fn(),
        ensureForNotification: vi.fn(),
        restoreMainWindow: vi.fn(),
      },
      runtimeServices: {
        startBackgroundServices: vi.fn(),
        stop,
      },
      flushRunningBackgroundTasksOnExit: mocks.flushRunningBackgroundTasksOnExit,
    })

    const promise = handlers.onBeforeQuit()

    expect(stopResolved).toBe(false)

    await promise

    expect(stopResolved).toBe(true)
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('will-quit 为空操作，清理已在 before-quit 完成', () => {
    const handlers = createMainAppLifecycleHandlers({
      isDev: false,
      log: mocks.log,
      ipcDependencies: {
        getUpdateManager: vi.fn(),
        getCapabilityDiscoveryService: vi.fn(),
        getCurrentAppearance: vi.fn(() => 'system'),
        getPrimaryWindow: vi.fn(),
        applyAppearance: vi.fn(),
      },
      mainWindowRegistry: {
        createAndRegister: vi.fn(),
        ensureForNotification: vi.fn(),
        restoreMainWindow: vi.fn(),
      },
      runtimeServices: {
        startBackgroundServices: vi.fn(),
        stop: vi.fn(),
      },
    })

    handlers.onWillQuit()

    expect(mocks.unregisterTerminalIpcHandlers).not.toHaveBeenCalled()
    expect(mocks.unregisterMainProcessIPCHandlers).not.toHaveBeenCalled()
    expect(mocks.destroyPtyManager).not.toHaveBeenCalled()
  })
})
