/**
 * CC-002 回归测试：useCloseHandlers 的 fallback 策略
 *
 * 历史背景：浏览器 handler 曾经在 onClose 里擅自把 activeKey 设为 null，
 * 导致关闭 canvas 分组内的浏览器标签时整个画布消失。本测试锁定三条不变量：
 *
 * 1. 关闭 canvas 分组内的 active tab 时，activeKey 应 fallback 到同 group 的 survivor pane
 * 2. handler.onClose 里即便"偷偷" setActiveKey(null)，hook 也会把 activeKey 纠回 plannedFallback
 * 3. 关闭普通 tab（不在 group 里）时，activeKey fallback 到 visible 邻居而非 null
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { CanvasLayoutGroup } from '@stores/useCanvasLayoutStore'
import type { ContextItem, ContainerContext } from '../../registry/types'

type MutableState = {
  tabOrderBySpace: Record<string, string[]>
  activeKeyBySpace: Record<string, string | null>
  spaceGroups: Record<string, CanvasLayoutGroup[]>
}

const state: MutableState = {
  tabOrderBySpace: {},
  activeKeyBySpace: {},
  spaceGroups: {},
}

const mockSetActiveKey = vi.fn((_spaceId: string, key: string | null) => {
  state.activeKeyBySpace['sp-1'] = key
})
const mockCloseTab = vi.fn((_spaceId: string, tabKey: string, fallback?: string | null) => {
  const order = state.tabOrderBySpace['sp-1'] ?? []
  state.tabOrderBySpace['sp-1'] = order.filter(k => k !== tabKey)
  if (fallback !== undefined) {
    state.activeKeyBySpace['sp-1'] = fallback
  }
})
const mockBatchCloseTab = vi.fn((_spaceId: string, tabKeys: string[]) => {
  const order = state.tabOrderBySpace['sp-1'] ?? []
  const closingSet = new Set(tabKeys)
  const nextOrder = order.filter(k => !closingSet.has(k))
  state.tabOrderBySpace['sp-1'] = nextOrder
  const active = state.activeKeyBySpace['sp-1']
  if (active && closingSet.has(active)) {
    // 真实 store 的 fallback：tabOrder 邻居（取 Math.min(closedIdx, nextOrder.length-1)）
    const closedIdx = order.indexOf(active)
    const fallbackIdx = Math.min(closedIdx, nextOrder.length - 1)
    state.activeKeyBySpace['sp-1'] = fallbackIdx >= 0 ? nextOrder[fallbackIdx] : null
  }
})
// 简化 mock：仅模拟 panes 过滤和 0-pane 销毁逻辑，不包含真实 store 的
// layout（removeLeafFromTree）/ anchorTabKey 重算 / activePaneId fallback。
// cc002 断言范围只涉及 panes.length 和 content.tabKey，对此足够。
const mockClosePane = vi.fn((_spaceId: string, groupId: string, paneId: string) => {
  const groups = state.spaceGroups['sp-1'] ?? []
  state.spaceGroups['sp-1'] = groups
    .map(group => {
      if (group.id !== groupId) return group
      const nextPanes = group.panes.filter(p => p.id !== paneId)
      if (nextPanes.length === 0) return null
      return { ...group, panes: nextPanes }
    })
    .filter((group): group is CanvasLayoutGroup => group !== null)
})

vi.mock('@stores/useCanvasLayoutStore', () => ({
  useCanvasLayoutStore: Object.assign(
    (sel: (s: Record<string, unknown>) => unknown) => sel({ closePane: mockClosePane, spaceGroups: state.spaceGroups }),
    { getState: () => ({ spaceGroups: state.spaceGroups, closePane: mockClosePane }) },
  ),
}))

vi.mock('@stores/useSpaceContextTabsStore', () => ({
  useSpaceContextTabsStore: Object.assign(
    (sel: (s: Record<string, unknown>) => unknown) => sel({}),
    {
      getState: () => ({
        tabOrderBySpace: state.tabOrderBySpace,
        activeKeyBySpace: state.activeKeyBySpace,
        closeTab: mockCloseTab,
        setActiveKey: mockSetActiveKey,
        batchCloseTab: mockBatchCloseTab,
      }),
    },
  ),
}))

vi.mock('@hooks/useTabDiscardListener', () => ({
  useDiscardedViewStore: { getState: () => ({ clearDiscarded: vi.fn() }) },
}))

const mockDispatchBeforeClose = vi.fn().mockResolvedValue(true)
// W2 T4 升级：dispatchClose 返回 DispatchCloseResult；`needsClose: true` 表示 hook 仍需 closeTab 兜底。
const mockDispatchClose = vi.fn().mockResolvedValue({ hasHandler: false, needsClose: true })
const mockDispatchAfterClose = vi.fn()

vi.mock('../../registry', () => ({
  contextRegistry: {
    isClosable: () => true,
    dispatchBeforeClose: (...args: unknown[]) => mockDispatchBeforeClose(...args),
    dispatchClose: (...args: unknown[]) => mockDispatchClose(...args),
    dispatchAfterClose: (...args: unknown[]) => mockDispatchAfterClose(...args),
    parseTabKey: (key: string) => {
      const idx = key.indexOf(':')
      if (idx <= 0) return null
      return { type: key.slice(0, idx), id: key.slice(idx + 1) }
    },
  },
}))

import { renderHook, act } from '@testing-library/react'
import { useCloseHandlers } from '../useCloseHandlers'

function makeItem(tabKey: string, type = 'tabweb'): ContextItem {
  const [t, id] = tabKey.split(':')
  return { type: (type || t) as ContextItem['type'], id, tabKey: tabKey as ContextItem['tabKey'] }
}

function makeCtx(closeBrowserView?: () => Promise<unknown>): ContainerContext {
  return { spaceId: 'sp-1', closeBrowserView: closeBrowserView ?? vi.fn() }
}

function makeGroup(id: string, panes: Array<{ id: string; tabKey: string }>, activePaneId?: string): CanvasLayoutGroup {
  return {
    id,
    spaceId: 'sp-1',
    panes: panes.map(p => ({ id: p.id, content: { tabKey: p.tabKey } })),
    activePaneId: activePaneId ?? panes[0]?.id ?? null,
    anchorTabKey: panes[0]?.tabKey ?? null,
    layout: null,
    updatedAt: Date.now(),
  } as unknown as CanvasLayoutGroup
}

function makeHookParams(overrides: {
  visibleTabKeys?: string[]
  contextItems?: ContextItem[]
  currentTabKeys?: string[]
  groupedTabKeys?: Set<string>
  canvasGroups?: CanvasLayoutGroup[]
} = {}) {
  const items = overrides.contextItems ?? [makeItem('tabweb:v1')]
  return {
    spaceId: 'sp-1',
    containerCtx: makeCtx(),
    visibleTabKeys: overrides.visibleTabKeys ?? items.map(i => i.tabKey),
    currentTabKeys: overrides.currentTabKeys ?? items.map(i => i.tabKey),
    groupedTabKeys: overrides.groupedTabKeys ?? new Set<string>(),
    canvasGroups: overrides.canvasGroups ?? [],
    contextItemByTabKey: new Map(items.map(i => [i.tabKey, i])),
    setActiveKey: mockSetActiveKey,
    handleSelectItem: vi.fn(),
  }
}

describe('useCloseHandlers fallback invariants', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.tabOrderBySpace = {}
    state.activeKeyBySpace = {}
    state.spaceGroups = {}
    mockDispatchBeforeClose.mockResolvedValue(true)
    mockDispatchClose.mockResolvedValue({ hasHandler: false, needsClose: true })
  })

  it('关闭 canvas 分组内的活动标签 → activeKey fallback 到同 group 的 survivor pane', async () => {
    const closingItem = makeItem('tabweb:v-browser')
    const survivorItem = makeItem('terminal:t-1', 'terminal')
    state.tabOrderBySpace['sp-1'] = [closingItem.tabKey, survivorItem.tabKey]
    state.activeKeyBySpace['sp-1'] = closingItem.tabKey
    state.spaceGroups['sp-1'] = [
      makeGroup('g1', [
        { id: 'p1', tabKey: closingItem.tabKey },
        { id: 'p2', tabKey: survivorItem.tabKey },
      ], 'p1'),
    ]

    const params = makeHookParams({
      visibleTabKeys: [],
      contextItems: [closingItem, survivorItem],
    })
    const { result } = renderHook(() => useCloseHandlers(params))

    await act(async () => {
      result.current.handleCloseItem(closingItem)
      await new Promise(r => setTimeout(r, 20))
    })

    expect(mockSetActiveKey).toHaveBeenCalledWith('sp-1', survivorItem.tabKey)
    expect(mockClosePane).toHaveBeenCalledWith('sp-1', 'g1', 'p1')
    expect(mockCloseTab).toHaveBeenCalledWith('sp-1', closingItem.tabKey, survivorItem.tabKey)
  })

  it('handler.onClose 擅自 setActiveKey(null) → hook 会纠正回 plannedFallback', async () => {
    const closingItem = makeItem('tabweb:v-legacy')
    const survivorItem = makeItem('terminal:t-s', 'terminal')
    state.tabOrderBySpace['sp-1'] = [closingItem.tabKey, survivorItem.tabKey]
    state.activeKeyBySpace['sp-1'] = closingItem.tabKey
    state.spaceGroups['sp-1'] = [
      makeGroup('g2', [
        { id: 'p1', tabKey: closingItem.tabKey },
        { id: 'p2', tabKey: survivorItem.tabKey },
      ], 'p1'),
    ]

    mockDispatchClose.mockImplementation(async () => {
      state.activeKeyBySpace['sp-1'] = null
      // W2.5 T9 mock 升级：dispatchClose 返回 DispatchCloseResult；保持类型一致
      return { hasHandler: true, needsClose: true }
    })

    const params = makeHookParams({
      visibleTabKeys: [],
      contextItems: [closingItem, survivorItem],
    })
    const { result } = renderHook(() => useCloseHandlers(params))

    await act(async () => {
      result.current.handleCloseItem(closingItem)
      await new Promise(r => setTimeout(r, 20))
    })

    expect(mockSetActiveKey).toHaveBeenCalledWith('sp-1', survivorItem.tabKey)
    expect(state.activeKeyBySpace['sp-1']).toBe(survivorItem.tabKey)
  })

  it('关闭非 canvas 内的活动普通标签 → fallback 到 visible 右邻居', async () => {
    const closingItem = makeItem('tabdoc:d1', 'tabdoc')
    const rightItem = makeItem('tabdoc:d2', 'tabdoc')
    const leftItem = makeItem('tabdoc:d0', 'tabdoc')
    state.tabOrderBySpace['sp-1'] = [leftItem.tabKey, closingItem.tabKey, rightItem.tabKey]
    state.activeKeyBySpace['sp-1'] = closingItem.tabKey

    const params = makeHookParams({
      visibleTabKeys: [leftItem.tabKey, closingItem.tabKey, rightItem.tabKey],
      contextItems: [leftItem, closingItem, rightItem],
    })
    const { result } = renderHook(() => useCloseHandlers(params))

    await act(async () => {
      result.current.handleCloseItem(closingItem)
      await new Promise(r => setTimeout(r, 20))
    })

    expect(mockCloseTab).toHaveBeenCalledWith('sp-1', closingItem.tabKey, rightItem.tabKey)
  })

  it('关闭最后一个标签 → fallback = null（回到 home），不崩溃', async () => {
    const closingItem = makeItem('tabweb:last')
    state.tabOrderBySpace['sp-1'] = [closingItem.tabKey]
    state.activeKeyBySpace['sp-1'] = closingItem.tabKey

    const params = makeHookParams({
      visibleTabKeys: [closingItem.tabKey],
      contextItems: [closingItem],
    })
    const { result } = renderHook(() => useCloseHandlers(params))

    await act(async () => {
      result.current.handleCloseItem(closingItem)
      await new Promise(r => setTimeout(r, 20))
    })

    expect(mockCloseTab).toHaveBeenCalledWith('sp-1', closingItem.tabKey, undefined)
  })

  it('关闭非活动标签 → 不触发 setActiveKey', async () => {
    const activeItem = makeItem('tabdoc:active', 'tabdoc')
    const closingItem = makeItem('tabdoc:closing', 'tabdoc')
    state.tabOrderBySpace['sp-1'] = [activeItem.tabKey, closingItem.tabKey]
    state.activeKeyBySpace['sp-1'] = activeItem.tabKey

    const params = makeHookParams({
      visibleTabKeys: [activeItem.tabKey, closingItem.tabKey],
      contextItems: [activeItem, closingItem],
    })
    const { result } = renderHook(() => useCloseHandlers(params))

    await act(async () => {
      result.current.handleCloseItem(closingItem)
      await new Promise(r => setTimeout(r, 20))
    })

    expect(mockSetActiveKey).not.toHaveBeenCalled()
    expect(mockCloseTab).toHaveBeenCalledWith('sp-1', closingItem.tabKey, undefined)
  })

  it('2 pane canvas group 关其中一个 → group 存活为单 pane（W4 D-W4-7：不再 reorder）', async () => {
    const closingItem = makeItem('tabweb:v-left')
    const survivorItem = makeItem('tabweb:v-right')
    const rightStandaloneItem = makeItem('tabdoc:doc', 'tabdoc')
    state.tabOrderBySpace['sp-1'] = [closingItem.tabKey, survivorItem.tabKey, rightStandaloneItem.tabKey]
    state.activeKeyBySpace['sp-1'] = closingItem.tabKey
    state.spaceGroups['sp-1'] = [
      makeGroup('g-2pane', [
        { id: 'p1', tabKey: closingItem.tabKey },
        { id: 'p2', tabKey: survivorItem.tabKey },
      ], 'p1'),
    ]

    const params = {
      spaceId: 'sp-1',
      containerCtx: makeCtx(),
      visibleTabKeys: [rightStandaloneItem.tabKey],
      currentTabKeys: [closingItem.tabKey, survivorItem.tabKey, rightStandaloneItem.tabKey],
      groupedTabKeys: new Set([closingItem.tabKey, survivorItem.tabKey]),
      canvasGroups: state.spaceGroups['sp-1'] ?? [],
      contextItemByTabKey: new Map([
        [closingItem.tabKey, closingItem],
        [survivorItem.tabKey, survivorItem],
        [rightStandaloneItem.tabKey, rightStandaloneItem],
      ]),
      setActiveKey: mockSetActiveKey,
      handleSelectItem: vi.fn(),
    }
    const { result } = renderHook(() => useCloseHandlers(params))

    await act(async () => {
      result.current.handleCloseItem(closingItem)
      await new Promise(r => setTimeout(r, 20))
    })

    // W4 后 group 不再销毁（2→1 保留），survivor 留在 group 内自然有位置，无需 reorder tabOrder
    expect(mockSetActiveKey).toHaveBeenCalledWith('sp-1', survivorItem.tabKey)
    expect(mockClosePane).toHaveBeenCalledWith('sp-1', 'g-2pane', 'p1')
    // group 存活，包含单个 survivor pane
    const groups = state.spaceGroups['sp-1'] ?? []
    expect(groups).toHaveLength(1)
    expect(groups[0].panes).toHaveLength(1)
    expect(groups[0].panes[0].content?.tabKey).toBe(survivorItem.tabKey)
  })

  it('handleCloseOtherItems → 批量关闭时 activeKey fallback 到 preferredSurvivor', async () => {
    const keepItem = makeItem('tabdoc:keep', 'tabdoc')
    const closeA = makeItem('tabdoc:a', 'tabdoc')
    const closeB = makeItem('tabdoc:b', 'tabdoc')
    const closeC = makeItem('tabdoc:c', 'tabdoc')
    state.tabOrderBySpace['sp-1'] = [closeA.tabKey, keepItem.tabKey, closeB.tabKey, closeC.tabKey]
    state.activeKeyBySpace['sp-1'] = closeA.tabKey

    const params = makeHookParams({
      visibleTabKeys: [closeA.tabKey, keepItem.tabKey, closeB.tabKey, closeC.tabKey],
      contextItems: [keepItem, closeA, closeB, closeC],
    })
    const { result } = renderHook(() => useCloseHandlers(params))

    await act(async () => {
      result.current.handleCloseOtherItems(keepItem)
      await new Promise(r => setTimeout(r, 30))
    })

    // 预期：activeKey 最终切到 keepItem（preferredSurvivor），而不是 closeA/closeB 的邻居
    expect(state.activeKeyBySpace['sp-1']).toBe(keepItem.tabKey)
  })
})

describe('useCloseHandlers group-version handlers (W5)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.tabOrderBySpace = {}
    state.activeKeyBySpace = {}
    state.spaceGroups = {}
    mockDispatchBeforeClose.mockResolvedValue(true)
    mockDispatchClose.mockResolvedValue({ hasHandler: false, needsClose: true })
  })

  it('handleCloseOthersForGroup → 关闭不属于本 group 的所有 tabs', async () => {
    const gItem1 = makeItem('tabweb:g1')
    const gItem2 = makeItem('tabweb:g2')
    const otherA = makeItem('tabdoc:a', 'tabdoc')
    const otherB = makeItem('tabdoc:b', 'tabdoc')
    const group = makeGroup('g1', [
      { id: 'p1', tabKey: gItem1.tabKey },
      { id: 'p2', tabKey: gItem2.tabKey },
    ])
    state.tabOrderBySpace['sp-1'] = [otherA.tabKey, gItem1.tabKey, gItem2.tabKey, otherB.tabKey]
    state.activeKeyBySpace['sp-1'] = otherA.tabKey
    state.spaceGroups['sp-1'] = [group]

    const allItems = [otherA, gItem1, gItem2, otherB]
    const params = makeHookParams({
      visibleTabKeys: [otherA.tabKey, otherB.tabKey],
      currentTabKeys: allItems.map(i => i.tabKey),
      groupedTabKeys: new Set([gItem1.tabKey, gItem2.tabKey]),
      canvasGroups: [group],
      contextItems: allItems,
    })
    const { result } = renderHook(() => useCloseHandlers(params))

    await act(async () => {
      result.current.handleCloseOthersForGroup(group)
      await new Promise(r => setTimeout(r, 30))
    })

    expect(mockBatchCloseTab).toHaveBeenCalledWith('sp-1', [otherA.tabKey, otherB.tabKey])
  })

  it('handleCloseLeftForGroup → 关闭 slot 序列中 group 左侧的全部 tabs', async () => {
    const leftA = makeItem('tabdoc:left-a', 'tabdoc')
    const leftB = makeItem('tabdoc:left-b', 'tabdoc')
    const gItem = makeItem('tabweb:g1')
    const rightC = makeItem('tabdoc:right-c', 'tabdoc')
    const group = makeGroup('g1', [{ id: 'p1', tabKey: gItem.tabKey }])
    state.tabOrderBySpace['sp-1'] = [leftA.tabKey, leftB.tabKey, gItem.tabKey, rightC.tabKey]
    state.activeKeyBySpace['sp-1'] = gItem.tabKey
    state.spaceGroups['sp-1'] = [group]

    const allItems = [leftA, leftB, gItem, rightC]
    const params = makeHookParams({
      visibleTabKeys: [leftA.tabKey, leftB.tabKey, rightC.tabKey],
      currentTabKeys: allItems.map(i => i.tabKey),
      groupedTabKeys: new Set([gItem.tabKey]),
      canvasGroups: [group],
      contextItems: allItems,
    })
    const { result } = renderHook(() => useCloseHandlers(params))

    await act(async () => {
      result.current.handleCloseLeftForGroup(group)
      await new Promise(r => setTimeout(r, 30))
    })

    expect(mockBatchCloseTab).toHaveBeenCalledWith('sp-1', [leftA.tabKey, leftB.tabKey])
  })

  it('handleCloseRightForGroup → 关闭 slot 序列中 group 右侧的全部 tabs', async () => {
    const leftA = makeItem('tabdoc:left-a', 'tabdoc')
    const gItem = makeItem('tabweb:g1')
    const rightB = makeItem('tabdoc:right-b', 'tabdoc')
    const rightC = makeItem('tabdoc:right-c', 'tabdoc')
    const group = makeGroup('g1', [{ id: 'p1', tabKey: gItem.tabKey }])
    state.tabOrderBySpace['sp-1'] = [leftA.tabKey, gItem.tabKey, rightB.tabKey, rightC.tabKey]
    state.activeKeyBySpace['sp-1'] = gItem.tabKey
    state.spaceGroups['sp-1'] = [group]

    const allItems = [leftA, gItem, rightB, rightC]
    const params = makeHookParams({
      visibleTabKeys: [leftA.tabKey, rightB.tabKey, rightC.tabKey],
      currentTabKeys: allItems.map(i => i.tabKey),
      groupedTabKeys: new Set([gItem.tabKey]),
      canvasGroups: [group],
      contextItems: allItems,
    })
    const { result } = renderHook(() => useCloseHandlers(params))

    await act(async () => {
      result.current.handleCloseRightForGroup(group)
      await new Promise(r => setTimeout(r, 30))
    })

    expect(mockBatchCloseTab).toHaveBeenCalledWith('sp-1', [rightB.tabKey, rightC.tabKey])
  })

  it('handleCloseLeftForGroup → 最左 group 时不调用 batchClose', async () => {
    const gItem = makeItem('tabweb:g1')
    const rightA = makeItem('tabdoc:right', 'tabdoc')
    const group = makeGroup('g1', [{ id: 'p1', tabKey: gItem.tabKey }])
    state.tabOrderBySpace['sp-1'] = [gItem.tabKey, rightA.tabKey]
    state.spaceGroups['sp-1'] = [group]

    const allItems = [gItem, rightA]
    const params = makeHookParams({
      visibleTabKeys: [rightA.tabKey],
      currentTabKeys: allItems.map(i => i.tabKey),
      groupedTabKeys: new Set([gItem.tabKey]),
      canvasGroups: [group],
      contextItems: allItems,
    })
    const { result } = renderHook(() => useCloseHandlers(params))

    await act(async () => {
      result.current.handleCloseLeftForGroup(group)
      await new Promise(r => setTimeout(r, 30))
    })

    expect(mockBatchCloseTab).not.toHaveBeenCalled()
  })

  it('handleCloseRightForGroup → 最右 group 时不调用 batchClose', async () => {
    const leftA = makeItem('tabdoc:left', 'tabdoc')
    const gItem = makeItem('tabweb:g1')
    const group = makeGroup('g1', [{ id: 'p1', tabKey: gItem.tabKey }])
    state.tabOrderBySpace['sp-1'] = [leftA.tabKey, gItem.tabKey]
    state.spaceGroups['sp-1'] = [group]

    const allItems = [leftA, gItem]
    const params = makeHookParams({
      visibleTabKeys: [leftA.tabKey],
      currentTabKeys: allItems.map(i => i.tabKey),
      groupedTabKeys: new Set([gItem.tabKey]),
      canvasGroups: [group],
      contextItems: allItems,
    })
    const { result } = renderHook(() => useCloseHandlers(params))

    await act(async () => {
      result.current.handleCloseRightForGroup(group)
      await new Promise(r => setTimeout(r, 30))
    })

    expect(mockBatchCloseTab).not.toHaveBeenCalled()
  })

  it('handleCloseLeftForGroup → 左侧有另一个 group 时关闭其全部 pane', async () => {
    const g1Item1 = makeItem('tabweb:g1-1')
    const g1Item2 = makeItem('tabweb:g1-2')
    const g2Item = makeItem('tabweb:g2')
    const group1 = makeGroup('g1', [
      { id: 'p1', tabKey: g1Item1.tabKey },
      { id: 'p2', tabKey: g1Item2.tabKey },
    ])
    const group2 = makeGroup('g2', [{ id: 'p3', tabKey: g2Item.tabKey }])
    state.tabOrderBySpace['sp-1'] = [g1Item1.tabKey, g1Item2.tabKey, g2Item.tabKey]
    state.spaceGroups['sp-1'] = [group1, group2]

    const allItems = [g1Item1, g1Item2, g2Item]
    const params = makeHookParams({
      visibleTabKeys: [],
      currentTabKeys: allItems.map(i => i.tabKey),
      groupedTabKeys: new Set([g1Item1.tabKey, g1Item2.tabKey, g2Item.tabKey]),
      canvasGroups: [group1, group2],
      contextItems: allItems,
    })
    const { result } = renderHook(() => useCloseHandlers(params))

    await act(async () => {
      result.current.handleCloseLeftForGroup(group2)
      await new Promise(r => setTimeout(r, 30))
    })

    expect(mockBatchCloseTab).toHaveBeenCalledWith('sp-1', [g1Item1.tabKey, g1Item2.tabKey])
  })
})

describe('useCloseHandlers · onAfterClose 触发不变量（W11+ 隐患 1 修复回归）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.tabOrderBySpace = {}
    state.activeKeyBySpace = {}
    state.spaceGroups = {}
    mockDispatchBeforeClose.mockResolvedValue(true)
    mockDispatchClose.mockResolvedValue({ hasHandler: true, needsClose: true })
  })

  it('单 close 路径：dispatchAfterClose 紧跟 closeTab 同步触发，per-item lifecycle 完整', async () => {
    // 时序断言：onClose 销毁资源 → closeTab 删 tabOrder → onAfterClose 清 source。
    // 这个顺序保证 source 删除发生在 tabOrder 已无 self.tabKey 的状态下，
    // syncTabOrder 不会把 tabKey 加回 → tabOrder 状态稳定。
    const closingItem = makeItem('terminal:t-1', 'terminal')
    state.tabOrderBySpace['sp-1'] = [closingItem.tabKey]
    state.activeKeyBySpace['sp-1'] = closingItem.tabKey

    const callOrder: string[] = []
    mockDispatchClose.mockImplementation(async () => {
      callOrder.push('dispatchClose')
      return { hasHandler: true, needsClose: true }
    })
    mockCloseTab.mockImplementation((_spaceId: string, tabKey: string) => {
      callOrder.push('closeTab')
      const order = state.tabOrderBySpace['sp-1'] ?? []
      state.tabOrderBySpace['sp-1'] = order.filter(k => k !== tabKey)
    })
    mockDispatchAfterClose.mockImplementation(() => {
      callOrder.push('dispatchAfterClose')
    })

    const params = makeHookParams({
      visibleTabKeys: [closingItem.tabKey],
      contextItems: [closingItem],
    })
    const { result } = renderHook(() => useCloseHandlers(params))

    await act(async () => {
      result.current.handleCloseItem(closingItem)
      await new Promise(r => setTimeout(r, 10))
    })

    expect(callOrder).toEqual(['dispatchClose', 'closeTab', 'dispatchAfterClose'])
    expect(mockDispatchAfterClose).toHaveBeenCalledWith(closingItem, expect.any(Object))
  })

  it('单 close 路径：dispatchClose needsClose=false 时仍触发 onAfterClose（让 source-driven sync handler 仍能清后置资源）', async () => {
    // browser 这种"必须 await IPC"的 handler 在 onClose 期间已经间接让 syncTabOrder
    // 删了 self.tabKey → dispatchClose 返回 needsClose=false。即便如此，调用方仍然需要
    // 给它一次 onAfterClose 机会做后置清理。
    const closingItem = makeItem('tabweb:v-browser')
    state.tabOrderBySpace['sp-1'] = [] // 已被 source 间接删除
    state.activeKeyBySpace['sp-1'] = null

    mockDispatchClose.mockResolvedValue({ hasHandler: true, needsClose: false })

    const params = makeHookParams({
      visibleTabKeys: [],
      contextItems: [closingItem],
    })
    const { result } = renderHook(() => useCloseHandlers(params))

    await act(async () => {
      result.current.handleCloseItem(closingItem)
      await new Promise(r => setTimeout(r, 10))
    })

    expect(mockCloseTab).not.toHaveBeenCalled()
    expect(mockDispatchAfterClose).toHaveBeenCalledTimes(1)
    expect(mockDispatchAfterClose).toHaveBeenCalledWith(closingItem, expect.any(Object))
  })

  it('batch close 路径：每个 item 的 dispatchAfterClose 跟着自己的 dispatchClose .then 跑（per-item lifecycle）', async () => {
    const item1 = makeItem('terminal:t-1', 'terminal')
    const item2 = makeItem('terminal:t-2', 'terminal')
    const survivor = makeItem('terminal:t-3', 'terminal')
    state.tabOrderBySpace['sp-1'] = [item1.tabKey, item2.tabKey, survivor.tabKey]
    state.activeKeyBySpace['sp-1'] = item1.tabKey

    const params = makeHookParams({
      visibleTabKeys: [item1.tabKey, item2.tabKey, survivor.tabKey],
      contextItems: [item1, item2, survivor],
    })
    const { result } = renderHook(() => useCloseHandlers(params))

    await act(async () => {
      result.current.handleCloseOtherItems(survivor)
      await new Promise(r => setTimeout(r, 30))
    })

    // batchCloseTab 一次批删
    expect(mockBatchCloseTab).toHaveBeenCalledWith('sp-1', [item1.tabKey, item2.tabKey])
    // 每个被关 item 都收到自己的 dispatchAfterClose（per-item，不丢）
    expect(mockDispatchAfterClose).toHaveBeenCalledTimes(2)
    const calledItems = mockDispatchAfterClose.mock.calls.map(call => (call[0] as ContextItem).tabKey).sort()
    expect(calledItems).toEqual([item1.tabKey, item2.tabKey].sort())
  })

  it('batch close 路径：单个 item 的 dispatchClose 抛错也仍会 dispatchAfterClose（best effort 清理）', async () => {
    const item1 = makeItem('terminal:t-1', 'terminal')
    const item2 = makeItem('terminal:t-2', 'terminal')
    const survivor = makeItem('terminal:t-3', 'terminal')
    state.tabOrderBySpace['sp-1'] = [item1.tabKey, item2.tabKey, survivor.tabKey]
    state.activeKeyBySpace['sp-1'] = item1.tabKey

    // item1 的 dispatchClose 抛错；item2 正常
    mockDispatchClose.mockImplementation(async (item: ContextItem) => {
      if (item.tabKey === item1.tabKey) throw new Error('dispatch boom')
      return { hasHandler: true, needsClose: true }
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      const params = makeHookParams({
        visibleTabKeys: [item1.tabKey, item2.tabKey, survivor.tabKey],
        contextItems: [item1, item2, survivor],
      })
      const { result } = renderHook(() => useCloseHandlers(params))

      await act(async () => {
        result.current.handleCloseOtherItems(survivor)
        await new Promise(r => setTimeout(r, 30))
      })

      // 两个 item 都收到 dispatchAfterClose（even when dispatchClose throws）
      expect(mockDispatchAfterClose).toHaveBeenCalledTimes(2)
    } finally {
      warnSpy.mockRestore()
    }
  })
})
