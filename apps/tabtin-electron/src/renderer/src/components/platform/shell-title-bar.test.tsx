import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { WINDOW_DRAG_REGION_WINDOWS_CONTROL_WIDTH } from './drag-region'
import { ShellTitleBar } from './shell-title-bar'

vi.mock('@/utils/cn', () => ({
  cn: (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' '),
}))

vi.mock('./window-controls', () => ({
  WindowControls: ({ className }: { className?: string }) => (
    <div data-testid="window-controls" className={className} />
  ),
}))

describe('ShellTitleBar', () => {
  it('does not render on the main window (ShellTopBar owns chrome)', () => {
    const { container } = render(<ShellTitleBar />)
    expect(container.firstChild).toBeNull()
    expect(screen.queryByTestId('shell-window-frame-overlay')).toBeNull()
    expect(screen.queryByTestId('window-controls')).toBeNull()
  })

  it('enables a reserved fallback drag strip and controls when requested', () => {
    render(<ShellTitleBar fallbackDrag />)

    const overlay = screen.getByTestId('shell-window-frame-overlay')
    const dragRegion = screen.getByTestId('window-drag-region')
    const controls = screen.getByTestId('window-controls')

    expect(overlay.className).toContain('pointer-events-none')
    expect(dragRegion.className).toContain('pointer-events-auto')
    expect(dragRegion.getAttribute('style')).toContain('height: 36px')
    expect(dragRegion.getAttribute('style')).toContain(
      `right: ${WINDOW_DRAG_REGION_WINDOWS_CONTROL_WIDTH}px`,
    )
    expect(controls.className).toContain('pointer-events-auto')
    expect(controls.className).toContain('app-region-no-drag')
  })
})
