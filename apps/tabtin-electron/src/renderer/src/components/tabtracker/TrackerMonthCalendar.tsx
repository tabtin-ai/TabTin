import React, { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Popover, PopoverContent, PopoverTrigger } from '@components/ui'
import { cn } from '@utils/cn'
import { CANVAS_TAB_TEXT, CANVAS_TEXT_META, CANVAS_TEXT_META_BASE, CANVAS_TEXT_MICRO, CANVAS_TEXT_SECONDARY } from '@components/layout/canvasUi'
import type { TrackerScheduleOccurrence } from '@/services/trackerApi'
import {
  formatScheduleAriaLabel,
  groupOccurrencesByDate,
  toScheduleDateKey,
} from './trackerScheduleWindow'

const MAX_VISIBLE = 3

export interface TrackerMonthCalendarProps {
  days: Date[]
  anchorMonth: Date
  todayKey: string
  occurrences: TrackerScheduleOccurrence[]
  onOccurrenceClick: (occurrence: TrackerScheduleOccurrence) => void
}

function formatTimeLabel(iso: string, locale?: string): string {
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return ''
    return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(d)
  } catch {
    return ''
  }
}

export const TrackerMonthCalendar: React.FC<TrackerMonthCalendarProps> = ({
  days,
  anchorMonth,
  todayKey,
  occurrences,
  onOccurrenceClick,
}) => {
  const { t, i18n } = useTranslation('tabtracker')
  const locale = i18n?.resolvedLanguage ?? i18n?.language
  const byDate = useMemo(() => groupOccurrencesByDate(occurrences), [occurrences])
  const anchorMonthIndex = anchorMonth.getMonth()
  const anchorYear = anchorMonth.getFullYear()

  const weekdayLabels = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(locale, { weekday: 'short' })
    // 固定周一起始：2025-01-06 是周一
    return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(2025, 0, 6 + i)))
  }, [locale])
  const weekRows = useMemo(
    () => Array.from({ length: 6 }, (_, row) => days.slice(row * 7, row * 7 + 7)),
    [days],
  )

  return (
    <div
      data-testid="tracker-month-calendar"
      className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-border/60"
      role="grid"
      aria-label={t('schedule.monthGrid', { defaultValue: '月日历' })}
    >
      <div role="row" className="grid grid-cols-7 border-b border-border/60 bg-muted/20">
        {weekdayLabels.map(label => (
          <div
            key={label}
            role="columnheader"
            className={cn('px-1.5', 'py-1', 'text-center', 'font-medium', CANVAS_TEXT_META)}
          >
            {label}
          </div>
        ))}
      </div>
      <div role="presentation" className="grid min-h-0 flex-1 grid-cols-7 grid-rows-6 gap-px bg-border/40">
        {weekRows.map((week, rowIndex) => (
          <div key={week[0] ? toScheduleDateKey(week[0]) : rowIndex} role="row" className="contents">
            {week.map(day => {
              const key = toScheduleDateKey(day)
              const isToday = key === todayKey
              const inMonth = day.getMonth() === anchorMonthIndex && day.getFullYear() === anchorYear
              const dayOccs = byDate.get(key) ?? []
              const visible = dayOccs.slice(0, MAX_VISIBLE)
              const hiddenCount = Math.max(0, dayOccs.length - MAX_VISIBLE)
              const dateLabel = new Intl.DateTimeFormat(
                locale,
                { dateStyle: 'long' },
              ).format(day)

              return (
                <div
                  key={key}
                  role="gridcell"
                  data-testid={`tracker-month-day-${key}`}
                  data-today={isToday ? 'true' : 'false'}
                  className={cn(
                    'flex min-h-0 flex-col bg-background p-1',
                    !inMonth && 'bg-muted/10 text-muted-foreground/60',
                    isToday && 'bg-primary/5 ring-1 ring-inset ring-primary/30',
                  )}
                >
                  <span
                    className={cn(
                      'mb-0.5 px-0.5 CANVAS_TEXT_META',
                      isToday ? 'font-medium text-primary' : inMonth ? 'text-foreground' : 'text-muted-foreground/60',
                    )}
                  >
                    {day.getDate()}
                  </span>
                  <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-hidden">
                    {visible.map(occ => {
                      const time = formatTimeLabel(occ.scheduled_at, locale)
                      const aria = formatScheduleAriaLabel([
                        time,
                        occ.name,
                        occ.space_name,
                        t('schedule.pending', { defaultValue: '待执行' }),
                      ], locale)
                      return (
                        <button
                          key={`${occ.tracker_id}-${occ.scheduled_at}`}
                          type="button"
                          onClick={() => onOccurrenceClick(occ)}
                          aria-label={aria}
                          className={cn('truncate', 'rounded-sm', 'bg-primary/10', 'px-1', 'py-px', 'text-left', 'leading-4', 'text-primary', 'transition-colors', 'hover:bg-primary/20', 'focus-visible:outline-none', 'focus-visible:ring-2', 'focus-visible:ring-ring', CANVAS_TEXT_META)}
                          title={occ.name}
                        >
                          <span className="tabular-nums text-muted-foreground/80">{time}</span>
                          {' '}
                          {occ.name}
                        </button>
                      )
                    })}
                    {hiddenCount > 0 ? (
                      <Popover>
                        <PopoverTrigger asChild>
                          <button
                            type="button"
                            aria-label={t('schedule.moreAriaLabel', {
                              defaultValue: '{{date}}，另有 {{count}} 个任务',
                              date: dateLabel,
                              count: hiddenCount,
                            })}
                            className={cn('rounded-sm', 'px-1', 'text-left', 'transition-colors', 'hover:bg-accent/10', 'hover:text-foreground', 'focus-visible:outline-none', 'focus-visible:ring-2', 'focus-visible:ring-ring', CANVAS_TEXT_META)}
                          >
                            {t('schedule.moreCount', { defaultValue: '+{{count}}', count: hiddenCount })}
                          </button>
                        </PopoverTrigger>
                        <PopoverContent
                          align="start"
                          side="bottom"
                          sideOffset={4}
                          className="w-56 p-2"
                        >
                          <div className="flex max-h-48 flex-col gap-1 overflow-y-auto">
                            {dayOccs.slice(MAX_VISIBLE).map(occ => {
                              const time = formatTimeLabel(occ.scheduled_at, locale)
                              const aria = formatScheduleAriaLabel([
                                time,
                                occ.name,
                                occ.space_name,
                                t('schedule.pending', { defaultValue: '待执行' }),
                              ], locale)
                              return (
                                <button
                                  key={`${occ.tracker_id}-${occ.scheduled_at}`}
                                  type="button"
                                  onClick={() => onOccurrenceClick(occ)}
                                  aria-label={aria}
                                  className="rounded-sm px-2 py-1.5 text-left transition-colors hover:bg-accent/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                >
                                  <span className={cn('tabular-nums', 'text-muted-foreground/80', CANVAS_TEXT_META)}>{time}</span>
                                  <span className="ml-2 text-body text-foreground">{occ.name}</span>
                                  {occ.space_name ? (
                                    <span className={cn('block', 'truncate', CANVAS_TEXT_META)}>
                                      {occ.space_name}
                                    </span>
                                  ) : null}
                                </button>
                              )
                            })}
                          </div>
                        </PopoverContent>
                      </Popover>
                    ) : null}
                  </div>
                </div>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}
