/**
 * IPC 处理器注册模块
 *
 * 将所有 crawl-view:* IPC channel 的注册逻辑从主模块中分离。
 * 通过 initIpcHandlers() 注入视图生命周期函数的引用。
 */

import { BrowserWindow, ipcMain } from 'electron'
import { getViewFactory } from '../view-factory'
import { createGuardedTrackHandle } from '../utils/guarded-handle'
import { getOrganizationTabManager } from '../organization/OrganizationTabManager'
import { getRunSessionManager } from '../run-session/RunSessionManager'
import { reconcileOrphans as reconcileOrphansFn } from './reconcile-orphans'
import { goBack, goForward, reload, stop, getNavigationState } from './navigation'
import {
  executeScript,
  loadUrl,
  waitForSelector,
  screenshot,
  type ScreenshotCaptureOptions,
  getCDPEndpoint,
  getWebContentsId,
  getHTML,
  getPageInfo,
  getProcessedContent,
} from './content-ops'
import { isAliveWebContents } from './utils'
import { markManualZoom, scheduleFitToWidth } from './fit-to-width'
import { notifyBrowserZoomLevelChanged } from './view-interaction'
import { createLogger } from './logger'
import { shouldAllowBrowserDevTools } from '../package-protection'
import type { ViewOptions, LoadUrlOptions, WaitForOptions } from './types'
import { applyBrowserViewBorderRadius } from '../browser-view-radius'

const log = createLogger('CrawlViewIPC')

// ---------------------------------------------------------------------------
// 依赖注入
// ---------------------------------------------------------------------------

export type IpcHandlersDeps = {
  showEmbeddedView: (
    urlOrTabId: string,
    boundsOrUrl: { x: number; y: number; width: number; height: number } | string,
    maybeBounds?: { x: number; y: number; width: number; height: number },
    runId?: string,
    options?: ViewOptions
  ) => Promise<void>
  hideEmbeddedView: (tabId?: string) => void
  destroyTabView: (tabId: string) => Promise<void>
  syncIgnoreMouseEventsForAttached: (ignore: boolean) => void
  getOrCreateViewForTab: (tabId: string, url: string, runId?: string, options?: ViewOptions) => Promise<import('electron').WebContentsView>
  cleanupStaleView: (tabId: string, reason: string) => void
  getMainWindow: () => BrowserWindow | null
  getCurrentTabId: () => string | null
  getResourceManagerAccessor: () => (() => { touchView?: (viewId: string, reason?: string) => boolean } | null) | null
  getCacheStats: () => { total: number; max: number; idle: number; inUse: number; current: string | null }
  getAllTabsInfo: () => Array<{
    tabId: string; url: string; title: string; isLoading: boolean; isActive: boolean;
    lastAccessTime: number; estimatedMemoryMB: number; source: 'tab' | 'singleton' | 'external'
  }>
}

let _deps: IpcHandlersDeps | null = null

export function initIpcHandlers(deps: IpcHandlersDeps): void {
  _deps = deps
}

function deps(): IpcHandlersDeps {
  if (!_deps) throw new Error('IPC handlers not initialized')
  return _deps
}

// ---------------------------------------------------------------------------
// Bounds 日志去重
// ---------------------------------------------------------------------------

const lastLoggedBounds = new Map<string, { width: number; height: number; timestamp: number }>()
const BOUNDS_LOG_THROTTLE = 1000
const BOUNDS_DIFF_THRESHOLD = 10
const shouldLogCrawlBounds = process.env.TABTIN_DEBUG_CRAWL_BOUNDS === '1' || process.env.TABTIN_DEBUG_CRAWLVIEW_VERBOSE === '1'

function logBoundsIfSignificant(
  tabId: string,
  requested: { x: number; y: number; width: number; height: number },
  applied?: { x: number; y: number; width: number; height: number },
) {
  if (!shouldLogCrawlBounds) return
  const now = Date.now()
  const last = lastLoggedBounds.get(tabId)

  const shouldLog = !last ||
    (now - last.timestamp > BOUNDS_LOG_THROTTLE) && (
      Math.abs(last.width - requested.width) > BOUNDS_DIFF_THRESHOLD ||
      Math.abs(last.height - requested.height) > BOUNDS_DIFF_THRESHOLD
    )

  if (shouldLog) {
    log.info('CrawlBounds 主进程应用 setViewBounds', {
      tabId,
      requested,
      applied,
      delta: applied
        ? {
            x: applied.x - requested.x,
            y: applied.y - requested.y,
            width: applied.width - requested.width,
            height: applied.height - requested.height,
          }
        : null,
    })
    lastLoggedBounds.set(tabId, { width: requested.width, height: requested.height, timestamp: now })
  }
}

