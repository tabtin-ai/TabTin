import { describe, expect, it } from 'vitest'
import { formatPercentCellValue, parsePercentPointsToRatio } from '../cellValueUtils'

describe('formatPercentCellValue', () => {
  it('returns empty for nullish / blank', () => {
    expect(formatPercentCellValue(null)).toBe('')
    expect(formatPercentCellValue(undefined)).toBe('')
    expect(formatPercentCellValue('')).toBe('')
  })

  it('shows integers without trailing zeros', () => {
    expect(formatPercentCellValue(0.12)).toBe('12%')
    expect(formatPercentCellValue(1)).toBe('100%')
    expect(formatPercentCellValue(0)).toBe('0%')
  })

  it('keeps meaningful fraction digits up to two places', () => {
    expect(formatPercentCellValue(0.123)).toBe('12.3%')
    expect(formatPercentCellValue(0.1234)).toBe('12.34%')
  })

  it('rounds beyond two fraction digits instead of padding', () => {
    expect(formatPercentCellValue(0.12345)).toBe('12.35%')
    expect(formatPercentCellValue(0.1)).toBe('10%')
  })

  it('stringifies non-numeric input', () => {
    expect(formatPercentCellValue('n/a')).toBe('n/a')
  })
})

describe('parsePercentPointsToRatio', () => {
  it('returns null for empty', () => {
    expect(parsePercentPointsToRatio(null)).toBeNull()
    expect(parsePercentPointsToRatio(undefined)).toBeNull()
    expect(parsePercentPointsToRatio('')).toBeNull()
    expect(parsePercentPointsToRatio('%')).toBeNull()
  })

  it('treats numbers as percent points', () => {
    expect(parsePercentPointsToRatio(12)).toBeCloseTo(0.12)
    expect(parsePercentPointsToRatio(12.5)).toBeCloseTo(0.125)
    expect(parsePercentPointsToRatio(0)).toBe(0)
  })

  it('parses percent-point strings with optional %', () => {
    expect(parsePercentPointsToRatio('12')).toBeCloseTo(0.12)
    expect(parsePercentPointsToRatio('12%')).toBeCloseTo(0.12)
    expect(parsePercentPointsToRatio('12.5 %')).toBeCloseTo(0.125)
  })

  it('returns null for non-numeric strings', () => {
    expect(parsePercentPointsToRatio('n/a')).toBeNull()
  })
})
