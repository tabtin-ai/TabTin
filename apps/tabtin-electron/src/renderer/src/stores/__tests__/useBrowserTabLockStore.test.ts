import { beforeEach, describe, expect, it } from 'vitest'
import { useBrowserTabLockStore } from '../useBrowserTabLockStore'

describe('useBrowserTabLockStore', () => {
  beforeEach(() => {
    useBrowserTabLockStore.setState({ lockedViewIds: [] })
  })

  it('tracks locked view ids', () => {
    useBrowserTabLockStore.getState().setLockedViewIds(['view-1'])

    expect(useBrowserTabLockStore.getState().isLocked('view-1')).toBe(true)
    expect(useBrowserTabLockStore.getState().isLocked('view-2')).toBe(false)
  })
})
