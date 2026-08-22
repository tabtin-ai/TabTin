import {
  addDays,
  eachDayOfInterval,
  startOfMonth,
  startOfWeek,
} from 'date-fns'
import type { TrackerScheduleOccurrence } from '@/services/trackerApi'

export interface ScheduleDateRange {
  from: Date
  to: Date
  days: Date[]
}

export function formatScheduleAriaLabel(
  parts: Array<string | null | undefined>,
  locale?: string,
): string {
  return new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' })
    .format(parts.filter((part): part is string => Boolean(part)))
}

/** 本地日历日 key：YYYY-MM-DD */
export function toScheduleDateKey(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** 查询串用的 aware ISO：保留本地日历字段与该时刻的 UTC offset。 */
export function toScheduleQueryDate(date: Date): string {
  const pad2 = (value: number) => String(value).padStart(2, '0')
  const offsetMinutes = -date.getTimezoneOffset()
  const offsetSign = offsetMinutes >= 0 ? '+' : '-'
  const offsetAbs = Math.abs(offsetMinutes)
  const offset = `${offsetSign}${pad2(Math.floor(offsetAbs / 60))}:${pad2(offsetAbs % 60)}`

  return [
    `${toScheduleDateKey(date)}T`,
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}.`,
    `${String(date.getMilliseconds()).padStart(3, '0')}${offset}`,
  ].join('')
}

/** 周窗：本地时间 [周一 00:00, 下周一 00:00) */
export function getWeekRange(anchor: Date): ScheduleDateRange {
  const from = startOfWeek(anchor, { weekStartsOn: 1 })
  const to = addDays(from, 7)
  const days = eachDayOfInterval({ start: from, end: addDays(to, -1) })
  return { from, to, days }
}

/** 月格可见窗：本地时间 [首格周一 00:00, 首格+42天 00:00) */
export function getMonthGridRange(anchor: Date): ScheduleDateRange {
  const monthStart = startOfMonth(anchor)
  const from = startOfWeek(monthStart, { weekStartsOn: 1 })
  const to = addDays(from, 42)
  const days = eachDayOfInterval({ start: from, end: addDays(to, -1) })
  return { from, to, days }
}

export function groupOccurrencesByDate(
  occurrences: TrackerScheduleOccurrence[],
): Map<string, TrackerScheduleOccurrence[]> {
  const map = new Map<string, TrackerScheduleOccurrence[]>()
  const ordered = [...occurrences].sort((a, b) => {
    const byTime = Date.parse(a.scheduled_at) - Date.parse(b.scheduled_at)
    return byTime !== 0 ? byTime : a.tracker_id.localeCompare(b.tracker_id)
  })
  for (const occ of ordered) {
    const key = toScheduleDateKey(new Date(occ.scheduled_at))
    const list = map.get(key)
    if (list) list.push(occ)
    else map.set(key, [occ])
  }
  return map
}
