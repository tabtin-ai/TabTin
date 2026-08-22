/**
 * useSpacePresenceStore 单测 — Project 在场感的连接计数语义。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { useSpacePresenceStore } from './useSpacePresenceStore'

const SPACE_A = 'space-a'
const SPACE_B = 'space-b'
const USER_1 = 'user-1'
const USER_2 = 'user-2'

describe('useSpacePresenceStore', () => {
  beforeEach(() => {
    useSpacePresenceStore.getState().reset()
  })

  it('join 后判定在线，leave 后判定离线', () => {
    const store = useSpacePresenceStore.getState()
    store.addSpaceConnection(SPACE_A, USER_1)
    expect(useSpacePresenceStore.getState().isOnlineInSpace(SPACE_A, USER_1)).toBe(true)

    store.removeSpaceConnection(SPACE_A, USER_1)
    expect(useSpacePresenceStore.getState().isOnlineInSpace(SPACE_A, USER_1)).toBe(false)
  })

  it('同一用户多连接：全部 leave 才离线', () => {
    const store = useSpacePresenceStore.getState()
    store.addSpaceConnection(SPACE_A, USER_1)
    store.addSpaceConnection(SPACE_A, USER_1)
    store.removeSpaceConnection(SPACE_A, USER_1)
    expect(useSpacePresenceStore.getState().isOnlineInSpace(SPACE_A, USER_1)).toBe(true)

    store.removeSpaceConnection(SPACE_A, USER_1)
    expect(useSpacePresenceStore.getState().isOnlineInSpace(SPACE_A, USER_1)).toBe(false)
  })

  it('presence bulk 覆盖式写入某个 Space，多个 client 属于同一用户时累加计数', () => {
    const store = useSpacePresenceStore.getState()
    store.addSpaceConnection(SPACE_A, 'stale-user')
    store.setSpacePresenceBulk(SPACE_A, {
      c1: { user: USER_1 },
      c2: { user: USER_1 },
      c3: { user: USER_2 },
    })

    const state = useSpacePresenceStore.getState()
    expect(state.isOnlineInSpace(SPACE_A, USER_1)).toBe(true)
    expect(state.isOnlineInSpace(SPACE_A, USER_2)).toBe(true)
    expect(state.isOnlineInSpace(SPACE_A, 'stale-user')).toBe(false)
    expect(state.connectionsBySpace[SPACE_A][USER_1]).toBe(2)
  })

  it('Space 之间互不影响；clearSpace 只清目标 Space', () => {
    const store = useSpacePresenceStore.getState()
    store.addSpaceConnection(SPACE_A, USER_1)
    store.addSpaceConnection(SPACE_B, USER_2)

    expect(useSpacePresenceStore.getState().isOnlineInSpace(SPACE_A, USER_2)).toBe(false)

    store.clearSpace(SPACE_A)
    const state = useSpacePresenceStore.getState()
    expect(state.isOnlineInSpace(SPACE_A, USER_1)).toBe(false)
    expect(state.isOnlineInSpace(SPACE_B, USER_2)).toBe(true)
  })

  it('对不存在的连接 remove 不产生负计数', () => {
    const store = useSpacePresenceStore.getState()
    store.removeSpaceConnection(SPACE_A, USER_1)
    expect(useSpacePresenceStore.getState().isOnlineInSpace(SPACE_A, USER_1)).toBe(false)

    store.addSpaceConnection(SPACE_A, USER_1)
    expect(useSpacePresenceStore.getState().isOnlineInSpace(SPACE_A, USER_1)).toBe(true)
  })
})
