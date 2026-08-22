import { describe, it, expect, beforeEach } from 'vitest'
import {
  __resetSpaceSessionListWriteGateForTest,
  commitSpaceSessionListMerge,
  getObservedServerSessionIds,
  getSpaceSessionListEpoch,
  recordSpaceSessionListMutation,
  replaceObservedServerSessionIds,
} from '../spaceSessionListWriteGate'

describe('spaceSessionListWriteGate', () => {
  const SPACE = 'space-1'

  beforeEach(() => {
    __resetSpaceSessionListWriteGateForTest()
  })

  it('mutation bump epoch，陈旧 fetch 写回被丢弃', () => {
    const fetchEpoch = getSpaceSessionListEpoch(SPACE)
    recordSpaceSessionListMutation(SPACE, 'upsert')
    let applied = false
    const outcome = commitSpaceSessionListMerge(SPACE, fetchEpoch, () => {
      applied = true
    })
    expect(outcome).toBe('stale-epoch')
    expect(applied).toBe(false)
  })

  it('epoch 一致时提交写回', () => {
    const fetchEpoch = getSpaceSessionListEpoch(SPACE)
    let applied = false
    const outcome = commitSpaceSessionListMerge(SPACE, fetchEpoch, () => {
      applied = true
    })
    expect(outcome).toBe('committed')
    expect(applied).toBe(true)
  })

  it('observed server ids 可替换读取', () => {
    replaceObservedServerSessionIds(SPACE, ['a', 'b'])
    expect([...getObservedServerSessionIds(SPACE)].sort()).toEqual(['a', 'b'])
  })
})
