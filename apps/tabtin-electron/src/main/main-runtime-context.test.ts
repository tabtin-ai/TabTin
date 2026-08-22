import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const appearanceSync = {
    getBackgroundColor: vi.fn(() => '#F5F3F0'),
  }
  const mainWindowRuntime = {
    appearanceSync,
    windowAppearanceRuntime: {
      registerWindowForAppearanceSync: vi.fn(),
      getCurrentAppearance: vi.fn(),
      applyAppearance: vi.fn(),
    },
    runtimeServices: {
      getUpdateManager: vi.fn(),
      startBackgroundServices: vi.fn(),
      stop: vi.fn(),
    },
    mainWindowRegistry: {
      createAndRegister: vi.fn(),
      ensureForNotification: vi.fn(),
      restoreMainWindow: vi.fn(),
    },
    getPrimaryWindow: vi.fn(),
  }
  const detachedIMWindowController = {
    open: vi.fn(() => 'im-window'),
    getWindow: vi.fn(),
    close: vi.fn(),
  }
  const ipcDependencies = {
    getUpdateManager: vi.fn(),
    getCapabilityDiscoveryService: vi.fn(),
    getCurrentAppearance: vi.fn(),
    getPrimaryWindow: vi.fn(),
    applyAppearance: vi.fn(),
  }
  const lifecycleHandlers = {
    onReady: vi.fn(),
    onActivate: vi.fn(),
    onBeforeQuit: vi.fn(),
  }

  return {
    appearanceSync,
    mainWindowRuntime,
    detachedIMWindowController,
    ipcDependencies,
    lifecycleHandlers,
    createMainWindowRuntimeContext: vi.fn(() => mainWindowRuntime),
    createDetachedIMWindowController: vi.fn(() => detachedIMWindowController),
    createMainRuntimeIpcDependencies: vi.fn(() => ipcDependencies),
    createMainAppLifecycleHandlers: vi.fn(() => lifecycleHandlers),
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  }
})

vi.mock('./main-window-runtime', () => ({
  createMainWindowRuntimeContext: mocks.createMainWindowRuntimeContext,
}))

vi.mock('./im-window', () => ({
  createDetachedIMWindowController: mocks.createDetachedIMWindowController,
}))

vi.mock('./main-runtime-ipc-dependencies', () => ({
  createMainRuntimeIpcDependencies: mocks.createMainRuntimeIpcDependencies,
}))

vi.mock('./main-app-handlers', () => ({
  createMainAppLifecycleHandlers: mocks.createMainAppLifecycleHandlers,
}))

import { createMainRuntimeContext } from './main-runtime-context'

describe('main-runtime-context', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('会组合主窗口运行时和 IPC 依赖', () => {
    const getCapabilityDiscoveryService = vi.fn(() => ({ id: 'capability-service' }))
    const onMainWindowReady = vi.fn()
    const getMainWindow = vi.fn(() => null)

    const runtimeContext = createMainRuntimeContext({
      icon: 'icon.png',
      isDev: true,
      rendererUrl: 'http://localhost:5173',
      rendererVerbose: true,
      displayMediaTrustedOrigins: ['http://localhost:5173'],
      log: mocks.log,
      getMainWindow,
      getCapabilityDiscoveryService,
      isQuitting: () => false,
      onMainWindowReady,
    })

    expect(runtimeContext.lifecycleHandlers).toBe(mocks.lifecycleHandlers)
    expect(runtimeContext.mainWindowRegistry).toBe(mocks.mainWindowRuntime.mainWindowRegistry)
    expect(mocks.createMainWindowRuntimeContext).toHaveBeenCalledWith({
      icon: 'icon.png',
      isDev: true,
      rendererUrl: 'http://localhost:5173',
      rendererVerbose: true,
      log: mocks.log,
      getMainWindow,
      isQuitting: expect.any(Function),
      onMainWindowReady,
    })
    expect(mocks.createDetachedIMWindowController).toHaveBeenCalledWith({
      isDev: true,
      rendererUrl: 'http://localhost:5173',
      log: mocks.log,
      getBackgroundColor: mocks.appearanceSync.getBackgroundColor,
    })
    expect(mocks.createMainRuntimeIpcDependencies).toHaveBeenCalledWith({
      mainWindowRuntime: mocks.mainWindowRuntime,
      openIMWindow: expect.any(Function),
      getCapabilityDiscoveryService,
    })
    expect(mocks.createMainAppLifecycleHandlers).toHaveBeenCalledWith({
      isDev: true,
      rendererUrl: 'http://localhost:5173',
      displayMediaTrustedOrigins: ['http://localhost:5173'],
      log: mocks.log,
      ipcDependencies: mocks.ipcDependencies,
      mainWindowRegistry: mocks.mainWindowRuntime.mainWindowRegistry,
      runtimeServices: mocks.mainWindowRuntime.runtimeServices,
    })
  })
})
