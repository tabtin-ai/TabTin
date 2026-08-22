/**
 * 嵌入式爬虫视图事件管理器（多视图架构）
 *
 * 支持同时为多个 WebContentsView 绑定事件，后台标签的事件不会丢失。
 * 每个 view 通过 viewId 持有独立的事件绑定（CrawlViewEventBinding），
 * 事件统一通过 IPC 分发到渲染进程，viewId 区分来源。
 */

import { BrowserWindow } from 'electron'
import type { WebContents, WebContentsView } from 'electron'
import {
  dispatchCrawlViewEvent,
  type CrawlViewEventListener,
  type DispatchableCrawlViewEvent,
} from './crawl-view-event-dispatcher'
import {
  createCrawlViewFaviconController,
  type CrawlViewFaviconController,
} from './crawl-view-favicon-controller'
import {
  createCrawlViewThemeColorController,
  type CrawlViewThemeColorController,
  type CrawlViewThemeColorRefreshOptions,
  type CrawlViewThemeColorRefreshReason,
} from './crawl-view-theme-color-controller'
import { bindCrawlViewWebContentsEvents } from './crawl-view-webcontents-events'
import { scheduleFitToWidth } from './crawl-view/fit-to-width'
import {
  bindNativeHistoryNavigationGuard,
  repairUnsafeInternalHistoryNavigation,
} from './crawl-view/native-history-navigation-guard'
import { getEffectiveNavigationState } from './crawl-view/navigation-state'
import { createLogger } from './logger'

const log = createLogger('CrawlViewEvents')

/**
 * 爬虫视图事件类型
 */
export enum CrawlViewEventType {
  PAGE_LOADING = 'page:loading',
  PAGE_LOADED = 'page:loaded',
  PAGE_ERROR = 'page:error',
  VIEW_FOCUSED = 'view:focused',
  URL_CHANGED = 'url:changed',
  TITLE_CHANGED = 'title:changed',
  FAVICON_CHANGED = 'favicon:changed',
  THEME_COLOR_CHANGED = 'theme-color:changed',
  NAVIGATION_STARTED = 'navigation:started',
  NAVIGATION_COMPLETED = 'navigation:completed',
  NAVIGATION_FAILED = 'navigation:failed',
  NAVIGATION_STATE = 'navigation:state',
  CONSOLE_MESSAGE = 'console:message',
}

export interface CrawlViewEventData extends DispatchableCrawlViewEvent {}
export type CrawlViewExternalListener = CrawlViewEventListener

// ---------------------------------------------------------------------------
// Per-view event binding
// ---------------------------------------------------------------------------

type EmitFn = (type: CrawlViewEventType, data: any) => void

/**
 * : 绑定目标收窄为「持有 webContents 的容器」——WCV 与 <webview> tag
 * guest（主进程侧只有 WebContents，包一层即可）都满足。运行时行为不变：
 * binding 自始至终只消费 `.webContents`。
 */
type WebContentsHolder = Pick<WebContentsView, 'webContents'> | { webContents: WebContents }

class CrawlViewEventBinding {
  private detachWebContentsListeners: (() => void) | null = null
  private detachNativeHistoryNavigationGuard: (() => void) | null = null
  private readonly faviconController: CrawlViewFaviconController
  private readonly themeColorController: CrawlViewThemeColorController
  private onDestroyed: (() => void) | null = null
  private lastKnownUrl: string

