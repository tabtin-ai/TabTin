/** @store-category session */

import { create } from 'zustand'
import { registerResetAction } from './sessionResetRegistry'

interface BrowserTabLockStore {
  lockedViewIds: string[]
  setLockedViewIds: (ids: string[]) => void
  isLocked: (viewId: string) => boolean
}

export const useBrowserTabLockStore = create<BrowserTabLockStore>((set, get) => ({
  lockedViewIds: [],
  setLockedViewIds: (lockedViewIds) => set({ lockedViewIds }),
  isLocked: (viewId) => get().lockedViewIds.includes(viewId),
}))

registerResetAction('browser-tab-lock', 'reset', () => {
  useBrowserTabLockStore.setState({ lockedViewIds: [] })
})
