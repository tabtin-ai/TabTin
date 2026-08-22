import {
  validateFieldRules,
  normalizeValidationPattern,
  coerceRuleNumber,
} from '@tabtin/smartsheet-ui'
import { resolveCanonicalGroupValue } from '@tabtin/table-engine'

export type DateDisplayFormat = 'YYYY/MM/DD' | 'YYYY-MM-DD' | 'M/D/YYYY' | 'D/M/YYYY'
export type TimeDisplayFormat = 'HH:mm' | 'HH:mm:ss' | 'hh:mm A' | 'hh:mm:ss A' | 'None'

export interface DateFormattingConfig {
  date?: DateDisplayFormat | string
  time?: TimeDisplayFormat | string
  timeZone?: string
}

export interface FieldDisplayValueField {
  field_type: string
  options?: {
    formatting?: DateFormattingConfig
    [key: string]: unknown
  }
}

const DEFAULT_DATE_DISPLAY_FORMAT: DateDisplayFormat = 'YYYY/MM/DD'
const DEFAULT_TIME_DISPLAY_FORMAT: TimeDisplayFormat = 'HH:mm'
const DATE_ONLY_VALUE_RE = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/

export function mapFieldTypeToColumnType(fieldType: string): string {
  switch (fieldType) {
    case 'number':
      return 'number'
    case 'date':
    case 'created_time':
    case 'last_modified_time':
      return 'date'
    case 'email':
    case 'phone':
    case 'url':
    case 'attachment':
      return 'text'
    case 'single_select':
    case 'select':
      return 'singleSelect'
    case 'multi_select':
      return 'multiSelect'
    case 'checkbox':
      return 'boolean'
    default:
      return 'text'
  }
}

/**
 * Format a stored percent ratio (e.g. 0.12) for grid display.
 * Shows at most 2 fraction digits and strips trailing zeros: 12% / 12.3% / 12.34%.
 */
export function formatPercentCellValue(value: unknown): string {
  if (value == null || value === '') return ''
  const num = Number(value)
  if (!Number.isFinite(num)) return String(value)
  const text = (num * 100).toFixed(2).replace(/\.?0+$/, '')
  return `${text}%`
}

/**
 * Convert editor / paste percent-point input into a stored ratio.
 * "12" / "12%" / 12 → 0.12. Empty → null.
 */
export function parsePercentPointsToRatio(value: unknown): number | null {
  if (value == null || value === '') return null
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value / 100 : null
  }
  const cleaned = String(value).replace(/\s*%\s*$/, '').trim()
  if (!cleaned) return null
  const n = Number(cleaned)
  return Number.isFinite(n) ? n / 100 : null
}

export function formatDateCellValue(value: unknown, formatting?: DateFormattingConfig): string {
  if (!value) return ''
  if (!hasCustomFormatting(formatting)) {
    const date = value instanceof Date ? value : new Date(value as any)
    if (Number.isNaN(date.getTime())) {
      return stringifyCellValue(value)
    }
    return date.toLocaleDateString()
  }

  const normalizedFormatting = {
    ...normalizeDateFormattingConfig(formatting),
    time:
      formatting?.time === 'HH:mm' ||
      formatting?.time === 'HH:mm:ss' ||
      formatting?.time === 'hh:mm A' ||
      formatting?.time === 'hh:mm:ss A'
        ? formatting.time
        : 'None' as TimeDisplayFormat,
  }
  const parts = resolveDateDisplayParts(value, normalizedFormatting)
  if (!parts) {
    return stringifyCellValue(value)
  }

  const dateText = renderDateString(parts, normalizedFormatting.date)
  if (normalizedFormatting.time === 'None') {
    return dateText
  }

  return `${dateText} ${renderTimeString(
    parts.hour24 ?? 0,
    parts.minute ?? '00',
    normalizedFormatting.time,
    parts.second ?? '00'
  )}`
}

