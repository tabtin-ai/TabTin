/**
 * 视图显示/隐藏模块
 *
 * 提供 showEmbeddedView / hideEmbeddedView 功能。
 * 通过 initViewDisplay() 注入运行时依赖，避免与主模块产生循环引用。
 */

import type { BrowserWindow, WebContentsView } from 'electron'
import { emitCrawlViewNavigationState, getCrawlViewEventManager } from '../crawl-view-events'
import { getViewFactory } from '../view-factory'
import { getViewStateRegistry } from '../webcontents/ViewStateRegistry'
import { getRunSessionManager } from '../run-session/RunSessionManager'
import { getOrganizationTabManager } from '../organization/OrganizationTabManager'
import { getCrawlspaceContextHub } from '../crawlspace/CrawlspaceContextHub'
import { ensureCrawlspaceWindowOpenHandler } from '../crawlspace/window-open-handler'
import type { ViewOptions } from './types'
import { hasAliveWebContents, validateNavigationUrl } from './utils'
import { scheduleFitToWidth } from './fit-to-width'
import { createLogger } from './logger'
import { guardLoadURL } from '../../shared/guard-load-url'
import { handleBlockedPreviewLoad } from '../blocked-preview-load'
import { markViewAttached, markViewDetached, attachViewInteractionListener } from './view-interaction'
import { applyBrowserViewBorderRadius } from '../browser-view-radius'

const logger = createLogger('view-display')

/**
 * 检查指定 viewId 是否被活跃的采集 Run 锁定。
 * 如果该 view 正关联到一个尚未结束的 Run，且该 Run 的 activeViewId 就是此 view，
 * 则视为 "有任务锁"，不应中断其当前导航。
 *
 * : 导出供 webview-host 的 navigate 路径复用（容器无关逻辑）。
 */
export function checkViewTaskLock(tabId: string | null): boolean {
  if (!tabId) return false
  try {
    const runManager = getRunSessionManager()
    const runId = runManager.getRunIdByView(tabId)
    if (!runId) return false
    const run = runManager.getRun(runId)
    if (!run) return false
    // 当 view 是该 Run 的活跃视图时，视为被锁定
    return run.activeViewId === tabId
  } catch {
    return false
  }
}

const shouldLogTabSwitch = process.env.TABTIN_DEBUG_TAB_SWITCH === '1'
const shouldLogCrawlViewVerbose = process.env.TABTIN_DEBUG_CRAWLVIEW_VERBOSE === '1'
const shouldLogCrawlBounds = process.env.TABTIN_DEBUG_CRAWL_BOUNDS === '1' || shouldLogCrawlViewVerbose
const logCrawlViewVerbose = (message: string, payload?: Record<string, unknown>) => {
  if (!shouldLogCrawlViewVerbose) return
  if (payload) { logger.info(message, payload); return }
  logger.info(message)
}
const logTabSwitch = (stage: string, payload: Record<string, unknown>) => {
  if (!shouldLogTabSwitch) return
  logger.info(`[TabSwitch] ${stage}`, { t: Date.now(), ...payload })
}

function shouldAllowPrivateHostNavigation(tabId: string | null, options?: ViewOptions): boolean {
  if (options?.allowPrivateHostNavigation) return true
  if (!tabId) return false
  try {
    return getViewFactory().getViewState(tabId)?.config.allowPrivateHostNavigation === true
  } catch {
    return false
  }
}

function resolveAllowedPrivateOrigins(tabId: string | null, url: string, options?: ViewOptions): string[] | undefined {
  if (options?.allowPrivateHostNavigation) {
    try {
      return [new URL(url).origin]
    } catch {
      return undefined
    }
  }
  if (!tabId) return undefined
  try {
    const config = getViewFactory().getViewState(tabId)?.config
    if (config?.allowPrivateHostNavigation && config.url) {
      return [new URL(config.url).origin]
    }
  } catch {
    return undefined
  }
  return undefined
}

/**
 * 受限 `file://` 放行的根目录来源（与 allowPrivateHostNavigation 同款无状态口径）：
 * 优先本次调用显式传入，否则读 view 自身持久化 config.localPreviewRoot——
 * 让 ⌘⇧T 还原 / discarded 唤醒 / 重启恢复用相同 config 重建 view 时放行自动保持。
 */
function resolveAllowedFileRoot(tabId: string | null, options?: ViewOptions): string | undefined {
  if (options?.localPreviewRoot) return options.localPreviewRoot
  if (!tabId) return undefined
  try {
    return getViewFactory().getViewState(tabId)?.config.localPreviewRoot || undefined
  } catch {
    return undefined
  }
}

