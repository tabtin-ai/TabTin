/**
 * Crawlspace lifecycle slice — closeCrawlspace, closeCrawlspaceView.
 *
 * Extracted from useCrawlTabStore.ts. Handles workspace and view
 * closure with IPC resource cleanup (endRun, closeView, destroyTabView).
 */

import { crawlViewClient } from '../../crawlspace/electron/crawl-view-client'
import { crawlspaceContextClient } from '../../crawlspace/electron/crawlspace-context-client'
import { runSessionClient } from '../../crawlspace/electron/run-session-client'
import { createLogger } from '@/utils/logger'
import type { CloseCrawlspaceViewResult, CrawlTab, CrawlspaceViewInfo, CrawlspaceConfig, CrawlspaceContextCache, CrawlspacePersistedViewSeed, CrawlspacePreviewState } from './types'
import { releaseCrawlspaceContextSubscription } from './crawlspaceContextSubscriptionRegistry'

const log = createLogger('CrawlLifecycle')

// ---------------------------------------------------------------------------
// Minimal store shape
// ---------------------------------------------------------------------------

export interface LifecycleStore {
  tabs: CrawlTab[]
  crawlspaceContextCache: Record<string, CrawlspaceContextCache>
  crawlspaceDeferredViewIdsByCS: Record<string, Set<string>>
  crawlspacePersistedViews: Record<string, CrawlspacePersistedViewSeed[]>
  crawlspaceConfigById: Record<string, CrawlspaceConfig>
  crawlspacePreviewStates: Record<string, CrawlspacePreviewState>
  _recentlyClosedViewIds: Set<string>
  getCrawlspaceViews: (crawlspaceId: string) => CrawlspaceViewInfo[]
  clearCrawlspacePreviewState: (crawlspaceId: string) => void
  applyCrawlspaceContextSnapshot: (crawlspaceId: string, snapshot: any) => void
  closeCrawlspace: (crawlspaceId: string, reason?: string, options?: { reason?: string }) => Promise<void>
  closeCrawlspaceView: (crawlspaceId: string, viewId: string) => Promise<CloseCrawlspaceViewResult>
  unmarkCrawlspaceViewDeferred: (crawlspaceId: string, viewId: string) => void
}

type GetFn = () => LifecycleStore
type SetFn = (
  partial:
    | Partial<LifecycleStore>
    | ((state: LifecycleStore) => Partial<LifecycleStore>),
) => void

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAX_CLOSED_VIEW_IDS = 200

/**
 * 向 _recentlyClosedViewIds 添加条目，超过容量上限时按 FIFO 淘汰。
 * 返回新的 Set（不修改原 Set）。
 */
export function addClosedViewId(prev: Set<string>, viewId: string): Set<string> {
  const next = new Set(prev)
  next.add(viewId)
  if (next.size > MAX_CLOSED_VIEW_IDS) {
    const iter = next.values()
    const excess = next.size - MAX_CLOSED_VIEW_IDS
    for (let i = 0; i < excess; i++) {
      next.delete(iter.next().value!)
    }
  }
  return next
}

