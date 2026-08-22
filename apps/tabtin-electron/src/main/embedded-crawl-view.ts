/**
 * 嵌入式爬虫视图管理器
 *
 * 负责管理主窗口中嵌入的 WebContentsView
 */

import { BrowserWindow, WebContentsView, type WebContents } from 'electron'
import { getCrawlViewEventManager, emitCrawlViewNavigationState } from './crawl-view-events'
import { getRunSessionManager } from './run-session/RunSessionManager'
import { getViewFactory } from './view-factory'
import { updateCrashRecoveryCallbacks } from './view-factory/crash-recovery'
import type { ViewProfile } from './view-factory/types'
import { ensureCrawlspaceWindowOpenHandler } from './crawlspace/window-open-handler'
import { getCrawlspaceContextHub } from './crawlspace/CrawlspaceContextHub'
import type { ViewOptions, LoadUrlOptions, WaitForOptions } from './crawl-view/types'
import {
  initNavigation,
  goBack as _goBack,
  goForward as _goForward,
  reload as _reload,
  stop as _stop,
  getNavigationState as _getNavigationState
} from './crawl-view/navigation'
import { createLogger } from './crawl-view/logger'
import { hasAliveWebContents, isAliveWebContents, ts } from './crawl-view/utils'
import {
  initViewInteraction,
  attachViewInteractionListener,
  markViewDetached,
  isMultiViewActive,
  syncIgnoreMouseEventsForAttached,
  clearInteractionState,
  deleteInteractionForView,
} from './crawl-view/view-interaction'
import {
  initViewDisplay,
  showEmbeddedView as _showEmbeddedView,
  hideEmbeddedView as _hideEmbeddedView,
} from './crawl-view/view-display'

const logger = createLogger('embedded-crawl-view')
import {
  initContentOps,
  executeScript as _executeScript,
  loadUrl as _loadUrl,
  waitForTabReady as _waitForTabReady,
  waitForSelector as _waitForSelector,
  screenshot as _screenshot,
  getCDPEndpoint as _getCDPEndpoint,
  getWebContentsId as _getWebContentsId,
  getHTML as _getHTML,
  getPageInfo as _getPageInfo,
} from './crawl-view/content-ops'
import {
  initIpcHandlers,
  registerEmbeddedCrawlViewHandlers as _registerEmbeddedCrawlViewHandlers,
  unregisterAllIpcHandlers,
} from './crawl-view/ipc-handlers'
import { deleteViewShowTimeEntry } from './crawl-view/view-display'
import { clearFitToWidthState } from './crawl-view/fit-to-width'
import { handleNativeHistoryAppCommand } from './crawl-view/native-history-navigation-guard'

// 与 ViewFactory 默认 maxViews 保持一致（ViewFactory.ts options.maxViews ?? 50）
const VIEW_MAX = 50

export type { ViewOptions, LoadUrlOptions, WaitForOptions }
export { type NavigationState } from './crawl-view/types'

type ResourceManagerAccessor = () => { touchView?: (viewId: string, reason?: string) => boolean } | null;

let resourceManagerAccessor: ResourceManagerAccessor | null = null;

export function setResourceManagerAccessor(accessor: ResourceManagerAccessor): void {
  resourceManagerAccessor = accessor;
}

/**
 * 架构说明：
 * - 所有 View 状态由 ViewFactory 统一管理
 * - 所有 View 操作通过 ViewFactory API 进行
 * - 不再维护本地 viewMap 和 viewMetadataMap
 */
let currentMainWindow: BrowserWindow | null = null
let currentTabId: string | null = null
let viewFactoryCleanupRegistered = false
let appCommandGuardWindow: BrowserWindow | null = null
let appCommandGuardHandler: ((event: Electron.Event, command: string) => void) | null = null

const warnMissingViewId = (action: string): boolean => {
  if (!isMultiViewActive()) {
    return false
  }
  logger.warn('⚠️ 多视图模式需要显式 viewId:', { action, currentTabId })
  return true
}

