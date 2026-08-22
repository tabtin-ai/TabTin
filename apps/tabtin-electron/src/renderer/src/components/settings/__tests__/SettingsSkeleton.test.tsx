import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SettingsSkeleton } from '../SettingsSkeleton'

vi.mock('@tabtin/smartsheet-ui', () => ({
  Skeleton: ({ className, width, height }: { className?: string; width?: number | string; height?: number | string }) => (
    <div
      data-testid="skeleton-block"
      className={className}
      data-width={width}
      data-height={height}
    />
  ),
}))

describe('SettingsSkeleton', () => {
  it('renders full-panel placeholder with header, tab bar, and section cards', () => {
    render(<SettingsSkeleton />)

    expect(screen.getByTestId('settings-panel-skeleton').className).toContain('h-full')
    expect(screen.getAllByTestId('skeleton-block').length).toBeGreaterThanOrEqual(10)
  })

  it('can hide tab bar placeholder for single-panel layouts', () => {
    render(<SettingsSkeleton showTabBar={false} />)

    const blocks = screen.getAllByTestId('skeleton-block')
    const tabBarBlock = blocks.find((node) => node.getAttribute('data-width') === '280')
    expect(tabBarBlock).toBeUndefined()
  })
})
