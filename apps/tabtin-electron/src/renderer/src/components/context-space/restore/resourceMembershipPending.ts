import type { ContextItemMeta } from '@stores/contextTabs/types'

export const RESOURCE_MEMBERSHIP_PENDING_SINCE_META = 'resourceMembershipPendingSince'
export const RESOURCE_MEMBERSHIP_PENDING_TTL_MS = 60_000

export function markResourceMembershipPending(
  meta?: ContextItemMeta,
  nowMs = Date.now(),
): ContextItemMeta {
  return {
    ...(meta ?? {}),
    [RESOURCE_MEMBERSHIP_PENDING_SINCE_META]: nowMs,
  }
}

export function isResourceMembershipPending(meta: ContextItemMeta | undefined, nowMs: number): boolean {
  const pendingSince = meta?.[RESOURCE_MEMBERSHIP_PENDING_SINCE_META]
  if (typeof pendingSince !== 'number' || !Number.isFinite(pendingSince)) return false
  const ageMs = nowMs - pendingSince
  return ageMs >= 0 && ageMs <= RESOURCE_MEMBERSHIP_PENDING_TTL_MS
}