async function endRunsSafe(
  runIds: Set<string>,
  crawlspaceId: string,
  reason: string,
): Promise<void> {
  for (const runId of runIds) {
    try {
      await runSessionClient.endRun(runId, {
        reason: `store.closeCrawlspace(${reason})`,
      })
    } catch (error) {
      log.warn('endRun 失败（忽略）:', { crawlspaceId, runId, error })
    }
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function readCloseViewFailure(raw: unknown): { code?: string; message: string } | null {
  if (!raw || typeof raw !== 'object') return null
  const result = raw as {
    success?: unknown
    ok?: unknown
    code?: unknown
    error?: unknown
    message?: unknown
  }

  if (result.success === false) {
    return {
      code: readString(result.code),
      message: readString(result.error) ?? readString(result.message) ?? 'close view failed',
    }
  }

  if (result.ok === false) {
    const envelopeError = result.error && typeof result.error === 'object'
      ? result.error as { code?: unknown; message?: unknown }
      : null
    return {
      code: readString(envelopeError?.code) ?? readString(result.code),
      message: readString(envelopeError?.message)
        ?? readString(result.error)
        ?? readString(result.message)
        ?? 'close view failed',
    }
  }

  return null
}

async function closeViewsSafe(
  views: CrawlspaceViewInfo[],
  crawlspaceId: string,
  reason: string,
): Promise<void> {
  // contract W2-β：旧 envelope `{success, error}` 改为 invokeIpc 自动 throw —
  // catch 块统一识别失败并 swallow（"忽略"语义保留：批量关闭流程不应被单 view
  // 失败阻断，下游 set state 仍清掉所有 tabs 状态）。
  for (const view of views) {
    if (view.isClosing) continue
    try {
      const result = await crawlspaceContextClient.closeView(
        crawlspaceId,
        view.viewId,
        `store.closeCrawlspace(${reason})`,
      )
      const failure = readCloseViewFailure(result)
      if (failure) {
        log.warn('关闭 workspace view 失败（忽略）:', {
          crawlspaceId, viewId: view.viewId, code: failure.code, message: failure.message,
        })
      }
    } catch (error) {
      log.warn('关闭 workspace view 失败（忽略）:', {
        crawlspaceId, viewId: view.viewId, error,
      })
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createCrawlspaceLifecycleActions(
  get: GetFn,
  set: SetFn,
) {
  return {
    deleteTab: (tabId: string) => {
      const current = get()
      const tab = current.tabs.find(t => t.id === tabId)
      const isWorkspaceTab = tab?.kind === 'workspace'

      if (isWorkspaceTab) {
        // Wave 3.3 简化：handler 是 `useCrawlTabStore.getState().closeCrawlspace`
        // 自己（store 模块加载时即注入），从 deleteTab 走 requestCloseWorkspace
        // 等于绕一圈跨包闭包再回到自己。直接调 closeCrawlspace 省 microtask
        // + dynamic import 闭包，语义不变。
        //
        // Wave 3.3 之前用 dynamic import 是为了规避 store 模块加载时反向 import
        // crawlspace-core 的潜在循环——Wave 3.3 改成 `useCrawlTabStore` 顶层
        // 静态 import `setCloseWorkspaceHandler` 后已无此风险。
        void get().closeCrawlspace(tabId, 'deleteTab(workspace)', { reason: 'deleteTab-workspace' })
        return
      }

      set((state: LifecycleStore) => {
        const newTabs = state.tabs.filter(t => t.id !== tabId)

        crawlViewClient
          .hasView(tabId)
          .then((exists: any) => {
            if (!exists?.exists) return null
            return crawlViewClient.destroyTabView(tabId)
          })
          .then((result: any) => {
            // contract W2-β：destroy 成功路径下 result 是 truthy（业务数据 / void）；
            // 失败已经走 catch（W2-α 后 invokeIpc 自动 throw）。
            if (result) log.info('标签视图已销毁:', tabId)
          })
          .catch((error: any) => {
            log.warn('销毁标签视图失败（已忽略）:', tabId, error?.message || error)
          })

        return {
          tabs: newTabs,
        }
      })
    },

    closeCrawlspace: async (
      crawlspaceId: string,
      reason?: string,
      options?: { reason?: string },
    ) => {
      const store = get()
      const views = store.getCrawlspaceViews(crawlspaceId)
      const closeReason = options?.reason
      const workspaceTab = store.tabs.find(t => t.id === crawlspaceId) || null

      log.info('关闭工作区:', {
        crawlspaceId, reason, viewCount: views.length, closeReason,
      })

      if (closeReason) {
        const runIds = new Set<string>()
        if (workspaceTab?.runId) runIds.add(workspaceTab.runId)
        for (const view of views) {
          if (view.runId) runIds.add(view.runId)
        }

        await endRunsSafe(runIds, crawlspaceId, reason || 'unknown')
        await closeViewsSafe(views, crawlspaceId, reason || 'unknown')
      }

      store.clearCrawlspacePreviewState(crawlspaceId)

      // 🆕 Wave 3.1: 业务实体退出时同步释放主进程 context 订阅。
      // 释放在 set 之前——避免迟到的 snapshot 写回正在被删除的 cache。
      releaseCrawlspaceContextSubscription(crawlspaceId)

      set((state: LifecycleStore) => {
        const newTabs = state.tabs.filter(t => t.id !== crawlspaceId)
        const nextCache = { ...state.crawlspaceContextCache }
        delete nextCache[crawlspaceId]
        const nextPersisted = { ...state.crawlspacePersistedViews }
        delete nextPersisted[crawlspaceId]
        const nextConfigs = { ...state.crawlspaceConfigById }
        delete nextConfigs[crawlspaceId]
        const nextDeferred = { ...state.crawlspaceDeferredViewIdsByCS }
        delete nextDeferred[crawlspaceId]
        return {
          tabs: newTabs,
          crawlspaceContextCache: nextCache,
          crawlspacePersistedViews: nextPersisted,
          crawlspaceConfigById: nextConfigs,
          crawlspaceDeferredViewIdsByCS: nextDeferred,
        }
      })
    },

    closeCrawlspaceView: async (crawlspaceId: string, viewId: string): Promise<CloseCrawlspaceViewResult> => {
      const store = get()
      const viewList = store.crawlspaceContextCache[crawlspaceId]?.viewList ?? []
      const persistedSeeds = store.crawlspacePersistedViews[crawlspaceId] || []
      const isClosing = viewList.find(view => view.viewId === viewId)?.isClosing
      if (isClosing) {
        log.warn('view 正在关闭中，跳过重复请求:', { crawlspaceId, viewId })
        return { ok: true, code: 'already_closing' }
      }
      log.debug('closeCrawlspaceView', {
        crawlspaceId, viewId, cacheCount: viewList.length, seedCount: persistedSeeds.length,
      })

      const workspaceTab = store.tabs.find(t => t.id === crawlspaceId)
      const closedView = viewList.find(v => v.viewId === viewId)

      // 先注册防护，防止 IPC 等待期间订阅快照将此 view 回写为 seed
      set((state: LifecycleStore) => ({
        _recentlyClosedViewIds: addClosedViewId(state._recentlyClosedViewIds, viewId),
      }))

      let closeSuccess = true
      let closeCode: CloseCrawlspaceViewResult['code'] = 'closed'
      let closeMessage: string | undefined
      try {
        // contract W2-β：旧 envelope `{success, error, code}` 改为 invokeIpc 直接返
        // `{ code? }` 或 throw —— `code` 是业务路径标识（closed / context_pruned / 等等），
        // 不是错误码，所以即使在新形态下仍是有意义的字段；catch 块统一处理失败。
        const result = await crawlspaceContextClient.closeView(
          crawlspaceId, viewId, 'store.closeCrawlspaceView',
        )
        const failure = readCloseViewFailure(result)
        if (failure) {
          closeSuccess = false
          closeCode = 'ipc_close_failed'
          closeMessage = failure.message
        } else if (result?.code) {
          switch (result.code) {
            case 'closed':
            case 'closed_with_context_prune':
            case 'context_pruned':
            case 'already_closed':
            case 'already_closing':
              closeCode = result.code as CloseCrawlspaceViewResult['code']
              break
            default:
              closeCode = 'closed'
              break
          }
        }
      } catch (error) {
        closeSuccess = false
        closeMessage = error instanceof Error ? error.message : String(error)
        log.warn('关闭 workspace view 失败:', { crawlspaceId, viewId, error })
      }
      if (!closeSuccess) {
        // IPC 失败，回滚防护标记
        set((state: LifecycleStore) => {
          const next = new Set(state._recentlyClosedViewIds)
          next.delete(viewId)
          return { _recentlyClosedViewIds: next }
        })
        return {
          ok: false,
          code: 'ipc_close_failed',
          message: closeMessage ?? 'close view failed',
        }
      }

      // IPC 成功后显式移除 seed / cache + deferred 标记
      set((state: LifecycleStore) => {
        const seeds = state.crawlspacePersistedViews[crawlspaceId] || []
        const filteredSeeds = seeds.filter(s => s.viewId !== viewId)
        const cache = state.crawlspaceContextCache[crawlspaceId]
        const filteredViewList = cache
          ? cache.viewList.filter(v => v.viewId !== viewId)
          : []
        // 🆕 Wave 3.1: 清理对应 viewId 的 deferred 标记（如果有的话）。
        const deferredIds = state.crawlspaceDeferredViewIdsByCS[crawlspaceId]
        let nextDeferredByCS = state.crawlspaceDeferredViewIdsByCS
        if (deferredIds && deferredIds.has(viewId)) {
          const next = new Set(deferredIds)
          next.delete(viewId)
          if (next.size === 0) {
            const { [crawlspaceId]: _removed, ...rest } = state.crawlspaceDeferredViewIdsByCS
            nextDeferredByCS = rest
          } else {
            nextDeferredByCS = {
              ...state.crawlspaceDeferredViewIdsByCS,
              [crawlspaceId]: next,
            }
          }
        }
        return {
          crawlspacePersistedViews: {
            ...state.crawlspacePersistedViews,
            [crawlspaceId]: filteredSeeds,
          },
          crawlspaceContextCache: {
            ...state.crawlspaceContextCache,
            [crawlspaceId]: {
              activeViewId: cache?.activeViewId === viewId
                ? (filteredViewList.find(v => !v.isClosing)?.viewId ?? null)
                : (cache?.activeViewId ?? null),
              viewList: filteredViewList,
            },
          },
          crawlspaceDeferredViewIdsByCS: nextDeferredByCS,
        }
      })

      try {
        const snapshot = await crawlspaceContextClient.getContext(crawlspaceId)
        if (snapshot && !Array.isArray(snapshot)) {
          store.applyCrawlspaceContextSnapshot(crawlspaceId, snapshot)
        }
      } catch (error) {
        log.warn('获取 Context 快照失败（忽略）:', { crawlspaceId, viewId, error })
      }

      {
        const after = get()
        log.debug('closeView done', {
          crawlspaceId, viewId,
          cacheAfter: (after.crawlspaceContextCache[crawlspaceId]?.viewList ?? []).length,
          seedsAfter: (after.crawlspacePersistedViews[crawlspaceId] || []).length,
        })
      }

      try {
        const remaining = viewList.filter(view => view.viewId !== viewId)
        if (remaining.length === 0) {
          const runIds = new Set<string>()
          if (workspaceTab?.runId) runIds.add(workspaceTab.runId)
          if (closedView?.runId) runIds.add(closedView.runId)

          for (const runId of runIds) {
            if (!runId) continue
            try {
              await runSessionClient.endRun(runId, {
                reason: 'store.closeCrawlspaceView(last)',
              })
            } catch (error) {
              log.warn('closeCrawlspaceView: endRun 失败（忽略）:', {
                crawlspaceId, viewId, runId, error,
              })
            }
          }
        }
      } finally {
        // closing 状态由 ContextHub 驱动
      }
      return { ok: true, code: closeCode }
    },
  }
}
