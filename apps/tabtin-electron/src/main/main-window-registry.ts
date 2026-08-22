import { BrowserWindow, type WebContents } from 'electron'

import type { ContextSpaceShortcutGuardOptions } from './types/runtime'
import { captureClientError } from './sentry'
import {
  clearMainWindow,
  getMainWindow,
  isMainWindowNotificationHostReady,
  setMainWindow,
  setMainWindowNotificationHostReady,
} from './window-manager'

type ShortcutGuardRegistrar = (
  webContents: WebContents,
  options?: ContextSpaceShortcutGuardOptions,
) => void

export interface MainWindowRegistry {
  register: (mainWindow: BrowserWindow) => void
  createAndRegister: () => BrowserWindow
  /** Dock / 托盘唤回：只 show/restore/focus，不新建窗口、不 loadURL */
  restoreMainWindow: () => BrowserWindow | null
  ensureReady: (signal?: AbortSignal) => Promise<BrowserWindow | null>
  ensureForNotification: (signal?: AbortSignal) => Promise<BrowserWindow | null>
}

export interface MainWindowRegistryOptions {
  createWindow: () => BrowserWindow
  registerContextSpaceShortcutGuard: ShortcutGuardRegistrar
  onMainWindowRegistered?: (mainWindow: BrowserWindow) => void
  onMainWindowDidFinishLoad: (mainWindow: BrowserWindow) => Promise<void> | void
}

export function createMainWindowRegistry(
  options: MainWindowRegistryOptions,
): MainWindowRegistry {
  let registeredMainWindow: BrowserWindow | null = null

  const hasReadyMainWindowHost = (): boolean => {
    return isMainWindowNotificationHostReady()
  }

  const broadcastNotificationHostState = (): void => {
    const payload = {
      hasMainWindow: hasReadyMainWindowHost(),
    }

    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed()) {
        continue
      }
      window.webContents.send('notification:host-state', payload)
    }
  }

  const getRegisteredMainWindow = (): BrowserWindow | null => {
    if (registeredMainWindow && !registeredMainWindow.isDestroyed()) {
      return registeredMainWindow
    }
    registeredMainWindow = null
    return getMainWindow()
  }

  const register = (mainWindow: BrowserWindow): void => {
    registeredMainWindow = mainWindow
    setMainWindow(mainWindow)
    setMainWindowNotificationHostReady(false)
    options.registerContextSpaceShortcutGuard(mainWindow.webContents, {
      interceptZoomShortcuts: false,
    })
    options.onMainWindowRegistered?.(mainWindow)

    // /#6774：不能用 did-start-loading——<webview> 挂载（宿主页里的子 frame
    // 导航）也会触发它，且 webview 场景没有后续主 frame did-finish-load 把 ready
    // 恢复回来，通知宿主会被永久判死。只有主 frame 真导航才清 ready。
    mainWindow.webContents.on('did-start-navigation', (details) => {
      if (!details.isMainFrame || details.isSameDocument) return
      setMainWindowNotificationHostReady(false)
      broadcastNotificationHostState()
    })
    mainWindow.webContents.on('did-finish-load', () => {
      setMainWindowNotificationHostReady(true)
      broadcastNotificationHostState()
    })
    mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      setMainWindowNotificationHostReady(false)
      broadcastNotificationHostState()
      if (isMainFrame && errorCode !== -3) {
        const isPackagedResource = validatedURL.startsWith('tabtin-file://')
        captureClientError(new Error(`Main renderer failed to load: ${errorDescription}`), {
          handled_by: 'main_window_load_failure',
          error_category: isPackagedResource ? 'STARTUP_FATAL' : 'NETWORK_FATAL',
          error_code: isPackagedResource
            ? 'MAIN_RENDERER_RESOURCE_LOAD_FAILED'
            : 'MAIN_RENDERER_NETWORK_EXHAUSTED',
          severity: 'fatal',
          recoverability: 'unrecoverable',
        })
      }
    })
    mainWindow.webContents.on('render-process-gone', () => {
      setMainWindowNotificationHostReady(false)
      broadcastNotificationHostState()
    })

    mainWindow.on('closed', () => {
      if (registeredMainWindow !== mainWindow) {
        return
      }
      registeredMainWindow = null
      setMainWindowNotificationHostReady(false)
      clearMainWindow()
      broadcastNotificationHostState()
    })

    mainWindow.webContents.once('did-finish-load', async () => {
      await options.onMainWindowDidFinishLoad(mainWindow)
    })
  }

  const createAndRegister = (): BrowserWindow => {
    const mainWindow = options.createWindow()
    register(mainWindow)
    return mainWindow
  }

  const restoreMainWindow = (): BrowserWindow | null => {
    const mainWindow = getRegisteredMainWindow()
    if (!mainWindow || mainWindow.isDestroyed()) {
      return null
    }
    if (!mainWindow.isVisible()) {
      mainWindow.show()
    }
    if (mainWindow.isMinimized()) {
      mainWindow.restore()
    }
    mainWindow.focus()
    return mainWindow
  }

  const ensureReady = async (signal?: AbortSignal): Promise<BrowserWindow | null> => {
    signal?.throwIfAborted()
    let mainWindow = getRegisteredMainWindow()

    if (!mainWindow) {
      mainWindow = createAndRegister()
    }

    if (mainWindow.isDestroyed()) {
      return null
    }

    if (mainWindow.webContents.isLoading()) {
      const loaded = await new Promise<boolean>((resolvePromise, rejectPromise) => {
        const settle = (result: boolean) => {
          mainWindow!.webContents.removeListener('did-finish-load', handleLoaded)
          mainWindow!.webContents.removeListener('did-fail-load', handleFailed)
          mainWindow!.removeListener('closed', handleFailed)
          signal?.removeEventListener('abort', handleAbort)
          resolvePromise(result)
        }
        const handleLoaded = () => settle(true)
        const handleFailed = () => settle(false)
        const handleAbort = () => {
          mainWindow!.webContents.removeListener('did-finish-load', handleLoaded)
          mainWindow!.webContents.removeListener('did-fail-load', handleFailed)
          mainWindow!.removeListener('closed', handleFailed)
          signal?.removeEventListener('abort', handleAbort)
          rejectPromise(signal?.reason)
        }
        mainWindow!.webContents.once('did-finish-load', handleLoaded)
        mainWindow!.webContents.once('did-fail-load', handleFailed)
        mainWindow!.once('closed', handleFailed)
        if (signal?.aborted) {
          handleAbort()
        } else {
          signal?.addEventListener('abort', handleAbort, { once: true })
        }
      })
      if (!loaded) return null
    }

    signal?.throwIfAborted()
    return mainWindow.isDestroyed() ? null : mainWindow
  }

  return {
    register,
    createAndRegister,
    restoreMainWindow,
    ensureReady,
    ensureForNotification: ensureReady,
  }
}
