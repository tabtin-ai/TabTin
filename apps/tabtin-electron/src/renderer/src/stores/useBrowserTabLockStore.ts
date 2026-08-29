/** @store-category session */

import { create } from 'zustand'
import { registerResetAction } from './sessionResetRegistry'
import type { BrowserTabControlSnapshot } from '../../../main/browser-tab-lock/browserTabInputLock'

interface BrowserTabLockStore {
  snapshot: BrowserTabControlSnapshot
  setSnapshot: (snapshot: BrowserTabControlSnapshot) => void
  isLocked: (viewId: string) => boolean
  isUserControlling: (viewId: string) => boolean
  getSessionIds: (viewId: string) => string[]
  reset: () => void
}

const EMPTY_SESSION_IDS: string[] = []

const createEmptySnapshot = (): BrowserTabControlSnapshot => ({
  lockedViewIds: [],
  userControlledViewIds: [],
  sessionIdsByViewId: {},
})

export const useBrowserTabLockStore = create<BrowserTabLockStore>((set, get) => ({
  snapshot: createEmptySnapshot(),
  setSnapshot: (snapshot) => set({ snapshot }),
  isLocked: (viewId) => get().snapshot.lockedViewIds.includes(viewId),
  isUserControlling: (viewId) =>
    get().snapshot.userControlledViewIds.includes(viewId),
  getSessionIds: (viewId) =>
    get().snapshot.sessionIdsByViewId[viewId] ?? EMPTY_SESSION_IDS,
  reset: () => set({ snapshot: createEmptySnapshot() }),
}))

export function subscribeBrowserTabControlSnapshots(): (() => void) | undefined {
  return window.tabtin?.crawlView?.onAgentTabLockChanged((snapshot) => {
    useBrowserTabLockStore.getState().setSnapshot(snapshot)
  })
}

registerResetAction('browser-tab-lock', 'reset', () => {
  useBrowserTabLockStore.getState().reset()
})
