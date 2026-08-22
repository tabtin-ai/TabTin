/**
 * ContextTabs orchestrator 集成回归测试
 *
 * 验证拆分后整体 wiring 正确：
 *   1. shim re-export：`from '@components/context-space/ContextTabs'` 仍能拿到组件
 *   2. items 渲染数量正确（普通 tab + group 代表 + home）
 *   3. 关闭按钮点击 → onCloseItem 被触发（业务流程）
 *   4. 关闭按钮点击 → tab 立即获得 closing 视觉态（动画启动）
 *   5. items 减少（业务通过）→ 旧 tab 仍在 DOM 中作为 phantom（保持 ~120ms 后 unmount）
 *   6. data-tab-item 属性存在（overflow detection 不破）
 *
 * 不做 e2e（jsdom 没有真实 ScrollArea / Popover 行为），只验证结构契约。
 */
import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest'
import { act, fireEvent, render } from '@testing-library/react'
import type { ContextItem, ContextRegistry } from '@components/context-space/registry'
import type { CanvasLayoutGroup } from '@stores/useCanvasLayoutStore'
import {
  DRAG_TYPE_PANE_DRAG,
  DRAG_TYPE_TAB_META,
  DRAG_TYPE_TAB_REORDER,
} from '@/utils/split-coordinator'

const { scrollAreaRemountProbe } = vi.hoisted(() => ({
  scrollAreaRemountProbe: { enabled: false, renderCount: 0 },
}))

