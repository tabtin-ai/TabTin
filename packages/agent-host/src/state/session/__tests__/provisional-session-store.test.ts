import { describe, expect, it } from 'vitest'
import { ProvisionalSessionStore } from '../provisional-session-store.js'

describe('ProvisionalSessionStore', () => {
  it('发送先接纳后拒绝放弃', () => {
    const store = new ProvisionalSessionStore()
    expect(store.register('session-1')).toBe(true)
    const claim = store.beginClaim('session-1')
    expect(claim.accepted).toBe(true)
    store.completeClaim('session-1', true)

    expect(store.beginDiscard('session-1')).toEqual({
      accepted: false,
      reason: 'claimed',
    })
  })

  it('放弃先提交后拒绝发送接纳', () => {
    const store = new ProvisionalSessionStore()
    store.register('session-1')
    const discard = store.beginDiscard('session-1')

    expect(discard.accepted).toBe(true)
    expect(store.beginClaim('session-1')).toEqual({
      accepted: false,
      reason: 'discarding',
    })
    store.completeDiscard('session-1', true)
    expect(store.getState('session-1')).toBe('discarded')
  })

  it('删除失败恢复 provisional，允许用户重试发送', () => {
    const store = new ProvisionalSessionStore()
    store.register('session-1')
    const discard = store.beginDiscard('session-1')

    store.completeDiscard('session-1', false)

    expect(store.getState('session-1')).toBe('provisional')
    expect(store.beginClaim('session-1').accepted).toBe(true)
  })

  it('发送未被接纳时恢复 provisional', () => {
    const store = new ProvisionalSessionStore()
    store.register('session-1')
    const claim = store.beginClaim('session-1')

    store.completeClaim('session-1', false)

    expect(store.getState('session-1')).toBe('provisional')
    expect(store.beginDiscard('session-1').accepted).toBe(true)
  })

  it('等待遥控 accepted 期间拒绝离页删除', () => {
    const store = new ProvisionalSessionStore()
    store.register('session-1')

    expect(store.beginClaim('session-1')).toMatchObject({ accepted: true, tracked: true })
    expect(store.beginDiscard('session-1')).toEqual({
      accepted: false,
      reason: 'claiming',
    })
  })

  it('普通会话不写入所有权状态', () => {
    const store = new ProvisionalSessionStore()
    const claim = store.beginClaim('session-1')

    expect(claim).toMatchObject({ accepted: true, tracked: false })
    store.completeClaim('session-1', true)
    expect(store.getState('session-1')).toBeUndefined()
  })

  it('未知会话 fail-closed，不允许删除', () => {
    const store = new ProvisionalSessionStore()

    expect(store.beginDiscard('unknown')).toEqual({
      accepted: false,
      reason: 'unknown',
    })
  })
})
