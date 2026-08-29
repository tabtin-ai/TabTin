import { beforeEach, describe, expect, it } from 'vitest'
import { useBrowserTabLockStore } from '../useBrowserTabLockStore'

describe('useBrowserTabLockStore', () => {
  beforeEach(() => {
    useBrowserTabLockStore.getState().setSnapshot({
      lockedViewIds: [],
      userControlledViewIds: [],
      sessionIdsByViewId: {},
    })
  })

  it('一次 snapshot 同步锁态、用户控制态和 session 映射', () => {
    useBrowserTabLockStore.getState().setSnapshot({
      lockedViewIds: [],
      userControlledViewIds: ['view-1'],
      sessionIdsByViewId: { 'view-1': ['session-1'] },
    })

    const state = useBrowserTabLockStore.getState()
    expect(state.isLocked('view-1')).toBe(false)
    expect(state.isUserControlling('view-1')).toBe(true)
    expect(state.getSessionIds('view-1')).toEqual(['session-1'])
  })

  it('reset 清空完整 snapshot', () => {
    useBrowserTabLockStore.getState().setSnapshot({
      lockedViewIds: ['view-1'],
      userControlledViewIds: ['view-2'],
      sessionIdsByViewId: {
        'view-1': ['session-1'],
        'view-2': ['session-2'],
      },
    })

    useBrowserTabLockStore.getState().reset()

    expect(useBrowserTabLockStore.getState().snapshot).toEqual({
      lockedViewIds: [],
      userControlledViewIds: [],
      sessionIdsByViewId: {},
    })
  })
})
