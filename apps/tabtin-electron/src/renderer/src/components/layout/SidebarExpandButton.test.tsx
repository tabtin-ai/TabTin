import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const { toggleSidebar } = vi.hoisted(() => ({ toggleSidebar: vi.fn() }))

vi.mock('@stores/useUIStore', () => ({
  useUIStore: (selector: (state: { toggleSidebar: typeof toggleSidebar }) => unknown) => selector({ toggleSidebar }),
}))

import { SidebarExpandButton } from './SidebarExpandButton'

describe('SidebarExpandButton', () => {
  it('在展开态复用同一开关提供收起入口', () => {
    render(<SidebarExpandButton action="collapse" />)

    const button = screen.getByRole('button', { name: '折叠侧边栏' })
    fireEvent.click(button)

    expect(toggleSidebar).toHaveBeenCalledTimes(1)
    expect(button.className).toContain('app-region-no-drag')
  })
})
