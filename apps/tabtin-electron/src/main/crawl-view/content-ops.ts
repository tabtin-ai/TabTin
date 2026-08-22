/**
 * 内容操作模块
 *
 * 提供 executeScript / loadUrl / screenshot / getHTML / getPageInfo 等功能。
 * 通过 initContentOps() 注入运行时依赖，避免与主模块产生循环引用。
 *
 * : 模块内部已容器无关化 — 只依赖 WebContents，不再引用 WebContentsView。
 */

import type { WebContents } from 'electron'
import { getViewFactory } from '../view-factory'
import { waitForViewState, getViewStateRegistry } from '../webcontents/ViewStateRegistry'
import type { ViewOptions, LoadUrlOptions, LoadReadiness, WaitForOptions } from './types'
import { isAliveWebContents, sleep, toErrorMessage, ts, validateNavigationUrl } from './utils'
import { isBlockedScript } from '@tabtin/browser-core/url-policy'
import { createLogger } from './logger'
import { getMainWindow } from '../window-manager'
import { handleBlockedPreviewLoad } from '../blocked-preview-load'
import { guardLoadURL } from '../../shared/guard-load-url'

const log = createLogger('ContentOps')

// DOM 稳定判定参数：连续 QUIET_MS 无 DOM 结构变更即视为内容就绪；
// MAX_MS 为 settle 观察上限，超过则返回 unsettled_timeout（持续动画/长轮询/数据未就绪）。
// 口径须与 packages/browser-core/src/utils/dom-settle.ts、apps/tabtin-daemon 的同名常量一致
// （三处运行时不同、无法共用一份实现；改动请同步另两处）。
const DOM_SETTLE_QUIET_MS = 500
const DOM_SETTLE_MAX_MS = 10000
// 历史导航 / reload 由外部触发后，webContents 可能尚未进入 loading 态：
// 在此宽限窗口内轮询等待其开始加载；纯 same-document（SPA history）不会 loading，由后续 DOM settle 兜住。
const NAV_START_GRACE_MS = 500

function resolvePrivateHostNavigationPolicy(
  tabId: string,
  url: string,
  options: LoadUrlOptions,
): { allowPrivateHostNavigation: boolean; allowedPrivateOrigins?: string[]; allowLocalFileRoot?: string } {
  // 受限 file:// 放行根：本次显式传入优先，否则读 view 自身持久化 config
  // （预览 view 恢复后 loadUrl / 刷新仍在工作目录内放行）。
  const allowLocalFileRoot = resolveLocalPreviewRoot(tabId, options)

  if (options.allowPrivateHostNavigation) {
    try {
      return { allowPrivateHostNavigation: true, allowedPrivateOrigins: [new URL(url).origin], allowLocalFileRoot }
    } catch {
      return { allowPrivateHostNavigation: true, allowLocalFileRoot }
    }
  }

  try {
    const config = getViewFactory().getViewState(tabId)?.config
    if (config?.allowPrivateHostNavigation && config.url) {
      return {
        allowPrivateHostNavigation: true,
        allowedPrivateOrigins: [new URL(config.url).origin],
        allowLocalFileRoot,
      }
    }
  } catch {
    // Keep the default deny policy.
  }

  return { allowPrivateHostNavigation: false, allowLocalFileRoot }
}

function resolveLocalPreviewRoot(tabId: string, options: LoadUrlOptions): string | undefined {
  if (options.localPreviewRoot) return options.localPreviewRoot
  try {
    return getViewFactory().getViewState(tabId)?.config.localPreviewRoot || undefined
  } catch {
    return undefined
  }
}

export interface ScreenshotCaptureRect {
  x: number
  y: number
  width: number
  height: number
}

export interface ScreenshotCaptureOptions {
  format?: 'png' | 'jpeg'
  quality?: number
  rect?: ScreenshotCaptureRect
}

// ---------------------------------------------------------------------------
// 依赖注入
// ---------------------------------------------------------------------------

