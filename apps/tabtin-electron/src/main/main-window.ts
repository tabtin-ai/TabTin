import { join } from 'path'

import { app, BrowserWindow, dialog, ipcMain, screen, shell } from 'electron'

import { configService } from './services/ConfigService'
import {
  buildBrowserContainerArgv,
  resolveBrowserContainerMode,
} from '../shared/browser-container-mode'
import { installWebviewAttachGuards } from './webview-host/webview-host'
import { sendResourceOpenFallback } from './resource-open-fallback'
import { SHELL_TOP_BAR_MAC_TRAFFIC_LIGHT_POSITION } from '../shared/shell-top-bar-layout'
import { captureClientError } from './sentry'

/**
 * Packaged 模式下 renderer 的入口 URL。
 *
 * 走 `tabtin-file://` 自定义协议（registerSchemesAsPrivileged 标记为 standard +
 * secure + supportFetchAPI + corsEnabled，详见 deep-link.ts），让 renderer 拿到
 * 稳定的 origin `tabtin-file://app`。这样：
 *   - Centrifugo `allowed_origins` 用 `tabtin-file://` 即可放行（避免 packaged 下
 *     renderer 走 file:// 协议握手时 Origin=null 被 403 拒掉）
 *   - 同源资源由 CSP `'self'` 自动覆盖 (`tabtin-file://app`)，不必把 file://
 *     这种弱 origin 加进 connect-src / script-src
 *
 * URL → 文件映射在 `file-system/protocol.ts` 的 `resolveAppResourcePath`。
 */
const PACKAGED_RENDERER_URL = 'tabtin-file://app/index.html'

function getDevInstanceId(): string | undefined {
  return process.env.TABTIN_DEV_INSTANCE?.trim() || undefined
}

function withDevInstanceMarker(rendererUrl: string): string {
  const instanceId = getDevInstanceId()
  if (!instanceId) return rendererUrl

  const url = new URL(rendererUrl)
  url.searchParams.set('tabtin-dev-instance', instanceId)
  return url.toString()
}

export interface MainWindowLogger {
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
  debug?: (...args: unknown[]) => void
}

const forceRepaint = (win: BrowserWindow) => {
  if (win.isDestroyed()) return
  win.webContents.invalidate()
  if (win.isMaximized() || win.isFullScreen()) return
  const [width, height] = win.getSize()
  win.setSize(width + 1, height)
  setTimeout(() => {
    if (!win.isDestroyed()) win.setSize(width, height)
  }, 32)
}

export function installGlobalWindowRecoveryHooks(log: MainWindowLogger): void {
  app.on('child-process-gone', (_event, details) => {
    if (details.type !== 'GPU') {
      return
    }
    log.warn('GPU process gone:', details.reason)
    BrowserWindow.getAllWindows().forEach(win => forceRepaint(win))
  })
}

/**
 * 把窗口的最大化/还原状态推给 renderer，让自绘标题栏的「最大化/还原」图标
 * 与真实窗口状态保持一致——双击拖拽区、系统快捷键（Win+↑）、贴边等任意来源
 * 触发的状态变化都会经此同步，而不仅是用户点了我们的按钮。
 *
 * 主窗 + 独立聊天窗共用，所以独立出来。
 */
export function attachWindowControlEvents(win: BrowserWindow): void {
  const pushState = () => {
    if (win.isDestroyed()) return
    win.webContents.send('window:maximize-changed', win.isMaximized())
  }
  win.on('maximize', pushState)
  win.on('unmaximize', pushState)

  // macOS 全屏时系统红绿灯隐藏，renderer 需要据此收回左侧安全区
  // （折叠态「展开侧栏」入口的避让位，见 AppLayout topBarSafeArea）。
  const pushFullScreenState = () => {
    if (win.isDestroyed()) return
    win.webContents.send('window:fullscreen-changed', win.isFullScreen())
  }
  win.on('enter-full-screen', pushFullScreenState)
  win.on('leave-full-screen', pushFullScreenState)
}

