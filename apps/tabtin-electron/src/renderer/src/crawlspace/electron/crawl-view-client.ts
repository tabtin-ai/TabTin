import i18n from '@/i18n'
import { withTimeout, DEFAULT_IPC_TIMEOUT, LONG_IPC_TIMEOUT } from '../utils/withTimeout'
import { createLogger } from '@/utils/logger'
import type { OpenIntentHints } from '@shared/open-intent'

const log = createLogger('CrawlViewClient')

type Bounds = { x: number; y: number; width: number; height: number }
type ViewOperationResult = { success: boolean; error?: string }
type HasViewResult = ViewOperationResult & { exists?: boolean }
type TouchResult = ViewOperationResult & { touched?: boolean }
type NavigationStateResult = ViewOperationResult & { state?: any }
type ScreenshotCaptureOptions = {
  format?: 'png' | 'jpeg'
  quality?: number
  rect?: Bounds
}
type CrawlViewOptions =
  | {
      profile: string
      kind: 'workspace-view'
      crawlspaceId: string
      partition: string
      isPreview?: boolean
      allowMultiple?: boolean
      allowPrivateHostNavigation?: boolean
      openIntentHints?: OpenIntentHints
    }
  | {
      profile: string
      kind: 'normal-view'
      crawlspaceId?: never
      partition?: string
      isPreview?: boolean
      allowMultiple?: boolean
      allowPrivateHostNavigation?: boolean
      openIntentHints?: OpenIntentHints
    }

function getApi(): any | null {
  return (typeof window !== 'undefined' ? window.tabtin?.crawlView : null) || null
}

