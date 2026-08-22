/** @store-category prefs */

/**
 * Chat split-pane layout store.
 *
 * Core concept: a "tab group" IS a split layout, just like context-space's
 * CanvasLayoutGroup. When multiple sessions are displayed side-by-side in
 * split panes, they automatically form a visual group in the sidebar.
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
  normalizeSizes,
  findLeafPath,
  updateNodeAtPath,
  insertLeafAtPath,
  removeLeafFromTree,
  collectLeafIds,
} from '@/utils/split-layout'
import { emitSplitEvent } from '@/utils/split-coordinator'
import { registerResetAction } from './sessionResetRegistry'
import { getChatClient } from '@/services/chatApi'

export const MAX_CHAT_PANES = 5

// ────────────────────────────────────────────────────────────
// Data types
// ────────────────────────────────────────────────────────────

export interface ChatPane {
  id: string
  sessionId: string | null
}

/** Per-space split state — this IS the "tab group". */
export interface SpaceChatSplit {
  layout: LayoutNode
  panes: ChatPane[]
  activePaneId: string
}

// ────────────────────────────────────────────────────────────
// Store interface
// ────────────────────────────────────────────────────────────

interface ChatSplitState {
  splitBySpace: Record<string, SpaceChatSplit | null>
  pinnedSessionsBySpace: Record<string, string[]>

  getSplit: (spaceId: string) => SpaceChatSplit | null
  isSplitActive: (spaceId: string) => boolean

  getGroupedSessionIds: (spaceId: string) => Set<string>

  initSinglePane: (spaceId: string, sessionId: string) => void

  splitPane: (
    spaceId: string,
    sessionId: string | null,
    direction?: SplitDirection,
    side?: SplitSide,
  ) => void

  setPaneSession: (spaceId: string, paneId: string, sessionId: string) => void
  closePane: (spaceId: string, paneId: string) => void
  setActivePane: (spaceId: string, paneId: string) => void
  setSplitSizes: (spaceId: string, splitPath: number[], sizes: number[]) => void
  resetSplit: (spaceId: string) => void
  clearSplit: (spaceId: string) => void

  cleanupDeletedSession: (spaceId: string, sessionId: string) => void

  // ── Pinned ──
  getPinnedSessions: (spaceId: string) => string[]
  togglePinSession: (spaceId: string, sessionId: string) => void
  purgeStaleEntries: (validSpaceIds: Set<string>) => void
}

type ChatSplitPersistState = Pick<ChatSplitState, 'splitBySpace' | 'pinnedSessionsBySpace'>

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

const newPaneId = () => createSplitId('cpane')

const makeSinglePane = (sessionId: string): SpaceChatSplit => {
  const id = newPaneId()
  return {
    layout: { type: 'leaf', paneId: id },
    panes: [{ id, sessionId }],
    activePaneId: id,
  }
}

const EMPTY_PINNED: string[] = []
const EMPTY_SET = new Set<string>()
const SIZE_EPSILON = 0.0001

import { isPersistedWorkspaceScopeKey } from '@components/layout/tabScopeRegistry'

const sizesEqual = (a: number[] | undefined, b: number[]): boolean => {
  if (!a || a.length !== b.length) return false
  return a.every((value, index) => Math.abs(value - b[index]) < SIZE_EPSILON)
}

/**
 * Repair layout/panes consistency after rehydration.
 * Returns the original reference if no repair was needed.
 */
