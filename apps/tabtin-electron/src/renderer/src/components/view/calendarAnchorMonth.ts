/**
 * 日历视图首次进入的锚月解析。
 *
 * 产品口径：用 date_field 最晚有值日所在月；全空 / 未配置 → 今天。
 * 故意不读 recordsQuery.date_range——否则会继承上一视图的「今天」窗口，
 * 把 date_bounds.max 永久盖住。
 */

export type CalendarAnchorMonth = { year: number; month: number } // month: 0–11

export function parseYearMonthFromDateKey(
  dateKey: string,
): CalendarAnchorMonth | null {
  const [y, m] = dateKey.split('-').map(Number)
  if (!y || !m || m < 1 || m > 12) return null
  return { year: y, month: m - 1 }
}

/** 从日历 occurrence wrapper 列表推算最晚日期所在月（旧后端无 date_bounds 时的兜底）。 */
export function maxMonthFromCalendarRecords(
  records: unknown[] | null | undefined,
): CalendarAnchorMonth | null {
  if (!Array.isArray(records) || records.length === 0) return null
  let maxKey: string | null = null
  for (const item of records) {
    if (!item || typeof item !== 'object') continue
    const dateRaw = (item as { date?: unknown }).date
    if (typeof dateRaw !== 'string' || dateRaw.length < 10) continue
    const key = dateRaw.slice(0, 10)
    if (!maxKey || key > maxKey) maxKey = key
  }
  return maxKey ? parseYearMonthFromDateKey(maxKey) : null
}

export function resolveCalendarAnchorMonth(input: {
  needsConfig: boolean
  metadata: Record<string, unknown> | null | undefined
  /** 仍在等首包时传 true，返回 null 避免先锚到今天再跳 */
  isWaitingForCalendarPayload: boolean
  /** 旧后端无 date_bounds 时，用首包 occurrence 推算 */
  records?: unknown[] | null
  today?: Date
}): CalendarAnchorMonth | null {
  const today = input.today ?? new Date()
  const todayAnchor: CalendarAnchorMonth = {
    year: today.getFullYear(),
    month: today.getMonth(),
  }

  if (input.needsConfig) {
    return todayAnchor
  }

  const meta = input.metadata
  if (!meta || meta.view_type !== 'calendar') {
    return input.isWaitingForCalendarPayload ? null : todayAnchor
  }

  if ('date_bounds' in meta) {
    const bounds = meta.date_bounds as { min?: unknown; max?: unknown } | null
    const maxRaw = bounds && typeof bounds.max === 'string' ? bounds.max : null
    if (maxRaw) {
      const parsed = parseYearMonthFromDateKey(maxRaw)
      if (parsed) return parsed
    }
    return todayAnchor
  }

  // 旧后端：从 occurrence 日期推算
  const fromRecords = maxMonthFromCalendarRecords(input.records)
  if (fromRecords) return fromRecords

  return todayAnchor
}
