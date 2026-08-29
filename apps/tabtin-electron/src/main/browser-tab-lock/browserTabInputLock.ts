import { getMainWindow } from '../window-manager'

const lockedViewIds = new Set<string>()
const unscopedLockedViewIds = new Set<string>()
const holders = new Map<string, Set<string>>()
const sessionViews = new Map<string, Set<string>>()
const userControlledSessionsByViewId = new Map<string, Set<string>>()
const pendingHandBackNoticeSessionIds = new Set<string>()

export const BROWSER_TAB_USER_IN_CONTROL_MESSAGE =
  '用户已接管浏览器。这是硬停止：不要重试当前浏览器命令，不要绕路操作；等待用户交还后再继续。'

export class BrowserTabUserInControlError extends Error {
  readonly code = 'BROWSER_TAB_USER_IN_CONTROL'
  readonly retryable = false
  readonly info: {
    code: 'BROWSER_TAB_USER_IN_CONTROL'
    message: string
    retryable: false
    detail: { viewId: string }
  }

  constructor(readonly viewId: string) {
    super(BROWSER_TAB_USER_IN_CONTROL_MESSAGE)
    this.name = 'BrowserTabUserInControlError'
    this.info = {
      code: this.code,
      message: BROWSER_TAB_USER_IN_CONTROL_MESSAGE,
      retryable: false,
      detail: { viewId },
    }
  }
}

export interface BrowserTabControlSnapshot {
  lockedViewIds: string[]
  userControlledViewIds: string[]
  sessionIdsByViewId: Record<string, string[]>
}

export interface BrowserTabControlViewState {
  viewId: string
  locked: boolean
  unscopedLocked: boolean
  holderSessionIds: string[]
  userControlledSessionIds: string[]
  pendingHandBackNoticeSessionIds: string[]
}

export interface BrowserTabHandBackResult {
  affectedSessionIds: string[]
  releaseSessionIds: string[]
}

let listener: ((snapshot: BrowserTabControlSnapshot) => void) | null = broadcastSnapshot
let onViewsUnlocked: ((viewIds: string[]) => void) | null = null

function broadcastSnapshot(snapshot: BrowserTabControlSnapshot): void {
  try {
    getMainWindow()?.webContents.send('browser-tab-lock:changed', snapshot)
  } catch {
    // 主窗口尚未创建或已销毁时无需广播。
  }
}

