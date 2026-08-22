import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SessionSpaceTreeHeader } from '../SessionSpaceTreeHeader'

describe('SessionSpaceTreeHeader', () => {
  const baseItem = {
    type: 'header' as const,
    key: 'space:ws-active',
    label: 'workspace-df1ff6',
    collapsed: false,
    depth: 0,
  }

  it('当前选中的工作空间行带 contextActive 高亮', () => {
    render(
      <SessionSpaceTreeHeader
        item={baseItem}
        highlightedSpaceId="ws-active"
        alreadyOnNewTaskLabel="当前已是新任务"
        resolveSpaceDeviceStatus={() => null}
        isSpaceAlreadyOnNewTask={() => false}
        onToggleCollapse={vi.fn()}
        t={(key, opts) => String(opts?.defaultValue ?? key)}
      />,
    )

    const row = screen.getByTestId('space-tree-header-ws-active')
    expect(row.getAttribute('aria-current')).toBe('true')
    // SIDEBAR_ROW_ACTIVE_CONTEXT_ACCENT：浅主题色底
    expect(row.className).toContain('bg-accent/10')
    expect(row.querySelector('svg')?.getAttribute('class') ?? '').toContain('text-accent')
  })

  it('非选中工作空间行不高亮', () => {
    render(
      <SessionSpaceTreeHeader
        item={baseItem}
        highlightedSpaceId="ws-other"
        alreadyOnNewTaskLabel="当前已是新任务"
        resolveSpaceDeviceStatus={() => null}
        isSpaceAlreadyOnNewTask={() => false}
        onToggleCollapse={vi.fn()}
        t={(key, opts) => String(opts?.defaultValue ?? key)}
      />,
    )

    const row = screen.getByTestId('space-tree-header-ws-active')
    expect(row.getAttribute('aria-current')).toBeNull()
    expect(row.className).not.toContain('bg-accent/10')
  })
})
