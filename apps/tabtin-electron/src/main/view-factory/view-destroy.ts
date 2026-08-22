/**
 * view-destroy — View 销毁流程
 *
 * 从 ViewFactory.destroyView 提取核心销毁序列，纯函数设计：
 * 不持有状态，所有依赖通过 ViewDestroyDeps 注入。
 *
 * 职责：
 * - 从主窗口移除 View
 * - 关闭 Browser/CDP 会话
 * - 销毁 WebContents + ViewManager 底层 View
 * - 资源拦截状态清理
 * - 任务索引清理
 * - Tab Discarding 通知
 * - 子系统反注册
 * - views Map 最终更新
 */

import type { BrowserWindow, WebContentsView } from 'electron'
import type { ViewEntry, DestroyViewOptions } from './types'
import type { ViewManager } from '@tabtin/browser-capabilities'
import type { DisplayContext } from './display-handler'
import {
  removeFromMainWindow,
  notifyRendererCloseTab,
} from './display-handler'
import { cleanupResourceInterceptionState } from './resource-interception'
import { createLogger } from '../logger'

const log = createLogger('ViewFactory')

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ViewDestroyDeps {
  views: Map<string, ViewEntry>
  viewManager: ViewManager
  mainWindow: BrowserWindow | null
  taskViewIndex: Map<string, Set<string>>
  registrationCoordinator: { unregisterAll: (entry: ViewEntry) => Promise<void> }
  getDisplayCtx: () => DisplayContext
  closeBrowserForView: (id: string) => Promise<void>
  destroyWebContents: (view: WebContentsView, entry?: ViewEntry) => Promise<void>
  log: (...args: any[]) => void
}

export interface ViewDestroyResult {
  viewDestroyed: boolean
  shouldNotifyRenderer: boolean
  isDiscard: boolean
}

// ---------------------------------------------------------------------------
// Core destruction
// ---------------------------------------------------------------------------

/**
 * 执行 View 核心销毁序列。
 *
 * 顺序：从主窗口移除 → 关闭 Browser/CDP → 销毁 WebContents → ViewManager 销毁 →
 * 资源拦截清理 → 任务索引清理 → discard 通知 → 子系统反注册 → 更新 views Map。
 *
 * 调用方（ViewFactory.destroyView）负责：
 * - 重入守卫（destroyingViewIds）
 * - keepAlive 判断
 * - CrawlspaceContextHub closing 标记
 * - 性能记录 + 事件发射
 * - try/catch/finally 框架
 *
 * @returns 销毁结果（供调用方做性能记录 / 事件发射 / 异常恢复）
 */
export async function executeViewDestruction(
  id: string,
  entry: ViewEntry,
  options: DestroyViewOptions | undefined,
  deps: ViewDestroyDeps,
): Promise<ViewDestroyResult> {
  const isWorkspaceView = Boolean(entry.config.metadata?.crawlspaceId)
  const shouldNotifyRenderer = Boolean(entry.tabNotified) && !isWorkspaceView
  const isDiscard = options?.discard === true

  // 1. 从主窗口移除
  if (entry.attachedToMainWindow) {
    await removeFromMainWindow(id, deps.views, deps.getDisplayCtx())
  }

  // 2. 缓存 discard URL（viewManager.destroyView 后 webContents 不可访问）
  const discardUrl = isDiscard
    ? (entry.view?.webContents?.isDestroyed?.()
        ? (entry.config.url || '')
        : (entry.view?.webContents?.getURL() || entry.config.url || ''))
    : undefined

  // 3. 关闭 Browser/CDP 会话
  await deps.closeBrowserForView(id)

  // 4. 缓存 session/webContentsId
  const cachedSession = entry.view?.webContents?.session
  const cachedWcId = entry.view?.webContents?.id
  const wcAlreadyDestroyed = entry.view?.webContents?.isDestroyed?.() ?? true

  // 5. 清理 WebContents 监听器
  if (entry.view) {
    await deps.destroyWebContents(entry.view, entry)
  }

  // 6. 使用 ViewManager 销毁底层 View
  deps.viewManager.destroyView(id)
  if (cachedSession && cachedWcId != null && !wcAlreadyDestroyed) {
    cleanupResourceInterceptionState(cachedSession, cachedWcId)
  }
  entry.view = null

  // 7. 清理任务索引
  const taskId = entry.config.taskId
  if (taskId) {
    const viewSet = deps.taskViewIndex.get(taskId)
    if (viewSet) {
      viewSet.delete(id)
      if (viewSet.size === 0) {
        deps.taskViewIndex.delete(taskId)
      }
    }
  }

  // crashHistory 按 URL 维度维护，不随 viewId 删除（由 TTL 自动过期）

  // 8. Tab Discarding：先通知渲染进程标记休眠态，再反注册
  // 保证渲染进程先收到 discard 事件，再收到 context 移除推送，
  // syncItemsByType 才能凭 meta.discarded 保留标签
  if (isDiscard) {
    entry.discardedUrl = discardUrl || ''
    deps.mainWindow?.webContents.send('crawl-view:tab-discarded', {
      id,
      url: entry.discardedUrl,
    })
  }

  // 9. 子系统反注册（顺序：数据流 → 工作区 → VSR → CDP → Resource → Session）
  await deps.registrationCoordinator.unregisterAll(entry)

  // 10. 最终清理：discard 保留 entry，否则完全移除
  if (isDiscard) {
    entry.discarded = true
    deps.log('[ViewFactory] ✅ View 已 discard（标签保留为休眠态）:', id)
  } else {
    deps.views.delete(id)

    if (shouldNotifyRenderer) {
      await notifyRendererCloseTab(entry, deps.getDisplayCtx())
    }
    deps.log('[ViewFactory] ✅ View 销毁完成:', id)
  }

  return { viewDestroyed: true, shouldNotifyRenderer, isDiscard }
}

// ---------------------------------------------------------------------------
// Error recovery
// ---------------------------------------------------------------------------

/**
 * 部分销毁后的异常恢复：View 已销毁但后续处理失败时，确保状态一致。
 */
export async function recoverFromPartialDestruction(
  id: string,
  entry: ViewEntry,
  options: DestroyViewOptions | undefined,
  deps: Pick<ViewDestroyDeps, 'views' | 'registrationCoordinator' | 'log'>,
): Promise<void> {
  try {
    await deps.registrationCoordinator.unregisterAll(entry)
  } catch (unregError) {
    log.error('⚠️ 异常路径 unregisterAll 失败:', id, unregError)
  }
  if (options?.discard) {
    entry.discarded = true
    entry.discardedUrl = entry.discardedUrl || entry.config.url || ''
    entry.view = null
  } else {
    deps.views.delete(id)
  }
}
