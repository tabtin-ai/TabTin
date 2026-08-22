import { describe, expect, it } from 'vitest'
import { selectIsCanvasModeForSpace } from './canvasMode'
import type { CanvasLayoutGroup } from './types'

const buildGroup = (spaceId: string, paneTabKeys: string[]): CanvasLayoutGroup => ({
  id: `group:${spaceId}:${paneTabKeys.join('+')}`,
  spaceId,
  anchorTabKey: paneTabKeys[0] as `${string}:${string}`,
  panes: paneTabKeys.map((tabKey, idx) => ({
    id: `pane:${idx}`,
    content: { tabKey: tabKey as `${string}:${string}` },
  })),
  layout: {
    type: 'split',
    id: 'split:root',
    direction: 'horizontal',
    children: paneTabKeys.map((_, idx) => ({ type: 'leaf', paneId: `pane:${idx}` })),
    sizes: paneTabKeys.map(() => 1 / paneTabKeys.length),
  },
  activePaneId: 'pane:0',
  createdAt: 0,
  updatedAt: 0,
})

describe('selectIsCanvasModeForSpace', () => {
  it('returns false when activeKey is missing', () => {
    expect(selectIsCanvasModeForSpace({}, {}, 'space-1')).toBe(false)
    expect(selectIsCanvasModeForSpace({}, { 'space-1': null }, 'space-1')).toBe(false)
  })

  it('returns false when activeKey type is home', () => {
    const groups = { 'space-1': [buildGroup('space-1', ['tabweb:view-1', 'tabweb:view-2'])] }
    expect(
      selectIsCanvasModeForSpace(groups, { 'space-1': 'home:home' }, 'space-1'),
    ).toBe(false)
  })

  it('returns false when activeKey cannot be parsed', () => {
    const groups = { 'space-1': [buildGroup('space-1', ['tabweb:view-1'])] }
    expect(
      selectIsCanvasModeForSpace(groups, { 'space-1': 'malformed' }, 'space-1'),
    ).toBe(false)
  })

  it('returns false when no canvas groups exist for space', () => {
    expect(
      selectIsCanvasModeForSpace(
        { 'space-1': [] },
        { 'space-1': 'tabweb:view-1' },
        'space-1',
      ),
    ).toBe(false)
    expect(
      selectIsCanvasModeForSpace({}, { 'space-1': 'tabweb:view-1' }, 'space-1'),
    ).toBe(false)
  })

  it('returns false when active tab is not in any pane of the space', () => {
    const groups = { 'space-1': [buildGroup('space-1', ['tabweb:view-A', 'tabweb:view-B'])] }
    expect(
      selectIsCanvasModeForSpace(groups, { 'space-1': 'tabweb:view-OUT' }, 'space-1'),
    ).toBe(false)
  })

  it('returns true when active tab is anchor pane in a group', () => {
    const groups = { 'space-1': [buildGroup('space-1', ['tabweb:view-A', 'tabweb:view-B'])] }
    expect(
      selectIsCanvasModeForSpace(groups, { 'space-1': 'tabweb:view-A' }, 'space-1'),
    ).toBe(true)
  })

  it('returns true when active tab is non-anchor pane in a group', () => {
    const groups = { 'space-1': [buildGroup('space-1', ['tabweb:view-A', 'tabweb:view-B'])] }
    expect(
      selectIsCanvasModeForSpace(groups, { 'space-1': 'tabweb:view-B' }, 'space-1'),
    ).toBe(true)
  })

  it('isolates canvas-mode by space — group in space-1 does not affect space-2', () => {
    const groups = {
      'space-1': [buildGroup('space-1', ['tabweb:view-A'])],
      'space-2': [],
    }
    const activeKeys = {
      'space-1': 'tabweb:view-A',
      'space-2': 'tabweb:view-A',
    }
    expect(selectIsCanvasModeForSpace(groups, activeKeys, 'space-1')).toBe(true)
    expect(selectIsCanvasModeForSpace(groups, activeKeys, 'space-2')).toBe(false)
  })

  it('handles tabdata / terminal tab types in canvas group', () => {
    const groups = {
      'space-1': [buildGroup('space-1', ['tabdata:table-1', 'terminal:sess-1'])],
    }
    expect(
      selectIsCanvasModeForSpace(groups, { 'space-1': 'tabdata:table-1' }, 'space-1'),
    ).toBe(true)
    expect(
      selectIsCanvasModeForSpace(groups, { 'space-1': 'terminal:sess-1' }, 'space-1'),
    ).toBe(true)
  })

  it('returns true when active tab matches a pane in any of multiple groups', () => {
    const groups = {
      'space-1': [
        buildGroup('space-1', ['tabweb:view-A']),
        buildGroup('space-1', ['tabweb:view-B', 'tabweb:view-C']),
      ],
    }
    expect(
      selectIsCanvasModeForSpace(groups, { 'space-1': 'tabweb:view-C' }, 'space-1'),
    ).toBe(true)
  })
})