type ContentOpsDeps = {
  getActiveWebContents: () => WebContents | null
  getCurrentTabId: () => string | null
  warnMissingViewId: (action: string) => boolean
  getOrCreateWebContentsForTab: (tabId: string, url: string, runId?: string, options?: ViewOptions) => Promise<WebContents>
  /**
   * 等待进行中的 View 创建（存在时返回其 Promise，resolve 为页面 WebContents）。
   *
   * ⚠️ 每次调用都可能返回基于缓存创建 Promise 新派生的 Promise：
   * 取用方必须 await 或显式 catch，否则创建失败会产生 unhandledRejection。
   */
  getPendingViewCreation: (tabId: string) => Promise<WebContents> | undefined
  /** 进行中的 View 创建数量（仅诊断日志用） */
  getPendingViewCreationCount: () => number
  getRunSessionManager: () => { getRunIdByView: (viewId: string) => string | undefined | null }
}

let _deps: ContentOpsDeps = {
  getActiveWebContents: () => null,
  getCurrentTabId: () => null,
  warnMissingViewId: () => false,
  getOrCreateWebContentsForTab: () => Promise.reject(new Error('ContentOps not initialized')),
  getPendingViewCreation: () => undefined,
  getPendingViewCreationCount: () => 0,
  getRunSessionManager: () => ({ getRunIdByView: () => null }),
}

export function initContentOps(deps: ContentOpsDeps): void {
  _deps = deps
}

// ---------------------------------------------------------------------------
// executeScript
// ---------------------------------------------------------------------------

export async function executeScript(
  script: string,
  tabId?: string,
  url?: string,
  options?: ViewOptions
): Promise<any> {
  if (isBlockedScript(script)) {
    log.warn('脚本包含受限 API 调用:', { tabId, snippet: script.slice(0, 80) })
    throw new Error('Script accesses restricted browser storage APIs')
  }
  if (!tabId && _deps.warnMissingViewId('executeScript')) {
    throw new Error('多视图模式下必须提供 viewId')
  }

  let webContents: WebContents | null = null
  let resolvedRunId: string | undefined

  if (tabId) {
    if (url) {
      log.info('等待 View 创建完成 (executeScript):', { tabId, url })
      try {
        try {
          const manager = _deps.getRunSessionManager()
          resolvedRunId = manager.getRunIdByView(tabId) || undefined
        } catch {
          // ignore
        }
        webContents = await _deps.getOrCreateWebContentsForTab(tabId, url, resolvedRunId, options)
      } catch (error) {
        log.error('获取 View 失败:', error)
        throw new Error(`获取标签 ${tabId} 失败: ${error instanceof Error ? error.message : String(error)}`)
      }
    } else {
      const pendingPromise = _deps.getPendingViewCreation(tabId)
      if (pendingPromise) {
        log.debug('executeScript 等待已有创建 Promise:', tabId)
        try {
          webContents = await pendingPromise
        } catch (error) {
          log.error('等待创建 Promise 失败:', error)
          throw new Error(`等待标签 ${tabId} 创建失败: ${error instanceof Error ? error.message : String(error)}`)
        }
      } else {
        try {
          const viewFactory = getViewFactory()
          if (viewFactory.hasView(tabId)) {
            const viewState = viewFactory.getViewState(tabId)
            if (viewState && viewState.view && !viewState.view.webContents?.isDestroyed()) {
              log.info('从 ViewFactory 获取 View (executeScript):', tabId)
              webContents = viewState.view.webContents
              resolvedRunId = viewState.config.runId
            }
          }
        } catch (error) {
          log.warn('检查 ViewFactory 失败:', error)
        }

        if (!webContents) {
          const candidate = getViewFactory().getWebContents(tabId) || null
          if (isAliveWebContents(candidate)) {
            log.info('从 ViewFactory 获取 View (executeScript):', tabId)
            webContents = candidate
          } else {
            if (candidate) {
              // stale view — caller (main module) should handle cleanup
              log.warn('View 已销毁:', tabId)
            }

            const viewFactory = getViewFactory()
            const diagnostics = {
              requestedTabId: tabId,
              availableTabIds: viewFactory.getAllViewIds(),
              currentTabId: _deps.getCurrentTabId(),
              hasPendingPromise: false,
              pendingPromisesCount: _deps.getPendingViewCreationCount(),
              viewFactorySize: viewFactory.getAllViewIds().length,
            }

            log.error('所有途径均未找到 View:', diagnostics)
            throw new Error(
              `View not found: ${tabId} (factory size: ${diagnostics.viewFactorySize}, pending: ${diagnostics.pendingPromisesCount})`
            )
          }
        }
      }
    }
  } else {
    webContents = _deps.getActiveWebContents()
    if (!webContents) {
      throw new Error('当前没有活跃的 WebContentsView')
    }
  }

  if (!isAliveWebContents(webContents)) {
    throw new Error('WebContentsView 不可用或已销毁')
  }

  try {
    const result = await webContents.executeJavaScript(script)
    log.info('脚本执行成功', { tabId: tabId || _deps.getCurrentTabId() })
    return result
  } catch (error: any) {
    log.error('脚本执行失败:', error, { tabId: tabId || _deps.getCurrentTabId() })
    throw error
  }
}