function cleanupStaleView(tabId: string, reason: string): void {
  markViewDetached(tabId)
  const viewFactory = getViewFactory()
  const existed = viewFactory.hasView(tabId)

  if (existed) {
    viewFactory.destroyView(tabId, { force: true }).catch(error => {
      logger.warn('清理失效视图失败:', { tabId, reason, error })
    })
  }

  if (currentTabId === tabId) {
    currentTabId = null
  }

  if (existed) {
    logger.warn('🧹 移除失效视图引用:', { tabId, reason })
  }
}

function markViewInUse(tabId: string): void {
  getViewFactory().markViewInUse(tabId)
}

function releaseViewInUse(tabId: string): void {
  getViewFactory().releaseViewInUse(tabId)
}

function installNativeHistoryAppCommandGuard(mainWindow: BrowserWindow): void {
  if (appCommandGuardWindow === mainWindow && appCommandGuardHandler) return
  if (appCommandGuardWindow && appCommandGuardHandler && !appCommandGuardWindow.isDestroyed()) {
    appCommandGuardWindow.removeListener('app-command', appCommandGuardHandler)
  }

  appCommandGuardWindow = mainWindow
  appCommandGuardHandler = (event, command) => {
    handleNativeHistoryAppCommand(event, command, {
      goBack: () => (currentTabId ? _goBack(currentTabId) : false),
      goForward: () => (currentTabId ? _goForward(currentTabId) : false),
      emitNavigationState: () => {
        if (currentTabId) {
          emitCrawlViewNavigationState(currentTabId)
        }
      },
    })
  }
  mainWindow.on('app-command', appCommandGuardHandler)
}

function uninstallNativeHistoryAppCommandGuard(): void {
  if (appCommandGuardWindow && appCommandGuardHandler && !appCommandGuardWindow.isDestroyed()) {
    appCommandGuardWindow.removeListener('app-command', appCommandGuardHandler)
  }
  appCommandGuardWindow = null
  appCommandGuardHandler = null
}

/**
 * 统一清理单个 view 关联的所有资源（Map 条目）。
 */
function cleanupViewResources(tabId: string): void {
  preprocessedCache.delete(tabId)
  deleteInteractionForView(tabId)
  deleteViewShowTimeEntry(tabId)
  clearFitToWidthState(tabId)
}

function registerViewFactoryResourceCleanup(): void {
  if (viewFactoryCleanupRegistered) return
  getViewFactory().on('view:destroyed', ({ id }) => {
    cleanupViewResources(id)
  })
  viewFactoryCleanupRegistered = true
}

function updateViewAccessTime(tabId: string): void {
  const viewFactory = getViewFactory()
  if (viewFactory.hasView(tabId)) {
    logger.debug('📊 访问 View（lastAccessAt 会自动更新）:', tabId)
  }
}

function getCacheStats(): {
  total: number
  max: number
  idle: number
  inUse: number
  current: string | null
} {
  const stats = getViewFactory().getStats()
  return {
    total: stats.total,
    max: VIEW_MAX,
    idle: stats.idle,
    inUse: stats.inUse,
    current: currentTabId
  }
}

/**
 * 初始化嵌入式爬虫视图
 */
