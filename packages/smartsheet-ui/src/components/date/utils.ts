import { format, type Locale } from 'date-fns'
import { enUS, zhCN } from 'date-fns/locale'
import { formatInTimeZone, fromZonedTime, toZonedTime } from 'date-fns-tz'
import { getSmartsheetUiLocale } from '../../i18n'

export type DateDisplayFormat = 'YYYY/MM/DD' | 'YYYY-MM-DD' | 'M/D/YYYY' | 'D/M/YYYY'
export type TimeDisplayFormat = 'HH:mm' | 'HH:mm:ss' | 'hh:mm A' | 'hh:mm:ss A' | 'None'

export interface DateFormattingConfig {
  date?: DateDisplayFormat | string
  time?: TimeDisplayFormat | string
  timeZone?: string
}

export interface DateFieldOptionsLike {
  formatting?: DateFormattingConfig
}

export interface ResolvedDateFormatting {
  date: DateDisplayFormat
  time: TimeDisplayFormat
  timeZone: string
}

export interface DateRangeValue {
  exactDate?: string
  exactDateEnd?: string
  timeZone?: string
}

export const DEFAULT_DATE_DISPLAY_FORMAT: DateDisplayFormat = 'YYYY-MM-DD'
export const DEFAULT_TIME_DISPLAY_FORMAT: TimeDisplayFormat = 'HH:mm'
export const MIN_CALENDAR_YEAR = 1900
export const MAX_CALENDAR_YEAR = 2100

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/

const DATE_FORMAT_TOKEN_MAP: Record<DateDisplayFormat, string> = {
  'YYYY/MM/DD': 'yyyy/MM/dd',
  'YYYY-MM-DD': 'yyyy-MM-dd',
  'M/D/YYYY': 'M/d/yyyy',
  'D/M/YYYY': 'd/M/yyyy',
}

const TIME_FORMAT_TOKEN_MAP: Record<Exclude<TimeDisplayFormat, 'None'>, string> = {
  'HH:mm': 'HH:mm',
  'HH:mm:ss': 'HH:mm:ss',
  'hh:mm A': 'hh:mm a',
  'hh:mm:ss A': 'hh:mm:ss a',
}

export const resolveLocalTimeZone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

export const getDatePickerLocale = (): Locale => {
  const locale = getSmartsheetUiLocale()
  return locale.startsWith('zh') ? zhCN : enUS
}

export const normalizeDateFormatting = (
  formatting?: DateFormattingConfig | null,
  disableTimePicker = false
): ResolvedDateFormatting => {
  const date =
    formatting?.date === 'YYYY/MM/DD' ||
    formatting?.date === 'YYYY-MM-DD' ||
    formatting?.date === 'M/D/YYYY' ||
    formatting?.date === 'D/M/YYYY'
      ? formatting.date
      : DEFAULT_DATE_DISPLAY_FORMAT

  const time =
    disableTimePicker
      ? 'None'
      : formatting?.time === 'HH:mm' ||
          formatting?.time === 'HH:mm:ss' ||
          formatting?.time === 'hh:mm A' ||
          formatting?.time === 'hh:mm:ss A' ||
          formatting?.time === 'None'
        ? formatting.time
        : DEFAULT_TIME_DISPLAY_FORMAT

  return {
    date,
    time,
    timeZone:
      typeof formatting?.timeZone === 'string' && formatting.timeZone.trim()
        ? formatting.timeZone
        : resolveLocalTimeZone(),
  }
}

export const getMonthLabels = (locale: Locale): string[] =>
  Array.from({ length: 12 }, (_, index) => format(new Date(2024, index, 1), 'MMM', { locale }))

export const getYearOptions = (
  centerYear: number,
  span = 60,
  minYear = MIN_CALENDAR_YEAR,
  maxYear = MAX_CALENDAR_YEAR
): number[] => {
  const from = Math.max(minYear, centerYear - span)
  const to = Math.min(maxYear, centerYear + span)
  return Array.from({ length: to - from + 1 }, (_, index) => from + index)
}

export const isDateOnlyValue = (value: string): boolean => DATE_ONLY_RE.test(value.trim())