// ---------------------------------------------------------------------------
// waitForSelector
// ---------------------------------------------------------------------------

export async function waitForSelector(
  tabId: string,
  options: WaitForOptions
): Promise<{ success: boolean; elapsedMs?: number; error?: string }> {
  const webContents = getViewFactory().getWebContents(tabId)
  if (!isAliveWebContents(webContents)) {
    return { success: false, error: `View not found: ${tabId}` }
  }
  const { selector, delay, state = 'visible', timeout = 10000, pollInterval = 200 } = options
  if (delay && selector) {
    return { success: false, error: 'selector and delay are mutually exclusive' }
  }
  if (delay) {
    const start = Date.now()
    await sleep(delay)
    return { success: true, elapsedMs: Date.now() - start }
  }
  if (!selector) {
    return { success: false, error: 'selector is required when delay is not provided' }
  }

  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (webContents.isDestroyed()) {
      return { success: false, error: `View ${tabId} destroyed during wait` }
    }
    let result: { found: boolean; visible: boolean } | null = null
    try {
      result = await webContents.executeJavaScript(
        `(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return { found: false, visible: false };
          const rects = el.getClientRects();
          const visible = !!(el.offsetParent || (rects && rects.length));
          return { found: true, visible };
        })();`
      )
    } catch (err: any) {
      // 视图在轮询期间发生导航时 executeJavaScript 会抛出，视为元素暂未可访问，继续等待
      if (webContents.isDestroyed()) {
        return { success: false, error: `View ${tabId} destroyed during wait` }
      }
      log.debug('waitForSelector: executeJavaScript 抛出（可能正在导航），继续等待:', err?.message)
      await sleep(pollInterval)
      continue
    }
    const found = Boolean(result?.found)
    const visible = Boolean(result?.visible)
    const matched =
      state === 'attached' ? found :
      state === 'visible' ? (found && visible) :
      state === 'hidden' ? (!found || !visible) :
      false
    if (matched) {
      return { success: true, elapsedMs: Date.now() - start }
    }
    await sleep(pollInterval)
  }
  return { success: false, error: 'wait_for timeout' }
}

// ---------------------------------------------------------------------------
// waitForNetworkIdle
// ---------------------------------------------------------------------------

async function waitForNetworkIdle(webContents: WebContents, timeout = 10000, idleMillis = 500): Promise<void> {
  const start = Date.now()
  let idleStart: number | null = null
  while (Date.now() - start < timeout) {
    if (webContents.isDestroyed()) {
      throw new Error('View destroyed during network idle wait')
    }
    if (!webContents.isLoading()) {
      if (!idleStart) idleStart = Date.now()
      if (Date.now() - idleStart >= idleMillis) return
    } else {
      idleStart = null
    }
    await sleep(100)
  }
  throw new Error('network idle timeout')
}

