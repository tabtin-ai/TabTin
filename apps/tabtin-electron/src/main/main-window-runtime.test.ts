import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const focusedWindow = { id: 'focused-window' }
  const fallbackWindow = { id: 'fallback-window' }
  const mainWindowSend = vi.fn()
  const appearanceSync = {
    getCurrentAppearance: vi.fn(() => 'system'),
    setCurrentAppearance: vi.fn(),
    getBackgroundColor: vi.fn(() => '#F5F3F0'),
    applyAppearanceToWebContents: vi.fn(),
    ensureWebContentsThemeSync: vi.fn(),
    cleanupWebContentsThemeSync: vi.fn(),
    applyAppearanceToAllCrawlViews: vi.fn(),
    applyBackgroundForAppearance: vi.fn(),
  }
  const shortcutController = {
    registerGuard: vi.fn(),
    cleanupGuard: vi.fn(),
  }
  const runtimeServices = {
    getUpdateManager: vi.fn(() => 'update-manager'),
    handleMainWindowRegistered: vi.fn(),
    handleMainWindowDidFinishLoad: vi.fn(),
    startBackgroundServices: vi.fn(),
    stop: vi.fn(),
  }
  const windowAppearanceRuntime = {
    getCurrentAppearance: vi.fn(() => 'system'),
    applyAppearance: vi.fn(),
    registerWindowForAppearanceSync: vi.fn(),
  }
  const ensureMainWindowReady = vi.fn()
  const mainWindowRegistry = {
    createAndRegister: vi.fn(),
    ensureReady: ensureMainWindowReady,
    ensureForNotification: ensureMainWindowReady,
  }
  const createdMainWindow = { id: 'created-main-window' }

  return {
    focusedWindow,
    fallbackWindow,
    mainWindowSend,
    appearanceSync,
    shortcutController,
    runtimeServices,
    windowAppearanceRuntime,
    mainWindowRegistry,
    createdMainWindow,
    getFocusedWindow: vi.fn(() => focusedWindow),
    getAllWindows: vi.fn(() => [fallbackWindow]),
    createAppearanceSyncController: vi.fn(() => appearanceSync),
    createContextSpaceShortcutController: vi.fn(() => shortcutController),
    createMainRuntimeServicesController: vi.fn(() => runtimeServices),
    createMainWindowRegistry: vi.fn(() => mainWindowRegistry),
    createMainWindow: vi.fn(() => createdMainWindow),
    createWindowAppearanceRuntime: vi.fn(() => windowAppearanceRuntime),
    setMainWindowEnsurer: vi.fn(),
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  }
})

vi.mock('electron', () => ({
  BrowserWindow: {
    getFocusedWindow: mocks.getFocusedWindow,
    getAllWindows: mocks.getAllWindows,
  },
}))

vi.mock('./appearance-sync', () => ({
  createAppearanceSyncController: mocks.createAppearanceSyncController,
}))

vi.mock('./context-space-shortcuts', () => ({
  createContextSpaceShortcutController: mocks.createContextSpaceShortcutController,
}))

vi.mock('./main-runtime-services', () => ({
  createMainRuntimeServicesController: mocks.createMainRuntimeServicesController,
}))

vi.mock('./main-window-registry', () => ({
  createMainWindowRegistry: mocks.createMainWindowRegistry,
}))

vi.mock('./main-window', () => ({
  createMainWindow: mocks.createMainWindow,
}))

vi.mock('./window-appearance-runtime', () => ({
  createWindowAppearanceRuntime: mocks.createWindowAppearanceRuntime,
}))

vi.mock('./window-manager', () => ({
  setMainWindowEnsurer: mocks.setMainWindowEnsurer,
}))

import { createMainWindowRuntimeContext } from './main-window-runtime'