const repairChatSplitConsistency = (split: SpaceChatSplit): SpaceChatSplit | null => {
  if (!split.layout || !Array.isArray(split.panes) || split.panes.length === 0) return null

  const layoutPaneIds = new Set(collectLeafIds(split.layout))
  const paneIds = new Set(split.panes.map(p => p.id))

  const orphanLeafIds = [...layoutPaneIds].filter(id => !paneIds.has(id))
  const orphanPanes = split.panes.filter(p => !layoutPaneIds.has(p.id))

  if (orphanLeafIds.length === 0 && orphanPanes.length === 0) {
    const activeOk = split.panes.some(p => p.id === split.activePaneId)
    if (activeOk) return split
    return { ...split, activePaneId: split.panes[0].id }
  }

  if (process.env.NODE_ENV === 'development') {
    console.warn('[ChatSplit] consistency repair', { orphanLeafIds, orphanPaneIds: orphanPanes.map(p => p.id) })
  }

  let nextPanes = [...split.panes]
  for (const orphanId of orphanLeafIds) {
    nextPanes.push({ id: orphanId, sessionId: null })
  }
  nextPanes = nextPanes.filter(p => layoutPaneIds.has(p.id))

  if (nextPanes.length === 0) return null

  const nextActive = nextPanes.some(p => p.id === split.activePaneId)
    ? split.activePaneId
    : nextPanes[0].id

  return { ...split, panes: nextPanes, activePaneId: nextActive }
}

// ────────────────────────────────────────────────────────────
// Store
// ────────────────────────────────────────────────────────────