export function initializeEmbeddedCrawlView(mainWindow: BrowserWindow): void {
  currentMainWindow = mainWindow
  registerViewFactoryResourceCleanup()
  installNativeHistoryAppCommandGuard(mainWindow)

  initViewInteraction({ getMainWindow: () => currentMainWindow })

  initViewDisplay({
    getMainWindow: () => currentMainWindow,
    getCurrentTabId: () => currentTabId,
    setCurrentTabId: (id) => { currentTabId = id },
    getOrCreateViewForTab,
    cleanupStaleView,
    updateViewAccessTime,
    warnMissingViewId,
  })

  // : navigation / content-ops 已容器无关化，注入面统一收窄为 WebContents
  initNavigation({
    getActiveWebContents,
    getCurrentTabId: () => currentTabId,
    warnMissingViewId,
  })

  initContentOps({
    getActiveWebContents,
    getCurrentTabId: () => currentTabId,
    warnMissingViewId,
    getOrCreateWebContentsForTab: async (tabId, url, runId, options) => {
      // : tab 已由 <webview> guest 承载时直接复用 guest 的 WebContents。
      // 不得进 getOrCreateViewForTab——guest 条目 view 为 null，会被其
      // 「状态不一致」分支强制销毁注册并重建一个不可见的影子 WCV，
      // 后续 executeScript / 截图全部打进影子（用户看到的页面无反应）。
      const viewFactory = getViewFactory()
      if (viewFactory.getViewState(tabId)?.containerKind === 'webview-tag') {
        const guestWc = viewFactory.getWebContents(tabId)
        if (isAliveWebContents(guestWc)) {
          return guestWc
        }
        throw new Error(`[EmbeddedCrawlView] webview guest 不可用（可能已销毁）: ${tabId}`)
      }
      return (await getOrCreateViewForTab(tabId, url, runId, options)).webContents
    },
    getPendingViewCreation: (tabId) => {
      const pending = viewCreationPromises.get(tabId)
      return pending ? pending.then((view) => view.webContents) : undefined
    },
    getPendingViewCreationCount: () => viewCreationPromises.size,
    getRunSessionManager: () => getRunSessionManager(),
  })

  initIpcHandlers({
    showEmbeddedView,
    hideEmbeddedView,
    destroyTabView,
    syncIgnoreMouseEventsForAttached,
    getOrCreateViewForTab,
    cleanupStaleView,
    getMainWindow: () => currentMainWindow,
    getCurrentTabId: () => currentTabId,
    getResourceManagerAccessor: () => resourceManagerAccessor,
    getCacheStats,
    getAllTabsInfo,
  })

  logger.debug('初始化完成')
}

// ❌ 已废弃：getOrCreateView() 函数已移除

/**
 * 创建中的 View Promise 缓存（防止并发重复创建）
 */
const viewCreationPromises = new Map<string, Promise<WebContentsView>>();
const preprocessedCache = new Map<string, {
  timestamp: number;
  result: {
    success: boolean;
    cleanHtml?: string;
    skeletonHtml?: string;
    title?: string;
    url?: string;
    stats?: any;
    contentInsights?: any;
    scrollDetection?: any;
    error?: string;
  };
}>();

function assertViewOptions(tabId: string, options?: ViewOptions): {
  profile: ViewProfile
  partition?: string
  crawlspaceId?: string
  kind: 'workspace-view' | 'normal-view'
} {
  if (!options) {
    throw new Error(`[EmbeddedCrawlView] 缺少 ViewOptions（tabId=${tabId}）`)
  }
  if (!options.profile) {
    throw new Error(`[EmbeddedCrawlView] 缺少 profile（tabId=${tabId}）`)
  }
  if (!options.kind) {
    throw new Error(`[EmbeddedCrawlView] 缺少 kind（tabId=${tabId}）`)
  }
  if (options.kind === 'workspace-view') {
    if (!options.crawlspaceId) {
      throw new Error(`[EmbeddedCrawlView] workspace-view 缺少 crawlspaceId（tabId=${tabId}）`)
    }
    if (!options.partition) {
      throw new Error(`[EmbeddedCrawlView] workspace-view 缺少 partition（tabId=${tabId}）`)
    }
  }
  if (options.kind === 'normal-view' && options.crawlspaceId) {
    throw new Error(`[EmbeddedCrawlView] normal-view 不应传 crawlspaceId（tabId=${tabId}）`)
  }
  return {
    profile: options.profile,
    partition: options.partition,
    crawlspaceId: options.crawlspaceId,
    kind: options.kind
  }
}

function logCallStack(label: string) {
  const stack = new Error().stack;
  const lines = stack?.split('\n').slice(2, 5) || [];
  logger.debug(`📞 ${label} 调用栈:`, lines.join('\n    '));
}

const VIEW_CREATION_TIMEOUT_MS = 30_000

/**
 * 为指定标签创建或获取 WebContentsView
 */