  constructor(
    readonly viewId: string,
    private readonly webContentsView: WebContentsHolder,
    private readonly emit: EmitFn,
    private readonly onAutoDetach: (viewId: string) => void,
  ) {
    const webContents = webContentsView.webContents
    const vid = viewId
    this.lastKnownUrl = webContents.getURL()

    this.faviconController = createCrawlViewFaviconController({
      emitFaviconChanged: (payload) => {
        this.emit(CrawlViewEventType.FAVICON_CHANGED, payload)
      },
    })
    this.themeColorController = createCrawlViewThemeColorController({
      emitThemeColorChanged: (payload) => {
        this.emit(CrawlViewEventType.THEME_COLOR_CHANGED, payload)
      },
    })

    this.onDestroyed = () => {
      log.debug('WebContents 已销毁，自动分离绑定', { viewId: vid })
      this.detach()
      this.onAutoDetach(vid)
    }
    webContents.once('destroyed', this.onDestroyed)

    this.faviconController.attach(webContents, vid)
    this.themeColorController.attach(webContents, vid)
    this.detachNativeHistoryNavigationGuard = bindNativeHistoryNavigationGuard(
      webContents,
      () => this.emitNavigationState(),
    )

    this.detachWebContentsListeners = bindCrawlViewWebContentsEvents(webContents, {
      onDidStartLoading: () => {
        if (webContents.isDestroyed()) return
        this.rememberUrl(webContents.getURL())
        this.emit(CrawlViewEventType.PAGE_LOADING, {
          url: webContents.getURL(),
          viewId: vid,
        })
        this.emitNavigationState()
      },
      onDidFinishLoad: () => {
        if (webContents.isDestroyed()) return
        if (this.repairUnsafeInternalHistoryNavigation()) {
          return
        }
        this.rememberUrl(webContents.getURL())
        this.emit(CrawlViewEventType.PAGE_LOADED, {
          url: webContents.getURL(),
          title: webContents.getTitle(),
          viewId: vid,
        })
        this.emitNavigationState()
        this.refreshThemeColor('finishLoad')
        scheduleFitToWidth(vid)
      },
      onDidStopLoading: () => {
        if (this.repairUnsafeInternalHistoryNavigation()) {
          return
        }
        this.emitNavigationState()
      },
      onDidFailLoad: (
        _event,
        errorCode,
        errorDescription,
        validatedURL,
        isMainFrame = true,
        frameProcessId,
        frameRoutingId,
      ) => {
        const failureContext = {
          source: 'did-fail-load' as const,
          isMainFrame,
          frameProcessId,
          frameRoutingId,
          currentMainUrl: webContents.getURL(),
        }
        log.warn('浏览器加载失败事件', {
          viewId: vid,
          errorCode,
          errorDescription,
          source: failureContext.source,
          isMainFrame: failureContext.isMainFrame,
          frameProcessId: failureContext.frameProcessId,
          frameRoutingId: failureContext.frameRoutingId,
        })
        if (errorCode === -3 || !isMainFrame) return
        this.emit(CrawlViewEventType.PAGE_ERROR, {
          url: validatedURL,
          errorCode,
          errorDescription,
          viewId: vid,
          ...failureContext,
        })
        this.emitNavigationState()
      },
      onDidStartNavigation: (_event, url, isInPlace = false, isMainFrame = true) => {
        if (!isMainFrame) return
        this.emit(CrawlViewEventType.NAVIGATION_STARTED, {
          url,
          viewId: vid,
        })
        if (!isInPlace) {
          this.refreshThemeColor('navigation', { urlOverride: url })
        }
        this.emitNavigationState()
      },
      onDidNavigateInPage: (_event, url, isMainFrame = true) => {
        if (!isMainFrame) return
        const isHashOnly = this.isHashOnlyNavigation(url)
        this.rememberUrl(url)
        this.emit(CrawlViewEventType.URL_CHANGED, {
          url,
          viewId: vid,
        })
        this.emitNavigationState()
        this.refreshThemeColor(isHashOnly ? 'hashOnly' : 'inPage', { urlOverride: url })
      },
      onDidFrameNavigate: (event: any) => {
        if (event.frame && event.frame.parent === null) {
          this.rememberUrl(event.url)
          this.emit(CrawlViewEventType.NAVIGATION_COMPLETED, {
            url: event.url,
            httpResponseCode: event.httpResponseCode,
            httpStatusText: event.httpStatusText,
            viewId: vid,
          })
          this.emitNavigationState()
        }
      },
      onDidFailProvisionalLoad: (
        _event,
        errorCode,
        errorDescription,
        validatedURL,
        isMainFrame = true,
        frameProcessId,
        frameRoutingId,
      ) => {
        const failureContext = {
          source: 'did-fail-provisional-load' as const,
          isMainFrame,
          frameProcessId,
          frameRoutingId,
          currentMainUrl: webContents.getURL(),
        }
        log.warn('浏览器预提交加载失败事件', {
          viewId: vid,
          errorCode,
          errorDescription,
          source: failureContext.source,
          isMainFrame: failureContext.isMainFrame,
          frameProcessId: failureContext.frameProcessId,
          frameRoutingId: failureContext.frameRoutingId,
        })
        if (errorCode === -3 || !isMainFrame) return
        this.emit(CrawlViewEventType.NAVIGATION_FAILED, {
          url: validatedURL,
          errorCode,
          errorDescription,
          viewId: vid,
          ...failureContext,
        })
        this.emitNavigationState()
      },
      onWillNavigate: (_event, url) => {
        this.rememberUrl(url)
        this.emit(CrawlViewEventType.URL_CHANGED, {
          url,
          viewId: vid,
        })
        this.emitNavigationState()
      },
      onPageTitleUpdated: (_event, title) => {
        if (webContents.isDestroyed()) return
        this.emit(CrawlViewEventType.TITLE_CHANGED, {
          title,
          url: webContents.getURL(),
          viewId: vid,
        })
        this.emitNavigationState()
      },
      onPageFaviconUpdated: (_event, favicons) => {
        this.faviconController.handleFaviconUpdated(webContents, vid, favicons)
      },
      onDidChangeThemeColor: (_event, color) => {
        this.themeColorController.handleNativeThemeColorChange(webContents, vid, color)
      },
      onConsoleMessage: (event: any) => {
        this.emit(CrawlViewEventType.CONSOLE_MESSAGE, {
          level: event.level,
          message: event.message,
          line: event.line,
          sourceId: event.sourceId,
          viewId: vid,
        })
      },
    })
  }

