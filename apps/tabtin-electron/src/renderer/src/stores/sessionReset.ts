import { runAllResetActions } from './sessionResetRegistry'
import { KEYS_PRESERVED_ON_LOGOUT, PERSIST_KEYS } from './persist-key-registry'

export type SessionResetReason = 'logout' | 'token_refresh_failed' | 'manual'

function readOrganizationMemoryForLogout(): string | null {
  const raw = localStorage.getItem(PERSIST_KEYS.organization)
  if (!raw) return null

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const state = (parsed.state && typeof parsed.state === 'object')
      ? parsed.state as Record<string, unknown>
      : parsed
    const selectedOrganization = state.selectedOrganization && typeof state.selectedOrganization === 'object'
      ? state.selectedOrganization as Record<string, unknown>
      : null
    return typeof state.lastOpenedOrganizationId === 'string'
      ? state.lastOpenedOrganizationId
      : typeof selectedOrganization?.id === 'string'
        ? selectedOrganization.id
        : null
  } catch {
    return null
  }
}

function clearPersistDataOnLogout(organizationMemoryId: string | null): void {
  try {
    sanitizeOrganizationPersistDataOnLogout(organizationMemoryId)
    const toRemove: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key && !KEYS_PRESERVED_ON_LOGOUT.includes(key)) {
        toRemove.push(key)
      }
    }
    toRemove.forEach(key => localStorage.removeItem(key))
    console.log(`[SessionReset] cleared ${toRemove.length} localStorage keys`)
  } catch (error) {
    console.error('[SessionReset] clearPersistDataOnLogout failed', error)
  }
}

function sanitizeOrganizationPersistDataOnLogout(organizationMemoryId: string | null): void {
  const raw = localStorage.getItem(PERSIST_KEYS.organization)
  if (!raw) return

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const state = (parsed.state && typeof parsed.state === 'object')
      ? parsed.state as Record<string, unknown>
      : parsed
    const selectedOrganization = state.selectedOrganization && typeof state.selectedOrganization === 'object'
      ? state.selectedOrganization as Record<string, unknown>
      : null
    const lastOpenedOrganizationId = organizationMemoryId
      ?? (typeof state.lastOpenedOrganizationId === 'string'
        ? state.lastOpenedOrganizationId
        : typeof selectedOrganization?.id === 'string'
          ? selectedOrganization.id
          : null)

    localStorage.setItem(PERSIST_KEYS.organization, JSON.stringify({
      ...parsed,
      state: {
        organizations: [],
        selectedOrganization: null,
        lastOpenedOrganizationId,
        currentUserRole: null,
      },
      version: typeof parsed.version === 'number' ? parsed.version : 2,
    }))
  } catch {
    localStorage.removeItem(PERSIST_KEYS.organization)
  }
}

export const resetSessionState = async (reason: SessionResetReason = 'manual'): Promise<void> => {
  const organizationMemoryId = reason === 'logout' || reason === 'token_refresh_failed'
    ? readOrganizationMemoryForLogout()
    : null

  await runAllResetActions()

  if (reason === 'logout' || reason === 'token_refresh_failed') {
    clearPersistDataOnLogout(organizationMemoryId)
  }

  console.log('[SessionReset] stores reset completed', { reason })
}
