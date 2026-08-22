import * as React from 'react'
import { addMonths, setMonth, setYear, type Locale } from 'date-fns'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { DayPicker, type Matcher } from 'react-day-picker'
import { Button } from '../button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../select'
import { cn } from '../../utils/cn'
import {
  getMonthLabels,
  getYearOptions,
  MAX_CALENDAR_YEAR,
  MIN_CALENDAR_YEAR,
} from './utils'

export type RangeModifiers = Record<string, Matcher | Matcher[] | undefined>

const RANGE_MODIFIER_CLASSNAMES = {
  range_start:
    'bg-primary/10 rounded-l-md rounded-r-none [&>button]:bg-primary [&>button]:text-primary-foreground [&>button]:hover:bg-primary [&>button]:hover:text-primary-foreground',
  range_end:
    'bg-primary/10 rounded-r-md rounded-l-none [&>button]:bg-primary [&>button]:text-primary-foreground [&>button]:hover:bg-primary [&>button]:hover:text-primary-foreground',
  range_middle:
    'rounded-none bg-accent/70 [&>button]:bg-transparent [&>button]:text-foreground [&>button]:hover:bg-transparent [&>button]:hover:text-foreground',
} as const

export interface CalendarMonthProps {
  month: Date
  onMonthChange: (date: Date) => void
  selected?: Date
  onSelect: (date: Date | undefined) => void
  locale: Locale
  disabled?: boolean
  className?: string
  rangeModifiers?: RangeModifiers
  /**
   * Select 下拉 Portal 容器。传 `null` 强制挂 body（Dialog 已挂 body 时避免被压住）。
   */
  portalContainer?: HTMLElement | null
}

export const CalendarMonth: React.FC<CalendarMonthProps> = ({
  month,
  onMonthChange,
  selected,
  onSelect,
  locale,
  disabled = false,
  className,
  rangeModifiers,
  portalContainer,
}) => {
  const monthLabels = React.useMemo(() => getMonthLabels(locale), [locale])
  const yearOptions = React.useMemo(() => getYearOptions(month.getFullYear()), [month])
  const selectPortalProps =
    portalContainer !== undefined ? { container: portalContainer } : {}

  const handleMonthSelect = React.useCallback(
    (value: string) => {
      onMonthChange(setMonth(month, Number.parseInt(value, 10)))
    },
    [month, onMonthChange]
  )

  const handleYearSelect = React.useCallback(
    (value: string) => {
      onMonthChange(setYear(month, Number.parseInt(value, 10)))
    },
    [month, onMonthChange]
  )

  return (
    <div className={cn('w-full min-w-[280px]', className)}>
      <div className="flex items-center gap-2 border-b px-2 py-2">
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-8 w-8 shrink-0"
          onClick={() => onMonthChange(addMonths(month, -1))}
          disabled={disabled || (month.getFullYear() <= MIN_CALENDAR_YEAR && month.getMonth() === 0)}
          aria-label="Previous month"
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>

        <Select
          value={String(month.getMonth())}
          onValueChange={handleMonthSelect}
          disabled={disabled}
        >
          <SelectTrigger
            aria-label="Month"
            className="h-8 min-w-0 flex-1 text-body"
            disabled={disabled}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent {...selectPortalProps} className="max-h-56 z-dropdown">
            {monthLabels.map((label, index) => (
              <SelectItem
                key={label}
                value={String(index)}
                className="justify-center px-2 text-body"
              >
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={String(month.getFullYear())}
          onValueChange={handleYearSelect}
          disabled={disabled}
        >
          <SelectTrigger
            aria-label="Year"
            className="h-8 w-[96px] shrink-0 text-body"
            disabled={disabled}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent {...selectPortalProps} className="max-h-56 z-dropdown">
            {yearOptions.map((year) => (
              <SelectItem
                key={year}
                value={String(year)}
                className="justify-center px-2 text-body"
              >
                {year}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-8 w-8 shrink-0"
          onClick={() => onMonthChange(addMonths(month, 1))}
          disabled={disabled || (month.getFullYear() >= MAX_CALENDAR_YEAR && month.getMonth() === 11)}
          aria-label="Next month"
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>

      <DayPicker
        mode="single"
        month={month}
        selected={selected}
        onSelect={onSelect}
        onMonthChange={onMonthChange}
        locale={locale}
        showOutsideDays
        fixedWeeks
        hideNavigation
        startMonth={new Date(MIN_CALENDAR_YEAR, 0, 1)}
        endMonth={new Date(MAX_CALENDAR_YEAR, 11, 31)}
        modifiers={rangeModifiers}
        modifiersClassNames={RANGE_MODIFIER_CLASSNAMES}
        className="w-full p-3"
        classNames={{
          root: 'w-full',
          months: 'w-full',
          month: 'w-full',
          caption: 'hidden',
          month_caption: 'hidden',
          nav: 'hidden',
          month_grid: 'w-full border-collapse',
          table: 'w-full border-collapse',
          weekdays: 'grid w-full grid-cols-7',
          week: 'mt-1 grid w-full grid-cols-7',
          weekday:
            'flex h-9 w-full items-center justify-center text-caption font-medium uppercase tracking-wide text-muted-foreground',
          cell: 'relative w-full p-0 text-center text-body',
          day: 'flex h-9 w-full items-center justify-center p-0 font-normal',
          day_button: cn(
            'flex h-9 w-full max-w-none items-center justify-center rounded-md text-body font-normal outline-none transition-colors',
            'hover:bg-foreground/[0.06] dark:hover:bg-foreground/[0.08] focus-visible:ring-2 focus-visible:ring-ring'
          ),
          selected:
            '[&>button]:bg-primary [&>button]:text-primary-foreground [&>button]:hover:bg-primary [&>button]:hover:text-primary-foreground',
          today: '[&>button]:border [&>button]:border-primary/40',
          outside: 'text-muted-foreground opacity-35',
          disabled: 'text-muted-foreground opacity-35',
          hidden: 'invisible',
        }}
      />
    </div>
  )
}
