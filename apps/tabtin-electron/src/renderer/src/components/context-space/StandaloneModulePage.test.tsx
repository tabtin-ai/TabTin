import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { StandaloneModulePage } from './StandaloneModulePage'

vi.mock('./ContextPageHeader', () => ({
  ContextPageHeader: ({ title }: { title: React.ReactNode }) => (
    <header data-testid="context-page-header">{title}</header>
  ),
}))

describe('StandaloneModulePage', () => {
  it('#7063 内容槽是 flex 列，子层 flex-1/overflow-y-auto 才能拿到确定高度并滚动', () => {
    const { container } = render(
      <StandaloneModulePage
        icon={<span aria-hidden>icon</span>}
        title="技能库"
        description="subtitle"
        testId="standalone-module-page"
      >
        <div data-testid="scroll-body" className="min-h-0 flex-1 overflow-y-auto">
          body
        </div>
      </StandaloneModulePage>,
    )

    expect(screen.getByTestId('standalone-module-page')).toBeTruthy()
    expect(screen.getByTestId('context-page-header').textContent).toContain('技能库')

    const scrollBody = screen.getByTestId('scroll-body')
    const contentSlot = scrollBody.parentElement
    expect(contentSlot).toBeTruthy()
    expect(contentSlot?.className).toMatch(/\bflex\b/)
    expect(contentSlot?.className).toMatch(/\bflex-col\b/)
    expect(contentSlot?.className).toMatch(/\bflex-1\b/)
    expect(contentSlot?.className).toMatch(/\bmin-h-0\b/)
    expect(contentSlot?.className).toMatch(/\boverflow-hidden\b/)

    const root = container.querySelector('[data-testid="standalone-module-page"]')
    expect(root?.className).toMatch(/\bh-full\b/)
    expect(root?.className).toMatch(/\bflex-col\b/)
  })
})