async function getOrCreateViewForTab(
  tabId: string,
  url: string,
  runId?: string,
  options?: ViewOptions
): Promise<WebContentsView> {
  const startTime = Date.now()
  logger.debug('═══════════════════════════════════════════')
  logger.debug('🔵 getOrCreateViewForTab 开始:', {
    tabId,
    url,
    runId,
    timestamp: ts()
  })
  logCallStack('getOrCreateViewForTab')

  const existingPromise = viewCreationPromises.get(tabId)
  if (existingPromise) {
    logger.debug('⏳ View 正在创建中，等待已有 Promise:', tabId)
    const view = await existingPromise
    logger.debug('✅ 等待完成，返回 View:', tabId, `耗时: ${Date.now() - startTime}ms`)
    return view
  }

  let resolveCreation: (view: WebContentsView) => void
  let rejectCreation: (error: any) => void

  const creationPromise = new Promise<WebContentsView>((resolve, reject) => {
    resolveCreation = resolve
    rejectCreation = reject
  })

  viewCreationPromises.set(tabId, creationPromise)
  logger.debug('💾 Promise 已缓存到队列:', tabId, '队列大小:', viewCreationPromises.size)

  const timeoutId = setTimeout(() => {
    if (viewCreationPromises.has(tabId)) {
      viewCreationPromises.delete(tabId)
      const elapsed = Date.now() - startTime
      logger.error('⏰ View 创建超时，强制 reject:', {
        tabId,
        timeoutMs: VIEW_CREATION_TIMEOUT_MS,
        elapsedMs: elapsed,
        stats: (() => { try { return getViewFactory().getStats() } catch { return null } })()
      })
      rejectCreation!(new Error(
        `[EmbeddedCrawlView] View 创建超时 (${VIEW_CREATION_TIMEOUT_MS}ms): tabId=${tabId}`
      ))
    }
  }, VIEW_CREATION_TIMEOUT_MS)

  ;(async () => {
    try {
      try {
        const viewFactory = getViewFactory()
        const hasView = viewFactory.hasView(tabId)
        logger.debug('  ViewFactory.hasView() 返回:', hasView)

        if (hasView) {
          logger.debug('♻️  ViewFactory 中找到 View，准备复用:', tabId)
          const state = viewFactory.getViewState(tabId)
          logger.debug('  ViewFactory.getViewState() 返回:', {
            hasState: !!state,
            url: state?.url,
            attachedToMainWindow: state?.attachedToMainWindow,
            createdAt: state?.createdAt
          })
          if (process.env.TABTIN_DEBUG_TAB_SWITCH === '1') {
            logger.debug('[TabSwitch] main:viewState', {
              t: Date.now(),
              tabId,
              attachedToMainWindow: state?.attachedToMainWindow ?? null,
              createdAt: state?.createdAt ?? null,
              url: state?.url ?? null
            })
          }

          // : tab 已由 <webview> guest 承载（容器在 renderer）——主进程
          // 不得销毁 guest 注册再重建 WCV：那会杀掉用户看得见的页面并造出一个
          // 不可见的影子视图。页面能力（executeScript / 截图 / getHTML）应走
          // ViewFactory.getWebContents 容器无关路径（content-ops 已短路）。
          if (state?.containerKind === 'webview-tag') {
            throw new Error(
              `[EmbeddedCrawlView] tab ${tabId} 由 webview 容器承载，拒绝创建/重建 WCV；` +
              '页面能力请走 ViewFactory.getWebContents 容器无关路径'
            )
          }

          if (state?.view) {
            updateViewAccessTime(tabId)
            attachViewInteractionListener(state.view, tabId)
            logger.debug('✅ 复用完成，返回 View:', tabId, `耗时: ${Date.now() - startTime}ms`)
            resolveCreation!(state.view)
            return
          } else {
            // hasView=true 但 getViewState=null：状态不一致，避免重复创建覆盖原 View 造成资源泄漏
            // 先尝试销毁不一致的 View，再走正常创建流程
            logger.warn('⚠️  hasView=true 但 getViewState=null，尝试销毁不一致状态后重新创建:', tabId)
            try {
              await viewFactory.destroyView(tabId, { force: true })
            } catch (destroyErr) {
              logger.warn('销毁不一致 View 失败（忽略，继续创建）:', destroyErr)
            }
          }
        } else {
          logger.debug('  💡 ViewFactory 中没有此 View，继续检查')
        }
      } catch (error) {
        logger.error('❌ 检查 ViewFactory 失败:', error)
      }

      const viewFactory = getViewFactory()
      const validated = assertViewOptions(tabId, options)
      const profile = validated.profile
      const partition = validated.partition
      const crawlspaceId = validated.crawlspaceId
      const kind = validated.kind
      const keepAlive = true
      const profileReason = 'explicit-from-renderer'
      logger.debug('  📋 选择 Profile:', { tabId, profile, keepAlive, reason: profileReason })

      const viewHandle = await viewFactory.createView({
        profile,
        id: tabId,
        url: 'about:blank',
        bounds: { x: -10000, y: -10000, width: 100, height: 100 },
        displayMode: 'hidden',
        notifyRenderer: false,
        keepAlive,
        runId,
        partition,
        spaceId: options?.spaceId,
        metadata: {
          createdBy: 'embedded-crawl-view',
          source: 'tab',
          profileReason,
          crawlspaceId,
          kind,
          isPreview: Boolean(options?.isPreview)
        }
      })

      const view = viewHandle.view
      attachViewInteractionListener(view, tabId)
      logger.debug('  ✅ ViewFactory 创建完成:', {
        id: viewHandle.id,
        profile: viewHandle.profile,
        reused: viewHandle.reused
      })

      const eventManager = getCrawlViewEventManager()
      if (eventManager) {
        eventManager.attach(view, tabId)
      }

      ensureCrawlspaceWindowOpenHandler(view.webContents, tabId)

      // 通过 crash-recovery 统一入口注入业务层回调，
      // 消除与 ViewFactory 通用层双重 render-process-gone 监听的冲突。
      updateCrashRecoveryCallbacks(tabId, {
        onBeforeRecover: (_viewId, details) => {
          cleanupViewResources(tabId)
          if (crawlspaceId) {
            getCrawlspaceContextHub().setViewError(crawlspaceId, tabId, {
              errorDescription: `Render process gone: ${details.reason} (exit ${details.exitCode})`,
            })
          }
        },
        onRecoverFailed: () => {
          if (currentMainWindow && !currentMainWindow.isDestroyed()) {
            try {
              currentMainWindow.contentView.removeChildView(view)
            } catch (err) {
              logger.warn('removeChildView failed (view may already be detached):', err)
            }
          }
        },
        onRecoverSuccess: () => {
          if (crawlspaceId) {
            getCrawlspaceContextHub().setViewError(crawlspaceId, tabId, null)
          }
        },
      })

      const stats = getCacheStats()
      logger.debug('✅ 视图已创建:', tabId, `(视图: ${stats.total}/${stats.max})`)

      resolveCreation!(view)
    } catch (error) {
      logger.error('❌ 创建流程失败:', error)
      logger.error('⚠️  不再使用回退方案，请修复 ViewFactory 的问题')
      rejectCreation!(error)
    } finally {
      clearTimeout(timeoutId)
      viewCreationPromises.delete(tabId)
      logger.debug('🧹 清理创建队列:', tabId)
    }
  })()

  const view = await creationPromise
  logger.debug('✅ getOrCreateViewForTab 完成:', tabId, `总耗时: ${Date.now() - startTime}ms`)
  return view
}

