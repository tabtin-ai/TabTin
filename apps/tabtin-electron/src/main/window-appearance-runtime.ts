import { BrowserWindow, nativeTheme } from 'electron'

import {
  readAppearanceThemeSnapshot,
  type AppearanceThemeSnapshot,
} from './appearance-theme-snapshot'
import type { AppearanceSyncController } from './appearance-sync'
import { createLogger } from './logger'
import type { MainWindowAppearance } from './types/runtime'

const log = createLogger('Appearance')

export const NATIVE_THEME_UPDATED_CHANNEL = 'appearance:native-theme-updated'

// 模块级追踪：确保工厂多次调用时不累积 nativeTheme 监听器
let _registeredNativeThemeListener: (() => void) | null = null

export interface WindowAppearanceRuntime {
  getCurrentAppearance: () => MainWindowAppearance
  applyAppearance: (appearance: MainWindowAppearance) => AppearanceThemeSnapshot
  registerWindowForAppearanceSync: (window: BrowserWindow) => void
}

export interface WindowAppearanceRuntimeOptions {
  appearanceSync: Pick<
    AppearanceSyncController,
    | 'getCurrentAppearance'
    | 'setCurrentAppearance'
    | 'applyBackgroundForAppearance'
    | 'applyAppearanceToAllCrawlViews'
  >
  /** 可注入，便于单测断言广播 */
  broadcastNativeThemeUpdated?: (snapshot: AppearanceThemeSnapshot) => void
}

function defaultBroadcastNativeThemeUpdated(snapshot: AppearanceThemeSnapshot): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue
    try {
      window.webContents.send(NATIVE_THEME_UPDATED_CHANNEL, snapshot)
    } catch {
      // 窗口销毁竞态：忽略
    }
  }
}

export function createWindowAppearanceRuntime(
  options: WindowAppearanceRuntimeOptions,
): WindowAppearanceRuntime {
  const managedWindows = new Set<BrowserWindow>()
  const windowsWithCloseHook = new WeakSet<BrowserWindow>()
  const broadcast =
    options.broadcastNativeThemeUpdated ?? defaultBroadcastNativeThemeUpdated

  const pruneDestroyedWindows = (): void => {
    for (const window of managedWindows) {
      if (window.isDestroyed()) {
        managedWindows.delete(window)
      }
    }
  }

  const applyAppearanceToManagedWindows = (appearance: MainWindowAppearance): void => {
    pruneDestroyedWindows()
    for (const window of managedWindows) {
      options.appearanceSync.applyBackgroundForAppearance(window, appearance)
    }
  }

  const applyAppearance = (appearance: MainWindowAppearance): AppearanceThemeSnapshot => {
    options.appearanceSync.setCurrentAppearance(appearance)
    nativeTheme.themeSource = appearance === 'system' ? 'system' : appearance
    applyAppearanceToManagedWindows(appearance)
    options.appearanceSync.applyAppearanceToAllCrawlViews(appearance)
    const snapshot = readAppearanceThemeSnapshot(nativeTheme, appearance)
    log.info('applyAppearance', {
      appearance: snapshot.appearance,
      themeSource: snapshot.themeSource,
      shouldUseDarkColors: snapshot.shouldUseDarkColors,
      systemUiDark: snapshot.shouldUseDarkColorsForSystemIntegratedUI,
    })
    return snapshot
  }

  // 移除上一次工厂调用注册的监听器，避免多次调用造成监听器累积
  if (_registeredNativeThemeListener) {
    nativeTheme.removeListener('updated', _registeredNativeThemeListener)
    _registeredNativeThemeListener = null
  }
  const nativeThemeListener = () => {
    if (options.appearanceSync.getCurrentAppearance() !== 'system') {
      return
    }
    applyAppearanceToManagedWindows('system')
    options.appearanceSync.applyAppearanceToAllCrawlViews('system')
    const snapshot = readAppearanceThemeSnapshot(nativeTheme, 'system')
    log.info('nativeTheme updated', {
      shouldUseDarkColors: snapshot.shouldUseDarkColors,
      systemUiDark: snapshot.shouldUseDarkColorsForSystemIntegratedUI,
    })
    broadcast(snapshot)
  }
  _registeredNativeThemeListener = nativeThemeListener
  nativeTheme.on('updated', nativeThemeListener)

  return {
    getCurrentAppearance: options.appearanceSync.getCurrentAppearance,
    applyAppearance,
    registerWindowForAppearanceSync: (window) => {
      pruneDestroyedWindows()
      managedWindows.add(window)
      options.appearanceSync.applyBackgroundForAppearance(
        window,
        options.appearanceSync.getCurrentAppearance(),
      )
      if (!windowsWithCloseHook.has(window)) {
        windowsWithCloseHook.add(window)
        window.once('closed', () => {
          managedWindows.delete(window)
        })
      }
    },
  }
}
