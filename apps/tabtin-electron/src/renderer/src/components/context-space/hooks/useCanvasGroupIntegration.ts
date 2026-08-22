import { useCallback, useEffect, useMemo } from 'react'
import { contextRegistry, type ContextItem, type ContextTabKey } from '../registry'
import { useCanvasLayoutStore, type CanvasTabKey, type CanvasLayoutGroup } from '@stores/useCanvasLayoutStore'
import { findGroupForTabKey } from '../utils/canvasLayout'
import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'
import type { CrawlspaceViewInfo } from '@stores/useCrawlTabStore'
import { traceTabRestore } from '@/utils/tabRestoreTrace'
import {
  deriveContextVisibleCanvasGroups,
  hasHiddenPersistentCanvasPanes,
} from '../utils/contextVisibleCanvasGroups'

interface CanvasGroupIntegrationParams {
  spaceId: string
  tabScopeKey?: string
  activeTabKey: string | null
  activeTabType: string
  safeSpaceGroups: CanvasLayoutGroup[]
  contextItemByTabKey: Map<string, ContextItem>
  currentTabKeys: ContextTabKey[]
  contextVisibleTabKeys: ContextTabKey[]
  browserViewList: CrawlspaceViewInfo[]
  setTabOrder: (orderedKeys: string[]) => void
  isForeground: boolean
}

interface CanvasGroupIntegrationResult {
  groupedTableIds: Set<string>
  groupedTerminalIds: Set<string>
  shouldShowCanvasGroup: boolean
  activeCanvasGroupId: string | null
  handleRestoreGroup: (group: CanvasLayoutGroup) => void
  buildContentFromActiveTab: () => ReturnType<typeof contextRegistry.buildCanvasContent>
  buildContentFromDrag: (tabKey: string, raw: string) => ReturnType<typeof contextRegistry.buildCanvasContentFromDrag>
}

/**
 * 画布分组联动 hook：
 * - 计算 activeCanvasGroup / shouldShowCanvasGroup
 * - 监听 canvas pane 交互事件（pointerdown / focusin / keydown）自动切换 active pane
 * - 提供 handleRestoreGroup / buildContentFromActiveTab / buildContentFromDrag
 */
