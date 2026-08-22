import type { TableRecord, ViewMeta, ViewRecordsResponse } from '@tabtin/table-core'
import {
  buildSortedCollabViewRecords,
  type BuildCollabViewRecordsInput,
} from './collabViewRuntime'

/** 与 view_calendar_service._MAX_OCCURRENCE_SPAN_DAYS 对齐 */
export const CALENDAR_MAX_OCCURRENCE_SPAN_DAYS = 366

export interface CalendarOccurrenceWrapper {
  date: string
  record: TableRecord
  is_start: boolean
  is_end: boolean
  span_total_days: number
  occurrence_index: number
  dirty: boolean
  truncated: boolean
}

export interface BuildCalendarViewRecordsInput extends BuildCollabViewRecordsInput {
  dateRange?: string | null
}

const parseDateRange = (
  dateRange: string | null | undefined,
): { start: Date | null; end: Date | null } => {
  if (!dateRange || typeof dateRange !== 'string') {
    return { start: null, end: null }
  }
  const parts = dateRange.split(',')
  if (parts.length !== 2) return { start: null, end: null }
  const start = parseIsoDate(parts[0]?.trim())
  const end = parseIsoDate(parts[1]?.trim())
  if (!start || !end) return { start: null, end: null }
  return { start, end }
}

/** 解析 YYYY-MM-DD 或 ISO datetime，取浏览器本地日历日（与 Electron 月格一致）。 */
export const parseIsoDate = (value: unknown): Date | null => {
  if (value == null) return null
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return new Date(value.getFullYear(), value.getMonth(), value.getDate())
  }
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!text) return null
  if (text.length === 10) {
    const [y, m, d] = text.split('-').map(Number)
    if (!y || !m || !d) return null
    return new Date(y, m - 1, d)
  }
  const normalized = text.endsWith('Z') || text.endsWith('z')
    ? `${text.slice(0, -1)}+00:00`
    : text
  const parsed = new Date(normalized)
  if (Number.isNaN(parsed.getTime())) {
    const fallback = text.slice(0, 10)
    const [y, m, d] = fallback.split('-').map(Number)
    if (!y || !m || !d) return null
    return new Date(y, m - 1, d)
  }
  return new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate())
}

const toDateKey = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

const addDays = (d: Date, days: number): Date =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate() + days)

const getRecordFieldValue = (record: TableRecord, fieldId: string): unknown =>
  record.fields?.[fieldId] ?? record.data?.[fieldId] ?? record.data?.[fieldId.replace(/-/g, '')]

const resolveDateFieldId = (view: ViewMeta | null): string | null => {
  if (!view) return null
  const fromConfig = (view.config as Record<string, unknown> | undefined)?.date_field
  return typeof fromConfig === 'string' && fromConfig.length > 0 ? fromConfig : null
}

const resolveEndDateFieldId = (view: ViewMeta | null): string | null => {
  if (!view) return null
  const fromConfig = (view.config as Record<string, unknown> | undefined)?.end_date_field
  return typeof fromConfig === 'string' && fromConfig.length > 0 ? fromConfig : null
}

const fieldNameById = (
  fieldsMeta: BuildCollabViewRecordsInput['fieldsMeta'],
  fieldId: string,
): string | undefined => fieldsMeta.find(f => f.id === fieldId)?.name

const readRecordFieldValue = (
  record: TableRecord,
  fieldId: string,
  fieldName?: string,
): unknown => {
  const direct = getRecordFieldValue(record, fieldId)
  if (direct != null) return direct
  if (fieldName && record.data?.[fieldName] != null) return record.data[fieldName]
  return null
}

const expandOccurrences = (
  record: TableRecord,
  startD: Date,
  endD: Date | null,
  queryStart: Date | null,
  queryEnd: Date | null,
): CalendarOccurrenceWrapper[] => {
  let isDirty = false
  let isTruncated = false
  let effectiveEnd = endD ?? startD

  if (endD && endD.getTime() < startD.getTime()) {
    effectiveEnd = startD
    isDirty = true
  }

  let spanTotal =
    Math.floor((effectiveEnd.getTime() - startD.getTime()) / (24 * 60 * 60 * 1000)) + 1
  if (spanTotal > CALENDAR_MAX_OCCURRENCE_SPAN_DAYS) {
    effectiveEnd = addDays(startD, CALENDAR_MAX_OCCURRENCE_SPAN_DAYS - 1)
    spanTotal = CALENDAR_MAX_OCCURRENCE_SPAN_DAYS
    isTruncated = true
  }

  const occurrenceStart =
    queryStart && queryStart.getTime() > startD.getTime() ? queryStart : startD
  const occurrenceEnd =
    queryEnd && queryEnd.getTime() < effectiveEnd.getTime() ? queryEnd : effectiveEnd

  if (occurrenceStart.getTime() > occurrenceEnd.getTime()) return []

  const leadingOffset = Math.max(
    0,
    Math.floor((occurrenceStart.getTime() - startD.getTime()) / (24 * 60 * 60 * 1000)),
  )

  const wrappers: CalendarOccurrenceWrapper[] = []
  let cur = occurrenceStart
  let idx = 0
  while (cur.getTime() <= occurrenceEnd.getTime()) {
    wrappers.push({
      date: toDateKey(cur),
      record,
      is_start: cur.getTime() === startD.getTime(),
      is_end: cur.getTime() === effectiveEnd.getTime(),
      span_total_days: spanTotal,
      occurrence_index: leadingOffset + idx,
      dirty: isDirty,
      truncated: isTruncated,
    })
    cur = addDays(cur, 1)
    idx += 1
  }
  return wrappers
}