async function waitForNavigationEvent(
  webContents: WebContents,
  waitUntil: 'load' | 'domcontentloaded',
  timeout: number
): Promise<void> {
  if (webContents.isDestroyed()) {
    throw new Error('View destroyed during navigation wait')
  }

  if (waitUntil === 'domcontentloaded') {
    try {
      const readyState = await webContents.executeJavaScript('document.readyState')
      if (readyState === 'interactive' || readyState === 'complete') {
        return
      }
    } catch {
      // 页面仍在切换，继续等待 dom-ready 事件
    }
  } else if (!webContents.isLoading()) {
    return
  }

  await new Promise<void>((resolve, reject) => {
    const eventName = waitUntil === 'domcontentloaded' ? 'dom-ready' : 'did-finish-load'
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`${eventName} timeout`))
    }, timeout)

    const onReady = () => {
      cleanup()
      resolve()
    }

    const onDestroyed = () => {
      cleanup()
      reject(new Error('View destroyed during navigation wait'))
    }

    let cleanup = () => {
      clearTimeout(timer)
      webContents.removeListener('destroyed', onDestroyed)
    }

    if (eventName === 'dom-ready') {
      cleanup = () => {
        clearTimeout(timer)
        webContents.removeListener('dom-ready', onReady)
        webContents.removeListener('destroyed', onDestroyed)
      }
      webContents.once('dom-ready', onReady)
    } else {
      cleanup = () => {
        clearTimeout(timer)
        webContents.removeListener('did-finish-load', onReady)
        webContents.removeListener('destroyed', onDestroyed)
      }
      webContents.once('did-finish-load', onReady)
    }

    webContents.once('destroyed', onDestroyed)
  })
}

// ---------------------------------------------------------------------------
// waitForDomSettle
// ---------------------------------------------------------------------------

/**
 * 生成在页面上下文里执行的「DOM 稳定观察」脚本：用原生 MutationObserver 观察
 * childList/subtree 变更，连续 quietMs 无变更 resolve(true)；到达 maxWaitMs 仍在变化
 * resolve(false)。以字符串形式导出，便于在 jsdom 下用同一份脚本做单测。
 */
export function buildDomSettleScript(quietMs: number, maxWaitMs: number): string {
  return `(() => new Promise((resolve) => {
    try {
      let quietTimer = null;
      let done = false;
      const finish = (settled) => {
        if (done) return;
        done = true;
        try { observer.disconnect(); } catch (e) {}
        if (quietTimer) clearTimeout(quietTimer);
        resolve(settled);
      };
      // 每次 DOM 变更都重置安静计时器：只有完整 ${quietMs}ms 无变更才判定 settled(true)。
      // 到达 ${maxWaitMs}ms 硬上限仍未安静则判定 unsettled(false)。
      const schedule = () => {
        if (quietTimer) clearTimeout(quietTimer);
        quietTimer = setTimeout(() => finish(true), ${quietMs});
      };
      const observer = new MutationObserver(() => schedule());
      const root = document.documentElement || document.body;
      if (!root) { resolve(false); return; }
      observer.observe(root, { childList: true, subtree: true, attributes: false, characterData: false });
      setTimeout(() => finish(false), ${maxWaitMs});
      schedule();
    } catch (e) {
      resolve(false);
    }
  }))()`
}

/**
 * 在页面上下文里观察 DOM 是否稳定：连续 quietMs 无结构性变更判定 settled；
 * 到达 maxWaitMs 仍在变化返回 false（unsettled）。纯 best-effort，不抛错。
 */
async function waitForDomSettle(
  webContents: WebContents,
  quietMs: number,
  maxWaitMs: number,
): Promise<boolean> {
  if (webContents.isDestroyed()) return false
  try {
    const settled = await webContents.executeJavaScript(buildDomSettleScript(quietMs, maxWaitMs), true)
    return Boolean(settled)
  } catch (err: any) {
    log.debug('waitForDomSettle: executeJavaScript 失败，视为 unsettled:', err?.message)
    return false
  }
}

// ---------------------------------------------------------------------------
// loadUrl
// ---------------------------------------------------------------------------

