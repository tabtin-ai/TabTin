/** @store-category domain */

/**
 * useBrowsingHistoryStore - 浏览历史状态管理
 *
 * 通过监听 crawlView 的 page:loaded 和 favicon:changed 事件，
 * 自动记录浏览器的访问历史。数据持久化到 localStorage。
 *
 * 设计决策：
 * - 纯渲染进程方案，无需主进程改动
 * - 通过 crawlView.onEvent 捕获所有视图的导航事件
 * - 在浏览器主页面板 + EmbeddedCrawlView 挂载时 initialize；从主页「+」导航后 recordVisit 兜底首屏竞态
 * - 去重：连续访问同一 URL 不重复记录
 * - 最多保留 2000 条记录，超出自动淘汰最旧的
 */

import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { withPersistSafety, createMigratingStorage } from '@tabtin/shared'
import { getBucket, registerStorageBucket } from '@tabtin/storage-manager'
import { PERSIST_KEYS } from './persist-key-registry'
import { registerResetAction } from './sessionResetRegistry'

export interface BrowsingHistoryItem {
  id: string
  url: string
  title: string
  favicon?: string
  visitedAt: number
}

const MAX_HISTORY_ITEMS = 2000

// 单条估算容量（JSON：id+url+title+favicon+visitedAt 约 300-500 字节）
const HISTORY_AVG_BYTES = 400

interface BrowsingHistoryState {
  items: BrowsingHistoryItem[]
  initialized: boolean

  initialize: () => void
  /** 主动写入一次访问（用于主页「+」等可能早于 page:loaded 监听的导航） */
  recordVisit: (url: string, title?: string, favicon?: string) => void
  dispose: () => void
  deleteItem: (id: string) => void
  deleteItems: (ids: string[]) => void
  clearAll: () => void
  clearByDateRange: (before: number) => void
}

type BrowsingHistoryPersistState = Pick<BrowsingHistoryState, 'items'>

let unsubscribe: (() => void) | null = null
const recentFavicons = new Map<string, string>()

function shouldRecord(url: string): boolean {
  if (!url || url === 'about:blank') return false
  if (url.startsWith('devtools://')) return false
  if (url.startsWith('chrome://')) return false
  if (url.startsWith('chrome-extension://')) return false
  return true
}

function applyHistoryVisit(
  items: BrowsingHistoryItem[],
  input: { url: string; title?: string; favicon?: string },
): BrowsingHistoryItem[] {
  const { url, title, favicon } = input
  if (!shouldRecord(url)) return items

  const latest = items[0]
  if (latest && latest.url === url && (Date.now() - latest.visitedAt) < 3000) {
    if (title && title !== latest.title) {
      const updated = [...items]
      updated[0] = { ...latest, title, ...(favicon ? { favicon } : {}) }
      return updated
    }
    return items
  }

  const newItem: BrowsingHistoryItem = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    url,
    title: title || url,
    favicon,
    visitedAt: Date.now(),
  }
  return [newItem, ...items].slice(0, MAX_HISTORY_ITEMS)
}