export function formatDateTimeCellValue(value: unknown, formatting?: DateFormattingConfig): string {
  if (!value) return ''
  if (!hasCustomFormatting(formatting)) {
    const date = value instanceof Date ? value : new Date(value as any)
    if (Number.isNaN(date.getTime())) {
      return stringifyCellValue(value)
    }
    return date.toLocaleString()
  }

  const normalizedFormatting = normalizeDateFormattingConfig(formatting)
  const parts = resolveDateDisplayParts(value, normalizedFormatting)
  if (!parts) {
    return stringifyCellValue(value)
  }

  const dateText = renderDateString(parts, normalizedFormatting.date)
  if (normalizedFormatting.time === 'None') {
    return dateText
  }

  return `${dateText} ${renderTimeString(
    parts.hour24 ?? 0,
    parts.minute ?? '00',
    normalizedFormatting.time,
    parts.second ?? '00'
  )}`
}

export function formatFieldDisplayValue(
  value: unknown,
  field: FieldDisplayValueField,
  options?: {
    emptyLabel?: string
    userDisplayNameById?: ReadonlyMap<string, string>
  }
): string {
  const emptyLabel = options?.emptyLabel ?? '-'
  if (isEmptyDisplayValue(value)) {
    return emptyLabel
  }

  if (field.field_type === 'date') {
    return formatDateCellValue(value, field.options?.formatting) || emptyLabel
  }

  if (
    field.field_type === 'created_time' ||
    field.field_type === 'last_modified_time'
  ) {
    return formatDateTimeCellValue(value, field.options?.formatting) || emptyLabel
  }

  if (
    field.field_type === 'user' ||
    field.field_type === 'created_by' ||
    field.field_type === 'last_modified_by'
  ) {
    return resolveCanonicalGroupValue(
      value,
      {
        fieldType: field.field_type,
        userDisplayNameById: options?.userDisplayNameById,
      },
      emptyLabel,
    ).label
  }

  return formatGenericDisplayValue(value, emptyLabel)
}

export function formatAttachmentValue(value: unknown, formatCount?: (count: number) => string): string {
  if (!value) return ''
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return ''
    }
    const names = value
      .map(item => {
        if (!item) return ''
        if (typeof item === 'string') return item
        if (typeof item === 'object') {
          return (item as any).name ?? (item as any).filename ?? (item as any).file_name ?? ''
        }
        return ''
      })
      .filter(Boolean)
    if (names.length > 0) {
      return names.join(', ')
    }
    if (formatCount) {
      return formatCount(value.length)
    }
    return `${value.length} attachments`
  }
  if (typeof value === 'object') {
    const name = (value as any)?.name ?? (value as any)?.filename ?? (value as any)?.file_name
    if (name) {
      return String(name)
    }
  }
  return stringifyCellValue(value)
}

export function attachmentMissing(value: unknown): boolean {
  if (!value) return true
  if (Array.isArray(value)) {
    return value.length === 0
  }
  return false
}

export function normalizeDateCellValue(
  value: unknown,
  fieldType: 'date',
  timeZone?: string,
  preserveDateTimeForDate = false
): { value: string | null; isValid: boolean } {
  if (value === null || value === undefined || value === '') {
    return { value: null, isValid: true }
  }

  const dateStringCarriesTime =
    typeof value === 'string' &&
    (/[tT]\d{2}:\d{2}/.test(value) || /\s+\d{1,2}:\d{2}/.test(value))
  const shouldPreserveDateTime = preserveDateTimeForDate || dateStringCarriesTime

  if (typeof value === 'string') {
    if (!shouldPreserveDateTime) {
      const normalized = normalizeDateInputToDateString(value)
      if (normalized) {
        return { value: normalized, isValid: true }
      }
    }
  }

  const date = value instanceof Date ? value : new Date(value as any)
  if (Number.isNaN(date.getTime())) {
    return { value: null, isValid: false }
  }

  if (shouldPreserveDateTime) {
    return { value: date.toISOString(), isValid: true }
  }
  return { value: resolveDateYmdByTimezone(date, timeZone), isValid: true }
}

