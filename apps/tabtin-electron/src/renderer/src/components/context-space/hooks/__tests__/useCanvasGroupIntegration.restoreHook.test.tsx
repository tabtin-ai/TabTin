import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CanvasLayoutGroup } from '@stores/useCanvasLayoutStore'
import type { ContextTabKey } from '../../registry'
import { useCanvasGroupIntegration } from '../useCanvasGroupIntegration'

const mockStore = vi.hoisted(() => ({
  setActivePane: vi.fn(),
  removeGroup: vi.fn(),
  setActiveKey: vi.fn(),
  freshGroup: null as CanvasLayoutGroup | null,
}))

vi.mock('@stores/useCanvasLayoutStore', () => ({
  useCanvasLayoutStore: Object.assign(
    (selector: (state: {
      setActivePane: typeof mockStore.setActivePane
      removeGroup: typeof mockStore.removeGroup
    }) => unknown) =>
      selector({
        setActivePane: mockStore.setActivePane,
        removeGroup: mockStore.removeGroup,
      }),
    {
      getState: () => ({
        getGroupById: () => mockStore.freshGroup,
      }),
    },
  ),
}))

vi.mock('@stores/useSpaceContextTabsStore', () => ({
  useSpaceContextTabsStore: (selector: (state: {
    setActiveKey: typeof mockStore.setActiveKey
  }) => unknown) =>
    selector({
      setActiveKey: mockStore.setActiveKey,
    }),
}))

vi.mock('../../registry', () => ({
  contextRegistry: {
    parseTabKey: (tabKey: string) => {
      const [type, id] = tabKey.split(':')
      return type && id ? { type, id } : null
    },
    buildCanvasContent: vi.fn(),
    buildCanvasContentFromDrag: vi.fn(),
  },
}))

function makeGroup(tabKeys: string[]): CanvasLayoutGroup {
  return {
    id: 'group-1',
    spaceId: 'space-1',
    anchorTabKey: tabKeys[0] as `${string}:${string}`,
    activePaneId: 'pane-0',
    panes: tabKeys.map((tabKey, index) => ({
      id: `pane-${index}`,
      content: { tabKey: tabKey as `${string}:${string}` },
    })),
    layout: {
      type: 'split',
      id: 'split-1',
      direction: 'horizontal',
      children: tabKeys.map((_, index) => ({
        type: 'leaf' as const,
        paneId: `pane-${index}`,
      })),
      sizes: tabKeys.map(() => 1 / tabKeys.length),
    },
    createdAt: 1,
    updatedAt: 1,
  }
}

describe('useCanvasGroupIntegration handleRestoreGroup', () => {
  beforeEach(() => {
    mockStore.setActivePane.mockReset()
    mockStore.removeGroup.mockReset()
    mockStore.setActiveKey.mockReset()
    mockStore.freshGroup = null
  })

  it('mixed group restore 不改写 hidden session 的持久 canvas state', () => {
    const visibleGroup = makeGroup(['tabdoc:doc-1', 'tabdata:table-1'])
    mockStore.freshGroup = makeGroup(['tabdoc:doc-1', 'tabdata:table-1', 'subagent_session:hidden'])
    const setTabOrder = vi.fn()
    const { result } = renderHook(() => useCanvasGroupIntegration({
      spaceId: 'space-1',
      activeTabKey: 'tabdoc:doc-1',
      activeTabType: 'tabdoc',
      safeSpaceGroups: [visibleGroup],
      contextItemByTabKey: new Map(),
      currentTabKeys: ['tabdoc:doc-1', 'tabdata:table-1', 'tabweb:web-1'] as ContextTabKey[],
      contextVisibleTabKeys: ['tabdoc:doc-1', 'tabdata:table-1'] as ContextTabKey[],
      browserViewList: [],
      setTabOrder,
      isForeground: false,
    }))

    act(() => result.current.handleRestoreGroup(visibleGroup))

    expect(setTabOrder).not.toHaveBeenCalled()
    expect(mockStore.setActiveKey).not.toHaveBeenCalled()
    expect(mockStore.removeGroup).not.toHaveBeenCalled()
  })

  it('完整可见 group restore 仍会还原 tabOrder 并删除 group', () => {
    const visibleGroup = makeGroup(['tabdoc:doc-1', 'tabdata:table-1'])
    mockStore.freshGroup = visibleGroup
    const setTabOrder = vi.fn()
    const { result } = renderHook(() => useCanvasGroupIntegration({
      spaceId: 'space-1',
      activeTabKey: 'tabdoc:doc-1',
      activeTabType: 'tabdoc',
      safeSpaceGroups: [visibleGroup],
      contextItemByTabKey: new Map(),
      currentTabKeys: ['tabdoc:doc-1', 'tabdata:table-1', 'tabweb:web-1'] as ContextTabKey[],
      contextVisibleTabKeys: ['tabdoc:doc-1', 'tabdata:table-1'] as ContextTabKey[],
      browserViewList: [],
      setTabOrder,
      isForeground: false,
    }))

    act(() => result.current.handleRestoreGroup(visibleGroup))

    expect(setTabOrder).toHaveBeenCalledWith(['tabdoc:doc-1', 'tabdata:table-1', 'tabweb:web-1'])
    expect(mockStore.setActiveKey).toHaveBeenCalledWith('space-1', 'tabdoc:doc-1')
    expect(mockStore.removeGroup).toHaveBeenCalledWith('space-1', 'group-1')
  })
})