function notifyListener(): void {
  listener?.(getBrowserTabControlSnapshot())
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
  assertBrowserTabAvailableForAgent(viewId)

  const normalizedSessionId = sessionId ? normalizeSessionId(sessionId) : undefined
  let holderChanged = false
  if (normalizedSessionId) {
    let viewHolders = holders.get(viewId)
    if (!viewHolders) {
      viewHolders = new Set<string>()
      holders.set(viewId, viewHolders)
    }
    if (!viewHolders.has(normalizedSessionId)) {
      viewHolders.add(normalizedSessionId)
      holderChanged = true
    }

    let views = sessionViews.get(normalizedSessionId)
    if (!views) {
      views = new Set<string>()
      sessionViews.set(normalizedSessionId, views)
    }
    views.add(viewId)
  } else {
    holderChanged = !unscopedLockedViewIds.has(viewId)
    unscopedLockedViewIds.add(viewId)
  }

  const lockChanged = !lockedViewIds.has(viewId)
  if (lockChanged) lockedViewIds.add(viewId)
  if (lockChanged || holderChanged) notifyListener()
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

/**
 * View 生命周期终止时移除全部控制态。
 *
 * 与 unlock 不同，它也清理用户接管态，避免已销毁 view 继续残留在
 * holders/sessionViews/userControlled 快照里。
 */
export function discardViewControl(viewId: string): void {
  const wasLocked = lockedViewIds.delete(viewId)
  const wasUnscoped = unscopedLockedViewIds.delete(viewId)
  const wasUserControlled = userControlledSessionsByViewId.delete(viewId)
  const hadHolders = holders.has(viewId)
  const changed = wasLocked || wasUnscoped || wasUserControlled || hadHolders

  removeViewFromSessions(viewId)
  if (!changed) return

  notifyListener()
  if (wasLocked) notifyViewsUnlocked([viewId])
}

export function unlockBySession(sessionId: string): void {
  const normalizedSessionId = normalizeSessionId(sessionId)
  const viewIds = sessionViews.get(normalizedSessionId)
  if (!viewIds) return

  let changed = false
  const released: string[] = []
  for (const viewId of viewIds) {
    const viewHolders = holders.get(viewId)
    if (viewHolders?.delete(normalizedSessionId)) changed = true
    if (viewHolders?.size === 0) {
      holders.delete(viewId)
      if (!unscopedLockedViewIds.has(viewId) && lockedViewIds.delete(viewId)) {
        released.push(viewId)
      }
    }
  }
  sessionViews.delete(normalizedSessionId)

  if (changed) notifyListener()
  notifyViewsUnlocked(released)
}

/**
 * 派生 view 继承源 view 的控制态（页面点击开新 tab 时调用）：
 * - 源 view 锁态 → 新 view 复制 holders 并入锁（膜从第一帧就有）
 * - 源 view 用户接管态 → 新 view 复制用户控制（用户自己点开的 tab 不反盖膜）
 * - 源 view 无控制态 → no-op
 */
export function inheritViewControl(sourceViewId: string, newViewId: string): void {
  if (!sourceViewId || !newViewId || sourceViewId === newViewId) return

  const sourceHolders = holders.get(sourceViewId)
  const sourceUserControlled = userControlledSessionsByViewId.get(sourceViewId)
  const sourceLocked = lockedViewIds.has(sourceViewId)
  const hasHolders = !!sourceHolders && sourceHolders.size > 0
  const hasUserControl = !!sourceUserControlled && sourceUserControlled.size > 0
  if (!hasHolders && !hasUserControl && !sourceLocked) return

  if (hasHolders) {
    let newHolders = holders.get(newViewId)
    if (!newHolders) {
      newHolders = new Set<string>()
      holders.set(newViewId, newHolders)
    }
    for (const sessionId of sourceHolders!) {
      newHolders.add(sessionId)
      let views = sessionViews.get(sessionId)
      if (!views) {
        views = new Set<string>()
        sessionViews.set(sessionId, views)
      }
      views.add(newViewId)
    }
  }

  if (hasUserControl) {
    userControlledSessionsByViewId.set(newViewId, new Set(sourceUserControlled!))
    lockedViewIds.delete(newViewId)
  } else if (sourceLocked) {
    lockedViewIds.add(newViewId)
    if (unscopedLockedViewIds.has(sourceViewId)) unscopedLockedViewIds.add(newViewId)
  }
  notifyListener()
}

export interface BrowserControlGroup {
  viewIds: string[]
  sessionIds: string[]
}

/** 接管组：种子 view 的 holders → 这些 session 的全部 view（一跳闭包，不递归）。 */
export function collectTakeOverGroup(viewId: string): BrowserControlGroup {
  const seedSessions = holders.get(viewId)
  if (!seedSessions || seedSessions.size === 0) return { viewIds: [], sessionIds: [] }

  const viewIds = new Set<string>([viewId])
  for (const sessionId of seedSessions) {
    for (const held of sessionViews.get(sessionId) ?? []) viewIds.add(held)
  }
  const sessionIds = new Set<string>()
  for (const gv of viewIds) {
    for (const sessionId of holders.get(gv) ?? []) sessionIds.add(sessionId)
  }
  return {
    viewIds: Array.from(viewIds).sort(),
    sessionIds: Array.from(sessionIds).sort(),
  }
}

/** 交还组：种子 view 的用户控制 session → 所有被这些 session 控制的 view。 */
export function collectHandBackGroup(viewId: string): BrowserControlGroup {
  const seedSessions = userControlledSessionsByViewId.get(viewId)
  if (!seedSessions || seedSessions.size === 0) return { viewIds: [], sessionIds: [] }

  const viewIds = new Set<string>()
  const sessionIds = new Set<string>()
  for (const [controlledViewId, sessions] of userControlledSessionsByViewId) {
    let intersects = false
    for (const sessionId of sessions) {
      if (seedSessions.has(sessionId)) { intersects = true; break }
    }
    if (!intersects) continue
    viewIds.add(controlledViewId)
    for (const sessionId of sessions) sessionIds.add(sessionId)
  }
  return {
    viewIds: Array.from(viewIds).sort(),
    sessionIds: Array.from(sessionIds).sort(),
  }
}

export function takeOverByUser(viewId: string): string[] {
  const group = collectTakeOverGroup(viewId)
  if (group.viewIds.length === 0) return []

  const unlockedViewIds: string[] = []
  for (const groupViewId of group.viewIds) {
    const viewSessions = Array.from(holders.get(groupViewId) ?? []).sort()
    if (viewSessions.length === 0) continue
    userControlledSessionsByViewId.set(groupViewId, new Set(viewSessions))
    if (lockedViewIds.delete(groupViewId)) unlockedViewIds.push(groupViewId)
  }
  notifyListener()
  notifyViewsUnlocked(unlockedViewIds)
  return group.sessionIds
}

export function captureBrowserTabControlViewState(viewId: string): BrowserTabControlViewState {
  const holderSessionIds = Array.from(holders.get(viewId) ?? []).sort()
  const userControlledSessionIds =
    Array.from(userControlledSessionsByViewId.get(viewId) ?? []).sort()
  const relatedSessionIds = new Set([...holderSessionIds, ...userControlledSessionIds])
  return {
    viewId,
    locked: lockedViewIds.has(viewId),
    unscopedLocked: unscopedLockedViewIds.has(viewId),
    holderSessionIds,
    userControlledSessionIds,
    pendingHandBackNoticeSessionIds: Array.from(relatedSessionIds)
      .filter((sessionId) => pendingHandBackNoticeSessionIds.has(sessionId))
      .sort(),
  }
}

export function restoreBrowserTabControlViewState(state: BrowserTabControlViewState): void {
  const currentHolderSessionIds = Array.from(holders.get(state.viewId) ?? [])
  const currentUserControlledSessionIds =
    Array.from(userControlledSessionsByViewId.get(state.viewId) ?? [])
  const relatedSessionIds = new Set([
    ...currentHolderSessionIds,
    ...currentUserControlledSessionIds,
    ...state.holderSessionIds,
    ...state.userControlledSessionIds,
  ])

  removeViewFromSessions(state.viewId)
  if (state.holderSessionIds.length > 0) {
    holders.set(state.viewId, new Set(state.holderSessionIds))
    for (const sessionId of state.holderSessionIds) {
      let views = sessionViews.get(sessionId)
      if (!views) {
        views = new Set()
        sessionViews.set(sessionId, views)
      }
      views.add(state.viewId)
    }
  }

  if (state.userControlledSessionIds.length > 0) {
    userControlledSessionsByViewId.set(
      state.viewId,
      new Set(state.userControlledSessionIds),
    )
  } else {
    userControlledSessionsByViewId.delete(state.viewId)
  }

  if (state.locked && state.userControlledSessionIds.length === 0) {
    lockedViewIds.add(state.viewId)
  } else {
    lockedViewIds.delete(state.viewId)
  }
  if (state.unscopedLocked) unscopedLockedViewIds.add(state.viewId)
  else unscopedLockedViewIds.delete(state.viewId)

  for (const sessionId of relatedSessionIds) {
    pendingHandBackNoticeSessionIds.delete(sessionId)
  }
  for (const sessionId of state.pendingHandBackNoticeSessionIds) {
    pendingHandBackNoticeSessionIds.add(sessionId)
  }
  notifyListener()
}

export function handBackToAgent(viewId: string): BrowserTabHandBackResult {
  const group = collectHandBackGroup(viewId)
  if (group.viewIds.length === 0) {
    return { affectedSessionIds: [], releaseSessionIds: [] }
  }

  for (const groupViewId of group.viewIds) {
    userControlledSessionsByViewId.delete(groupViewId)
    lockedViewIds.add(groupViewId)
  }
  const releaseSessionIds =
    group.sessionIds.filter((sessionId) => !isUserControllingSession(sessionId))
  for (const sessionId of releaseSessionIds) {
    pendingHandBackNoticeSessionIds.add(sessionId)
  }
  notifyListener()
  return {
    affectedSessionIds: group.sessionIds,
    releaseSessionIds,
  }
}

export function clearUserControlBySession(sessionId: string): boolean {
  const normalizedSessionId = normalizeSessionId(sessionId)
  let changed = pendingHandBackNoticeSessionIds.delete(normalizedSessionId)
  let controlChanged = false

  for (const [viewId, sessions] of userControlledSessionsByViewId) {
    if (!sessions.delete(normalizedSessionId)) continue

    changed = true
    controlChanged = true
    if (sessions.size === 0) userControlledSessionsByViewId.delete(viewId)

    const viewHolders = holders.get(viewId)
    viewHolders?.delete(normalizedSessionId)
    if (viewHolders?.size === 0) holders.delete(viewId)

    const views = sessionViews.get(normalizedSessionId)
    views?.delete(viewId)
    if (views?.size === 0) sessionViews.delete(normalizedSessionId)
  }

  if (controlChanged) notifyListener()
  return changed
}

export function isUserControllingSession(sessionId: string): boolean {
  const normalizedSessionId = normalizeSessionId(sessionId)
  for (const sessions of userControlledSessionsByViewId.values()) {
    if (sessions.has(normalizedSessionId)) return true
  }
  return false
}

export function isUserControllingView(viewId: string): boolean {
  return userControlledSessionsByViewId.has(viewId)
}

export function assertBrowserTabAvailableForAgent(viewId: string): void {
  if (isUserControllingView(viewId)) {
    throw new BrowserTabUserInControlError(viewId)
  }
}

export function consumeHandBackNotice(sessionId: string): boolean {
  return pendingHandBackNoticeSessionIds.delete(normalizeSessionId(sessionId))
}

export function getBrowserTabControlSnapshot(): BrowserTabControlSnapshot {
  const userControlledViewIds = Array.from(userControlledSessionsByViewId.keys()).sort()
  const userControlledViewIdSet = new Set(userControlledViewIds)
  const sortedLockedViewIds = Array.from(lockedViewIds)
    .filter((viewId) => !userControlledViewIdSet.has(viewId))
    .sort()
  const sessionIdsByViewId: Record<string, string[]> = {}
  const visibleViewIds = Array.from(
    new Set([...sortedLockedViewIds, ...userControlledViewIds]),
  ).sort()
  for (const viewId of visibleViewIds) {
    const sessions = new Set<string>()
    if (lockedViewIds.has(viewId)) {
      for (const sessionId of holders.get(viewId) ?? []) sessions.add(sessionId)
    }
    for (const sessionId of userControlledSessionsByViewId.get(viewId) ?? []) {
      sessions.add(sessionId)
    }
    sessionIdsByViewId[viewId] = Array.from(sessions).sort()
  }

  return {
    lockedViewIds: sortedLockedViewIds,
    userControlledViewIds,
    sessionIdsByViewId,
  }
}

export function isLocked(viewId: string): boolean {
  return lockedViewIds.has(viewId)
}

export function getLockedViewIds(): string[] {
  return Array.from(lockedViewIds)
}

export function setBrowserTabLockListener(
  nextListener: ((snapshot: BrowserTabControlSnapshot) => void) | null,
): void {
  listener = nextListener
}

export function setOnViewsUnlocked(nextListener: ((viewIds: string[]) => void) | null): void {
  onViewsUnlocked = nextListener
}

export function clearAllBrowserTabControl(): void {
  const releasedViewIds = Array.from(new Set([
    ...lockedViewIds,
    ...userControlledSessionsByViewId.keys(),
  ])).sort()
  lockedViewIds.clear()
  unscopedLockedViewIds.clear()
  holders.clear()
  sessionViews.clear()
  userControlledSessionsByViewId.clear()
  pendingHandBackNoticeSessionIds.clear()
  notifyListener()
  notifyViewsUnlocked(releasedViewIds)
}

export function resetBrowserTabInputLockForTests(): void {
  lockedViewIds.clear()
  unscopedLockedViewIds.clear()
  holders.clear()
  sessionViews.clear()
  userControlledSessionsByViewId.clear()
  pendingHandBackNoticeSessionIds.clear()
  onViewsUnlocked = null
}
