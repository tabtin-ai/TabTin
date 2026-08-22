import { describe, expect, it } from 'vitest'
import {
  parseYearMonthFromDateKey,
  resolveCalendarAnchorMonth,
} from './calendarAnchorMonth'

describe('parseYearMonthFromDateKey', () => {
  it('parses YYYY-MM-DD to 0-based month', () => {
    expect(parseYearMonthFromDateKey('2026-06-11')).toEqual({ year: 2026, month: 5 })
  })

  it('rejects invalid keys', () => {
    expect(parseYearMonthFromDateKey('')).toBeNull()
    expect(parseYearMonthFromDateKey('2026-13-01')).toBeNull()
  })
})

describe('resolveCalendarAnchorMonth', () => {
  const today = new Date(2026, 6, 10) // 2026-07-10

  it('returns today when date_field is not configured', () => {
    expect(
      resolveCalendarAnchorMonth({
        needsConfig: true,
        metadata: null,
        isWaitingForCalendarPayload: false,
        today,
      }),
    ).toEqual({ year: 2026, month: 6 })
  })

  it('waits (null) until calendar payload arrives', () => {
    expect(
      resolveCalendarAnchorMonth({
        needsConfig: false,
        metadata: null,
        isWaitingForCalendarPayload: true,
        today,
      }),
    ).toBeNull()
  })

  it('anchors to date_bounds.max month even when today is later', () => {
    expect(
      resolveCalendarAnchorMonth({
        needsConfig: false,
        metadata: {
          view_type: 'calendar',
          date_bounds: { min: '2026-06-10', max: '2026-06-11' },
        },
        isWaitingForCalendarPayload: false,
        today,
      }),
    ).toEqual({ year: 2026, month: 5 })
  })

  it('falls back to today when date_bounds is null (empty table)', () => {
    expect(
      resolveCalendarAnchorMonth({
        needsConfig: false,
        metadata: {
          view_type: 'calendar',
          date_bounds: null,
        },
        isWaitingForCalendarPayload: false,
        today,
      }),
    ).toEqual({ year: 2026, month: 6 })
  })

  it('does not prefer a stale date_range over date_bounds', () => {
    // 回归：曾把 recordsQuery.date_range（今天）排在 bounds 前面，导致永远锁在当前月
    expect(
      resolveCalendarAnchorMonth({
        needsConfig: false,
        metadata: {
          view_type: 'calendar',
          date_range: '2026-07-01,2026-07-31',
          date_bounds: { min: '2026-06-10', max: '2026-06-11' },
        },
        isWaitingForCalendarPayload: false,
        today,
      }),
    ).toEqual({ year: 2026, month: 5 })
  })

  it('falls back to today for legacy calendar payload without date_bounds', () => {
    expect(
      resolveCalendarAnchorMonth({
        needsConfig: false,
        metadata: {
          view_type: 'calendar',
          date_field: 'fld',
        },
        isWaitingForCalendarPayload: false,
        today,
      }),
    ).toEqual({ year: 2026, month: 6 })
  })

  it('falls back to max occurrence date when legacy payload has no date_bounds', () => {
    expect(
      resolveCalendarAnchorMonth({
        needsConfig: false,
        metadata: {
          view_type: 'calendar',
          date_field: 'fld',
        },
        records: [
          { date: '2026-06-10' },
          { date: '2026-06-11' },
          { date: '2026-05-01' },
        ],
        isWaitingForCalendarPayload: false,
        today,
      }),
    ).toEqual({ year: 2026, month: 5 })
  })
})