  private repairUnsafeInternalHistoryNavigation(): boolean {
    const wc = this.webContentsView?.webContents
    if (!wc || wc.isDestroyed()) return false
    return repairUnsafeInternalHistoryNavigation(
      wc.getURL(),
      wc,
      () => this.emitNavigationState(),
    )
  }

  private rememberUrl(url: string | undefined): void {
    if (!url) return
    this.lastKnownUrl = url
  }

  private isHashOnlyNavigation(nextUrl: string): boolean {
    if (!this.lastKnownUrl || !nextUrl || this.lastKnownUrl === nextUrl) {
      return false
    }
    const prevWithoutHash = this.lastKnownUrl.split('#')[0]
    const nextWithoutHash = nextUrl.split('#')[0]
    return prevWithoutHash === nextWithoutHash
  }

  /**
   * 主题色刷新的对外唯一入口；外部只描述"为什么要刷新"，
   * 具体策略（是否清空 + 延迟矩阵）交给 themeColorController 统一处理。
   */
  refreshThemeColor(
    reason: CrawlViewThemeColorRefreshReason,
    options?: CrawlViewThemeColorRefreshOptions,
  ): void {
    const wc = this.webContentsView?.webContents
    if (!wc || wc.isDestroyed()) return
    this.themeColorController.requestThemeColorRefresh(wc, this.viewId, reason, options)
  }

  emitNavigationState(): void {
    const wc = this.webContentsView?.webContents
    if (!wc || wc.isDestroyed()) return
    try {
      const navigation = getEffectiveNavigationState(wc)
      this.emit(CrawlViewEventType.NAVIGATION_STATE, {
        canGoBack: navigation.canGoBack,
        canGoForward: navigation.canGoForward,
        isLoading: wc.isLoading(),
        url: wc.getURL(),
        title: wc.getTitle(),
        viewId: this.viewId,
      })
    } catch {
      // webContents may have been destroyed between the check and the call
    }
  }

