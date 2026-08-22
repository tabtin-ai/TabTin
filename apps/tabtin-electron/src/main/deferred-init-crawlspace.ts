import type { BrowserWindow } from 'electron'
import { startupPerf, createLogger } from './logger'
import { withStepTimeout, STEP_TIMEOUT_MS } from './deferred-utils'
import type { ResourceDetectionSummary } from '@tabtin/action-tools/types'

const mainLog = createLogger('Main')

let disconnectCrawlspaceViewEventSync: (() => void) | undefined
let networkCaptureRequestCompletedHandler: ((details: Electron.OnCompletedListenerDetails) => void) | null = null
let resourceHubSummaryChangedHandler: ((viewId: string, summary: ResourceDetectionSummary) => void) | null = null

let _crawlspaceDisposeDeps: {
  cleanupEmbeddedCrawlView: () => Promise<void>
  cleanupCrawlViewEventManager: () => void
  cleanupCrawlspaceContextBridge: () => void
  networkCaptureService: { off(event: string, handler: (...args: unknown[]) => void): void }
  getResourceHubService: () => { off(event: string, handler: (...args: unknown[]) => void): void }
  resetResourceDetectionService: () => void
} | null = null

export async function initCrawlspace(
  mainWindow: BrowserWindow,
): Promise<{ crawlViewPipelineOk: boolean }> {
  const [
    crawlViewEventsMod,
    crawlspaceContextBridgeMod,
    { connectCrawlspaceViewEventSync },
    { getCrawlspaceContextHub },
    embeddedCrawlViewMod,
    resourceDetectionMod,
    { getResourceHubService },
    { networkCaptureService },
    { getViewFactory },
  ] = await Promise.all([
    import('./crawl-view-events'),
    import('./crawlspace/CrawlspaceContextBridge'),
    import('./crawlspace/crawl-view-event-sync'),
    import('./crawlspace/CrawlspaceContextHub'),
    import('./embedded-crawl-view'),
    import('./services/ResourceDetectionService'),
    import('./services/ResourceHubService'),
    import('./services/NetworkCaptureService'),
    import('./view-factory'),
  ])

  const { initializeCrawlViewEventManager, getCrawlViewEventManager } = crawlViewEventsMod
  const { cleanupCrawlViewEventManager } = crawlViewEventsMod
  const { initializeCrawlspaceContextBridge, cleanupCrawlspaceContextBridge } = crawlspaceContextBridgeMod
  const { initializeEmbeddedCrawlView, registerEmbeddedCrawlViewHandlers, cleanupEmbeddedCrawlView } = embeddedCrawlViewMod
  const { getResourceDetectionService, resetResourceDetectionService } = resourceDetectionMod

  _crawlspaceDisposeDeps = {
    cleanupEmbeddedCrawlView,
    cleanupCrawlViewEventManager,
    cleanupCrawlspaceContextBridge,
    networkCaptureService,
    getResourceHubService,
    resetResourceDetectionService,
  }

  let crawlViewPipelineOk = true

  const initResourceDetection = async () => {
    startupPerf.mark('Phase2:A2-ResourceDetection')
    try {
      const resourceDetectionService = getResourceDetectionService()

      if (networkCaptureRequestCompletedHandler) {
        networkCaptureService.off('request-completed', networkCaptureRequestCompletedHandler)
      }

      networkCaptureRequestCompletedHandler = (details) => {
        resourceDetectionService.handleDefaultSessionRequest(details)
      }
      networkCaptureService.on('request-completed', networkCaptureRequestCompletedHandler)

      const contextHub = getCrawlspaceContextHub()
      resourceDetectionService.setSummaryChangedCallback((viewId, summary) => {
        try {
          const vf = getViewFactory()
          const viewState = vf.getViewState(viewId)
          const crawlspaceId = viewState?.config?.metadata?.crawlspaceId
          if (crawlspaceId) {
            contextHub.updateViewResourceSummary(crawlspaceId, viewId, summary)
          }
        } catch {
          // view 可能不属于任何 crawlspace
        }
      })

      const resourceHub = getResourceHubService()
      if (resourceHubSummaryChangedHandler) {
        resourceHub.off('summary-changed', resourceHubSummaryChangedHandler)
      }
      resourceHubSummaryChangedHandler = (viewId, summary) => {
        try {
          const vf = getViewFactory()
          const viewState = vf.getViewState(viewId)
          const crawlspaceId = viewState?.config?.metadata?.crawlspaceId
          if (crawlspaceId) {
            contextHub.updateViewResourceSummary(crawlspaceId, viewId, summary)
          }
        } catch {
          // view 可能不属于任何 crawlspace
        }
      }
      resourceHub.on('summary-changed', resourceHubSummaryChangedHandler)

      mainLog.info('资源检测服务互联初始化成功')
    } catch (error) {
      mainLog.warn('资源检测服务互联初始化失败（非致命）:', error)
    }
    startupPerf.measure('Phase2:A2-ResourceDetection')
  }

  const initCrawlViewPipeline = async () => {
    startupPerf.mark('Phase2:B-CrawlViewPipeline')
    try {
      mainLog.info('初始化嵌入式爬虫视图事件管理器...')
      initializeCrawlViewEventManager(mainWindow)
      disconnectCrawlspaceViewEventSync?.()
      const crawlEventMgr = getCrawlViewEventManager()
      if (crawlEventMgr) {
        disconnectCrawlspaceViewEventSync = connectCrawlspaceViewEventSync(
          crawlEventMgr.addExternalListener.bind(crawlEventMgr),
        )
      }

      mainLog.info('初始化 CrawlspaceContextBridge...')
      initializeCrawlspaceContextBridge()

      mainLog.info('初始化嵌入式爬虫视图...')
      initializeEmbeddedCrawlView(mainWindow)
      // crawl-view:* IPC handler 依赖 EmbeddedCrawlView 实例，必须在 initializeEmbeddedCrawlView 之后注册
      registerEmbeddedCrawlViewHandlers()

      // : webview-host IPC（announce/bind/navigate）与 crawl-view 同期注册；
      // flag=wcv 时 handler 内部直接拒绝，renderer 也不会调用
      const { registerWebviewHostIpcHandlers } = await import('./webview-host/webview-host')
      registerWebviewHostIpcHandlers()

      mainLog.info('嵌入式爬虫视图初始化成功')
    } catch (error) {
      mainLog.error('CrawlView 管线初始化失败:', error)
      crawlViewPipelineOk = false
    }
    startupPerf.measure('Phase2:B-CrawlViewPipeline')
  }

  await Promise.allSettled([initResourceDetection(), initCrawlViewPipeline()])

  return { crawlViewPipelineOk }
}

