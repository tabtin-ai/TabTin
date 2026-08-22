/**
 * Storage adapter for transparent persist key migration.
 *
 * Wraps a zustand persist `StateStorage` so that when `getItem(newKey)`
 * finds nothing, it tries each legacy key in order and copies the first
 * hit to the new key. The old key is **preserved** (copy, not move) to
 * support version rollback — cleanup happens in a later migrate pass.
 *
 * Usage with withPersistSafety:
 *   persist(stateCreator, withPersistSafety({
 *     name: 'tabtin-prefs-canvas-layout',
 *     storage: createMigratingStorage(
 *       createJSONStorage(() => localStorage),
 *       ['canvas-layout'],   // legacy keys, tried in order
 *     ),
 *     ...
 *   }))
 *
 * Timing guarantee:
 *   zustand persist calls `storage.getItem(name)` before merge/migrate,
 *   so migration completes before any callback receives the persisted state.
 */

import type { StateStorage } from 'zustand/middleware'

export interface MigratingStorageOptions {
  /**
   * Previously used persist key names. Tried in order; the first one
   * containing data wins. Data is copied (not moved) to the new key.
   */
  legacyNames: string[]
}

/**
 * Wrap a base StateStorage with legacy-key migration.
 *
 * When `getItem` is called for a key that has no data, each legacy name
 * is checked. If legacy data is found it is copied to the new key so
 * subsequent reads go through the normal path.
 *
 * The old key is intentionally kept so that a rollback to a previous
 * version (which still uses the old key) can read the data.
 */
export function createMigratingStorage(
  base: StateStorage,
  legacyNames: string[],
): StateStorage {
  if (!legacyNames.length) return base

  return {
    getItem: (name: string): string | null | Promise<string | null> => {
      const current = base.getItem(name)

      if (current instanceof Promise) {
        return current.then((val) => {
          if (val != null) return val
          return _migrateFromLegacy(base, name, legacyNames)
        })
      }

      if (current != null) return current
      return _migrateFromLegacy(base, name, legacyNames)
    },

    setItem: (name: string, value: string) => {
      return base.setItem(name, value)
    },

    removeItem: (name: string) => {
      return base.removeItem(name)
    },
  }
}

function _migrateFromLegacy(
  base: StateStorage,
  name: string,
  legacyNames: string[],
): string | null | Promise<string | null> {
  for (let i = 0; i < legacyNames.length; i++) {
    const oldName = legacyNames[i]
    try {
      const legacy = base.getItem(oldName)

      if (legacy instanceof Promise) {
        return legacy.then((val) => {
          if (val != null) {
            try {
              base.setItem(name, val)
              console.log(
                `[PersistKeyMigration] copied "${oldName}" → "${name}"`,
              )
            } catch {
              console.warn(
                `[PersistKeyMigration] copy failed for "${oldName}" → "${name}", returning data without persistence`,
              )
            }
            return val
          }
          return _migrateFromLegacy(base, name, legacyNames.slice(i + 1))
        })
      }

      if (legacy != null) {
        try {
          base.setItem(name, legacy)
          console.log(`[PersistKeyMigration] copied "${oldName}" → "${name}"`)
        } catch {
          console.warn(
            `[PersistKeyMigration] copy failed for "${oldName}" → "${name}", returning data without persistence`,
          )
        }
        return legacy
      }
    } catch {
      // storage access may fail in restricted contexts; skip silently
    }
  }
  return null
}