// jsdom 不提供 ResizeObserver — useOverflowDetection 会用它监听 viewport 尺寸变化
beforeAll(() => {
  if (typeof globalThis.ResizeObserver === 'undefined') {
    class FakeResizeObserver {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    ;(globalThis as unknown as { ResizeObserver: typeof FakeResizeObserver }).ResizeObserver =
      FakeResizeObserver
  }
})

// 桥接 mock smartsheet-ui Popover，使 ScrollArea / Popover 在 jsdom 中能展开 children
vi.mock('@tabtin/smartsheet-ui', async () => {
  const React = await import('react')
  const actual = await vi.importActual<typeof import('@tabtin/smartsheet-ui')>(
    '@tabtin/smartsheet-ui',
  )
  return {
    ...actual,
    Popover: ({ children }: { children: React.ReactNode }) => React.createElement('div', null, children),
    PopoverTrigger: ({ children }: { children: React.ReactNode; asChild?: boolean }) => children as React.ReactElement,
    PopoverContent: ({ children }: { children: React.ReactNode }) => React.createElement('div', null, children),
    ScrollArea: ({ children, viewportRef }: { children: React.ReactNode; viewportRef?: React.Ref<HTMLDivElement> }) => {
      // 简化 ScrollArea：内部 div 用 viewportRef，让 useOverflowDetection 能拿到 viewport
      const content = scrollAreaRemountProbe.enabled
        ? React.createElement(
            React.Fragment,
            { key: `scroll-remount-${scrollAreaRemountProbe.renderCount += 1}` },
            children,
          )
        : children
      return React.createElement(
        'div',
        { className: 'mock-scroll-area', ref: viewportRef },
        content,
      )
    },
  }
})

vi.mock('@/utils/nativeMenu', () => ({
  openNativeContextMenu: vi.fn(() => () => {}),
  menuSeparator: () => ({ id: 'sep', type: 'separator' as const }),
}))

vi.mock('@stores/useClosedTabsStore', () => ({
  useClosedTabsStore: { getState: () => ({ stack: [] }) },
}))

vi.mock('@stores/useCanvasLayoutStore', () => ({
  useCanvasLayoutStore: Object.assign(
    (sel: (s: Record<string, unknown>) => unknown) => sel({ setActivePane: vi.fn(), removeGroup: vi.fn() }),
    { getState: () => ({ setActivePane: vi.fn(), removeGroup: vi.fn() }) },
  ),
}))

vi.mock('@hooks/useIsDarkMode', () => ({
  useIsDarkMode: () => false,
}))

import { ContextTabs } from '@components/context-space/ContextTabs'

const makeRegistry = (): ContextRegistry => ({
  getTabLabel: (item: ContextItem) => item.title ?? item.tabKey,
  getTabIcon: () => null,
  getDragPayload: () => ({} as Record<string, unknown>),
  buildContextAttachment: () => null,
  getCanvasColor: () => null,
  isClosable: () => true,
  parseTabKey: (key: string) => {
    const idx = key.indexOf(':')
    if (idx <= 0) return null
    return { type: key.slice(0, idx), id: key.slice(idx + 1) }
  },
  getHandler: () => null,
  buildTabKey: (type: string, id: string) => `${type}:${id}`,
}) as unknown as ContextRegistry

const makeItem = (tabKey: string, title?: string): ContextItem => {
  const idx = tabKey.indexOf(':')
  return {
    type: tabKey.slice(0, idx) as ContextItem['type'],
    id: tabKey.slice(idx + 1),
    tabKey: tabKey as ContextItem['tabKey'],
    title,
  }
}

const makeGroup = (tabKeys: string[]): CanvasLayoutGroup => ({
  id: 'group-1',
  spaceId: 'space-1',
  anchorTabKey: tabKeys[0] as ContextItem['tabKey'],
  activePaneId: 'pane-0',
  panes: tabKeys.map((tabKey, index) => ({
    id: `pane-${index}`,
    content: { tabKey: tabKey as ContextItem['tabKey'] },
  })),
  layout: {
    type: 'split',
    id: 'split-1',
    direction: 'horizontal',
    children: tabKeys.map((_, index) => ({ type: 'leaf' as const, paneId: `pane-${index}` })),
    sizes: tabKeys.map(() => 1 / tabKeys.length),
  },
  createdAt: 1,
  updatedAt: 1,
})

const makeDataTransfer = () => {
  const values = new Map<string, string>()
  const types: string[] = []
  return {
    effectAllowed: 'all',
    dropEffect: 'none',
    files: [],
    items: [],
    types,
    setData: (type: string, value: string) => {
      values.set(type, value)
      if (!types.includes(type)) types.push(type)
    },
    getData: (type: string) => values.get(type) ?? '',
    setDragImage: vi.fn(),
    clearData: (type?: string) => {
      if (type) {
        values.delete(type)
        const index = types.indexOf(type)
        if (index >= 0) types.splice(index, 1)
      } else {
        values.clear()
        types.splice(0)
      }
    },
  } as unknown as DataTransfer
}

const baseProps = (overrides: Partial<React.ComponentProps<typeof ContextTabs>> = {}) => ({
  activeTabKey: null as string | null,
  isHomeActive: false,
  showHome: false,
  items: [makeItem('tabweb:a', 'A'), makeItem('tabweb:b', 'B')],
  registry: makeRegistry(),
  onSelectHome: vi.fn(),
  onSelectItem: vi.fn(),
  onCloseItem: vi.fn(),
  onRefreshItem: vi.fn(),
  onCloseOtherItems: vi.fn(),
  onCloseLeftItems: vi.fn(),
  onCloseRightItems: vi.fn(),
  onCreateWebTab: vi.fn(),
  onReopenClosedTab: vi.fn(),
  onReorderItem: vi.fn(),
  onRestoreGroup: vi.fn(),
  ...overrides,
})

const setRect = (element: Element, left: number, width: number, height = 30) => {
  ;(element as HTMLElement).getBoundingClientRect = () => ({
    left,
    right: left + width,
    top: 0,
    bottom: height,
    width,
    height,
    x: left,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect)
}

const setHorizontalTabMetrics = (
  container: HTMLElement,
  metrics: Array<{ element: Element; left: number; width: number }>,
  contentWidth = 500,
) => {
  const scrollContent = container.querySelector(
    '[data-context-tabs-scroll-content]',
  ) as HTMLElement
  setRect(scrollContent, 0, contentWidth, 48)
  metrics.forEach(metric => setRect(metric.element, metric.left, metric.width))
  return scrollContent
}

const fireDragPointerEvent = (
  element: Element,
  type: 'dragover' | 'drop',
  dataTransfer: DataTransfer,
  clientX: number,
) => {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX,
  })
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
  fireEvent(element, event)
}

