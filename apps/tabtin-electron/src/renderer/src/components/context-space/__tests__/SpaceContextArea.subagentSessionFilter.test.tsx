/**
 * SpaceContextArea.subagentSessionFilter.test.tsx — PRD §7.1 / §8 Phase 5 #30 P0 集成测试
 *
 * 验证子 Agent 详情标签「三集合分离」架构端到端行为：
 *   - useTabSync：visibleTabKeys 过滤 + syncTabOrder 全量保留 + active fallback
 *   - SpaceContextArea：paneItems 仅用 visibleItems，隐藏 tab 不挂载 DOM
 */
import React, { useMemo } from 'react'
import { act, render, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import '@components/context-space/registry'
import { SpaceContextArea } from '../SpaceContextArea'
import {
  SpaceContextAreaProvider,
  type SpaceContextAreaActions,
  type SpaceContextAreaState,
} from '../SpaceContextAreaContext'
import { useActiveKeyGuard } from '../hooks/useActiveKeyGuard'
import { useTabSync } from '../hooks/useTabSync'
import type { ContextItem } from '../registry'
import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'

const SPACE = 'space-subagent-p0'
const SESSION_A = 'sess-a'
const SESSION_B = 'sess-b'
const RUN_A1 = 'run-a1'
const TABDATA_KEY = 'tabdata:visible-fallback'
const SUBAGENT_KEY = `subagent_session:${RUN_A1}`

const { chatState, viewPrefsState } = vi.hoisted(() => ({
  chatState: {
    currentSessionIdBySpaceId: {} as Record<string, string | null>,
    sessionsHydrated: true,
    getSessionById: vi.fn(),
  },
  viewPrefsState: {
    sidebarMode: 'desktop' as 'desktop' | 'conversations',
  },
}))

vi.mock('@stores/chat/useChatStore', () => ({
  useChatStore: (selector: (s: typeof chatState) => unknown) => selector(chatState),
}))

vi.mock('@stores/useCrawlTabStore', () => ({
  useCrawlTabStore: (selector: (s: {
    _recentlyClosedViewIds: Set<string>
    _coldStartPendingByCS: Record<string, boolean>
  }) => unknown) =>
    selector({
      _recentlyClosedViewIds: new Set(),
      _coldStartPendingByCS: {},
    }),
}))

vi.mock('@stores/useTerminalSplitStore', () => ({
  useTerminalSplitStore: (selector: (s: { layouts: Record<string, never> }) => unknown) =>
    selector({ layouts: {} }),
}))

vi.mock('@components/context-space/ContextTabs', () => ({
  ContextTabs: ({
    items,
    showHome,
    isHomeActive,
  }: {
    items: ContextItem[]
    showHome: boolean
    isHomeActive: boolean
  }) => (
    <div data-testid="context-tabs" data-home-active={String(isHomeActive)}>
      {showHome && <div data-tab-key="desktop_home:current">工作台</div>}
      {items.map(item => (
        <div key={item.tabKey} data-tab-key={item.tabKey}>
          {item.title}
        </div>
      ))}
    </div>
  ),
}))

vi.mock('@components/context-space/DesktopHomePane', () => ({
  DesktopHomePane: ({ variant }: { variant: string }) => (
    <div data-testid="desktop-home-pane" data-variant={variant} />
  ),
}))

vi.mock('../../chat/subagent/SubagentDetailPane', () => ({
  SubagentDetailPane: ({ subagentRunId }: { subagentRunId: string }) => (
    <div data-testid={`subagent-pane-${subagentRunId}`}>subagent-pane</div>
  ),
}))

vi.mock('@components/layout/CanvasDragLayer', () => ({
  CanvasDragLayer: () => null,
}))

vi.mock('@components/tabsite/CreateSiteDialog', () => ({
  default: () => null,
}))

vi.mock('@stores/useSpaceViewPrefsStore', () => ({
  useSpaceViewPrefsStore: (selector: (s: {
    getPrefs: (spaceId: string) => {
      sidebarTabsWidth: number
      sidebarMode: string
      resourceScope: string
    }
    setSidebarTabsWidth: ReturnType<typeof vi.fn>
    setSidebarMode: ReturnType<typeof vi.fn>
    getSidebarMode: ReturnType<typeof vi.fn>
    setSidebarModeForOrganizationUser: ReturnType<typeof vi.fn>
    pinnedAgentIds: string[]
    togglePinnedAgent: ReturnType<typeof vi.fn>
  }) => unknown) =>
    selector({
      getPrefs: () => ({
        sidebarTabsWidth: 240,
        sidebarMode: viewPrefsState.sidebarMode,
        resourceScope: 'space',
      }),
      setSidebarTabsWidth: vi.fn(),
      setSidebarMode: vi.fn(),
      getSidebarMode: vi.fn(() => viewPrefsState.sidebarMode),
      setSidebarModeForOrganizationUser: vi.fn(),
      pinnedAgentIds: [],
      togglePinnedAgent: vi.fn(),
    }),
  SIDEBAR_TABS_MIN_WIDTH: 120,
  SIDEBAR_TABS_MAX_WIDTH: 400,
  SIDEBAR_TABS_DEFAULT_WIDTH: 240,
}))

const noopActions: SpaceContextAreaActions = {
  createHandlers: {},
  onOpenAppHome: vi.fn(),
  onOpenSpaceSettings: vi.fn(),
  onTableClick: vi.fn(),
  onSelectHome: vi.fn(),
  onSelectItem: vi.fn(),
  onCloseItem: vi.fn(),
  onRefreshItem: vi.fn(),
  onCloseOtherItems: vi.fn(),
  onCloseLeftItems: vi.fn(),
  onCloseRightItems: vi.fn(),
  onCloseOthersForGroup: vi.fn(),
  onCloseLeftForGroup: vi.fn(),
  onCloseRightForGroup: vi.fn(),
  onReorderItem: vi.fn(),
  onReopenClosedTab: vi.fn(),
  onRestoreGroup: vi.fn(),
  buildContentFromActiveTab: () => null,
  buildContentFromDrag: () => null,
}

function resetTabsStore() {
  useSpaceContextTabsStore.setState({
    activeKeyBySpace: {},
    displayKeyBySpace: {},
    tabOrderBySpace: {},
    itemsBySpace: {},
  })
}

function resetChatState(sessionId: string | null = SESSION_A) {
  chatState.currentSessionIdBySpaceId = { [SPACE]: sessionId }
  chatState.sessionsHydrated = true
  chatState.getSessionById = vi.fn()
}

function openSubagentTab(runId: string, parentSessionId: string) {
  useSpaceContextTabsStore.getState().openResourceTab(SPACE, {
    type: 'subagent_session',
    id: runId,
    title: `Subagent ${runId}`,
    meta: { kind: 'subagent_session', parentSessionId },
  })
}

function openVisibleFallbackTab() {
  useSpaceContextTabsStore.getState().openResourceTab(SPACE, {
    type: 'tabdata',
    id: 'visible-fallback',
    title: 'Fallback table',
    silent: true,
  })
}

function setCurrentSession(sessionId: string | null) {
  chatState.currentSessionIdBySpaceId = { [SPACE]: sessionId }
}

function buildVisibleItems(orderedItems: ContextItem[], visibleTabKeys: readonly string[]): ContextItem[] {
  const itemsByKey = new Map<string, ContextItem>(orderedItems.map(item => [item.tabKey, item]))
  const result: ContextItem[] = []
  for (const key of visibleTabKeys) {
    const item = itemsByKey.get(key)
    if (item) result.push(item)
  }
  return result
}

const emptyBrowserSource = { items: [] as ContextItem[], viewList: [], activeViewId: null }
const emptyTableSource = { items: [] as ContextItem[], openTableIds: [] as string[] }
const emptyTerminalSource = { items: [] as ContextItem[], sessions: [] as { id: string }[] }

function useTabSyncHarness(options?: { isForeground?: boolean }) {
  const tabOrder = useSpaceContextTabsStore(s => s.tabOrderBySpace[SPACE] ?? [])
  const activeTabKey = useSpaceContextTabsStore(s => s.activeKeyBySpace[SPACE] ?? null)
  const syncTabOrder = useSpaceContextTabsStore(s => s.syncTabOrder)
  const setActiveKey = useSpaceContextTabsStore(s => s.setActiveKey)
  const openHome = vi.fn()

  const guard = useActiveKeyGuard({
    spaceId: SPACE,
    activeTabKey,
    groupedTabKeys: new Set(),
    tabOrder,
    isAppEnabled: () => true,
  })

  return useTabSync({
    spaceId: SPACE,
    crawlspaceId: null,
    activeTabKey,
    safeActiveTabKey: guard.safeActiveTabKey,
    activeTabInOrder: guard.activeTabInOrder,
    isActiveTabData: guard.isActiveTabData,
    tabOrder,
    groupedTabKeys: new Set(),
    canvasGroups: [],
    isForeground: options?.isForeground ?? true,
    tabStoreHydrated: true,
    restoreSettled: true,
    browserSource: emptyBrowserSource,
    tableSource: emptyTableSource,
    terminalSource: emptyTerminalSource,
    isAppEnabled: () => true,
    syncTabOrder: (keys, activeKey) => syncTabOrder(SPACE, keys, activeKey),
    setActiveKey: (spaceId, key) => setActiveKey(spaceId, key),
    openHome,
  })
}

function SubagentFilterHarness() {
  // DOM 用例只验证 visibleItems → paneItems 挂载，不跑 sync/fallback 副作用（避免空 visible 时 active 校正死循环）
  const tabSync = useTabSyncHarness({ isForeground: false })
  const activeTabKey = useSpaceContextTabsStore(s => s.activeKeyBySpace[SPACE] ?? null)
  const guard = useActiveKeyGuard({
    spaceId: SPACE,
    activeTabKey,
    groupedTabKeys: new Set(),
    tabOrder: useSpaceContextTabsStore(s => s.tabOrderBySpace[SPACE] ?? []),
    isAppEnabled: () => true,
  })

  const visibleItems = useMemo(
    () => buildVisibleItems(tabSync.orderedItems, tabSync.visibleTabKeys),
    [tabSync.orderedItems, tabSync.visibleTabKeys],
  )
  const tabLookupItems = useMemo(
    () => buildVisibleItems(tabSync.orderedItems, tabSync.contextVisibleTabKeys),
    [tabSync.contextVisibleTabKeys, tabSync.orderedItems],
  )

  const state = useMemo<SpaceContextAreaState>(() => ({
    spaceId: SPACE,
    activeTabKey,
    activeTabType: guard.activeTabType,
    activeTableId: guard.activeTableId,
    orderedItems: tabSync.orderedItems,
    tabLookupItems,
    visibleItems,
    groupedTabKeys: new Set(),
    canvasGroups: [],
    shouldShowCanvasGroup: false,
    activeCanvasGroupId: null,
    openTableTabs: [],
    groupedTableIds: new Set(),
    terminalSessionIds: [],
    groupedTerminalIds: new Set(),
    crawlspaceId: null,
    homeTables: [],
    isLoading: false,
    error: null,
    isCrawlspaceReady: false,
    creatingAppIds: new Set(),
  }), [
    activeTabKey,
    guard.activeTabType,
    guard.activeTableId,
    tabSync.orderedItems,
    tabLookupItems,
    visibleItems,
  ])

  return (
    <SpaceContextAreaProvider state={state} actions={noopActions}>
      <SpaceContextArea hideTabsBar />
    </SpaceContextAreaProvider>
  )
}

const desktopTabItem: ContextItem = {
  type: 'desktop_home',
  id: 'current',
  tabKey: 'desktop_home:current',
  title: '桌面',
}
const defaultDesktopTabItems = [desktopTabItem]

function TabBarVisibilityHarness({
  tabScopeKey = SPACE,
  restoreSettled = true,
  activeTabKey = desktopTabItem.tabKey,
  activeTabType = desktopTabItem.type,
  items = defaultDesktopTabItems,
  hideTabsBar = false,
}: {
  tabScopeKey?: string
  restoreSettled?: boolean
  activeTabKey?: string | null
  activeTabType?: ContextItem['type']
  items?: ContextItem[]
  hideTabsBar?: boolean
}) {
  const state = useMemo<SpaceContextAreaState>(() => ({
    spaceId: SPACE,
    tabScopeKey,
    restoreSettled,
    activeTabKey,
    activeTabType,
    activeTableId: null,
    orderedItems: items,
    tabLookupItems: items,
    visibleItems: items,
    groupedTabKeys: new Set(),
    canvasGroups: [],
    shouldShowCanvasGroup: false,
    activeCanvasGroupId: null,
    openTableTabs: [],
    groupedTableIds: new Set(),
    terminalSessionIds: [],
    groupedTerminalIds: new Set(),
    crawlspaceId: null,
    homeTables: [],
    isLoading: false,
    error: null,
    isCrawlspaceReady: true,
    creatingAppIds: new Set(),
  }), [activeTabKey, activeTabType, items, restoreSettled, tabScopeKey])

  return (
    <SpaceContextAreaProvider state={state} actions={noopActions}>
      <SpaceContextArea renderTabsOnly={!hideTabsBar} hideTabsBar={hideTabsBar} />
    </SpaceContextAreaProvider>
  )
}

async function flushTabSyncEffects() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  resetTabsStore()
  resetChatState(SESSION_A)
  viewPrefsState.sidebarMode = 'desktop'
})

