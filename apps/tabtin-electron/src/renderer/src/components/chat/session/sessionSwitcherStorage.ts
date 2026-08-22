import { migrateLegacyLocalStorageKey } from '@/utils/localStorageMigration'
import type { CollapsibleGroupKey } from './buildSessionListVirtualItems'

export const COLLAPSED_GROUPS_KEY_BASE = 'chat-collapsed-groups'
export const MAX_SESSION_TITLE_LENGTH = 255
export function buildCollapsedGroupsKey(organizationId: string | null | undefined): string {
  return organizationId ? `${COLLAPSED_GROUPS_KEY_BASE}:${organizationId}` : COLLAPSED_GROUPS_KEY_BASE
}

export function readCollapsedGroups(organizationId: string | null | undefined): Set<CollapsibleGroupKey> {
  try {
    const raw = localStorage.getItem(buildCollapsedGroupsKey(organizationId))
      ?? localStorage.getItem(COLLAPSED_GROUPS_KEY_BASE)
    if (raw) return new Set(JSON.parse(raw) as CollapsibleGroupKey[])
  } catch { /* ignore */ }
  return new Set(['trackerRuns'] as CollapsibleGroupKey[])
}

export function writeCollapsedGroups(
  organizationId: string | null | undefined,
  groups: Set<CollapsibleGroupKey>,
): void {
  try {
    localStorage.setItem(buildCollapsedGroupsKey(organizationId), JSON.stringify([...groups]))
  } catch { /* ignore */ }
}

export function syncCollapsedGroupsForOrganization(organizationId: string | null | undefined): Set<CollapsibleGroupKey> {
  if (organizationId) {
    migrateLegacyLocalStorageKey(COLLAPSED_GROUPS_KEY_BASE, buildCollapsedGroupsKey(organizationId))
  }
  return readCollapsedGroups(organizationId)
}
