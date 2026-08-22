import { BrowserWindow } from 'electron'
import { markDiagnosticSessionClean } from './diagnostics/diagnostic-runtime'

import {
  unregisterMainProcessIPCHandlers,
  type MainProcessIpcRegistryDependencies,
} from './ipc-registry'
import { startupPerf } from './logger'
import type { MainRuntimeServicesController } from './main-runtime-services'
import type { MainWindowRegistry } from './main-window-registry'
import { notificationService } from './services/notification'
import { loadSiteAccessMemory, flushSave as flushSiteAccessMemory } from './services/SiteAccessMemoryPersistence'
import { consumePendingLocalDataWipe } from './services/UninstallCleanupService'
import {
  initializeStartupServices,
  type StartupServicesLogger,
} from './startup-services'
import { destroyPtyManager } from './terminal/PtyManager'
import { unregisterTerminalIpcHandlers } from './terminal/ipc'
import { clearMainWindow } from './window-manager'

export interface MainAppLifecycleHandlers {
  onReady: () => Promise<void>
  onActivate: () => void
  onBeforeQuit: () => Promise<void>
  onWillQuit: () => void
}

export interface CreateMainAppLifecycleHandlersOptions {
  isDev: boolean
  rendererUrl?: string
  displayMediaTrustedOrigins?: string[]
  log: StartupServicesLogger
  ipcDependencies: MainProcessIpcRegistryDependencies
  mainWindowRegistry: Pick<MainWindowRegistry, 'createAndRegister' | 'ensureForNotification' | 'restoreMainWindow'>
  runtimeServices: Pick<MainRuntimeServicesController, 'startBackgroundServices' | 'stop'>
  flushRunningBackgroundTasksOnExit?: () => Promise<void>
}

const reportAllWindowsOffline = (): void => {
  try {
    const windows = BrowserWindow.getAllWindows()
    for (const win of windows) {
      if (!win.isDestroyed() && win.webContents) {
        win.webContents.executeJavaScript(
          `try { window.__tabtin_report_offline?.() } catch(e) {}`
        ).catch(() => {})
      }
    }
  } catch {
    // ignore
  }
}

export function createMainAppLifecycleHandlers(
  options: CreateMainAppLifecycleHandlersOptions,
): MainAppLifecycleHandlers {
  return {
    onReady: async () => {
      startupPerf.sinceStart('app.whenReady()')

      // loadSiteAccessMemory is not required for first paint — run it in
      // parallel with IPC registration instead of blocking the critical path.
      const siteMemoryReady = loadSiteAccessMemory().catch((e) => {
        options.log.warn?.('[Startup] SiteAccessMemory 加载失败，继续启动:', e)
      })

      startupPerf.mark('IPC 注册')

      initializeStartupServices({
        isDev: options.isDev,
        appUserModelId: process.env.TABTIN_APP_ID || 'com.tabtin.app',
        rendererUrl: options.rendererUrl,
        displayMediaTrustedOrigins: options.displayMediaTrustedOrigins,
        log: options.log,
        ipcDependencies: options.ipcDependencies,
        ensureMainWindowForNotification: options.mainWindowRegistry.ensureForNotification,
      })

      startupPerf.measure('IPC 注册')

      // ：pending wipe 须在 whenReady + session 预清注册之后、开窗之前。
      // whenReady 前纯磁盘删会撞 Chromium 自锁，且跳过 clearStorageData，导致凭证被契约保留。
      try {
        const pendingWipe = await consumePendingLocalDataWipe()
        if (pendingWipe) {
          options.log.info?.(
            `[Startup] pending local-data wipe ok=${pendingWipe.ok} removed=${pendingWipe.removed.length} failed=${pendingWipe.failed.length}`,
          )
        }
      } catch (error) {
        options.log.warn?.('[Startup] pending local-data wipe 失败，继续启动:', error)
      }

      startupPerf.mark('createWindow')
      const mainWindow = options.mainWindowRegistry.createAndRegister()
      startupPerf.measure('createWindow')

      startupPerf.mark('BackgroundServices')
      options.runtimeServices.startBackgroundServices(mainWindow)
      startupPerf.measure('BackgroundServices')

      await siteMemoryReady
    },
    onActivate: () => {
      if (options.mainWindowRegistry.restoreMainWindow()) {
        return
      }
      if (BrowserWindow.getAllWindows().length === 0) {
        options.mainWindowRegistry.createAndRegister()
      }
    },
    onBeforeQuit: async () => {
      reportAllWindowsOffline()

      // 终端假运行根治 v3 路线 A / F-EXIT：在 destroyPtyManager（杀 PTY）之前，
      // 先枚举所有 running 后台 shell 命令 → 杀整组 + **同步 flush** "已终止"
      // 终态到 Django（发不出去落 RelayRetryQueue 等下次启动 recover）。这样优雅
      // 退出后重开对话不再"运行中"转圈。best-effort，失败不阻断退出。
      try {
        if (options.flushRunningBackgroundTasksOnExit) {
          await options.flushRunningBackgroundTasksOnExit()
        } else {
          const { electronAgentHost } = await import('./agent/ElectronAgentHost')
          await electronAgentHost.flushRunningBackgroundTasksOnExit()
        }
      } catch (err) {
        options.log.warn?.('退出 flush 后台命令终态时出错:', err)
      }

      try {
        await flushSiteAccessMemory()
      } catch {
        // ignore
      }

      // 会话代码根本机 sidecar：覆盖 debounce / 未完成写链，避免正常退出丢绑定。
      try {
        const { electronAgentHost } = await import('./agent/ElectronAgentHost')
        await electronAgentHost.flushSessionCodeRootBindingsOnExit()
      } catch (err) {
        options.log.warn?.('退出 flush 会话代码根绑定时出错:', err)
      }

      try {
        notificationService.destroy()
      } catch {
        // ignore
      }

      try {
        options.log.info?.('正在清理 PTY 子进程...')
        destroyPtyManager()
        options.log.info?.('PTY 子进程已清理')
      } catch (err) {
        options.log.warn?.('PTY 子进程清理时出错:', err)
      }

      await options.runtimeServices.stop()

      // 显式关闭所有窗口，触发 renderer beforeunload（保存 PTY 快照等）
      // 之后再注销 IPC handlers，确保 will-quit 无输出、进程快速退出
      const windows = BrowserWindow.getAllWindows()
      if (windows.length > 0) {
        await Promise.all(windows.map(win => new Promise<void>(resolve => {
          if (win.isDestroyed()) { resolve(); return }
          const forceTimer = setTimeout(() => {
            if (!win.isDestroyed()) win.destroy()
            resolve()
          }, 2000)
          win.once('closed', () => { clearTimeout(forceTimer); resolve() })
          win.close()
        })))
      }

      try {
        unregisterTerminalIpcHandlers()
        options.log.info?.('Terminal IPC handlers 已注销')
      } catch (err) {
        options.log.warn?.('Terminal IPC handler 注销时出错:', err)
      }
      try {
        unregisterMainProcessIPCHandlers()
        options.log.info?.('Main-process IPC handlers 已注销')
      } catch (err) {
        options.log.warn?.('Main-process IPC handler 注销时出错:', err)
      }

      await markDiagnosticSessionClean()
      clearMainWindow()
    },
    onWillQuit: () => {
      // 所有清理已在 onBeforeQuit 完成，此处为安全兜底
    },
  }
}