describe('main-window-runtime', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getFocusedWindow.mockReturnValue(mocks.focusedWindow)
    mocks.getAllWindows.mockReturnValue([mocks.fallbackWindow])
  })

  it('会组装主窗口、外观同步和运行时服务', () => {
    const mainWindow = {
      isDestroyed: () => false,
      webContents: {
        send: mocks.mainWindowSend,
      },
    }
    const onMainWindowReady = vi.fn()

    const context = createMainWindowRuntimeContext({
      icon: 'icon.png',
      isDev: true,
      rendererUrl: 'http://localhost:5173',
      rendererVerbose: true,
      log: mocks.log,
      getMainWindow: () => mainWindow as any,
      isQuitting: () => false,
      onMainWindowReady,
    })

    expect(context.appearanceSync).toBe(mocks.appearanceSync)
    expect(context.windowAppearanceRuntime).toBe(mocks.windowAppearanceRuntime)
    expect(context.runtimeServices).toBe(mocks.runtimeServices)
    expect(context.mainWindowRegistry).toBe(mocks.mainWindowRegistry)
    expect(context.getPrimaryWindow()).toBe(mocks.focusedWindow)

    const shortcutOptions = mocks.createContextSpaceShortcutController.mock.calls[0]?.[0]
    shortcutOptions.emitShortcut('refresh')
    expect(mocks.mainWindowSend).toHaveBeenCalledWith('context-space:shortcut', {
      action: 'refresh',
    })

    expect(mocks.createWindowAppearanceRuntime).toHaveBeenCalledWith({
      appearanceSync: mocks.appearanceSync,
    })

    expect(mocks.createMainRuntimeServicesController).toHaveBeenCalledWith({
      isDev: true,
      log: mocks.log,
      getCurrentAppearance: mocks.appearanceSync.getCurrentAppearance,
      isQuitting: expect.any(Function),
      registerContextSpaceShortcutGuard: mocks.shortcutController.registerGuard,
      cleanupContextSpaceShortcutGuard: mocks.shortcutController.cleanupGuard,
      ensureWebContentsThemeSync: mocks.appearanceSync.ensureWebContentsThemeSync,
      cleanupWebContentsThemeSync: mocks.appearanceSync.cleanupWebContentsThemeSync,
      applyAppearanceToWebContents: mocks.appearanceSync.applyAppearanceToWebContents,
      onMainWindowReady,
    })

    const registryOptions = mocks.createMainWindowRegistry.mock.calls[0]?.[0]
    expect(registryOptions).toBeTruthy()
    expect(registryOptions.registerContextSpaceShortcutGuard).toBe(
      mocks.shortcutController.registerGuard,
    )
    expect(registryOptions.onMainWindowRegistered).toBe(
      mocks.runtimeServices.handleMainWindowRegistered,
    )
    expect(registryOptions.onMainWindowDidFinishLoad).toBe(
      mocks.runtimeServices.handleMainWindowDidFinishLoad,
    )
    expect(mocks.setMainWindowEnsurer).toHaveBeenCalledWith(
      mocks.mainWindowRegistry.ensureReady,
    )

    expect(registryOptions.createWindow()).toBe(mocks.createdMainWindow)
    expect(mocks.windowAppearanceRuntime.registerWindowForAppearanceSync).toHaveBeenCalledWith(
      mocks.createdMainWindow,
    )
    expect(mocks.createMainWindow).toHaveBeenCalledWith({
      icon: 'icon.png',
      isDev: true,
      rendererUrl: 'http://localhost:5173',
      rendererVerbose: true,
      log: mocks.log,
      getBackgroundColor: mocks.appearanceSync.getBackgroundColor,
      isQuitting: expect.any(Function),
    })
  })

  it('没有聚焦窗口时会回退到第一个窗口，并忽略已销毁主窗口的 shortcut 发送', () => {
    mocks.getFocusedWindow.mockReturnValueOnce(null)
    mocks.getAllWindows.mockReturnValueOnce([mocks.fallbackWindow])

    const context = createMainWindowRuntimeContext({
      icon: 'icon.png',
      isDev: false,
      rendererVerbose: false,
      log: mocks.log,
      getMainWindow: () => ({
        isDestroyed: () => true,
        webContents: {
          send: mocks.mainWindowSend,
        },
      } as any),
      isQuitting: () => false,
    })

    expect(context.getPrimaryWindow()).toBe(mocks.fallbackWindow)

    const shortcutOptions = mocks.createContextSpaceShortcutController.mock.calls[0]?.[0]
    shortcutOptions.emitShortcut('refresh')
    expect(mocks.mainWindowSend).not.toHaveBeenCalled()
  })
})