afterEach(() => {
  resetTabsStore()
  vi.clearAllMocks()
})

describe('桌面虚拟标签显示规则', () => {
  it('桌面模式下画布标签栏固定显示工作台首页', () => {
    viewPrefsState.sidebarMode = 'desktop'

    const { container } = render(<TabBarVisibilityHarness />)

    expect(container.querySelector('[data-tab-key="desktop_home:current"]')).toBeTruthy()
  })

  it('应用主页和具体资源都作为独立横向标签展示', () => {
    viewPrefsState.sidebarMode = 'desktop'
    const appHomeItem: ContextItem = {
      type: 'apphome',
      id: 'tabdata',
      tabKey: 'apphome:tabdata',
      title: '多维表',
    }
    const tableItem: ContextItem = {
      type: 'tabdata',
      id: 'table-1',
      tabKey: 'tabdata:table-1',
      title: '项目库',
    }
    const documentItem: ContextItem = {
      type: 'tabdoc',
      id: 'document-1',
      tabKey: 'tabdoc:document-1',
      title: '项目说明',
    }

    const { container, getByTestId } = render(
      <TabBarVisibilityHarness
        activeTabKey={appHomeItem.tabKey}
        activeTabType="apphome"
        items={[desktopTabItem, appHomeItem, tableItem, documentItem]}
      />,
    )

    expect(getByTestId('context-tabs').getAttribute('data-home-active')).toBe('false')
    expect(container.querySelector('[data-tab-key="apphome:tabdata"]')).toBeTruthy()
    expect(container.querySelector('[data-tab-key="tabdata:table-1"]')).toBeTruthy()
    expect(container.querySelector('[data-tab-key="tabdoc:document-1"]')).toBeTruthy()
  })

  it('对话模式标签栏钉任务工作台首页', () => {
    viewPrefsState.sidebarMode = 'conversations'

    const { container } = render(<TabBarVisibilityHarness />)

    expect(container.querySelector('[data-tab-key="desktop_home:current"]')).toBeTruthy()
  })

  it('IM 会话不显示任务工作台首页', () => {
    viewPrefsState.sidebarMode = 'conversations'

    const { container } = render(<TabBarVisibilityHarness tabScopeKey="im:conversation-1" />)

    expect(container.querySelector('[data-tab-key="desktop_home:current"]')).toBeNull()
  })

  it('普通对话空画布回退任务工作台，IM 会话不回退', async () => {
    viewPrefsState.sidebarMode = 'conversations'
    const ordinary = render(
      <TabBarVisibilityHarness
        activeTabKey={null}
        activeTabType="home"
        hideTabsBar
      />,
    )

    expect((await ordinary.findByTestId('desktop-home-pane')).getAttribute('data-variant'))
      .toBe('task-workbench')
    ordinary.unmount()

    // Task 3：conversation scope + 无真实标签时，画布列同样落到工作台（非空指）
    const conversationScope = render(
      <TabBarVisibilityHarness
        tabScopeKey="conversation:s1"
        activeTabKey={null}
        activeTabType="home"
        items={[]}
        hideTabsBar
      />,
    )
    expect((await conversationScope.findByTestId('desktop-home-pane')).getAttribute('data-variant'))
      .toBe('task-workbench')
    conversationScope.unmount()

    const im = render(
      <TabBarVisibilityHarness
        tabScopeKey="im:conversation-1"
        activeTabKey={null}
        activeTabType="home"
        hideTabsBar
      />,
    )

    expect(im.queryByTestId('desktop-home-pane')).toBeNull()
  })

  it('用户显式打开工作台时不等待浏览器冷启动恢复完成', async () => {
    viewPrefsState.sidebarMode = 'conversations'
    const scopeKey = 'conversation:pending-browser-restore'
    const documentItem: ContextItem = {
      type: 'tabdoc',
      id: 'document-before-home',
      tabKey: 'tabdoc:document-before-home',
      title: '恢复前文档',
    }
    act(() => {
      useSpaceContextTabsStore.getState().openResourceTab(scopeKey, {
        type: documentItem.type,
        id: documentItem.id,
        title: documentItem.title,
      })
    })
    const view = render(
      <TabBarVisibilityHarness
        tabScopeKey={scopeKey}
        restoreSettled={false}
        activeTabKey={documentItem.tabKey}
        activeTabType="tabdoc"
        items={[documentItem]}
        hideTabsBar
      />,
    )

    expect(view.queryByTestId('desktop-home-pane')).toBeNull()

    act(() => {
      useSpaceContextTabsStore.getState().setActiveKey(scopeKey, null, {
        writer: 'user',
        reason: 'openHome',
      })
    })
    view.rerender(
      <TabBarVisibilityHarness
        tabScopeKey={scopeKey}
        restoreSettled={false}
        activeTabKey={null}
        activeTabType="home"
        items={[documentItem]}
        hideTabsBar
      />,
    )

    expect((await view.findByTestId('desktop-home-pane')).getAttribute('data-variant'))
      .toBe('task-workbench')

    act(() => {
      useSpaceContextTabsStore.getState().clearSpaceTabs(scopeKey)
    })
  })
})

