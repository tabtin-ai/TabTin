import { DETACHED_IM_MODE } from '@shared/detached-window-modes'

export function isDetachedIMWindow(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return new URLSearchParams(window.location.search).get('mode') === DETACHED_IM_MODE
  } catch {
    return false
  }
}
