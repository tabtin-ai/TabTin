import { describe, expect, it } from 'vitest'
import { shouldScrollToSession } from '../sessionListScroll'

const virtualItems = [
  { index: 2, start: 72, size: 36 },
  { index: 3, start: 108, size: 36 },
]

describe('session list scroll targeting', () => {
  it('does not scroll when the target item intersects the viewport', () => {
    expect(shouldScrollToSession({
      targetSessionId: 's-3',
      scrollIntent: { sessionId: 's-3', sequence: 1 },
      lastConsumedIntentSequence: null,
      targetIndex: 3,
      virtualItems,
      scrollTop: 80,
      viewportHeight: 120,
    })).toBe(false)
  })

  it('scrolls once when the target item is outside the viewport', () => {
    expect(shouldScrollToSession({
      targetSessionId: 's-8',
      scrollIntent: { sessionId: 's-8', sequence: 1 },
      lastConsumedIntentSequence: null,
      targetIndex: 8,
      virtualItems: [{ index: 8, start: 480, size: 36 }],
      scrollTop: 80,
      viewportHeight: 120,
    })).toBe(true)
  })

  it('does not scroll without an explicit selection intent', () => {
    expect(shouldScrollToSession({
      targetSessionId: 's-8',
      scrollIntent: null,
      lastConsumedIntentSequence: null,
      targetIndex: 8,
      virtualItems: [{ index: 8, start: 480, size: 36 }],
      scrollTop: 80,
      viewportHeight: 120,
    })).toBe(false)
  })

  it('does not repeat an already consumed selection intent', () => {
    expect(shouldScrollToSession({
      targetSessionId: 's-8',
      scrollIntent: { sessionId: 's-8', sequence: 1 },
      lastConsumedIntentSequence: 1,
      targetIndex: 8,
      virtualItems: [{ index: 8, start: 480, size: 36 }],
      scrollTop: 80,
      viewportHeight: 120,
    })).toBe(false)
  })

  it('allows a later explicit selection of the same session', () => {
    expect(shouldScrollToSession({
      targetSessionId: 's-8',
      scrollIntent: { sessionId: 's-8', sequence: 2 },
      lastConsumedIntentSequence: 1,
      targetIndex: 8,
      virtualItems: [{ index: 8, start: 480, size: 36 }],
      scrollTop: 80,
      viewportHeight: 120,
    })).toBe(true)
  })
})
