import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const SPACE = 'space-browser-active-view'

const mocks = vi.hoisted(() => ({
  setActiveKey: vi.fn(),
  syncTabOrder: vi.fn(),
  openHome: vi.fn(),
  setTabOrder: vi.fn(),
  syncItemsByType: vi.fn(),
  recallActiveSubagentForSession: vi.fn(),
  sessionsHydrated: true,
  resolution: {
    currentTabKeys: [] as string[],
    currentTabKeySet: new Set<string>(),
    contextItemByTabKey: new Map<string, unknown>(),
  },
}))

vi.mock('../useTabKeyResolution', () => ({
  useTabKeyResolution: vi.fn(() => mocks.resolution),
}))

vi.mock('@stores/chat/useChatStore', () => ({
  useChatStore: (selector: (state: { currentSessionIdBySpaceId: Record<string, string | null>; sessionsHydrated: boolean }) => unknown) =>
    selector({ currentSessionIdBySpaceId: { [SPACE]: null }, sessionsHydrated: mocks.sessionsHydrated }),
}))

vi.mock('@stores/useCrawlTabStore', () => ({
  useCrawlTabStore: (selector: (state: { _recentlyClosedViewIds: Set<string>; _coldStartPendingByCS: Record<string, boolean> }) => unknown) =>
    selector({ _recentlyClosedViewIds: new Set(), _coldStartPendingByCS: {} }),
}))

vi.mock('@stores/useTerminalSplitStore', () => ({
  useTerminalSplitStore: (selector: (state: { layouts: Record<string, never> }) => unknown) =>
    selector({ layouts: {} }),
}))

vi.mock('@stores/useSpaceContextTabsStore', () => ({
  useSpaceContextTabsStore: Object.assign(
    (selector: (state: { setTabOrder: typeof mocks.setTabOrder; syncItemsByType: typeof mocks.syncItemsByType }) => unknown) =>
      selector({ setTabOrder: mocks.setTabOrder, syncItemsByType: mocks.syncItemsByType }),
    {
      getState: () => ({
        tabOrderBySpace: {},
        recallActiveSubagentForSession: mocks.recallActiveSubagentForSession,
      }),
    },
  ),
}))

vi.mock('../../registry', () => ({
  contextRegistry: {
    getAppId: (type: string) => type,
    getHandler: () => undefined,
    parseTabKey: (tabKey: string) => {
      const separator = tabKey.indexOf(':')
      if (separator <= 0 || separator === tabKey.length - 1) return null
      return { type: tabKey.slice(0, separator), id: tabKey.slice(separator + 1) }
    },
  },
}))

vi.mock('../../registry/index', () => ({
  contextRegistry: {
    getAppId: (type: string) => type,
    getHandler: () => undefined,
    parseTabKey: (tabKey: string) => {
      const separator = tabKey.indexOf(':')
      if (separator <= 0 || separator === tabKey.length - 1) return null
      return { type: tabKey.slice(0, separator), id: tabKey.slice(separator + 1) }
    },
  },
}))

vi.mock('../../registry/instance', () => ({
  contextRegistry: {
    getAppId: (type: string) => type,
    getHandler: () => undefined,
    parseTabKey: (tabKey: string) => {
      const separator = tabKey.indexOf(':')
      if (separator <= 0 || separator === tabKey.length - 1) return null
      return { type: tabKey.slice(0, separator), id: tabKey.slice(separator + 1) }
    },
  },
}))

import { shouldFollowBrowserActiveView, useTabSync } from '../useTabSync'

type TestContextItem = Parameters<typeof useTabSync>[0]['browserSource']['items'][number]

function item(tabKey: string): TestContextItem {
  const separator = tabKey.indexOf(':')
  const type = tabKey.slice(0, separator)
  const id = tabKey.slice(separator + 1)
  return { type: type as TestContextItem['type'], id, tabKey: tabKey as TestContextItem['tabKey'] }
}

function setResolvedTabs(tabKeys: string[]) {
  mocks.resolution = {
    currentTabKeys: tabKeys,
    currentTabKeySet: new Set(tabKeys),
    contextItemByTabKey: new Map(tabKeys.map(key => [key, item(key)])),
  }
}

function makeProps(overrides: Partial<Parameters<typeof useTabSync>[0]> = {}): Parameters<typeof useTabSync>[0] {
  const browserItems = (overrides.browserSource?.items ?? []) as Parameters<typeof useTabSync>[0]['browserSource']['items']
  return {
    spaceId: SPACE,
    crawlspaceId: 'cs-1',
    activeTabKey: 'tabdata:t1',
    safeActiveTabKey: 'tabdata:t1',
    activeTabInOrder: true,
    isActiveTabData: true,
    tabOrder: ['tabdata:t1'],
    groupedTabKeys: new Set(),
    canvasGroups: [],
    isForeground: true,
    tabStoreHydrated: true,
    restoreSettled: true,
    browserSource: {
      items: browserItems,
      viewList: [],
      activeViewId: null,
    },
    tableSource: {
      items: [item('tabdata:t1')],
      openTableIds: ['t1'],
    },
    terminalSource: {
      items: [],
      sessions: [],
    },
    isAppEnabled: () => true,
    syncTabOrder: mocks.syncTabOrder,
    setActiveKey: mocks.setActiveKey,
    openHome: mocks.openHome,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.sessionsHydrated = true
  setResolvedTabs(['tabdata:t1'])
})

describe('shouldFollowBrowserActiveView', () => {
  it('仅 active 为空时做恢复兜底；已有 Browser 或资源 tab 都不由运行时 source-sync 抢焦点', () => {
    expect(shouldFollowBrowserActiveView(null)).toBe(true)
    expect(shouldFollowBrowserActiveView(undefined)).toBe(true)
    expect(shouldFollowBrowserActiveView('tabweb:view-a')).toBe(false)
    expect(shouldFollowBrowserActiveView('tabdata:t1')).toBe(false)
    expect(shouldFollowBrowserActiveView('tabdoc:d1')).toBe(false)
  })
})

