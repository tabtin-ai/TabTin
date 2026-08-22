import { describe, expect, it } from 'vitest'
import {
  computeQueueStatusType,
  computeShowComposerStopChrome,
} from '../useChatInputDerivedSendState'

describe('computeShowComposerStopChrome ', () => {
  it('streaming 时始终显示停止铬', () => {
    expect(computeShowComposerStopChrome(true, 0)).toBe(true)
    expect(computeShowComposerStopChrome(true, 2)).toBe(true)
  })

  it('在线排队非空且未 streaming 时仍显示停止', () => {
    expect(computeShowComposerStopChrome(false, 1)).toBe(true)
  })

  it('空闲无排队显示发送', () => {
    expect(computeShowComposerStopChrome(false, 0)).toBe(false)
  })
})

describe('computeQueueStatusType', () => {
  it('仅在线 Host 排队触发 streaming 黄条', () => {
    expect(computeQueueStatusType(0)).toBeNull()
    expect(computeQueueStatusType(1)).toBe('streaming')
    expect(computeQueueStatusType(3)).toBe('streaming')
  })
})
