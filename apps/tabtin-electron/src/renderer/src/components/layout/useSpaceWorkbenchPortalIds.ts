import { useMemo } from 'react'
import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'
import { useCanvasLayoutStore, type CanvasLayoutGroup } from '@stores/useCanvasLayoutStore'
import { contextRegistry } from '@components/context-space/registry'
import { useTerminalSessionStore, type TerminalSession } from '@components/context-space/sources/terminal'
import { mergePortalTableIds } from './contentAreaState'

/**
 * 与 ContentArea 一致的 table / terminal portal 订阅逻辑，
 * 供主内容区与 AppLayout 中「外置」的 SpaceContext（如会话模式右侧栏）共用。
 */
export function useSpaceWorkbenchPortalIds(spaceId: string | null, tabScopeKey?: string | null): {
  portalTableIds: string[]
  terminalSessionIds: string[]
} {
  const storageKey = tabScopeKey || spaceId
  const emptyTabOrder = useMemo<string[]>(() => [], [])
  const emptyTerminalSessions = useMemo<TerminalSession[]>(() => [], [])
  const emptySpaceGroups = useMemo<CanvasLayoutGroup[]>(() => [], [])

  const activeContextKeyFromStore = useSpaceContextTabsStore(state => {
    if (!storageKey) return null
    return state.activeKeyBySpace[storageKey] ?? null
  })

  const activeContextMeta = useMemo(() => {
    if (!activeContextKeyFromStore) return null
    return contextRegistry.parseTabKey(activeContextKeyFromStore)
  }, [activeContextKeyFromStore])

  const activeContextTableId = activeContextMeta?.type === 'tabdata' ? activeContextMeta.id : null

  const tabOrder = useSpaceContextTabsStore(state => {
    if (!storageKey) return emptyTabOrder
    return state.tabOrderBySpace[storageKey] || emptyTabOrder
  })

  const openTableTabs = useMemo(() => {
    return tabOrder
      .filter(key => key.startsWith('tabdata:'))
      .map(key => key.replace('tabdata:', ''))
  }, [tabOrder])

  const spaceGroups = useCanvasLayoutStore(state =>
    storageKey
      ? state.spaceGroups[storageKey] || emptySpaceGroups
      : emptySpaceGroups
  )

  const groupedTableIds = useMemo(() => {
    if (!spaceId || spaceGroups.length === 0) return new Set<string>()
    const ids = new Set<string>()
    spaceGroups.forEach(group => {
      group.panes.forEach(pane => {
        if (!pane.content) return
        const parsed = contextRegistry.parseTabKey(pane.content.tabKey)
        if (parsed?.type === 'tabdata') {
          ids.add(parsed.id)
        }
      })
    })
    return ids
  }, [spaceGroups, spaceId])

  const portalTableIds = useMemo(() => {
    return mergePortalTableIds({
      activeSpaceId: spaceId,
      openTableTabs,
      groupedTableIds,
      activeContextTableId,
    })
  }, [activeContextTableId, groupedTableIds, openTableTabs, spaceId])

  // Phase 4：用户终端载体已按 tabScopeKey（scope 桶）编组，承载 PTY 的 portal layer
  // 必须按同口径取会话——否则 tab 在 scope 标签栏出现、但 portal 拿不到 session →
  // 终端永不挂载/spawn（空白）。同时合并 legacy 真实 spaceId 桶，兼容旧数据与
  // materialize 的 agent transcript（仍写真实 space 桶）。
  const scopedSessions = useTerminalSessionStore(state => {
    if (!storageKey) return emptyTerminalSessions
    return state.sessionsBySpace[storageKey] || emptyTerminalSessions
  })
  const legacySessions = useTerminalSessionStore(state => {
    if (!spaceId || spaceId === storageKey) return emptyTerminalSessions
    return state.sessionsBySpace[spaceId] || emptyTerminalSessions
  })
  const terminalSessions = useMemo(() => {
    if (legacySessions.length === 0) return scopedSessions
    if (scopedSessions.length === 0) return legacySessions
    const seen = new Set<string>()
    const merged: TerminalSession[] = []
    for (const s of scopedSessions) { if (!seen.has(s.id)) { seen.add(s.id); merged.push(s) } }
    for (const s of legacySessions) { if (!seen.has(s.id)) { seen.add(s.id); merged.push(s) } }
    return merged
  }, [scopedSessions, legacySessions])

  const openTerminalTabIds = useMemo(() => {
    const ids = new Set<string>()
    for (const key of tabOrder) {
      if (key.startsWith('terminal:')) ids.add(key.slice('terminal:'.length))
    }
    return ids
  }, [tabOrder])

  const terminalSessionIds = useMemo(() => {
    return terminalSessions
      .filter(s => s.status !== 'closed' && openTerminalTabIds.has(s.id))
      .map(s => s.id)
  }, [terminalSessions, openTerminalTabIds])

  return { portalTableIds, terminalSessionIds }
}