describe('PRD §7.1 P0-A：session 切换隔离（DOM + visibleTabKeys）', () => {
  it('session A 可见子 Agent Pane；切到 B 后 DOM 移除；切回 A 恢复', async () => {
    openSubagentTab(RUN_A1, SESSION_A)
    expect(useSpaceContextTabsStore.getState().activeKeyBySpace[SPACE]).toBe(SUBAGENT_KEY)

    const { rerender, queryByTestId, unmount } = render(<SubagentFilterHarness />)
    await flushTabSyncEffects()

    expect(queryByTestId(`subagent-pane-${RUN_A1}`)).not.toBeNull()

    setCurrentSession(SESSION_B)
    rerender(<SubagentFilterHarness />)
    await flushTabSyncEffects()

    await waitFor(() => {
      expect(queryByTestId(`subagent-pane-${RUN_A1}`)).toBeNull()
    })

    setCurrentSession(SESSION_A)
    act(() => {
      useSpaceContextTabsStore.getState().setActiveKey(SPACE, SUBAGENT_KEY)
    })
    rerender(<SubagentFilterHarness />)
    await flushTabSyncEffects()

    await waitFor(() => {
      expect(queryByTestId(`subagent-pane-${RUN_A1}`)).not.toBeNull()
    })

    unmount()
  })

  it('切 session 时 visibleTabKeys 过滤，currentTabKeys 仍含隐藏 tab', async () => {
    openSubagentTab(RUN_A1, SESSION_A)

    const { result, rerender, unmount } = renderHook(() => useTabSyncHarness())
    await flushTabSyncEffects()

    expect(result.current.currentTabKeys).toContain(SUBAGENT_KEY)
    expect(result.current.visibleTabKeys).toContain(SUBAGENT_KEY)

    setCurrentSession(SESSION_B)
    rerender()
    await flushTabSyncEffects()

    expect(result.current.currentTabKeys).toContain(SUBAGENT_KEY)
    expect(result.current.visibleTabKeys).not.toContain(SUBAGENT_KEY)
    unmount()
  })
})

