import type { BrowserWindow, WebContents } from 'electron'
import { startupPerf, createLogger } from './logger'
import type {
  ContextSpaceShortcutGuardOptions,
  MainWindowAppearance,
} from './types/runtime'

const mainLog = createLogger('Main')

export interface ViewFactoryHooks {
  getCurrentAppearance: () => MainWindowAppearance
  registerContextSpaceShortcutGuard: (
    webContents: WebContents,
    options?: ContextSpaceShortcutGuardOptions,
  ) => void
  cleanupContextSpaceShortcutGuard: (webContents: WebContents) => void
  ensureWebContentsThemeSync: (webContents: WebContents) => void
  cleanupWebContentsThemeSync: (webContents: WebContents) => void
  applyAppearanceToWebContents: (
    webContents: WebContents,
    appearance: MainWindowAppearance,
  ) => void
}

let viewFactoryRef: ReturnType<typeof import('./view-factory').getViewFactory> | null = null
const viewWebContentsById = new Map<string, WebContents>()
let _initDownloadManager: ((mainWindow: BrowserWindow) => void) | null = null

export function getDeferredViewFactory(): ReturnType<typeof import('./view-factory').getViewFactory> | null {
  return viewFactoryRef
}

export function rebindViewFactory(mainWindow: BrowserWindow): void {
  viewFactoryRef?.setMainWindow(mainWindow)
  _initDownloadManager?.(mainWindow)
}

export async function initViewFactory(
  mainWindow: BrowserWindow,
  hooks: ViewFactoryHooks,
): Promise<void> {
  const [
    { initDownloadManager },
    { setViewFactoryAccessor },
    { getViewFactory, setViewFactoryExternalHandlers },
  ] = await Promise.all([
    import('./download-manager'),
    import('./run-session/RunSessionManager'),
    import('./view-factory'),
  ])

  _initDownloadManager = initDownloadManager

  const initViewFactoryTask = async () => {
    startupPerf.mark('ViewFactory')
    mainLog.info('初始化 ViewFactory...')
    try {
      const viewFactory = getViewFactory({
        verbose: process.env.NODE_ENV === 'development',
        maxViews: 50,
        idleTimeout: 300000,
        enableReuse: false,
      })
      viewFactory.setMainWindow(mainWindow)
      viewFactoryRef = viewFactory
      setViewFactoryAccessor(() => viewFactory)
      // 网络捕获生命周期：创建网页 view 即挂 CDP 捕获、销毁即释放缓冲。
      // setViewFactoryExternalHandlers 是 merge 语义，不会清掉 TabPhone 等其它 handler。
      const { enableForTab, disableForTab } = await import('./services/CDPNetworkBridge')
      setViewFactoryExternalHandlers({
        enableNetworkCaptureForView: async (id: string) => {
          const wc = viewFactory.getWebContents(id)
          if (wc && !wc.isDestroyed()) {
            await enableForTab(wc, id)
          }
        },
        disableNetworkCaptureForView: async (id: string) => {
          await disableForTab(id)
        },
      })
      const trackViewWebContents = (id: string) => {
        const webContents = viewFactory.getWebContents(id)
        if (!webContents) return
        viewWebContentsById.set(id, webContents)
        hooks.registerContextSpaceShortcutGuard(webContents)
        hooks.ensureWebContentsThemeSync(webContents)
        hooks.applyAppearanceToWebContents(webContents, hooks.getCurrentAppearance())
      }
      viewFactory.on('view:created', ({ id }) => {
        trackViewWebContents(id)
      })
      viewFactory.on('view:registered', ({ id }) => {
        trackViewWebContents(id)
      })
      viewFactory.on('view:destroyed', ({ id }) => {
        const webContents = viewWebContentsById.get(id)
        if (!webContents) return
        hooks.cleanupContextSpaceShortcutGuard(webContents)
        hooks.cleanupWebContentsThemeSync(webContents)
        viewWebContentsById.delete(id)
      })
      mainLog.info('ViewFactory 初始化成功')
      const { installAgentCursorLifecycle } = await import('./browser-tab-lock/agentCursorLifecycle')
      installAgentCursorLifecycle()
    } catch (error) {
      mainLog.error('ViewFactory 初始化失败:', error)
    }
    startupPerf.measure('ViewFactory')
  }

  const initDownloadTask = async () => {
    startupPerf.mark('DownloadManager')
    mainLog.info('初始化下载管理器...')
    try {
      initDownloadManager(mainWindow)
      mainLog.info('下载管理器初始化成功')
    } catch (error) {
      mainLog.error('下载管理器初始化失败:', error)
    }
    startupPerf.measure('DownloadManager')
  }

  await Promise.allSettled([initViewFactoryTask(), initDownloadTask()])
}

export function disposeViewFactory(): void {
  viewFactoryRef = null
  viewWebContentsById.clear()
}
