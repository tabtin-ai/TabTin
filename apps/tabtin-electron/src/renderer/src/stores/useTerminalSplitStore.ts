/** @store-category prefs */

/**
 * Terminal split-pane layout store.
 *
 * Manages per-tab split layouts for terminal panes. Each root terminal tab
 * (identified by its sessionId) can be split into multiple PTY panes arranged
 * in an arbitrary tree layout.
 *
 * Reuses the shared tree layout utilities from `utils/split-layout.ts`.
 */

import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { createMigratingStorage, withPersistSafety } from '@tabtin/shared'
import { PERSIST_KEYS } from './persist-key-registry'
import {
  type LayoutNode,
  type SplitDirection,
  type SplitSide,
  createSplitId,
  buildSizes,
  normalizeSizes,
  findLeafPath,
  updateNodeAtPath,
  insertLeafAtPath,
  removeLeafFromTree,
  collectLeafIds,
} from '@/utils/split-layout'
import { registerResetAction } from './sessionResetRegistry'

const MAX_TERMINAL_PANES = 6

// ────────────────────────────────────────────────────────────
// Data types
// ────────────────────────────────────────────────────────────

export interface TerminalSplitPane {
  id: string        // paneId
  sessionId: string // PTY session ID
}

export interface TerminalSplitLayout {
  rootSessionId: string
  spaceId: string
  layout: LayoutNode
  panes: Record<string, TerminalSplitPane>
  activePaneId: string
  maximizedPaneId: string | null
}

// ────────────────────────────────────────────────────────────
// Store interface
// ────────────────────────────────────────────────────────────

interface TerminalSplitState {
  layouts: Record<string, TerminalSplitLayout>

  // 查询
  getLayout: (rootSessionId: string) => TerminalSplitLayout | null
  getPaneCount: (rootSessionId: string) => number

  // 初始化
  ensureLayout: (rootSessionId: string, spaceId: string) => void

  // 分屏操作
  splitPane: (
    rootSessionId: string,
    targetPaneId: string,
    direction: SplitDirection,
    side: SplitSide,
    newSessionId: string,
  ) => string | null

  // 关闭
  closePane: (rootSessionId: string, paneId: string) => void

  // 布局尺寸
  setSplitSizes: (rootSessionId: string, splitPath: number[], sizes: number[]) => void

  // 焦点
  setActivePane: (rootSessionId: string, paneId: string) => void

  // 均分
  equalizeSizes: (rootSessionId: string, splitPath: number[]) => void
  equalizeAllSizes: (rootSessionId: string) => void

  // 最大化/还原
  toggleMaximize: (rootSessionId: string, paneId: string) => void

  // 清理
  removeLayout: (rootSessionId: string) => void
  clearSpaceLayouts: (spaceId: string) => void
  rehomeScopeLayouts: (fromScopeKey: string, toScopeKey: string) => number
}

type TerminalSplitPersistState = Pick<TerminalSplitState, 'layouts'>

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

const newPaneId = () => createSplitId('tsp')

const createDefaultLayout = (rootSessionId: string, spaceId: string): TerminalSplitLayout => {
  const paneId = newPaneId()
  return {
    rootSessionId,
    spaceId,
    layout: { type: 'leaf', paneId },
    panes: { [paneId]: { id: paneId, sessionId: rootSessionId } },
    activePaneId: paneId,
    maximizedPaneId: null,
  }
}