function resolveDateYmdByTimezone(date: Date, timeZone?: string): string {
  if (timeZone) {
    try {
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      })
      const parts = formatter.formatToParts(date)
      const year = parts.find(part => part.type === 'year')?.value
      const month = parts.find(part => part.type === 'month')?.value
      const day = parts.find(part => part.type === 'day')?.value
      if (year && month && day) {
        return `${year}-${month}-${day}`
      }
    } catch {
      // 回退本地时区格式，保持可用性
    }
  }

  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function normalizeDateInputToDateString(value: unknown, fallback?: unknown): string | null {
  if (value === null || value === undefined || value === '') {
    return null
  }

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      return null
    }
    const year = value.getFullYear()
    const month = String(value.getMonth() + 1).padStart(2, '0')
    const day = String(value.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
  }

  const raw = String(value).trim()
  if (!raw) {
    return null
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return raw
  }

  if (/^\d{4}\/\d{2}\/\d{2}$/.test(raw)) {
    return raw.replace(/\//g, '-')
  }

  const digitsOnly = raw.replace(/[^\d]/g, '')
  if (/^\d{8}$/.test(digitsOnly)) {
    return `${digitsOnly.slice(0, 4)}-${digitsOnly.slice(4, 6)}-${digitsOnly.slice(6, 8)}`
  }

  if (fallback !== undefined) {
    const fallbackValue = normalizeDateInputToDateString(fallback)
    if (fallbackValue) {
      return fallbackValue
    }
  }

  return null
}

/**
 * Normalize "empty" values per field type so the full editing pipeline
 * uses a consistent representation.
 *
 * - text / long_text / url / email / phone → `''`
 * - number / currency / percent / rating   → `null`
 * - select (single_select)                  → `null`
 * - multi_select                           → `null`
 * - date                                   → `null`
 * - checkbox / boolean                     → `false`
 * - attachment                             → `null`
 * - others                                 → `null`
 *
 * Returns the original value unchanged if it is not considered empty.
 */
export function normalizeEmptyValue(fieldType: string, value: unknown): unknown {
  const isEmpty =
    value === null ||
    value === undefined ||
    value === '' ||
    (Array.isArray(value) && value.length === 0)

  if (!isEmpty) return value

  switch (fieldType) {
    case 'text':
    case 'long_text':
    case 'url':
    case 'email':
    case 'phone':
      return ''
    case 'checkbox':
      return false
    default:
      return null
  }
}

