import { useMemo } from 'react'
import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'

export type ContextSession = {
  activeKey: string | null
  tabOrder: string[]
  setTabOrder: (orderedKeys: string[]) => void
  syncTabOrder: (tabKeys: string[], activeKey?: string | null) => void
}

export const useContextSession = (scopeKey: string): ContextSession => {
  const emptyTabOrder = useMemo<string[]>(() => [], [])

  const activeKey = useSpaceContextTabsStore(state => state.activeKeyBySpace[scopeKey] ?? null)
  const tabOrder = useSpaceContextTabsStore(state => state.tabOrderBySpace[scopeKey] || emptyTabOrder)
  const setTabOrder = useSpaceContextTabsStore(state => state.setTabOrder)
  const syncTabOrder = useSpaceContextTabsStore(state => state.syncTabOrder)

  return useMemo(() => ({
    activeKey,
    tabOrder,
    setTabOrder: (orderedKeys: string[]) => setTabOrder(scopeKey, orderedKeys),
    syncTabOrder: (tabKeys: string[], activeKeyOverride?: string | null) =>
      syncTabOrder(scopeKey, tabKeys, activeKeyOverride)
  }), [activeKey, setTabOrder, scopeKey, syncTabOrder, tabOrder])
}

useContextSession.displayName = 'useContextSession'
