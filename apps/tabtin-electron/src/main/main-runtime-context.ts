import type { BrowserWindow } from 'electron'
import { createMainAppLifecycleHandlers, type MainAppLifecycleHandlers } from './main-app-handlers'
import { createDetachedIMWindowController } from './im-window'
import { createMainRuntimeIpcDependencies } from './main-runtime-ipc-dependencies'
import { createMainWindowRuntimeContext } from './main-window-runtime'
import type { CapabilityDiscoveryService } from './services/CapabilityDiscoveryService'
import type { MainWindowLogger } from './main-window'
import type { MainWindowRegistry } from './main-window-registry'

export interface MainRuntimeContextLogger extends MainWindowLogger {}

export interface MainRuntimeContextOptions {
  icon: string
  isDev: boolean
  rendererUrl?: string
  rendererVerbose: boolean
  displayMediaTrustedOrigins?: string[]
  log: MainRuntimeContextLogger
  getMainWindow: () => BrowserWindow | null
  getCapabilityDiscoveryService: () => CapabilityDiscoveryService
  isQuitting: () => boolean
  onMainWindowReady?: () => void
  /**
   * 关窗口前置守卫（W2.5 T9）。透传给 createMainWindowRuntimeContext → createMainWindow。
   */
  onExitGuard?: () => Promise<'continue' | 'cancel'>
  /** 托盘常驻，透传给 createMainWindowRuntimeContext */
  shouldHideToTray?: () => boolean
  shouldHideToTrayOnMinimize?: () => boolean
  onHiddenToTray?: () => void
}

export interface MainRuntimeContext {
  lifecycleHandlers: MainAppLifecycleHandlers
  mainWindowRegistry: MainWindowRegistry
}

export function createMainRuntimeContext(
  options: MainRuntimeContextOptions,
): MainRuntimeContext {
  const mainWindowRuntime = createMainWindowRuntimeContext({
    icon: options.icon,
    isDev: options.isDev,
    rendererUrl: options.rendererUrl,
    rendererVerbose: options.rendererVerbose,
    log: options.log,
    getMainWindow: options.getMainWindow,
    isQuitting: options.isQuitting,
    onMainWindowReady: options.onMainWindowReady,
    onExitGuard: options.onExitGuard,
    shouldHideToTray: options.shouldHideToTray,
    shouldHideToTrayOnMinimize: options.shouldHideToTrayOnMinimize,
    onHiddenToTray: options.onHiddenToTray,
  })

  const detachedIMWindowController = createDetachedIMWindowController({
    isDev: options.isDev,
    rendererUrl: options.rendererUrl,
    log: options.log,
    getBackgroundColor: mainWindowRuntime.appearanceSync.getBackgroundColor,
  })

  const openIMWindow = (): BrowserWindow => {
    const window = detachedIMWindowController.open()
    mainWindowRuntime.windowAppearanceRuntime.registerWindowForAppearanceSync(window)
    return window
  }

  const lifecycleHandlers = createMainAppLifecycleHandlers({
    isDev: options.isDev,
    rendererUrl: options.rendererUrl,
    displayMediaTrustedOrigins: options.displayMediaTrustedOrigins,
    log: options.log,
    ipcDependencies: createMainRuntimeIpcDependencies({
      mainWindowRuntime,
      openIMWindow,
      getCapabilityDiscoveryService: options.getCapabilityDiscoveryService,
    }),
    mainWindowRegistry: mainWindowRuntime.mainWindowRegistry,
    runtimeServices: mainWindowRuntime.runtimeServices,
  })

  return {
    lifecycleHandlers,
    mainWindowRegistry: mainWindowRuntime.mainWindowRegistry,
  }
}
