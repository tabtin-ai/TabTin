import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DocFindPopover } from './DocFindPopover'

const translate = (key: string) => key

describe('DocFindPopover', () => {
  afterEach(() => cleanup())

  it('refocuses and selects the query for every find request', async () => {
    const props = {
      open: true,
      focusRequest: 1,
      query: '关键词',
      currentIndex: 0,
      total: 1,
      onQueryChange: vi.fn(),
      onClose: vi.fn(),
      onNext: vi.fn(),
      onPrevious: vi.fn(),
      t: translate,
    }
    const { getByRole, rerender } = render(<DocFindPopover {...props} />)
    const input = getByRole('searchbox') as HTMLInputElement

    await waitFor(() => expect(document.activeElement).toBe(input))
    const closeButton = getByRole('button', { name: 'find.close' })
    fireEvent.focus(closeButton)
    closeButton.focus()
    expect(document.activeElement).not.toBe(input)

    rerender(<DocFindPopover {...props} focusRequest={2} />)

    await waitFor(() => expect(document.activeElement).toBe(input))
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe(props.query.length)
  })
})
