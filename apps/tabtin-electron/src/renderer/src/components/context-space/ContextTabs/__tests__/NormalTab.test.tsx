/**
 * NormalTab 结构与行为回归测试
 *
 * 验证：
 *   1. data-tab-item / data-tab-key 属性存在（useOverflowDetection 依赖）
 *   2. role="tab" + aria-selected 正确
 *   3. 关闭按钮 → 触发 onRequestClose（不是 onCloseItem 直接，由父级 useCloseAnimation 包装）
 *   4. 中键 → 触发 onMiddleClickClose
 *   5. isClosing=true → 应用 closing className（max-w-0 / opacity-0 / pointer-events-none）
 *   6. tabdoc + dirty registry → 出现 dirty indicator（圆点）
 *   7. 非 tabdoc → 没有 dirty indicator（即使 register 了同名）
 *   8. 右键 → 调用 onContextMenu prop
 *   9. tabdoc / tabdata 在有 scope 时提供聚焦入口；任务 / IM 统一到 taskViewMode
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import type { ContextItem, ContextRegistry } from '@components/context-space/registry'
import {
  registerTabDocDirtySource,
  _resetTabDocDirtyRegistry,
} from '../../tabdoc/tabdocDirtyRegistry'
import { NormalTab } from '../NormalTab'

const {
  mockContextState,
  mockSetFocusedCanvas,
  mockFocusedCanvas,
  mockTaskViewMode,
  mockSetTaskViewModeForScope,
  mockCaptureTaskViewModeMorph,
} = vi.hoisted(() => ({
  mockContextState: { current: null as null | { tabScopeKey: string } },
  mockSetFocusedCanvas: vi.fn(),
  mockFocusedCanvas: {
    current: null as null | { scopeKey: string; tabKey: string },
  },
  mockTaskViewMode: {
    current: 'split' as 'chat-focus' | 'split' | 'app-focus',
  },
  mockSetTaskViewModeForScope: vi.fn(),
  mockCaptureTaskViewModeMorph: vi.fn(),
}))

vi.mock('@components/context-space/SpaceContextAreaContext', () => ({
  useOptionalSpaceContextState: () => mockContextState.current,
}))

vi.mock('@stores/useUIStore', () => ({
  useUIStore: (
    selector: (state: {
      focusedCanvas: typeof mockFocusedCanvas.current
      setFocusedCanvas: typeof mockSetFocusedCanvas
    }) => unknown,
  ) => selector({
    focusedCanvas: mockFocusedCanvas.current,
    setFocusedCanvas: mockSetFocusedCanvas,
  }),
}))

vi.mock('@stores/useSpaceViewPrefsStore', () => ({
  useSpaceViewPrefsStore: (
    selector: (state: {
      getTaskViewMode: () => typeof mockTaskViewMode.current
      setTaskViewModeForScope: typeof mockSetTaskViewModeForScope
    }) => unknown,
  ) => selector({
    getTaskViewMode: () => mockTaskViewMode.current,
    setTaskViewModeForScope: mockSetTaskViewModeForScope,
  }),
}))

vi.mock('@components/chat/capsule/chatCapsuleMorph', () => ({
  captureTaskViewModeMorph: mockCaptureTaskViewModeMorph,
}))

const makeRegistry = (): ContextRegistry => ({
  getTabLabel: (item: ContextItem) => item.title ?? item.tabKey,
  getTabIcon: () => null,
  getDragPayload: () => ({} as Record<string, unknown>),
  getCanvasColor: () => null,
  isClosable: () => true,
}) as unknown as ContextRegistry

const makeWebItem = (): ContextItem => ({
  type: 'tabweb',
  id: 'a',
  tabKey: 'tabweb:a',
  title: 'Site A',
})

const makeDocItem = (): ContextItem => ({
  type: 'tabdoc',
  id: 'doc-1',
  tabKey: 'tabdoc:doc-1',
  title: 'My Doc',
})

const makeTableItem = (): ContextItem => ({
  type: 'tabdata',
  id: 'table-1',
  tabKey: 'tabdata:table-1',
  title: '123',
})

const baseProps = (overrides: Partial<React.ComponentProps<typeof NormalTab>> = {}) => ({
  item: makeWebItem(),
  registry: makeRegistry(),
  isActive: false,
  isClosing: false,
  t: ((key: string, opts?: { defaultValue?: string }) =>
    opts?.defaultValue ?? key) as unknown as React.ComponentProps<typeof NormalTab>['t'],
  onSelect: vi.fn(),
  onRequestClose: vi.fn(),
  onMiddleClickClose: vi.fn(),
  onContextMenu: vi.fn(),
  dragProps: {
    draggable: true,
    onDragStart: vi.fn(),
    onDragEnd: vi.fn(),
  },
  ...overrides,
})

beforeEach(() => {
  _resetTabDocDirtyRegistry()
  mockContextState.current = null
  mockFocusedCanvas.current = null
  mockTaskViewMode.current = 'split'
  mockSetFocusedCanvas.mockReset()
  mockSetTaskViewModeForScope.mockReset()
  mockCaptureTaskViewModeMorph.mockReset()
})

afterEach(() => {
  _resetTabDocDirtyRegistry()
})

describe('NormalTab · 基础结构', () => {
  it('包含 data-tab-item 与 data-tab-key（用于 overflow detection）', () => {
    const props = baseProps()
    const { container } = render(<NormalTab {...props} />)
    const tab = container.querySelector('[data-tab-item][data-tab-key="tabweb:a"]')
    expect(tab).toBeTruthy()
  })

  it('role="tab" + tabIndex=0 + aria-selected=isActive', () => {
    const { rerender, container } = render(<NormalTab {...baseProps({ isActive: false })} />)
    let tab = container.querySelector('[role="tab"]')
    expect(tab?.getAttribute('aria-selected')).toBe('false')

    rerender(<NormalTab {...baseProps({ isActive: true })} />)
    tab = container.querySelector('[role="tab"]')
    expect(tab?.getAttribute('aria-selected')).toBe('true')
  })

  it('宽度策略按内容自然展开，但保留最大宽度上限', () => {
    const { container } = render(
      <NormalTab {...baseProps({ item: { ...makeWebItem(), title: '融资事件库' } })} />,
    )
    const tab = container.querySelector('[role="tab"]') as HTMLElement
    expect(tab.className).toContain('min-w-[48px]')
    expect(tab.className).toContain('max-w-[220px]')
    expect(tab.className).toContain('shrink-0')
    expect(tab.getAttribute('title')).toBe('融资事件库')
  })
})

describe('NormalTab · 拖拽排序反馈', () => {
  it('拖动源标签时保留中性空占位，并隐藏原标签内容', () => {
    const { container } = render(<NormalTab {...baseProps({ isDragging: true })} />)
    const tab = container.querySelector('[role="tab"]') as HTMLElement
    const content = container.querySelector('[data-tab-drag-content]') as HTMLElement

    expect(tab.dataset.tabPlaceholder).toBe('true')
    expect(tab.className).toContain('border-dashed')
    expect(tab.className).toContain('border-border/60')
    expect(tab.className).not.toContain('border-accent')
    expect(content.className).toContain('invisible')
    expect(content.hasAttribute('inert')).toBe(true)
  })

  it('占位标签可平滑移动，但不显示蓝色目标态或插入标记', () => {
    const { container } = render(
      <NormalTab
        {...baseProps({
          reorderOffsetX: 48,
        })}
      />,
    )
    const tab = container.querySelector('[role="tab"]') as HTMLElement
    const marker = container.querySelector('[data-reorder-marker]')

    expect(tab.style.transform).toBe('translateX(48px)')
    expect(tab.className).not.toContain('ring-accent')
    expect(marker).toBeNull()
  })
})

describe('NormalTab · 关闭按钮', () => {
  it('为关闭按钮预留右侧空间，hover 时不遮挡标题', () => {
    const { container } = render(<NormalTab {...baseProps()} />)
    const tab = container.querySelector('[role="tab"]') as HTMLElement
    expect(tab.className).toContain('pr-6')
  })

  it('点击关闭按钮 → 触发 onRequestClose（不调用 onSelect）', () => {
    const onRequestClose = vi.fn()
    const onSelect = vi.fn()
    const { container } = render(
      <NormalTab {...baseProps({ onRequestClose, onSelect })} />,
    )
    const closeBtn = container.querySelector('button[aria-label="tab.menu.close"]')
    expect(closeBtn).toBeTruthy()
    fireEvent.click(closeBtn!)
    expect(onRequestClose).toHaveBeenCalledTimes(1)
    expect(onSelect).not.toHaveBeenCalled()  // stopPropagation 生效
  })

  it('中键点击 tab 主体 → 触发 onMiddleClickClose', () => {
    const onMiddleClickClose = vi.fn()
    const { container } = render(<NormalTab {...baseProps({ onMiddleClickClose })} />)
    const tab = container.querySelector('[role="tab"]')!
    // testing-library 的 fireEvent 没有 auxClick 简写，手动分派 MouseEvent('auxclick')
    const event = new MouseEvent('auxclick', { bubbles: true, button: 1 })
    tab.dispatchEvent(event)
    expect(onMiddleClickClose).toHaveBeenCalledTimes(1)
    expect(onMiddleClickClose.mock.calls[0][0].button).toBe(1)
  })

  it('右键点击 tab → 触发 onContextMenu', () => {
    const onContextMenu = vi.fn()
    const { container } = render(<NormalTab {...baseProps({ onContextMenu })} />)
    fireEvent.contextMenu(container.querySelector('[role="tab"]')!)
    expect(onContextMenu).toHaveBeenCalledTimes(1)
  })
})

describe('NormalTab · isClosing 视觉态', () => {
  it('isClosing=false → 没有 data-tab-closing 属性', () => {
    const { container } = render(<NormalTab {...baseProps({ isClosing: false })} />)
    const tab = container.querySelector('[role="tab"]')
    expect(tab?.getAttribute('data-tab-closing')).toBeNull()
  })

  it('isClosing=true → data-tab-closing="true" + 应用 closing 类（max-w-0 / opacity-0 / pointer-events-none）', () => {
    const { container } = render(<NormalTab {...baseProps({ isClosing: true })} />)
    const tab = container.querySelector('[role="tab"]') as HTMLElement
    expect(tab.getAttribute('data-tab-closing')).toBe('true')
    expect(tab.className).toContain('!max-w-0')
    expect(tab.className).toContain('opacity-0')
    expect(tab.className).toContain('pointer-events-none')
    // 必须有 transition 类（保证视觉过渡）
    expect(tab.className).toContain('transition-all')
    expect(tab.className).toContain('[transition-duration:120ms]')
  })
})

describe('NormalTab · tabdoc dirty 指示符', () => {
  it('非 tabdoc 即使有同 id register 也不显示指示符', () => {
    registerTabDocDirtySource(
      'a',
      () => ({ saveState: 'dirty', isDirty: true, isCollaborating: false, title: 'fake' }),
      async () => true,
    )
    const { container } = render(<NormalTab {...baseProps({ item: makeWebItem() })} />)
    const indicator = container.querySelector('[data-tab-dirty-indicator]')
    expect(indicator).toBeNull()
  })

  it('tabdoc + register dirty → 显示 dirty 指示符（圆点）', () => {
    registerTabDocDirtySource(
      'doc-1',
      () => ({ saveState: 'dirty', isDirty: false, isCollaborating: false, title: 'My Doc' }),
      async () => true,
    )
    const { container } = render(<NormalTab {...baseProps({ item: makeDocItem() })} />)
    const indicator = container.querySelector('[data-tab-dirty-indicator="dirty"]')
    expect(indicator).toBeTruthy()
  })

  it('tabdoc + register error → 显示 error 指示符（红圆点）', () => {
    registerTabDocDirtySource(
      'doc-1',
      () => ({ saveState: 'error', isDirty: true, isCollaborating: false, title: 'My Doc' }),
      async () => true,
    )
    const { container } = render(<NormalTab {...baseProps({ item: makeDocItem() })} />)
    const indicator = container.querySelector('[data-tab-dirty-indicator="error"]')
    expect(indicator).toBeTruthy()
    // 应用 destructive 颜色类
    expect(container.querySelector('.bg-destructive')).toBeTruthy()
  })

  it('tabdoc + register saving → 显示 saving 指示符（旋转）', () => {
    registerTabDocDirtySource(
      'doc-1',
      () => ({ saveState: 'saving', isDirty: false, isCollaborating: false, title: 'My Doc' }),
      async () => true,
    )
    const { container } = render(<NormalTab {...baseProps({ item: makeDocItem() })} />)
    const indicator = container.querySelector('[data-tab-dirty-indicator="saving"]')
    expect(indicator).toBeTruthy()
    // 应用 spin 动画类
    expect(container.querySelector('.animate-spin')).toBeTruthy()
  })

  it('tabdoc + 未 register → 不显示指示符', () => {
    const { container } = render(<NormalTab {...baseProps({ item: makeDocItem() })} />)
    const indicator = container.querySelector('[data-tab-dirty-indicator]')
    expect(indicator).toBeNull()
  })

  it('error 状态的指示符不应用 group-hover:opacity-0（永不让位）', () => {
    registerTabDocDirtySource(
      'doc-1',
      () => ({ saveState: 'error', isDirty: true, isCollaborating: false, title: 'My Doc' }),
      async () => true,
    )
    const { container } = render(<NormalTab {...baseProps({ item: makeDocItem(), isActive: false })} />)
    const indicator = container.querySelector('[data-tab-dirty-indicator="error"]') as HTMLElement
    expect(indicator).toBeTruthy()
    expect(indicator.className).not.toContain('group-hover:opacity-0')
  })

  it('active tab 上的 dirty 指示符不应用 group-hover:opacity-0（关闭按钮已常驻，圆点也无需让位）', () => {
    registerTabDocDirtySource(
      'doc-1',
      () => ({ saveState: 'dirty', isDirty: false, isCollaborating: false, title: 'My Doc' }),
      async () => true,
    )
    const { container } = render(<NormalTab {...baseProps({ item: makeDocItem(), isActive: true })} />)
    const indicator = container.querySelector('[data-tab-dirty-indicator="dirty"]') as HTMLElement
    expect(indicator).toBeTruthy()
    expect(indicator.className).not.toContain('group-hover:opacity-0')
  })

  it('非 active tab 上的 dirty / saving 指示符仍然 hover 让位', () => {
    registerTabDocDirtySource(
      'doc-1',
      () => ({ saveState: 'dirty', isDirty: false, isCollaborating: false, title: 'My Doc' }),
      async () => true,
    )
    const { container } = render(<NormalTab {...baseProps({ item: makeDocItem(), isActive: false })} />)
    const indicator = container.querySelector('[data-tab-dirty-indicator="dirty"]') as HTMLElement
    expect(indicator).toBeTruthy()
    expect(indicator.className).toContain('group-hover:opacity-0')
  })
})

describe('NormalTab · 临时展开', () => {
  it('无 scope 时 tabdoc / tabdata 都不显示临时展开入口', () => {
    mockContextState.current = null
    const { container: docContainer } = render(<NormalTab {...baseProps({ item: makeDocItem() })} />)
    const { container: tableContainer } = render(<NormalTab {...baseProps({ item: makeTableItem() })} />)
    expect(docContainer.querySelector('button[aria-label="临时展开"]')).toBeNull()
    expect(tableContainer.querySelector('button[aria-label="临时展开"]')).toBeNull()
  })

  it('有 scope 时 tabdoc 与 tabdata 都显示临时展开入口，其它类型不显示', () => {
    mockContextState.current = { tabScopeKey: 'scope-1' }
    const { container: docContainer } = render(<NormalTab {...baseProps({ item: makeDocItem() })} />)
    const { container: tableContainer } = render(<NormalTab {...baseProps({ item: makeTableItem() })} />)
    const { container: webContainer } = render(<NormalTab {...baseProps({ item: makeWebItem() })} />)
    expect(docContainer.querySelector('button[aria-label="临时展开"]')).toBeTruthy()
    expect(tableContainer.querySelector('button[aria-label="临时展开"]')).toBeTruthy()
    expect(webContainer.querySelector('button[aria-label="临时展开"]')).toBeNull()
  })

  it('点击表格临时展开 → 选中标签并写入 focusedCanvas', () => {
    mockContextState.current = { tabScopeKey: 'scope-1' }
    const onSelect = vi.fn()
    const { container } = render(
      <NormalTab {...baseProps({ item: makeTableItem(), onSelect })} />,
    )
    fireEvent.click(container.querySelector('button[aria-label="临时展开"]')!)
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(mockSetFocusedCanvas).toHaveBeenCalledWith({
      scopeKey: 'scope-1',
      tabKey: 'tabdata:table-1',
    })
  })

  it('已临时展开时再点 → 退出临时展开', () => {
    mockContextState.current = { tabScopeKey: 'scope-1' }
    mockFocusedCanvas.current = { scopeKey: 'scope-1', tabKey: 'tabdata:table-1' }
    const { container } = render(<NormalTab {...baseProps({ item: makeTableItem() })} />)
    fireEvent.click(container.querySelector('button[aria-label="退出临时展开"]')!)
    expect(mockSetFocusedCanvas).toHaveBeenCalledWith(null)
  })

  it('任务分屏下点击标签聚焦 → 选中标签并进入统一 app-focus', () => {
    mockContextState.current = { tabScopeKey: 'conversation:session-1' }
    mockTaskViewMode.current = 'split'
    const onSelect = vi.fn()
    const { container } = render(
      <NormalTab {...baseProps({ item: makeTableItem(), isActive: true, onSelect })} />,
    )

    fireEvent.click(container.querySelector('button[aria-label="应用聚焦"]')!)

    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(mockSetTaskViewModeForScope).toHaveBeenCalledWith(
      'conversation:session-1',
      'app-focus',
    )
    expect(mockCaptureTaskViewModeMorph).toHaveBeenCalledWith('split', 'app-focus')
    expect(mockSetFocusedCanvas).not.toHaveBeenCalled()
  })

  it('顶部已进入 app-focus 时，活动标签显示退出入口并回到分屏', () => {
    mockContextState.current = { tabScopeKey: 'conversation:session-1' }
    mockTaskViewMode.current = 'app-focus'
    const { container } = render(
      <NormalTab {...baseProps({ item: makeDocItem(), isActive: true })} />,
    )

    fireEvent.click(container.querySelector('button[aria-label="退出应用聚焦"]')!)

    expect(mockSetTaskViewModeForScope).toHaveBeenCalledWith(
      'conversation:session-1',
      'split',
    )
  })

  it('app-focus 下点击非活动标签的聚焦入口 → 切标签但保持 app-focus', () => {
    mockContextState.current = { tabScopeKey: 'im:conversation-1' }
    mockTaskViewMode.current = 'app-focus'
    const onSelect = vi.fn()
    const { container } = render(
      <NormalTab {...baseProps({ item: makeTableItem(), isActive: false, onSelect })} />,
    )

    fireEvent.click(container.querySelector('button[aria-label="应用聚焦"]')!)

    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(mockSetTaskViewModeForScope).toHaveBeenCalledWith(
      'im:conversation-1',
      'app-focus',
    )
  })

  it('任务 scope 遗留 focusedCanvas 不再裁决按钮状态，并在操作时按 scope 清理', () => {
    mockContextState.current = { tabScopeKey: 'conversation:session-1' }
    mockTaskViewMode.current = 'split'
    mockFocusedCanvas.current = {
      scopeKey: 'conversation:session-1',
      tabKey: 'tabdata:table-1',
    }
    const { container } = render(
      <NormalTab {...baseProps({ item: makeTableItem(), isActive: true })} />,
    )

    expect(container.querySelector('button[aria-label="退出应用聚焦"]')).toBeNull()
    fireEvent.click(container.querySelector('button[aria-label="应用聚焦"]')!)

    expect(mockSetTaskViewModeForScope).toHaveBeenCalledWith(
      'conversation:session-1',
      'app-focus',
    )
    expect(mockSetFocusedCanvas).toHaveBeenCalledWith(null)
  })
})
