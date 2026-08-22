import { app, protocol, type BrowserWindow } from 'electron'
import { resolve } from 'path'
import {
  parseToastLaunchUrl,
  resolveTabTinProtocolScheme,
} from './services/notification/notify-launch'
import type { NavigateTarget } from './services/notification/types'
import { consumePlatformOAuthDeepLink } from './services/mcp-oauth-window'

export interface DeepLinkLogger {
  debug: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
}

export interface DeepLinkController {
  flushPendingLinks: () => void
  handleSecondInstance: (argv: string[]) => void
  setEnsureMainWindow: (callback?: EnsureMainWindow) => void
}

export type EnsureMainWindow = () => BrowserWindow | null | Promise<BrowserWindow | null>

export interface DeepLinkControllerOptions {
  log: DeepLinkLogger
  getMainWindow: () => BrowserWindow | null
  /** 可选：主窗缺失时拉起（对齐 OsNotificationPresenter /  WinRT 协议激活） */
  ensureMainWindow?: EnsureMainWindow
}

function findTabtinUrlInArgv(argv: readonly string[], scheme: string): string | undefined {
  return argv.find((arg) => arg.startsWith(`${scheme}://`))
}

function revealWindow(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  if (win.isMinimized()) {
    win.restore()
  }
  if (!win.isVisible()) {
    win.show()
  }
  win.focus()
}

/**
 * 发送 notification:navigate；加载中则等 did-finish/fail-load，
 * 避免 WinRT 协议激活时在空壳窗上丢 IPC。
 */
function sendNotificationNavigate(win: BrowserWindow, navigateTo: NavigateTarget): void {
  const dispatch = () => {
    if (win.isDestroyed()) return
    win.webContents.send('notification:navigate', navigateTo)
  }

  if (win.webContents.isLoading()) {
    const dispatchOnce = () => dispatch()
    win.webContents.once('did-finish-load', dispatchOnce)
    win.webContents.once('did-fail-load', dispatchOnce)
    return
  }

  dispatch()
}

/**
 * 聚焦主窗。若仍在首屏加载，推迟 show，避免任务栏亮起深色空白壳。
 */
function focusWindow(win: BrowserWindow): void {
  if (win.isDestroyed()) return

  if (!win.isVisible() && win.webContents.isLoading()) {
    const revealOnce = () => revealWindow(win)
    win.once('ready-to-show', revealOnce)
    win.webContents.once('did-finish-load', revealOnce)
    win.webContents.once('did-fail-load', revealOnce)
    return
  }

  revealWindow(win)
}

export function createDeepLinkController(
  options: DeepLinkControllerOptions,
): DeepLinkController {
  const deepLinkScheme = resolveTabTinProtocolScheme()

  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'tabtin-file',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
      },
    },
  ])

  // 第二个开发实例只用于本机双端调试：不能抢占系统 tabtin:// 协议处理器，
  // 否则启动/退出它会影响主开发实例的深链接行为。
  if (!process.env.TABTIN_DEV_INSTANCE) {
    if (process.defaultApp) {
      if (process.argv.length >= 2) {
        app.setAsDefaultProtocolClient(deepLinkScheme, process.execPath, [resolve(process.argv[1])])
      }
    } else {
      app.setAsDefaultProtocolClient(deepLinkScheme)
    }
  }

  const gotTheLock = app.requestSingleInstanceLock()
  if (!gotTheLock) {
    app.quit()
  }

  const pendingDeepLinkUrls: string[] = []
  let ensureMainWindow: EnsureMainWindow | null = options.ensureMainWindow ?? null
  let dispatchChain: Promise<void> = Promise.resolve()

  const resolveMainWindow = async (): Promise<BrowserWindow | null> => {
    const existing = options.getMainWindow()
    if (existing && !existing.isDestroyed()) {
      return existing
    }
    if (ensureMainWindow) {
      const created = await ensureMainWindow()
      if (created && !created.isDestroyed()) {
        return created
      }
    }
    return null
  }

  const dispatchDeepLink = async (url: string): Promise<boolean> => {
    const safeUrl = url
      .replace(/(invite\/)[^/?#]+/, '$1***')
      .replace(/([?&]ticket=)[^&#]+/i, '$1***')
    options.log.debug('收到深链接:', safeUrl)
    try {
      const parsed = new URL(url)
      if (parsed.protocol !== `${deepLinkScheme}:`) {
        options.log.debug('非 tabtin 协议，忽略:', parsed.protocol)
        return true
      }

      if (consumePlatformOAuthDeepLink(url)) {
        const win = await resolveMainWindow()
        if (win) focusWindow(win)
        return true
      }

      const win = await resolveMainWindow()
      if (!win) {
        return false
      }

      focusWindow(win)

      // WinRT toast 点击：protocol 激活 → 复用 notification:navigate（与 Electron Notification click 同路）
      const toastLaunch = parseToastLaunchUrl(url)
      if (toastLaunch.kind === 'notify') {
        sendNotificationNavigate(win, toastLaunch.navigateTo)
        return true
      }
      if (toastLaunch.kind === 'focus') {
        return true
      }

      const path = parsed.hostname + parsed.pathname
      const sendDeepLink = () => {
        if (win.isDestroyed()) return
        win.webContents.send('deep-link', { path, url })
      }
      if (win.webContents.isLoading()) {
        win.webContents.once('did-finish-load', sendDeepLink)
        win.webContents.once('did-fail-load', sendDeepLink)
      } else {
        sendDeepLink()
      }
      return true
    } catch (error) {
      options.log.error('深链接解析失败:', error)
      return true
    }
  }

  const handleDeepLink = (url: string): void => {
    dispatchChain = dispatchChain.then(async () => {
      if (!(await dispatchDeepLink(url))) {
        pendingDeepLinkUrls.push(url)
      }
    }).catch((error) => {
      options.log.error('深链接分发失败:', error)
    })
  }

  app.on('open-url', (event, url) => {
    event.preventDefault()
    handleDeepLink(url)
  })

  // Windows 冷启动：协议 URL 在首实例 process.argv 里（热启动走 second-instance）
  const startupUrl = findTabtinUrlInArgv(process.argv, deepLinkScheme)
  if (startupUrl) {
    handleDeepLink(startupUrl)
  }

  return {
    setEnsureMainWindow: (callback?: EnsureMainWindow) => {
      ensureMainWindow = callback ?? null
    },
    flushPendingLinks: () => {
      dispatchChain = dispatchChain.then(async () => {
        while (pendingDeepLinkUrls.length > 0) {
          const nextUrl = pendingDeepLinkUrls.shift()
          if (!nextUrl) {
            continue
          }
          if (!(await dispatchDeepLink(nextUrl))) {
            pendingDeepLinkUrls.unshift(nextUrl)
            break
          }
        }
      }).catch((error) => {
        options.log.error('flushPendingLinks 失败:', error)
      })
    },
    handleSecondInstance: (argv) => {
      const win = options.getMainWindow()
      if (win && !win.isDestroyed()) {
        // 托盘常驻时窗口可能处于隐藏态，二开实例要能把它唤回前台
        focusWindow(win)
      }
      const url = findTabtinUrlInArgv(argv, deepLinkScheme)
      if (url) {
        handleDeepLink(url)
      }
    },
  }
}
