import { runAllResetActions } from '@tabtin/app-shell'

const PRESERVED_KEYS = new Set([
  'tabtin-ui-store',
  'tabtin_language',
])

const TABTIN_PREFIXES = ['tabtin_', 'tabtin-']

type ResetCallback = () => void
const _resetCallbacks: ResetCallback[] = []

export function registerSessionReset(callback: ResetCallback) {
  _resetCallbacks.push(callback)
}

export function resetSessionState() {
  for (const callback of _resetCallbacks) {
    try { callback() } catch { /* ignore */ }
  }

  void runAllResetActions()

  const keysToRemove: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (!key) continue
    if (PRESERVED_KEYS.has(key)) continue
    if (TABTIN_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      keysToRemove.push(key)
    }
  }
  for (const key of keysToRemove) {
    localStorage.removeItem(key)
  }
}
