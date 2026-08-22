import * as React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const popoverContentCalls = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown>>,
}))

vi.mock('../popover', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({
    children,
    align,
  }: {
    children: React.ReactNode
    align?: string
  }) => {
    popoverContentCalls.calls.push({ align })

    return <div data-align={align}>{children}</div>
  },
}))

vi.mock('./useDateEditorCore', () => ({
  useDateEditorCore: () => ({
    formatting: { date: 'YYYY-MM-DD', time: 'None', timeZone: 'UTC' },
    locale: {},
    hasTimePicker: false,
    draftDate: undefined,
    timeValue: '00:00',
    displayMonth: new Date('2026-08-01T00:00:00.000Z'),
    resetFromValue: vi.fn(),
    handleDaySelect: vi.fn(),
    handleTimeChange: vi.fn(),
    handleClear: vi.fn(),
    handleToday: vi.fn(),
    handleConfirm: vi.fn(),
  }),
}))

vi.mock('./CalendarMonth', () => ({
  CalendarMonth: () => <div>calendar</div>,
}))

vi.mock('./TimeSelect', () => ({
  TimeSelect: () => <div>time-select</div>,
}))

vi.mock('../../i18n', () => ({
  t: (key: string) => key,
}))

import { DatePicker } from './DatePicker'

describe('DatePicker', () => {
  it('forwards popover alignment to the calendar panel', () => {
    render(
      <DatePicker
        value={null}
        onChange={vi.fn()}
        placeholder="YYYY-MM-DD"
        popoverAlign="end"
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'dateStringCellEditor.toggleCalendar' }))
    expect(popoverContentCalls.calls.at(-1)?.align).toBe('end')
  })
})