export function applySequoiaFix(win: BrowserWindow): void {
  if (process.platform !== 'darwin') {
    return
  }
  const invalidate = () => {
    if (!win.isDestroyed()) {
      win.webContents.invalidate()
    }
  }
  win.on('restore', invalidate)
  win.on('show', invalidate)
}

export interface CreateMainWindowOptions {
  icon: string
  isDev: boolean
  rendererUrl?: string
  rendererVerbose: boolean
  log: MainWindowLogger
  getBackgroundColor: () => string
  isQuitting: () => boolean
  /**
   * W2.5 T9: 关窗口前置守卫。返回 'cancel' → 阻止本次关闭；返回 'continue' → 继续走
   * slide flush 链路。未提供时（向后兼容/单元测试）相当于"始终 continue"。
   *
   * 注意：⌘Q 路径走 app-lifecycle.before-quit + onExitGuard，不会走到这里
   * （isQuitting 返回 true 时本 close 直接放行）；本函数仅用于"用户点窗口 ×"或
   * Windows/Linux "关最后一个窗口"场景。
   */
  onExitGuard?: () => Promise<'continue' | 'cancel'>
  /**
   * 托盘常驻：返回 true 时点 X 不销毁窗口，改为隐藏（进程与
   * 后台服务照常运行）。真退出（isQuitting=true）不会走到这里。
   * 未提供时（向后兼容/单元测试）保持原销毁链路。
   */
  shouldHideToTray?: () => boolean
  /** macOS 最小化改 hide，与点 X 一致保活 renderer 会话 */
  shouldHideToTrayOnMinimize?: () => boolean
  /** 窗口因托盘模式被隐藏后回调（用于首次隐藏的系统通知提示） */
  onHiddenToTray?: () => void
}

function isAllowedNavigation(navigationUrl: string, rendererUrl: string): boolean {
  if (navigationUrl.startsWith('file://')) return true
  // packaged 模式 renderer 走 tabtin-file://app/*；任何 tabtin-file:// 子路径都视为
  // 同源跳转放行（协议本身只能由 main 进程注册的 stream handler 提供数据，无外部入口）
  if (navigationUrl.startsWith('tabtin-file://')) return true
  try {
    const nav = new URL(navigationUrl)
    const renderer = new URL(rendererUrl)
    if (nav.hostname === renderer.hostname && nav.port === renderer.port) return true
    // Allow Vite dev server port range (5170-5179) on localhost
    if (nav.hostname === 'localhost') {
      const port = parseInt(nav.port, 10)
      if (port >= 5170 && port <= 5179) return true
    }
  } catch {
    // invalid URL — deny by default
  }
  return false
}