type ViewDisplayDeps = {
  getMainWindow: () => BrowserWindow | null
  getCurrentTabId: () => string | null
  setCurrentTabId: (id: string | null) => void
  getOrCreateViewForTab: (tabId: string, url: string, runId?: string, options?: ViewOptions) => Promise<WebContentsView>
  cleanupStaleView: (tabId: string, reason: string) => void
  updateViewAccessTime: (tabId: string) => void
  warnMissingViewId: (action: string) => boolean
}

let _deps: ViewDisplayDeps = {
  getMainWindow: () => null,
  getCurrentTabId: () => null,
  setCurrentTabId: () => {},
  getOrCreateViewForTab: () => Promise.reject(new Error('ViewDisplay not initialized')),
  cleanupStaleView: () => {},
  updateViewAccessTime: () => {},
  warnMissingViewId: () => false,
}

export function initViewDisplay(deps: ViewDisplayDeps): void {
  _deps = deps
}

const _lastShowTime: Record<string, number> = {}

/**
 * 视图销毁时清理对应的节流记录，防止 _lastShowTime 随标签创建无限增长。
 */
export function deleteViewShowTimeEntry(tabId: string): void {
  delete _lastShowTime[tabId]
}

export async function showEmbeddedView(
  urlOrTabId: string,
  boundsOrUrl: { x: number; y: number; width: number; height: number } | string,
  maybeBounds?: { x: number; y: number; width: number; height: number },
  runId?: string,
  options?: ViewOptions,
): Promise<void> {
  const startTs = Date.now()
  const debugReload = process.env.DEBUG_VIEW_RELOAD === 'true'
  const currentMainWindow = _deps.getMainWindow()
  if (!currentMainWindow) {
    throw new Error('主窗口未设置')
  }

  let tabId: string | null = null
  let url: string
  let bounds: { x: number; y: number; width: number; height: number }

  if (typeof boundsOrUrl === 'string') {
    tabId = urlOrTabId
    url = boundsOrUrl
    bounds = maybeBounds!
  } else {
    url = urlOrTabId
    bounds = boundsOrUrl
  }

  const allowPrivateHostNavigation = shouldAllowPrivateHostNavigation(tabId, options)
  const allowedPrivateOrigins = resolveAllowedPrivateOrigins(tabId, url, options)
  const allowLocalFileRoot = resolveAllowedFileRoot(tabId, options)
  const urlCheck = validateNavigationUrl(url, {
    allowPrivateHostNavigation,
    allowedPrivateOrigins,
    allowLocalFileRoot,
  })
  if (!urlCheck.ok) {
    throw new Error(urlCheck.error!)
  }

  const throttleKey = tabId || url
  if (throttleKey) {
    const now = Date.now()
    const lastShow = _lastShowTime[throttleKey]
    if (lastShow && now - lastShow < 300) {
      let shouldSkip = true
      if (tabId && currentMainWindow) {
        try {
          const view = getViewFactory().getView(tabId)
          const isAttached = Boolean(view && currentMainWindow.contentView.children.includes(view))
          if (!view || !isAttached) shouldSkip = false
        } catch {
          shouldSkip = false
        }
      }
      if (shouldSkip) {
        logger.debug('⏩ 跳过快速重复 showEmbeddedView:', { tabId, url, deltaMs: now - lastShow })
        try {
          const view = tabId ? getViewFactory().getView(tabId) : null
          if (view) {
            view.setBounds(bounds)
            logger.debug('✅ 节流期间仍更新了 bounds:', { tabId, bounds })
          }
        } catch (error) {
          logger.warn('节流期间更新 bounds 失败:', error)
        }
        return
      }
    }
    _lastShowTime[throttleKey] = now
  }

  if (shouldLogCrawlBounds) {
    logger.info('CrawlBounds 主进程收到 showEmbeddedView', { tabId, url, bounds })
  }
  logTabSwitch('main:showEmbeddedView:start', { tabId, url, bounds })

  const hasTaskLock = checkViewTaskLock(tabId)

  if (!tabId) {
    throw new Error('[EmbeddedCrawlView] showEmbeddedView 缺少 tabId')
  }
  const view = await _deps.getOrCreateViewForTab(tabId, url, runId, options)

  if (hasAliveWebContents(view)) {
    const currentUrl = view.webContents.getURL()
    if (debugReload) {
      const registryState = getViewStateRegistry().getState(tabId)
      logger.debug('[DebugViewReload] main.show', {
        tabId, requestedUrl: url, currentUrl,
        registryUrl: registryState?.url, registryStatus: registryState?.status, hasTaskLock,
      })
    }
    if (currentUrl && currentUrl !== url && !hasTaskLock) {
      const navCheck = validateNavigationUrl(url, {
        allowPrivateHostNavigation,
        allowedPrivateOrigins,
        allowLocalFileRoot,
      })
      if (!navCheck.ok) {
        logger.warn('🚫 URL 变化导航被拦截:', { tabId, url, reason: navCheck.error })
      } else {
        const openIntentHints = options?.openIntentHints
        const previewGuard = guardLoadURL({ url, ...openIntentHints, source: 'view-display.navigate' })
        if (previewGuard.action === 'block-preview') {
          logger.info('🚫 Preview Guard 阻止 loadURL:', {
            tabId, url, previewKind: previewGuard.intent.previewKind,
          })
          handleBlockedPreviewLoad({
            url,
            source: 'view-display.navigate',
            intent: previewGuard.intent,
            mainWindow: currentMainWindow,
            ...openIntentHints,
          })
        } else {
          if (debugReload) {
            logger.warn('[DebugViewReload] main.loadURL', { tabId, from: currentUrl, to: url })
          }
          logger.debug('🔄 URL 已变化，导航到新 URL:', { from: currentUrl, to: url, tabId })
          try {
            await view.webContents.loadURL(url)
          } catch (error) {
            logger.warn('⚠️ 导航到新 URL 失败:', error)
          }
        }
      }
    }
  }

  const allowMultiple = Boolean(options?.allowMultiple)
  const currentTabId = _deps.getCurrentTabId()

  if (!allowMultiple && currentTabId && currentTabId !== tabId) {
    const oldView = getViewFactory().getView(currentTabId)
    if (hasAliveWebContents(oldView)) {
      try {
        // E2E-012 fix: 切换 Tab 时显式更新旧 View 的 attachedToMainWindow 状态
        const viewFactory = getViewFactory()
        if (viewFactory.hasView(currentTabId)) {
          viewFactory.markAttachedToMainWindow(currentTabId, false)
        }
        currentMainWindow.contentView.removeChildView(oldView)
        logger.debug('🔄 已隐藏旧视图:', currentTabId)
        markViewDetached(currentTabId)
      } catch (error) {
        logger.warn('隐藏旧视图失败:', error)
      }
    } else if (oldView) {
      try {
        const viewFactory = getViewFactory()
        if (viewFactory.hasView(currentTabId)) {
          viewFactory.markAttachedToMainWindow(currentTabId, false)
        }
      } catch (error) {
        logger.warn('更新 stale view attachedToMainWindow 状态失败:', error)
      }
      markViewDetached(currentTabId)
      _deps.cleanupStaleView(currentTabId, 'switch-tab')
    }
  }

  if (tabId) {
    _deps.setCurrentTabId(tabId)
    _deps.updateViewAccessTime(tabId)

    try {
      const runManager = getRunSessionManager()
      const resolvedRunId = runId || runManager.getRunIdByView(tabId)
      if (resolvedRunId) {
        runManager.createRun(resolvedRunId)
        runManager.setActiveView(resolvedRunId, tabId)
      }
    } catch (error) {
      logger.warn('设置 activeViewId 失败:', error)
    }

    try {
      const organizationTabManager = getOrganizationTabManager()
      const crawlspaceId = organizationTabManager.getTabByView(tabId)
      if (crawlspaceId && organizationTabManager.isOrganizationTab(crawlspaceId)) {
        getCrawlspaceContextHub().setActiveView(crawlspaceId, tabId)
      }
    } catch (error) {
      logger.warn('设置 Crawlspace activeView 失败:', error)
    }
  }

  view.setBounds(bounds)
  applyBrowserViewBorderRadius(view)
  if (tabId) scheduleFitToWidth(tabId)
  if (shouldLogCrawlBounds) {
    logger.info('CrawlBounds 主进程执行 show/setBounds', {
      tabId,
      url,
      requested: bounds,
      applied: view.getBounds(),
    })
  }

  const eventManager = getCrawlViewEventManager()
  if (eventManager) {
    eventManager.attach(view, tabId)
  }

  ensureCrawlspaceWindowOpenHandler(view.webContents, tabId)

  const existingViews = currentMainWindow.contentView.children

  try {
    const summary = existingViews.map((child: any, index: number) => {
      const wc = child?.webContents
      const id = wc && typeof wc.id === 'number' ? wc.id : undefined
      const childUrl = wc && typeof wc.getURL === 'function' ? wc.getURL() : undefined
      return { index, id, url: childUrl }
    })
    logger.debug('当前 contentView.children 概要:', { total: existingViews.length, views: summary })
  } catch (error) {
    logger.warn('打印 children 概要失败:', error)
  }

  const isAlreadyAttached = existingViews.includes(view)

  let viewFactoryState: { attachedToMainWindow?: boolean } | undefined
  if (tabId) {
    try {
      viewFactoryState = getViewFactory().getViewState(tabId)
    } catch (error) {
      logger.warn('getViewState failed:', error)
    }
  }

  if (isAlreadyAttached && viewFactoryState?.attachedToMainWindow === true) {
    logger.debug('⏭️  视图已附加到主窗口，跳过重复操作:', { tabId, bounds })
  } else if (!isAlreadyAttached) {
    const before = existingViews.length

    const viewUrl = view.webContents.getURL()
    // 防御主窗口 webContents 被错误地当成子视图重新挂载。覆盖三种主 renderer 形态：
    //   - dev: vite dev server (localhost:5170-5189)
    //   - packaged: tabtin-file://app/index.html（主窗口/分离 chat 窗口都用这个 origin）
    //   - 历史 file:// 加载（防回退）
    if (viewUrl && (
      viewUrl.includes('localhost:517') ||
      viewUrl.includes('localhost:518') ||
      viewUrl.startsWith('tabtin-file://app/') ||
      viewUrl.includes('/renderer/index.html')
    )) {
      logger.error('🚨 阻止将主窗口添加为子视图！', { tabId, url: viewUrl })
      throw new Error(`🚨 检测到尝试将主窗口添加为子视图 (tabId: ${tabId}, url: ${viewUrl})`)
    }

    currentMainWindow.contentView.addChildView(view)
    const after = currentMainWindow.contentView.children.length
    logger.debug('视图已添加到主窗口:', { tabId, before, after, bounds })

    if (tabId) {
      try {
        const viewFactory = getViewFactory()
        if (viewFactory.hasView(tabId)) {
          viewFactory.markAttachedToMainWindow(tabId, true)
          logger.debug('✅ 已同步 attachedToMainWindow=true 到 ViewFactory:', tabId)
        }
      } catch (error) {
        logger.warn('同步 ViewFactory 状态失败:', error)
      }
    }
  } else {
    logger.debug('视图已在主窗口中，跳过 addChildView:', tabId)
  }

  if (tabId && currentMainWindow.contentView.children.includes(view)) {
    markViewAttached(tabId)
  }

  const registry = getViewStateRegistry()
  const registryState = tabId ? registry.getState(tabId) : null

  const currentURL = view.webContents.getURL()
  const viewState = tabId ? getViewFactory().getViewState(tabId) : null
  const status = registryState?.status
  const webContentsIsLoading = view.webContents.isLoading()

  if (webContentsIsLoading && (status === 'idle' || status === 'error' || !status) && tabId) {
    logger.debug('📊 状态不一致: webContents 正在加载但 registry 状态为', status, { tabId })
  }

  if (status === 'loaded' && webContentsIsLoading) {
    logger.debug('📊 DOM 已就绪（Registry=loaded），子资源仍在加载')
  }

  const loadingDuration = (status === 'loading' && registryState?.lastAccessTime)
    ? Date.now() - registryState.lastAccessTime
    : 0
  const hasLoadingTimeout = loadingDuration > 60000

  if (status === 'loading' && hasLoadingTimeout) {
    logger.warn('⚠️  加载超过 60 秒，可能卡住了，允许重新加载', { tabId, url, loadingDuration })
  }

  const normalizeURL = (u: string): string => {
    try { return new URL(u).href.replace(/\/$/, '') } catch { return u }
  }

  const normalizedCurrentURL = normalizeURL(currentURL || '')
  const normalizedRequestURL = normalizeURL(url)
  const isURLMatched = normalizedCurrentURL === normalizedRequestURL

  logger.debug('📊 View 状态检查:', {
    tabId: tabId?.slice(0, 30),
    currentURL, requestedURL: url,
    viewStateURL: viewState?.url,
    registryStatus: status, webContentsIsLoading,
    loadingDuration: status === 'loading' ? `${loadingDuration}ms` : 'N/A',
    hasLoadingTimeout,
    isURLMatched,
    isConsistent: status === 'loading' ? webContentsIsLoading : true,
  })

  const shouldLoad = (
    status === 'idle' ||
    status === 'error' ||
    !status ||
    (status === 'loading' && hasLoadingTimeout)
  ) && !hasTaskLock && !webContentsIsLoading && !isURLMatched

  const shouldWait = status === 'loading' && !hasLoadingTimeout

  if (shouldWait) {
    logger.debug('⏭️  View 正在加载，立即返回（后台加载）:', {
      tabId, url,
      loadingDuration: `${loadingDuration}ms`,
    })
  } else if (shouldLoad) {
    const loadCheck = validateNavigationUrl(url, {
      allowPrivateHostNavigation,
      allowedPrivateOrigins,
      allowLocalFileRoot,
    })
    if (!loadCheck.ok) {
      logger.warn('🚫 加载 URL 被拦截:', { tabId, url, reason: loadCheck.error })
    } else {
      const openIntentHints = options?.openIntentHints
      const previewGuard = guardLoadURL({ url, ...openIntentHints, source: 'view-display.initial-load' })
      if (previewGuard.action === 'block-preview') {
        logger.info('🚫 Preview Guard 阻止 loadURL:', {
          tabId, url, previewKind: previewGuard.intent.previewKind,
        })
        handleBlockedPreviewLoad({
          url,
          source: 'view-display.initial-load',
          intent: previewGuard.intent,
          mainWindow: currentMainWindow,
          ...openIntentHints,
        })
      } else {
        logger.debug('🔄 需要加载 URL:', {
          reason: status === 'error' ? 'View 加载失败' : 'View 未加载',
          from: currentURL || viewState?.url,
          to: url,
        })

        try {
          registry.updateState(tabId || '', { status: 'loading', url })
        } catch (error) {
          logger.warn('⚠️ 预标记 loading 失败（忽略继续）:', error)
        }

        try {
          await view.webContents.loadURL(url)
          logger.debug('✅ URL 已加载:', url)
        } catch (error: any) {
          if (error.code !== 'ERR_ABORTED') {
            logger.error('❌ URL 加载失败:', error)
            throw error
          } else {
            logger.debug('ℹ️  导航被中止（正常）:', url)
          }
        }
      }
    }
  } else if (status === 'loaded') {
    logger.debug('✅ View 已加载完成，跳过加载:', { url: currentURL, status })
  }

  emitCrawlViewNavigationState()
}