beforeEach(() => {
  vi.clearAllMocks()
  scrollAreaRemountProbe.enabled = false
  scrollAreaRemountProbe.renderCount = 0
})

describe('ContextTabs orchestrator · 结构契约', () => {
  it('shim 路径 import 仍能拿到组件（向后兼容）', () => {
    expect(ContextTabs).toBeDefined()
  })

  it('渲染所有 items（每个一个 data-tab-item）', () => {
    const { container } = render(<ContextTabs {...baseProps()} />)
    const tabs = container.querySelectorAll('[data-tab-item]')
    expect(tabs.length).toBe(2)
    expect(Array.from(tabs).map(t => t.getAttribute('data-tab-key'))).toEqual([
      'tabweb:a',
      'tabweb:b',
    ])
  })

  it('home 固定在最前方并独立于普通标签滚动区，避免被大量标签挤走', () => {
    const { container } = render(<ContextTabs {...baseProps({ showHome: true, isHomeActive: true })} />)
    // home 是 role="tab" + aria-selected="true"，但没有 data-tab-item
    const homeTab = Array.from(container.querySelectorAll('[role="tab"]')).find(
      el => el.getAttribute('aria-selected') === 'true' && !el.hasAttribute('data-tab-item'),
    )
    expect(homeTab).toBeTruthy()
    expect(homeTab?.closest('.mock-scroll-area')).toBeNull()
    expect(container.querySelector('[data-tab-key="tabweb:a"]')?.closest('.mock-scroll-area')).toBeTruthy()
    expect(container.querySelector('.mock-scroll-area [data-context-tabs-scroll-content]')).toBeTruthy()
    expect(container.querySelector('[role="tablist"]')?.contains(homeTab ?? null)).toBe(true)
  })

  it('homeClosable 时展示关闭按钮并回调 onCloseHome', () => {
    const onCloseHome = vi.fn()
    const { container } = render(
      <ContextTabs
        {...baseProps({
          showHome: true,
          homeClosable: true,
          isHomeActive: true,
          items: [],
          onCloseHome,
        })}
      />,
    )
    const homeTab = Array.from(container.querySelectorAll('[role="tab"]')).find(
      el => el.getAttribute('aria-selected') === 'true' && !el.hasAttribute('data-tab-item'),
    )
    const closeBtn = homeTab?.querySelector('button[aria-label="tab.menu.close"]') as HTMLElement
    expect(closeBtn).toBeTruthy()
    fireEvent.click(closeBtn)
    expect(onCloseHome).toHaveBeenCalledTimes(1)
  })

  it('trailingSlot 固定在标签滚动区外，不会被大量标签推到最右侧', () => {
    const { container } = render(
      <ContextTabs
        {...baseProps()}
        trailingSlot={<button type="button" aria-label="collapse apps">collapse</button>}
      />,
    )

    const trailingButton = container.querySelector('[aria-label="collapse apps"]')
    expect(trailingButton).toBeTruthy()
    expect(trailingButton?.closest('[role="tablist"]')).toBeNull()
    expect(trailingButton?.closest('.mock-scroll-area')).toBeNull()
  })

  it('无 drag payload 的系统标签不可重排，真实标签仍可重排', () => {
    const desktop = makeItem('desktop_home:current', '桌面')
    const web = makeItem('tabweb:a', 'A')
    const registry = {
      ...makeRegistry(),
      getDragPayload: (item: ContextItem) =>
        item.tabKey === desktop.tabKey ? null : ({ type: item.type, id: item.id }),
    } as unknown as ContextRegistry

    const { container } = render(
      <ContextTabs
        {...baseProps({
          items: [desktop, web],
          registry,
        })}
      />,
    )

    expect((container.querySelector('[data-tab-key="desktop_home:current"]') as HTMLElement).draggable).toBe(false)
    expect((container.querySelector('[data-tab-key="tabweb:a"]') as HTMLElement).draggable).toBe(true)
  })
})