// ---------------------------------------------------------------------------
// 重型操作防并发：同一 tabId 同一操作只允许一个在途请求
// ---------------------------------------------------------------------------

const _inFlightOps = new Map<string, boolean>()

const CANCEL_BROWSER_ANNOTATION_SCRIPT = `(() => {
  const cancelKey = '__tabtinBrowserAnnotationCancel__';
  if (typeof window[cancelKey] === 'function') {
    window[cancelKey]();
    return true;
  }
  return false;
})()`

function withConcurrencyGuard<T>(
  key: string,
  fn: () => Promise<T>
): Promise<T | { success: false; error: string }> {
  if (_inFlightOps.get(key)) {
    return Promise.resolve({ success: false, error: `操作 ${key} 正在进行中，请稍后重试` })
  }
  _inFlightOps.set(key, true)
  return fn().finally(() => {
    _inFlightOps.delete(key)
  })
}

// 本地化退役 Wave 3：partition 重建（destroy + show）路径的串行锁。
//
// 用户改 env 绑定 → renderer EmbeddedCrawlView 监测到 partition 变化 → 调一次
// `crawl-view:show`。如果用户连续改两次（A→B→C 在 destroyView 完成前）会触发
// 两次 show，两次都进 partition mismatch 分支：
//   - 不加锁：两次都尝试 destroyView，第二次撞 `destroyingViewIds.has` 早返，
//     接着两个 showEmbeddedView 各自再创建一份 view，view-factory 的 reuse
//     检查可能撞 race，状态不一致。
//   - 加锁：第一次锁住 tabId 完整跑完 destroy + show + 广播；后续并发的 show
//     直接 skip（renderer 拿到的最新 partition 在锁释放后下一帧的 EmbeddedCrawlView
//     effect 里会再触发一次 show，自然收敛到最新值）。
const _partitionRebuildInFlight = new Set<string>()

// ---------------------------------------------------------------------------
// 已注册 channel 追踪（用于 cleanup）
// ---------------------------------------------------------------------------

const registeredIpcChannels: string[] = []

export function unregisterAllIpcHandlers(): void {
  // 退出竞态保护：把每个 channel 替换成 noop stub 而不是 removeHandler。
  // 退出阶段 renderer 各组件 unmount 时仍会发若干 crawl-view:* IPC（典型如
  // crawl-view:hide），如果 handler 已 remove，Electron 会自己抛
  // "No handler registered for 'crawl-view:hide'" 到 stderr。业务上这一刻
  // 无所谓返回什么，stub 静默返回 success 即可消除噪声。
  for (const channel of registeredIpcChannels) {
    try {
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, async () => ({ success: true, ignored: 'app-quitting' }))
    } catch { /* ignore */ }
  }
  registeredIpcChannels.length = 0
  lastLoggedBounds.clear()
  _inFlightOps.clear()
  _partitionRebuildInFlight.clear()
  log.info('IPC handlers 已注销（替换为退出期 noop stub）')
}

// ---------------------------------------------------------------------------
// 注册所有 crawl-view:* IPC handlers
// ---------------------------------------------------------------------------

