/** @store-category session */

/**
 * useClosedTabsStore - 已关闭标签栈
 *
 * 记录最近关闭的标签页，支持 Ctrl+Shift+T 恢复。
 * 支持所有标签类型：tabweb / tabdata / tabdoc / terminal / tabfolder / tabslide 等。
 */

import { create } from 'zustand'
import { registerResetAction } from './sessionResetRegistry'

export interface ClosedTabEntry {
  type: string
  title: string
  closedAt: number
  spaceId: string
  id?: string
  tabKey?: string
  url?: string
  favicon?: string
  meta?: Record<string, unknown>
}

const MAX_CLOSED_TABS = 50

interface ClosedTabsState {
  stack: ClosedTabEntry[]
  push: (entry: Omit<ClosedTabEntry, 'closedAt'>) => void
  pop: (spaceId?: string) => ClosedTabEntry | undefined
  peek: (spaceId?: string) => ClosedTabEntry | undefined
  clear: () => void
}

export const useClosedTabsStore = create<ClosedTabsState>((set, get) => ({
  stack: [],

  push: (entry) => {
    const type = entry.type || 'tabweb'
    if (type === 'tabweb' && (!entry.url || entry.url === 'about:blank')) return
    if (type !== 'tabweb' && !entry.id) return
    set(state => ({
      stack: [
        { ...entry, type, closedAt: Date.now() },
        ...state.stack,
      ].slice(0, MAX_CLOSED_TABS),
    }))
  },

  pop: (spaceId) => {
    const { stack } = get()
    if (stack.length === 0) return undefined

    if (spaceId) {
      const idx = stack.findIndex(e => e.spaceId === spaceId)
      if (idx === -1) return undefined
      const entry = stack[idx]
      set(state => ({
        stack: state.stack.filter((_, i) => i !== idx),
      }))
      return entry
    }

    const [first, ...rest] = stack
    set({ stack: rest })
    return first
  },

  peek: (spaceId) => {
    const { stack } = get()
    if (spaceId) {
      return stack.find(e => e.spaceId === spaceId)
    }
    return stack[0]
  },

  clear: () => set({ stack: [] }),
}))

registerResetAction('closed-tabs', 'reset', () => {
  useClosedTabsStore.setState({ stack: [] })
})