describe('selectIsCanvasModeForSpace × real zustand stores (canvas-mode user journey)', () => {
  it('flips false → true when user enables canvas group on the active tabweb tab; back to false when group is removed', async () => {
    const { useCanvasLayoutStore } = await import('@/stores/useCanvasLayoutStore')
    const { useSpaceContextTabsStore } = await import('@/stores/useSpaceContextTabsStore')

    const spaceId = 'space-canvas-mode-1'
    const tabKey = 'tabweb:view-AAA'

    useCanvasLayoutStore.setState({ spaceGroups: {} })
    useSpaceContextTabsStore.setState({
      activeKeyBySpace: {},
      displayKeyBySpace: {},
      tabOrderBySpace: {},
      itemsBySpace: {},
    })

    useSpaceContextTabsStore.getState().openResourceTab(spaceId, {
      type: 'tabweb',
      id: 'view-AAA',
    })
    useSpaceContextTabsStore.getState().setActiveKey(spaceId, tabKey)

    const baselineGroups = useCanvasLayoutStore.getState().spaceGroups
    const baselineActiveKeys = useSpaceContextTabsStore.getState().activeKeyBySpace
    expect(
      selectIsCanvasModeForSpace(baselineGroups, baselineActiveKeys, spaceId),
    ).toBe(false)

    const created = useCanvasLayoutStore.getState().createGroup(
      spaceId,
      tabKey as `${string}:${string}`,
      { tabKey: tabKey as `${string}:${string}` },
    )

    const enabledGroups = useCanvasLayoutStore.getState().spaceGroups
    const enabledActiveKeys = useSpaceContextTabsStore.getState().activeKeyBySpace
    expect(
      selectIsCanvasModeForSpace(enabledGroups, enabledActiveKeys, spaceId),
    ).toBe(true)

    useCanvasLayoutStore.getState().removeGroup(spaceId, created.id)

    const finalGroups = useCanvasLayoutStore.getState().spaceGroups
    const finalActiveKeys = useSpaceContextTabsStore.getState().activeKeyBySpace
    expect(
      selectIsCanvasModeForSpace(finalGroups, finalActiveKeys, spaceId),
    ).toBe(false)
  })

  it('isolates canvas-mode flips between hot Spaces — A entering canvas does not flip B', async () => {
    const { useCanvasLayoutStore } = await import('@/stores/useCanvasLayoutStore')
    const { useSpaceContextTabsStore } = await import('@/stores/useSpaceContextTabsStore')

    const spaceA = 'space-iso-A'
    const spaceB = 'space-iso-B'
    const tabA = 'tabweb:view-A'
    const tabB = 'tabweb:view-B'

    useCanvasLayoutStore.setState({ spaceGroups: {} })
    useSpaceContextTabsStore.setState({
      activeKeyBySpace: {},
      displayKeyBySpace: {},
      tabOrderBySpace: {},
      itemsBySpace: {},
    })

    useSpaceContextTabsStore.getState().openResourceTab(spaceA, { type: 'tabweb', id: 'view-A' })
    useSpaceContextTabsStore.getState().setActiveKey(spaceA, tabA)
    useSpaceContextTabsStore.getState().openResourceTab(spaceB, { type: 'tabweb', id: 'view-B' })
    useSpaceContextTabsStore.getState().setActiveKey(spaceB, tabB)

    useCanvasLayoutStore.getState().createGroup(
      spaceA,
      tabA as `${string}:${string}`,
      { tabKey: tabA as `${string}:${string}` },
    )

    const groups = useCanvasLayoutStore.getState().spaceGroups
    const keys = useSpaceContextTabsStore.getState().activeKeyBySpace
    expect(selectIsCanvasModeForSpace(groups, keys, spaceA)).toBe(true)
    expect(selectIsCanvasModeForSpace(groups, keys, spaceB)).toBe(false)
  })

  it('flips back to false when user switches active tab away from a tab inside a canvas group', async () => {
    const { useCanvasLayoutStore } = await import('@/stores/useCanvasLayoutStore')
    const { useSpaceContextTabsStore } = await import('@/stores/useSpaceContextTabsStore')

    const spaceId = 'space-switch-tab'
    const tabIn = 'tabweb:view-IN'
    const tabOut = 'tabweb:view-OUT'

    useCanvasLayoutStore.setState({ spaceGroups: {} })
    useSpaceContextTabsStore.setState({
      activeKeyBySpace: {},
      displayKeyBySpace: {},
      tabOrderBySpace: {},
      itemsBySpace: {},
    })

    useSpaceContextTabsStore.getState().openResourceTab(spaceId, { type: 'tabweb', id: 'view-IN' })
    useSpaceContextTabsStore.getState().openResourceTab(spaceId, { type: 'tabweb', id: 'view-OUT' })
    useSpaceContextTabsStore.getState().setActiveKey(spaceId, tabIn)

    useCanvasLayoutStore.getState().createGroup(
      spaceId,
      tabIn as `${string}:${string}`,
      { tabKey: tabIn as `${string}:${string}` },
    )

    let groups = useCanvasLayoutStore.getState().spaceGroups
    let keys = useSpaceContextTabsStore.getState().activeKeyBySpace
    expect(selectIsCanvasModeForSpace(groups, keys, spaceId)).toBe(true)

    useSpaceContextTabsStore.getState().setActiveKey(spaceId, tabOut)

    groups = useCanvasLayoutStore.getState().spaceGroups
    keys = useSpaceContextTabsStore.getState().activeKeyBySpace
    expect(selectIsCanvasModeForSpace(groups, keys, spaceId)).toBe(false)
  })
})