function stringifyCellValue(value: unknown): string {
  if (value === null || value === undefined) {
    return ''
  }
  if (typeof value === 'string') {
    return value
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function isEmptyDisplayValue(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    value === '' ||
    (Array.isArray(value) && value.length === 0)
  )
}

function hasCustomFormatting(
  formatting?: DateFormattingConfig | null
): formatting is DateFormattingConfig {
  if (!formatting || typeof formatting !== 'object') {
    return false
  }
  return (
    typeof formatting.date === 'string' ||
    typeof formatting.time === 'string' ||
    typeof formatting.timeZone === 'string'
  )
}

function normalizeDateFormattingConfig(
  formatting?: DateFormattingConfig | null
): {
  date: DateDisplayFormat
  time: TimeDisplayFormat
  timeZone?: string
} {
  const date = formatting?.date
  const time = formatting?.time
  const timeZone =
    typeof formatting?.timeZone === 'string' && formatting.timeZone.trim().length > 0
      ? formatting.timeZone
      : undefined

  return {
    date:
      date === 'YYYY-MM-DD' || date === 'M/D/YYYY' || date === 'D/M/YYYY'
        ? date
        : DEFAULT_DATE_DISPLAY_FORMAT,
    time:
      time === 'HH:mm:ss' ||
      time === 'hh:mm A' ||
      time === 'hh:mm:ss A' ||
      time === 'None'
        ? time
        : DEFAULT_TIME_DISPLAY_FORMAT,
    timeZone,
  }
}

function resolveDateDisplayParts(
  value: unknown,
  formatting?: DateFormattingConfig | null
): {
  year: string
  month: string
  day: string
  hour24: number | null
  minute: string | null
  second: string | null
} | null {
  if (typeof value === 'string') {
    const match = value.trim().match(DATE_ONLY_VALUE_RE)
    if (match) {
      return {
        year: match[1],
        month: match[2].padStart(2, '0'),
        day: match[3].padStart(2, '0'),
        hour24: null,
        minute: null,
        second: null,
      }
    }
  }

  const date = value instanceof Date ? value : new Date(value as any)
  if (Number.isNaN(date.getTime())) {
    return null
  }

  const formatterOptions: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }

  const timeZone = normalizeDateFormattingConfig(formatting).timeZone

  try {
    if (timeZone) {
      formatterOptions.timeZone = timeZone
    }
    const formatter = new Intl.DateTimeFormat('en-US', formatterOptions)
    const parts = formatter.formatToParts(date)
    const year = parts.find((part) => part.type === 'year')?.value
    const month = parts.find((part) => part.type === 'month')?.value
    const day = parts.find((part) => part.type === 'day')?.value
    const hour = parts.find((part) => part.type === 'hour')?.value
    const minute = parts.find((part) => part.type === 'minute')?.value
    const second = parts.find((part) => part.type === 'second')?.value

    if (!year || !month || !day) {
      return null
    }

    return {
      year,
      month,
      day,
      hour24: hour ? Number.parseInt(hour, 10) : null,
      minute: minute ?? null,
      second: second ?? null,
    }
  } catch {
    return {
      year: String(date.getFullYear()),
      month: String(date.getMonth() + 1).padStart(2, '0'),
      day: String(date.getDate()).padStart(2, '0'),
      hour24: date.getHours(),
      minute: String(date.getMinutes()).padStart(2, '0'),
      second: String(date.getSeconds()).padStart(2, '0'),
    }
  }
}

function renderDateString(
  parts: { year: string; month: string; day: string },
  format: DateDisplayFormat
): string {
  const monthNumeric = String(Number.parseInt(parts.month, 10))
  const dayNumeric = String(Number.parseInt(parts.day, 10))

  switch (format) {
    case 'YYYY-MM-DD':
      return `${parts.year}-${parts.month}-${parts.day}`
    case 'M/D/YYYY':
      return `${monthNumeric}/${dayNumeric}/${parts.year}`
    case 'D/M/YYYY':
      return `${dayNumeric}/${monthNumeric}/${parts.year}`
    case 'YYYY/MM/DD':
    default:
      return `${parts.year}/${parts.month}/${parts.day}`
  }
}

function renderTimeString(
  hour24: number,
  minute: string,
  format: TimeDisplayFormat,
  second: string | null = null
): string {
  const includesSeconds = format === 'HH:mm:ss' || format === 'hh:mm:ss A'
  const secondsText = includesSeconds ? `:${second ?? '00'}` : ''

  if (format === 'hh:mm A' || format === 'hh:mm:ss A') {
    const meridiem = hour24 >= 12 ? 'PM' : 'AM'
    const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12
    return `${String(hour12).padStart(2, '0')}:${minute}${secondsText} ${meridiem}`
  }

  return `${String(hour24).padStart(2, '0')}:${minute}${secondsText}`
}

function flattenValues(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => flattenValues(item))
  }
  return value === null || value === undefined || value === '' ? [] : [value]
}

function formatGenericDisplayValue(value: unknown, emptyLabel: string): string {
  if (value === null || value === undefined) {
    return emptyLabel
  }

  if (typeof value === 'boolean') {
    return value ? '✓' : '✗'
  }

  if (typeof value === 'number') {
    return value.toLocaleString()
  }

  if (typeof value === 'string') {
    return value
  }

  if (Array.isArray(value)) {
    const formattedValues = value
      .flatMap((item) => flattenValues(item))
      .map((item) => stringifyDisplayItem(item))
      .filter((item) => item.length > 0)

    return formattedValues.join(', ') || emptyLabel
  }

  return stringifyDisplayItem(value) || emptyLabel
}