const recordOverlapsRange = (
  record: TableRecord,
  dateFieldId: string,
  endDateFieldId: string | null,
  dateFieldName: string | undefined,
  endDateFieldName: string | undefined,
  queryStart: Date | null,
  queryEnd: Date | null,
): boolean => {
  const startRaw = readRecordFieldValue(record, dateFieldId, dateFieldName)
  const startD = parseIsoDate(startRaw)
  if (!startD) return false

  let endD: Date | null = null
  if (endDateFieldId) {
    endD = parseIsoDate(readRecordFieldValue(record, endDateFieldId, endDateFieldName))
  }

  const effectiveEnd =
    endD && endD.getTime() >= startD.getTime() ? endD : startD

  if (queryStart && queryEnd) {
    if (startD.getTime() > queryEnd.getTime()) return false
    if (effectiveEnd.getTime() < queryStart.getTime()) return false
  }
  return true
}

/**
 * 从 Y.Doc 全量快照派生日历 occurrence wrapper 列表。
 * 分页单位是 TableRecord 行（与后端 metadata.pagination_unit='record' 对齐）。
 */
export function buildCalendarViewRecords(
  input: BuildCalendarViewRecordsInput,
): ViewRecordsResponse {
  const dateFieldId = resolveDateFieldId(input.view)
  const endDateFieldId = resolveEndDateFieldId(input.view)

  if (!dateFieldId) {
    return {
      view: {
        id: String(input.view?.id ?? ''),
        name: String(input.view?.name ?? ''),
        view_type: 'calendar',
        config: input.view?.config ?? {},
      },
      records: [],
      total: 0,
      matched_total: 0,
      page: input.page ?? 1,
      page_size: input.pageSize ?? 100,
      latest_version: 0,
      delta: false,
      has_changes: true,
      metadata: {
        view_type: 'calendar',
        needs_configuration: true,
        missing_fields: ['date_field'],
      },
    }
  }

  const dateFieldName = fieldNameById(input.fieldsMeta, dateFieldId)
  const endDateFieldName = endDateFieldId
    ? fieldNameById(input.fieldsMeta, endDateFieldId)
    : undefined

  const { start: queryStart, end: queryEnd } = parseDateRange(input.dateRange)
  const sorted = buildSortedCollabViewRecords(input)

  let minDate: Date | null = null
  let maxDate: Date | null = null
  for (const record of sorted) {
    const startD = parseIsoDate(readRecordFieldValue(record, dateFieldId, dateFieldName))
    if (!startD) continue
    if (!minDate || startD.getTime() < minDate.getTime()) minDate = startD
    if (!maxDate || startD.getTime() > maxDate.getTime()) maxDate = startD
  }

  const filtered = sorted.filter(record =>
    recordOverlapsRange(
      record,
      dateFieldId,
      endDateFieldId,
      dateFieldName,
      endDateFieldName,
      queryStart,
      queryEnd,
    ),
  )

  const page = Math.max(1, Math.floor(input.page ?? 1))
  const pageSize = Math.max(1, Math.floor(input.pageSize ?? 100))
  const visibleRecordCount = page * pageSize
  const pageRecords = filtered.slice(0, visibleRecordCount)

  const wrappers: CalendarOccurrenceWrapper[] = []
  for (const record of pageRecords) {
    const startD = parseIsoDate(readRecordFieldValue(record, dateFieldId, dateFieldName))
    if (!startD) continue
    const endD = endDateFieldId
      ? parseIsoDate(readRecordFieldValue(record, endDateFieldId, endDateFieldName))
      : null
    wrappers.push(
      ...expandOccurrences(record, startD, endD, queryStart, queryEnd),
    )
  }

  const metadata: Record<string, unknown> = {
    view_type: 'calendar',
    date_field: dateFieldId,
    pagination_unit: 'record',
    occurrence_count: wrappers.length,
    date_bounds:
      minDate && maxDate
        ? { min: toDateKey(minDate), max: toDateKey(maxDate) }
        : null,
  }
  if (endDateFieldId) metadata.end_date_field = endDateFieldId
  if (input.dateRange) metadata.date_range = input.dateRange

  return {
    view: {
      id: String(input.view?.id ?? ''),
      name: String(input.view?.name ?? ''),
      view_type: 'calendar',
      config: input.view?.config ?? {},
    },
    records: wrappers as unknown as TableRecord[],
    total: filtered.length,
    matched_total: filtered.length,
    page,
    page_size: pageSize,
    latest_version: 0,
    delta: false,
    has_changes: true,
    metadata,
  }
}