export async function loadUrl(
  tabId: string,
  url: string,
  options: LoadUrlOptions = {}
): Promise<{
  success: boolean
  status?: 'loaded' | 'timeout' | 'error'
  finalUrl?: string
  timing?: { start: number; end: number; duration: number }
  readiness?: LoadReadiness
  code?: 'PREVIEW_REQUIRED'
  intent?: Extract<ReturnType<typeof guardLoadURL>, { action: 'block-preview' }>['intent']
  error?: string
}> {
  const urlCheck = validateNavigationUrl(url, resolvePrivateHostNavigationPolicy(tabId, url, options))
  if (!urlCheck.ok) {
    return { success: false, status: 'error', error: urlCheck.error }
  }
  const webContents = getViewFactory().getWebContents(tabId)
  if (!isAliveWebContents(webContents)) {
    return { success: false, status: 'error', error: `View not found: ${tabId}` }
  }

  const previewGuard = guardLoadURL({
    url,
    ...options.openIntentHints,
    forceBrowser: options.forceBrowser,
    source: 'content-ops.loadUrl',
  })
  if (previewGuard.action === 'block-preview') {
    log.info('Preview Guard 阻止 loadURL', {
      tabId, url, previewKind: previewGuard.intent.previewKind,
    })
    //  / ：与 webview-host:navigate / view-display 对齐——阻断时
    // 必须发 Preview fallback，否则 Agent load_tab_url 只会失败、用户看不到预览。
    handleBlockedPreviewLoad({
      url,
      source: 'content-ops.loadUrl',
      intent: previewGuard.intent,
      mainWindow: getMainWindow(),
      ...options.openIntentHints,
    })
    return {
      success: false,
      status: 'error',
      code: 'PREVIEW_REQUIRED',
      intent: previewGuard.intent,
      error: `previewable URL blocked from BrowserView: ${previewGuard.intent.previewKind}`,
    }
  }

  const start = Date.now()
  // 默认 settled：基础导航完成后再等 DOM 稳定，避免 SPA 内容未渲染就返回 loaded
  const waitUntil = options.waitUntil || 'settled'
  const timeout = typeof options.timeout === 'number' && options.timeout > 0 ? options.timeout : 10000

  try {
    getViewFactory().refreshResourceInterception(tabId, url)
    let navigationAborted = false
    let loadTimer: ReturnType<typeof setTimeout> | undefined
    let loadTimedOut = false
    try {
      await Promise.race([
        webContents.loadURL(url),
        new Promise<never>((_, reject) => {
          loadTimer = setTimeout(() => {
            loadTimedOut = true
            try {
              if (!webContents.isDestroyed()) webContents.stop()
            } catch {
              // best effort
            }
            reject(new Error(`loadURL timeout after ${timeout}ms`))
          }, timeout)
        }),
      ])
    } catch (error: any) {
      if (loadTimedOut && error?.code === 'ERR_ABORTED') {
        throw new Error(`loadURL timeout after ${timeout}ms`)
      }
      if (error?.code !== 'ERR_ABORTED') {
        throw error
      }
      navigationAborted = true
    } finally {
      if (loadTimer) clearTimeout(loadTimer)
    }

    if (waitUntil === 'networkidle') {
      await waitForNetworkIdle(webContents, timeout)
    } else if (navigationAborted) {
      await waitForNavigationEvent(webContents, waitUntil === 'domcontentloaded' ? 'domcontentloaded' : 'load', timeout)
    }

    const resolvedUrl = webContents.isDestroyed() ? url : webContents.getURL()
    getViewFactory().refreshResourceInterception(tabId, resolvedUrl || url)

    if (options.waitForSelector) {
      const waitResult = await waitForSelector(tabId, {
        selector: options.waitForSelector,
        timeout: options.waitForTimeout || timeout,
        state: options.waitForState || 'visible'
      })
      if (!waitResult.success) {
        const destroyed = webContents.isDestroyed()
        return {
          success: false,
          status: 'timeout',
          finalUrl: destroyed ? url : webContents.getURL(),
          timing: { start, end: Date.now(), duration: Date.now() - start },
          error: waitResult.error
        }
      }
    }

    // settled：基础导航后观察 DOM 稳定度，作为「内容就绪」信号。
    // 显式传了 waitForSelector 时以选择器为准，不再叠加 settle。
    let readiness: LoadReadiness | undefined
    if (waitUntil === 'settled' && !options.waitForSelector && !webContents.isDestroyed()) {
      const elapsed = Date.now() - start
      const settleWindow = Math.min(Math.max(timeout - elapsed, DOM_SETTLE_QUIET_MS), DOM_SETTLE_MAX_MS)
      const settled = await waitForDomSettle(webContents, DOM_SETTLE_QUIET_MS, settleWindow)
      readiness = settled ? 'settled' : 'unsettled_timeout'
    }

    return {
      success: true,
      status: 'loaded',
      finalUrl: resolvedUrl,
      timing: { start, end: Date.now(), duration: Date.now() - start },
      ...(readiness ? { readiness } : {})
    }
  } catch (error: any) {
    const isTimeout = String(error?.message || '').toLowerCase().includes('timeout')
    const destroyed = webContents.isDestroyed()
    return {
      success: false,
      status: isTimeout ? 'timeout' : 'error',
      finalUrl: destroyed ? url : webContents.getURL(),
      timing: { start, end: Date.now(), duration: Date.now() - start },
      error: error?.message || String(error)
    }
  }
}

