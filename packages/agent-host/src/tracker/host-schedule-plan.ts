export const HOST_TRACKER_MISFIRE_GRACE_MS = 600_000
export const HOST_TRACKER_DEFAULT_CRON_TIMEZONE = 'Asia/Shanghai'

export type HostScheduleItem = {
  trackerId: string
  triggerType: string
  triggerConfig: Record<string, unknown>
  lastRunAt?: string | null
  createdAt?: string | null
}

export type HostSchedulePlan = {
  trackerId: string
  dueMs: number
  shouldFire: boolean
}

export function planHostSchedule(
  item: HostScheduleItem,
  nowMs: number,
): HostSchedulePlan | null {
  const triggerType = item.triggerType.trim()
  const config = item.triggerConfig ?? {}
  if (triggerType === 'at') {
    return planAt(item.trackerId, config, item.lastRunAt, nowMs)
  }
  if (triggerType === 'interval') {
    return planInterval(item.trackerId, config, item.lastRunAt, item.createdAt, nowMs)
  }
  if (triggerType === 'cron') {
    return planCron(item.trackerId, config, item.lastRunAt, nowMs)
  }
  return null
}

function catchupPolicy(config: Record<string, unknown>): string {
  return String(config.catchup_policy || 'run_once')
}

function isLate(dueMs: number, nowMs: number): boolean {
  return nowMs - dueMs > HOST_TRACKER_MISFIRE_GRACE_MS
}

function planAt(
  trackerId: string,
  config: Record<string, unknown>,
  lastRunAt: string | null | undefined,
  nowMs: number,
): HostSchedulePlan | null {
  if (lastRunAt) return null
  const dueMs = parseInstant(config.at)
  if (dueMs == null) return null
  if (dueMs > nowMs) {
    return { trackerId, dueMs, shouldFire: true }
  }
  if (isLate(dueMs, nowMs) && catchupPolicy(config) === 'skip') {
    return null
  }
  return { trackerId, dueMs: nowMs, shouldFire: true }
}

function planInterval(
  trackerId: string,
  config: Record<string, unknown>,
  lastRunAt: string | null | undefined,
  createdAt: string | null | undefined,
  nowMs: number,
): HostSchedulePlan | null {
  const seconds = Number(config.interval_seconds ?? config.seconds ?? 3600)
  if (!Number.isFinite(seconds) || seconds <= 0) return null
  const stepMs = seconds * 1000
  const anchorMs = parseInstant(lastRunAt) ?? parseInstant(createdAt)
  if (anchorMs == null) {
    return { trackerId, dueMs: nowMs + stepMs, shouldFire: true }
  }
  let dueMs = anchorMs + stepMs
  if (dueMs > nowMs) {
    return { trackerId, dueMs, shouldFire: true }
  }
  if (isLate(dueMs, nowMs) && catchupPolicy(config) === 'skip') {
    while (dueMs <= nowMs) dueMs += stepMs
    return { trackerId, dueMs, shouldFire: true }
  }
  return { trackerId, dueMs: nowMs, shouldFire: true }
}

function planCron(
  trackerId: string,
  config: Record<string, unknown>,
  lastRunAt: string | null | undefined,
  nowMs: number,
): HostSchedulePlan | null {
  const expression = String(config.cron_expression || config.expression || '').trim()
  if (!expression) return null
  const timezone = String(config.timezone || '').trim() || HOST_TRACKER_DEFAULT_CRON_TIMEZONE
  const afterMs = parseInstant(lastRunAt) ?? nowMs
  const dueMs = nextCronOccurrence(expression, timezone, afterMs)
  if (dueMs == null) return null
  if (dueMs > nowMs) {
    return { trackerId, dueMs, shouldFire: true }
  }
  if (isLate(dueMs, nowMs) && catchupPolicy(config) === 'skip') {
    const later = nextCronOccurrence(expression, timezone, nowMs)
    if (later == null) return null
    return { trackerId, dueMs: later, shouldFire: true }
  }
  return { trackerId, dueMs: nowMs, shouldFire: true }
}

function parseInstant(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : ms
}

function nextCronOccurrence(expression: string, timezone: string, afterMs: number): number | null {
  const fields = parseCronExpression(expression)
  if (!fields) return null
  let cursor = Math.floor(afterMs / 60_000) * 60_000 + 60_000
  const limit = afterMs + 366 * 24 * 60 * 60 * 1000
  while (cursor <= limit) {
    if (cronMatches(fields, timezone, cursor)) return cursor
    cursor += 60_000
  }
  return null
}

type CronFields = {
  minute: Set<number>
  hour: Set<number>
  day: Set<number>
  month: Set<number>
  weekday: Set<number>
}

function parseCronExpression(expression: string): CronFields | null {
  const parts = expression.split(/\s+/).filter(Boolean)
  if (parts.length !== 5) return null
  try {
    return {
      minute: parseCronField(parts[0], 0, 59),
      hour: parseCronField(parts[1], 0, 23),
      day: parseCronField(parts[2], 1, 31),
      month: parseCronField(parts[3], 1, 12),
      weekday: parseCronField(parts[4], 0, 7),
    }
  } catch {
    return null
  }
}

function parseCronField(field: string, min: number, max: number): Set<number> {
  const values = new Set<number>()
  for (const token of field.split(',')) {
    const [rangePart, stepPart] = token.split('/')
    const step = stepPart ? Number(stepPart) : 1
    if (!Number.isInteger(step) || step <= 0) throw new Error('invalid cron step')
    if (rangePart === '*') {
      for (let value = min; value <= max; value += step) values.add(value)
      continue
    }
    const [startRaw, endRaw] = rangePart.split('-')
    const start = Number(startRaw)
    const end = endRaw == null ? start : Number(endRaw)
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end) {
      throw new Error('invalid cron range')
    }
    for (let value = start; value <= end; value += step) values.add(value)
  }
  return values
}

function cronMatches(fields: CronFields, timezone: string, atMs: number): boolean {
  const parts = zonedDateParts(atMs, timezone)
  if (!parts) return false
  const weekday = fields.weekday.has(parts.weekday) || (parts.weekday === 0 && fields.weekday.has(7))
  return (
    fields.minute.has(parts.minute)
    && fields.hour.has(parts.hour)
    && fields.day.has(parts.day)
    && fields.month.has(parts.month)
    && weekday
  )
}

function zonedDateParts(atMs: number, timezone: string): {
  minute: number
  hour: number
  day: number
  month: number
  weekday: number
} | null {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
    })
    const mapped = Object.fromEntries(
      formatter.formatToParts(new Date(atMs)).map((part) => [part.type, part.value]),
    )
    const weekdayMap: Record<string, number> = {
      Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
    }
    return {
      minute: Number(mapped.minute),
      hour: Number(mapped.hour),
      day: Number(mapped.day),
      month: Number(mapped.month),
      weekday: weekdayMap[mapped.weekday ?? ''] ?? -1,
    }
  } catch {
    return null
  }
}
