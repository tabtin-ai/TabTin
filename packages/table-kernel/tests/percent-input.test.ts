import { describe, expect, it } from 'vitest'
import { formatFieldValue, parsePercentInputToRatio } from '../src/field-types/index.js'

describe('parsePercentInputToRatio', () => {
  it('keeps stored ratios as numbers', () => {
    expect(parsePercentInputToRatio(0.12)).toBeCloseTo(0.12)
    expect(parsePercentInputToRatio(1)).toBe(1)
  })

  it('treats string input as percent points', () => {
    expect(parsePercentInputToRatio('12')).toBeCloseTo(0.12)
    expect(parsePercentInputToRatio('12%')).toBeCloseTo(0.12)
    expect(parsePercentInputToRatio('12.5 %')).toBeCloseTo(0.125)
  })

  it('returns null for empty / invalid', () => {
    expect(parsePercentInputToRatio(null)).toBeNull()
    expect(parsePercentInputToRatio('')).toBeNull()
    expect(parsePercentInputToRatio('%')).toBeNull()
    expect(parsePercentInputToRatio('abc')).toBeNull()
  })
})

describe('formatFieldValue(percent)', () => {
  it('matches parsePercentInputToRatio', () => {
    expect(formatFieldValue('percent', 0.12)).toBeCloseTo(0.12)
    expect(formatFieldValue('percent', '12')).toBeCloseTo(0.12)
    expect(formatFieldValue('percent', '12%')).toBeCloseTo(0.12)
  })
})