describe('PRD §7.1 P0-A 进阶：syncTabOrder 不物理删除隐藏 tab', () => {
  it('A → B → A 后 tabOrder 长度不变', async () => {
    openVisibleFallbackTab()
    openSubagentTab(RUN_A1, SESSION_A)

    const { rerender, unmount } = renderHook(() => useTabSyncHarness())
    await flushTabSyncEffects()

    const lengthOnA = useSpaceContextTabsStore.getState().tabOrderBySpace[SPACE]?.length ?? 0
    expect(lengthOnA).toBeGreaterThanOrEqual(2)

    setCurrentSession(SESSION_B)
    rerender()
    await flushTabSyncEffects()

    const lengthOnB = useSpaceContextTabsStore.getState().tabOrderBySpace[SPACE]?.length ?? 0
    expect(lengthOnB).toBe(lengthOnA)

    setCurrentSession(SESSION_A)
    rerender()
    await flushTabSyncEffects()

    const lengthBackOnA = useSpaceContextTabsStore.getState().tabOrderBySpace[SPACE]?.length ?? 0
    expect(lengthBackOnA).toBe(lengthOnA)
    expect(useSpaceContextTabsStore.getState().tabOrderBySpace[SPACE]).toContain(SUBAGENT_KEY)
    unmount()
  })
})