  detach(): void {
    this.faviconController.detach()
    this.themeColorController.detach()

    const wc = this.webContentsView?.webContents
    if (wc && !wc.isDestroyed()) {
      this.detachWebContentsListeners?.()
      this.detachNativeHistoryNavigationGuard?.()
      if (this.onDestroyed) {
        wc.removeListener('destroyed', this.onDestroyed)
      }
    }
    this.detachWebContentsListeners = null
    this.detachNativeHistoryNavigationGuard = null
    this.onDestroyed = null
  }
}

// ---------------------------------------------------------------------------
// Registry — manages all per-view bindings + external listeners
// ---------------------------------------------------------------------------

export class CrawlViewEventManager {
  private static anonCounter = 0
  private mainWindow: BrowserWindow | null = null
  private bindings = new Map<string, CrawlViewEventBinding>()
  private externalListeners: CrawlViewExternalListener[] = []

  constructor(mainWindow: BrowserWindow) {
    this.mainWindow = mainWindow
  }

  /**
   * Bind event listeners for a WebContentsView.
   * If this viewId already has a binding, the old one is detached first.
   * Unlike the old single-instance model, attaching a new view does NOT
   * detach bindings for other views.
   */
  attach(webContentsView: WebContentsHolder, viewId?: string): void {
    const id = viewId || `anon-${++CrawlViewEventManager.anonCounter}-${Date.now()}`

    const existing = this.bindings.get(id)
    if (existing) {
      existing.detach()
      this.bindings.delete(id)
    }

    const binding = new CrawlViewEventBinding(
      id,
      webContentsView,
      (type, data) => this.dispatch(type, data, id),
      (viewId) => this.bindings.delete(viewId),
    )
    this.bindings.set(id, binding)
    log.info('事件绑定已附加', { viewId: id, totalBindings: this.bindings.size })

    binding.emitNavigationState()
    binding.refreshThemeColor('attach')
  }

  /**
   * Detach event binding for a specific view.
   * Called when a view is destroyed or no longer needs event tracking.
   */
  detach(viewId?: string): void {
    if (!viewId) {
      // Legacy compat: detach all (shouldn't normally happen)
      this.detachAll()
      return
    }
    const binding = this.bindings.get(viewId)
    if (binding) {
      binding.detach()
      this.bindings.delete(viewId)
      log.debug('事件绑定已分离', { viewId, remainingBindings: this.bindings.size })
    }
  }

  private detachAll(): void {
    for (const [id, binding] of this.bindings) {
      binding.detach()
    }
    this.bindings.clear()
  }

  private dispatch(type: CrawlViewEventType, data: any, fallbackViewId: string): void {
    dispatchCrawlViewEvent({
      type,
      data,
      fallbackViewId,
      mainWindow: this.mainWindow,
      externalListeners: this.externalListeners,
    })
  }

  /**
   * Push navigation state for a specific view, or for all bindings if no viewId given.
   */
  notifyNavigationState(viewId?: string): void {
    if (viewId) {
      this.bindings.get(viewId)?.emitNavigationState()
    } else {
      for (const binding of this.bindings.values()) {
        binding.emitNavigationState()
      }
    }
  }

  addExternalListener(listener: CrawlViewExternalListener): () => void {
    this.externalListeners.push(listener)
    return () => {
      this.externalListeners = this.externalListeners.filter(l => l !== listener)
    }
  }

  cleanup(): void {
    this.detachAll()
    this.externalListeners = []
    this.mainWindow = null
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton (preserves existing external API)
// ---------------------------------------------------------------------------

let eventManager: CrawlViewEventManager | null = null

export function initializeCrawlViewEventManager(mainWindow: BrowserWindow): void {
  if (eventManager) {
    eventManager.cleanup()
  }
  eventManager = new CrawlViewEventManager(mainWindow)
  log.info('事件管理器已初始化（多视图模式）')
}

export function getCrawlViewEventManager(): CrawlViewEventManager | null {
  return eventManager
}

export function cleanupCrawlViewEventManager(): void {
  if (eventManager) {
    eventManager.cleanup()
    eventManager = null
    log.info('事件管理器已清理')
  }
}

export function emitCrawlViewNavigationState(viewId?: string): void {
  eventManager?.notifyNavigationState(viewId)
}
