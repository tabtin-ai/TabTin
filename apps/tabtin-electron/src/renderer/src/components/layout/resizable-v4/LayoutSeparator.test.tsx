import React from 'react'
import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { LayoutSeparator } from './index'

vi.mock('react-resizable-panels', () => ({
  Group: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  Panel: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  Separator: ({
    children,
    className,
    ...rest
  }: {
    children?: React.ReactNode
    className?: string
  }) => (
    <div
      aria-orientation="vertical"
      className={className}
      data-testid="layout-separator"
      {...rest}
    >
      {children}
    </div>
  ),
}))

describe('LayoutSeparator', () => {
  it('keeps a stronger persistent divider line for Retina visibility', () => {
    const { getByTestId } = render(<LayoutSeparator persistentLine />)
    const line = getByTestId('layout-separator').querySelector('div')

    expect(line?.className).toContain('bg-muted-foreground/35')
    expect(line?.className).toContain('w-0.5')
    expect(line?.className).toContain('left-0')
    expect(line?.className).not.toContain('-translate-x-1/2')
  })

  it('stays transparent until hover when the line is not persistent', () => {
    const { getByTestId } = render(<LayoutSeparator />)
    const line = getByTestId('layout-separator').querySelector('div')

    expect(line?.className).toContain('bg-border/0')
    expect(line?.className).toContain('group-hover:bg-muted-foreground/50')
  })
})