export const crawlViewClient = {
  show: async (
    tabId: string,
    url: string,
    bounds: Bounds,
    runId?: string,
    options?: CrawlViewOptions
  ): Promise<ViewOperationResult> => {
    const api = getApi()
    if (!api?.show) throw new Error(i18n.t('crawl:clients.apiUnavailable', { api: 'crawlView.show' }))
    return withTimeout(
      api.show(tabId, url, bounds, runId, options) as Promise<ViewOperationResult>,
      DEFAULT_IPC_TIMEOUT,
      'crawlView.show'
    )
  },

  hide: async (tabId?: string): Promise<ViewOperationResult> => {
    const api = getApi()
    if (!api?.hide) throw new Error(i18n.t('crawl:clients.apiUnavailable', { api: 'crawlView.hide' }))
    return withTimeout(api.hide(tabId) as Promise<ViewOperationResult>, DEFAULT_IPC_TIMEOUT, 'crawlView.hide')
  },

  setViewBounds: async (tabId: string, bounds: Bounds): Promise<ViewOperationResult> => {
    const api = getApi()
    if (!api?.setViewBounds) throw new Error(i18n.t('crawl:clients.apiUnavailable', { api: 'crawlView.setViewBounds' }))
    return withTimeout(
      api.setViewBounds(tabId, bounds) as Promise<ViewOperationResult>,
      DEFAULT_IPC_TIMEOUT,
      'crawlView.setViewBounds'
    )
  },

  setIgnoreMouseEventsForAttached: async (ignore: boolean) => {
    const api = getApi()
    if (!api?.setIgnoreMouseEventsForAttached) {
      throw new Error(i18n.t('crawl:clients.apiUnavailable', { api: 'crawlView.setIgnoreMouseEventsForAttached' }))
    }
    return withTimeout(api.setIgnoreMouseEventsForAttached(ignore), DEFAULT_IPC_TIMEOUT, 'crawlView.setIgnoreMouseEventsForAttached')
  },

  destroyTabView: async (tabId: string): Promise<ViewOperationResult> => {
    const api = getApi()
    if (!api?.destroyTabView) throw new Error(i18n.t('crawl:clients.apiUnavailable', { api: 'crawlView.destroyTabView' }))
    return withTimeout(
      api.destroyTabView(tabId) as Promise<ViewOperationResult>,
      DEFAULT_IPC_TIMEOUT,
      'crawlView.destroyTabView'
    )
  },

  onEvent: (callback: (event: any) => void) => {
    const api = getApi()
    if (!api?.onEvent) {
      log.warn('API 不可用:', { api: 'crawlView.onEvent' })
      return () => {}
    }
    return api.onEvent(callback)
  },

  onCrashRecovered: (callback: (payload: { viewId: string; reason: string; url: string }) => void) => {
    const api = getApi()
    if (!api?.onCrashRecovered) {
      return () => {}
    }
    return api.onCrashRecovered(callback)
  },

  hasView: async (tabId: string): Promise<HasViewResult> => {
    const api = getApi()
    if (!api?.hasView) throw new Error(i18n.t('crawl:clients.apiUnavailable', { api: 'crawlView.hasView' }))
    return withTimeout(api.hasView(tabId) as Promise<HasViewResult>, DEFAULT_IPC_TIMEOUT, 'crawlView.hasView')
  },

  touch: async (tabId: string, reason?: string): Promise<TouchResult> => {
    const api = getApi()
    if (!api?.touch) throw new Error(i18n.t('crawl:clients.apiUnavailable', { api: 'crawlView.touch' }))
    return withTimeout(api.touch(tabId, reason) as Promise<TouchResult>, DEFAULT_IPC_TIMEOUT, 'crawlView.touch')
  },

  executeScript: async (
    script: string,
    tabId?: string,
    url?: string,
    options?: CrawlViewOptions
  ) => {
    const api = getApi()
    if (!api?.executeScript) throw new Error(i18n.t('crawl:clients.apiUnavailable', { api: 'crawlView.executeScript' }))
    return withTimeout(api.executeScript(script, tabId, url, options), LONG_IPC_TIMEOUT, 'crawlView.executeScript')
  },

  cancelAnnotation: async (tabId: string) => {
    const api = getApi()
    if (!api?.cancelAnnotation) throw new Error(i18n.t('crawl:clients.apiUnavailable', { api: 'crawlView.cancelAnnotation' }))
    return withTimeout(api.cancelAnnotation(tabId), DEFAULT_IPC_TIMEOUT, 'crawlView.cancelAnnotation')
  },

  getProcessedContent: async (
    tabId?: string,
    url?: string,
    runId?: string,
    options?: CrawlViewOptions
  ) => {
    const api = getApi()
    if (!api?.getProcessedContent) throw new Error(i18n.t('crawl:clients.apiUnavailable', { api: 'crawlView.getProcessedContent' }))
    return withTimeout(api.getProcessedContent(tabId, url, runId, options), LONG_IPC_TIMEOUT, 'crawlView.getProcessedContent')
  },

  screenshot: async (
    captureOptions?: ScreenshotCaptureOptions,
    tabId?: string,
    url?: string,
    runId?: string,
    options?: CrawlViewOptions
  ) => {
    const api = getApi()
    if (!api?.screenshot) throw new Error(i18n.t('crawl:clients.apiUnavailable', { api: 'crawlView.screenshot' }))
    return withTimeout(api.screenshot(captureOptions, tabId, url, runId, options), 30_000, 'crawlView.screenshot')
  },

  getNavigationState: async (tabId?: string): Promise<NavigationStateResult> => {
    const api = getApi()
    if (!api?.getNavigationState) throw new Error(i18n.t('crawl:clients.apiUnavailable', { api: 'crawlView.getNavigationState' }))
    return withTimeout(
      api.getNavigationState(tabId) as Promise<NavigationStateResult>,
      DEFAULT_IPC_TIMEOUT,
      'crawlView.getNavigationState'
    )
  },

  loadUrl: async (
    tabId: string,
    url: string,
    options?: {
      waitUntil?: 'load' | 'domcontentloaded' | 'networkidle'
      timeout?: number
      waitForSelector?: string
      waitForTimeout?: number
      waitForState?: 'attached' | 'visible' | 'hidden'
      allowPrivateHostNavigation?: boolean
    }
  ) => {
    const api = getApi()
    if (!api?.loadUrl) throw new Error(i18n.t('crawl:clients.apiUnavailable', { api: 'crawlView.loadUrl' }))
    return withTimeout(api.loadUrl(tabId, url, options), LONG_IPC_TIMEOUT, 'crawlView.loadUrl')
  },

  waitForSelector: async (
    tabId: string,
    options: {
      selector?: string
      state?: 'attached' | 'visible' | 'hidden'
      timeout?: number
      delay?: number
      pollInterval?: number
    }
  ) => {
    const api = getApi()
    if (!api?.waitForSelector) throw new Error(i18n.t('crawl:clients.apiUnavailable', { api: 'crawlView.waitForSelector' }))
    const waitMs = (options?.timeout ?? 30_000) + 5_000
    return withTimeout(api.waitForSelector(tabId, options), waitMs, 'crawlView.waitForSelector')
  },

  goBack: async (tabId?: string): Promise<ViewOperationResult> => {
    const api = getApi()
    if (!api?.goBack) throw new Error(i18n.t('crawl:clients.apiUnavailable', { api: 'crawlView.goBack' }))
    return withTimeout(api.goBack(tabId) as Promise<ViewOperationResult>, DEFAULT_IPC_TIMEOUT, 'crawlView.goBack')
  },

  goForward: async (tabId?: string): Promise<ViewOperationResult> => {
    const api = getApi()
    if (!api?.goForward) throw new Error(i18n.t('crawl:clients.apiUnavailable', { api: 'crawlView.goForward' }))
    return withTimeout(api.goForward(tabId) as Promise<ViewOperationResult>, DEFAULT_IPC_TIMEOUT, 'crawlView.goForward')
  },

  reload: async (ignoreCache = false, tabId?: string): Promise<ViewOperationResult> => {
    const api = getApi()
    if (!api?.reload) throw new Error(i18n.t('crawl:clients.apiUnavailable', { api: 'crawlView.reload' }))
    return withTimeout(api.reload(Boolean(ignoreCache), tabId) as Promise<ViewOperationResult>, DEFAULT_IPC_TIMEOUT, 'crawlView.reload')
  },

  stop: async (tabId?: string): Promise<ViewOperationResult> => {
    const api = getApi()
    if (!api?.stop) throw new Error(i18n.t('crawl:clients.apiUnavailable', { api: 'crawlView.stop' }))
    return withTimeout(api.stop(tabId) as Promise<ViewOperationResult>, DEFAULT_IPC_TIMEOUT, 'crawlView.stop')
  },

  getHTML: async (
    tabId?: string,
    url?: string,
    runId?: string,
    options?: CrawlViewOptions
  ) => {
    const api = getApi()
    if (!api?.getHTML) throw new Error(i18n.t('crawl:clients.apiUnavailable', { api: 'crawlView.getHTML' }))
    return withTimeout(api.getHTML(tabId, url, runId, options), LONG_IPC_TIMEOUT, 'crawlView.getHTML')
  },

  getPageInfo: async (
    tabId?: string,
    url?: string,
    runId?: string,
    options?: CrawlViewOptions
  ) => {
    const api = getApi()
    if (!api?.getPageInfo) throw new Error(i18n.t('crawl:clients.apiUnavailable', { api: 'crawlView.getPageInfo' }))
    return withTimeout(api.getPageInfo(tabId, url, runId, options), DEFAULT_IPC_TIMEOUT, 'crawlView.getPageInfo')
  }
}