export function useCanvasGroupIntegration({
  spaceId, tabScopeKey, activeTabKey, activeTabType,
  safeSpaceGroups,
  contextItemByTabKey, currentTabKeys, contextVisibleTabKeys,
  browserViewList,
  setTabOrder,
  isForeground,
}: CanvasGroupIntegrationParams): CanvasGroupIntegrationResult {
  const storageKey = tabScopeKey ?? spaceId
  const setActivePane = useCanvasLayoutStore(state => state.setActivePane)
  const removeGroup = useCanvasLayoutStore(state => state.removeGroup)
  const setActiveKey = useSpaceContextTabsStore(state => state.setActiveKey)

  const contextVisibleTabKeySet = useMemo(
    () => new Set<string>(contextVisibleTabKeys),
    [contextVisibleTabKeys],
  )

  const effectiveGroupedTabKeys = useMemo(() => {
    return deriveContextVisibleCanvasGroups(safeSpaceGroups, contextVisibleTabKeys).visibleGroupedTabKeys
  }, [contextVisibleTabKeys, safeSpaceGroups])

  const groupedTableIds = useMemo(() => {
    const ids = new Set<string>()
    effectiveGroupedTabKeys.forEach(tabKey => {
      const parsed = contextRegistry.parseTabKey(tabKey)
      if (parsed?.type === 'tabdata') ids.add(parsed.id)
    })
    return ids
  }, [effectiveGroupedTabKeys])

  const groupedTerminalIds = useMemo(() => {
    const ids = new Set<string>()
    effectiveGroupedTabKeys.forEach(tabKey => {
      const parsed = contextRegistry.parseTabKey(tabKey)
      if (parsed?.type === 'terminal') ids.add(parsed.id)
    })
    return ids
  }, [effectiveGroupedTabKeys])

  const activeCanvasGroup = useMemo(() => {
    if (!activeTabKey) return null
    const group = findGroupForTabKey(safeSpaceGroups, activeTabKey)
    if (!group) return null
    const visiblePaneCount = group.panes.filter(
      pane => pane.content?.tabKey && contextVisibleTabKeySet.has(pane.content.tabKey),
    ).length
    return visiblePaneCount > 1 ? group : null
  }, [activeTabKey, contextVisibleTabKeySet, safeSpaceGroups])

  const shouldShowCanvasGroup = Boolean(activeCanvasGroup && activeTabType !== 'home')
  const activeCanvasGroupId = activeCanvasGroup?.id ?? null

  useEffect(() => {
    traceTabRestore('canvasIntegration:activeGroup', {
      spaceId,
      activeTabKey,
      activeTabType,
      shouldShowCanvasGroup,
      activeCanvasGroupId,
      groups: safeSpaceGroups.map(group => ({
        id: group.id,
        activePaneId: group.activePaneId,
        anchorTabKey: group.anchorTabKey,
        panes: group.panes.map(pane => ({
          id: pane.id,
          tabKey: pane.content?.tabKey ?? null,
        })),
      })),
    })
  }, [activeCanvasGroupId, activeTabKey, activeTabType, safeSpaceGroups, shouldShowCanvasGroup, spaceId])

  // Sync active canvas pane when active tab changes
  useEffect(() => {
    if (!isForeground) return
    if (!activeTabKey || !activeCanvasGroup) return
    const activePane = activeCanvasGroup.panes.find(pane => pane.content?.tabKey === activeTabKey)
    if (!activePane) return
    if (activeCanvasGroup.activePaneId === activePane.id) return
    setActivePane(storageKey, activeCanvasGroup.id, activePane.id)
  }, [activeCanvasGroup, activeTabKey, isForeground, setActivePane, storageKey])

  // Canvas interaction listener: switch active pane/tab on click/focus/key
  useEffect(() => {
    if (!isForeground) return

    const handleInteraction = (event: Event) => {
      if (event.type === 'keydown') {
        const ke = event as KeyboardEvent
        if (ke.isComposing) return
        const el = ke.target instanceof HTMLElement ? ke.target : null
        if (el?.closest('input, textarea, [contenteditable="true"]')) return
      }
      const composedPath = typeof event.composedPath === 'function' ? event.composedPath() : []
      const paneElement = composedPath.find(target =>
        target instanceof HTMLElement && Boolean(target.dataset?.canvasPaneId)
      ) as HTMLElement | undefined

      if (!paneElement) return
      const paneId = paneElement.dataset.canvasPaneId
      const groupId = paneElement.dataset.canvasGroupId
      if (!paneId || !groupId) return

      const layoutState = useCanvasLayoutStore.getState()
      const group = layoutState.getGroupById(storageKey, groupId)
      if (!group) return

      const pane = group.panes.find(item => item.id === paneId)
      if (!pane) return

      if (group.activePaneId !== paneId) {
        layoutState.setActivePane(storageKey, groupId, paneId)
      }

      if (pane.content?.tabKey && contextVisibleTabKeySet.has(pane.content.tabKey)) {
        const tabsState = useSpaceContextTabsStore.getState()
        if ((tabsState.activeKeyBySpace[storageKey] ?? null) !== pane.content.tabKey) {
          traceTabRestore('canvasIntegration:interactionSetActive', {
            spaceId,
            storageKey,
            groupId,
            paneId,
            tabKey: pane.content.tabKey,
            eventType: event.type,
          })
          tabsState.setActiveKey(storageKey, pane.content.tabKey)
        }
      }
    }

    const handlePointer = (event: Event) => handleInteraction(event)
    window.addEventListener('pointerdown', handlePointer, true)
    window.addEventListener('focusin', handleInteraction, true)
    window.addEventListener('keydown', handleInteraction, true)

    return () => {
      window.removeEventListener('pointerdown', handlePointer, true)
      window.removeEventListener('focusin', handleInteraction, true)
      window.removeEventListener('keydown', handleInteraction, true)
    }
  }, [contextVisibleTabKeySet, isForeground, spaceId, storageKey])

  const canvasBuildContext = useMemo(() => ({
    browserTabs: browserViewList
  }), [browserViewList])

  const buildContentFromActiveTab = useCallback(() => {
    if (!activeTabKey) return null
    const item = contextItemByTabKey.get(activeTabKey)
    if (!item) return null
    return contextRegistry.buildCanvasContent(item, canvasBuildContext)
  }, [activeTabKey, canvasBuildContext, contextItemByTabKey])

  const buildContentFromDrag = useCallback((tabKey: string, raw: string) => {
    let meta: { type: string; id: string; title?: string; url?: string }
    try {
      meta = JSON.parse(raw)
      if (!meta || typeof meta.type !== 'string' || typeof meta.id !== 'string') {
        console.warn('[useCanvasGroupIntegration] invalid drag data format:', raw)
        return null
      }
    } catch (error) {
      console.warn('[useCanvasGroupIntegration] failed to parse drag data:', error)
      return null
    }
    return contextRegistry.buildCanvasContentFromDrag(tabKey as CanvasTabKey, meta, canvasBuildContext)
  }, [canvasBuildContext])

  const handleRestoreGroup = useCallback((group: CanvasLayoutGroup) => {
    const groupTabKeys: string[] = group.panes
      .map(pane => pane.content?.tabKey)
      .filter((key): key is CanvasTabKey => Boolean(key))

    if (groupTabKeys.length === 0) {
      removeGroup(storageKey, group.id)
      return
    }

    const freshGroup = useCanvasLayoutStore.getState().getGroupById(storageKey, group.id)
    if (hasHiddenPersistentCanvasPanes(freshGroup, groupTabKeys.length)) {
      traceTabRestore('canvasIntegration:skipPartialRestore', {
        spaceId,
        groupId: group.id,
        visiblePaneCount: groupTabKeys.length,
        persistedPaneCount: freshGroup?.panes.filter(pane => pane.content).length ?? groupTabKeys.length,
      })
      return
    }

    const activePaneId = group.activePaneId || group.panes[0]?.id
    const activePaneTabKey =
      group.panes.find(pane => pane.id === activePaneId)?.content?.tabKey ||
      group.anchorTabKey ||
      groupTabKeys[0] ||
      null

    const groupTabKeySet = new Set(groupTabKeys)
    const withoutGroup = currentTabKeys.filter(key => !groupTabKeySet.has(key))

    let insertIndex = withoutGroup.length
    if (activeTabKey) {
      if (groupTabKeySet.has(activeTabKey)) {
        const firstGroupTabIndex = currentTabKeys.findIndex(key => groupTabKeySet.has(key))
        if (firstGroupTabIndex !== -1) {
          insertIndex = currentTabKeys.slice(0, firstGroupTabIndex).filter(key => !groupTabKeySet.has(key)).length
        }
      } else {
        const activeIndex = withoutGroup.indexOf(activeTabKey as (typeof withoutGroup)[number])
        if (activeIndex !== -1) {
          insertIndex = activeIndex + 1
        }
      }
    }

    const next = [
      ...withoutGroup.slice(0, insertIndex),
      ...groupTabKeys,
      ...withoutGroup.slice(insertIndex),
    ]

    setTabOrder(next)

    if (activePaneTabKey) {
      setActiveKey(storageKey, activePaneTabKey)
    }

    // React 18 auto-batch 会合并两个 store 的更新到同一次渲染
    removeGroup(storageKey, group.id)
  }, [activeTabKey, currentTabKeys, spaceId, storageKey, removeGroup, setActiveKey, setTabOrder])

  return {
    groupedTableIds,
    groupedTerminalIds,
    shouldShowCanvasGroup,
    activeCanvasGroupId,
    handleRestoreGroup,
    buildContentFromActiveTab,
    buildContentFromDrag,
  }
}