describe('PRD §7.1 P0-B：active 落在隐藏 subagent 时自动 fallback', () => {
  it('active 为 session A 的 subagent，切到 B 后 fallback 到可见 tab', async () => {
    openVisibleFallbackTab()
    openSubagentTab(RUN_A1, SESSION_A)

    const { rerender, unmount } = renderHook(() => useTabSyncHarness())
    await flushTabSyncEffects()
    expect(useSpaceContextTabsStore.getState().activeKeyBySpace[SPACE]).toBe(SUBAGENT_KEY)

    setCurrentSession(SESSION_B)
    rerender()
    await flushTabSyncEffects()

    await waitFor(() => {
      const active = useSpaceContextTabsStore.getState().activeKeyBySpace[SPACE]
      expect(active).toBe(TABDATA_KEY)
      expect(active).not.toBe(SUBAGENT_KEY)
    })
    unmount()
  })

  it('仅 subagent tab 时切走 session，active 不再指向隐藏的 subagent key', async () => {
    openSubagentTab(RUN_A1, SESSION_A)

    const { rerender, unmount } = renderHook(() => useTabSyncHarness())
    await flushTabSyncEffects()

    setCurrentSession(SESSION_B)
    rerender()
    await flushTabSyncEffects()

    await waitFor(() => {
      expect(useSpaceContextTabsStore.getState().activeKeyBySpace[SPACE]).not.toBe(SUBAGENT_KEY)
    })
    unmount()
  })
})