export function rebindCrawlspace(mainWindow: BrowserWindow): void {
  if (_crawlspaceDisposeDeps) {
    import('./crawl-view-events').then(m => m.initializeCrawlViewEventManager(mainWindow)).catch(() => {})
    import('./embedded-crawl-view').then(m => m.initializeEmbeddedCrawlView(mainWindow)).catch(() => {})
    mainLog.info('CrawlView 管线已 rebind 到新窗口')
  }
}

export function disposeCrawlspaceEarly(): void {
  try {
    disconnectCrawlspaceViewEventSync?.()
    disconnectCrawlspaceViewEventSync = undefined
  } catch {
    // ignore
  }
}

export async function disposeCrawlspaceFull(): Promise<void> {
  if (!_crawlspaceDisposeDeps) return
  const deps = _crawlspaceDisposeDeps

  mainLog.info('应用退出，清理嵌入式爬虫资源...')
  await withStepTimeout(
    () => deps.cleanupEmbeddedCrawlView(),
    STEP_TIMEOUT_MS,
    'cleanupEmbeddedCrawlView',
  )
  deps.cleanupCrawlViewEventManager()
  deps.cleanupCrawlspaceContextBridge()

  if (networkCaptureRequestCompletedHandler) {
    deps.networkCaptureService.off('request-completed', networkCaptureRequestCompletedHandler as (...args: unknown[]) => void)
    networkCaptureRequestCompletedHandler = null
  }

  if (resourceHubSummaryChangedHandler) {
    try {
      deps.getResourceHubService().off('summary-changed', resourceHubSummaryChangedHandler as (...args: unknown[]) => void)
    } catch { /* ignore */ }
    resourceHubSummaryChangedHandler = null
  }

  try {
    deps.resetResourceDetectionService()
  } catch {
    // ignore
  }

  _crawlspaceDisposeDeps = null
}
