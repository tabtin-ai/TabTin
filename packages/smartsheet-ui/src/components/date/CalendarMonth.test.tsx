import { fireEvent, render, screen } from '@testing-library/react'
import { zhCN } from 'date-fns/locale'
import { describe, expect, it } from 'vitest'
import { CalendarMonth } from './CalendarMonth'

describe('CalendarMonth', () => {
  it('centers month and year dropdown values', async () => {
    Element.prototype.scrollIntoView = () => undefined

    const props = {
      month: new Date(2026, 7, 15),
      onMonthChange: () => undefined,
      onSelect: () => undefined,
      locale: zhCN,
    }

    const { unmount } = render(<CalendarMonth {...props} />)
    fireEvent.click(screen.getByRole('combobox', { name: 'Month' }))
    expect((await screen.findByRole('option', { name: '8月' })).className).toContain(
      'justify-center'
    )

    unmount()
    render(<CalendarMonth {...props} />)
    fireEvent.click(screen.getByRole('combobox', { name: 'Year' }))
    expect((await screen.findByRole('option', { name: '2026' })).className).toContain(
      'justify-center'
    )
  })
})
