import { describe, expect, it, vi } from 'vitest'
import { beginSendScroll } from '../sendScrollPolicy'

describe('beginSendScroll', () => {
  it('follows immediately without leaving a delayed override for a mounted list', () => {
    const requestFollow = vi.fn()

    expect(beginSendScroll({ messageCount: 8, requestFollow })).toBeNull()
    expect(requestFollow).toHaveBeenCalledTimes(1)
  })

  it('keeps one post-mount fallback when sending the first message', () => {
    const requestFollow = vi.fn()

    expect(beginSendScroll({ messageCount: 0, requestFollow })).toBe(0)
    expect(requestFollow).toHaveBeenCalledTimes(1)
  })
})
