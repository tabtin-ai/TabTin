import { useCallback, useMemo, useState } from 'react'
import type { Locale } from 'date-fns'
import {
  applyTimeToDate,
  formatTimeFromDate,
  getDatePickerLocale,
  getTodayInTimeZone,
  normalizeDateFormatting,
  parseStoredDateValue,
  toStoredDateValue,
  type DateFormattingConfig,
  type ResolvedDateFormatting,
} from './utils'

export interface UseDateEditorCoreOptions {
  value?: string | null
  formatting?: DateFormattingConfig | null
  disableTimePicker?: boolean
  onChange: (value: string | null) => void
  onComplete?: () => void
}

export interface UseDateEditorCoreReturn {
  locale: Locale
  formatting: ResolvedDateFormatting
  hasTimePicker: boolean
  draftDate: Date | undefined
  displayMonth: Date
  timeValue: string
  setDisplayMonth: (date: Date) => void
  handleDaySelect: (day: Date | undefined) => void
  /** HH:mm or HH:mm:ss */
  handleTimeChange: (nextTime: string) => void
  handleConfirm: () => void
  handleToday: () => void
  handleClear: () => void
  resetFromValue: (nextValue?: string | null) => void
}

export const useDateEditorCore = (options: UseDateEditorCoreOptions): UseDateEditorCoreReturn => {
  const { value, formatting: formattingConfig, disableTimePicker = false, onChange, onComplete } = options

  const locale = useMemo(() => getDatePickerLocale(), [])
  const formatting = useMemo(
    () => normalizeDateFormatting(formattingConfig, disableTimePicker),
    [formattingConfig, disableTimePicker]
  )
  const hasTimePicker = formatting.time !== 'None'

  const [draftDate, setDraftDate] = useState<Date | undefined>(() =>
    parseStoredDateValue(value, formatting)
  )
  const [displayMonth, setDisplayMonth] = useState<Date>(() =>
    parseStoredDateValue(value, formatting) ?? getTodayInTimeZone(formatting)
  )
  const [timeValue, setTimeValue] = useState<string>(() =>
    formatTimeFromDate(parseStoredDateValue(value, formatting) ?? getTodayInTimeZone(formatting), formatting)
  )

  const emit = useCallback(
    (nextDate: Date | null) => {
      onChange(nextDate ? toStoredDateValue(nextDate, formatting) : null)
    },
    [formatting, onChange]
  )

  const complete = useCallback(
    (nextDate: Date | null) => {
      emit(nextDate)
      onComplete?.()
    },
    [emit, onComplete]
  )

  const resetFromValue = useCallback(
    (nextValue?: string | null) => {
      const parsed = parseStoredDateValue(nextValue, formatting)
      const fallback = getTodayInTimeZone(formatting)
      setDraftDate(parsed)
      setDisplayMonth(parsed ?? fallback)
      setTimeValue(formatTimeFromDate(parsed ?? fallback, formatting))
    },
    [formatting]
  )

  const handleDaySelect = useCallback(
    (nextDay: Date | undefined) => {
      if (!nextDay) return

      const resolved = hasTimePicker ? applyTimeToDate(nextDay, timeValue) : nextDay
      setDraftDate(resolved)
      setDisplayMonth(nextDay)

      if (!hasTimePicker) {
        complete(resolved)
      }
    },
    [complete, hasTimePicker, timeValue]
  )

  const handleTimeChange = useCallback((nextTime: string) => {
    setTimeValue(nextTime)
    setDraftDate((current) => (current ? applyTimeToDate(current, nextTime) : current))
  }, [])

  const handleConfirm = useCallback(() => {
    if (!draftDate) return
    complete(applyTimeToDate(draftDate, timeValue))
  }, [complete, draftDate, timeValue])

  const handleToday = useCallback(() => {
    const nowInTimeZone = getTodayInTimeZone(formatting)
    setDraftDate(nowInTimeZone)
    setDisplayMonth(nowInTimeZone)
    setTimeValue(formatTimeFromDate(nowInTimeZone, formatting))
    complete(nowInTimeZone)
  }, [complete, formatting])

  const handleClear = useCallback(() => {
    setDraftDate(undefined)
    complete(null)
  }, [complete])

  return {
    locale,
    formatting,
    hasTimePicker,
    draftDate,
    displayMonth,
    timeValue,
    setDisplayMonth,
    handleDaySelect,
    handleTimeChange,
    handleConfirm,
    handleToday,
    handleClear,
    resetFromValue,
  }
}
