import { describe, expect, it } from 'vitest'
import { differenceInCalendarDays } from 'date-fns'
import {
  formatScheduleAriaLabel,
  getMonthGridRange,
  getWeekRange,
  groupOccurrencesByDate,
  toScheduleDateKey,
  toScheduleQueryDate,
} from './trackerScheduleWindow'
import type { TrackerScheduleOccurrence } from '@/services/trackerApi'

describe('trackerScheduleWindow', () => {
  it('aria 摘要使用当前 locale 的列表分隔符', () => {
    expect(formatScheduleAriaLabel(['09:00', 'Task', null, 'Pending'], 'en-US'))
      .toBe('09:00, Task, and Pending')
    expect(formatScheduleAriaLabel(['09:00', '任务', '待执行'], 'zh-CN'))
      .toBe('09:00、任务和待执行')
  })

  it('查询边界是 timezone-aware ISO datetime', () => {
    const localBoundary = new Date(2026, 6, 20, 0, 0, 0, 0)
    const query = toScheduleQueryDate(localBoundary)
    expect(query.startsWith(`${toScheduleDateKey(localBoundary)}T00:00:00.000`)).toBe(true)
    expect(query).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(Z|[+-]\d{2}:\d{2})$/)
    expect(Number.isNaN(Date.parse(query))).toBe(false)
  })

  it('DST 月格两端保留各自本地日期，日历跨度仍为 42 天', () => {
    const { from, to } = getMonthGridRange(new Date(2026, 9, 15))
    const fromQuery = toScheduleQueryDate(from)
    const toQuery = toScheduleQueryDate(to)

    expect(fromQuery.startsWith(`${toScheduleDateKey(from)}T00:00:00.000`)).toBe(true)
    expect(toQuery.startsWith(`${toScheduleDateKey(to)}T00:00:00.000`)).toBe(true)
    expect(differenceInCalendarDays(to, from)).toBe(42)

    if (Intl.DateTimeFormat().resolvedOptions().timeZone === 'Europe/London') {
      expect(fromQuery).toMatch(/\+01:00$/)
      expect(toQuery).toMatch(/\+00:00$/)
    }
  })

  it('周窗使用 [周一 00:00, 下周一 00:00) 并覆盖完整 7 天', () => {
    // 2026-07-22 周三 → 半开窗 [2026-07-20(一), 2026-07-27(一))
    const { from, to, days } = getWeekRange(new Date(2026, 6, 22))
    expect(toScheduleDateKey(from)).toBe('2026-07-20')
    expect(toScheduleDateKey(to)).toBe('2026-07-27')
    expect(differenceInCalendarDays(to, from)).toBe(7)
    expect(days).toHaveLength(7)
    expect(days.map(toScheduleDateKey)).toEqual([
      '2026-07-20',
      '2026-07-21',
      '2026-07-22',
      '2026-07-23',
      '2026-07-24',
      '2026-07-25',
      '2026-07-26',
    ])
    const lastDayOccurrence = new Date(2026, 6, 26, 23, 59, 59)
    expect(lastDayOccurrence >= from && lastDayOccurrence < to).toBe(true)
  })

  it('月格使用 [首格周一 00:00, 首格+42天 00:00) 并覆盖末格', () => {
    // 2026-07 月：7/1 周三 → 半开窗 [6/29(一), 8/10(一))
    const { from, to, days } = getMonthGridRange(new Date(2026, 6, 15))
    expect(toScheduleDateKey(from)).toBe('2026-06-29')
    expect(toScheduleDateKey(to)).toBe('2026-08-10')
    expect(differenceInCalendarDays(to, from)).toBe(42)
    expect(days).toHaveLength(42)
    expect(toScheduleDateKey(days.at(-1)!)).toBe('2026-08-09')
    const lastDayOccurrence = new Date(2026, 7, 9, 23, 59, 59)
    expect(lastDayOccurrence >= from && lastDayOccurrence < to).toBe(true)
  })

  it('分组前按 scheduled_at、tracker_id 稳定排序', () => {
    const occurrences: TrackerScheduleOccurrence[] = [
      mkOcc('c', new Date(2026, 6, 23, 2, 0).toISOString()),
      mkOcc('b', new Date(2026, 6, 22, 1, 0).toISOString()),
      mkOcc('a', new Date(2026, 6, 22, 1, 0).toISOString()),
    ]
    const grouped = groupOccurrencesByDate(occurrences)
    expect([...grouped.keys()]).toEqual(['2026-07-22', '2026-07-23'])
    expect(grouped.get('2026-07-22')?.map(occ => occ.tracker_id)).toEqual(['a', 'b'])
  })

  it('scheduled_at 含不同 offset 时按真实时间轴排序', () => {
    const occurrences: TrackerScheduleOccurrence[] = [
      mkOcc('later', '2026-07-21T18:00:00.000Z'),
      mkOcc('earlier', '2026-07-22T01:00:00.000+08:00'),
    ]

    const ordered = [...groupOccurrencesByDate(occurrences).values()].flat()
    expect(ordered.map(occ => occ.tracker_id)).toEqual(['earlier', 'later'])
  })
})

function mkOcc(id: string, scheduledAt: string): TrackerScheduleOccurrence {
  return {
    tracker_id: id,
    name: id,
    space_id: 'space-1',
    space_name: 'Space',
    scheduled_at: scheduledAt,
    status: 'active',
    trigger_type: 'cron',
    timezone: 'Asia/Shanghai',
  }
}
