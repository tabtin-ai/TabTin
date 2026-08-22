import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}))

vi.mock('@tabtin/smartsheet-ui', () => ({
  ContextMenu: ({ open, children }: { open: boolean; children: React.ReactNode }) => (
    open ? <div data-testid="context-menu">{children}</div> : null
  ),
  ContextMenuItem: ({
    label,
    onClick,
  }: {
    label: React.ReactNode
    onClick?: () => void
  }) => (
    <button type="button" onClick={onClick}>
      {label}
    </button>
  ),
  ContextMenuDivider: () => <hr />,
}))

import { FileContextMenu } from '../FileContextMenu'

describe('FileContextMenu', () => {
  it('keeps create actions available for folders', () => {
    const onNewFile = vi.fn()
    const onNewFolder = vi.fn()

    render(
      <FileContextMenu
        entry={{ path: '/workspace/src', name: 'src', isDirectory: true }}
        onNewFile={onNewFile}
        onNewFolder={onNewFolder}
      >
        <button type="button">src</button>
      </FileContextMenu>,
    )

    fireEvent.contextMenu(screen.getByText('src'))
    fireEvent.click(screen.getByText('新建文件'))
    fireEvent.click(screen.getByText('新建文件夹'))

    expect(onNewFile).toHaveBeenCalledTimes(1)
    expect(onNewFolder).toHaveBeenCalledTimes(1)
  })

  it('hides create actions for files even when callbacks are supplied', () => {
    render(
      <FileContextMenu
        entry={{ path: '/workspace/src/index.ts', name: 'index.ts', isDirectory: false }}
        onNewFile={vi.fn()}
        onNewFolder={vi.fn()}
      >
        <button type="button">index.ts</button>
      </FileContextMenu>,
    )

    fireEvent.contextMenu(screen.getByText('index.ts'))

    expect(screen.queryByText('新建文件')).toBeNull()
    expect(screen.queryByText('新建文件夹')).toBeNull()
  })
})
