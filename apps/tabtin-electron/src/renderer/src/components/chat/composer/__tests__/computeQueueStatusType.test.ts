import { describe, expect, it } from 'vitest'
import { computeQueueStatusType } from '../useChatInputDerivedSendState'

describe('computeQueueStatusType', () => {
  it('无队列时不显示黄条', () => {
    expect(computeQueueStatusType(0, false)).toBeNull()
    expect(computeQueueStatusType(0, true)).toBeNull()
  })

  it('有队列时与抽屉同闸：不依赖 isStreaming', () => {
    expect(computeQueueStatusType(1, false)).toBe('streaming')
    expect(computeQueueStatusType(2, true)).toBe('offline')
  })
})
