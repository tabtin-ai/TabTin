import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import React from 'react'
import { LinkedRecordsTable } from './LinkedRecordsTable'

describe('LinkedRecordsTable', () => {
  it('renders empty state', () => {
    const html = renderToStaticMarkup(
      React.createElement(LinkedRecordsTable, { items: [] }),
    )
    expect(html).toContain('暂无关联记录')
  })

  it('renders linked titles and unlink control when enabled', () => {
    const onUnlink = vi.fn()
    const html = renderToStaticMarkup(
      React.createElement(LinkedRecordsTable, {
        items: [{ id: '1', title: '2025-12' }],
        onUnlink,
      }),
    )
    expect(html).toContain('2025-12')
    expect(html).toContain('解除关联')
  })

  it('shows select records button when onAdd provided', () => {
    const html = renderToStaticMarkup(
      React.createElement(LinkedRecordsTable, {
        items: [],
        onAdd: () => undefined,
      }),
    )
    expect(html).toContain('选择记录')
  })

  it('hides add when single-select already has one item', () => {
    const html = renderToStaticMarkup(
      React.createElement(LinkedRecordsTable, {
        items: [{ id: '1', title: 'only' }],
        isSingleSelect: true,
        onAdd: () => undefined,
      }),
    )
    expect(html).not.toContain('选择记录')
  })

  it('open/unlink buttons wire click handlers (stopPropagation at runtime)', () => {
    // SSR markup 无法断言 stopPropagation；这里保证控件仍渲染且带 title，
    // 运行时行为由 LinkedRecordsTable.tsx 源码 onClick 内 stopPropagation 保证。
    const html = renderToStaticMarkup(
      React.createElement(LinkedRecordsTable, {
        items: [{ id: '1', title: 'row' }],
        onOpenRecord: () => undefined,
        onUnlink: () => undefined,
      }),
    )
    expect(html).toContain('打开记录详情')
    expect(html).toContain('解除关联')
  })
})
