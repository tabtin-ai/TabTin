import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  DragRegion,
  SidebarDragRegion,
  WindowDragRegion,
  WINDOW_DRAG_REGION_HEIGHT,
  WINDOW_DRAG_REGION_MAC_TRAFFIC_LIGHT_WIDTH,
  WINDOW_DRAG_REGION_WINDOWS_CONTROL_WIDTH,
} from './drag-region'

vi.mock('@/utils/cn', () => ({
  cn: (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' '),
}))

describe('window drag regions', () => {
  it('renders a global draggable top strip with system-control reservations', () => {
    render(<WindowDragRegion
      reserveLeft={WINDOW_DRAG_REGION_MAC_TRAFFIC_LIGHT_WIDTH}
      reserveRight={WINDOW_DRAG_REGION_WINDOWS_CONTROL_WIDTH}
    />)

    const region = screen.getByTestId('window-drag-region')

    // eslint-disable-next-line tabtin/no-design-system-violations -- 断言源码渲染出 z-0 基线层，字面量本身不是样式
    expect(region.className).toContain('z-0')
    expect(region.getAttribute('style')).toContain(`height: ${WINDOW_DRAG_REGION_HEIGHT}px`)
    expect(region.getAttribute('style')).toContain(
      `left: ${WINDOW_DRAG_REGION_MAC_TRAFFIC_LIGHT_WIDTH}px`,
    )
    expect(region.getAttribute('style')).toContain(
      `right: ${WINDOW_DRAG_REGION_WINDOWS_CONTROL_WIDTH}px`,
    )
    expect(region.className).toContain('app-region-drag')
  })

  it('keeps sidebar drag region hittable for Electron window dragging', () => {
    const { container } = render(<SidebarDragRegion />)
    const region = container.firstElementChild

    expect(region?.className).toContain('z-sticky')
    expect(region?.className).not.toContain('pointer-events-none')
    expect(region?.className).toContain('app-region-drag')
  })

  it('marks child content as non-draggable inside a drag region', () => {
    render(
      <DragRegion>
        <button type="button">Action</button>
      </DragRegion>,
    )

    const childWrapper = screen.getByText('Action').parentElement

    expect(childWrapper?.className).toContain('app-region-no-drag')
  })
})
