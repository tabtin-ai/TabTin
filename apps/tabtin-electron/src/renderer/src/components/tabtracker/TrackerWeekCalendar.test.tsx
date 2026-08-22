import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import type { TrackerScheduleOccurrence } from '@/services/trackerApi'
import { getWeekRange } from './trackerScheduleWindow'
import { TrackerWeekCalendar } from './TrackerWeekCalendar'

const localeState = vi.hoisted(() => ({ value: 'en-US' }))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key.split('.').pop() ?? key,
    i18n: { resolvedLanguage: localeState.value, language: localeState.value },
  }),
}))

describe('TrackerWeekCalendar', () => {
  beforeEach(() => {
    localeState.value = 'en-US'
  })

  it('周卡展示时刻、任务名、space_name 与待执行；今天列有语义标记', () => {
    const anchor = new Date(2026, 6, 22) // 周三
    const { days } = getWeekRange(anchor)
    const todayKey = '2026-07-22'
    const occ: TrackerScheduleOccurrence = {
      tracker_id: 't1',
      name: '晨报催办',
      space_id: 'space-1',
      space_name: '产品空间',
      scheduled_at: new Date(2026, 6, 22, 9, 0).toISOString(),
      status: 'active',
      trigger_type: 'cron',
      timezone: 'Asia/Shanghai',
    }

    render(
      <TrackerWeekCalendar
        days={days}
        todayKey={todayKey}
        occurrences={[occ]}
        onOccurrenceClick={vi.fn()}
      />,
    )

    expect(screen.getByText('晨报催办')).toBeTruthy()
    expect(screen.getByText('产品空间')).toBeTruthy()
    expect(screen.getByText('待执行')).toBeTruthy()
    expect(screen.getByTestId(`tracker-week-day-${todayKey}`).getAttribute('data-today')).toBe('true')
  })

  it('点击 occurrence 回调', () => {
    const onOccurrenceClick = vi.fn()
    const { days } = getWeekRange(new Date(2026, 6, 22))
    const occ: TrackerScheduleOccurrence = {
      tracker_id: 't1',
      name: '任务 A',
      space_id: 'space-1',
      space_name: null,
      scheduled_at: new Date(2026, 6, 22, 10, 30).toISOString(),
      status: 'active',
      trigger_type: 'cron',
      timezone: 'UTC',
    }

    render(
      <TrackerWeekCalendar
        days={days}
        todayKey="2026-07-22"
        occurrences={[occ]}
        onOccurrenceClick={onOccurrenceClick}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /任务 A/ }))
    expect(onOccurrenceClick).toHaveBeenCalledWith(occ)
  })

  it('周网格按 ARIA grid → row → gridcell 组织', () => {
    const { days } = getWeekRange(new Date(2026, 6, 22))
    render(
      <TrackerWeekCalendar
        days={days}
        todayKey="2026-07-22"
        occurrences={[]}
        onOccurrenceClick={vi.fn()}
      />,
    )

    const grid = screen.getByRole('grid')
    const row = within(grid).getByRole('row')
    expect(within(row).getAllByRole('gridcell')).toHaveLength(7)
  })

  it('星期与时刻跟随应用 en-US / zh-CN 语言', () => {
    const anchor = new Date(2026, 6, 22)
    const { days } = getWeekRange(anchor)
    const scheduledAt = new Date(2026, 6, 22, 9, 0).toISOString()
    const occurrence: TrackerScheduleOccurrence = {
      tracker_id: 'localized',
      name: 'Localized task',
      space_id: 'space-1',
      space_name: null,
      scheduled_at: scheduledAt,
      status: 'active',
      trigger_type: 'cron',
      timezone: 'UTC',
    }

    localeState.value = 'en-US'
    const en = render(
      <TrackerWeekCalendar
        days={days}
        todayKey="2026-07-22"
        occurrences={[occurrence]}
        onOccurrenceClick={vi.fn()}
      />,
    )
    expect(screen.getByText(new Intl.DateTimeFormat('en-US', { weekday: 'short' }).format(days[0]))).toBeTruthy()
    expect(screen.getByText(new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit' }).format(new Date(scheduledAt)))).toBeTruthy()
    en.unmount()

    localeState.value = 'zh-CN'
    render(
      <TrackerWeekCalendar
        days={days}
        todayKey="2026-07-22"
        occurrences={[occurrence]}
        onOccurrenceClick={vi.fn()}
      />,
    )
    expect(screen.getByText(new Intl.DateTimeFormat('zh-CN', { weekday: 'short' }).format(days[0]))).toBeTruthy()
    expect(screen.getByText(new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(new Date(scheduledAt)))).toBeTruthy()
  })
})