describe('ContextTabs orchestrator · group lookup', () => {
  it('拖入内容区成组后立即清除灰色拖拽占位态', () => {
    const groupedItems = [
      makeItem('tabdoc:doc-1', 'Doc'),
      makeItem('tabdata:table-1', 'Table'),
    ]
    const group = makeGroup(groupedItems.map(item => item.tabKey))
    const { container, rerender } = render(
      <ContextTabs
        {...baseProps({
          items: groupedItems,
          allItems: groupedItems,
          canvasGroups: [],
        })}
      />,
    )
    const sourceRoot = container.querySelector(
      '[data-tab-key="tabdoc:doc-1"]',
    ) as HTMLElement
    const siblingRoot = container.querySelector(
      '[data-tab-key="tabdata:table-1"]',
    ) as HTMLElement
    setHorizontalTabMetrics(container, [
      { element: sourceRoot, left: 0, width: 100 },
      { element: siblingRoot, left: 104, width: 100 },
    ])
    const dataTransfer = makeDataTransfer()

    fireEvent.dragStart(sourceRoot, { dataTransfer })
    expect(sourceRoot.dataset.tabPlaceholder).toBe('true')

    // Canvas 接收 drop 后会立即用 GroupTab 替换源 NormalTab，源节点上的
    // dragend 此时可能丢失；全局 drop 必须先结束标签拖拽视觉会话。
    fireDragPointerEvent(container, 'drop', dataTransfer, 120)
    rerender(
      <ContextTabs
        {...baseProps({
          items: [],
          allItems: groupedItems,
          groupedTabKeys: new Set(groupedItems.map(item => item.tabKey)),
          canvasGroups: [group],
        })}
      />,
    )

    const groupRoot = container.querySelector('[data-group-tab]') as HTMLElement
    expect(groupRoot).toBeTruthy()
    expect(groupRoot.dataset.tabDragging).toBeUndefined()
    expect(groupRoot.dataset.tabPlaceholder).toBeUndefined()
    expect(groupRoot.querySelector('[data-tab-drag-content]')?.className).not.toContain(
      'invisible',
    )
  })

  it('GroupTab 可从 allItems 激活 grouped pane', () => {
    const onSelectItem = vi.fn()
    const groupedItem = makeItem('tabdoc:doc-1', 'Doc')
    const siblingItem = makeItem('tabdata:table-1', 'Table')
    const group = makeGroup(['tabdoc:doc-1', 'tabdata:table-1'])

    const { container } = render(
      <ContextTabs
        {...baseProps({
          items: [groupedItem],
          allItems: [groupedItem, siblingItem],
          groupedTabKeys: new Set(['tabdoc:doc-1', 'tabdata:table-1']),
          canvasGroups: [group],
          onSelectItem,
        })}
      />,
    )

    const segment = Array.from(container.querySelectorAll('[data-group-tab] [role="tab"]'))
      .find(el => (el.textContent || '').includes('Doc')) as HTMLElement
    expect(segment).toBeTruthy()

    fireEvent.click(segment)

    expect(onSelectItem).toHaveBeenCalledWith(expect.objectContaining({ tabKey: 'tabdoc:doc-1' }))
  })

  it('GroupTab 对不在 allItems 中的 hidden pane 降级为普通 tab', () => {
    const onSelectItem = vi.fn()
    const visibleItem = makeItem('apphome:cloud-resources', '云盘')
    const hiddenKey = 'subagent_session:hidden-run'
    const group = makeGroup(['apphome:cloud-resources', hiddenKey])

    const { container } = render(
      <ContextTabs
        {...baseProps({
          items: [visibleItem],
          allItems: [visibleItem],
          groupedTabKeys: new Set(['apphome:cloud-resources', hiddenKey]),
          canvasGroups: [group],
          onSelectItem,
        })}
      />,
    )

    expect(container.querySelector('[data-group-tab]')).toBeNull()
    fireEvent.click(container.querySelector('[data-tab-key="apphome:cloud-resources"]') as HTMLElement)

    expect(onSelectItem).toHaveBeenCalledWith(expect.objectContaining({ tabKey: 'apphome:cloud-resources' }))
  })

  it('成组后仍可作为一个整体标签拖动排序', () => {
    const onReorderItem = vi.fn()
    const groupedItems = [
      makeItem('tabdoc:doc-1', 'Doc'),
      makeItem('tabdata:table-1', 'Table'),
    ]
    const targetItem = makeItem('tabweb:target', 'Target')
    const group = makeGroup(groupedItems.map(item => item.tabKey))
    const { container, rerender } = render(
      <ContextTabs
        {...baseProps({
          // 生产态 visibleItems 会排除 grouped tabKey；allItems 才保留完整 tabOrder。
          items: [targetItem],
          allItems: [...groupedItems, targetItem],
          groupedTabKeys: new Set(groupedItems.map(item => item.tabKey)),
          canvasGroups: [group],
          onReorderItem,
        })}
      />,
    )
    const groupRoot = container.querySelector('[data-group-tab]') as HTMLElement
    const targetRoot = container.querySelector('[data-tab-key="tabweb:target"]') as HTMLElement
    const dataTransfer = makeDataTransfer()
    expect(Array.from(
      container.querySelector('[data-context-tabs-scroll-content]')?.children ?? [],
    ).map(element => element.getAttribute('data-tab-reorder-key'))).toEqual([
      'tabdoc:doc-1',
      'tabweb:target',
    ])
    setHorizontalTabMetrics(container, [
      { element: groupRoot, left: 0, width: 180 },
      { element: targetRoot, left: 184, width: 100 },
    ])

    expect(groupRoot.draggable).toBe(true)
    fireEvent.dragStart(groupRoot, { dataTransfer })
    expect(dataTransfer.getData(DRAG_TYPE_TAB_REORDER)).toBe('tabdoc:doc-1')
    expect(dataTransfer.getData(DRAG_TYPE_TAB_META)).toBe('')
    fireDragPointerEvent(targetRoot, 'dragover', dataTransfer, 280)
    fireDragPointerEvent(targetRoot, 'drop', dataTransfer, 280)

    expect(onReorderItem).toHaveBeenCalledWith(
      expect.objectContaining({ tabKey: 'tabdoc:doc-1' }),
      expect.objectContaining({ tabKey: 'tabweb:target' }),
      'after',
    )

    // 模拟 setTabOrder 写回后父级按新顺序重渲染：组必须真正移动到 Target 后，
    // 不能因为 items 不含组成员而再次被无条件追加到旧的末尾位置。
    rerender(
      <ContextTabs
        {...baseProps({
          items: [targetItem],
          allItems: [targetItem, ...groupedItems],
          groupedTabKeys: new Set(groupedItems.map(item => item.tabKey)),
          canvasGroups: [group],
          onReorderItem,
        })}
      />,
    )
    expect(Array.from(
      container.querySelector('[data-context-tabs-scroll-content]')?.children ?? [],
    ).map(element => element.getAttribute('data-tab-reorder-key'))).toEqual([
      'tabweb:target',
      'tabdoc:doc-1',
    ])
  })

  it('普通标签可拖到成组标签后的空白区域', () => {
    const onReorderItem = vi.fn()
    const sourceItem = makeItem('tabweb:source', 'Source')
    const groupedItems = [
      makeItem('tabdoc:doc-1', 'Doc'),
      makeItem('tabdata:table-1', 'Table'),
    ]
    const group = makeGroup(groupedItems.map(item => item.tabKey))
    const { container } = render(
      <ContextTabs
        {...baseProps({
          // 与 SpaceContextArea 一致：标签栏 items 不含组成员，allItems 保留排序锚点。
          items: [sourceItem],
          allItems: [sourceItem, ...groupedItems],
          groupedTabKeys: new Set(groupedItems.map(item => item.tabKey)),
          canvasGroups: [group],
          onReorderItem,
        })}
      />,
    )
    const sourceRoot = container.querySelector('[data-tab-key="tabweb:source"]') as HTMLElement
    const groupRoot = container.querySelector('[data-group-tab]') as HTMLElement
    const scrollContent = setHorizontalTabMetrics(container, [
      { element: sourceRoot, left: 0, width: 100 },
      { element: groupRoot, left: 104, width: 180 },
    ])
    const dataTransfer = makeDataTransfer()
    expect(Array.from(scrollContent.children).map(
      element => element.getAttribute('data-tab-reorder-key'),
    )).toEqual([
      'tabweb:source',
      'tabdoc:doc-1',
    ])

    fireEvent.dragStart(sourceRoot, { dataTransfer })
    fireDragPointerEvent(scrollContent, 'dragover', dataTransfer, 450)
    fireDragPointerEvent(scrollContent, 'drop', dataTransfer, 450)

    expect(onReorderItem).toHaveBeenCalledWith(
      expect.objectContaining({ tabKey: 'tabweb:source' }),
      expect.objectContaining({ tabKey: 'tabdoc:doc-1' }),
      'after',
    )
  })
})

