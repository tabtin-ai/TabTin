import * as React from 'react'
import { addMonths, isBefore, startOfMonth } from 'date-fns'
import { Button } from '../button'
import { Input } from '../input'
import { Popover, PopoverContent, PopoverTrigger } from '../popover'
import { t } from '../../i18n'
import { cn } from '../../utils/cn'
import { CalendarMonth, type RangeModifiers } from './CalendarMonth'
import { TimeSelect } from './TimeSelect'
import {
  applyTimeToDate,
  formatLocalDateValue,
  formatStoredDateValue,
  formatTimeFromDate,
  getDatePickerLocale,
  getTodayInTimeZone,
  hasSecondsInTimeFormat,
  normalizeDateFormatting,
  parseStoredDateValue,
  parseTimeString,
  toStoredDateValue,
  type DateFieldOptionsLike,
  type DateRangeValue,
  type ResolvedDateFormatting,
} from './utils'
import { isPortaledSelectTarget } from '../../utils/is-portaled-select-target'

const START_DEFAULT_TIME = '00:00'
const END_DEFAULT_TIME = '23:59'

const isSameDayDate = (left: Date, right: Date): boolean =>
  left.getFullYear() === right.getFullYear() &&
  left.getMonth() === right.getMonth() &&
  left.getDate() === right.getDate()

const timeToSeconds = (value: string): number => {
  const [hours, minutes, seconds] = parseTimeString(value)
  return hours * 3600 + minutes * 60 + seconds
}

const formatLocalRangeValue = (
  fromDate: Date | undefined,
  toDate: Date | undefined,
  fromTime: string,
  toTime: string,
  formatting: ResolvedDateFormatting
): string => {
  if (!fromDate) {
    return ''
  }

  const resolvedFrom = formatting.time === 'None' ? fromDate : applyTimeToDate(fromDate, fromTime)
  const fromText = formatLocalDateValue(resolvedFrom, formatting)

  if (!toDate) {
    return `${fromText} ~ ?`
  }

  const resolvedTo = formatting.time === 'None' ? toDate : applyTimeToDate(toDate, toTime)
  return `${fromText} ~ ${formatLocalDateValue(resolvedTo, formatting)}`
}

export interface DateRangePickerProps {
  value: DateRangeValue | null
  onChange: (value: DateRangeValue | null) => void
  options?: DateFieldOptionsLike
  className?: string
  disabled?: boolean
  error?: boolean
  disableTimePicker?: boolean
}

