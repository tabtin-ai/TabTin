/**
 * Tab Discard 事件监听器
 *
 * 监听主进程 ViewFactory 的 idle discard 事件，将标签标记为"休眠"态。
 * 当主进程因 idle 超时回收 View 时，标签不从 UI 中移除，而是在 meta 中标记 discarded。
 * 用户点击休眠标签时由导航层自动重建 View。
 *
 * 与 useOrphanResourceReconcile 互补：orphan reconcile 清理孤儿资源，
 * 而 tab discard 是有意的资源释放（标签保留、View 释放）。
 */

import { useEffect } from 'react'
import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'
import { createLogger } from '@/utils/logger'

const log = createLogger('TabDiscard')

/** 去掉 URL query/hash（可能含鉴权 token），只留 origin+path 便于诊断。 */
function sanitizeDiscardUrl(url: string): string {
  try {
    const u = new URL(url)
    return `${u.origin}${u.pathname}`
  } catch {
    return url.split('?')[0]
  }
}

/**
 * 清除 View 的 discarded 状态（从 itemsBySpace 的 meta 中移除标记）。
 * 在 View 恢复或标签关闭时调用。
 */
export function clearDiscardedState(viewId: string): void {
  const tabKey = `tabweb:${viewId}`
  const store = useSpaceContextTabsStore.getState()
  const spaceId = store.findSpaceByTabKey(tabKey)
  if (!spaceId) return
  const item = store.itemsBySpace[spaceId]?.[tabKey]
  if (item?.meta?.discarded) {
    const { discarded, discardedUrl, restoring, ...cleanMeta } = item.meta as Record<string, unknown>
    store.upsertItems(spaceId, [{ ...item, meta: Object.keys(cleanMeta).length > 0 ? cleanMeta : undefined }])
  }
}

/**
 * @deprecated 使用 clearDiscardedState 替代。保留以兼容旧导入。
 */
export const useDiscardedViewStore = {
  getState: () => ({
    clearDiscarded: clearDiscardedState,
  }),
}

export function useTabDiscardListener(): void {
  useEffect(() => {
    const ipc = window.electron?.ipcRenderer
    if (!ipc) return

    const handleTabDiscarded = (_event: unknown, data: { id: string; url: string }) => {
      if (!data?.id) return
      log.info('View 已休眠:', data.id, sanitizeDiscardUrl(data.url))

      const tabKey = `tabweb:${data.id}`
      const tabsState = useSpaceContextTabsStore.getState()
      const spaceId = tabsState.findSpaceByTabKey(tabKey)

      if (spaceId) {
        const item = tabsState.itemsBySpace[spaceId]?.[tabKey]
        if (item) {
          tabsState.upsertItems(spaceId, [{
            ...item,
            meta: { ...item.meta, discarded: true, discardedUrl: data.url },
          }])
        }
      }
    }

    const unsub = ipc.on('crawl-view:tab-discarded', handleTabDiscarded)

    return () => {
      unsub()
    }
  }, [])
}