export type ValidationResult =
  | { valid: true }
  | { valid: false; errorCode: string; params?: Record<string, unknown> }

export type FieldValidationConfig = {
  max_length?: number
  choices?: string[]
  /** 字段 validation_rules（与后端 field_validation_rules.py 对齐） */
  validation_rules?: Record<string, unknown> | null
}

// validation_rules 实现收口在 smartsheet-ui，避免格子 / 表单两套语义漂移
export { validateFieldRules, normalizeValidationPattern, coerceRuleNumber }

// 与 @tabtin/table-kernel 的 EMAIL_RE / 默认 CN 电话规则保持一致（table-ui 未直接依赖
// table-kernel，此处内联同一正则，避免新增跨包依赖）。
const EMAIL_RE = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/
const PHONE_DIGITS_RE = /[^\d]/g
const CN_MOBILE_RE = /^1[3-9]\d{9}$/
const CN_LANDLINE_RE = /^0\d{2,3}\d{7,8}$/
const CN_SERVICE_RE = /^[48]00\d{7}$/

function isValidCnPhoneDigits(digits: string): boolean {
  return CN_MOBILE_RE.test(digits) || CN_LANDLINE_RE.test(digits) || CN_SERVICE_RE.test(digits)
}

function isEmptyCellValue(value: unknown): boolean {
  if (value == null) return true
  if (typeof value === 'string' && value.trim() === '') return true
  if (Array.isArray(value) && value.length === 0) return true
  return false
}

export function validateBeforeSave(
  fieldType: string,
  value: unknown,
  fieldConfig?: FieldValidationConfig,
): ValidationResult {
  const rulesResult = validateFieldRules(
    value,
    {
      ...(fieldConfig?.validation_rules ?? {}),
    },
  )
  if (!rulesResult.valid) return rulesResult

  if (isEmptyCellValue(value)) return { valid: true }

  switch (fieldType) {
    case 'text':
    case 'long_text': {
      const maxLen = fieldConfig?.max_length ?? 100_000
      if (typeof value === 'string' && value.length > maxLen) {
        return { valid: false, errorCode: 'text_too_long', params: { maxLen } }
      }
      return { valid: true }
    }
    case 'number':
    case 'percent':
    case 'currency': {
      const num = Number(value)
      if (!Number.isFinite(num)) {
        return { valid: false, errorCode: 'invalid_number' }
      }
      if (num !== 0) {
        const str = String(value).replace(/[^0-9]/g, '')
        if (str.length > 15) {
          return { valid: false, errorCode: 'number_precision_exceeded', params: { maxDigits: 15 } }
        }
      }
      return { valid: true }
    }
    case 'email': {
      if (typeof value === 'string' && !EMAIL_RE.test(value.trim())) {
        return { valid: false, errorCode: 'invalid_email' }
      }
      return { valid: true }
    }
    case 'phone': {
      // 默认 CN：手机号 / 固话 / 400·800（与 table-kernel 一致）；允许分隔符，先抽数字再判。
      if (typeof value !== 'string') {
        return { valid: false, errorCode: 'invalid_phone' }
      }
      const digits = value.replace(PHONE_DIGITS_RE, '')
      if (!digits || !isValidCnPhoneDigits(digits)) {
        return { valid: false, errorCode: 'invalid_phone' }
      }
      return { valid: true }
    }
    case 'single_select':
    case 'select': {
      // Select choices can be updated by the same editor interaction that saves
      // the cell. Avoid rejecting against stale client metadata; the write path
      // remains the source of truth for option validity.
      return { valid: true }
    }
    default:
      return { valid: true }
  }
}

function stringifyDisplayItem(value: unknown): string {
  if (value === null || value === undefined) {
    return ''
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const preferred =
      record.title ??
      record.name ??
      record.display_name ??
      record.filename ??
      record.file_name ??
      record.id
    if (preferred != null) {
      return String(preferred)
    }
  }

  return stringifyCellValue(value)
}