describe('useTabSync browser active view sync ', () => {
  it('Agent 会话索引未水合时普通资源仍完成失效 active 回退', async () => {
    mocks.sessionsHydrated = false

    renderHook((props: Parameters<typeof useTabSync>[0]) => useTabSync(props), {
      initialProps: makeProps({
        activeTabKey: 'tabdata:missing',
        safeActiveTabKey: null,
        activeTabInOrder: false,
      }),
    })

    await waitFor(() => {
      expect(mocks.setActiveKey).toHaveBeenCalledWith(
        SPACE,
        'tabdata:t1',
        expect.objectContaining({ writer: 'fallback' }),
      )
    })
  })

  it('前景已是旧 tabweb 时，后台 activeViewId 变化不切到新 tabweb', async () => {
    setResolvedTabs(['tabweb:view-a', 'tabweb:view-b'])
    const { rerender } = renderHook((props: Parameters<typeof useTabSync>[0]) => useTabSync(props), {
      initialProps: makeProps({
        activeTabKey: 'tabweb:view-a',
        safeActiveTabKey: 'tabweb:view-a',
        isActiveTabData: false,
        tabOrder: ['tabweb:view-a', 'tabweb:view-b'],
        tableSource: { items: [], openTableIds: [] },
        browserSource: {
          items: [item('tabweb:view-a'), item('tabweb:view-b')],
          viewList: [
            { viewId: 'view-a', url: 'https://a.example/' } as never,
            { viewId: 'view-b', url: 'https://b.example/' } as never,
          ],
          activeViewId: 'view-a',
        },
      }),
    })

    rerender(makeProps({
      activeTabKey: 'tabweb:view-a',
      safeActiveTabKey: 'tabweb:view-a',
      isActiveTabData: false,
      tabOrder: ['tabweb:view-a', 'tabweb:view-b'],
      tableSource: { items: [], openTableIds: [] },
      browserSource: {
        items: [item('tabweb:view-a'), item('tabweb:view-b')],
        viewList: [
          { viewId: 'view-a', url: 'https://a.example/' } as never,
          { viewId: 'view-b', url: 'https://b.example/' } as never,
        ],
        activeViewId: 'view-b',
      },
    }))

    await waitFor(() => {
      expect(mocks.syncTabOrder).toHaveBeenCalled()
    })
    expect(mocks.setActiveKey).not.toHaveBeenCalled()
  })

  it('前景为 tabdata 时 activeViewId 变化不抢焦点', async () => {
    const { rerender } = renderHook((props: Parameters<typeof useTabSync>[0]) => useTabSync(props), {
      initialProps: makeProps(),
    })

    setResolvedTabs(['tabdata:t1', 'tabweb:view-new'])
    rerender(makeProps({
      browserSource: {
        items: [item('tabweb:view-new')],
        viewList: [{ viewId: 'view-new', url: 'https://example.com/' } as never],
        activeViewId: 'view-new',
      },
    }))

    await waitFor(() => {
      expect(mocks.syncTabOrder).toHaveBeenCalled()
    })
    expect(mocks.setActiveKey).not.toHaveBeenCalled()
  })

  it('初始恢复已有 activeViewId 时不抢当前资源 tab 焦点', async () => {
    setResolvedTabs(['tabdata:t1', 'tabweb:view-restored'])

    renderHook((props: Parameters<typeof useTabSync>[0]) => useTabSync(props), {
      initialProps: makeProps({
        browserSource: {
          items: [item('tabweb:view-restored')],
          viewList: [{ viewId: 'view-restored', url: 'https://example.com/' } as never],
          activeViewId: 'view-restored',
        },
      }),
    })

    await waitFor(() => {
      expect(mocks.syncTabOrder).toHaveBeenCalled()
    })
    expect(mocks.setActiveKey).not.toHaveBeenCalled()
  })

  it('active 为空且本是浏览器导航时，等 tabKey 可见后跟随 activeViewId', async () => {
    setResolvedTabs([])
    const { rerender } = renderHook((props: Parameters<typeof useTabSync>[0]) => useTabSync(props), {
      initialProps: makeProps({
        activeTabKey: null,
        safeActiveTabKey: null,
        isActiveTabData: false,
        tabOrder: [],
        tableSource: { items: [], openTableIds: [] },
      }),
    })

    rerender(makeProps({
      activeTabKey: null,
      safeActiveTabKey: null,
      isActiveTabData: false,
      tabOrder: [],
      tableSource: { items: [], openTableIds: [] },
      browserSource: {
        items: [],
        viewList: [{ viewId: 'view-late', url: 'https://example.com/' } as never],
        activeViewId: 'view-late',
      },
    }))
    expect(mocks.setActiveKey).not.toHaveBeenCalled()

    setResolvedTabs(['tabweb:view-late'])
    rerender(makeProps({
      activeTabKey: null,
      safeActiveTabKey: null,
      isActiveTabData: false,
      tabOrder: [],
      tableSource: { items: [], openTableIds: [] },
      browserSource: {
        items: [item('tabweb:view-late')],
        viewList: [{ viewId: 'view-late', url: 'https://example.com/' } as never],
        activeViewId: 'view-late',
      },
    }))

    await waitFor(() => {
      expect(mocks.setActiveKey).toHaveBeenCalledWith(
        SPACE,
        'tabweb:view-late',
        expect.objectContaining({
          writer: 'source_sync',
          reason: 'tabSync:browserActiveViewChanged',
        }),
      )
    })
  })
})
