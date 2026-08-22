import { CollabStatus } from '@tabtin/collab-core'

export function isRecordFocusCollabBootstrapPending(input: {
  hasFocusIntent: boolean
  syncMode: 'collab' | 'legacy'
  status: CollabStatus
  syncModeReason?: string | null
}): boolean {
  if (!input.hasFocusIntent) return false

  if (input.syncMode === 'collab') {
    return input.status !== CollabStatus.SYNCED
  }

  // Before the token/provider is ready, the collaboration hook briefly
  // exposes the REST fallback as `collab_unavailable`. Keep the deep-link
  // intent pending during that bootstrap window, but do not delay explicit
  // permanent legacy modes such as disabled/permission-restricted tables.
  return input.status === CollabStatus.INITIAL && input.syncModeReason === 'collab_unavailable'
}
