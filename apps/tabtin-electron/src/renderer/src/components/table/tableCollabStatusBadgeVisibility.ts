import { CollabConnectionStatus, CollabStatus } from '@tabtin/collab-core'

export function shouldShowTableCollabStatusBadge(
  status: CollabStatus | null | undefined,
  connectionStatus: CollabConnectionStatus | string | null | undefined,
): boolean {
  if (status == null || status === CollabStatus.INITIAL) return false

  const isExpectedInitialConnect =
    status === CollabStatus.CONNECTING &&
    connectionStatus === CollabConnectionStatus.CONNECTING

  return !isExpectedInitialConnect
}