describe('ContextTabs orchestrator · Codex 风格排序动画', () => {
  it('源内容只保留在幽灵态，空占位移动且跨过的标签平滑让位', () => {
    const items = [
      makeItem('tabweb:a', 'A'),
      makeItem('tabweb:b', 'B'),
      makeItem('tabweb:c', 'C'),
    ]
    const { container } = render(<ContextTabs {...baseProps({ items })} />)
    const source = container.querySelector('[data-tab-key="tabweb:a"]') as HTMLElement
    const middle = container.querySelector('[data-tab-key="tabweb:b"]') as HTMLElement
    const target = container.querySelector('[data-tab-key="tabweb:c"]') as HTMLElement
    const scrollContent = setHorizontalTabMetrics(container, [
      { element: source, left: 0, width: 100 },
      { element: middle, left: 104, width: 100 },
      { element: target, left: 208, width: 100 },
    ])
    const dataTransfer = makeDataTransfer()

    fireEvent.dragStart(source, { dataTransfer })
    fireDragPointerEvent(scrollContent, 'dragover', dataTransfer, 300)

    expect(source.dataset.tabDragging).toBe('true')
    expect(source.dataset.tabPlaceholder).toBe('true')
    expect(source.querySelector('[data-tab-drag-content]')?.className).toContain('invisible')
    expect(source.style.transform).toBe('translateX(208px)')
    expect(middle.style.transform).toBe('translateX(-104px)')
    expect(target.style.transform).toBe('translateX(-104px)')
    expect(dataTransfer.setDragImage).toHaveBeenCalledTimes(1)
    const ghost = vi.mocked(dataTransfer.setDragImage).mock.calls[0][0] as HTMLElement
    expect(ghost.dataset.tabDragGhost).toBe('true')
    expect(ghost.style.boxShadow).toContain('12px 30px')
  })

  it('指针在相邻标签中点附近停留时使用滞回区，不会反复抽搐', () => {
    const items = [
      makeItem('tabweb:a', 'A'),
      makeItem('tabweb:b', 'B'),
      makeItem('tabweb:c', 'C'),
    ]
    const { container } = render(<ContextTabs {...baseProps({ items })} />)
    const source = container.querySelector('[data-tab-key="tabweb:a"]') as HTMLElement
    const middle = container.querySelector('[data-tab-key="tabweb:b"]') as HTMLElement
    const target = container.querySelector('[data-tab-key="tabweb:c"]') as HTMLElement
    const scrollContent = setHorizontalTabMetrics(container, [
      { element: source, left: 0, width: 100 },
      { element: middle, left: 104, width: 100 },
      { element: target, left: 208, width: 100 },
    ])
    const dataTransfer = makeDataTransfer()

    fireEvent.dragStart(source, { dataTransfer })
    fireDragPointerEvent(scrollContent, 'dragover', dataTransfer, 159)
    expect(source.style.transform).toBe('translateX(104px)')
    expect(middle.style.transform).toBe('translateX(-104px)')

    // B 的冻结中点是 154；回到中点仍保持当前占位，越过 150 才返回。
    fireDragPointerEvent(scrollContent, 'dragover', dataTransfer, 154)
    expect(source.style.transform).toBe('translateX(104px)')
    fireDragPointerEvent(scrollContent, 'dragover', dataTransfer, 149)
    expect(source.style.transform).toBe('')
    expect(middle.style.transform).toBe('')
  })

  it('最后一个标签后的空白区域可直接接收 drop 并追加到末尾', () => {
    const onReorderItem = vi.fn()
    const items = [
      makeItem('tabweb:a', 'A'),
      makeItem('tabweb:b', 'B'),
      makeItem('tabweb:c', 'C'),
    ]
    const { container } = render(
      <ContextTabs {...baseProps({ items, onReorderItem })} />,
    )
    const source = container.querySelector('[data-tab-key="tabweb:a"]') as HTMLElement
    const middle = container.querySelector('[data-tab-key="tabweb:b"]') as HTMLElement
    const target = container.querySelector('[data-tab-key="tabweb:c"]') as HTMLElement
    const scrollContent = setHorizontalTabMetrics(container, [
      { element: source, left: 0, width: 100 },
      { element: middle, left: 104, width: 100 },
      { element: target, left: 208, width: 100 },
    ])
    const dataTransfer = makeDataTransfer()

    fireEvent.dragStart(source, { dataTransfer })
    fireDragPointerEvent(scrollContent, 'dragover', dataTransfer, 450)
    fireDragPointerEvent(scrollContent, 'drop', dataTransfer, 450)

    expect(onReorderItem).toHaveBeenCalledWith(
      expect.objectContaining({ tabKey: 'tabweb:a' }),
      expect.objectContaining({ tabKey: 'tabweb:c' }),
      'after',
    )
  })

  it('ScrollArea 在排序预览更新后重建内容节点，当前容器仍可完成 drop', () => {
    scrollAreaRemountProbe.enabled = true
    const onReorderItem = vi.fn()
    const items = [
      makeItem('tabweb:a', 'A'),
      makeItem('tabweb:b', 'B'),
      makeItem('tabweb:c', 'C'),
    ]
    const { container } = render(
      <ContextTabs {...baseProps({ items, onReorderItem })} />,
    )
    const source = container.querySelector('[data-tab-key="tabweb:a"]') as HTMLElement
    const middle = container.querySelector('[data-tab-key="tabweb:b"]') as HTMLElement
    const target = container.querySelector('[data-tab-key="tabweb:c"]') as HTMLElement
    const initialScrollContent = setHorizontalTabMetrics(container, [
      { element: source, left: 0, width: 100 },
      { element: middle, left: 104, width: 100 },
      { element: target, left: 208, width: 100 },
    ])
    const dataTransfer = makeDataTransfer()

    fireEvent.dragStart(source, { dataTransfer })
    fireDragPointerEvent(initialScrollContent, 'dragover', dataTransfer, 159)
    const currentScrollContent = container.querySelector(
      '[data-context-tabs-scroll-content]',
    ) as HTMLElement
    expect(currentScrollContent).not.toBe(initialScrollContent)

    fireDragPointerEvent(currentScrollContent, 'drop', dataTransfer, 450)
    expect(onReorderItem).toHaveBeenCalledWith(
      expect.objectContaining({ tabKey: 'tabweb:a' }),
      expect.objectContaining({ tabKey: 'tabweb:c' }),
      'after',
    )
  })

  it('标签排序与分区还原拖拽都不高亮整条标签栏', () => {
    const { container } = render(<ContextTabs {...baseProps()} />)
    const tablist = container.querySelector('[role="tablist"]') as HTMLElement
    const source = container.querySelector('[data-tab-key="tabweb:a"]') as HTMLElement
    const target = container.querySelector('[data-tab-key="tabweb:b"]') as HTMLElement
    const scrollContent = setHorizontalTabMetrics(container, [
      { element: source, left: 0, width: 100 },
      { element: target, left: 104, width: 100 },
    ])
    const initialClassName = tablist.className
    const tabTransfer = makeDataTransfer()

    fireEvent.dragStart(source, { dataTransfer: tabTransfer })
    fireDragPointerEvent(scrollContent, 'dragover', tabTransfer, 180)
    expect(tablist.className).toBe(initialClassName)
    expect(tablist.className).not.toContain('ring-accent')
    expect(tablist.className).not.toContain('bg-accent')

    const paneTransfer = makeDataTransfer()
    paneTransfer.setData(
      DRAG_TYPE_PANE_DRAG,
      JSON.stringify({ paneId: 'pane-0', groupId: 'missing-group' }),
    )
    fireEvent.dragOver(tablist, { dataTransfer: paneTransfer })
    expect(tablist.className).toBe(initialClassName)
    expect(tablist.textContent).not.toContain('tab.restoreHint')
  })
})