export function registerEmbeddedCrawlViewHandlers(): void {
  log.info('注册 IPC 处理器...')
  const d = deps()

  const guardedTrackHandle = createGuardedTrackHandle(registeredIpcChannels)

  // -- 显示视图 --
  guardedTrackHandle(
    'crawl-view:show',
    async (
      _event,
      urlOrTabId: string,
      boundsOrUrl: any,
      maybeBounds?: any,
      runIdOrOptions?: any,
      maybeOptions?: any
    ) => {
      try {
        const isPlainObject = (value: any) => typeof value === 'object' && value !== null && !Array.isArray(value)
        const runId = typeof runIdOrOptions === 'string' ? runIdOrOptions : undefined
        const options = isPlainObject(runIdOrOptions) ? runIdOrOptions : (isPlainObject(maybeOptions) ? maybeOptions : undefined)

        const isNewStyle = typeof boundsOrUrl === 'string'
        const tabId = isNewStyle ? urlOrTabId : null
        if (tabId) {
          const viewFactory = getViewFactory()
          const existing = viewFactory.getViewState(tabId)
          const existingMeta = existing?.config?.metadata || {}
          const isWorkspaceIntent = Boolean(
            existingMeta?.crawlspaceId ||
              existingMeta?.kind === 'workspace-view' ||
              options?.crawlspaceId ||
              options?.kind === 'workspace-view'
          )

          if (isWorkspaceIntent && !existing) {
            if (!options?.crawlspaceId || options?.kind !== 'workspace-view' || !options?.partition) {
              return { success: false, error: 'workspace view requires crawlspaceId/kind/partition' }
            }
          }

          if (existing && isWorkspaceIntent) {
            if (options?.kind && options.kind !== 'workspace-view') {
              return { success: false, error: 'workspace view cannot be shown as normal-view' }
            }
            // crawlspaceId 不一致 = 同一 tabId 被两个不同 workspace 抢用，属于
            // 数据完整性问题（不是用户改 env 绑定的"合法重建"），保留 hard error。
            if (options?.crawlspaceId && existingMeta?.crawlspaceId && options.crawlspaceId !== existingMeta.crawlspaceId) {
              return { success: false, error: 'crawlspaceId mismatch for workspace view' }
            }
            // ── partition 不一致 = 用户改了 env 绑定（或镜像就绪后升级）──
            //
            // 历史行为：返回 partition 不匹配 error → 工具栏弹红条 + 用户必须
            // 手动关闭重开。Wave 3 收尾：BrowserEnvironment 完全本地化后，
            // partition 在主进程同步可读，"环境变更"是合法路径而非错误。
            // 改为主动销毁旧 view + 用新 partition 重建，并广播
            // `crawl-view:partition-rebuilt` 让 renderer 弹友好 toast。
            //
            // 注：destroy → showEmbeddedView 之间，view 已不在 `views` 表里，
            // 后续 `view-reuse.ts` 取不到 existing 自然走"创建新 view"路径，
            // 不会再撞 partition 一致性检查。
            if (options?.partition && existing?.config?.partition && options.partition !== existing.config.partition) {
              const oldPartition = existing.config.partition
              const newPartition = options.partition

              // ── B1 守卫：Agent run 期间不打断 view ──
              //
              // 设置页 toast / 首次切换说明对话框承诺 "Agent 正在执行的任务会
              // 继续用旧环境跑完"。如果不加这个守卫，destroyView force=true 会
              // 把绑定到 active run 的 webContents 当场销毁，下一条 action-tools
              // 调用立刻失败 → run 半路死掉 → 撒谎 toast。
              //
              // 当前选择：拒绝重建，告诉 renderer `deferred: 'run-in-progress'`。
              // renderer（EmbeddedCrawlView）收到此响应后走 L-W3-6 修复后的
              // `handleCrawlViewShowResponse.onDeferredOrSkipped` 分支，
              // **不调 touchView / setDisplayKey** 副作用，仅记 info 日志。
              //
              // 真正的"下一轮重建"由两条路径之一驱动：
              //   1. 用户驱动的下一次 show（切 tab / resize / reload / 滚动等
              //      触发 useViewDisplay 主 effect）：主 effect 不依赖
              //      lastObservedPartitionRef，直接用 store 中的最新 partition
              //      重发 show → run 已结束（viewToRun 解除）→ 守卫放行 →
              //      完成重建。
              //   2. partition-rebuild-released 广播（成功或失败路径都广播）：
              //      EmbeddedCrawlView 的 onReleased 监听比对 store partition
              //      vs actualPartition，不一致则主动再发一次 show。
              //
              // 注：EmbeddedCrawlView 的 `lastObservedPartitionRef` 在 partition
              // 字面量变化时即被推进到 newPartition（即使本次 show 被 defer），
              // 这是有意行为——它只用于"partition 字面量变化驱动 show"那条
              // effect，不影响主 effect 的下一次 show 调用。
              const activeRunId = getRunSessionManager().getRunIdByView(tabId)
              if (activeRunId) {
                log.info('partition 不一致但 view 绑定 active run, deferred 直到 run 结束', {
                  tabId, oldPartition, newPartition, activeRunId,
                })
                return {
                  success: true,
                  rebuilt: false,
                  deferred: 'run-in-progress',
                  activeRunId,
                }
              }

              if (_partitionRebuildInFlight.has(tabId)) {
                // 同一 tab 正在另一条路径重建中，跳过此次。
                //
                // B2 收敛：renderer 端 EmbeddedCrawlView 收到 `success: true,
                // skipped: 'rebuild-in-flight'` 响应后，走 L-W3-6 修复后的
                // `handleCrawlViewShowResponse.onDeferredOrSkipped` 分支，
                // **不调 touchView / setDisplayKey** 副作用。锁释放时主进程
                // 无条件广播 `crawl-view:partition-rebuild-released`，
                // EmbeddedCrawlView 的 onReleased 监听比对 store partition
                // vs actualPartition，不一致则自动再发一次 show 完成收敛。
                log.info('partition 重建已在进行中，跳过重复请求', { tabId, newPartition })
                return { success: true, rebuilt: false, skipped: 'rebuild-in-flight' }
              }
              log.info('partition 不一致，主动销毁旧 view 并重建', {
                tabId, oldPartition, newPartition,
                crawlspaceId: existingMeta?.crawlspaceId,
              })
              _partitionRebuildInFlight.add(tabId)
              // actualResolvedPartition：finally 里广播给 renderer 的"主进程
              // 实际生效的 partition"。成功路径 = newPartition；任一步骤失败
              // = oldPartition（因为 view 状态没变成新 partition）。
              let actualResolvedPartition = oldPartition
              try {
                try {
                  await getViewFactory().destroyView(tabId, { force: true })
                } catch (destroyErr: any) {
                  // 销毁失败时返回 error 而不是继续——继续重建会撞 view-reuse 的
                  // partition 检查再抛一次，对调用方反而不友好。
                  log.error('partition 重建：销毁旧 view 失败', { tabId, error: destroyErr?.message })
                  return { success: false, error: `partition rebuild failed: ${destroyErr?.message || String(destroyErr)}` }
                }
                // 广播放在 showEmbeddedView **之后** —— 如果重建失败,toast"已切换到新登录环境"
                // 显示给用户却看不到 view 是欺骗。BroadcastChannel 不支持撤销 toast,
                // 只能严格按"成功才弹"的契约来。
                try {
                  await d.showEmbeddedView(urlOrTabId, boundsOrUrl, maybeBounds, runId, options)
                } catch (showErr: any) {
                  log.error('partition 重建：showEmbeddedView 失败,旧 view 已销毁但新 view 未起', {
                    tabId, error: showErr?.message,
                  })
                  return {
                    success: false,
                    error: `partition rebuild succeeded destroy but failed show: ${showErr?.message || String(showErr)}`,
                    rebuilt: true,
                  }
                }
                actualResolvedPartition = newPartition
                // 广播给所有 BrowserWindow（不仅主窗口）——多窗口形态下让每个窗口都能弹 toast，
                // 与 `browser-env:changed` 的广播一致。
                for (const win of BrowserWindow.getAllWindows()) {
                  if (win.isDestroyed()) continue
                  try {
                    win.webContents.send('crawl-view:partition-rebuilt', {
                      tabId,
                      oldPartition,
                      newPartition,
                      reason: 'env-binding-changed',
                    })
                  } catch (sendErr) {
                    log.warn('广播 partition-rebuilt 失败（单个窗口）:', sendErr)
                  }
                }
                return { success: true, rebuilt: true }
              } finally {
                _partitionRebuildInFlight.delete(tabId)
                // B2 收敛广播：renderer 在 _partitionRebuildInFlight 期间发起
                // 的并发 show 已被 skip；锁释放后告诉所有 renderer 主进程实际
                // 处理到的 partition，让 EmbeddedCrawlView 比对 store partition
                // → 不一致则自动再发一次 show（用户连续切 A→B→C 时确保最终
                // 收敛到 C，而非停在 B）。
                //
                // 失败路径也广播：actualResolvedPartition 仍是 oldPartition，
                // renderer 比对发现 store 是 C → 再触发 show → 主进程再尝试
                // 重建。第二次失败仍然会广播，但失败 toast 已让用户感知，
                // 不会无限循环（renderer 端 EmbeddedCrawlView 用 ref 记录最近
                // ack 的 partition，相同 partition 不会重复 retry）。
                for (const win of BrowserWindow.getAllWindows()) {
                  if (win.isDestroyed()) continue
                  try {
                    win.webContents.send('crawl-view:partition-rebuild-released', {
                      tabId,
                      actualPartition: actualResolvedPartition,
                    })
                  } catch (sendErr) {
                    log.warn('广播 partition-rebuild-released 失败（单个窗口）:', sendErr)
                  }
                }
              }
            }
          }
        }

        await d.showEmbeddedView(urlOrTabId, boundsOrUrl, maybeBounds, runId, options)
        return { success: true }
      } catch (error: any) {
        log.error('显示视图失败:', error)
        return { success: false, error: error.message }
      }
    }
  )

  // -- 隐藏视图 --
  guardedTrackHandle('crawl-view:hide', async (_event, tabId?: string) => {
    try {
      d.hideEmbeddedView(tabId)
      return { success: true }
    } catch (error: any) {
      log.error('隐藏视图失败:', error)
      return { success: false, error: error.message }
    }
  })

  // -- 专用 setViewBounds --
  guardedTrackHandle('crawl-view:setViewBounds', async (_event, tabId: string, bounds: { x: number; y: number; width: number; height: number }) => {
    try {
      if (!tabId) {
        return { success: false, error: 'tabId is required' }
      }
      const view = getViewFactory().getView(tabId)
      if (!view) {
        log.warn('setViewBounds: View 不存在:', { tabId })
        return { success: false, error: `View not found: ${tabId}` }
      }
      view.setBounds(bounds)
      applyBrowserViewBorderRadius(view)
      const applied = view.getBounds()
      logBoundsIfSignificant(tabId, bounds, applied)
      scheduleFitToWidth(tabId)
      return { success: true, requested: bounds, applied }
    } catch (error: any) {
      log.error('setViewBounds 失败:', error)
      return { success: false, error: error.message }
    }
  })

  // -- 拖拽模式 --
  guardedTrackHandle('crawl-view:setIgnoreMouseEventsForAttached', async (_event, ignore: boolean) => {
    try {
      d.syncIgnoreMouseEventsForAttached(Boolean(ignore))
      return { success: true }
    } catch (error: any) {
      log.error('setIgnoreMouseEventsForAttached 失败:', error)
      return { success: false, error: error.message }
    }
  })

  // -- 导航控制 --
  guardedTrackHandle('crawl-view:goBack', async (_event, tabId?: string) => {
    try {
      const success = goBack(tabId)
      return { success, canGoBack: getNavigationState(tabId).canGoBack }
    } catch (error: any) {
      log.error('后退失败:', error)
      return { success: false, error: error.message }
    }
  })

  guardedTrackHandle('crawl-view:goForward', async (_event, tabId?: string) => {
    try {
      const success = goForward(tabId)
      return { success, canGoForward: getNavigationState(tabId).canGoForward }
    } catch (error: any) {
      log.error('前进失败:', error)
      return { success: false, error: error.message }
    }
  })

  guardedTrackHandle('crawl-view:reload', async (_event, ignoreCache = false, tabId?: string) => {
    try {
      const success = reload(ignoreCache, tabId)
      return { success }
    } catch (error: any) {
      log.error('刷新失败:', error)
      return { success: false, error: error.message }
    }
  })

  guardedTrackHandle('crawl-view:stop', async (_event, tabId?: string) => {
    try {
      const success = stop(tabId)
      return { success }
    } catch (error: any) {
      log.error('停止失败:', error)
      return { success: false, error: error.message }
    }
  })

  guardedTrackHandle('crawl-view:getNavigationState', async (_event, tabId?: string) => {
    try {
      const state = getNavigationState(tabId)
      return { success: true, state }
    } catch (error: any) {
      log.error('获取导航状态失败:', error)
      return { success: false, error: error.message }
    }
  })

  // -- 内容操作 --
  guardedTrackHandle('crawl-view:executeScript', async (_event, script: string, tabId?: string, url?: string, options?: ViewOptions) => {
    const guardKey = `executeScript:${tabId || 'active'}`
    return withConcurrencyGuard(guardKey, async () => {
      try {
        const result = await executeScript(script, tabId, url, options)
        return { success: true, result }
      } catch (error: any) {
        log.error('执行脚本失败:', error)
        return { success: false, error: error.message }
      }
    })
  })

  // 注释取消必须能打断仍在等待用户点击的 executeScript Promise，不能复用上面的同 tab 串行锁。
  // : 经容器无关的 getWebContents 取页面（WCV / webview guest 一致）。
  guardedTrackHandle('crawl-view:cancelAnnotation', async (_event, tabId: string) => {
    try {
      if (!tabId) {
        return { success: false, error: 'tabId is required' }
      }
      const wc = getViewFactory().getWebContents(tabId)
      if (!isAliveWebContents(wc)) {
        return { success: false, error: `View not found: ${tabId}` }
      }
      const result = await wc.executeJavaScript(CANCEL_BROWSER_ANNOTATION_SCRIPT)
      return { success: true, result }
    } catch (error: any) {
      log.error('取消网页注释失败:', error)
      return { success: false, error: error.message }
    }
  })

  guardedTrackHandle('crawl-view:loadUrl', async (_event, tabId: string, url: string, options?: LoadUrlOptions) => {
    try {
      return await loadUrl(tabId, url, options)
    } catch (error: any) {
      log.error('loadUrl 失败:', error)
      return { success: false, status: 'error', error: error.message }
    }
  })

  guardedTrackHandle('crawl-view:waitForSelector', async (_event, tabId: string, options: WaitForOptions) => {
    try {
      return await waitForSelector(tabId, options)
    } catch (error: any) {
      log.error('waitForSelector 失败:', error)
      return { success: false, error: error.message }
    }
  })

  guardedTrackHandle('crawl-view:getProcessedContent', async (_event, tabId?: string, url?: string, runId?: string, options?: ViewOptions) => {
    try {
      return await getProcessedContent(tabId, url, runId, options)
    } catch (error: any) {
      log.error('action-tools 获取内容失败:', error)
      return { success: false, error: error.message }
    }
  })

  // -- 截图 --
  guardedTrackHandle('crawl-view:screenshot', async (_event, options?: ScreenshotCaptureOptions, tabId?: string, url?: string, runId?: string, viewOptions?: ViewOptions) => {
    const guardKey = `screenshot:${tabId || 'active'}`
    return withConcurrencyGuard(guardKey, async () => {
      try {
        const buffer = await screenshot(options, tabId, url, runId, viewOptions)
        const base64 = buffer.toString('base64')
        return { success: true, data: base64, format: options?.format || 'png' }
      } catch (error: any) {
        log.error('截图失败:', error)
        return { success: false, error: error.message }
      }
    })
  })

  // -- CDP / WebContents --
  guardedTrackHandle('crawl-view:getCDPEndpoint', async (_event) => {
    try {
      const endpoint = getCDPEndpoint()
      if (endpoint) {
        return { success: true, endpoint }
      } else {
        return { success: false, error: '无法获取 CDP 端点' }
      }
    } catch (error: any) {
      log.error('获取 CDP 端点失败:', error)
      return { success: false, error: error.message }
    }
  })

  guardedTrackHandle('crawl-view:getWebContentsId', async (_event) => {
    try {
      const id = getWebContentsId()
      if (id !== null) {
        return { success: true, id }
      } else {
        return { success: false, error: '无法获取 WebContents ID' }
      }
    } catch (error: any) {
      log.error('获取 WebContents ID 失败:', error)
      return { success: false, error: error.message }
    }
  })

  // -- HTML / PageInfo --
  guardedTrackHandle('crawl-view:getHTML', async (_event, tabId?: string, url?: string, runId?: string, options?: ViewOptions) => {
    const guardKey = `getHTML:${tabId || 'active'}`
    return withConcurrencyGuard(guardKey, async () => {
      try {
        const html = await getHTML(tabId, url, runId, options)
        return { success: true, html }
      } catch (error: any) {
        log.error('获取 HTML 失败:', error)
        return { success: false, error: error.message }
      }
    })
  })

  guardedTrackHandle('crawl-view:getPageInfo', async (_event, tabId?: string, url?: string, runId?: string, options?: ViewOptions) => {
    try {
      const pageInfo = await getPageInfo(tabId, url, runId, options)
      return { success: true, pageInfo }
    } catch (error: any) {
      log.error('获取页面信息失败:', error)
      return { success: false, error: error.message }
    }
  })

  // -- 缓存管理 --
  guardedTrackHandle('crawl-view:getCacheStats', async () => {
    try {
      const stats = d.getCacheStats()
      return { success: true, stats }
    } catch (error: any) {
      log.error('获取缓存统计失败:', error)
      return { success: false, error: error.message }
    }
  })

  guardedTrackHandle('crawl-view:cleanupCache', async () => {
    try {
      const viewFactory = getViewFactory()
      const result = await viewFactory.triggerCleanup()
      log.info('手动触发缓存清理:', result.message)
      const stats = d.getCacheStats()
      return { success: true, stats, ...result }
    } catch (error: any) {
      log.error('执行缓存清理失败:', error)
      return { success: false, error: error.message }
    }
  })

  guardedTrackHandle('crawl-view:hasView', async (_event, viewId: string) => {
    try {
      return { success: true, exists: getViewFactory().hasView(viewId) }
    } catch (error: any) {
      log.error('检查 View 是否存在失败:', error)
      return { success: false, error: error.message }
    }
  })

  guardedTrackHandle('crawl-view:touch', async (_event, viewId: string, reason?: string) => {
    try {
      const accessor = d.getResourceManagerAccessor()
      const resourceManager = accessor?.() ?? null
      if (!resourceManager?.touchView) {
        return { success: false, error: 'ResourceManager 不可用' }
      }
      const touched = resourceManager.touchView(viewId, reason)
      return { success: true, touched }
    } catch (error: any) {
      log.error('touch view 失败:', error)
      return { success: false, error: error.message }
    }
  })

  // -- 页面内查找 --
  // : 经容器无关的 getWebContents 取页面（WCV / webview guest 一致），
  // findInPage / stopFindInPage / found-in-page 事件均为 WebContents 级能力。
  guardedTrackHandle('crawl-view:findInPage', async (_event, tabId: string, text: string, options?: { forward?: boolean; findNext?: boolean; matchCase?: boolean }) => {
    try {
      const wc = getViewFactory().getWebContents?.(tabId)
      if (!wc || wc.isDestroyed()) {
        return { success: false, error: 'view not found' }
      }
      const foundHandler = (_e: Electron.Event, result: Electron.Result) => {
        wc.removeListener('destroyed', destroyedCleanup)
        const mw = d.getMainWindow()
        if (mw && !mw.isDestroyed()) {
          mw.webContents.send('crawl-view:found-in-page', {
            viewId: tabId,
            activeMatchOrdinal: result.activeMatchOrdinal,
            matches: result.matches,
            finalUpdate: result.finalUpdate
          })
        }
      }
      const destroyedCleanup = () => {
        wc.removeListener('found-in-page', foundHandler)
      }
      wc.once('found-in-page', foundHandler)
      wc.once('destroyed', destroyedCleanup)
      const requestId = wc.findInPage(text, options)
      return { success: true, requestId }
    } catch (error: any) {
      log.error('findInPage 失败:', error)
      return { success: false, error: error.message }
    }
  })

  guardedTrackHandle('crawl-view:stopFindInPage', async (_event, tabId: string, action?: 'clearSelection' | 'keepSelection' | 'activateSelection') => {
    try {
      const wc = getViewFactory().getWebContents?.(tabId)
      if (!wc || wc.isDestroyed()) {
        return { success: false, error: 'view not found' }
      }
      wc.stopFindInPage(action || 'clearSelection')
      return { success: true }
    } catch (error: any) {
      log.error('stopFindInPage 失败:', error)
      return { success: false, error: error.message }
    }
  })

  // -- 缩放控制 --
  // : 经容器无关的 getWebContents 取页面（WCV 返回同一 webContents，
  // 行为不变；webview guest 条目由此路径同样可缩放）
  guardedTrackHandle('crawl-view:setZoomLevel', async (_event, tabId: string, level: number) => {
    try {
      const wc = getViewFactory().getWebContents?.(tabId)
      if (!wc || wc.isDestroyed()) {
        return { success: false, error: 'view not found' }
      }
      wc.setZoomLevel(level)
      markManualZoom(tabId, level)
      notifyBrowserZoomLevelChanged(tabId, level)
      return { success: true }
    } catch (error: any) {
      log.error('setZoomLevel 失败:', error)
      return { success: false, error: error.message }
    }
  })

  guardedTrackHandle('crawl-view:getZoomLevel', async (_event, tabId: string) => {
    try {
      const wc = getViewFactory().getWebContents?.(tabId)
      if (!wc || wc.isDestroyed()) {
        return { success: false, error: 'view not found', level: 0 }
      }
      return { success: true, level: wc.getZoomLevel() }
    } catch (error: any) {
      log.error('getZoomLevel 失败:', error)
      return { success: false, error: error.message, level: 0 }
    }
  })

  // -- 销毁标签视图 --
  guardedTrackHandle('crawl-view:destroyTabView', async (_event, tabId: string) => {
    try {
      const viewFactory = getViewFactory()
      const state = viewFactory.getViewState?.(tabId)
      const metadata = state?.config?.metadata || {}
      const isWorkspaceView = Boolean(metadata?.crawlspaceId || metadata?.kind === 'workspace-view')
      if (isWorkspaceView) {
        return { success: false, error: 'workspace view 请使用 crawlspace:closeView' }
      }
      await d.destroyTabView(tabId)
      return { success: true }
    } catch (error: any) {
      log.error('销毁标签视图失败:', error)
      return { success: false, error: error.message }
    }
  })

  // -- 孤儿资源协调 --
  guardedTrackHandle(
    'crawl-view:reconcileOrphans',
    async (_event, payload: { knownTabIds?: string[]; knownViewIds?: string[]; knownWorkspaceIds?: string[]; reason?: string }) => {
      try {
        return await reconcileOrphansFn(payload, { getCurrentTabId: d.getCurrentTabId })
      } catch (error: any) {
        log.error('reconcileOrphans 失败:', error)
        return { success: false, error: error?.message || String(error) }
      }
    }
  )

  // -- DevTools --
  // 容器无关：经 getWebContents 同时覆盖 WCV 与 webview guest（ Phase 3）。
  guardedTrackHandle('webcontentsview:openDevTools', async (_event, viewId: string) => {
    try {
      if (!shouldAllowBrowserDevTools()) {
        return { success: false, error: 'Browser DevTools is disabled for this profile' }
      }
      const wc = getViewFactory().getWebContents?.(viewId)
      if (!wc || wc.isDestroyed()) {
        return { success: false, error: 'view not found' }
      }
      if (!wc.isDevToolsOpened()) {
        wc.openDevTools({ mode: 'detach' })
      }
      return { success: true }
    } catch (error: any) {
      log.error('openDevTools 失败:', error)
      return { success: false, error: error.message }
    }
  })

  guardedTrackHandle('webcontentsview:closeDevTools', async (_event, viewId: string) => {
    try {
      const wc = getViewFactory().getWebContents?.(viewId)
      if (!wc || wc.isDestroyed()) {
        return { success: false, error: 'view not found' }
      }
      if (wc.isDevToolsOpened()) {
        wc.closeDevTools()
      }
      return { success: true }
    } catch (error: any) {
      log.error('closeDevTools 失败:', error)
      return { success: false, error: error.message }
    }
  })

  guardedTrackHandle('webcontentsview:getAllViews', async () => {
    try {
      const allInfo = d.getAllTabsInfo()
      return { success: true, views: allInfo }
    } catch (error: any) {
      log.error('getAllViews 失败:', error)
      return { success: false, error: error.message, views: [] }
    }
  })

  log.info('IPC 处理器注册完成')
}