export function hideEmbeddedView(requestedTabId?: string): void {
  logCrawlViewVerbose('[EmbeddedCrawlView] 🔴 hideEmbeddedView 被调用:', {
    requestedTabId,
    currentTabId: _deps.getCurrentTabId(),
    stack: new Error().stack?.split('\n').slice(1, 5).join('\n'),
  })

  if (!requestedTabId && _deps.warnMissingViewId('hide')) {
    return
  }

  const currentMainWindow = _deps.getMainWindow()
  const currentTabId = _deps.getCurrentTabId()
  const targetTabId = requestedTabId || currentTabId
  if (targetTabId && currentMainWindow) {
    const view = getViewFactory().getView(targetTabId)
    if (hasAliveWebContents(view)) {
      try {
        const existingViews = currentMainWindow.contentView.children
        const isActuallyAttached = existingViews.includes(view)

        if (!isActuallyAttached) {
          logCrawlViewVerbose('[EmbeddedCrawlView] ⏭️  视图未附加到主窗口，跳过隐藏操作:', {
            tabId: targetTabId,
          })
          markViewDetached(targetTabId)
          if (targetTabId === currentTabId) {
            _deps.setCurrentTabId(null)
            emitCrawlViewNavigationState()
          }
          logTabSwitch('main:hideEmbeddedView:skip', { tabId: targetTabId, reason: 'not-attached' })
          return
        }

        // E2E-011 fix: 在 removeChildView 前同步更新 attachedToMainWindow，
        // 避免异步更新导致的竞态（其他代码在窗口期内读到过期状态）
        try {
          const viewFactory = getViewFactory()
          if (viewFactory.hasView(targetTabId)) {
            viewFactory.markAttachedToMainWindow(targetTabId, false)
            logger.debug('✅ 已同步 attachedToMainWindow=false 到 ViewFactory:', targetTabId)
          }
        } catch (error) {
          logger.warn('同步 ViewFactory 状态失败:', error)
        }

        currentMainWindow.contentView.removeChildView(view)
        logger.debug('✅ 已隐藏标签视图（保留状态）:', targetTabId)
        markViewDetached(targetTabId)

        if (targetTabId === currentTabId) {
          _deps.setCurrentTabId(null)
          emitCrawlViewNavigationState()
        }
        return
      } catch (error) {
        logger.error('隐藏标签视图失败:', error)
      }
    } else if (view) {
      markViewDetached(targetTabId)
      _deps.cleanupStaleView(targetTabId, 'hide-view')
    }
    return
  }
}
