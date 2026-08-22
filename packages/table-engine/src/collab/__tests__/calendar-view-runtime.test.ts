import { describe, expect, it } from 'vitest'
import { buildCalendarViewRecords, parseIsoDate } from '../calendar-view-runtime'

const dateField = {
  id: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
  id_hex: 'dddddddddddddddddddddddddddddddd',
  name: '日期',
  field_type: 'date' as const,
}

const titleField = {
  id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  id_hex: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  name: '标题',
  field_type: 'text' as const,
}

const makeRecord = (values: Record<string, unknown>) =>
  new Map<string, unknown>(Object.entries(values))

const calendarView = {
  id: 'view-cal',
  table_id: 'table-1',
  name: '日历',
  view_type: 'calendar' as const,
  filters: [],
  sorts: [],
  groups: [],
  visible_fields: [],
  field_order: [],
  column_meta: {},
  config: { date_field: dateField.id },
  is_shared: false,
  is_locked: false,
  order: 0,
  created_at: '',
}

describe('buildCalendarViewRecords', () => {
  it('parseIsoDate handles YYYY-MM-DD', () => {
    const d = parseIsoDate('2025-06-15')
    expect(d?.getFullYear()).toBe(2025)
    expect(d?.getMonth()).toBe(5)
    expect(d?.getDate()).toBe(15)
  })

  it('expands single-day events into occurrence wrappers', () => {
    const recordsSnapshot = new Map([
      ['r1', makeRecord({ [dateField.id_hex]: '2025-06-10', [titleField.id_hex]: 'A' })],
      ['r2', makeRecord({ [dateField.id_hex]: '2025-06-20', [titleField.id_hex]: 'B' })],
    ])

    const result = buildCalendarViewRecords({
      tableId: 'table-1',
      recordsSnapshot,
      rowOrder: ['r1', 'r2'],
      fieldsMeta: [titleField, dateField],
      view: calendarView,
      dateRange: '2025-06-01,2025-06-30',
      page: 1,
      pageSize: 50,
    })

    expect(result.metadata?.pagination_unit).toBe('record')
    expect(result.total).toBe(2)
    expect(result.records).toHaveLength(2)
    const first = result.records[0] as unknown as { date: string; record: { id: string } }
    expect(first.date).toBe('2025-06-10')
    expect(first.record.id).toBe('r1')
  })

  it('filters records outside date_range', () => {
    const recordsSnapshot = new Map([
      ['r1', makeRecord({ [dateField.id_hex]: '2025-07-01' })],
    ])

    const result = buildCalendarViewRecords({
      tableId: 'table-1',
      recordsSnapshot,
      rowOrder: ['r1'],
      fieldsMeta: [dateField],
      view: calendarView,
      dateRange: '2025-06-01,2025-06-30',
      page: 1,
      pageSize: 50,
    })

    expect(result.total).toBe(0)
    expect(result.records).toHaveLength(0)
    // date_bounds 不受 date_range 裁剪：仍反映全表最晚日期
    expect(result.metadata?.date_bounds).toEqual({ min: '2025-07-01', max: '2025-07-01' })
  })

  it('exposes date_bounds min/max from date_field across all records', () => {
    const recordsSnapshot = new Map([
      ['r1', makeRecord({ [dateField.id_hex]: '2025-06-10' })],
      ['r2', makeRecord({ [dateField.id_hex]: '2025-04-01' })],
      ['r3', makeRecord({ [dateField.id_hex]: '2025-06-11' })],
    ])

    const result = buildCalendarViewRecords({
      tableId: 'table-1',
      recordsSnapshot,
      rowOrder: ['r1', 'r2', 'r3'],
      fieldsMeta: [dateField],
      view: calendarView,
      dateRange: '2025-06-01,2025-06-30',
      page: 1,
      pageSize: 50,
    })

    expect(result.metadata?.date_bounds).toEqual({ min: '2025-04-01', max: '2025-06-11' })
  })

  it('uses cumulative record pagination for load more', () => {
    const recordsSnapshot = new Map(
      Array.from({ length: 5 }, (_, i) => [
        `r${i}`,
        makeRecord({ [dateField.id_hex]: `2025-06-${String(i + 1).padStart(2, '0')}` }),
      ]),
    )

    const page1 = buildCalendarViewRecords({
      tableId: 'table-1',
      recordsSnapshot,
      rowOrder: ['r0', 'r1', 'r2', 'r3', 'r4'],
      fieldsMeta: [dateField],
      view: calendarView,
      dateRange: '2025-06-01,2025-06-30',
      page: 1,
      pageSize: 2,
    })
    const page2 = buildCalendarViewRecords({
      tableId: 'table-1',
      recordsSnapshot,
      rowOrder: ['r0', 'r1', 'r2', 'r3', 'r4'],
      fieldsMeta: [dateField],
      view: calendarView,
      dateRange: '2025-06-01,2025-06-30',
      page: 2,
      pageSize: 2,
    })

    expect(page1.total).toBe(5)
    expect(page1.records).toHaveLength(2)
    expect(page2.records).toHaveLength(4)
  })
})
