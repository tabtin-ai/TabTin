import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { TrackerScheduleOccurrence } from '@/services/trackerApi'
import { getMonthGridRange } from './trackerScheduleWindow'
import { TrackerMonthCalendar } from './TrackerMonthCalendar'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string; count?: number; date?: string }) => {
      if (opts?.defaultValue) {
        return opts.defaultValue
          .replace('{{count}}', String(opts.count ?? ''))
          .replace('{{date}}', opts.date ?? '')
      }
      return key.split('.').pop() ?? key
    },
    i18n: { resolvedLanguage: 'zh-CN', language: 'zh-CN' },
  }),
}))

describe('TrackerMonthCalendar', () => {
  it('每格最多 3 条，带日期上下文的 +N 可打开并聚焦隐藏任务', async () => {
    const onOccurrenceClick = vi.fn()
    const { days } = getMonthGridRange(new Date(2026, 6, 15))
    const day = new Date(2026, 6, 22)
    const occurrences: TrackerScheduleOccurrence[] = Array.from({ length: 5 }, (_, i) => ({
      tracker_id: `t${i}`,
      name: `任务${i}`,
      space_id: 'space-1',
      space_name: null,
      scheduled_at: new Date(2026, 6, 22, 8 + i, 0).toISOString(),
      status: 'active' as const,
      trigger_type: 'cron',
      timezone: 'UTC',
    }))

    render(
      <TrackerMonthCalendar
        days={days}
        anchorMonth={day}
        todayKey="2026-07-22"
        occurrences={occurrences}
        onOccurrenceClick={onOccurrenceClick}
      />,
    )

    expect(screen.getByText('任务0')).toBeTruthy()
    expect(screen.getByText('任务1')).toBeTruthy()
    expect(screen.getByText('任务2')).toBeTruthy()
    expect(screen.getByText(new Intl.DateTimeFormat('zh-CN', { weekday: 'short' }).format(days[0]))).toBeTruthy()
    expect(screen.getByText(
      new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' })
        .format(new Date(occurrences[0].scheduled_at)),
    )).toBeTruthy()
    expect(screen.queryByText('任务3')).toBeNull()
    expect(screen.getByText('+2')).toBeTruthy()

    const moreButton = screen.getByRole('button', { name: /7.*22.*2/ })
    moreButton.focus()
    expect(document.activeElement).toBe(moreButton)
    fireEvent.click(moreButton)
    const hiddenTask = await screen.findByRole('button', { name: /任务3/ })
    await waitFor(() => expect(document.activeElement).toBe(hiddenTask))
    fireEvent.click(hiddenTask)
    expect(onOccurrenceClick).toHaveBeenCalledWith(occurrences[3])
  })

  it('点击可见 occurrence 打开回调', () => {
    const onOccurrenceClick = vi.fn()
    const { days } = getMonthGridRange(new Date(2026, 6, 15))
    const occ: TrackerScheduleOccurrence = {
      tracker_id: 't1',
      name: '月历任务',
      space_id: 'space-1',
      space_name: '研发',
      scheduled_at: new Date(2026, 6, 10, 9, 0).toISOString(),
      status: 'active',
      trigger_type: 'cron',
      timezone: 'UTC',
    }

    render(
      <TrackerMonthCalendar
        days={days}
        anchorMonth={new Date(2026, 6, 1)}
        todayKey="2026-07-22"
        occurrences={[occ]}
        onOccurrenceClick={onOccurrenceClick}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /月历任务/ }))
    expect(onOccurrenceClick).toHaveBeenCalledWith(occ)
  })

  it('月网格包含表头 row、columnheader 与 6 个日期 row', () => {
    const { days } = getMonthGridRange(new Date(2026, 6, 15))
    render(
      <TrackerMonthCalendar
        days={days}
        anchorMonth={new Date(2026, 6, 1)}
        todayKey="2026-07-22"
        occurrences={[]}
        onOccurrenceClick={vi.fn()}
      />,
    )

    const grid = screen.getByRole('grid')
    expect(within(grid).getAllByRole('row')).toHaveLength(7)
    expect(within(grid).getAllByRole('columnheader')).toHaveLength(7)
    expect(within(grid).getAllByRole('gridcell')).toHaveLength(42)
  })
})
