import * as React from 'react'
import { CalendarDays } from 'lucide-react'
import { Button } from '../button'
import { Input } from '../input'
import { Popover, PopoverContent, PopoverTrigger } from '../popover'
import { t } from '../../i18n'
import { cn } from '../../utils/cn'
import { CalendarMonth } from './CalendarMonth'
import { TimeSelect } from './TimeSelect'
import { useDateEditorCore } from './useDateEditorCore'
import {
  buildDateInputPlaceholder,
  formatStoredDateValue,
  type DateFieldOptionsLike,
} from './utils'
import { isPortaledSelectTarget } from '../../utils/is-portaled-select-target'

export interface DatePickerProps {
  value?: string | null
  onChange: (value: string | null) => void
  options?: DateFieldOptionsLike
  className?: string
  disabled?: boolean
  error?: boolean
  disableTimePicker?: boolean
  placeholder?: string
  popoverAlign?: 'start' | 'center' | 'end'
}

export const DatePicker: React.FC<DatePickerProps> = ({
  value,
  onChange,
  options,
  className,
  disabled = false,
  error = false,
  disableTimePicker = false,
  placeholder,
  popoverAlign = 'start',
}) => {
  const [open, setOpen] = React.useState(false)
  const handleComplete = React.useCallback(() => setOpen(false), [])

  const core = useDateEditorCore({
    value,
    formatting: options?.formatting,
    disableTimePicker,
    onChange,
    onComplete: handleComplete,
  })

  const displayValue = React.useMemo(
    () => formatStoredDateValue(value ?? null, core.formatting, core.locale),
    [core.formatting, core.locale, value]
  )
  const placeholderText = placeholder ?? buildDateInputPlaceholder(core.formatting)

  const handleOpenChange = React.useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen)
      if (nextOpen) {
        core.resetFromValue(value)
      }
    },
    [core.resetFromValue, value]
  )

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
          placeholder={placeholderText}
          className={cn('cursor-pointer pr-10 text-left', !displayValue && 'text-muted-foreground', className)}
        />
        <PopoverTrigger asChild disabled={disabled}>
          <button
            type="button"
            className="absolute inset-0 rounded-md"
            aria-label={t('dateStringCellEditor.toggleCalendar')}
          />
        </PopoverTrigger>
        <CalendarDays className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      </div>

      <PopoverContent
        className="w-auto min-w-[300px] p-0"
        align={popoverAlign}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onInteractOutside={preventDismissForPortaledSelect}
        onPointerDownOutside={preventDismissForPortaledSelect}
      >
        <div className="flex w-full flex-col">
          <CalendarMonth
            month={core.displayMonth}
            onMonthChange={core.setDisplayMonth}
            selected={core.draftDate}
            onSelect={core.handleDaySelect}
            locale={core.locale}
            className="w-full"
          />

          <div className="flex w-full flex-wrap items-center gap-2 border-t px-3 py-2">
            {core.hasTimePicker ? (
              <TimeSelect
                value={core.timeValue}
                onChange={core.handleTimeChange}
                disabled={!core.draftDate}
              />
            ) : null}

            <div className="ml-auto flex items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={core.handleClear}
                disabled={!core.draftDate && !value}
              >
                {t('datePicker.clear')}
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={core.handleToday}>
                {core.hasTimePicker ? t('datePicker.now') : t('datePicker.today')}
              </Button>
              {core.hasTimePicker ? (
                <Button type="button" size="sm" onClick={core.handleConfirm} disabled={!core.draftDate}>
                  {t('common.confirm')}
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
