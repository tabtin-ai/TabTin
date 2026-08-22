import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ContextPageHeader } from './ContextPageHeader'

describe('ContextPageHeader', () => {
  it('keeps the muted surface for ordinary line icons', () => {
    render(
      <ContextPageHeader
        icon={<span data-testid="icon">I</span>}
        title="普通模块"
      />,
    )

    expect(screen.getByTestId('icon').parentElement?.className).toContain('bg-foreground/[0.04]')
  })

  it('does not add a second surface around self-contained app icons', () => {
    render(
      <ContextPageHeader
        icon={<img data-testid="icon" src="/app-icons/tabdoc.svg" alt="" />}
        iconSurface="none"
        title="文档"
      />,
    )

    expect(screen.getByTestId('icon').parentElement?.className).not.toContain('bg-foreground')
  })
})
