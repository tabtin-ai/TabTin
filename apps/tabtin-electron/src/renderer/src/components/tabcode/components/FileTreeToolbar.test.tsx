import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FileTreeToolbar } from './FileTreeToolbar'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const defaultProps = {
  onOpenQuickOpen: vi.fn(),
  onNewFile: vi.fn(),
  onNewFolder: vi.fn(),
  viewMode: 'all' as const,
  onCollapseAll: vi.fn(),
  onRefresh: vi.fn(),
}

describe('FileTreeToolbar', () => {
  it('点击文件搜索入口会打开 Quick Open', () => {
    render(<FileTreeToolbar {...defaultProps} isTreeExpanded={false} />)

    fireEvent.click(screen.getByRole('button', { name: 'quickOpen.placeholder' }))

    expect(defaultProps.onOpenQuickOpen).toHaveBeenCalledOnce()
  })

  it('仅在有目录展开时启用全部折叠按钮', () => {
    const { rerender } = render(
      <FileTreeToolbar {...defaultProps} isTreeExpanded={false} />,
    )

    const collapseButton = screen.getByRole('button', { name: 'fileTree.collapseAll' })
    expect((collapseButton as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(collapseButton)
    expect(defaultProps.onCollapseAll).not.toHaveBeenCalled()

    rerender(<FileTreeToolbar {...defaultProps} isTreeExpanded />)
    expect((collapseButton as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(collapseButton)
    expect(defaultProps.onCollapseAll).toHaveBeenCalledOnce()
  })
})