/** Repair layout/panes consistency after rehydration. */
const repairConsistency = (entry: TerminalSplitLayout): TerminalSplitLayout | null => {
  if (!entry.layout || !entry.panes) return null

  const layoutIds = new Set(collectLeafIds(entry.layout))
  const paneIds = new Set(Object.keys(entry.panes))

  if (layoutIds.size === 0) return null

  // 同步 panes 与 layout 树
  let panes = { ...entry.panes }
  let layout = entry.layout
  let dirty = false

  // layout 中存在但 panes map 中缺失 → 从 layout 树中移除该 leaf
  for (const id of layoutIds) {
    if (!paneIds.has(id)) {
      layout = removeLeafFromTree(layout, id)
      dirty = true
    }
  }

  // panes map 中存在但 layout 中无对应 leaf → 移除
  for (const id of paneIds) {
    if (!layoutIds.has(id)) {
      delete panes[id]
      dirty = true
    }
  }

  // 修剪后重新检查 layout 有效性
  const repairedLeafIds = collectLeafIds(layout)
  if (repairedLeafIds.length === 0) return null

  // 验证所有 pane 的 sessionId 有效性
  for (const pane of Object.values(panes)) {
    if (!pane.sessionId) return null
  }

  const activePaneOk = new Set(repairedLeafIds).has(entry.activePaneId)
  const firstLeaf = repairedLeafIds[0]
  const maximizedOk = entry.maximizedPaneId === null || new Set(repairedLeafIds).has(entry.maximizedPaneId)

  if (!dirty && activePaneOk && maximizedOk) return entry

  return {
    ...entry,
    layout,
    panes,
    activePaneId: activePaneOk ? entry.activePaneId : firstLeaf,
    maximizedPaneId: maximizedOk ? entry.maximizedPaneId : null,
  }
}

/** Recursively equalize all split node sizes in a layout tree. */
const equalizeTree = (node: LayoutNode): LayoutNode => {
  if (node.type === 'leaf') return node
  const n = node.children.length
  return {
    ...node,
    sizes: buildSizes(n),
    children: node.children.map(equalizeTree),
  }
}

/** Immutable update helper for a single layout entry. */
const withLayoutUpdate = (
  layouts: Record<string, TerminalSplitLayout>,
  rootSessionId: string,
  updater: (entry: TerminalSplitLayout) => TerminalSplitLayout | null,
): { layouts: Record<string, TerminalSplitLayout> } | null => {
  const entry = layouts[rootSessionId]
  if (!entry) return null
  const next = updater(entry)
  if (!next) return null
  return { layouts: { ...layouts, [rootSessionId]: next } }
}

// ────────────────────────────────────────────────────────────
// Store
// ────────────────────────────────────────────────────────────