export const showEmbeddedView = _showEmbeddedView
export const hideEmbeddedView = _hideEmbeddedView

export async function destroyTabView(tabId: string): Promise<void> {
  logger.debug('销毁标签视图请求:', tabId);

  if (!tabId) {
    logger.warn('⚠️  tabId 为空，跳过销毁');
    return;
  }

  markViewDetached(tabId)
  if (currentTabId === tabId) {
    currentTabId = null
  }

  const viewFactory = getViewFactory();
  if (viewFactory.isDestroyingView?.(tabId)) {
    logger.debug('⏭️  标签视图正在销毁，跳过:', tabId);
    return;
  }

  if (!viewFactory.hasView(tabId)) {
    logger.debug('⏭️  标签视图不存在，跳过销毁:', tabId);
    cleanupViewResources(tabId)
    return;
  }

  try {
    await viewFactory.destroyView(tabId, { force: true });
    logger.debug('✅ 标签视图已销毁（通过 ViewFactory）:', tabId);
    emitCrawlViewNavigationState();
  } catch (error) {
    logger.error('销毁标签视图失败:', tabId, error);
    throw error;
  } finally {
    cleanupViewResources(tabId)
  }
}

function getActiveView(): WebContentsView | null {
  if (currentTabId) {
    const active = getViewFactory().getView(currentTabId)
    if (hasAliveWebContents(active)) {
      return active
    }
    if (active) {
      cleanupStaleView(currentTabId, 'active-view-stale')
    }
  }
  return null
}