export const useChatSplitStore = create<ChatSplitState>()(
  persist<ChatSplitState, [], [], ChatSplitPersistState>(
    (set, get) => ({
      splitBySpace: {},
      pinnedSessionsBySpace: {},

      getSplit: (spaceId) => get().splitBySpace[spaceId] ?? null,

      isSplitActive: (spaceId) => {
        const split = get().splitBySpace[spaceId]
        return split !== null && split !== undefined && split.panes.length > 1
      },

      getGroupedSessionIds: (spaceId) => {
        const split = get().splitBySpace[spaceId]
        if (!split || split.panes.length <= 1) return EMPTY_SET
        const ids = new Set<string>()
        for (const pane of split.panes) {
          if (pane.sessionId) ids.add(pane.sessionId)
        }
        return ids
      },

      initSinglePane: (spaceId, sessionId) => {
        set(state => ({
          splitBySpace: {
            ...state.splitBySpace,
            [spaceId]: makeSinglePane(sessionId),
          },
        }))
      },

      splitPane: (spaceId, sessionId, direction = 'horizontal', side = 'right') => {
        set(state => {
          let split = state.splitBySpace[spaceId]
          if (!split) {
            split = makeSinglePane(sessionId ?? '')
          }
          if (split.panes.length >= MAX_CHAT_PANES) return state

          const targetPaneId = split.activePaneId || split.panes[0]?.id
          if (!targetPaneId) return state

          const leafPath = findLeafPath(split.layout, targetPaneId)
          if (!leafPath) return state

          const id = newPaneId()
          const nextLayout = insertLeafAtPath(split.layout, leafPath, id, direction, side)
          const nextPanes: ChatPane[] = [...split.panes, { id, sessionId }]

          return {
            splitBySpace: {
              ...state.splitBySpace,
              [spaceId]: {
                layout: nextLayout,
                panes: nextPanes,
                activePaneId: id,
              },
            },
          }
        })
        emitSplitEvent({ system: 'chat', type: 'split:created', spaceId: spaceId })
      },

      setPaneSession: (spaceId, paneId, sessionId) => {
        set(state => {
          const split = state.splitBySpace[spaceId]
          if (!split) return state

          const nextPanes = split.panes.map(p =>
            p.id === paneId ? { ...p, sessionId } : p,
          )

          return {
            splitBySpace: {
              ...state.splitBySpace,
              [spaceId]: { ...split, panes: nextPanes },
            },
          }
        })
      },

      closePane: (spaceId, paneId) => {
        set(state => {
          const split = state.splitBySpace[spaceId]
          if (!split) return state

          const remaining = split.panes.filter(p => p.id !== paneId)
          if (remaining.length <= 1) {
            const next = { ...state.splitBySpace }
            delete next[spaceId]
            return { splitBySpace: next }
          }

          const nextLayout = removeLeafFromTree(split.layout, paneId)
          const nextActive =
            split.activePaneId === paneId
              ? remaining[0].id
              : split.activePaneId

          return {
            splitBySpace: {
              ...state.splitBySpace,
              [spaceId]: {
                layout: nextLayout,
                panes: remaining,
                activePaneId: nextActive,
              },
            },
          }
        })
        emitSplitEvent({ system: 'chat', type: 'split:pane-closed', spaceId: spaceId })
      },

      setActivePane: (spaceId, paneId) => {
        set(state => {
          const split = state.splitBySpace[spaceId]
          if (!split) return state
          return {
            splitBySpace: {
              ...state.splitBySpace,
              [spaceId]: { ...split, activePaneId: paneId },
            },
          }
        })
        emitSplitEvent({ system: 'chat', type: 'split:active-changed', spaceId: spaceId })
      },

      setSplitSizes: (spaceId, splitPath, sizes) => {
        set(state => {
          const split = state.splitBySpace[spaceId]
          if (!split) return state

          let changed = false
          const nextLayout = updateNodeAtPath(split.layout, splitPath, node => {
            if (node.type !== 'split') return node
            const normalized = normalizeSizes(sizes, node.children.length)
            if (sizesEqual(node.sizes, normalized)) return node
            changed = true
            return { ...node, sizes: normalized }
          })
          if (!changed) return state

          return {
            splitBySpace: {
              ...state.splitBySpace,
              [spaceId]: { ...split, layout: nextLayout },
            },
          }
        })
      },

      cleanupDeletedSession: (spaceId, sessionId) => {
        set((state: ChatSplitState) => {
          const split = state.splitBySpace[spaceId]
          if (!split) return state

          const targetPane = split.panes.find(p => p.sessionId === sessionId)
          if (!targetPane) return state

          const remaining = split.panes.filter(p => p.id !== targetPane.id)
          if (remaining.length <= 1) {
            const next = { ...state.splitBySpace }
            delete next[spaceId]
            return { splitBySpace: next }
          }

          const nextLayout = removeLeafFromTree(split.layout, targetPane.id)
          const nextActive =
            split.activePaneId === targetPane.id
              ? remaining[0].id
              : split.activePaneId

          return {
            splitBySpace: {
              ...state.splitBySpace,
              [spaceId]: {
                layout: nextLayout,
                panes: remaining,
                activePaneId: nextActive,
              },
            },
          }
        })
        emitSplitEvent({ system: 'chat', type: 'split:pane-closed', spaceId: spaceId })
      },

      resetSplit: (spaceId) => {
        set(state => {
          const split = state.splitBySpace[spaceId]
          if (!split) return state

          const keepPane = split.panes.find(p => p.id === split.activePaneId) || split.panes[0]
          if (!keepPane) {
            const next = { ...state.splitBySpace }
            delete next[spaceId]
            return { splitBySpace: next }
          }

          return {
            splitBySpace: {
              ...state.splitBySpace,
              [spaceId]: {
                layout: { type: 'leaf', paneId: keepPane.id },
                panes: [keepPane],
                activePaneId: keepPane.id,
              },
            },
          }
        })
        emitSplitEvent({ system: 'chat', type: 'split:removed', spaceId: spaceId })
      },

      clearSplit: (spaceId) => {
        set(state => {
          const nextSplit = { ...state.splitBySpace }
          delete nextSplit[spaceId]
          const nextPinned = { ...state.pinnedSessionsBySpace }
          delete nextPinned[spaceId]
          return {
            splitBySpace: nextSplit,
            pinnedSessionsBySpace: nextPinned,
          }
        })
        emitSplitEvent({ system: 'chat', type: 'split:removed', spaceId: spaceId })
      },

      // ── Pinned ──

      getPinnedSessions: (spaceId) =>
        get().pinnedSessionsBySpace[spaceId] ?? EMPTY_PINNED,

      togglePinSession: (spaceId, sessionId) => {
        let nextPinned = false
        set(state => {
          const existing = state.pinnedSessionsBySpace[spaceId] ?? EMPTY_PINNED
          const isPinned = existing.includes(sessionId)
          nextPinned = !isPinned
          return {
            pinnedSessionsBySpace: {
              ...state.pinnedSessionsBySpace,
              [spaceId]: isPinned
                ? existing.filter(id => id !== sessionId)
                : [...existing, sessionId],
            },
          }
        })
        void getChatClient().sessions.update(sessionId, { is_pinned: nextPinned }).catch(() => {
          set(state => {
            const existing = state.pinnedSessionsBySpace[spaceId] ?? EMPTY_PINNED
            if (existing.includes(sessionId) !== nextPinned) return state
            return {
              pinnedSessionsBySpace: {
                ...state.pinnedSessionsBySpace,
                [spaceId]: nextPinned
                  ? existing.filter(id => id !== sessionId)
                  : [...existing, sessionId],
              },
            }
          })
        })
      },

      purgeStaleEntries: (validSpaceIds: Set<string>) => {
        set(state => {
          const filterRecord = <V,>(record: Record<string, V>): Record<string, V> => {
            const next: Record<string, V> = {}
            for (const [key, value] of Object.entries(record)) {
              if (validSpaceIds.has(key) || isPersistedWorkspaceScopeKey(key)) next[key] = value
            }
            return next
          }
          const prevCount = Object.keys(state.splitBySpace).length +
            Object.keys(state.pinnedSessionsBySpace).length
          const nextSplit = filterRecord(state.splitBySpace)
          const nextPinned = filterRecord(state.pinnedSessionsBySpace)
          const nextCount = Object.keys(nextSplit).length + Object.keys(nextPinned).length
          if (prevCount === nextCount) return state
          console.log(`[ChatSplitStore] purged ${prevCount - nextCount} stale space entries`)
          return {
            splitBySpace: nextSplit,
            pinnedSessionsBySpace: nextPinned,
          }
        })
      },
    }),
    withPersistSafety({
      name: PERSIST_KEYS.chatSplit,
      storage: createJSONStorage(() => createMigratingStorage(localStorage, ['chat-split-layout'])),
      partialize: (state) => ({
        splitBySpace: state.splitBySpace,
        pinnedSessionsBySpace: state.pinnedSessionsBySpace,
      }),
      merge: (persisted: unknown, currentState: ChatSplitState): ChatSplitState => {
        const persistedState = (persisted || {}) as Partial<ChatSplitPersistState>
        const rawSplits = persistedState.splitBySpace || {}
        const repairedSplits: Record<string, SpaceChatSplit | null> = {}
        for (const [spaceId, split] of Object.entries(rawSplits)) {
          if (!split) { repairedSplits[spaceId] = null; continue }
          const fixed = repairChatSplitConsistency(split)
          if (!fixed) continue
          repairedSplits[spaceId] = fixed
        }
        return {
          ...currentState,
          splitBySpace: repairedSplits,
          pinnedSessionsBySpace: persistedState.pinnedSessionsBySpace || {},
        }
      },
      version: 1,
      migrate: ((persistedState: unknown, version: number) => {
        const state = (persistedState ?? {}) as Record<string, unknown>
        if (version < 1) {
          if (state.splitByProject && !state.splitBySpace) {
            state.splitBySpace = state.splitByProject
            delete state.splitByProject
          }
          if (state.pinnedSessionsByProject && !state.pinnedSessionsBySpace) {
            state.pinnedSessionsBySpace = state.pinnedSessionsByProject
            delete state.pinnedSessionsByProject
          }
        }
        return state as ChatSplitPersistState
      }) as any,
    }),
  ),
)

registerResetAction('chat-split', 'reset', () => { useChatSplitStore.setState({ splitBySpace: {}, pinnedSessionsBySpace: {} }) })