describe('ContextTabs orchestrator · 关闭动画 wiring', () => {
  it('点击关闭按钮 → onCloseItem 被调用 + tab 立即得到 closing 视觉态', () => {
    const onCloseItem = vi.fn()
    const props = baseProps({ onCloseItem })
    const { container } = render(<ContextTabs {...props} />)

    const tabA = container.querySelector('[data-tab-key="tabweb:a"]') as HTMLElement
    const closeBtn = tabA.querySelector('button[aria-label="tab.menu.close"]') as HTMLElement
    expect(closeBtn).toBeTruthy()

    act(() => {
      fireEvent.click(closeBtn)
    })

    // 业务流程被同步触发
    expect(onCloseItem).toHaveBeenCalledWith(expect.objectContaining({ tabKey: 'tabweb:a' }))

    // 视觉立即标 closing
    const tabAAfterClick = container.querySelector('[data-tab-key="tabweb:a"]') as HTMLElement
    expect(tabAAfterClick.getAttribute('data-tab-closing')).toBe('true')
  })

  it('items 减少（业务通过）→ 旧 tab 仍作为 phantom 渲染（保留动画时间）', () => {
    const props = baseProps()
    const { container, rerender } = render(<ContextTabs {...props} />)

    // 模拟用户点击 X 后 items 立刻被父级减少（业务流程通过、无 beforeClose）
    const tabAEl = container.querySelector('[data-tab-key="tabweb:a"]') as HTMLElement
    const closeBtn = tabAEl.querySelector('button[aria-label="tab.menu.close"]') as HTMLElement

    act(() => {
      fireEvent.click(closeBtn)
    })
    // items 减少 —— 包在 act 里让 useEffect 同步执行
    act(() => {
      rerender(<ContextTabs {...baseProps({ items: [makeItem('tabweb:b', 'B')] })} />)
    })

    // tabweb:a 应该仍在 DOM 中作为 phantom，且 data-tab-closing=true
    const tabAPhantom = container.querySelector('[data-tab-key="tabweb:a"]') as HTMLElement
    expect(tabAPhantom).toBeTruthy()
    expect(tabAPhantom.getAttribute('data-tab-closing')).toBe('true')
  })

  it('phantom 在 ~120ms 后真正 unmount', async () => {
    const { container, rerender } = render(<ContextTabs {...baseProps()} />)

    act(() => {
      rerender(<ContextTabs {...baseProps({ items: [makeItem('tabweb:b', 'B')] })} />)
    })

    // 立刻：phantom 仍在
    expect(container.querySelector('[data-tab-key="tabweb:a"]')).toBeTruthy()

    // 等真实 setTimeout fire（durationMs=120）
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 200))
    })

    // unmount 完成
    expect(container.querySelector('[data-tab-key="tabweb:a"]')).toBeNull()
  })

  it('beforeClose 阻止（items 不变）→ tab 在 cancelTimeoutMs 后回弹（去掉 closing）', async () => {
    const props = baseProps()
    const { container } = render(<ContextTabs {...props} />)
    const closeBtn = container.querySelector(
      '[data-tab-key="tabweb:a"] button[aria-label="tab.menu.close"]',
    ) as HTMLElement

    act(() => {
      fireEvent.click(closeBtn)
    })
    // closing 立即应用
    expect(
      container.querySelector('[data-tab-key="tabweb:a"]')?.getAttribute('data-tab-closing'),
    ).toBe('true')

    // beforeClose 阻止 → items 没变 + cancelTimeoutMs 后回弹（默认 cancelTimeoutMs = durationMs * 3 = 360ms）
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 500))
    })
    expect(
      container.querySelector('[data-tab-key="tabweb:a"]')?.getAttribute('data-tab-closing'),
    ).toBeNull()
  })
})