// ---------------------------------------------------------------------------
// waitForTabReady
// ---------------------------------------------------------------------------

/**
 * 等待一个已由外部触发导航（reload / back / forward）的 tab 达到「内容就绪」，
 * 与 loadUrl 的 settled 语义同口径：基础导航完成后观察 DOM 稳定。
 * 纯 best-effort：导航事件超时或 settle 未达成都不抛错，返回 readiness 供调用方参考。
 * 返回 undefined 表示 tab 不存在 / 已销毁（无法判定）。
 */
export async function waitForTabReady(
  tabId: string,
  options: { timeout?: number } = {},
): Promise<LoadReadiness | undefined> {
  const webContents = getViewFactory().getWebContents(tabId)
  if (!isAliveWebContents(webContents)) return undefined
  const timeout = typeof options.timeout === 'number' && options.timeout > 0 ? options.timeout : 10000
  const start = Date.now()

  // 1) 等导航开始（外部刚触发 goBack/goForward/reload，可能还没进入 loading 态）
  const navStartDeadline = start + Math.min(timeout, NAV_START_GRACE_MS)
  while (Date.now() < navStartDeadline) {
    if (webContents.isDestroyed()) return undefined
    if (webContents.isLoading()) break
    await sleep(50)
  }

  // 2) 基础导航完成（best-effort，不让导航事件超时拖垮整个 nav）
  try {
    if (!webContents.isDestroyed() && webContents.isLoading()) {
      await waitForNavigationEvent(webContents, 'load', timeout)
    }
  } catch {
    // 导航事件超时 / 中断：降级到 DOM settle 观察
  }

  if (webContents.isDestroyed()) return undefined

  // 3) DOM 稳定作为「内容就绪」信号（覆盖 SPA pushState / load 后 fetch 渲染）
  const elapsed = Date.now() - start
  const settleWindow = Math.min(Math.max(timeout - elapsed, DOM_SETTLE_QUIET_MS), DOM_SETTLE_MAX_MS)
  const settled = await waitForDomSettle(webContents, DOM_SETTLE_QUIET_MS, settleWindow)
  return settled ? 'settled' : 'unsettled_timeout'
}

// ---------------------------------------------------------------------------
// screenshot
// ---------------------------------------------------------------------------

function normalizeCaptureRect(rect: ScreenshotCaptureRect | undefined): ScreenshotCaptureRect | undefined {
  if (!rect) return undefined
  const normalized = {
    x: Math.max(0, Math.round(rect.x)),
    y: Math.max(0, Math.round(rect.y)),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  }
  const values = [normalized.x, normalized.y, normalized.width, normalized.height]
  if (!values.every(Number.isFinite) || normalized.width <= 0 || normalized.height <= 0) {
    return undefined
  }
  return normalized
}