export const useTerminalSplitStore = create<TerminalSplitState>()(
  persist<TerminalSplitState, [], [], TerminalSplitPersistState>(
    (set, get) => ({
      layouts: {},

      // ── 查询 ──

      getLayout: (rootSessionId) => get().layouts[rootSessionId] ?? null,

      getPaneCount: (rootSessionId) => {
        const entry = get().layouts[rootSessionId]
        if (!entry) return 0
        return Object.keys(entry.panes).length
      },

      // ── 初始化 ──

      ensureLayout: (rootSessionId, spaceId) => {
        if (get().layouts[rootSessionId]) return
        set(state => ({
          layouts: {
            ...state.layouts,
            [rootSessionId]: createDefaultLayout(rootSessionId, spaceId),
          },
        }))
      },

      // ── 分屏 ──

      splitPane: (rootSessionId, targetPaneId, direction, side, newSessionId) => {
        const entry = get().layouts[rootSessionId]
        if (!entry) return null
        if (Object.keys(entry.panes).length >= MAX_TERMINAL_PANES) return null

        const leafPath = findLeafPath(entry.layout, targetPaneId)
        if (!leafPath) return null

        const paneId = newPaneId()
        set(state => ({
          layouts: {
            ...state.layouts,
            [rootSessionId]: {
              ...entry,
              layout: insertLeafAtPath(entry.layout, leafPath, paneId, direction, side),
              panes: { ...entry.panes, [paneId]: { id: paneId, sessionId: newSessionId } },
              activePaneId: paneId,
              maximizedPaneId: null, // 分屏时自动退出最大化
            },
          },
        }))
        return paneId
      },

      // ── 关闭 ──

      closePane: (rootSessionId, paneId) => {
        set(state => {
          const entry = state.layouts[rootSessionId]
          if (!entry) return state

          const nextPanes = { ...entry.panes }
          delete nextPanes[paneId]

          const remaining = Object.keys(nextPanes)
          if (remaining.length === 0) {
            const next = { ...state.layouts }
            delete next[rootSessionId]
            return { layouts: next }
          }

          const nextLayout = removeLeafFromTree(entry.layout, paneId)
          const nextActive = entry.activePaneId === paneId
            ? collectLeafIds(nextLayout)[0]
            : entry.activePaneId
          // 关闭已最大化的 pane → 自动最大化下一个 pane，保持焦点连贯
          const nextMaximized = entry.maximizedPaneId === paneId
            ? (remaining.length > 0 ? remaining[0] : null)
            : entry.maximizedPaneId

          return {
            layouts: {
              ...state.layouts,
              [rootSessionId]: {
                ...entry,
                layout: nextLayout,
                panes: nextPanes,
                activePaneId: nextActive,
                maximizedPaneId: nextMaximized,
              },
            },
          }
        })
      },

      // ── 尺寸 ──

      setSplitSizes: (rootSessionId, splitPath, sizes) => {
        set(state =>
          withLayoutUpdate(state.layouts, rootSessionId, (entry) => ({
            ...entry,
            layout: updateNodeAtPath(entry.layout, splitPath, node => {
              if (node.type !== 'split') return node
              return { ...node, sizes: normalizeSizes(sizes, node.children.length) }
            }),
          })) ?? state,
        )
      },

      // ── 均分 ──

      equalizeSizes: (rootSessionId, splitPath) => {
        set(state =>
          withLayoutUpdate(state.layouts, rootSessionId, (entry) => ({
            ...entry,
            layout: updateNodeAtPath(entry.layout, splitPath, node => {
              if (node.type !== 'split') return node
              return { ...node, sizes: buildSizes(node.children.length) }
            }),
          })) ?? state,
        )
      },

      equalizeAllSizes: (rootSessionId) => {
        set(state =>
          withLayoutUpdate(state.layouts, rootSessionId, (entry) => ({
            ...entry,
            layout: equalizeTree(entry.layout),
          })) ?? state,
        )
      },

      // ── 焦点 ──

      setActivePane: (rootSessionId, paneId) => {
        set(state =>
          withLayoutUpdate(state.layouts, rootSessionId, (entry) => ({
            ...entry,
            activePaneId: paneId,
          })) ?? state,
        )
      },

      // ── 最大化 ──

      toggleMaximize: (rootSessionId, paneId) => {
        set(state =>
          withLayoutUpdate(state.layouts, rootSessionId, (entry) => ({
            ...entry,
            maximizedPaneId: entry.maximizedPaneId === paneId ? null : paneId,
          })) ?? state,
        )
      },

      // ── 清理 ──

      removeLayout: (rootSessionId) => {
        set(state => {
          const next = { ...state.layouts }
          delete next[rootSessionId]
          return { layouts: next }
        })
      },

      clearSpaceLayouts: (spaceId) => {
        set(state => {
          const next: Record<string, TerminalSplitLayout> = {}
          for (const [key, entry] of Object.entries(state.layouts)) {
            if (entry.spaceId !== spaceId) next[key] = entry
          }
          return { layouts: next }
        })
      },

      rehomeScopeLayouts: (fromScopeKey, toScopeKey) => {
        if (!fromScopeKey || !toScopeKey || fromScopeKey === toScopeKey) return 0
        let moved = 0
        set((state) => {
          const layouts = Object.fromEntries(Object.entries(state.layouts).map(([id, layout]) => {
            if (layout.spaceId !== fromScopeKey) return [id, layout]
            moved += 1
            return [id, { ...layout, spaceId: toScopeKey }]
          }))
          return moved ? { layouts } : state
        })
        return moved
      },
    }),
    withPersistSafety<TerminalSplitState, TerminalSplitPersistState>({
      name: PERSIST_KEYS.terminalSplit,
      storage: createJSONStorage(() => createMigratingStorage(localStorage, ['terminal-split-layout'])),
      partialize: (state) => ({ layouts: state.layouts }),
      version: 1,
      migrate: (persisted: unknown, _version: number): TerminalSplitPersistState => persisted as TerminalSplitPersistState,
      merge: (persisted: unknown, currentState: TerminalSplitState): TerminalSplitState => {
        const raw = ((persisted || {}) as Partial<TerminalSplitPersistState>).layouts || {}
        const repairedLayouts: Record<string, TerminalSplitLayout> = {}
        for (const [key, entry] of Object.entries(raw)) {
          if (!entry) continue
          const fixed = repairConsistency(entry)
          if (fixed) repairedLayouts[key] = fixed
        }
        return { ...currentState, layouts: repairedLayouts }
      },
    }),
  ),
)

registerResetAction('terminal-split', 'reset', () => {
  useTerminalSplitStore.setState({ layouts: {} })
})
