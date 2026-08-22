/**
 * Store version guard — MUST be imported BEFORE any zustand store.
 *
 * ES modules evaluate imports in dependency order. By importing this
 * module as the very first import in main.tsx (and keeping it free of
 * store-related dependencies), we guarantee the localStorage version
 * check runs before any zustand persist middleware hydrates state from
 * a potentially stale / incompatible localStorage snapshot.
 *
 * If the version has changed, all localStorage data is cleared (except
 * keys listed in KEYS_PRESERVED_ON_VERSION_BUMP and their legacy
 * equivalents) so that subsequent store hydrations start from a clean slate.
 *
 * IMPORTANT: persist key renames MUST NOT ship in the same release as a
 * STORE_VERSION bump — the guard clears localStorage before store hydration,
 * so createMigratingStorage would not find legacy keys.
 */

import {
  KEYS_PRESERVED_ON_VERSION_BUMP,
  LEGACY_KEY_MAP,
} from './persist-key-registry'

const STORE_VERSION = 'v3'

// Also preserve legacy equivalents so createMigratingStorage can migrate them
const KEYS_TO_PRESERVE = [
  ...KEYS_PRESERVED_ON_VERSION_BUMP,
  ...Object.keys(LEGACY_KEY_MAP).filter(legacyKey => {
    const newKey = LEGACY_KEY_MAP[legacyKey]
    return KEYS_PRESERVED_ON_VERSION_BUMP.includes(newKey)
  }),
]

try {
  const currentVersion = localStorage.getItem('__store_version')
  if (currentVersion !== STORE_VERSION) {
    console.log(
      `[StoreVersionGuard] Version changed (${currentVersion} → ${STORE_VERSION}), clearing localStorage...`,
    )

    const preserved: Record<string, string | null> = {}
    KEYS_TO_PRESERVE.forEach((key) => {
      try { preserved[key] = localStorage.getItem(key) } catch { /* skip */ }
    })

    try {
      localStorage.clear()
    } catch (e) {
      console.error('[StoreVersionGuard] localStorage.clear() failed:', e)
      // clear 失败则不继续，避免数据不一致
      throw e
    }

    Object.entries(preserved).forEach(([key, value]) => {
      if (value) try { localStorage.setItem(key, value) } catch { /* skip */ }
    })

    try { localStorage.setItem('__store_version', STORE_VERSION) } catch { /* skip */ }
    console.log('[StoreVersionGuard] Cleanup completed')
  }
} catch (e) {
  console.error('[StoreVersionGuard] Failed, proceeding without cleanup:', e)
}
