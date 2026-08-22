import { getMainWindow } from '../window-manager'

const lockedViewIds = new Set<string>()
const unscopedLockedViewIds = new Set<string>()
const holders = new Map<string, Set<string>>()
const sessionViews = new Map<string, Set<string>>()

let listener: ((ids: string[]) => void) | null = broadcastLockedViewIds
let onViewsUnlocked: ((viewIds: string[]) => void) | null = null

function broadcastLockedViewIds(lockedViewIds: string[]): void {
  try {
    getMainWindow()?.webContents.send('browser-tab-lock:changed', { lockedViewIds })
  } catch {
    // 主窗口尚未创建或已销毁时无需广播。
  }
}

function notifyListener(): void {
  listener?.(Array.from(lockedViewIds))
}

function notifyViewsUnlocked(viewIds: string[]): void {
  if (viewIds.length === 0) return
  try {
    onViewsUnlocked?.(viewIds)
  } catch {
    // 指针收起失败不得阻断解锁。
  }
}

function normalizeSessionId(sessionId: string): string {
  return sessionId.startsWith('chat-session-')
    ? sessionId.slice('chat-session-'.length)
    : sessionId
}

function removeViewFromSessions(viewId: string): void {
  const viewHolders = holders.get(viewId)
  if (!viewHolders) return

  for (const sessionId of viewHolders) {
    const views = sessionViews.get(sessionId)
    views?.delete(viewId)
    if (views?.size === 0) sessionViews.delete(sessionId)
  }

  holders.delete(viewId)
}

export function lock(viewId: string, sessionId?: string): void {
  const normalizedSessionId = sessionId ? normalizeSessionId(sessionId) : undefined
  if (normalizedSessionId) {
    let viewHolders = holders.get(viewId)
    if (!viewHolders) {
      viewHolders = new Set<string>()
      holders.set(viewId, viewHolders)
    }
    viewHolders.add(normalizedSessionId)

    let views = sessionViews.get(normalizedSessionId)
    if (!views) {
      views = new Set<string>()
      sessionViews.set(normalizedSessionId, views)
    }
    views.add(viewId)
  } else {
    unscopedLockedViewIds.add(viewId)
  }

  if (lockedViewIds.has(viewId)) return

  lockedViewIds.add(viewId)
  notifyListener()
}

export function unlock(viewId: string): void {
  if (!lockedViewIds.has(viewId)) {
    return
  }

  lockedViewIds.delete(viewId)
  unscopedLockedViewIds.delete(viewId)
  removeViewFromSessions(viewId)
  notifyListener()
  notifyViewsUnlocked([viewId])
}

export function unlockBySession(sessionId: string): void {
  const normalizedSessionId = normalizeSessionId(sessionId)
  const viewIds = sessionViews.get(normalizedSessionId)
  if (!viewIds) return

  let changed = false
  const released: string[] = []
  for (const viewId of viewIds) {
    const viewHolders = holders.get(viewId)
    viewHolders?.delete(normalizedSessionId)
    if (viewHolders?.size === 0) {
      holders.delete(viewId)
      if (!unscopedLockedViewIds.has(viewId) && lockedViewIds.delete(viewId)) {
        changed = true
        released.push(viewId)
      }
    }
  }
  sessionViews.delete(normalizedSessionId)

  if (changed) notifyListener()
  notifyViewsUnlocked(released)
}

export function isLocked(viewId: string): boolean {
  return lockedViewIds.has(viewId)
}

export function getLockedViewIds(): string[] {
  return Array.from(lockedViewIds)
}

export function setBrowserTabLockListener(nextListener: ((ids: string[]) => void) | null): void {
  listener = nextListener
}

export function setOnViewsUnlocked(nextListener: ((viewIds: string[]) => void) | null): void {
  onViewsUnlocked = nextListener
}

export function resetBrowserTabInputLockForTests(): void {
  lockedViewIds.clear()
  unscopedLockedViewIds.clear()
  holders.clear()
  sessionViews.clear()
  onViewsUnlocked = null
}
