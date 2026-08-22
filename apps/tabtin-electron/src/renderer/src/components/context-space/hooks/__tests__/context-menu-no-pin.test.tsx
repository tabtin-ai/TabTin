/**
 * 标签右键菜单不含 Pin 项的回归测试
 *
 * 背景：早期 `useContextTabsLogic` 暴露了 `onPinItem` 可选回调 + `tab.menu.pinLeft`
 * 文案，但没有任何调用方实装；`canPin = Boolean(onPinItem)` 永远为 false。
 * 结果是代码里留有"画大饼"的接口、变量、i18n 文案和菜单项，违背总控 D1 的
 * "承诺兑现"原则。
 *
 * D1 最终决策：砍掉 pin 菜单项 + 所有相关接口 / 变量 / i18n 文案。
 * 本测试锁定四条不变量：
 *
 * 1. 右键菜单的 id 集合里不得出现 `pin-left` / `pin` / `unpin`（防止被重新引入）
 * 2. 菜单项顺序精确固定：new-web-tab → reopen-closed-tab → (sep) → refresh →
 *    close → (sep) → close-others → close-left → close-right
 * 3. hasLeft / hasRight / hasOthers 会按 visibleItems 的位置计算，
 *    使得首标签的 close-left、末标签的 close-right、单标签的 close-others
 *    均被置为 disabled
 * 4. 关闭相关菜单项的 onClick 回调会正确转发给父组件注入的 handler
 *
 * ⚠️ 维护提示：当你**合法**地新增/删除/重排右键菜单项时，**必须同步更新**
 * 「菜单项顺序与集合精确固定」用例里的 `nonSeparatorIds` 期望值。这是
 * 有意设计的 "锁契约" 测试 —— 它挡不住演进，但能挡住"偷偷重新引入 pin"。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { NativeMenuItem } from '@/utils/nativeMenu'

const mockOpenNativeContextMenu = vi.fn().mockReturnValue(() => {})
const mockClosedTabsStack: { stack: string[] } = { stack: [] }

vi.mock('@/utils/nativeMenu', () => ({
  openNativeContextMenu: (items: NativeMenuItem[], x?: number, y?: number) =>
    mockOpenNativeContextMenu(items, x, y),
  menuSeparator: () => ({ id: 'sep', type: 'separator' as const }),
}))

vi.mock('@stores/useClosedTabsStore', () => ({
  useClosedTabsStore: {
    getState: () => mockClosedTabsStack,
  },
}))

vi.mock('@stores/useCanvasLayoutStore', () => ({
  useCanvasLayoutStore: Object.assign(
    (sel: (s: Record<string, unknown>) => unknown) =>
      sel({ setActivePane: vi.fn(), removeGroup: vi.fn() }),
    { getState: () => ({ setActivePane: vi.fn(), removeGroup: vi.fn() }) },
  ),
}))

import type { ContextItem, ContextRegistry } from '@components/context-space/registry'
import { useContextTabsLogic } from '@hooks/useContextTabsLogic'

type MenuItemLite = { id: string; enabled?: boolean; type?: string; onClick?: () => void; label?: string }

function makeItem(tabKey: string, type = 'tabweb'): ContextItem {
  const [t, id] = tabKey.split(':')
  return { type: (type || t) as ContextItem['type'], id, tabKey: tabKey as ContextItem['tabKey'] }
}

const fakeRegistry = {
  getTabLabel: (item: ContextItem) => item.title ?? item.tabKey,
  getTabIcon: () => null,
  parseTabKey: (key: string) => {
    const idx = key.indexOf(':')
    if (idx <= 0) return null
    return { type: key.slice(0, idx), id: key.slice(idx + 1) }
  },
  getHandler: () => null,
  buildTabKey: (type: string, id: string) => `${type}:${id}`,
  getDragPayload: () => ({} as Record<string, unknown>),
  getCanvasColor: () => null,
} as unknown as ContextRegistry

function makeParams(overrides: Partial<Parameters<typeof useContextTabsLogic>[0]> = {}) {
  const items = overrides.items ?? [makeItem('tabweb:a'), makeItem('tabweb:b'), makeItem('tabweb:c')]
  return {
    items,
    registry: fakeRegistry,
    groupedTabKeys: undefined,
    canvasGroups: undefined,
    onSelectHome: vi.fn(),
    onSelectItem: vi.fn(),
    onCloseItem: vi.fn(),
    onRefreshItem: vi.fn(),
    onCloseOtherItems: vi.fn(),
    onCloseLeftItems: vi.fn(),
    onCloseRightItems: vi.fn(),
    onCreateWebTab: vi.fn(),
    onReopenClosedTab: vi.fn(),
    onRestoreGroup: vi.fn(),
    ...overrides,
  }
}

function invokeContextMenu(
  hook: ReturnType<typeof renderHook<ReturnType<typeof useContextTabsLogic>, unknown>>,
  item: ContextItem,
): MenuItemLite[] {
  const fakeEvent = { preventDefault: vi.fn(), stopPropagation: vi.fn(), clientX: 0, clientY: 0 } as unknown as React.MouseEvent
  hook.result.current.handleTabContextMenu(fakeEvent, item)
  const lastCall = mockOpenNativeContextMenu.mock.calls.at(-1)
  expect(lastCall, '期望 openNativeContextMenu 至少被调用一次').toBeDefined()
  return lastCall![0] as MenuItemLite[]
}

describe('useContextTabsLogic · 右键菜单 pin 清除回归', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockClosedTabsStack.stack = []
  })

  it('菜单项 id 集合里不得出现 pin 相关项（防止画大饼回归）', () => {
    const params = makeParams()
    const hook = renderHook(() => useContextTabsLogic(params))

    const items = invokeContextMenu(hook, params.items[1])
    const ids = items.map(i => i.id)

    // 显式断言三种可能的回归命名
    expect(ids).not.toContain('pin-left')
    expect(ids).not.toContain('pin')
    expect(ids).not.toContain('unpin')
    // label 是 i18n key（setup.ts 把 t 设为 k => k），不得暴露 tab.menu.pin 前缀
    // 精确匹配 tab.menu.pin 相关 key，避免误伤 `mapping`/`pinyin` 等合法单词
    const labels = items.map(i => i.label ?? '')
    for (const label of labels) {
      expect(label.startsWith('tab.menu.pin'), `菜单 label "${label}" 不应以 tab.menu.pin 开头`).toBe(false)
      expect(label).not.toBe('tab.pinEmptyHint')
      expect(label).not.toBe('tab.pinDropHint')
      expect(label).not.toBe('tab.pinUnsupportedTitle')
      expect(label).not.toBe('tab.pinUnsupportedDesc')
    }
  })

  it('菜单项顺序与集合精确固定（排除 separator 后）', () => {
    const params = makeParams()
    const hook = renderHook(() => useContextTabsLogic(params))

    const items = invokeContextMenu(hook, params.items[1])
    const nonSeparatorIds = items
      .filter(i => i.type !== 'separator')
      .map(i => i.id)

    expect(nonSeparatorIds).toEqual([
      'new-web-tab',
      'reopen-closed-tab',
      'refresh',
      'close',
      'close-others',
      'close-left',
      'close-right',
    ])
  })

  it('首标签：close-left 被置为 disabled（hasLeft=false）', () => {
    const params = makeParams()
    const hook = renderHook(() => useContextTabsLogic(params))

    const items = invokeContextMenu(hook, params.items[0])
    const findById = (id: string) => items.find(i => i.id === id)

    expect(findById('close-left')?.enabled).toBe(false)
    expect(findById('close-right')?.enabled).toBe(true)
    expect(findById('close-others')?.enabled).toBe(true)
  })

  it('末标签：close-right 被置为 disabled（hasRight=false）', () => {
    const params = makeParams()
    const hook = renderHook(() => useContextTabsLogic(params))

    const items = invokeContextMenu(hook, params.items[2])
    const findById = (id: string) => items.find(i => i.id === id)

    expect(findById('close-left')?.enabled).toBe(true)
    expect(findById('close-right')?.enabled).toBe(false)
    expect(findById('close-others')?.enabled).toBe(true)
  })

  it('单标签：close-others / close-left / close-right 全部 disabled（hasOthers=false）', () => {
    const onlyItem = makeItem('tabweb:solo')
    const params = makeParams({ items: [onlyItem] })
    const hook = renderHook(() => useContextTabsLogic(params))

    const items = invokeContextMenu(hook, onlyItem)
    const findById = (id: string) => items.find(i => i.id === id)

    expect(findById('close-others')?.enabled).toBe(false)
    expect(findById('close-left')?.enabled).toBe(false)
    expect(findById('close-right')?.enabled).toBe(false)
  })

  it('close / close-others / close-left / close-right 的 onClick 会正确转发给注入的 handler', () => {
    const params = makeParams()
    const hook = renderHook(() => useContextTabsLogic(params))
    const target = params.items[1]

    const items = invokeContextMenu(hook, target)
    const byId = (id: string) => items.find(i => i.id === id)

    byId('close')!.onClick!()
    byId('close-others')!.onClick!()
    byId('close-left')!.onClick!()
    byId('close-right')!.onClick!()

    expect(params.onCloseItem).toHaveBeenCalledWith(target)
    expect(params.onCloseOtherItems).toHaveBeenCalledWith(target)
    expect(params.onCloseLeftItems).toHaveBeenCalledWith(target)
    expect(params.onCloseRightItems).toHaveBeenCalledWith(target)
  })

  it('new-web-tab / reopen-closed-tab / refresh 的 onClick 也会正确转发', () => {
    mockClosedTabsStack.stack = ['tabweb:recycled']
    const params = makeParams()
    const hook = renderHook(() => useContextTabsLogic(params))
    const target = params.items[1]

    const items = invokeContextMenu(hook, target)
    const byId = (id: string) => items.find(i => i.id === id)

    byId('new-web-tab')!.onClick!()
    byId('reopen-closed-tab')!.onClick!()
    byId('refresh')!.onClick!()

    expect(params.onCreateWebTab).toHaveBeenCalledTimes(1)
    expect(params.onReopenClosedTab).toHaveBeenCalledTimes(1)
    expect(params.onRefreshItem).toHaveBeenCalledWith(target)
  })

  it('reopen-closed-tab 的 enabled 跟随 closedTabsStore 的堆栈：空 → disabled', () => {
    mockClosedTabsStack.stack = []
    const params = makeParams()
    const hook = renderHook(() => useContextTabsLogic(params))

    const items = invokeContextMenu(hook, params.items[0])
    const entry = items.find(i => i.id === 'reopen-closed-tab')
    expect(entry?.enabled).toBe(false)
  })

  it('reopen-closed-tab 的 enabled 跟随 closedTabsStore 的堆栈：非空 → enabled', () => {
    mockClosedTabsStack.stack = ['tabweb:recycled']
    const params = makeParams()
    const hook = renderHook(() => useContextTabsLogic(params))

    const items = invokeContextMenu(hook, params.items[0])
    const entry = items.find(i => i.id === 'reopen-closed-tab')
    expect(entry?.enabled).toBe(true)
  })
})
