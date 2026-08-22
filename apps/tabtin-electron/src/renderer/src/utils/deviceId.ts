const STORAGE_KEY = 'tabtin.device_id'

const createDeviceId = (): string => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `electron-${crypto.randomUUID()}`
  }
  return `electron-${Date.now()}_${Math.floor(Math.random() * 100000)}`
}

/**
 * Synchronous getter — returns the cached/localStorage value immediately.
 * Callers that need the canonical Main-process fingerprint should use
 * `syncDeviceFingerprint()` once at app startup, after which this function
 * returns the authoritative value.
 */
export const getOrCreateDeviceId = (): string => {
  if (typeof window === 'undefined') {
    return createDeviceId()
  }

  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    if (stored && stored.trim().length > 0) {
      return stored
    }
    const created = createDeviceId()
    window.localStorage.setItem(STORAGE_KEY, created)
    return created
  } catch {
    return createDeviceId()
  }
}

/**
 * One-time sync: fetch the canonical fingerprint from Main process (persisted
 * on disk) and align localStorage so that all subsequent `getOrCreateDeviceId()`
 * calls return the same value as Main.
 *
 * Called in main.tsx bootstrap() before React render.
 */
export type SyncedDeviceIdentity = {
  fingerprint: string
  machineKey: string | null
  previousFingerprint: string | null
  recoveryFingerprints: string[]
}

let _syncedIdentity: SyncedDeviceIdentity | null = null

/** bootstrap 后可读：注册设备时带上 machine_key / previous_fingerprint。 */
export const getSyncedDeviceIdentity = (): SyncedDeviceIdentity | null => _syncedIdentity

export const syncDeviceFingerprint = async (): Promise<string> => {
  try {
    const tabtin = window.tabtin
    if (tabtin?.getDeviceIdentity) {
      const identity = await tabtin.getDeviceIdentity()
      if (identity?.fingerprint) {
        window.localStorage.setItem(STORAGE_KEY, identity.fingerprint)
        _syncedIdentity = {
          fingerprint: identity.fingerprint,
          machineKey: identity.machineKey ?? null,
          previousFingerprint: identity.previousFingerprint ?? null,
          recoveryFingerprints: identity.recoveryFingerprints ?? [],
        }
        return identity.fingerprint
      }
    }
    if (tabtin?.getDeviceFingerprint) {
      const fp: string = await tabtin.getDeviceFingerprint()
      if (fp && fp.length > 0) {
        window.localStorage.setItem(STORAGE_KEY, fp)
        _syncedIdentity = {
          fingerprint: fp,
          machineKey: null,
          previousFingerprint: null,
          recoveryFingerprints: [],
        }
        return fp
      }
    }
  } catch {
    // IPC unavailable — fall back to existing localStorage value
  }
  const fp = getOrCreateDeviceId()
  _syncedIdentity = {
    fingerprint: fp,
    machineKey: null,
    previousFingerprint: null,
    recoveryFingerprints: [],
  }
  return fp
}