export const buildDateInputPlaceholder = (formatting: ResolvedDateFormatting): string => {
  if (formatting.time === 'None') {
    return formatting.date
  }
  return `${formatting.date} ${formatting.time}`
}

export const hasSecondsInTimeFormat = (
  format: TimeDisplayFormat | string | null | undefined
): boolean => format === 'HH:mm:ss' || format === 'hh:mm:ss A'

const resolveDateFnsDatePattern = (format: DateDisplayFormat) => DATE_FORMAT_TOKEN_MAP[format]

const resolveDateFnsTimePattern = (format: Exclude<TimeDisplayFormat, 'None'>) =>
  TIME_FORMAT_TOKEN_MAP[format]

export const buildDateTimePattern = (
  formatting: ResolvedDateFormatting,
  includeTime = formatting.time !== 'None'
): string => {
  const datePattern = resolveDateFnsDatePattern(formatting.date)
  if (!includeTime || formatting.time === 'None') {
    return datePattern
  }
  return `${datePattern} ${resolveDateFnsTimePattern(formatting.time)}`
}

export const createDateFromDateOnlyValue = (value: string): Date | undefined => {
  const match = value.trim().match(DATE_ONLY_RE)
  if (!match) {
    return undefined
  }
  const [, year, month, day] = match
  const date = new Date(Number(year), Number(month) - 1, Number(day))
  if (Number.isNaN(date.getTime())) {
    return undefined
  }
  return date
}

export const parseStoredDateValue = (
  value: string | null | undefined,
  formatting: ResolvedDateFormatting
): Date | undefined => {
  if (!value) {
    return undefined
  }

  if (isDateOnlyValue(value)) {
    return createDateFromDateOnlyValue(value)
  }

  try {
    const zonedDate = toZonedTime(value, formatting.timeZone)
    if (Number.isNaN(zonedDate.getTime())) {
      return undefined
    }
    return zonedDate
  } catch {
    return undefined
  }
}

export const formatLocalDateValue = (
  value: Date,
  formatting: ResolvedDateFormatting,
  locale = getDatePickerLocale(),
  includeTime = formatting.time !== 'None'
): string => format(value, buildDateTimePattern(formatting, includeTime), { locale })

export const formatStoredDateValue = (
  value: string | null | undefined,
  formatting: ResolvedDateFormatting,
  locale = getDatePickerLocale()
): string => {
  if (!value) {
    return ''
  }

  if (isDateOnlyValue(value)) {
    const localDate = createDateFromDateOnlyValue(value)
    return localDate ? formatLocalDateValue(localDate, formatting, locale) : ''
  }

  try {
    return formatInTimeZone(value, formatting.timeZone, buildDateTimePattern(formatting), { locale })
  } catch {
    return ''
  }
}

export const parseTimeString = (timeValue: string): [number, number, number] => {
  const [hour = '0', minute = '0', second = '0'] = timeValue.split(':')
  return [
    Number.parseInt(hour, 10) || 0,
    Number.parseInt(minute, 10) || 0,
    Number.parseInt(second, 10) || 0,
  ]
}

export const formatTimeFromDate = (
  value: Date,
  formatting?: ResolvedDateFormatting | TimeDisplayFormat | string | null
): string => {
  const timeFormat = typeof formatting === 'string' ? formatting : formatting?.time
  return format(value, hasSecondsInTimeFormat(timeFormat) ? 'HH:mm:ss' : 'HH:mm')
}

export const applyTimeToDate = (value: Date, timeValue: string): Date => {
  const [hours, minutes, seconds] = parseTimeString(timeValue)
  const nextDate = new Date(value)
  nextDate.setHours(hours, minutes, seconds, 0)
  return nextDate
}

export const getTodayInTimeZone = (formatting: ResolvedDateFormatting): Date =>
  toZonedTime(new Date(), formatting.timeZone)

export const toStoredDateValue = (
  value: Date,
  formatting: ResolvedDateFormatting,
  forceDateOnly = formatting.time === 'None'
): string => {
  if (forceDateOnly) {
    return format(value, 'yyyy-MM-dd')
  }
  return fromZonedTime(value, formatting.timeZone).toISOString()
}
