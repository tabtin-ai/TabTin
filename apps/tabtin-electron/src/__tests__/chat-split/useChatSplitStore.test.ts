/**
 * useChatSplitStore 状态管理测试
 *
 * 覆盖：
 *  - initSinglePane / splitPane / closePane / resetSplit
 *  - setPaneSession / setActivePane / setSplitSizes
 *  - MAX_CHAT_PANES (3) 限制
 *  - getGroupedSessionIds (分屏即标签组)
 *  - Pinned sessions (toggle)
 *  - 边界条件 (无 projectId, 空 panes, 重复操作)
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { useChatSplitStore } from '@/stores/useChatSplitStore'
import { collectLeafIds } from '@/utils/split-layout'

const PROJECT = 'proj-1'
const SESSION_A = 'session-a'
const SESSION_B = 'session-b'
const SESSION_C = 'session-c'
const SESSION_D = 'session-d'

const store = () => useChatSplitStore.getState()

beforeEach(() => {
  useChatSplitStore.setState({
    splitBySpace: {},
    pinnedSessionsBySpace: {},
  })
})

// ─── init / basic split lifecycle ───

describe('initSinglePane', () => {
  it('creates a single-leaf layout', () => {
    store().initSinglePane(PROJECT, SESSION_A)
    const split = store().getSplit(PROJECT)!
    expect(split).toBeTruthy()
    expect(split.panes).toHaveLength(1)
    expect(split.panes[0].sessionId).toBe(SESSION_A)
    expect(split.layout.type).toBe('leaf')
    expect(split.activePaneId).toBe(split.panes[0].id)
  })

  it('isSplitActive returns false for single pane', () => {
    store().initSinglePane(PROJECT, SESSION_A)
    expect(store().isSplitActive(PROJECT)).toBe(false)
  })
})

describe('splitPane', () => {
  it('splits from single to two panes', () => {
    store().initSinglePane(PROJECT, SESSION_A)
    store().splitPane(PROJECT, SESSION_B, 'horizontal', 'right')

    const split = store().getSplit(PROJECT)!
    expect(split.panes).toHaveLength(2)
    expect(store().isSplitActive(PROJECT)).toBe(true)
    expect(split.layout.type).toBe('split')
    if (split.layout.type === 'split') {
      expect(split.layout.direction).toBe('horizontal')
      expect(split.layout.children).toHaveLength(2)
    }
  })

  it('sets new pane as active', () => {
    store().initSinglePane(PROJECT, SESSION_A)
    const firstPaneId = store().getSplit(PROJECT)!.panes[0].id
    store().splitPane(PROJECT, SESSION_B, 'horizontal', 'right')
    const split = store().getSplit(PROJECT)!
    expect(split.activePaneId).not.toBe(firstPaneId)
    expect(split.panes.find(p => p.id === split.activePaneId)?.sessionId).toBe(SESSION_B)
  })

  it('respects MAX_CHAT_PANES limit (3)', () => {
    store().initSinglePane(PROJECT, SESSION_A)
    store().splitPane(PROJECT, SESSION_B)
    store().splitPane(PROJECT, SESSION_C)
    store().splitPane(PROJECT, SESSION_D)

    const split = store().getSplit(PROJECT)!
    expect(split.panes).toHaveLength(3)
  })

  it('auto-creates split from scratch if no prior state', () => {
    store().splitPane(PROJECT, SESSION_B, 'horizontal', 'right')
    const split = store().getSplit(PROJECT)!
    expect(split).toBeTruthy()
    expect(split.panes).toHaveLength(2)
  })

  it('supports vertical direction', () => {
    store().initSinglePane(PROJECT, SESSION_A)
    store().splitPane(PROJECT, SESSION_B, 'vertical', 'bottom')
    const split = store().getSplit(PROJECT)!
    if (split.layout.type === 'split') {
      expect(split.layout.direction).toBe('vertical')
    }
  })
})

describe('closePane', () => {
  it('when closing one of two panes, split state should be removed', () => {
    store().initSinglePane(PROJECT, SESSION_A)
    store().splitPane(PROJECT, SESSION_B)
    const split = store().getSplit(PROJECT)!
    const paneToClose = split.panes.find(p => p.sessionId === SESSION_B)!

    store().closePane(PROJECT, paneToClose.id)

    const after = store().getSplit(PROJECT)
    expect(after).toBeNull()
    expect(store().isSplitActive(PROJECT)).toBe(false)
  })

  it('closing active pane in a two-pane split should clear split state', () => {
    store().initSinglePane(PROJECT, SESSION_A)
    store().splitPane(PROJECT, SESSION_B)
    const split = store().getSplit(PROJECT)!
    const activeId = split.activePaneId

    store().closePane(PROJECT, activeId)
    expect(store().getSplit(PROJECT)).toBeNull()
  })

  it('removes project entry when closing last pane', () => {
    store().initSinglePane(PROJECT, SESSION_A)
    const paneId = store().getSplit(PROJECT)!.panes[0].id
    store().closePane(PROJECT, paneId)
    expect(store().getSplit(PROJECT)).toBeNull()
  })

  it('is a no-op for non-existent project', () => {
    store().closePane('non-existent', 'fake-pane')
    expect(store().getSplit('non-existent')).toBeNull()
  })
})

describe('resetSplit', () => {
  it('keeps active pane and collapses to single', () => {
    store().initSinglePane(PROJECT, SESSION_A)
    store().splitPane(PROJECT, SESSION_B)
    store().splitPane(PROJECT, SESSION_C)
    const activePaneId = store().getSplit(PROJECT)!.activePaneId
    const activeSession = store().getSplit(PROJECT)!.panes.find(p => p.id === activePaneId)?.sessionId

    store().resetSplit(PROJECT)

    const after = store().getSplit(PROJECT)!
    expect(after.panes).toHaveLength(1)
    expect(after.panes[0].sessionId).toBe(activeSession)
    expect(after.layout.type).toBe('leaf')
  })

  it('is a no-op for non-existent project', () => {
    store().resetSplit('non-existent')
    expect(store().getSplit('non-existent')).toBeNull()
  })
})

// ─── pane session / active ───

describe('setPaneSession', () => {
  it('replaces session in a specific pane', () => {
    store().initSinglePane(PROJECT, SESSION_A)
    store().splitPane(PROJECT, SESSION_B)
    const split = store().getSplit(PROJECT)!
    const pane = split.panes.find(p => p.sessionId === SESSION_A)!

    store().setPaneSession(PROJECT, pane.id, SESSION_C)

    const after = store().getSplit(PROJECT)!
    expect(after.panes.find(p => p.id === pane.id)?.sessionId).toBe(SESSION_C)
  })

  it('is a no-op for non-existent project', () => {
    store().setPaneSession('non-existent', 'fake', SESSION_A)
    expect(store().getSplit('non-existent')).toBeNull()
  })
})

describe('setActivePane', () => {
  it('updates activePaneId', () => {
    store().initSinglePane(PROJECT, SESSION_A)
    store().splitPane(PROJECT, SESSION_B)
    const split = store().getSplit(PROJECT)!
    const otherPane = split.panes.find(p => p.id !== split.activePaneId)!

    store().setActivePane(PROJECT, otherPane.id)
    expect(store().getSplit(PROJECT)!.activePaneId).toBe(otherPane.id)
  })
})

describe('setSplitSizes', () => {
  it('updates sizes on the root split', () => {
    store().initSinglePane(PROJECT, SESSION_A)
    store().splitPane(PROJECT, SESSION_B)

    store().setSplitSizes(PROJECT, [], [0.7, 0.3])

    const split = store().getSplit(PROJECT)!
    if (split.layout.type === 'split') {
      expect(split.layout.sizes[0]).toBeCloseTo(0.7)
      expect(split.layout.sizes[1]).toBeCloseTo(0.3)
    }
  })
})

// ─── layout tree integrity ───

describe('layout tree integrity', () => {
  it('all pane ids appear in the layout tree', () => {
    store().initSinglePane(PROJECT, SESSION_A)
    store().splitPane(PROJECT, SESSION_B)
    store().splitPane(PROJECT, SESSION_C)

    const split = store().getSplit(PROJECT)!
    const treeIds = collectLeafIds(split.layout)
    const paneIds = split.panes.map(p => p.id)
    expect(treeIds.sort()).toEqual(paneIds.sort())
  })

  it('tree stays consistent after close', () => {
    store().initSinglePane(PROJECT, SESSION_A)
    store().splitPane(PROJECT, SESSION_B)
    store().splitPane(PROJECT, SESSION_C)
    const split = store().getSplit(PROJECT)!
    const middlePane = split.panes[1]

    store().closePane(PROJECT, middlePane.id)

    const after = store().getSplit(PROJECT)!
    const treeIds = collectLeafIds(after.layout)
    const paneIds = after.panes.map(p => p.id)
    expect(treeIds.sort()).toEqual(paneIds.sort())
  })
})

// ─── getGroupedSessionIds (分屏 = 标签组) ───

describe('getGroupedSessionIds', () => {
  it('returns empty set for single pane', () => {
    store().initSinglePane(PROJECT, SESSION_A)
    const ids = store().getGroupedSessionIds(PROJECT)
    expect(ids.size).toBe(0)
  })

  it('returns empty set for unknown project', () => {
    expect(store().getGroupedSessionIds('unknown').size).toBe(0)
  })

  it('returns session ids of all panes when split is active', () => {
    store().initSinglePane(PROJECT, SESSION_A)
    store().splitPane(PROJECT, SESSION_B)

    const ids = store().getGroupedSessionIds(PROJECT)
    expect(ids.has(SESSION_A)).toBe(true)
    expect(ids.has(SESSION_B)).toBe(true)
    expect(ids.size).toBe(2)
  })

  it('excludes null sessionIds (empty panes)', () => {
    store().initSinglePane(PROJECT, SESSION_A)
    store().splitPane(PROJECT, null)

    const ids = store().getGroupedSessionIds(PROJECT)
    expect(ids.has(SESSION_A)).toBe(true)
    expect(ids.size).toBe(1)
  })

  it('updates after setPaneSession', () => {
    store().initSinglePane(PROJECT, SESSION_A)
    store().splitPane(PROJECT, SESSION_B)
    const split = store().getSplit(PROJECT)!
    const pane = split.panes.find(p => p.sessionId === SESSION_B)!

    store().setPaneSession(PROJECT, pane.id, SESSION_C)

    const ids = store().getGroupedSessionIds(PROJECT)
    expect(ids.has(SESSION_A)).toBe(true)
    expect(ids.has(SESSION_C)).toBe(true)
    expect(ids.has(SESSION_B)).toBe(false)
  })

  it('becomes empty after resetSplit', () => {
    store().initSinglePane(PROJECT, SESSION_A)
    store().splitPane(PROJECT, SESSION_B)
    expect(store().getGroupedSessionIds(PROJECT).size).toBe(2)

    store().resetSplit(PROJECT)
    expect(store().getGroupedSessionIds(PROJECT).size).toBe(0)
  })
})

// ─── Pinned sessions ───

describe('pinned sessions', () => {
  it('starts with empty pinned list', () => {
    expect(store().getPinnedSessions(PROJECT)).toEqual([])
  })

  it('togglePinSession adds session', () => {
    store().togglePinSession(PROJECT, SESSION_A)
    expect(store().getPinnedSessions(PROJECT)).toEqual([SESSION_A])
  })

  it('togglePinSession removes when already pinned', () => {
    store().togglePinSession(PROJECT, SESSION_A)
    store().togglePinSession(PROJECT, SESSION_A)
    expect(store().getPinnedSessions(PROJECT)).toEqual([])
  })

  it('supports multiple pinned sessions', () => {
    store().togglePinSession(PROJECT, SESSION_A)
    store().togglePinSession(PROJECT, SESSION_B)
    expect(store().getPinnedSessions(PROJECT)).toEqual([SESSION_A, SESSION_B])
  })
})

// ─── Cross-project isolation ───

describe('cross-project isolation', () => {
  const PROJ_2 = 'proj-2'

  it('split state is independent per project', () => {
    store().initSinglePane(PROJECT, SESSION_A)
    store().initSinglePane(PROJ_2, SESSION_B)

    store().splitPane(PROJECT, SESSION_C)

    expect(store().isSplitActive(PROJECT)).toBe(true)
    expect(store().isSplitActive(PROJ_2)).toBe(false)
  })

  it('grouped session ids are independent per project', () => {
    store().initSinglePane(PROJECT, SESSION_A)
    store().splitPane(PROJECT, SESSION_B)
    store().initSinglePane(PROJ_2, SESSION_C)

    expect(store().getGroupedSessionIds(PROJECT).size).toBe(2)
    expect(store().getGroupedSessionIds(PROJ_2).size).toBe(0)
  })

  it('pinned sessions are independent per project', () => {
    store().togglePinSession(PROJECT, SESSION_A)
    store().togglePinSession(PROJ_2, SESSION_B)
    expect(store().getPinnedSessions(PROJECT)).toEqual([SESSION_A])
    expect(store().getPinnedSessions(PROJ_2)).toEqual([SESSION_B])
  })
})

// ─── Edge cases ───

describe('edge cases', () => {
  it('getSplit returns null for unknown project', () => {
    expect(store().getSplit('unknown')).toBeNull()
  })

  it('isSplitActive returns false for unknown project', () => {
    expect(store().isSplitActive('unknown')).toBe(false)
  })

  it('splitPane with null sessionId creates an empty pane', () => {
    store().initSinglePane(PROJECT, SESSION_A)
    store().splitPane(PROJECT, null)
    const split = store().getSplit(PROJECT)!
    const newPane = split.panes.find(p => p.sessionId === null)
    expect(newPane).toBeTruthy()
  })

  it('repeated initSinglePane overwrites previous state', () => {
    store().initSinglePane(PROJECT, SESSION_A)
    store().splitPane(PROJECT, SESSION_B)
    expect(store().getSplit(PROJECT)!.panes).toHaveLength(2)

    store().initSinglePane(PROJECT, SESSION_C)
    expect(store().getSplit(PROJECT)!.panes).toHaveLength(1)
    expect(store().getSplit(PROJECT)!.panes[0].sessionId).toBe(SESSION_C)
  })
})