describe('PRD v3.1 P2-13：切回 session 时 active 自动 recall 回上次激活的 subagent', () => {
  it('A 看 subagent → 切 B（active fallback 到 tabdata）→ 切回 A（active 自动 recall 回 subagent）', async () => {
    openVisibleFallbackTab()
    openSubagentTab(RUN_A1, SESSION_A)

    const { rerender, unmount } = renderHook(() => useTabSyncHarness())
    await flushTabSyncEffects()

    // 起点：session A，active=subagent_session:run-a1
    expect(useSpaceContextTabsStore.getState().activeKeyBySpace[SPACE]).toBe(SUBAGENT_KEY)
    // setActiveKey 应该已经把 lastActiveSubagent 写入 map
    expect(useSpaceContextTabsStore.getState().lastActiveSubagentByParentSession[SESSION_A]).toBe(RUN_A1)

    // 切到 session B：subagent 被 isVisibleInContext 隐藏，fallback 到 tabdata
    setCurrentSession(SESSION_B)
    rerender()
    await flushTabSyncEffects()
    await waitFor(() => {
      expect(useSpaceContextTabsStore.getState().activeKeyBySpace[SPACE]).toBe(TABDATA_KEY)
    })

    // 切回 session A：useTabSync 的 stale guard effect 在 fallback 之前先调
    // recallActiveSubagentForSession，把 active 切回 SUBAGENT_KEY
    setCurrentSession(SESSION_A)
    rerender()
    await flushTabSyncEffects()
    await waitFor(() => {
      expect(useSpaceContextTabsStore.getState().activeKeyBySpace[SPACE]).toBe(SUBAGENT_KEY)
    })
    unmount()
  })

  it('用户在 session B 手动切 active 到 tabdata 后，切回 A 不影响 recall（recall 只依赖 session A 自己的记录）', async () => {
    openVisibleFallbackTab()
    openSubagentTab(RUN_A1, SESSION_A)

    const { rerender, unmount } = renderHook(() => useTabSyncHarness())
    await flushTabSyncEffects()

    setCurrentSession(SESSION_B)
    rerender()
    await flushTabSyncEffects()

    // session B 期间用户主动切到 tabdata（非 subagent，不污染 lastActiveSubagentByParentSession[SESSION_A]）
    act(() => {
      useSpaceContextTabsStore.getState().setActiveKey(SPACE, TABDATA_KEY)
    })
    await flushTabSyncEffects()
    expect(useSpaceContextTabsStore.getState().lastActiveSubagentByParentSession[SESSION_A]).toBe(RUN_A1)

    setCurrentSession(SESSION_A)
    rerender()
    await flushTabSyncEffects()
    await waitFor(() => {
      expect(useSpaceContextTabsStore.getState().activeKeyBySpace[SPACE]).toBe(SUBAGENT_KEY)
    })
    unmount()
  })

  it('用户在 session A 手动 × 关闭原 subagent 后，再切走切回不会 recall（tabKey 已不在 visibleTabKeys）', async () => {
    openVisibleFallbackTab()
    openSubagentTab(RUN_A1, SESSION_A)

    const { rerender, unmount } = renderHook(() => useTabSyncHarness())
    await flushTabSyncEffects()

    // 用户在 A 关掉 subagent tab
    act(() => {
      useSpaceContextTabsStore.getState().closeTab(SPACE, SUBAGENT_KEY)
    })
    await flushTabSyncEffects()
    // active 已 fallback 到 tabdata
    expect(useSpaceContextTabsStore.getState().activeKeyBySpace[SPACE]).toBe(TABDATA_KEY)

    setCurrentSession(SESSION_B)
    rerender()
    await flushTabSyncEffects()

    setCurrentSession(SESSION_A)
    rerender()
    await flushTabSyncEffects()
    // recall 应失败（tabKey 不在 visibleTabKeys），active 仍是 tabdata
    expect(useSpaceContextTabsStore.getState().activeKeyBySpace[SPACE]).toBe(TABDATA_KEY)
    unmount()
  })

  it('clearOrphanSubagentTabs 同步清掉 lastActiveSubagentByParentSession 对应条目', () => {
    openSubagentTab(RUN_A1, SESSION_A)
    expect(useSpaceContextTabsStore.getState().lastActiveSubagentByParentSession[SESSION_A]).toBe(RUN_A1)

    act(() => {
      useSpaceContextTabsStore.getState().clearOrphanSubagentTabs(SPACE, SESSION_A)
    })

    expect(useSpaceContextTabsStore.getState().lastActiveSubagentByParentSession[SESSION_A]).toBeUndefined()
  })
})

