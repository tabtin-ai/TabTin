import { useCallback, useEffect, useRef, useState } from 'react'
import type { CollapsibleGroupKey } from './buildSessionListVirtualItems'
import {
  readCollapsedGroups,
  syncCollapsedGroupsForOrganization,
  writeCollapsedGroups,
} from './sessionSwitcherStorage'

export function useSessionCollapsedGroups(
  organizationId: string | null | undefined,
  onExpandTrackerRuns?: () => void,
) {
  const [collapsedGroups, setCollapsedGroups] = useState<Set<CollapsibleGroupKey>>(() =>
    readCollapsedGroups(organizationId),
  )
  useEffect(() => {
    setCollapsedGroups(syncCollapsedGroupsForOrganization(organizationId))
  }, [organizationId])

  const collapsedGroupsRef = useRef(collapsedGroups)
  collapsedGroupsRef.current = collapsedGroups

  const toggleGroupCollapse = useCallback((key: CollapsibleGroupKey) => {
    const wasCollapsed = collapsedGroupsRef.current.has(key)
    setCollapsedGroups(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      writeCollapsedGroups(organizationId, next)
      return next
    })
    if (key === 'trackerRuns' && wasCollapsed && onExpandTrackerRuns) {
      onExpandTrackerRuns()
    }
  }, [organizationId, onExpandTrackerRuns])

  return {
    collapsedGroups,
    toggleGroupCollapse,
  }
}