export const useBrowsingHistoryStore = create<BrowsingHistoryState>()(
  persist<BrowsingHistoryState, [], [], BrowsingHistoryPersistState>(
    (set, get) => ({
      items: [],
      initialized: false,

      initialize: () => {
        if (get().initialized) return

        const api = window.tabtin?.crawlView
        if (!api?.onEvent) {
          // crawlView 尚未注入时保持未初始化，便于 EmbeddedCrawlView 挂载后重试
          return
        }

        unsubscribe = api.onEvent((event: any) => {
          if (!event?.type) return

          if (event.type === 'favicon:changed') {
            const { viewId, favicon } = event.data ?? event
            if (viewId && favicon) {
              recentFavicons.set(viewId, favicon)
              try {
                const faviconHost = new URL(favicon).host
                if (!faviconHost) return
                set(state => {
                  let changed = false
                  const updated = state.items.map(item => {
                    if (item.favicon) return item
                    try {
                      if (new URL(item.url).host === faviconHost) {
                        changed = true
                        return { ...item, favicon }
                      }
                    } catch { /* ignore */ }
                    return item
                  })
                  return changed ? { items: updated } : state
                })
              } catch { /* data: URL or invalid */ }
            }
            return
          }

          if (event.type === 'page:loaded') {
            const { url, title, viewId } = event.data ?? event
            if (!shouldRecord(url)) return

            const favicon = viewId ? recentFavicons.get(viewId) : undefined

            set(state => ({
              items: applyHistoryVisit(state.items, { url, title, favicon }),
            }))
          }
        })

        set({ initialized: true })
      },

      recordVisit: (url, title, favicon) => {
        if (!shouldRecord(url)) return
        set(state => ({
          items: applyHistoryVisit(state.items, { url, title, favicon }),
        }))
      },

      dispose: () => {
        if (unsubscribe) {
          unsubscribe()
          unsubscribe = null
        }
        recentFavicons.clear()
        set({ initialized: false })
      },

      deleteItem: (id) => {
        set(state => ({
          items: state.items.filter(item => item.id !== id),
        }))
      },

      deleteItems: (ids) => {
        const idSet = new Set(ids)
        set(state => ({
          items: state.items.filter(item => !idSet.has(item.id)),
        }))
      },

      clearAll: () => {
        set({ items: [] })
      },

      clearByDateRange: (before) => {
        set(state => ({
          items: state.items.filter(item => item.visitedAt >= before),
        }))
      },
    }),
    withPersistSafety<BrowsingHistoryState, BrowsingHistoryPersistState>({
      name: PERSIST_KEYS.browsingHistory,
      storage: createJSONStorage(() => createMigratingStorage(localStorage, ['agent-browsing-history'])),
      partialize: (state) => ({ items: state.items }),
      version: 1,
      migrate: (persisted: unknown, _version: number): BrowsingHistoryPersistState => persisted as BrowsingHistoryPersistState,
    }),
  ),
)

registerResetAction('browsing-history', 'reset', () => {
  useBrowsingHistoryStore.getState().dispose()
  useBrowsingHistoryStore.setState({ items: [], initialized: false })
})

// ── storage-manager 接入（W2.2 G3）──────────────────────────────
//
// browser:browsing-history 是隐私类 data 桶：
//   - 清理支持 itemIds 子项清（UI 按时间段勾选）
//   - category=data + requiresConfirmation=hard（强二次确认）
//   - 不提供 exportFn（隐私考虑；D-5 没把 browsing-history 列入 5 核心导出）
if (!getBucket('browser:browsing-history')) {
  registerStorageBucket({
    id: 'browser:browsing-history',
    category: 'data',
    group: 'browser',
    displayName: '浏览历史',
    description:
      '浏览器内嵌视图的访问记录（最多 2000 条）。当前版本不区分账号，仅展示当前视图。',
    warnings: [
      '清理会永久丢失浏览历史（无云端备份）',
      '隐私数据—清理后不可恢复',
    ],
    requiresConfirmation: 'hard',
    sizeFn: async () => {
      try {
        const raw = localStorage.getItem(PERSIST_KEYS.browsingHistory)
        if (raw) {
          const bytes =
            typeof TextEncoder !== 'undefined'
              ? new TextEncoder().encode(raw).length
              : raw.length
          return {
            bytes,
            itemCount: useBrowsingHistoryStore.getState().items.length,
          }
        }
      } catch {
        /* ignore */
      }
      const items = useBrowsingHistoryStore.getState().items
      return { bytes: items.length * HISTORY_AVG_BYTES, itemCount: items.length }
    },
    listFn: async () => {
      const items = useBrowsingHistoryStore.getState().items
      return items.map((h) => ({
        id: h.id,
        label: h.title || h.url,
        bytes: HISTORY_AVG_BYTES,
        metadata: {
          url: h.url,
          favicon: h.favicon,
          visitedAt: h.visitedAt,
        },
      }))
    },
    clearFn: async (options) => {
      const state = useBrowsingHistoryStore.getState()
      const items = state.items
      const targetIds =
        options?.itemIds && options.itemIds.length > 0
          ? new Set(options.itemIds)
          : null
      const targets = targetIds ? items.filter((h) => targetIds.has(h.id)) : items
      const freedBytes = targets.length * HISTORY_AVG_BYTES
      const clearedItemCount = targets.length
      if (options?.dryRun) {
        return { clearedItemCount, freedBytes }
      }
      if (targetIds) {
        state.deleteItems(Array.from(targetIds))
      } else {
        state.clearAll()
      }
      return { clearedItemCount, freedBytes }
    },
  })
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    useBrowsingHistoryStore.getState().dispose()
  })
}
