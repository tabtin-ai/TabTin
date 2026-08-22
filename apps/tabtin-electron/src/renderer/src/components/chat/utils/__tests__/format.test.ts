import { describe, expect, it } from 'vitest'
import { formatDuration } from '../format'

describe('formatDuration', () => {
  it('空值不显示', () => {
    expect(formatDuration(undefined)).toBe('')
    expect(formatDuration(null)).toBe('')
  })

  it('0ms 显示为 <1ms，1ms 仍显示 1ms', () => {
    expect(formatDuration(0)).toBe('<1ms')
    expect(formatDuration(1)).toBe('1ms')
  })
})
