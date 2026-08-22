import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { SidebarBrandHeader } from './SidebarBrandHeader'

describe('SidebarBrandHeader', () => {
  it('renders main client name without slogan', () => {
    render(<SidebarBrandHeader />)
    expect(screen.getByText('TabTin · 主端')).toBeTruthy()
    expect(screen.queryByText('看得见的 AI 工作')).toBeNull()
  })

  it('renders a distinct IM test client name', () => {
    render(<SidebarBrandHeader devInstanceId="im-2" />)
    expect(screen.getByText('TabTin · IM 测试端 im-2')).toBeTruthy()
  })

  it('renders black logo in light mode and white logo in dark mode', () => {
    const { container } = render(<SidebarBrandHeader />)
    const images = container.querySelectorAll('img')
    expect(images).toHaveLength(2)
    expect(images[0]?.className).toContain('dark:hidden')
    expect(images[1]?.className).toContain('dark:block')
  })
})