export function createMainWindow(options: CreateMainWindowOptions): BrowserWindow {
  const windowState = configService.get('window.main') || { width: 1400, height: 900 }
  let { width, height, x, y, isMaximized } = windowState

  if (x !== undefined && y !== undefined) {
    const isOffScreen = !screen.getAllDisplays().some(display => {
      const { bounds } = display
      return x! >= bounds.x && y! >= bounds.y &&
        x! + width! <= bounds.x + bounds.width &&
        y! + height! <= bounds.y + bounds.height
    })
    if (isOffScreen) {
      x = undefined
      y = undefined
    }
  }

  const mainWindow = new BrowserWindow({
    width,
    height,
    x,
    y,
    // 下限放宽：侧栏可折叠、右侧收起栏窄时收成图标，窗口能更小仍可用。
    // 原 1200×800 偏大，拖不小；这里给到 900×640（仍够容纳侧栏+对话+图标态收起栏）。
    minWidth: 900,
    minHeight: 640,
    show: false,
    frame: false,
    // macOS 的自绘标题栏不展示原生 title，但它仍会出现在窗口切换器等系统入口；
    // 侧栏也会读同一个 URL marker 展示测试端标识。
    title: getDevInstanceId() ? `TabTin · IM 测试端 ${getDevInstanceId()}` : 'TabTin · 主端',
    // Windows/Linux：frameless + renderer 自绘标题栏控件（见 components/platform/
    // window-controls.tsx）。不再用原生 titleBarOverlay——原生覆盖层浮在所有内容
    // 之上，鼠标悬浮右上角时会遮挡 UI（飞书式自绘按钮可控样式 + 预留空间）。
    // macOS 保留系统红绿灯（titleBarStyle:'hidden' + trafficLightPosition）。
    // 几何真源：shared/shell-top-bar-layout.ts（与 ShellTopBar 行高同步）。
    titleBarStyle: 'hidden',
    trafficLightPosition:
      process.platform === 'darwin' ? SHELL_TOP_BAR_MAC_TRAFFIC_LIGHT_POSITION : undefined,
    backgroundColor: options.getBackgroundColor(),
    icon: options.icon,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: !options.isDev,
      backgroundThrottling: false,
      spellcheck: false,
      enableWebSQL: false,
      v8CacheOptions: 'code',
      //  (webview 迁移 Phase 2): 开启 <webview> tag 能力。
      // 无论 TABTIN_BROWSER_CONTAINER 取值都开启——tag 能力是 Tin 沙箱
      // () 的前置依赖，这里同时解除该阻塞；安全边界由 webview-host
      // 的 will-attach-webview 白名单无条件兜底，浏览器容器是否实际使用
      // <webview> 由 flag 单独控制（默认 wcv，行为不变）。
      webviewTag: true,
      // flag 传播给 sandboxed preload（读 process.argv），见 browser-container-mode.ts
      additionalArguments: [buildBrowserContainerArgv(resolveBrowserContainerMode())],
    },
  })

  // : webviewTag 开启后必须先装 attach 白名单守卫再加载 renderer
  installWebviewAttachGuards(mainWindow)

  applySequoiaFix(mainWindow)
  attachWindowControlEvents(mainWindow)

  let windowShown = false
  let closeConfirmed = false
  let isClosing = false

  /**
   * 主窗口的 close 钩子分两段（W2.5 T9 引入退出守卫）：
   *
   * 1. 退出守卫：询问 renderer 有无 dirty 资源 + 弹合并对话框；
   *    用户选择 'cancel' → 阻止关闭、释放 isClosing 锁
   *    用户选择 'continue' / 守卫不可用 → 进入 slide flush
   *
   * 2. slide flush：发 `slide:flush-before-close` 让 renderer 自动保存 slide editor；
   *    `slide:flush-complete` 收到后真正关窗口，超时强制关。
   *
   * ⌘Q 路径不会走这里（options.isQuitting() 在 before-quit 已置 true）。
   */
  const saveWindowBounds = () => {
    const bounds = mainWindow.isMaximized() ? mainWindow.getNormalBounds() : mainWindow.getBounds()
    configService.set('window.main', {
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      isMaximized: mainWindow.isMaximized(),
    })
  }

  const handleMinimizeToTray = (event: { preventDefault: () => void }) => {
    if (!options.shouldHideToTrayOnMinimize?.()) {
      return
    }
    event.preventDefault()
    saveWindowBounds()
    mainWindow.hide()
    options.onHiddenToTray?.()
  }
  // Electron 运行时支持 minimize + preventDefault；BrowserWindow 类型未收录该事件
  ;(mainWindow as unknown as NodeJS.EventEmitter).on('minimize', handleMinimizeToTray)

  mainWindow.on('close', (event) => {
    if (closeConfirmed || options.isQuitting()) return

    // 托盘常驻分支：隐藏而非销毁，不走 exit guard / slide flush
    // ——窗口和 renderer 都还活着，无需 flush；真退出仍走下方原链路。
    if (options.shouldHideToTray?.()) {
      event.preventDefault()
      saveWindowBounds()
      mainWindow.hide()
      options.onHiddenToTray?.()
      return
    }

    event.preventDefault()
    if (isClosing) return

    isClosing = true

    saveWindowBounds()

    const proceedWithFlush = () => {
      mainWindow.webContents.send('slide:flush-before-close')

      // 使用带 sender 过滤的处理器，防止其他窗口触发此事件导致主窗口提前关闭（VS-44）
      const flushCompleteHandler = (ipcEvent: import('electron').IpcMainEvent) => {
        if (ipcEvent.sender !== mainWindow.webContents) return
        clearTimeout(forceCloseTimer)
        ipcMain.removeListener('slide:flush-complete', flushCompleteHandler)
        closeConfirmed = true
        isClosing = false
        // SC-007: 多窗口竞态防护 — quit 流程可能已销毁窗口
        if (!mainWindow.isDestroyed()) {
          mainWindow.close()
        }
      }

      const flushTimeoutMs = options.isDev ? 1500 : 4000
      const forceCloseTimer = setTimeout(() => {
        ipcMain.removeListener('slide:flush-complete', flushCompleteHandler)
        options.log.warn(`renderer 保存超时（${flushTimeoutMs}ms），强制关闭窗口`)
        closeConfirmed = true
        isClosing = false
        if (!mainWindow.isDestroyed()) {
          mainWindow.close()
        }
      }, flushTimeoutMs)

      ipcMain.on('slide:flush-complete', flushCompleteHandler)
    }

    const guard = options.onExitGuard
    if (!guard) {
      proceedWithFlush()
      return
    }
    guard()
      .then((choice) => {
        if (choice === 'cancel') {
          options.log.info('用户取消关闭窗口 (exit-guard=cancel)')
          isClosing = false
          return
        }
        if (mainWindow.isDestroyed()) return
        proceedWithFlush()
      })
      .catch((err) => {
        options.log.error('window close exit-guard 异常，降级 continue:', err)
        if (!mainWindow.isDestroyed()) proceedWithFlush()
      })
  })

  mainWindow.on('ready-to-show', () => {
    if (windowShown) {
      return
    }
    windowShown = true
    if (isMaximized) {
      mainWindow.maximize()
    }
    mainWindow.show()
    options.log.info('窗口已显示（ready-to-show）')
  })

  setTimeout(() => {
    if (windowShown) {
      return
    }
    windowShown = true
    options.log.warn('窗口3秒后仍未显示，强制显示')
    mainWindow.show()
    if (options.isDev) {
      mainWindow.webContents.openDevTools()
    }
  }, 3000)

  mainWindow.webContents.on('did-start-loading', () => {
    options.log.info('开始加载页面...')
  })

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    options.log.error('页面加载失败:', { errorCode, errorDescription, validatedURL })
  })

  mainWindow.webContents.on('dom-ready', () => {
    options.log.info('DOM 已就绪')
  })

  mainWindow.webContents.on('console-message', (...args: any[]) => {
    const details = args.length === 1 ? args[0] : null
    const level = typeof details?.level === 'number' ? details.level : args[1]
    const message = typeof details?.message === 'string' ? details.message : args[2]

    if (level === 0 && !options.rendererVerbose) return
    const levelMap = ['DEBUG', 'LOG', 'WARNING', 'ERROR']
    const levelStr = levelMap[level] || 'LOG'
    const line = `[Renderer:${levelStr}] ${message}`
    // 转发渲染进程 console：WARNING/ERROR 落 main.log（打包版可诊断），
    // 低级别走 debug 避免刷屏。
    if (level >= 3) options.log.error(line)
    else if (level === 2) options.log.warn(line)
    else options.log.debug?.(line)
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    try {
      const parsed = new URL(details.url)
      if (parsed.protocol === 'mailto:') {
        void shell.openExternal(details.url)
        return { action: 'deny' }
      }
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
        // 交给 renderer onOpenFallback：可预览文件进 Preview Modal，网页走 ResourceRouter/tabweb。
        // 不再直接 shell.openExternal，避免 https://…xlsx 绕过 Preview。
        const sent = sendResourceOpenFallback(mainWindow, {
          url: details.url,
          source: 'main_window',
          disposition: details.disposition,
        })
        if (!sent) {
          void shell.openExternal(details.url)
        }
      }
    } catch {
      // ignore invalid URLs
    }
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', (event, navigationUrl) => {
    const rendererUrl = options.rendererUrl || 'http://localhost:5173'
    if (!isAllowedNavigation(navigationUrl, rendererUrl)) {
      event.preventDefault()
      options.log.error(`主窗口导航被拦截！疑似 CDP 误操作。目标 URL: ${navigationUrl}`)
    }
  })

  mainWindow.webContents.on('will-frame-navigate' as any, (event: any) => {
    const navigationUrl: string = event.url || ''
    if (!event.isMainFrame) {
      return
    }
    const rendererUrl = options.rendererUrl || 'http://localhost:5173'
    if (!isAllowedNavigation(navigationUrl, rendererUrl)) {
      event.preventDefault()
      options.log.error(`主窗口 frame 导航被拦截！疑似 CDP 误操作。目标 URL: ${navigationUrl}`)
    }
  })

  let unresponsiveRecoveryTimer: ReturnType<typeof setTimeout> | null = null
  let responsiveListenerAttached = false

  const handleResponsive = () => {
    responsiveListenerAttached = false
    mainWindow.removeListener('responsive', handleResponsive)
    if (unresponsiveRecoveryTimer) {
      clearTimeout(unresponsiveRecoveryTimer)
      unresponsiveRecoveryTimer = null
    }
    options.log.info('[MainWindow] 渲染进程已恢复响应')
  }

  const handleUnresponsive = () => {
    options.log.warn('[MainWindow] 渲染进程无响应')

    if (unresponsiveRecoveryTimer) return

    unresponsiveRecoveryTimer = setTimeout(() => {
      unresponsiveRecoveryTimer = null
      if (mainWindow.isDestroyed()) return
      captureClientError(new Error('Main renderer remained unresponsive for 15 seconds'), {
        handled_by: 'main_window_unresponsive_timeout',
        error_category: 'HANG',
        error_code: 'MAIN_RENDERER_UNRESPONSIVE_15S',
        severity: 'actionable',
        recoverability: 'degraded',
      })
      dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: '应用无响应',
        message: 'TabTin 暂时无响应，是否重新加载？',
        buttons: ['继续等待', '重新加载'],
        defaultId: 1,
      }).then(({ response }) => {
        if (response === 1 && !mainWindow.isDestroyed()) {
          mainWindow.reload()
        }
      }).catch(() => {})
    }, 15_000)

    if (!responsiveListenerAttached) {
      responsiveListenerAttached = true
      mainWindow.on('responsive', handleResponsive)
    }
  }

  mainWindow.on('unresponsive', handleUnresponsive)

  mainWindow.on('closed', () => {
    ;(mainWindow as unknown as NodeJS.EventEmitter).removeListener('minimize', handleMinimizeToTray)
    mainWindow.removeListener('unresponsive', handleUnresponsive)
    mainWindow.removeListener('responsive', handleResponsive)
    if (unresponsiveRecoveryTimer) {
      clearTimeout(unresponsiveRecoveryTimer)
      unresponsiveRecoveryTimer = null
    }
  })

  if (options.isDev && options.rendererUrl) {
    const rendererUrl = withDevInstanceMarker(options.rendererUrl)
    options.log.info('加载开发服务器:', rendererUrl)
    void mainWindow.loadURL(rendererUrl)
  } else {
    options.log.info('加载本地资源:', PACKAGED_RENDERER_URL)
    void mainWindow.loadURL(PACKAGED_RENDERER_URL)
  }

  options.log.info('ViewFactory 已集成 ViewManager 引擎')
  return mainWindow
}
