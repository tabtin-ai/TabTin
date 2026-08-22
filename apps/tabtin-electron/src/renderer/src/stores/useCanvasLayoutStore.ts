/** @store-category prefs */

import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { createMigratingStorage, withPersistSafety } from '@tabtin/shared'
import { PERSIST_KEYS } from './persist-key-registry'
import { registerResetAction } from './sessionResetRegistry'
import { traceTabRestore } from '@/utils/tabRestoreTrace'
import {
  type SplitSide,
  buildSizes,
  normalizeSizes,
  findLeafPath,
  updateNodeAtPath,
  insertLeafAtPath,
  removeLeafFromTree,
} from '@/utils/split-layout'
import {
  MAX_PANES_PER_GROUP,
  EMPTY_CANVAS_GROUPS,
  createId,
  findGroupById,
  ensureLayout,
  repairGroupConsistency,
  withGroupUpdate,
  emitCanvasEvent,
} from './canvasLayout/helpers'
import { migrateCanvasLayout } from './canvasLayout/migration'
import { buildCanvasLayoutSignature } from './workbenchRestoreSignature'
import type {
  CanvasTabKey,
  CanvasPaneContent,
  CanvasLayoutDirection,
  CanvasLayoutNode,
  CanvasLayoutGroup,
} from './canvasLayout/types'

export type {
  CanvasTabKey,
  CanvasPaneContent,
  CanvasLayoutDirection,
  CanvasLayoutNode,
  CanvasPane,
  CanvasLayoutGroup,
} from './canvasLayout/types'

interface CanvasLayoutState {
  spaceGroups: Record<string, CanvasLayoutGroup[]>
  getSpaceGroups: (spaceId: string) => CanvasLayoutGroup[]
  getGroupById: (spaceId: string, groupId: string) => CanvasLayoutGroup | null
  findGroupByTabKey: (spaceId: string, tabKey: CanvasTabKey) => CanvasLayoutGroup | null
  createGroup: (
    spaceId: string,
    anchorTabKey: CanvasTabKey,
    initialContent: CanvasPaneContent,
    direction?: CanvasLayoutDirection,
    emptySide?: SplitSide,
  ) => CanvasLayoutGroup
  splitActivePane: (
    spaceId: string, groupId: string,
    direction: CanvasLayoutDirection, side: SplitSide,
  ) => void
  assignPaneContent: (
    spaceId: string, groupId: string,
    paneId: string, content: CanvasPaneContent,
  ) => void
  movePane: (
    spaceId: string, groupId: string,
    sourcePaneId: string, targetPaneId: string, side: SplitSide,
  ) => void
  dockPaneToOuter: (
    spaceId: string, groupId: string,
    paneId: string, side: SplitSide,
  ) => void
  splitPaneWithContent: (
    spaceId: string, groupId: string, targetPaneId: string,
    direction: CanvasLayoutDirection, side: SplitSide, content: CanvasPaneContent,
  ) => boolean
  removeGroup: (spaceId: string, groupId: string) => void
  setSplitSizes: (spaceId: string, groupId: string, splitPath: number[], sizes: number[]) => void
  closePane: (spaceId: string, groupId: string, paneId: string) => void
  closeTabEverywhere: (tabKey: string) => void
  setActivePane: (spaceId: string, groupId: string, paneId: string) => void
  applyRestoreDecision: (
    spaceId: string,
    groups: CanvasLayoutGroup[],
    baseSignature: string,
  ) => boolean
  clearSpaceLayout: (spaceId: string) => void
  purgeStaleEntries: (validSpaceIds: Set<string>) => void
}

type CanvasLayoutPersistState = Pick<CanvasLayoutState, 'spaceGroups'>

import { isPersistedWorkspaceScopeKey } from '@components/layout/tabScopeRegistry'

