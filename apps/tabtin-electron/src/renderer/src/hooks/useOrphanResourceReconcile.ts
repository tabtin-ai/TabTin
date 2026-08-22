import { useEffect } from 'react'
import { useCrawlTabStore } from '@stores/useCrawlTabStore'
import { electronCrawlspaceHost } from '../crawlspace/host/electron-crawlspace-host'
import { crawlspaceContextClient } from '../crawlspace/electron/crawlspace-context-client'
import { createLogger } from '@/utils/logger'

const log = createLogger('OrphanReconcile')

/**
 * renderer 重载兜底：对齐主进程资源，清理孤儿 View/Run
 *
 * 触发时机：
 * - `useCrawlTabStore` rehydrate 完成后（确保已拿到“本次启动应存在的 tabIds”）
 *
 * 设计意图：
 * - 解决“刷新窗口后：工作区没了，但主进程 view/run 仍存在”的状态错位与资源泄漏问题
 */
/**
 * 🚀 启动优化：延迟执行 reconcile
 *
 * reconcileOrphans 通过 window.tabtin.crawlView.reconcileOrphans IPC 调用
 * embeddedCrawlView handlers，这些 handlers 在主进程爬虫模块延迟初始化中注册。
 *
 * 延迟 8 秒确保：
 * 1. 主进程 handlers 已就绪
 * 2. restorePersistedViews 已完成（最多 8 次重试 × 指数退避，可达 ~6s）
 * 避免 reconcile 与 view 恢复的竞态条件导致误删正在创建的 view。
 */
const RECONCILE_DELAY_MS = 8000

export function useOrphanResourceReconcile(): void {
  useEffect(() => {
    const allowOrphanReconcile = import.meta.env.VITE_ALLOW_ORPHAN_RECONCILE === 'true'
    if (!allowOrphanReconcile) {
      log.debug('已禁用（VITE_ALLOW_ORPHAN_RECONCILE=false）')
      return
    }
    const persistApi = (useCrawlTabStore as any).persist
    let delayTimer: ReturnType<typeof setTimeout> | null = null

    const reconcile = async (reason: string) => {
      const state = useCrawlTabStore.getState()
      const workspaceTabs = state.tabs.filter(tab => tab.kind === 'workspace')
      const workspaceIds = workspaceTabs.map(tab => tab.id).filter(Boolean)
      const legacyTabIds = state.tabs
        .filter(tab => tab.kind !== 'workspace')
        .map(tab => tab.id)
        .filter(Boolean)

      // ✅ 新模型关键：workspace 内部 view 不在 tabs[]，必须单独汇总 viewIds
      const viewIds = new Set<string>()

      // 1) 普通标签：tabId == viewId
      for (const tab of state.tabs) {
        if (!tab?.id) continue
        if (tab.kind === 'workspace') {
          continue
        }
        viewIds.add(tab.id)
      }

      // 2) workspace 内部 views（基于 crawlspaceContextCache）
      workspaceIds.forEach(crawlspaceId => {
        const workspaceViews = state.crawlspaceContextCache[crawlspaceId]?.viewList || []
        for (const v of workspaceViews) {
          if (v?.viewId) viewIds.add(v.viewId)
        }

        // 3) workspace 预览 view（如果存在）
        const previewState = state.getCrawlspacePreviewState(crawlspaceId)
        if (previewState?.previewTabId) viewIds.add(previewState.previewTabId)
      })

      const contextViewIds = new Set<string>()
      const contextWorkspaceIds = new Set<string>()
      try {
        const snapshot = await crawlspaceContextClient.getContext(null)
        if (Array.isArray(snapshot)) {
          snapshot.forEach(item => {
            if (item?.crawlspaceId) contextWorkspaceIds.add(item.crawlspaceId)
            item?.views?.forEach(view => {
              if (view?.viewId) contextViewIds.add(view.viewId)
            })
          })
        } else if (snapshot) {
          if (snapshot.crawlspaceId) contextWorkspaceIds.add(snapshot.crawlspaceId)
          snapshot.views?.forEach(view => {
            if (view?.viewId) contextViewIds.add(view.viewId)
          })
        }
      } catch (error) {
        log.warn('获取 Context 快照失败（忽略）:', error)
      }

      const knownViewIds = new Set<string>([...viewIds, ...contextViewIds])
      const knownWorkspaceIds = new Set<string>([...workspaceIds, ...contextWorkspaceIds])

      const hasContextSnapshot = contextViewIds.size > 0 || contextWorkspaceIds.size > 0
      if (workspaceIds.length > 0 && !hasContextSnapshot) {
        log.warn('未拿到 Context 快照，跳过 workspace 资源清理:', {
          reason,
          workspaceCount: workspaceIds.length
        })
        return
      }

      if (legacyTabIds.length === 0 && knownViewIds.size === 0 && knownWorkspaceIds.size === 0) {
        log.debug('未发现已知资源，跳过清理:', reason)
        return
      }

      try {
        await electronCrawlspaceHost.reconcileOrphans?.({
          knownTabIds: legacyTabIds,
          knownViewIds: Array.from(knownViewIds),
          knownWorkspaceIds: Array.from(knownWorkspaceIds),
          reason
        })
      } catch (error) {
        log.warn('reconcileOrphans 失败（忽略）:', error)
      }
    }

    const scheduleReconcile = (reason: string) => {
      delayTimer = setTimeout(() => {
        void reconcile(reason)
      }, RECONCILE_DELAY_MS)
    }

    // 已 hydrated 的情况下（某些热重载场景）延迟触发一次
    if (persistApi?.hasHydrated?.()) {
      scheduleReconcile('renderer-boot:already-hydrated')
    }

    // 标准路径：等待 rehydrate 完成后延迟触发
    const unsubscribe = persistApi?.onFinishHydration?.(() => {
      scheduleReconcile('renderer-boot:finish-hydration')
    })

    return () => {
      unsubscribe?.()
      if (delayTimer) clearTimeout(delayTimer)
    }
  }, [])
}
