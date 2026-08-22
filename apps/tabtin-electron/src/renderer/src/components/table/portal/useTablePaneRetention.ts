import { useEffect, useMemo, useReducer, useRef } from 'react'
import {
  TABLE_PANE_RETENTION_MS,
  updateTablePaneRetention,
  type TablePaneRetentionResult,
} from './tablePaneRetention'

interface CommittedRetentionSnapshot {
  previousVisibleTableIds: ReadonlySet<string>
  retainedUntil: ReadonlyMap<string, number>
}

/**
 * Derive pane retention during render, then advance the previous-visible and
 * deadline snapshot only after React commits that render. A discarded or
 * repeated concurrent render therefore cannot influence the next transition.
 */
export function useTablePaneRetention(
  visibleTableIds: readonly string[],
  openTableIds: readonly string[],
  retentionMs = TABLE_PANE_RETENTION_MS,
): TablePaneRetentionResult {
  const [retentionRevision, bumpRetentionRevision] = useReducer(
    (value: number) => value + 1,
    0,
  )
  const committedSnapshotRef = useRef<CommittedRetentionSnapshot | null>(null)

  const retentionResult = useMemo(() => {
    // The reducer tick invalidates this memo when the next deadline fires.
    void retentionRevision
    const committedSnapshot = committedSnapshotRef.current
    const previousVisibleTableIds =
      committedSnapshot?.previousVisibleTableIds ?? new Set(visibleTableIds)
    const retentionCandidates = openTableIds.filter(tableId =>
      previousVisibleTableIds.has(tableId),
    )

    return updateTablePaneRetention(
      visibleTableIds,
      openTableIds,
      retentionCandidates,
      committedSnapshot?.retainedUntil ?? new Map(),
      Date.now(),
      retentionMs,
    )
  }, [visibleTableIds, openTableIds, retentionMs, retentionRevision])

  useEffect(() => {
    committedSnapshotRef.current = {
      previousVisibleTableIds: new Set(visibleTableIds),
      retainedUntil: retentionResult.retainedUntil,
    }
  }, [retentionResult.retainedUntil, visibleTableIds])

  useEffect(() => {
    if (retentionResult.nextExpiryAt == null) return
    const delay = Math.max(0, retentionResult.nextExpiryAt - Date.now())
    const timer = window.setTimeout(() => bumpRetentionRevision(), delay)
    return () => window.clearTimeout(timer)
  }, [retentionResult.nextExpiryAt])

  return retentionResult
}
