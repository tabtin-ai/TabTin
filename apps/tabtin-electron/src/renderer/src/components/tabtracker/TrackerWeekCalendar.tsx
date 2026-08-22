import React, { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@utils/cn'
import { CANVAS_TAB_TEXT, CANVAS_TEXT_META, CANVAS_TEXT_META_BASE, CANVAS_TEXT_MICRO, CANVAS_TEXT_SECONDARY } from '@components/layout/canvasUi'
import type { TrackerScheduleOccurrence } from '@/services/trackerApi'
import {
  formatScheduleAriaLabel,
  groupOccurrencesByDate,
  toScheduleDateKey,
} from './trackerScheduleWindow'

export interface TrackerWeekCalendarProps {
  days: Date[]
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

export const TrackerWeekCalendar: React.FC<TrackerWeekCalendarProps> = ({
  days,
  todayKey,
  occurrences,
  onOccurrenceClick,
}) => {
  const { t, i18n } = useTranslation('tabtracker')
  const locale = i18n?.resolvedLanguage ?? i18n?.language
  const byDate = useMemo(() => groupOccurrencesByDate(occurrences), [occurrences])

  const weekdayLabels = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(locale, { weekday: 'short' })
    return days.map(d => fmt.format(d))
  }, [days, locale])

  return (
    <div
      data-testid="tracker-week-calendar"
      className="grid min-h-0 flex-1 grid-cols-7 gap-px overflow-hidden rounded-md border border-border/60 bg-border/60"
      role="grid"
      aria-label={t('schedule.weekGrid', { defaultValue: '周日历' })}
    >
      <div role="row" className="contents">
        {days.map((day, index) => {
          const key = toScheduleDateKey(day)
          const isToday = key === todayKey
          const dayOccs = byDate.get(key) ?? []
          const dayLabel = new Intl.DateTimeFormat(locale, { month: 'numeric', day: 'numeric' }).format(day)

          return (
            <div
              key={key}
              role="gridcell"
              data-testid={`tracker-week-day-${key}`}
              data-today={isToday ? 'true' : 'false'}
              className={cn(
                'flex min-h-0 flex-col bg-background p-1.5',
                isToday && 'bg-primary/5 ring-1 ring-inset ring-primary/30',
              )}
            >
              <div className="mb-1 flex items-baseline justify-between gap-1 px-0.5">
                <span className={CANVAS_TEXT_META}>{weekdayLabels[index]}</span>
                <span
                  className={cn(
                    CANVAS_TEXT_MICRO,
                    'font-medium',
                    isToday ? 'text-primary' : 'text-foreground',
                  )}
                >
                  {dayLabel}
                </span>
              </div>
              <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
                {dayOccs.map(occ => {
                  const time = formatTimeLabel(occ.scheduled_at, locale)
                  const spaceName = occ.space_name?.trim()
                  const pending = t('schedule.pending', { defaultValue: '待执行' })
                  const aria = formatScheduleAriaLabel(
                    [time, occ.name, spaceName, pending],
                    locale,
                  )
                  return (
                    <button
                      key={`${occ.tracker_id}-${occ.scheduled_at}`}
                      type="button"
                      onClick={() => onOccurrenceClick(occ)}
                      aria-label={aria}
                      className="w-full rounded-sm border border-border/40 bg-card px-1.5 py-1 text-left transition-colors hover:bg-accent/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <div className="flex items-center gap-1">
                        <span className={cn('tabular-nums', 'text-muted-foreground/80', CANVAS_TEXT_META)}>{time}</span>
                        <span className={cn('truncate', 'text-foreground', CANVAS_TEXT_META)}>{occ.name}</span>
                      </div>
                      {spaceName ? (
                        <div className={cn('truncate', CANVAS_TEXT_META)}>{spaceName}</div>
                      ) : null}
                      <div className={CANVAS_TEXT_META}>{pending}</div>
                    </button>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
