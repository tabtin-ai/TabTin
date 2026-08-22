/** @store-category domain */

/**
 * useBookmarkStore - 浏览器书签管理
 *
 * 纯渲染进程方案，数据持久化到 localStorage。
 * 提供收藏/取消收藏、按 URL 查询、搜索、删除等能力。
 */

import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { withPersistSafety, createMigratingStorage } from '@tabtin/shared'
import { getBucket, registerStorageBucket } from '@tabtin/storage-manager'
import { PERSIST_KEYS } from './persist-key-registry'
import { registerResetAction } from './sessionResetRegistry'

export interface BookmarkItem {
  id: string
  url: string
  title: string
  favicon?: string
  createdAt: number
}

const MAX_BOOKMARKS = 5000

// 单条估算容量（JSON：id+url+title+favicon+createdAt 约 200-400 字节）
const BOOKMARK_AVG_BYTES = 350

interface BookmarkState {
  items: BookmarkItem[]

  addBookmark: (url: string, title: string, favicon?: string) => void
  removeBookmark: (id: string) => void
  removeByUrl: (url: string) => void
  toggleBookmark: (url: string, title: string, favicon?: string) => boolean
  isBookmarked: (url: string) => boolean
  getByUrl: (url: string) => BookmarkItem | undefined
  updateBookmark: (id: string, updates: Partial<Pick<BookmarkItem, 'title' | 'favicon'>>) => void
  clearAll: () => void
}

type BookmarkPersistState = Pick<BookmarkState, 'items'>

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url)
    let pathname = u.pathname
    if (pathname.length > 1 && pathname.endsWith('/')) {
      pathname = pathname.slice(0, -1)
    }
    return `${u.protocol}//${u.host}${pathname}${u.search}${u.hash}`
  } catch {
    return url
  }
}

export const useBookmarkStore = create<BookmarkState>()(
  persist<BookmarkState, [], [], BookmarkPersistState>(
    (set, get) => ({
      items: [],

      addBookmark: (url, title, favicon) => {
        const normalized = normalizeUrl(url)
        set(state => {
          if (state.items.some(b => normalizeUrl(b.url) === normalized)) return state
          const newItem: BookmarkItem = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            url,
            title: title || url,
            favicon,
            createdAt: Date.now(),
          }
          return { items: [newItem, ...state.items].slice(0, MAX_BOOKMARKS) }
        })
      },

      removeBookmark: (id) => {
        set(state => ({
          items: state.items.filter(b => b.id !== id),
        }))
      },

      removeByUrl: (url) => {
        const normalized = normalizeUrl(url)
        set(state => ({
          items: state.items.filter(b => normalizeUrl(b.url) !== normalized),
        }))
      },

      toggleBookmark: (url, title, favicon) => {
        const normalized = normalizeUrl(url)
        const existing = get().items.find(b => normalizeUrl(b.url) === normalized)
        if (existing) {
          get().removeByUrl(url)
          return false
        }
        get().addBookmark(url, title, favicon)
        return true
      },

      isBookmarked: (url) => {
        const normalized = normalizeUrl(url)
        return get().items.some(b => normalizeUrl(b.url) === normalized)
      },

      getByUrl: (url) => {
        const normalized = normalizeUrl(url)
        return get().items.find(b => normalizeUrl(b.url) === normalized)
      },

      updateBookmark: (id, updates) => {
        set(state => ({
          items: state.items.map(b =>
            b.id === id ? { ...b, ...updates } : b,
          ),
        }))
      },

      clearAll: () => {
        set({ items: [] })
      },
    }),
    withPersistSafety<BookmarkState, BookmarkPersistState>({
      name: PERSIST_KEYS.bookmarks,
      storage: createJSONStorage(() => createMigratingStorage(localStorage, ['agent-bookmarks'])),
      partialize: (state) => ({ items: state.items }),
      version: 1,
      migrate: (persisted: unknown, _version: number): BookmarkPersistState => persisted as BookmarkPersistState,
    }),
  ),
)

