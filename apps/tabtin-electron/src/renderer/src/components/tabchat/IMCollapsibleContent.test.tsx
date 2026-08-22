import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  IM_COLLAPSE_CHAR_THRESHOLD,
  IMCollapsibleContent,
} from './IMCollapsibleContent'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? _key,
  }),
}))

describe('IMCollapsibleContent', () => {
  it('defers expensive full-content rendering until the reader explicitly expands a long message', () => {
    const renderFullContent = vi.fn(() => <div data-testid="full-content">full content</div>)
    const content = 'x'.repeat(IM_COLLAPSE_CHAR_THRESHOLD + 1)

    render(
      <IMCollapsibleContent messageKey="conv-1:101" content={content} shouldCollapse>
        {renderFullContent}
      </IMCollapsibleContent>,
    )

    expect(renderFullContent).not.toHaveBeenCalled()
    expect(screen.queryByTestId('full-content')).toBeNull()
    expect(screen.getByRole('button', { name: '展开全文' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '展开全文' }))

    expect(renderFullContent).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('full-content')).toBeTruthy()
    expect(screen.getByRole('button', { name: '收起' })).toBeTruthy()
  })

  it('remembers expansion when Virtuoso recycles and remounts the same message', () => {
    const content = 'x'.repeat(IM_COLLAPSE_CHAR_THRESHOLD + 1)
    const renderFullContent = vi.fn(() => <div data-testid="full-content">full content</div>)
    const view = render(
      <IMCollapsibleContent messageKey="conv-1:103" content={content} shouldCollapse>
        {renderFullContent}
      </IMCollapsibleContent>,
    )

    fireEvent.click(screen.getByRole('button', { name: '展开全文' }))
    view.unmount()

    render(
      <IMCollapsibleContent messageKey="conv-1:103" content={content} shouldCollapse>
        {renderFullContent}
      </IMCollapsibleContent>,
    )

    expect(screen.getByTestId('full-content')).toBeTruthy()
  })

  it('keeps distinct optimistic-message keys isolated even when their server id is shared', () => {
    const content = 'x'.repeat(IM_COLLAPSE_CHAR_THRESHOLD + 1)
    const renderFullContent = vi.fn(() => <div data-testid="full-content">full content</div>)
    const view = render(
      <IMCollapsibleContent messageKey="_opt_first" content={content} shouldCollapse>
        {renderFullContent}
      </IMCollapsibleContent>,
    )

    fireEvent.click(screen.getByRole('button', { name: '展开全文' }))
    view.unmount()

    render(
      <IMCollapsibleContent messageKey="_opt_second" content={content} shouldCollapse>
        {renderFullContent}
      </IMCollapsibleContent>,
    )

    expect(screen.queryByTestId('full-content')).toBeNull()
    expect(screen.getByRole('button', { name: '展开全文' })).toBeTruthy()
  })

  it('does not change ordinary-message rendering', () => {
    const renderFullContent = vi.fn(() => <div data-testid="full-content">short content</div>)

    render(
      <IMCollapsibleContent messageKey="conv-1:102" content="short" shouldCollapse={false}>
        {renderFullContent}
      </IMCollapsibleContent>,
    )

    expect(renderFullContent).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('full-content')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '展开全文' })).toBeNull()
  })
})
