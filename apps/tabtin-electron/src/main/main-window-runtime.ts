import { BrowserWindow } from 'electron'

import {
  createAppearanceSyncController,
  type AppearanceSyncController,
} from './appearance-sync'
import { createContextSpaceShortcutController } from './context-space-shortcuts'
import { createMainWindow, type MainWindowLogger } from './main-window'
import {
  createMainRuntimeServicesController,
  type MainRuntimeServicesController,
} from './main-runtime-services'
import {
  createMainWindowRegistry,
  type MainWindowRegistry,
} from './main-window-registry'
import {
  createWindowAppearanceRuntime,
  type WindowAppearanceRuntime,
} from './window-appearance-runtime'
import { setMainWindowEnsurer } from './window-manager'

export interface MainWindowRuntimeLogger extends MainWindowLogger {}

export interface MainWindowRuntimeOptions {
  icon: string
  isDev: boolean
  rendererUrl?: string
  rendererVerbose: boolean
  log: MainWindowRuntimeLogger
  getMainWindow: () => BrowserWindow | null
  isQuitting: () => boolean
  onMainWindowReady?: () => void
  /**
   * 关窗口前置守卫（W2.5 T9）。透传给 createMainWindow。
   * 见 main-window.ts CreateMainWindowOptions.onExitGuard 注释。
   */
  onExitGuard?: () => Promise<'continue' | 'cancel'>
  /** 托盘常驻，透传给 createMainWindow */
  shouldHideToTray?: () => boolean
  shouldHideToTrayOnMinimize?: () => boolean
  onHiddenToTray?: () => void
}

export interface MainWindowRuntimeContext {
  appearanceSync: AppearanceSyncController
  windowAppearanceRuntime: WindowAppearanceRuntime
  runtimeServices: MainRuntimeServicesController
  mainWindowRegistry: MainWindowRegistry
  getPrimaryWindow: () => BrowserWindow | null
}

export function createMainWindowRuntimeContext(
  options: MainWindowRuntimeOptions,
): MainWindowRuntimeContext {
  const appearanceSync = createAppearanceSyncController()
  const windowAppearanceRuntime = createWindowAppearanceRuntime({
    appearanceSync,
  })

  const getPrimaryWindow = (): BrowserWindow | null => {
    return BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null
  }

  const contextSpaceShortcuts = createContextSpaceShortcutController({
    emitShortcut: (action) => {
      const mainWindow = options.getMainWindow()
      if (!mainWindow || mainWindow.isDestroyed()) {
        return
      }
      mainWindow.webContents.send('context-space:shortcut', { action })
    },
  })

  const runtimeServices = createMainRuntimeServicesController({
    isDev: options.isDev,
    log: options.log,
    getCurrentAppearance: appearanceSync.getCurrentAppearance,
    isQuitting: options.isQuitting,
    registerContextSpaceShortcutGuard: contextSpaceShortcuts.registerGuard,
    cleanupContextSpaceShortcutGuard: contextSpaceShortcuts.cleanupGuard,
    ensureWebContentsThemeSync: appearanceSync.ensureWebContentsThemeSync,
    cleanupWebContentsThemeSync: appearanceSync.cleanupWebContentsThemeSync,
    applyAppearanceToWebContents: appearanceSync.applyAppearanceToWebContents,
    onMainWindowReady: options.onMainWindowReady,
  })

  const createWindow = (): BrowserWindow => {
    return createMainWindow({
      icon: options.icon,
      isDev: options.isDev,
      rendererUrl: options.rendererUrl,
      rendererVerbose: options.rendererVerbose,
      log: options.log,
      getBackgroundColor: appearanceSync.getBackgroundColor,
      isQuitting: options.isQuitting,
      onExitGuard: options.onExitGuard,
      shouldHideToTray: options.shouldHideToTray,
      shouldHideToTrayOnMinimize: options.shouldHideToTrayOnMinimize,
      onHiddenToTray: options.onHiddenToTray,
    })
  }

  const mainWindowRegistry = createMainWindowRegistry({
    createWindow: () => {
      const window = createWindow()
      windowAppearanceRuntime.registerWindowForAppearanceSync(window)
      return window
    },
    registerContextSpaceShortcutGuard: contextSpaceShortcuts.registerGuard,
    onMainWindowRegistered: runtimeServices.handleMainWindowRegistered,
    onMainWindowDidFinishLoad: runtimeServices.handleMainWindowDidFinishLoad,
  })
  setMainWindowEnsurer(mainWindowRegistry.ensureReady)

  return {
    appearanceSync,
    windowAppearanceRuntime,
    runtimeServices,
    mainWindowRegistry,
    getPrimaryWindow,
  }
}
