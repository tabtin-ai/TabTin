import { describe, expect, it } from 'vitest'

import {
  applyTimeToDate,
  buildDateInputPlaceholder,
  formatStoredDateValue,
  formatTimeFromDate,
  normalizeDateFormatting,
  parseTimeString,
  toStoredDateValue,
} from './utils'

describe('date formatting utils', () => {
  it('preserves second-level time formats', () => {
    const formatting = normalizeDateFormatting({
      date: 'YYYY-MM-DD',
      time: 'HH:mm:ss',
      timeZone: 'Asia/Shanghai',
    })

    expect(formatting.time).toBe('HH:mm:ss')
    expect(buildDateInputPlaceholder(formatting)).toBe('YYYY-MM-DD HH:mm:ss')
  })

  it('parses and applies seconds from time input', () => {
    expect(parseTimeString('12:34:56')).toEqual([12, 34, 56])

    const next = applyTimeToDate(new Date(2026, 2, 7), '12:34:56')
    expect(next.getHours()).toBe(12)
    expect(next.getMinutes()).toBe(34)
    expect(next.getSeconds()).toBe(56)
  })

  it('formats time values with seconds only when the format asks for them', () => {
    const value = new Date(2026, 2, 7, 1, 2, 3)

    expect(formatTimeFromDate(value, 'HH:mm')).toBe('01:02')
    expect(formatTimeFromDate(value, 'HH:mm:ss')).toBe('01:02:03')
  })

  it('shows midnight time for date-only stored values when time display is enabled', () => {
    const formatting = normalizeDateFormatting({
      date: 'YYYY-MM-DD',
      time: 'HH:mm:ss',
      timeZone: 'Asia/Shanghai',
    })

    expect(formatStoredDateValue('2026-08-09', formatting)).toBe('2026-08-09 00:00:00')
  })

  it('stores date-only values when the time picker is disabled', () => {
    const formatting = normalizeDateFormatting({
      date: 'YYYY-MM-DD',
      time: 'None',
      timeZone: 'Asia/Shanghai',
    })
    const value = new Date(2026, 7, 9, 11, 22, 33)
    const stored = toStoredDateValue(value, formatting)

    expect(stored).toBe('2026-08-09')
    expect(formatStoredDateValue(stored, { ...formatting, time: 'HH:mm:ss' })).toBe('2026-08-09 00:00:00')
    expect(toStoredDateValue(value, formatting, true)).toBe('2026-08-09')
  })

  it('stores timestamps when time display is enabled', () => {
    const formatting = normalizeDateFormatting({
      date: 'YYYY-MM-DD',
      time: 'HH:mm:ss',
      timeZone: 'Asia/Shanghai',
    })
    const value = new Date(2026, 7, 9, 11, 22, 33)
    const stored = toStoredDateValue(value, formatting)

    expect(stored).toContain('T')
    expect(formatStoredDateValue(stored, formatting)).toBe('2026-08-09 11:22:33')
  })
})
