import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FileTreeItem } from './FileTreeItem'

afterEach(cleanup)

describe('FileTreeItem selection', () => {
  it.each([
    { name: '目录', isDirectory: true },
    { name: '文件', isDirectory: false },
  ])('为选中的$name显示明确高亮', ({ name, isDirectory }) => {
    render(
      <FileTreeItem
        entry={{
          name,
          path: `/workspace/${name}`,
          isDirectory,
          size: 0,
          modifiedAt: null,
        }}
        depth={0}
        isExpanded={false}
        isSelected
        onToggle={vi.fn()}
        onSelect={vi.fn()}
      />,
    )

    const row = screen.getByRole('button')
    expect(row.className).toContain('bg-primary/10')
    expect(row.className).toContain('ring-primary/20')
    expect(row.getAttribute('aria-pressed')).toBe('true')
  })
})
