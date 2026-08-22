import type { CollabSyncMode } from '@tabtin/collab-core'

export function shouldConsumeTableRecordDelta(syncMode: CollabSyncMode): boolean {
  return syncMode === 'legacy'
}