export async function screenshot(
  options?: ScreenshotCaptureOptions,
  tabId?: string,
  url?: string,
  runId?: string,
  viewOptions?: ViewOptions
): Promise<Buffer> {
  if (!tabId && _deps.warnMissingViewId('screenshot')) {
    throw new Error('多视图模式下必须提供 viewId')
  }

  let webContents: WebContents | null = null
  let resolvedTabId = tabId || null

  if (resolvedTabId) {
    if (url) {
      await _deps.getOrCreateWebContentsForTab(resolvedTabId, url, runId, viewOptions)
    }
    webContents = getViewFactory().getWebContents(resolvedTabId) || null
  } else {
    webContents = _deps.getActiveWebContents()
    resolvedTabId = _deps.getCurrentTabId()
  }

  if (!isAliveWebContents(webContents)) {
    log.error('截图失败：WebContentsView 不可用', {
      tabId: resolvedTabId,
      hasView: !!webContents,
      currentTabId: _deps.getCurrentTabId(),
      viewFactorySize: getViewFactory().getStats().total
    })
    throw new Error('WebContentsView 不可用')
  }

  log.info('开始截图...', {
    tabId: resolvedTabId,
    url: webContents.getURL(),
    rect: options?.rect,
  })

  try {
    const image = await webContents.capturePage(normalizeCaptureRect(options?.rect))

    let buffer: Buffer
    if (options?.format === 'jpeg') {
      buffer = image.toJPEG(options.quality || 90)
    } else {
      buffer = image.toPNG()
    }

    log.info('截图成功，大小:', buffer.length, 'bytes')
    return buffer
  } catch (error: any) {
    log.error('截图失败:', error)
    throw error
  }
}

// ---------------------------------------------------------------------------
// getCDPEndpoint / getWebContentsId (legacy singleton)
// ---------------------------------------------------------------------------

export function getCDPEndpoint(): string | null {
  if (_deps.warnMissingViewId('getCDPEndpoint')) {
    return null
  }
  const activeWebContents = _deps.getActiveWebContents()
  if (!activeWebContents || !isAliveWebContents(activeWebContents)) {
    log.error('WebContentsView 不可用')
    return null
  }

  try {
    const port = (activeWebContents as any).debugger?.port
    if (port) {
      const endpoint = `http://127.0.0.1:${port}`
      log.debug('CDP 端点:', endpoint)
      return endpoint
    }

    const globalPort = process.argv.find(arg => arg.startsWith('--remote-debugging-port='))?.split('=')[1]
    if (globalPort) {
      const endpoint = `http://127.0.0.1:${globalPort}`
      log.debug('使用全局 CDP 端点:', endpoint)
      return endpoint
    }

    log.warn('无法获取 CDP 端点')
    return null
  } catch (error: any) {
    log.error('获取 CDP 端点失败:', error)
    return null
  }
}

export function getWebContentsId(): number | null {
  if (_deps.warnMissingViewId('getWebContentsId')) {
    return null
  }
  const activeWebContents = _deps.getActiveWebContents()
  if (!activeWebContents || !isAliveWebContents(activeWebContents)) {
    return null
  }

  const id = activeWebContents.id
  log.debug('WebContents ID:', id)
  return id
}

// ---------------------------------------------------------------------------
// getHTML / getPageInfo
// ---------------------------------------------------------------------------

export async function getHTML(
  tabId?: string,
  url?: string,
  runId?: string,
  options?: ViewOptions
): Promise<string> {
  if (!tabId && _deps.warnMissingViewId('getHTML')) {
    throw new Error('多视图模式下必须提供 viewId')
  }
  const resolvedTabId = tabId || _deps.getCurrentTabId()

  if (!resolvedTabId) {
    if (url) {
      throw new Error('url 已提供，但 tabId 为空，无法隐式创建 View')
    }
    throw new Error('当前没有活跃的标签')
  }

  let webContents = getViewFactory().getWebContents(resolvedTabId)

  if ((!webContents || !isAliveWebContents(webContents)) && url) {
    webContents = await _deps.getOrCreateWebContentsForTab(resolvedTabId, url, runId, options)
  }

  if (!webContents || !isAliveWebContents(webContents)) {
    throw new Error('嵌入式视图不存在或已销毁')
  }

  try {
    const html = await webContents.executeJavaScript('document.documentElement.outerHTML')
    log.info('已获取 HTML，长度:', html.length)
    return html
  } catch (error: any) {
    log.error('获取 HTML 失败:', error)
    throw error
  }
}