registerResetAction('bookmarks', 'reset', () => {
  useBookmarkStore.setState({ items: [] })
})

// ── storage-manager 接入（W2.2 G3）──────────────────────────────
//
// 在 renderer 进程 singleton registry 注册 browser:bookmarks 桶。
// D-5 要求 bookmarks 是 5 个核心可导出资产之一，exportFn 返回 JSON。
//
// 清理支持 itemIds 部分清理（UI 允许勾选单条删除）。
if (!getBucket('browser:bookmarks')) {
  registerStorageBucket({
    id: 'browser:bookmarks',
    category: 'data',
    group: 'browser',
    displayName: '浏览器书签',
    description:
      '浏览器内嵌视图的书签（最多 5000 条）。当前版本不区分账号，仅展示当前视图。',
    warnings: [
      '清理会永久丢失所有书签（无云端备份）',
      '清理前请使用"导出"按钮保留 JSON 备份',
      '导出文件含完整 URL（可能包括 query 参数 / token / sessionId），请妥善保管或在分享前剔除敏感链接',
    ],
    requiresConfirmation: 'hard',
    sizeFn: async () => {
      // 优先读真实 localStorage 字节数；拿不到就回落到估算
      try {
        const raw = localStorage.getItem(PERSIST_KEYS.bookmarks)
        if (raw) {
          const bytes =
            typeof TextEncoder !== 'undefined'
              ? new TextEncoder().encode(raw).length
              : raw.length
          return { bytes, itemCount: useBookmarkStore.getState().items.length }
        }
      } catch {
        /* ignore */
      }
      const items = useBookmarkStore.getState().items
      return { bytes: items.length * BOOKMARK_AVG_BYTES, itemCount: items.length }
    },
    listFn: async () => {
      const items = useBookmarkStore.getState().items
      return items.map((b) => ({
        id: b.id,
        label: b.title || b.url,
        bytes: BOOKMARK_AVG_BYTES,
        metadata: {
          url: b.url,
          favicon: b.favicon,
          createdAt: b.createdAt,
        },
      }))
    },
    clearFn: async (options) => {
      const state = useBookmarkStore.getState()
      const items = state.items
      const targetIds =
        options?.itemIds && options.itemIds.length > 0
          ? new Set(options.itemIds)
          : null
      const targets = targetIds ? items.filter((b) => targetIds.has(b.id)) : items
      const freedBytes = targets.length * BOOKMARK_AVG_BYTES
      const clearedItemCount = targets.length
      if (options?.dryRun) {
        return { clearedItemCount, freedBytes }
      }
      if (targetIds) {
        const kept = items.filter((b) => !targetIds.has(b.id))
        useBookmarkStore.setState({ items: kept })
      } else {
        state.clearAll()
      }
      return { clearedItemCount, freedBytes }
    },
    exportFn: async () => {
      // R1 / R2 增强（W3.3）：导出包封顶层加 metadata（schemaVersion / 来源 /
      // ISO 时间戳 / 总数），每条 bookmark 同时给 createdAt 数字 + addedAtIso
      // ISO 字符串——便于用户在 jq / Excel 里按时间筛选；schemaVersion 让
      // 导入端能区分版本，避免 v2 改格式后旧文件解析炸裂。
      const items = useBookmarkStore.getState().items
      const exportedAt = new Date().toISOString()
      const payload = {
        schemaVersion: 1,
        exportedAt,
        source: 'tabtin-electron',
        bucketId: 'browser:bookmarks',
        itemCount: items.length,
        bookmarks: items.map((b) => ({
          id: b.id,
          url: b.url,
          title: b.title,
          favicon: b.favicon,
          createdAt: b.createdAt,
          addedAtIso: new Date(b.createdAt).toISOString(),
        })),
      }
      const ts = exportedAt.replace(/[:.]/g, '-')
      return {
        filename: `tabtin-bookmarks-${ts}.json`,
        data: JSON.stringify(payload, null, 2),
        mimeType: 'application/json',
      }
    },
  })
}