export const DateRangePicker: React.FC<DateRangePickerProps> = ({
  value,
  onChange,
  options,
  className,
  disabled = false,
  error = false,
  disableTimePicker = false,
}) => {
  const locale = React.useMemo(() => getDatePickerLocale(), [])
  const baseFormatting = React.useMemo(
    () => normalizeDateFormatting(options?.formatting, disableTimePicker),
    [options?.formatting, disableTimePicker]
  )
  const formatting = React.useMemo(
    () => ({
      ...baseFormatting,
      timeZone: value?.timeZone || baseFormatting.timeZone,
    }),
    [baseFormatting, value?.timeZone]
  )
  const hasTimePicker = formatting.time !== 'None'
  const hasSecondPicker = hasSecondsInTimeFormat(formatting.time)
  const [open, setOpen] = React.useState(false)
  const [fromDate, setFromDate] = React.useState<Date | undefined>()
  const [toDate, setToDate] = React.useState<Date | undefined>()
  const [fromTime, setFromTime] = React.useState(START_DEFAULT_TIME)
  const [toTime, setToTime] = React.useState(END_DEFAULT_TIME)
  const [leftMonth, setLeftMonth] = React.useState<Date>(() => getTodayInTimeZone(formatting))
  const [rightMonth, setRightMonth] = React.useState<Date>(() => addMonths(getTodayInTimeZone(formatting), 1))
  const [selectionPhase, setSelectionPhase] = React.useState<'start' | 'end'>('start')

  const displayValue = React.useMemo(() => {
    if (!value?.exactDate) {
      return ''
    }

    const fromText = formatStoredDateValue(value.exactDate, formatting, locale)
    if (!value.exactDateEnd) {
      return fromText
    }
    return `${fromText} ~ ${formatStoredDateValue(value.exactDateEnd, formatting, locale)}`
  }, [formatting, locale, value?.exactDate, value?.exactDateEnd])

  const tempDisplayValue = React.useMemo(
    () => formatLocalRangeValue(fromDate, toDate, fromTime, toTime, formatting),
    [formatting, fromDate, fromTime, toDate, toTime]
  )

  const isSameDay = React.useMemo(
    () => Boolean(fromDate && toDate && isSameDayDate(fromDate, toDate)),
    [fromDate, toDate]
  )

  const isTimeRangeValid = React.useMemo(() => {
    if (!hasTimePicker || !fromDate || !toDate || !isSameDay) {
      return true
    }
    return timeToSeconds(toTime) >= timeToSeconds(fromTime)
  }, [fromDate, fromTime, hasTimePicker, isSameDay, toDate, toTime])

  const rangeModifiers = React.useMemo((): RangeModifiers => {
    if (!fromDate || !toDate) {
      return {}
    }
    if (isSameDayDate(fromDate, toDate)) {
      return {
        range_start: fromDate,
        range_end: toDate,
      }
    }
    return {
      range_start: fromDate,
      range_end: toDate,
      range_middle: { after: fromDate, before: toDate },
    }
  }, [fromDate, toDate])

  const initializeDraft = React.useCallback(() => {
    const parsedFrom = parseStoredDateValue(value?.exactDate, formatting)
    const parsedTo = parseStoredDateValue(value?.exactDateEnd, formatting)
    const today = getTodayInTimeZone(formatting)
    const nextLeftMonth = parsedFrom ?? parsedTo ?? today
    const fallbackToTime = hasSecondPicker ? '23:59:59' : END_DEFAULT_TIME

    setFromDate(parsedFrom)
    setToDate(parsedTo)
    setFromTime(parsedFrom ? formatTimeFromDate(parsedFrom, formatting) : START_DEFAULT_TIME)
    setToTime(parsedTo ? formatTimeFromDate(parsedTo, formatting) : fallbackToTime)
    setLeftMonth(nextLeftMonth)
    setRightMonth(
      parsedTo && startOfMonth(parsedTo).getTime() > startOfMonth(nextLeftMonth).getTime()
        ? parsedTo
        : addMonths(nextLeftMonth, 1)
    )
    setSelectionPhase(parsedFrom && !parsedTo ? 'end' : 'start')
  }, [formatting, hasSecondPicker, value?.exactDate, value?.exactDateEnd])

  const handleOpenChange = React.useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen)
      if (nextOpen) {
        initializeDraft()
      }
    },
    [initializeDraft]
  )

  const handleDateSelect = React.useCallback(
    (nextDate: Date | undefined) => {
      if (!nextDate && selectionPhase === 'end' && fromDate) {
        setToDate(new Date(fromDate))
        setSelectionPhase('start')
        return
      }

      if (!nextDate) {
        return
      }

      if (selectionPhase === 'start' || !fromDate) {
        setFromDate(nextDate)
        setToDate(undefined)
        setSelectionPhase('end')
        return
      }

      if (isBefore(nextDate, fromDate)) {
        setToDate(fromDate)
        setFromDate(nextDate)
      } else {
        setToDate(nextDate)
      }
      setSelectionPhase('start')
    },
    [fromDate, selectionPhase]
  )

  const handleLeftMonthChange = React.useCallback((nextMonth: Date) => {
    setLeftMonth(nextMonth)
    setRightMonth((currentRightMonth) =>
      startOfMonth(currentRightMonth).getTime() <= startOfMonth(nextMonth).getTime()
        ? addMonths(nextMonth, 1)
        : currentRightMonth
    )
  }, [])

  const handleRightMonthChange = React.useCallback(
    (nextMonth: Date) => {
      if (startOfMonth(nextMonth).getTime() <= startOfMonth(leftMonth).getTime()) {
        setRightMonth(addMonths(leftMonth, 1))
        return
      }
      setRightMonth(nextMonth)
    },
    [leftMonth]
  )

  const handleConfirm = React.useCallback(() => {
    if (!fromDate || !toDate || !isTimeRangeValid) {
      return
    }

    const nextFromDate = new Date(fromDate)
    const nextToDate = new Date(toDate)

    if (hasTimePicker) {
      const [fromHour, fromMinute, fromSecond] = parseTimeString(fromTime)
      const [toHour, toMinute, toSecond] = parseTimeString(toTime)
      nextFromDate.setHours(fromHour, fromMinute, hasSecondPicker ? fromSecond : 0, 0)
      nextToDate.setHours(toHour, toMinute, hasSecondPicker ? toSecond : 59, 999)
    }

    onChange({
      exactDate: toStoredDateValue(nextFromDate, formatting, !hasTimePicker),
      exactDateEnd: toStoredDateValue(nextToDate, formatting, !hasTimePicker),
      timeZone: formatting.timeZone,
    })
    setOpen(false)
  }, [formatting, fromDate, fromTime, hasSecondPicker, hasTimePicker, isTimeRangeValid, onChange, toDate, toTime])

  const handleClear = React.useCallback(() => {
    onChange(null)
    setOpen(false)
  }, [onChange])

  const preventDismissForPortaledSelect = React.useCallback((event: Event) => {
    if (isPortaledSelectTarget(event.target)) {
      event.preventDefault()
    }
  }, [])

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <div className="relative">
        <Input
          value={displayValue}
          readOnly
          disabled={disabled}
          error={error}
          placeholder={t('datePicker.rangePlaceholder')}
          className={cn('cursor-pointer text-left', !displayValue && 'text-muted-foreground', className)}
        />
        <PopoverTrigger asChild disabled={disabled}>
          <button
            type="button"
            className="absolute inset-0 rounded-md"
            aria-label={t('datePicker.toggleRange')}
          />
        </PopoverTrigger>
      </div>

      <PopoverContent
        className="w-auto p-0"
        align="start"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onInteractOutside={preventDismissForPortaledSelect}
        onPointerDownOutside={preventDismissForPortaledSelect}
      >
        <div className="flex flex-col">
          <div className="flex flex-col gap-3 p-3 xl:flex-row">
            <div className="flex flex-col gap-2">
              <CalendarMonth
                month={leftMonth}
                onMonthChange={handleLeftMonthChange}
                selected={fromDate}
                onSelect={handleDateSelect}
                locale={locale}
                rangeModifiers={rangeModifiers}
              />
              {hasTimePicker ? (
                <TimeSelect
                  value={fromTime}
                  onChange={setFromTime}
                  showSeconds={hasSecondPicker}
                />
              ) : null}
            </div>

            <div className="flex flex-col gap-2">
              <CalendarMonth
                month={rightMonth}
                onMonthChange={handleRightMonthChange}
                selected={toDate ?? fromDate}
                onSelect={handleDateSelect}
                locale={locale}
                rangeModifiers={rangeModifiers}
              />
              {hasTimePicker ? (
                <TimeSelect
                  value={toTime}
                  onChange={setToTime}
                  showSeconds={hasSecondPicker}
                />
              ) : null}
            </div>
          </div>

          <div className="flex items-center justify-between gap-3 border-t px-3 py-2">
            <div className="min-w-0 flex-1 text-body text-muted-foreground">
              {!isTimeRangeValid ? (
                <span className="text-destructive">{t('datePicker.invalidTimeRange')}</span>
              ) : tempDisplayValue ? (
                <span className="truncate">{tempDisplayValue}</span>
              ) : (
                <span>{t('datePicker.rangeHelp')}</span>
              )}
            </div>

            <div className="flex items-center gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={handleClear}>
                {t('datePicker.clear')}
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={handleConfirm}
                disabled={!fromDate || !toDate || !isTimeRangeValid}
              >
                {t('common.confirm')}
              </Button>
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
