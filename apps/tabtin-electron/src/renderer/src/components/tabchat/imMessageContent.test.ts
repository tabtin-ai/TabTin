import { describe, expect, it } from 'vitest'

import {
  getIMMessageContentByteLength,
  IM_MESSAGE_CONTENT_MAX_BYTES,
  isIMMessageContentWithinLimit,
} from './imMessageContent'

describe('IM message content limit', () => {
  it('uses the Tencent UTF-8 byte budget rather than JavaScript string length', () => {
    expect(getIMMessageContentByteLength('字')).toBe(3)
    expect(getIMMessageContentByteLength('😀')).toBe(4)
  })

  it('accepts content at the client budget and rejects content one byte over it', () => {
    expect(isIMMessageContentWithinLimit('a'.repeat(IM_MESSAGE_CONTENT_MAX_BYTES))).toBe(true)
    expect(isIMMessageContentWithinLimit('a'.repeat(IM_MESSAGE_CONTENT_MAX_BYTES + 1))).toBe(false)
  })

  it('rejects the roughly 5,000-character Chinese payload from the regression', () => {
    expect(isIMMessageContentWithinLimit('字'.repeat(5_000))).toBe(false)
  })
})
