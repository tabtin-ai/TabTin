/**
 * OverflowPopover 行为回归测试
 *
 * 验证：
 *   1. overflowTabKeys 为空 → 整个组件不渲染（null）
 *   2. 触发按钮显示正确数量 +N
 *   3. 单击 item → onActivateTabKey + popover 关闭（onOpenChange→false）
 *   4. 中键 item → onCloseItem
 *   5. group 类 key（"group:..."）走 anchorTabKey fallback
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import type { CanvasLayoutGroup } from '@stores/useCanvasLayoutStore'
import type { ContextItem } from '@components/context-space/registry'

// smartsheet-ui Popover 由 Radix 实现，jsdom 中要让它直接展开 children；用最小桥接 mock
vi.mock('@tabtin/smartsheet-ui', async () => {
  const React = await import('react')
  return {
    Popover: ({ children, open: _open, onOpenChange: _onOpenChange }: { children: React.ReactNode; open?: boolean; onOpenChange?: (open: boolean) => void }) => {
      void _open
      void _onOpenChange
      return React.createElement('div', { 'data-mock-popover': true }, children)
    },
    PopoverTrigger: ({ children }: { children: React.ReactNode; asChild?: boolean }) => {
      // asChild 模式直接 render children
      return children as React.ReactElement
    },
    PopoverContent: ({ children }: { children: React.ReactNode }) => {
      // 始终 render（jsdom 不模拟 Radix 的 portal/visibility）
      return React.createElement('div', { 'data-mock-popover-content': true }, children)
    },
    ScrollArea: ({ children }: { children: React.ReactNode }) => {
      return React.createElement('div', { 'data-mock-scroll-area': true }, children)
    },
  }
})

import { OverflowPopover } from '../OverflowPopover'

const baseProps = (overrides: Partial<React.ComponentProps<typeof OverflowPopover>> = {}) => {
  const tabKeyToItem = new Map<string, ContextItem>([
    ['tabweb:a', { type: 'tabweb', id: 'a', tabKey: 'tabweb:a' as ContextItem['tabKey'], title: 'Site A' }],
    ['tabweb:b', { type: 'tabweb', id: 'b', tabKey: 'tabweb:b' as ContextItem['tabKey'], title: 'Site B' }],
  ])
  return {
    overflowTabKeys: ['tabweb:a', 'tabweb:b'],
    activeTabKey: null as string | null,
    groupLookup: new Map<string, CanvasLayoutGroup>(),
    tabKeyToItem,
    tabKeyToGroup: new Map<string, CanvasLayoutGroup>(),
    t: ((key: string, opts?: { defaultValue?: string }) =>
      opts?.defaultValue ?? key) as unknown as React.ComponentProps<typeof OverflowPopover>['t'],
    getLabelForTabKey: (key: string | null) => key ?? '',
    getIconForTabKey: () => null,
    onActivateTabKey: vi.fn(),
    onCloseItem: vi.fn(),
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('OverflowPopover', () => {
  it('overflowTabKeys 为空 → 渲染 null（即 popover 触发按钮不出现）', () => {
    const { container } = render(<OverflowPopover {...baseProps({ overflowTabKeys: [] })} />)
    expect(container.querySelector('button')).toBeNull()
  })

  it('触发按钮显示正确数量 +N', () => {
    const { container } = render(<OverflowPopover {...baseProps()} />)
    const trigger = container.querySelector('button')!
    expect(trigger.textContent?.trim()).toBe('+2')
  })

  it('点击 overflow item → 激活该 tabKey', () => {
    const onActivateTabKey = vi.fn()
    const { container } = render(<OverflowPopover {...baseProps({ onActivateTabKey })} />)
    const items = container.querySelectorAll('[data-overflow-item]')
    expect(items.length).toBe(2)
    fireEvent.click(items[1])
    expect(onActivateTabKey).toHaveBeenCalledWith('tabweb:b')
  })

  it('中键 item → onCloseItem(item)', () => {
    const onCloseItem = vi.fn()
    const { container } = render(<OverflowPopover {...baseProps({ onCloseItem })} />)
    const items = container.querySelectorAll('[data-overflow-item]')
    const event = new MouseEvent('auxclick', { bubbles: true, button: 1 })
    items[0].dispatchEvent(event)
    expect(onCloseItem).toHaveBeenCalledWith(
      expect.objectContaining({ tabKey: 'tabweb:a' }),
    )
  })

  it('点击 hover 关闭按钮 → onCloseItem(item)', () => {
    const onCloseItem = vi.fn()
    const { container } = render(<OverflowPopover {...baseProps({ onCloseItem })} />)
    const items = container.querySelectorAll('[data-overflow-item]')
    const closeBtn = items[1].querySelector('button[aria-label="tab.menu.close"]')!
    fireEvent.click(closeBtn)
    expect(onCloseItem).toHaveBeenCalledWith(
      expect.objectContaining({ tabKey: 'tabweb:b' }),
    )
  })

  it('不可关闭 item → 不显示关闭按钮且中键不触发关闭', () => {
    const onCloseItem = vi.fn()
    const { container } = render(
      <OverflowPopover
        {...baseProps({
          onCloseItem,
          isItemClosable: item => item.tabKey !== 'tabweb:a',
        })}
      />,
    )
    const items = container.querySelectorAll('[data-overflow-item]')
    const closeBtn = items[0].querySelector('button[aria-label="tab.menu.close"]')
    expect(closeBtn).toBeNull()

    const event = new MouseEvent('auxclick', { bubbles: true, button: 1 })
    items[0].dispatchEvent(event)
    expect(onCloseItem).not.toHaveBeenCalled()
  })

  it('group 类 key（"group:..."）→ 点击走 anchorTabKey fallback', () => {
    const groupLookup = new Map<string, CanvasLayoutGroup>([
      [
        'g1',
        {
          id: 'g1',
          spaceId: 'sp-1',
          panes: [
            { id: 'p1', content: { tabKey: 'tabweb:x' as `${string}:${string}` } },
            { id: 'p2', content: { tabKey: 'tabweb:y' as `${string}:${string}` } },
          ],
          activePaneId: 'p2',
          anchorTabKey: 'tabweb:x' as `${string}:${string}`,
        } as unknown as CanvasLayoutGroup,
      ],
    ])
    const onActivateTabKey = vi.fn()
    const { container } = render(
      <OverflowPopover
        {...baseProps({
          overflowTabKeys: ['group:g1'],
          groupLookup,
          tabKeyToItem: new Map(),
          onActivateTabKey,
        })}
      />,
    )
    const items = container.querySelectorAll('[data-overflow-item]')
    fireEvent.click(items[0])
    // 优先用 activePaneId=p2 → 'tabweb:y'
    expect(onActivateTabKey).toHaveBeenCalledWith('tabweb:y')
  })
})
