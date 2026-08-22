/**
 * GroupTab 结构与右键菜单回归测试
 *
 * 验证：
 *   1. 渲染所有 segment（与 panes 数量一致）
 *   2. 点击 segment → 切换 active pane + activate tabKey
 *   3. 点击还原按钮（Minimize2）→ onRestoreGroup
 *   4. 中键 → 关闭当前 active pane 对应 item
 *   5. 右键 → 弹出 5 项菜单（splitGroup / closeGroup / closeOthers / closeLeft / closeRight）
 *   6. close-group 菜单项 → 对每个 closable item 调一次 onCloseItem
 *   7. split-group 菜单项 → onRestoreGroup
 *   8. W5 三项新增菜单项 → 对应 group handler + enabled 状态动态判断
 *
 * Wave 1 T3 + Wave 5 扩展：右键菜单从 2 项扩展为 5 项，对齐 NormalTab 关闭体验。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import type { CanvasLayoutGroup } from '@stores/useCanvasLayoutStore'
import type { ContextItem, ContextRegistry } from '@components/context-space/registry'
import type { NativeMenuItem } from '@/utils/nativeMenu'

const mockOpenNativeContextMenu = vi.fn().mockReturnValue(() => {})

vi.mock('@/utils/nativeMenu', () => ({
  openNativeContextMenu: (items: NativeMenuItem[], x?: number, y?: number) =>
    mockOpenNativeContextMenu(items, x, y),
  menuSeparator: () => ({ id: 'sep', type: 'separator' as const }),
}))

vi.mock('@stores/useCanvasLayoutStore', async () => {
  const actual = await vi.importActual<typeof import('@stores/useCanvasLayoutStore')>(
    '@stores/useCanvasLayoutStore',
  )
  return {
    ...actual,
    useCanvasLayoutStore: Object.assign(
      (sel: (s: Record<string, unknown>) => unknown) => sel({ setActivePane: vi.fn(), removeGroup: vi.fn() }),
      { getState: () => ({ setActivePane: vi.fn(), removeGroup: vi.fn() }) },
    ),
  }
})

const mockDirtyResult = { current: null as null | { status: string; isCollaborating: boolean } }

vi.mock('../hooks/useTabDocDirtyIndicator', () => ({
  useTabDocDirtyIndicator: () => mockDirtyResult.current,
}))

import { GroupTab } from '../GroupTab'

const makeRegistry = (): ContextRegistry => ({
  getTabLabel: (item: ContextItem) => item.title ?? item.tabKey,
  getTabIcon: () => null,
  isClosable: () => true,
}) as unknown as ContextRegistry

const makeGroup = (panes: Array<{ id: string; tabKey: string }>): CanvasLayoutGroup => ({
  id: 'g1',
  spaceId: 'sp-1',
  panes: panes.map(p => ({
    id: p.id,
    content: { tabKey: p.tabKey as `${string}:${string}` },
  })),
  layout: null,
  activePaneId: panes[0]?.id ?? null,
  anchorTabKey: panes[0]?.tabKey as `${string}:${string}` | null,
}) as unknown as CanvasLayoutGroup

const baseProps = (overrides: Partial<React.ComponentProps<typeof GroupTab>> = {}) => {
  const group = makeGroup([
    { id: 'p1', tabKey: 'tabweb:a' },
    { id: 'p2', tabKey: 'tabweb:b' },
  ])
  const tabKeyToItem = new Map<string, ContextItem>([
    ['tabweb:a', { type: 'tabweb', id: 'a', tabKey: 'tabweb:a' as ContextItem['tabKey'], title: 'A' }],
    ['tabweb:b', { type: 'tabweb', id: 'b', tabKey: 'tabweb:b' as ContextItem['tabKey'], title: 'B' }],
  ])
  return {
    group,
    isGroupActive: false,
    activeTabKey: null as string | null,
    registry: makeRegistry(),
    tabKeyToItem,
    t: ((key: string, opts?: { defaultValue?: string }) =>
      opts?.defaultValue ?? key) as unknown as React.ComponentProps<typeof GroupTab>['t'],
    onSetActivePane: vi.fn(),
    onActivateTabKey: vi.fn(),
    onRestoreGroup: vi.fn(),
    onCloseItem: vi.fn(),
    getLabelForTabKey: (key: string | null) => key ?? '',
    getIconForTabKey: () => null,
    reorderKey: 'tabweb:a',
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockDirtyResult.current = null
})

describe('GroupTab · 结构', () => {
  it('渲染所有 segment（与 panes 数量一致）', () => {
    const { container } = render(<GroupTab {...baseProps()} />)
    const segments = container.querySelectorAll('[role="tab"]')
    // 1 个 group 容器 + 2 个 segment = 3
    // 不过 group 容器没有 role="tab"，segment 才有
    expect(segments.length).toBe(2)
  })

  it('data-tab-item + data-group-tab 标记存在（用于 overflow detection 与样式区分）', () => {
    const { container } = render(<GroupTab {...baseProps()} />)
    expect(container.querySelector('[data-tab-item][data-group-tab]')).toBeTruthy()
  })
})

describe('GroupTab · 中键关闭', () => {
  it('中键 → 关闭当前 activePane 对应的 item', () => {
    const onCloseItem = vi.fn()
    const props = baseProps({ onCloseItem })
    const { container } = render(<GroupTab {...props} />)
    const groupRoot = container.querySelector('[data-group-tab]')!
    const event = new MouseEvent('auxclick', { bubbles: true, button: 1 })
    groupRoot.dispatchEvent(event)
    expect(onCloseItem).toHaveBeenCalledTimes(1)
    // activePaneId=p1 → tabweb:a
    expect(onCloseItem.mock.calls[0][0]).toMatchObject({ tabKey: 'tabweb:a' })
  })
})

describe('GroupTab · 右键菜单', () => {
  it('右键 → 调用 openNativeContextMenu 弹出 split-group + close-group', () => {
    const { container } = render(<GroupTab {...baseProps()} />)
    fireEvent.contextMenu(container.querySelector('[data-group-tab]')!)

    expect(mockOpenNativeContextMenu).toHaveBeenCalledTimes(1)
    const items = mockOpenNativeContextMenu.mock.calls[0][0] as NativeMenuItem[]
    const ids = items.filter(i => 'id' in i).map(i => i.id)
    expect(ids).toContain('split-group')
    expect(ids).toContain('close-group')
  })

  it('split-group onClick → onRestoreGroup(group)', () => {
    const onRestoreGroup = vi.fn()
    const props = baseProps({ onRestoreGroup })
    const { container } = render(<GroupTab {...props} />)
    fireEvent.contextMenu(container.querySelector('[data-group-tab]')!)

    const items = mockOpenNativeContextMenu.mock.calls[0][0] as Array<{ id: string; onClick?: () => void }>
    const splitItem = items.find(i => i.id === 'split-group')
    splitItem?.onClick?.()
    expect(onRestoreGroup).toHaveBeenCalledWith(props.group)
  })

  it('close-group onClick → 第一个同步立即关闭，其余 80ms 错峰触发（避免 N 个 closing 视觉同时挤压）', () => {
    vi.useFakeTimers()
    const onCloseItem = vi.fn()
    const props = baseProps({ onCloseItem })
    const { container } = render(<GroupTab {...props} />)
    fireEvent.contextMenu(container.querySelector('[data-group-tab]')!)

    const items = mockOpenNativeContextMenu.mock.calls[0][0] as Array<{ id: string; onClick?: () => void; enabled?: boolean }>
    const closeGroupItem = items.find(i => i.id === 'close-group')
    expect(closeGroupItem?.enabled).toBe(true)
    closeGroupItem?.onClick?.()

    // 第一个同步触发
    expect(onCloseItem).toHaveBeenCalledTimes(1)
    expect(onCloseItem.mock.calls[0][0]).toMatchObject({ tabKey: 'tabweb:a' })

    // 第二个在 80ms 后
    vi.advanceTimersByTime(80)
    expect(onCloseItem).toHaveBeenCalledTimes(2)
    expect(onCloseItem.mock.calls[1][0]).toMatchObject({ tabKey: 'tabweb:b' })

    vi.useRealTimers()
  })

  it('group 全空时 close-group 被 disabled', () => {
    const props = baseProps({
      group: makeGroup([]),  // 空 panes
      tabKeyToItem: new Map(),
    })
    const { container } = render(<GroupTab {...props} />)
    fireEvent.contextMenu(container.querySelector('[data-group-tab]')!)

    const items = mockOpenNativeContextMenu.mock.calls[0][0] as Array<{ id: string; enabled?: boolean }>
    const closeGroupItem = items.find(i => i.id === 'close-group')
    expect(closeGroupItem?.enabled).toBe(false)
  })
})

describe('GroupTab · 整体右上角还原按钮', () => {
  it('GroupTab 右上角只渲染一个还原按钮（segment 内不再有还原按钮）', () => {
    const props = baseProps()
    const { container } = render(<GroupTab {...props} />)
    const restoreBtns = container.querySelectorAll('button[aria-label="tab.restoreGroup"]')
    expect(restoreBtns.length).toBe(1)
  })

  it('点击右上角还原按钮 → onRestoreGroup(group)', () => {
    const onRestoreGroup = vi.fn()
    const props = baseProps({ onRestoreGroup })
    const { container } = render(<GroupTab {...props} />)
    const restoreBtn = container.querySelector('[data-restore-group-btn]')!
    fireEvent.click(restoreBtn)
    expect(onRestoreGroup).toHaveBeenCalledWith(props.group)
  })

  it('始终为 absolute 还原按钮预留宽度，长标题不会延伸到按钮下方', () => {
    const { container } = render(<GroupTab {...baseProps()} />)
    const root = container.querySelector('[data-group-tab]') as HTMLElement
    const grid = root.querySelector('.grid') as HTMLElement
    const restoreBtn = root.querySelector('[data-restore-group-btn]') as HTMLElement

    expect(root.className).toContain('pr-7')
    expect(grid.className).toContain('flex-1')
    expect(grid.className).not.toContain('w-full')
    expect(restoreBtn.className).toContain('right-1')
  })
})

describe('GroupTab · 拖拽排序反馈', () => {
  it('整组可作为一个标签槽位拖动，并显示让位动画', () => {
    const onDragStart = vi.fn()
    const { container } = render(
      <GroupTab
        {...baseProps({
          reorderOffsetX: -96,
          dragProps: {
            draggable: true,
            onDragStart,
            onDragEnd: vi.fn(),
          },
        })}
      />,
    )
    const root = container.querySelector('[data-group-tab]') as HTMLElement

    expect(root.draggable).toBe(true)
    expect(root.style.transform).toBe('translateX(-96px)')
    expect(root.querySelector('[data-reorder-marker]')).toBeNull()
    fireEvent.dragStart(root)
    expect(onDragStart).toHaveBeenCalledTimes(1)
  })

  it('拖动源组时保留中性空占位，并隐藏全部原内容', () => {
    const { container } = render(<GroupTab {...baseProps({ isDragging: true })} />)
    const root = container.querySelector('[data-group-tab]') as HTMLElement
    const content = root.querySelector('[data-tab-drag-content]') as HTMLElement
    const restoreBtn = root.querySelector('[data-restore-group-btn]') as HTMLElement

    expect(root.dataset.tabDragging).toBe('true')
    expect(root.dataset.tabPlaceholder).toBe('true')
    expect(root.className).toContain('border-border/60')
    expect(root.className).not.toContain('border-accent')
    expect(content.className).toContain('invisible')
    expect(content.hasAttribute('inert')).toBe(true)
    expect(restoreBtn.className).toContain('opacity-0')
  })
})

describe('GroupTab · 单 segment 自适应布局（W4 T4）', () => {
  const makeSinglePaneGroup = () =>
    makeGroup([{ id: 'p1', tabKey: 'tabweb:a' }])

  it('1 segment 时不渲染 grid-cols-2 / divide-x', () => {
    const group = makeSinglePaneGroup()
    const tabKeyToItem = new Map<string, ContextItem>([
      ['tabweb:a', { type: 'tabweb', id: 'a', tabKey: 'tabweb:a' as ContextItem['tabKey'], title: 'A' }],
    ])
    const { container } = render(
      <GroupTab {...baseProps({ group, tabKeyToItem })} />,
    )
    const gridDiv = container.querySelector('[data-group-tab] .grid')
    expect(gridDiv).toBeTruthy()
    expect(gridDiv!.className).not.toContain('grid-cols-2')
    expect(gridDiv!.className).not.toContain('divide-x')
  })

  it('2 segment 时渲染 grid-cols-2 + divide-x', () => {
    const { container } = render(<GroupTab {...baseProps()} />)
    const gridDiv = container.querySelector('[data-group-tab] .grid')
    expect(gridDiv!.className).toContain('grid-cols-2')
    expect(gridDiv!.className).toContain('divide-x')
  })

  it('1 segment 时仍渲染分屏标识（Columns2 icon）', () => {
    const group = makeSinglePaneGroup()
    const tabKeyToItem = new Map<string, ContextItem>([
      ['tabweb:a', { type: 'tabweb', id: 'a', tabKey: 'tabweb:a' as ContextItem['tabKey'], title: 'A' }],
    ])
    const { container } = render(
      <GroupTab {...baseProps({ group, tabKeyToItem })} />,
    )
    expect(container.querySelector('[data-split-indicator]')).toBeTruthy()
  })

  it('单 pane group 仍然渲染右上角还原按钮（用户可拆回独立 tab）', () => {
    const group = makeSinglePaneGroup()
    const tabKeyToItem = new Map<string, ContextItem>([
      ['tabweb:a', { type: 'tabweb', id: 'a', tabKey: 'tabweb:a' as ContextItem['tabKey'], title: 'A' }],
    ])
    const { container } = render(
      <GroupTab {...baseProps({ group, tabKeyToItem })} />,
    )
    const restoreBtn = container.querySelector('[data-restore-group-btn]')
    expect(restoreBtn).toBeTruthy()
  })
})

describe('GroupTab · 分屏标识（W4 T4）', () => {
  it('多 segment 时也显示分屏标识', () => {
    const { container } = render(<GroupTab {...baseProps()} />)
    expect(container.querySelector('[data-split-indicator]')).toBeTruthy()
  })

  it('分屏标识有正确的 aria-label', () => {
    const { container } = render(<GroupTab {...baseProps()} />)
    const indicator = container.querySelector('[data-split-indicator]')!
    expect(indicator.getAttribute('aria-label')).toBe('分屏')
  })
})

describe('GroupTab · segment dirty 指示符（W4 T4 D-W4-9）', () => {
  it('dirty 状态 → segment 内出现 dirty 指示符', () => {
    mockDirtyResult.current = { status: 'dirty', isCollaborating: false }
    const { container } = render(<GroupTab {...baseProps()} />)
    const indicators = container.querySelectorAll('[data-segment-dirty-indicator="dirty"]')
    expect(indicators.length).toBeGreaterThan(0)
  })

  it('saving 状态 → segment 内出现 saving 指示符（旋转）', () => {
    mockDirtyResult.current = { status: 'saving', isCollaborating: false }
    const { container } = render(<GroupTab {...baseProps()} />)
    const indicators = container.querySelectorAll('[data-segment-dirty-indicator="saving"]')
    expect(indicators.length).toBeGreaterThan(0)
    expect(container.querySelector('.animate-spin')).toBeTruthy()
  })

  it('error 状态 → segment 内出现 error 指示符（红圆点）', () => {
    mockDirtyResult.current = { status: 'error', isCollaborating: false }
    const { container } = render(<GroupTab {...baseProps()} />)
    const indicators = container.querySelectorAll('[data-segment-dirty-indicator="error"]')
    expect(indicators.length).toBeGreaterThan(0)
    expect(container.querySelector('.bg-destructive')).toBeTruthy()
  })

  it('error 状态 → 指示符不应用 group-hover:opacity-0（永不让位）', () => {
    mockDirtyResult.current = { status: 'error', isCollaborating: false }
    const { container } = render(<GroupTab {...baseProps()} />)
    const indicator = container.querySelector('[data-segment-dirty-indicator="error"]') as HTMLElement
    expect(indicator.className).not.toContain('group-hover:opacity-0')
  })

  it('active segment 上的 dirty 指示符不应用 group-hover:opacity-0（永不让位）', () => {
    mockDirtyResult.current = { status: 'dirty', isCollaborating: false }
    const { container } = render(
      <GroupTab {...baseProps({ activeTabKey: 'tabweb:a' })} />,
    )
    const indicators = container.querySelectorAll('[data-segment-dirty-indicator="dirty"]')
    const firstIndicator = indicators[0] as HTMLElement
    expect(firstIndicator.className).not.toContain('group-hover:opacity-0')
  })

  it('非 active、非 error 的 dirty 指示符 hover 时让位', () => {
    mockDirtyResult.current = { status: 'dirty', isCollaborating: false }
    const { container } = render(
      <GroupTab {...baseProps({ activeTabKey: null })} />,
    )
    const indicators = container.querySelectorAll('[data-segment-dirty-indicator="dirty"]')
    const firstIndicator = indicators[0] as HTMLElement
    expect(firstIndicator.className).toContain('group-hover:opacity-0')
  })

  it('hook 返回 null 时不显示指示符', () => {
    mockDirtyResult.current = null
    const { container } = render(<GroupTab {...baseProps()} />)
    expect(container.querySelector('[data-segment-dirty-indicator]')).toBeNull()
  })
})

describe('GroupTab · 右键菜单 W5 新增项（closeOthers / closeLeft / closeRight）', () => {
  const slotBooleans = (position: 'left' | 'middle' | 'right' | 'only') => {
    switch (position) {
      case 'left': return { hasOtherSlots: true, hasLeftSlots: false, hasRightSlots: true }
      case 'right': return { hasOtherSlots: true, hasLeftSlots: true, hasRightSlots: false }
      case 'middle': return { hasOtherSlots: true, hasLeftSlots: true, hasRightSlots: true }
      case 'only': return { hasOtherSlots: false, hasLeftSlots: false, hasRightSlots: false }
    }
  }

  it('右键弹出 5 项菜单（splitGroup / closeGroup / closeOthers / closeLeft / closeRight）', () => {
    const props = baseProps({
      ...slotBooleans('middle'),
      onCloseOthersForGroup: vi.fn(),
      onCloseLeftForGroup: vi.fn(),
      onCloseRightForGroup: vi.fn(),
    })
    const { container } = render(<GroupTab {...props} />)
    fireEvent.contextMenu(container.querySelector('[data-group-tab]')!)

    const items = mockOpenNativeContextMenu.mock.calls[0][0] as NativeMenuItem[]
    const ids = items.filter(i => 'id' in i).map(i => i.id)
    expect(ids).toContain('split-group')
    expect(ids).toContain('close-group')
    expect(ids).toContain('close-others')
    expect(ids).toContain('close-left')
    expect(ids).toContain('close-right')
  })

  it('中间位置 group → closeOthers / closeLeft / closeRight 全 enabled', () => {
    const props = baseProps({
      ...slotBooleans('middle'),
      onCloseOthersForGroup: vi.fn(),
      onCloseLeftForGroup: vi.fn(),
      onCloseRightForGroup: vi.fn(),
    })
    const { container } = render(<GroupTab {...props} />)
    fireEvent.contextMenu(container.querySelector('[data-group-tab]')!)

    const items = mockOpenNativeContextMenu.mock.calls[0][0] as Array<{ id: string; enabled?: boolean }>
    expect(items.find(i => i.id === 'close-others')?.enabled).toBe(true)
    expect(items.find(i => i.id === 'close-left')?.enabled).toBe(true)
    expect(items.find(i => i.id === 'close-right')?.enabled).toBe(true)
  })

  it('最左 group → closeLeft disabled', () => {
    const props = baseProps({
      ...slotBooleans('left'),
      onCloseOthersForGroup: vi.fn(),
      onCloseLeftForGroup: vi.fn(),
      onCloseRightForGroup: vi.fn(),
    })
    const { container } = render(<GroupTab {...props} />)
    fireEvent.contextMenu(container.querySelector('[data-group-tab]')!)

    const items = mockOpenNativeContextMenu.mock.calls[0][0] as Array<{ id: string; enabled?: boolean }>
    expect(items.find(i => i.id === 'close-left')?.enabled).toBe(false)
    expect(items.find(i => i.id === 'close-right')?.enabled).toBe(true)
    expect(items.find(i => i.id === 'close-others')?.enabled).toBe(true)
  })

  it('最右 group → closeRight disabled', () => {
    const props = baseProps({
      ...slotBooleans('right'),
      onCloseOthersForGroup: vi.fn(),
      onCloseLeftForGroup: vi.fn(),
      onCloseRightForGroup: vi.fn(),
    })
    const { container } = render(<GroupTab {...props} />)
    fireEvent.contextMenu(container.querySelector('[data-group-tab]')!)

    const items = mockOpenNativeContextMenu.mock.calls[0][0] as Array<{ id: string; enabled?: boolean }>
    expect(items.find(i => i.id === 'close-right')?.enabled).toBe(false)
    expect(items.find(i => i.id === 'close-left')?.enabled).toBe(true)
    expect(items.find(i => i.id === 'close-others')?.enabled).toBe(true)
  })

  it('单 slot 时三项全 disabled', () => {
    const props = baseProps({
      ...slotBooleans('only'),
      onCloseOthersForGroup: vi.fn(),
      onCloseLeftForGroup: vi.fn(),
      onCloseRightForGroup: vi.fn(),
    })
    const { container } = render(<GroupTab {...props} />)
    fireEvent.contextMenu(container.querySelector('[data-group-tab]')!)

    const items = mockOpenNativeContextMenu.mock.calls[0][0] as Array<{ id: string; enabled?: boolean }>
    expect(items.find(i => i.id === 'close-others')?.enabled).toBe(false)
    expect(items.find(i => i.id === 'close-left')?.enabled).toBe(false)
    expect(items.find(i => i.id === 'close-right')?.enabled).toBe(false)
  })

  it('closeOthers onClick → 调用 onCloseOthersForGroup(group)', () => {
    const onCloseOthersForGroup = vi.fn()
    const props = baseProps({
      ...slotBooleans('middle'),
      onCloseOthersForGroup,
      onCloseLeftForGroup: vi.fn(),
      onCloseRightForGroup: vi.fn(),
    })
    const { container } = render(<GroupTab {...props} />)
    fireEvent.contextMenu(container.querySelector('[data-group-tab]')!)

    const items = mockOpenNativeContextMenu.mock.calls[0][0] as Array<{ id: string; onClick?: () => void }>
    items.find(i => i.id === 'close-others')?.onClick?.()
    expect(onCloseOthersForGroup).toHaveBeenCalledWith(props.group)
  })

  it('closeLeft onClick → 调用 onCloseLeftForGroup(group)', () => {
    const onCloseLeftForGroup = vi.fn()
    const props = baseProps({
      ...slotBooleans('middle'),
      onCloseOthersForGroup: vi.fn(),
      onCloseLeftForGroup,
      onCloseRightForGroup: vi.fn(),
    })
    const { container } = render(<GroupTab {...props} />)
    fireEvent.contextMenu(container.querySelector('[data-group-tab]')!)

    const items = mockOpenNativeContextMenu.mock.calls[0][0] as Array<{ id: string; onClick?: () => void }>
    items.find(i => i.id === 'close-left')?.onClick?.()
    expect(onCloseLeftForGroup).toHaveBeenCalledWith(props.group)
  })

  it('closeRight onClick → 调用 onCloseRightForGroup(group)', () => {
    const onCloseRightForGroup = vi.fn()
    const props = baseProps({
      ...slotBooleans('middle'),
      onCloseOthersForGroup: vi.fn(),
      onCloseLeftForGroup: vi.fn(),
      onCloseRightForGroup,
    })
    const { container } = render(<GroupTab {...props} />)
    fireEvent.contextMenu(container.querySelector('[data-group-tab]')!)

    const items = mockOpenNativeContextMenu.mock.calls[0][0] as Array<{ id: string; onClick?: () => void }>
    items.find(i => i.id === 'close-right')?.onClick?.()
    expect(onCloseRightForGroup).toHaveBeenCalledWith(props.group)
  })

  it('默认 boolean props 为 false 时三项全 disabled（向后兼容）', () => {
    const props = baseProps({
      onCloseOthersForGroup: vi.fn(),
      onCloseLeftForGroup: vi.fn(),
      onCloseRightForGroup: vi.fn(),
    })
    const { container } = render(<GroupTab {...props} />)
    fireEvent.contextMenu(container.querySelector('[data-group-tab]')!)

    const items = mockOpenNativeContextMenu.mock.calls[0][0] as Array<{ id: string; enabled?: boolean }>
    expect(items.find(i => i.id === 'close-others')?.enabled).toBe(false)
    expect(items.find(i => i.id === 'close-left')?.enabled).toBe(false)
    expect(items.find(i => i.id === 'close-right')?.enabled).toBe(false)
  })
})

describe('GroupTab · 右上角还原按钮（替代旧的 X 关闭按钮）', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('还原按钮 aria-label / title 都是 tab.restoreGroup', () => {
    const { container } = render(<GroupTab {...baseProps()} />)
    const restoreBtn = container.querySelector('[data-restore-group-btn]')!
    expect(restoreBtn.getAttribute('aria-label')).toBe('tab.restoreGroup')
    expect(restoreBtn.getAttribute('title')).toBe('tab.restoreGroup')
  })

  it('点击还原按钮 → onRestoreGroup(group) 被调用，不触发 onCloseItem', () => {
    const onRestoreGroup = vi.fn()
    const onCloseItem = vi.fn()
    const props = baseProps({ onRestoreGroup, onCloseItem })
    const { container } = render(<GroupTab {...props} />)
    fireEvent.click(container.querySelector('[data-restore-group-btn]')!)
    expect(onRestoreGroup).toHaveBeenCalledWith(props.group)
    expect(onCloseItem).not.toHaveBeenCalled()
  })

  it('还原按钮 stopPropagation（不触发 GroupTab 整体 onClick 切换 active）', () => {
    const onActivateTabKey = vi.fn()
    const onRestoreGroup = vi.fn()
    const { container } = render(
      <GroupTab {...baseProps({ onActivateTabKey, onRestoreGroup })} />,
    )
    fireEvent.click(container.querySelector('[data-restore-group-btn]')!)
    expect(onActivateTabKey).not.toHaveBeenCalled()
  })

  it('非 active group 时还原按钮 opacity-0，hover 才显示', () => {
    const { container } = render(
      <GroupTab {...baseProps({ isGroupActive: false })} />,
    )
    const btn = container.querySelector('[data-restore-group-btn]') as HTMLElement
    expect(btn.className).toContain('opacity-0')
    expect(btn.className).toContain('group-hover:opacity-100')
  })

  it('active group 时还原按钮常驻可见（opacity-70）', () => {
    const { container } = render(
      <GroupTab {...baseProps({ isGroupActive: true })} />,
    )
    const btn = container.querySelector('[data-restore-group-btn]') as HTMLElement
    expect(btn.className).toContain('opacity-70')
    expect(btn.className).not.toContain('opacity-0')
  })

  it('还原按钮位于 absolute right-1，浅灰底遮挡文字', () => {
    const { container } = render(<GroupTab {...baseProps()} />)
    const btn = container.querySelector('[data-restore-group-btn]') as HTMLElement
    expect(btn.className).toContain('absolute')
    expect(btn.className).toContain('right-1')
    expect(btn.className).toContain('bg-foreground/[0.04]')
  })

  it('右键菜单 close-group 仍可错峰关闭整组（高级路径，不再受 X 按钮影响）', () => {
    vi.useFakeTimers()
    const onCloseItem = vi.fn()
    const props = baseProps({ onCloseItem })
    const { container } = render(<GroupTab {...props} />)
    fireEvent.contextMenu(container.querySelector('[data-group-tab]')!)
    const items = mockOpenNativeContextMenu.mock.calls.at(-1)![0] as Array<{ id: string; onClick?: () => void }>
    items.find(i => i.id === 'close-group')?.onClick?.()
    expect(onCloseItem).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(80)
    expect(onCloseItem).toHaveBeenCalledTimes(2)
  })
})
