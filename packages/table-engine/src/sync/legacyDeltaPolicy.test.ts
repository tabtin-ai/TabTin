import { describe, expect, it } from 'vitest'
import { shouldConsumeTableRecordDelta } from './legacyDeltaPolicy'

describe('shouldConsumeTableRecordDelta', () => {
  it('does not consume table record deltas in collab mode', () => {
    expect(shouldConsumeTableRecordDelta('collab')).toBe(false)
  })

  it('consumes table record deltas only in legacy mode', () => {
    expect(shouldConsumeTableRecordDelta('legacy')).toBe(true)
  })
})