/** : 容器无关注入面 — navigation / content-ops 只需要页面 WebContents */
function getActiveWebContents(): WebContents | null {
  const viaView = getActiveView()?.webContents
  if (viaView) return viaView
  //  Phase 3: webview guest 条目 view 恒 null，回落 ViewFactory.getWebContents
  // 容器无关路径——否则「无 tabId 回退到当前活动 tab」的调用面在 webview 模式全部失效
  if (currentTabId) {
    const guestWc = getViewFactory().getWebContents(currentTabId)
    if (isAliveWebContents(guestWc)) return guestWc
  }
  return null
}

async function waitForActiveView(retries = 30, interval = 200): Promise<WebContentsView | null> {
  if (isMultiViewActive()) {
    logger.warn('⚠️ 多视图模式下不允许等待当前活动 View')
    return null
  }
  for (let attempt = 0; attempt < retries; attempt++) {
    const view = getActiveView()
    if (view) {
      logger.debug(`✅ 获取活动 View 成功（尝试 ${attempt + 1}/${retries}）`);
      return view
    }
    logger.debug(`⏳ 等待活动 View（尝试 ${attempt + 1}/${retries}）...`);
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
  logger.error('❌ 等待活动 View 超时');
  return null
}

// Re-export navigation for backward compatibility
export const goBack = _goBack
export const goForward = _goForward
export const reload = _reload
export const stop = _stop
export const getNavigationState = _getNavigationState

// Re-export content ops for backward compatibility
export const executeScript = _executeScript
export const loadUrl = _loadUrl
export const waitForTabReady = _waitForTabReady
export const waitForSelector = _waitForSelector
export const screenshot = _screenshot
export const getCDPEndpoint = _getCDPEndpoint
export const getWebContentsId = _getWebContentsId
export const getHTML = _getHTML
export const getPageInfo = _getPageInfo

// Re-export IPC handler registration
export const registerEmbeddedCrawlViewHandlers = _registerEmbeddedCrawlViewHandlers

export function hasView(tabId: string): boolean {
  return getViewFactory().hasView(tabId)
}

export function getView(tabId: string): WebContentsView | undefined {
  const view = getViewFactory().getView(tabId)
  return view ?? undefined
}

/**
 * : 容器无关的页面句柄。WCV 条目返回 view 本体；webview guest 条目
 * （ViewEntry.view 恒为 null，页面能力在 guestWebContents）包一层
 * `{ webContents }`，让只消费 `.webContents` 的调用方（CLI viewGetter →
 * validateViewExists / requireTabWithView / print / record）对两种容器一致工作。
 * 只用 getView 的话 webview tab 在 CLI 眼里永远"不存在"。
 */
export function getViewPageHandle(
  tabId: string,
): WebContentsView | { webContents: WebContents } | undefined {
  const view = getViewFactory().getView(tabId)
  if (view) return view
  const webContents = getViewFactory().getWebContents(tabId)
  return webContents ? { webContents } : undefined
}

export function registerExternalView(
  viewId: string,
  view: WebContentsView,
  options?: {
    profile?: ViewProfile
    url?: string
    metadata?: Record<string, any>
    runId?: string
    partition?: string
    source?: string
  }
): void {
  const estimatedMemory = 50
  const currentUrl = view.webContents?.getURL?.() ?? ''
  const baseMetadata = options?.metadata || {}
  const metadata = {
    ...baseMetadata,
    createdBy: baseMetadata.createdBy ?? 'external',
    source: options?.source ?? baseMetadata.source ?? 'registerExternalView',
    estimatedMemory
  }
  const sessionPartition =
    (view.webContents?.session as unknown as { partition?: string } | undefined)?.partition
  const partition = options?.partition ?? sessionPartition

  getViewFactory().registerExternalView(viewId, view, {
    profile: options?.profile || 'background-task',
    url: options?.url || currentUrl,
    runId: options?.runId,
    partition,
    metadata
  })

  logger.debug('🔗 注册外部视图（通过 ViewFactory）:', viewId)
}

export async function unregisterExternalView(viewId: string): Promise<void> {
  const viewFactory = getViewFactory()

  if (!viewFactory.hasView(viewId)) {
    logger.debug('视图不存在（ViewFactory）:', viewId)
    return
  }

  try {
    await viewFactory.destroyView(viewId, { force: true })
    logger.debug('🔻 注销外部视图（通过 ViewFactory）:', viewId)
  } catch (error) {
    logger.error('注销外部视图失败:', viewId, error)
    throw error
  }
}

export function getAllTabsInfo(): Array<{
  tabId: string
  url: string
  title: string
  isLoading: boolean
  isActive: boolean
  lastAccessTime: number
  estimatedMemoryMB: number
  source: 'tab' | 'singleton' | 'external'
}> {
  const tabsInfo: Array<{
    tabId: string
    url: string
    title: string
    isLoading: boolean
    isActive: boolean
    lastAccessTime: number
    estimatedMemoryMB: number
    source: 'tab' | 'singleton' | 'external'
  }> = []

  const viewFactory = getViewFactory()

  for (const tabId of viewFactory.getAllViewIds()) {
    //  Phase 3: 容器无关取 WebContents——webview guest 条目 view 恒 null，
    // 原先按 getView 判活会把**存活的 guest**误判为失效并 cleanupStaleView 强制
    // 销毁注册（用户看得见的页面被杀）。改用 getWebContents 两种容器统一判活。
    const wc = viewFactory.getWebContents(tabId)
    const state = viewFactory.getViewState(tabId)

    if (!isAliveWebContents(wc) || !state) {
      cleanupStaleView(tabId, 'tabs-info-stale')
      continue
    }

    try {
      const url = wc.getURL() || state.url || ''
      const title = wc.getTitle() || ''
      const isLoading = wc.isLoading()
      const isActive = tabId === currentTabId
      const metadata = state.config?.metadata || {}
      const estimatedMemoryMB = 50

      tabsInfo.push({
        tabId,
        url,
        title,
        isLoading,
        isActive,
        lastAccessTime: state.lastAccessAt,
        estimatedMemoryMB,
        source: metadata.source || metadata.createdBy || 'unknown'
      })
    } catch (error) {
      logger.warn('获取标签信息失败:', tabId, error)
    }
  }

  logger.debug('📊 获取标签信息:', {
    总数: tabsInfo.length,
    当前标签: currentTabId
  })

  return tabsInfo
}

/**
 * 导出给 ElectronWebContentsAdapter 使用的函数
 */
export {
  getOrCreateViewForTab,
  destroyTabView as destroyView,
  markViewInUse,
  releaseViewInUse
};

export async function cleanupEmbeddedCrawlView(): Promise<void> {
  logger.debug('🧹 开始清理资源...')

  unregisterAllIpcHandlers()

  try {
    await getViewFactory().shutdown()
    logger.debug('✅ ViewFactory 已关闭（含所有 View、定时器）')
  } catch (error) {
    logger.error('ViewFactory 关闭失败:', error)
  }

  preprocessedCache.clear()
  viewCreationPromises.clear()

  currentTabId = null
  syncIgnoreMouseEventsForAttached(false)
  clearInteractionState()
  uninstallNativeHistoryAppCommandGuard()
  currentMainWindow = null

  logger.debug('✅ 资源清理完成')
}
