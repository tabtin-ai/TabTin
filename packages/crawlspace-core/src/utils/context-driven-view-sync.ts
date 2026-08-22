const VIEW_MANAGER_MAIN_OWNED_EVENTS = new Set([
  'title:changed',
  'favicon:changed',
])

const SHELL_MAIN_OWNED_EVENTS = new Set([
  'page:loading',
  'page:loaded',
  'navigation:state',
  'navigation:completed',
  'theme-color:changed',
])

export function shouldMirrorViewManagerEventToLocalStore(
  eventType: string,
  isContextDriven: boolean,
): boolean {
  if (!isContextDriven) {
    return true
  }
  return !VIEW_MANAGER_MAIN_OWNED_EVENTS.has(eventType)
}

export function shouldMirrorShellEventToLocalStore(
  eventType: string,
  isContextDriven: boolean,
): boolean {
  if (!isContextDriven) {
    return true
  }
  return !SHELL_MAIN_OWNED_EVENTS.has(eventType)
}
