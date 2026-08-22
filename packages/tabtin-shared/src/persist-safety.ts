/**
 * Framework-level safety wrapper for zustand persist options.
 *
 * Protects `merge`, `migrate`, and `onRehydrateStorage` callbacks with
 * try/catch so that corrupted / structurally invalid localStorage data
 * never crashes the entire store initialisation (which would white-screen
 * the app).
 *
 * When merge/migrate fails, the original localStorage data is backed up
 * under a `{name}__corrupt_backup` key so it can be inspected later.
 *
 * Usage:
 *   persist(stateCreator, withPersistSafety({ name: '...', merge, migrate, ... }))
 */

import type { PersistOptions } from 'zustand/middleware'

export type PersistSafetyEvent =
  | { type: 'merge_failed'; storeName: string; error: unknown }
  | { type: 'migrate_failed'; storeName: string; error: unknown }
  | { type: 'rehydrate_setup_failed'; storeName: string; error: unknown }
  | { type: 'rehydrate_error'; storeName: string; error: unknown }
  | { type: 'rehydrate_callback_failed'; storeName: string; error: unknown }

export interface PersistSafetyOptions<S, PersistedState = S, PersistReturn = unknown>
  extends PersistOptions<S, PersistedState, PersistReturn> {
  onSafetyEvent?: (event: PersistSafetyEvent) => void
}

function backupCorruptedData(storeName: string): void {
  try {
    if (typeof localStorage === 'undefined') return
    const raw = localStorage.getItem(storeName)
    if (raw) {
      const backupKey = `${storeName}__corrupt_backup`
      localStorage.setItem(backupKey, raw)
      console.warn(
        `[PersistSafety:${storeName}] corrupt data backed up to "${backupKey}"`,
      )
    }
  } catch {
    // 备份本身不能抛出异常
  }
}

export function withPersistSafety<S, PersistedState = S, PersistReturn = unknown>(
  options: PersistSafetyOptions<S, PersistedState, PersistReturn>
): PersistOptions<S, PersistedState, PersistReturn> {
  const { name, merge, migrate, onRehydrateStorage, onSafetyEvent } = options
  const wrapped: PersistOptions<S, PersistedState, PersistReturn> = { ...options }
  // 不让 onSafetyEvent 泄漏到 zustand 的 PersistOptions 中
  delete (wrapped as unknown as Record<string, unknown>)['onSafetyEvent']

  wrapped.merge = ((persisted: unknown, currentState: S) => {
    try {
      if (merge) {
        return merge(persisted, currentState)
      }
      return { ...currentState, ...(persisted as Partial<S>) }
    } catch (error) {
      console.error(`[PersistSafety:${name}] merge failed, falling back to defaults`, error)
      backupCorruptedData(name)
      onSafetyEvent?.({ type: 'merge_failed', storeName: name, error })
      return currentState
    }
  }) as PersistOptions<S, PersistedState, PersistReturn>['merge']

  if (migrate) {
    wrapped.migrate = ((persisted: unknown, version: number) => {
      try {
        return migrate(persisted, version)
      } catch (error) {
        console.error(`[PersistSafety:${name}] migrate failed, passing raw state to merge for best-effort recovery`, error)
        backupCorruptedData(name)
        onSafetyEvent?.({ type: 'migrate_failed', storeName: name, error })
        return (persisted ?? {}) as PersistedState
      }
    }) as PersistOptions<S, PersistedState, PersistReturn>['migrate']
  }

  if (onRehydrateStorage) {
    wrapped.onRehydrateStorage = ((initialState: S) => {
      let callback: ((state?: S, error?: unknown) => void) | void
      try {
        callback = onRehydrateStorage(initialState)
      } catch (error) {
        console.error(`[PersistSafety:${name}] onRehydrateStorage setup failed`, error)
        onSafetyEvent?.({ type: 'rehydrate_setup_failed', storeName: name, error })
        return undefined
      }
      if (typeof callback !== 'function') return undefined
      return (hydratedState?: unknown, rehydrateError?: unknown) => {
        if (rehydrateError) {
          console.error(`[PersistSafety:${name}] rehydration error`, rehydrateError)
          onSafetyEvent?.({ type: 'rehydrate_error', storeName: name, error: rehydrateError })
          return
        }
        try {
          callback!(hydratedState as S | undefined, rehydrateError)
        } catch (error) {
          console.error(`[PersistSafety:${name}] onRehydrateStorage callback failed`, error)
          onSafetyEvent?.({ type: 'rehydrate_callback_failed', storeName: name, error })
        }
      }
    }) as PersistOptions<S, PersistedState, PersistReturn>['onRehydrateStorage']
  }

  return wrapped
}