export async function getPageInfo(
  tabId?: string,
  url?: string,
  runId?: string,
  options?: ViewOptions
): Promise<{
  html: string
  url: string
  title: string
}> {
  if (!tabId && _deps.warnMissingViewId('getPageInfo')) {
    throw new Error('多视图模式下必须提供 viewId')
  }
  const resolvedTabId = tabId || _deps.getCurrentTabId()

  if (!resolvedTabId) {
    if (url) {
      throw new Error('url 已提供，但 tabId 为空，无法隐式创建 View')
    }
    throw new Error('当前没有活跃的标签')
  }

  let webContents = getViewFactory().getWebContents(resolvedTabId)

  if ((!webContents || !isAliveWebContents(webContents)) && url) {
    webContents = await _deps.getOrCreateWebContentsForTab(resolvedTabId, url, runId, options)
  }

  if (!webContents || !isAliveWebContents(webContents)) {
    throw new Error('嵌入式视图不存在或已销毁')
  }

  try {
    const result = await webContents.executeJavaScript(`
      ({
        html: document.documentElement.outerHTML,
        url: window.location.href,
        title: document.title
      })
    `)
    log.info('已获取页面信息:', {
      url: result.url,
      title: result.title,
      htmlLength: result.html.length
    })
    return result
  } catch (error: any) {
    log.error('获取页面信息失败:', error)
    throw error
  }
}

// ---------------------------------------------------------------------------
// getProcessedContent (action-tools integration)
// ---------------------------------------------------------------------------

export async function getProcessedContent(
  tabId?: string,
  url?: string,
  runId?: string,
  options?: ViewOptions
): Promise<{
  success: boolean
  cleanHtml?: string
  skeletonHtml?: string
  title?: string
  url?: string
  stats?: any
  error?: string
}> {
  if (!runId) {
    throw new Error('getProcessedContent 必须提供 runId')
  }
  if (!tabId) {
    throw new Error('getProcessedContent 必须提供 tabId')
  }

  if (url) {
    log.debug('获取 View (getProcessedContent):', { tabId, url, runId, at: ts() })
    await _deps.getOrCreateWebContentsForTab(tabId, url, runId, options)
  }

  const registryState = getViewStateRegistry().getState(tabId)
  const isDomReady = registryState?.status === 'loaded'

  if (!isDomReady) {
    log.debug('DOM 未就绪，等待加载完成（最多 5 秒）...')
    try {
      await waitForViewState(tabId, 'loaded', { timeout: 5000 })
      log.info('DOM 已就绪')
    } catch (error: any) {
      log.warn('等待 DOM 超时，继续尝试:', error.message)
    }
  }

  log.debug('使用 action-tools 获取页面内容...', { tabId, runId, at: ts() })

  const { requestSnapshotTool } = await import('@tabtin/action-tools/tools')

  const snapshotResult = await requestSnapshotTool.execute({
    runId,
    crawlTabId: tabId,
    include_dom: true,
    include_clean_html: true,
    include_screenshot: false,
    include_accessibility_tree: false
  })

  if (!snapshotResult.success || !snapshotResult.data?.snapshot) {
    throw new Error(toErrorMessage(snapshotResult.error ?? 'action-tools requestSnapshot 失败'))
  }

  const snapshot = snapshotResult.data.snapshot

  log.info('action-tools 获取内容完成', {
    url: snapshot.url,
    title: snapshot.title,
    cleanHtmlLength: snapshot.clean_html?.length || 0,
    skeletonLength: snapshot.skeleton_html?.length || 0,
    executionTime: snapshotResult.data.frontend_execution_time_ms
  })

  return {
    success: true,
    cleanHtml: snapshot.clean_html,
    skeletonHtml: snapshot.skeleton_html,
    title: snapshot.title,
    url: snapshot.url,
    stats: {
      cleanHtmlLength: snapshot.clean_html?.length || 0,
      skeletonHtmlLength: snapshot.skeleton_html?.length || 0,
      executionTime: snapshotResult.data.frontend_execution_time_ms
    }
  }
}