describe('PRD §7.1 null session 兜底', () => {
  it('currentSessionId=null 时 subagent 隐藏且 tabOrder 不变', async () => {
    openVisibleFallbackTab()
    openSubagentTab(RUN_A1, SESSION_A)

    const { result, rerender, unmount } = renderHook(() => useTabSyncHarness({ isForeground: false }))
    await flushTabSyncEffects()
    const orderBefore = [...(useSpaceContextTabsStore.getState().tabOrderBySpace[SPACE] ?? [])]

    setCurrentSession(null)
    rerender()
    await flushTabSyncEffects()

    expect(result.current.visibleTabKeys).not.toContain(SUBAGENT_KEY)
    expect(result.current.currentTabKeys).toContain(SUBAGENT_KEY)
    expect(useSpaceContextTabsStore.getState().tabOrderBySpace[SPACE]).toEqual(orderBefore)
    unmount()
  })

  it('currentSessionId=null 时子 Agent Pane 不在 DOM', async () => {
    openSubagentTab(RUN_A1, SESSION_A)

    const { rerender, queryByTestId, unmount } = render(<SubagentFilterHarness />)
    await flushTabSyncEffects()
    expect(queryByTestId(`subagent-pane-${RUN_A1}`)).not.toBeNull()

    setCurrentSession(null)
    rerender(<SubagentFilterHarness />)
    await flushTabSyncEffects()

    await waitFor(() => {
      expect(queryByTestId(`subagent-pane-${RUN_A1}`)).toBeNull()
    })
    unmount()
  })
})

describe('PRD §7.1 sessionsHydrated=false 冷启动保护', () => {
  it('未 hydrate 时不因 null session 立刻 fallback active', async () => {
    openVisibleFallbackTab()
    openSubagentTab(RUN_A1, SESSION_A)

    chatState.sessionsHydrated = false
    chatState.currentSessionIdBySpaceId = { [SPACE]: null }

    const { rerender, unmount } = renderHook(() => useTabSyncHarness())
    await flushTabSyncEffects()

    expect(useSpaceContextTabsStore.getState().activeKeyBySpace[SPACE]).toBe(SUBAGENT_KEY)

    chatState.sessionsHydrated = true
    chatState.currentSessionIdBySpaceId = { [SPACE]: SESSION_A }
    rerender()
    await flushTabSyncEffects()

    expect(useSpaceContextTabsStore.getState().activeKeyBySpace[SPACE]).toBe(SUBAGENT_KEY)
    expect(useSpaceContextTabsStore.getState().tabOrderBySpace[SPACE]).toContain(SUBAGENT_KEY)
    unmount()
  })
})