const summarizeCanvasLayoutPersistState = (state: Partial<CanvasLayoutPersistState>) => ({
  spaces: Object.entries(state.spaceGroups ?? {}).map(([spaceId, groups]) => ({
    spaceId,
    groups: Array.isArray(groups)
      ? groups.map(group => {
        const panes = Array.isArray(group.panes) ? group.panes : []
        return {
          id: group.id,
          anchorTabKey: group.anchorTabKey,
          activePaneId: group.activePaneId,
          paneCount: panes.length,
          panes: panes.map(pane => ({
            id: pane.id,
            tabKey: pane.content?.tabKey ?? null,
          })),
        }
      })
      : [],
  })),
})

export const useCanvasLayoutStore = create<CanvasLayoutState>()(
  persist<CanvasLayoutState, [], [], CanvasLayoutPersistState>(
    (set, get) => ({
      spaceGroups: {},

      getSpaceGroups: (spaceId) =>
        get().spaceGroups[spaceId] ?? EMPTY_CANVAS_GROUPS,

      getGroupById: (spaceId, groupId) =>
        findGroupById(get().spaceGroups[spaceId] ?? EMPTY_CANVAS_GROUPS, groupId),

      findGroupByTabKey: (spaceId, tabKey) =>
        (get().spaceGroups[spaceId] ?? EMPTY_CANVAS_GROUPS)
          .find(g => g.panes.some(p => p.content?.tabKey === tabKey)) || null,

      createGroup: (spaceId, anchorTabKey, initialContent, direction = 'horizontal', emptySide = 'right') => {
        const now = Date.now()
        const primaryPaneId = createId('pane')
        const emptyPaneId = createId('pane')
        const placeEmptyFirst = emptySide === 'left' || emptySide === 'top'
        const panes = placeEmptyFirst
          ? [{ id: emptyPaneId, content: null }, { id: primaryPaneId, content: initialContent }]
          : [{ id: primaryPaneId, content: initialContent }, { id: emptyPaneId, content: null }]
        const layout: CanvasLayoutNode = {
          type: 'split',
          id: createId('split'),
          direction,
          children: [{ type: 'leaf', paneId: panes[0].id }, { type: 'leaf', paneId: panes[1].id }],
          sizes: buildSizes(2),
        }
        const group: CanvasLayoutGroup = {
          id: createId('group'), spaceId, anchorTabKey, panes, layout,
          activePaneId: primaryPaneId, createdAt: now, updatedAt: now,
        }
        set(state => ({
          spaceGroups: {
            ...state.spaceGroups,
            [spaceId]: [...(state.spaceGroups[spaceId] ?? EMPTY_CANVAS_GROUPS), group],
          },
        }))
        traceTabRestore('canvasLayout:createGroup', {
          spaceId,
          groupId: group.id,
          anchorTabKey,
          activePaneId: group.activePaneId,
          panes: group.panes.map(pane => ({ id: pane.id, tabKey: pane.content?.tabKey ?? null })),
        })
        emitCanvasEvent(spaceId, 'split:created')
        return group
      },

      splitActivePane: (spaceId, groupId, direction, side) => {
        set(state => withGroupUpdate(state.spaceGroups, spaceId, groupId, (group) => {
          if (group.panes.length >= MAX_PANES_PER_GROUP) return null
          const activePaneId = group.activePaneId || group.panes[0]?.id
          if (!activePaneId) return null
          const layoutRoot = ensureLayout(group)
          const leafPath = findLeafPath(layoutRoot, activePaneId)
          if (!leafPath) return null
          const newPaneId = createId('pane')
          return {
            ...group,
            panes: [...group.panes, { id: newPaneId, content: null }],
            layout: insertLeafAtPath(layoutRoot, leafPath, newPaneId, direction, side),
            updatedAt: Date.now(),
          }
        }) ?? state)
      },

      assignPaneContent: (spaceId, groupId, paneId, content) => {
        set(state => withGroupUpdate(state.spaceGroups, spaceId, groupId, (group) => {
          const oldPane = group.panes.find(p => p.id === paneId)
          let replacedPaneId: string | null = null
          const nextPanes = group.panes.map(pane => {
            if (pane.content?.tabKey === content.tabKey) {
              replacedPaneId = pane.id
              return { ...pane, content: null }
            }
            return pane.id === paneId ? { ...pane, content } : pane
          })
          let nextAnchor = group.anchorTabKey
          const anchorLost =
            oldPane?.content?.tabKey === group.anchorTabKey ||
            (replacedPaneId != null &&
              group.panes.find(p => p.id === replacedPaneId)?.content?.tabKey === group.anchorTabKey)
          if (anchorLost) nextAnchor = content.tabKey
          return {
            ...group,
            panes: nextPanes,
            anchorTabKey: nextAnchor,
            activePaneId: paneId,
            updatedAt: Date.now(),
          }
        }) ?? state)
        traceTabRestore('canvasLayout:assignPaneContent', {
          spaceId,
          groupId,
          paneId,
          tabKey: content.tabKey,
        })
      },

      movePane: (spaceId, groupId, sourcePaneId, targetPaneId, side) => {
        set(state => withGroupUpdate(state.spaceGroups, spaceId, groupId, (group) => {
          if (sourcePaneId === targetPaneId) return null
          if (!group.panes.some(p => p.id === sourcePaneId)) return null
          if (!group.panes.some(p => p.id === targetPaneId)) return null
          const direction: CanvasLayoutDirection =
            (side === 'top' || side === 'bottom') ? 'vertical' : 'horizontal'
          const layoutRoot = ensureLayout(group)
          const layoutWithoutSource = removeLeafFromTree(layoutRoot, sourcePaneId)
          const targetPath = findLeafPath(layoutWithoutSource, targetPaneId)
          if (!targetPath) return null
          return {
            ...group,
            layout: insertLeafAtPath(layoutWithoutSource, targetPath, sourcePaneId, direction, side),
            updatedAt: Date.now(),
          }
        }) ?? state)
        emitCanvasEvent(spaceId, 'split:layout-changed')
      },

      dockPaneToOuter: (spaceId, groupId, paneId, side) => {
        set(state => withGroupUpdate(state.spaceGroups, spaceId, groupId, (group) => {
          if (!group.panes.some(p => p.id === paneId)) return null
          const remainingLayout = removeLeafFromTree(ensureLayout(group), paneId)
          const direction: CanvasLayoutDirection =
            (side === 'top' || side === 'bottom') ? 'vertical' : 'horizontal'
          const placeBefore = side === 'left' || side === 'top'
          return {
            ...group,
            layout: {
              type: 'split',
              id: createId('split'),
              direction,
              children: placeBefore
                ? [{ type: 'leaf', paneId }, remainingLayout]
                : [remainingLayout, { type: 'leaf', paneId }],
              sizes: placeBefore ? [1 / 3, 2 / 3] : [2 / 3, 1 / 3],
            },
            updatedAt: Date.now(),
          }
        }) ?? state)
      },

      splitPaneWithContent: (spaceId, groupId, targetPaneId, direction, side, content) => {
        let didSplit = false
        set(state => withGroupUpdate(state.spaceGroups, spaceId, groupId, (group) => {
          if (group.panes.length >= MAX_PANES_PER_GROUP) return null
          if (group.panes.some(p => p.content?.tabKey === content.tabKey)) return null
          const layoutRoot = ensureLayout(group)
          const targetPath = findLeafPath(layoutRoot, targetPaneId)
          if (!targetPath) return null
          const newPaneId = createId('pane')
          didSplit = true
          return {
            ...group,
            panes: [...group.panes, { id: newPaneId, content }],
            layout: insertLeafAtPath(layoutRoot, targetPath, newPaneId, direction, side),
            activePaneId: newPaneId,
            updatedAt: Date.now(),
          }
        }) ?? state)
        if (didSplit) {
          emitCanvasEvent(spaceId, 'split:layout-changed')
        }
        return didSplit
      },

      removeGroup: (spaceId, groupId) => {
        set(state => ({
          spaceGroups: {
            ...state.spaceGroups,
            [spaceId]: (state.spaceGroups[spaceId] ?? EMPTY_CANVAS_GROUPS)
              .filter(item => item.id !== groupId),
          },
        }))
        emitCanvasEvent(spaceId, 'split:removed')
      },

      setSplitSizes: (spaceId, groupId, splitPath, sizes) => {
        set(state => withGroupUpdate(state.spaceGroups, spaceId, groupId, (group) => {
          const nextLayout = updateNodeAtPath(ensureLayout(group), splitPath, (node) => {
            if (node.type !== 'split') return node
            return { ...node, sizes: normalizeSizes(sizes, node.children.length) }
          })
          return { ...group, layout: nextLayout, updatedAt: Date.now() }
        }) ?? state)
      },

      closePane: (spaceId, groupId, paneId) => {
        set(state => {
          const groups = state.spaceGroups[spaceId] ?? EMPTY_CANVAS_GROUPS
          const group = findGroupById(groups, groupId)
          if (!group) return state

          const closedPane = group.panes.find(p => p.id === paneId)
          const nextPanes = group.panes.filter(p => p.id !== paneId)
          const nextContentPane = nextPanes.find(p => p.content?.tabKey)
          const nextContentTabKey = nextContentPane?.content?.tabKey

          if (nextPanes.length === 0 || !nextContentPane || !nextContentTabKey) {
            return {
              spaceGroups: {
                ...state.spaceGroups,
                [spaceId]: groups.filter(item => item.id !== groupId),
              },
            }
          }

          let nextAnchor = group.anchorTabKey
          if (closedPane?.content?.tabKey === group.anchorTabKey) {
            nextAnchor = nextContentTabKey
          }
          const activePaneStillHasContent = nextPanes.some(
            pane => pane.id === group.activePaneId && Boolean(pane.content?.tabKey),
          )

          return {
            spaceGroups: {
              ...state.spaceGroups,
              [spaceId]: groups.map(item => (item.id === groupId ? {
                ...group,
                panes: nextPanes,
                layout: removeLeafFromTree(ensureLayout(group), paneId),
                anchorTabKey: nextAnchor,
                activePaneId: activePaneStillHasContent ? group.activePaneId : nextContentPane.id,
                updatedAt: Date.now(),
              } : item)),
            },
          }
        })
        emitCanvasEvent(spaceId, 'split:pane-closed')
      },

      closeTabEverywhere: (tabKey) => {
        if (!tabKey) return
        const groupsByScope = get().spaceGroups
        for (const [scopeKey, groups] of Object.entries(groupsByScope)) {
          for (const group of groups) {
            const pane = group.panes.find(item => item.content?.tabKey === tabKey)
            if (!pane) continue
            get().closePane(scopeKey, group.id, pane.id)
          }
        }
      },

      setActivePane: (spaceId, groupId, paneId) => {
        set(state =>
          withGroupUpdate(state.spaceGroups, spaceId, groupId, (group) =>
            ({ ...group, activePaneId: paneId, updatedAt: Date.now() }),
          ) ?? state,
        )
        traceTabRestore('canvasLayout:setActivePane', { spaceId, groupId, paneId })
      },

      applyRestoreDecision: (spaceId, groups, baseSignature) => {
        const repairedGroups = groups
          .filter(group => Array.isArray(group.panes) && group.panes.length > 0)
          .map(group => repairGroupConsistency(group, spaceId))

        let applied = false
        set(state => {
          const currentGroups = state.spaceGroups[spaceId] ?? EMPTY_CANVAS_GROUPS
          const currentSignature = buildCanvasLayoutSignature(currentGroups)
          if (currentSignature !== baseSignature) {
            console.warn('[canvasLayout.applyRestoreDecision] signature-mismatch (skipped)', {
              spaceId: spaceId.slice(0, 8),
              base: baseSignature.slice(0, 80),
              cur: currentSignature.slice(0, 80),
            })
            traceTabRestore('canvasLayout:applyRestoreDecision:signatureMismatch', {
              spaceId,
              expected: baseSignature,
              actual: currentSignature,
            })
            return state
          }
          const nextSignature = buildCanvasLayoutSignature(repairedGroups)
          if (nextSignature === currentSignature) {
            console.warn('[canvasLayout.applyRestoreDecision] noop-idempotent', {
              spaceId: spaceId.slice(0, 8),
              groupCount: repairedGroups.length,
            })
            applied = true
            return state
          }

          console.warn('[canvasLayout.applyRestoreDecision] applying', {
            spaceId: spaceId.slice(0, 8),
            from: currentSignature.slice(0, 80),
            to: nextSignature.slice(0, 80),
            groupCount: repairedGroups.length,
          })
          applied = true
          traceTabRestore('canvasLayout:applyRestoreDecision', {
            spaceId,
            groups: repairedGroups.map(group => ({
              id: group.id,
              activePaneId: group.activePaneId,
              anchorTabKey: group.anchorTabKey,
              panes: group.panes.map(pane => ({
                id: pane.id,
                tabKey: pane.content?.tabKey ?? null,
              })),
            })),
          })
          return {
            spaceGroups: {
              ...state.spaceGroups,
              [spaceId]: repairedGroups,
            },
          }
        })
        return applied
      },

      clearSpaceLayout: (spaceId) => {
        set(state => {
          const next = { ...state.spaceGroups }
          delete next[spaceId]
          return { spaceGroups: next }
        })
        emitCanvasEvent(spaceId, 'split:removed')
      },

      purgeStaleEntries: (validSpaceIds) => {
        set(state => {
          const next: Record<string, CanvasLayoutGroup[]> = {}
          let purged = 0
          for (const [key, groups] of Object.entries(state.spaceGroups)) {
            if (validSpaceIds.has(key) || isPersistedWorkspaceScopeKey(key)) next[key] = groups
            else purged++
          }
          if (purged === 0) return state
          console.log(`[CanvasLayoutStore] purged ${purged} stale space layout entries`)
          return { spaceGroups: next }
        })
      },
    }),
    withPersistSafety({
      name: PERSIST_KEYS.canvasLayout,
      storage: createJSONStorage(() => createMigratingStorage(localStorage, ['canvas-layout'])),
      partialize: (state) => {
        const persisted = { spaceGroups: state.spaceGroups }
        traceTabRestore('canvasLayout:partialize', summarizeCanvasLayoutPersistState(persisted))
        return persisted
      },
      version: 1,
      migrate: migrateCanvasLayout as any,
      merge: (persisted: unknown, currentState: CanvasLayoutState): CanvasLayoutState => {
        const raw = ((persisted || {}) as Partial<CanvasLayoutPersistState>).spaceGroups || {}
        traceTabRestore('canvasLayout:merge:start', summarizeCanvasLayoutPersistState({ spaceGroups: raw }))
        const repairedGroups: Record<string, CanvasLayoutGroup[]> = {}
        for (const [spaceId, groups] of Object.entries(raw)) {
          if (Array.isArray(groups)) {
            // D-W4-2/A + 选项 C：0 pane group 是极端崩溃窗口产物（set() 后 persist flush 前），
            // 不具备有效状态，在 rehydrate 时直接丢弃而非交给 repair 函数处理。
            repairedGroups[spaceId] = groups
              .filter(group => Array.isArray(group.panes) && group.panes.length > 0)
              .map(group => repairGroupConsistency(group, spaceId))
          }
        }
        traceTabRestore('canvasLayout:merge:repaired', summarizeCanvasLayoutPersistState({ spaceGroups: repairedGroups }))
        return { ...currentState, spaceGroups: repairedGroups }
      },
    }),
  ),
)

registerResetAction('canvas-layout', 'reset', () => { useCanvasLayoutStore.setState({ spaceGroups: {} }) })
