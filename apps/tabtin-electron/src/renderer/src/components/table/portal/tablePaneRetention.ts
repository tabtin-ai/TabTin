/** Keep the full pane alive for short back-and-forth navigation without making
 * inactive canvases a long-lived background workload. */
export const TABLE_PANE_RETENTION_MS = 90_000

export interface TablePaneRetentionResult {
  retainedTableIds: string[]
  retainedUntil: Map<string, number>
  nextExpiryAt: number | null
}

/**
 * Keep a table pane mounted for a short grace period after it leaves the
 * active portal list, as long as its tab is still open. This preserves the
 * provider/context while the user switches between tabs and avoids a reload
 * on the common switch-back path.
 */
export function updateTablePaneRetention(
  visibleTableIds: readonly string[],
  openTableIds: readonly string[],
  retentionCandidates: readonly string[],
  previousRetainedUntil: ReadonlyMap<string, number>,
  now: number,
  retentionMs = TABLE_PANE_RETENTION_MS,
): TablePaneRetentionResult {
  const visible = new Set(visibleTableIds)
  const open = new Set(openTableIds)
  const candidates = new Set(retentionCandidates)
  const retainedUntil = new Map<string, number>()

  for (const [tableId, expiresAt] of previousRetainedUntil) {
    if (open.has(tableId) && !visible.has(tableId) && expiresAt > now) {
      retainedUntil.set(tableId, expiresAt)
    }
  }

  for (const tableId of candidates) {
    if (visible.has(tableId) || retainedUntil.has(tableId)) continue
    retainedUntil.set(tableId, now + retentionMs)
  }

  let nextExpiryAt: number | null = null
  for (const expiresAt of retainedUntil.values()) {
    if (nextExpiryAt == null || expiresAt < nextExpiryAt) {
      nextExpiryAt = expiresAt
    }
  }

  return {
    retainedTableIds: Array.from(retainedUntil.keys()),
    retainedUntil,
    nextExpiryAt,
  }
}
