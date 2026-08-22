import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

import { WebSearchCard } from '../WebSearchCard'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (key === 'card.result_count') return `${String(opts?.count ?? 0)} results`
      return key
    },
  }),
}))

describe('WebSearchCard', () => {
  it('collapses search results by default and expands from the header', () => {
    const { container } = render(
      <WebSearchCard
        query="tabtin docs"
        results={[
          {
            title: 'TabTin manual',
            url: 'https://example.com/manual',
            snippet: 'A short result snippet',
          },
        ]}
      />,
    )

    const header = screen.getByRole('button', { expanded: false })
    expect(screen.getByText('tabtin docs')).toBeTruthy()
    expect(screen.getByText('1 results')).toBeTruthy()
    expect(container.textContent).not.toContain('TabTin manual')
    expect(screen.queryByText('A short result snippet')).toBeNull()

    fireEvent.click(header)

    expect(screen.getByRole('button', { expanded: true })).toBeTruthy()
    expect(container.textContent).toContain('TabTin manual')
    expect(screen.getByText('A short result snippet')).toBeTruthy()
  })
})
