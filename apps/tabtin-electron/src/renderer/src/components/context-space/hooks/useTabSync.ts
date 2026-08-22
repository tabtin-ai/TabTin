import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { contextRegistry } from '../registry/instance'
import type { ContextItem, ContextTabKey } from '../registry/types'
import type { CanvasLayoutGroup } from '@stores/useCanvasLayoutStore'
import { useChatStore } from '@stores/chat/useChatStore'
import { useCrawlTabStore, type CrawlspaceViewInfo } from '@stores/useCrawlTabStore'
import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'
import { useTerminalSplitStore } from '@stores/useTerminalSplitStore'
import { useTabKeyResolution } from './useTabKeyResolution'
import { isIsolatedScopeKey } from '@/components/layout/workspaceContextState'
import { traceTabRestore } from '@/utils/tabRestoreTrace'
import { deriveContextVisibleCanvasGroups } from '../utils/contextVisibleCanvasGroups'
import { requiresChatSessionIndex } from '../restore/policies'
import { createLogger } from '@/utils/logger'

const log = createLogger('TabSync')

const shouldDebugTabSync =
  typeof globalThis !== 'undefined' && Boolean((globalThis as Record<string, unknown>).__TABTIN_DEBUG_TAB_SWITCH__)

/**
 * crawlspace activeViewId 变化时，是否应跟随切 Space 顶部 activeKey。
 *
 * 仅工作台尚无 active 时做恢复兜底。已有 active（包括旧 Browser tab）时，
 * 运行时目标变化不等于用户选择变化，不能据此抢焦点。
 * 主动开网页、点击 Browser tab 和显式 Agent 切换均由各自入口 setActiveKey。
 */
export function shouldFollowBrowserActiveView(activeTabKey: string | null | undefined): boolean {
  return !activeTabKey
}

/**
 * 按视觉 slot 重排底层 tabOrder。
 *
 * Canvas group 在顶部只占一个槽位，但底层仍保存多个 tabKey。拖动组标签时必须把
 * 组内成员作为连续块移动；普通标签落到组标签前后时，也必须以整个组为边界。
 */
export function reorderTabOrderBySlot(
  tabOrder: readonly string[],
  canvasGroups: readonly CanvasLayoutGroup[],
  draggedTabKey: string,
  targetTabKey: string,
  position: 'before' | 'after',
): string[] | null {
  if (draggedTabKey === targetTabKey) return null

  const findGroup = (tabKey: string) =>
    canvasGroups.find(group =>
      group.panes.some(pane => pane.content?.tabKey === tabKey),
    )
  const draggedGroup = findGroup(draggedTabKey)
  const targetGroup = findGroup(targetTabKey)
  if (draggedGroup && targetGroup?.id === draggedGroup.id) return null

  const orderedKeysFor = (group: CanvasLayoutGroup | undefined, fallback: string) => {
    if (!group) return tabOrder.includes(fallback) ? [fallback] : []
    const members = new Set<string>()
    group.panes.forEach(pane => {
      if (pane.content?.tabKey) members.add(pane.content.tabKey)
    })
    return tabOrder.filter(key => members.has(key))
  }

  const draggedKeys = orderedKeysFor(draggedGroup, draggedTabKey)
  const targetKeys = orderedKeysFor(targetGroup, targetTabKey)
  if (draggedKeys.length === 0 || targetKeys.length === 0) return null

  const draggedSet = new Set(draggedKeys)
  const next = tabOrder.filter(key => !draggedSet.has(key))
  const targetIndexes = targetKeys
    .map(key => next.indexOf(key))
    .filter(index => index >= 0)
  if (targetIndexes.length === 0) return null

  const insertIndex = position === 'before'
    ? Math.min(...targetIndexes)
    : Math.max(...targetIndexes) + 1
  next.splice(insertIndex, 0, ...draggedKeys)
  if (next.length === tabOrder.length && next.every((key, index) => key === tabOrder[index])) {
    return null
  }
  return next
}

interface TabSyncParams {
  spaceId: string
  tabScopeKey?: string
  crawlspaceId?: string | null
  activeTabKey: string | null
  safeActiveTabKey: string | null
  activeTabInOrder: boolean
  isActiveTabData: boolean
  tabOrder: string[]
  groupedTabKeys: Set<string>
  canvasGroups: CanvasLayoutGroup[]
  isForeground: boolean
  tabStoreHydrated: boolean
  restoreSettled: boolean
  browserSource: { items: ContextItem[]; viewList: CrawlspaceViewInfo[]; activeViewId: string | null }
  tableSource: { items: ContextItem[]; openTableIds: string[] }
  terminalSource: { items: ContextItem[]; sessions: { id: string }[] }
  isAppEnabled: (appId?: string) => boolean
  syncTabOrder: (tabKeys: string[], activeKey?: string | null) => void
  setActiveKey: (
    spaceId: string,
    key: string | null,
    options?: { writer?: 'user' | 'async_completion' | 'restore' | 'source_sync' | 'fallback' | 'self_heal'; reason?: string },
  ) => void
  openHome: () => void
}

interface TabSyncResult {
  currentTabKeys: ContextTabKey[]
  currentTabKeySet: Set<ContextTabKey>
  contextItemByTabKey: Map<string, ContextItem>
  orderedItems: ContextItem[]
  filteredOpenTableIds: string[]
  filteredTerminalSessionIds: string[]
  contextVisibleTabKeys: ContextTabKey[]
  visibleTabKeys: ContextTabKey[]
  handleReorderItem: (dragged: ContextItem, target: ContextItem, position: 'before' | 'after') => void
}

/**
 * 标签同步核心 hook：
 * - 收集各数据源的 items，计算 currentTabKeys / orderedItems
 * - 管理水合保护、冷启动保护、browserSourceReady 等防护机制
 * - 执行 syncTabOrder / syncItemsByType 等同步副作用
 * - 包含 activeKey 守卫副作用（失效回退 / fallback to home）
 */
export function useTabSync({
  spaceId, tabScopeKey, crawlspaceId,
  activeTabKey, safeActiveTabKey,
  activeTabInOrder, isActiveTabData,
  tabOrder, groupedTabKeys, canvasGroups,
  isForeground, tabStoreHydrated, restoreSettled,
  browserSource, tableSource, terminalSource,
  isAppEnabled, syncTabOrder, setActiveKey, openHome,
}: TabSyncParams): TabSyncResult {
  const storageKey = tabScopeKey ?? spaceId
  const isIsolatedScope = isIsolatedScopeKey(storageKey)
  const setTabOrder = useSpaceContextTabsStore(state => state.setTabOrder)
  const recentlyClosedViewIds = useCrawlTabStore(state => state._recentlyClosedViewIds)

  // ── Browser source ready tracking (cold-start protection) ──
  const browserSourceEverLoadedRef = useRef(false)
  const prevCrawlspaceIdRef = useRef(crawlspaceId)
  const browserSourceHasItems = browserSource.items.length > 0
  useEffect(() => {
    if (prevCrawlspaceIdRef.current !== crawlspaceId) {
      browserSourceEverLoadedRef.current = false
      prevCrawlspaceIdRef.current = crawlspaceId
    }
  }, [crawlspaceId])
  useEffect(() => {
    if (browserSourceHasItems && !browserSourceEverLoadedRef.current) {
      browserSourceEverLoadedRef.current = true
    }
  }, [browserSourceHasItems])
  const browserSourceReady = browserSourceEverLoadedRef.current || browserSourceHasItems

  const coldStartPending = useCrawlTabStore(state =>
    crawlspaceId ? Boolean(state._coldStartPendingByCS[crawlspaceId]) : false
  )

  // ── Terminal session IDs ──
  const terminalSessionIds = useMemo(
    () => terminalSource.sessions.map(session => session.id),
    [terminalSource.sessions]
  )

  // ── Split sub-pane session IDs (excluded from tabs) ──
  // 用 useShallow 派生 sorted array：任何无关 split 操作（不影响 sub-pane 集合）
  // 都不再触发 useTabSync rerender（hot-spaces 模式下别的 Space 拖动 split 不影响本 Space）。
  // splitLayouts 跨 Space 共享，但 sub-pane sessionId 全局唯一，扫一遍开销低；输出 sorted
  // array 让 shallow equality 在内容不变时抑制 rerender。
  const splitSubPaneSessionIdsArr = useTerminalSplitStore(
    useShallow(state => {
      const ids: string[] = []
      for (const layout of Object.values(state.layouts)) {
        for (const pane of Object.values(layout.panes)) {
          if (pane.sessionId && pane.sessionId !== layout.rootSessionId) {
            ids.push(pane.sessionId)
          }
        }
      }
      return ids.sort()
    }),
  )
  const splitSubPaneSessionIds = useMemo(
    () => new Set(splitSubPaneSessionIdsArr),
    [splitSubPaneSessionIdsArr],
  )

  // ── Closing view IDs ──
  const closingViewIdSet = useMemo(() => {
    const ids = new Set<string>()
    browserSource.viewList.forEach(view => {
      if (view.isClosing) ids.add(view.viewId)
    })
    return ids
  }, [browserSource.viewList])

  // ── All source items + context items ──
  const allSourceItems = useMemo(() => [
    tableSource.items,
    browserSource.items,
    terminalSource.items,
  ], [
    tableSource.items,
    browserSource.items,
    terminalSource.items,
  ])

  const contextItems = useMemo<ContextItem[]>(() => {
    const map = new Map<string, ContextItem>()
    const shouldInclude = (item: ContextItem) => {
      const appId = contextRegistry.getAppId(item.type)
      return isAppEnabled(appId)
    }
    for (const sourceItems of allSourceItems) {
      for (const item of sourceItems) {
        if (shouldInclude(item)) map.set(item.tabKey, item)
      }
    }
    return Array.from(map.values())
  }, [allSourceItems, isAppEnabled])

  const contextItemKeys = useMemo<ContextTabKey[]>(() => {
    return contextItems.map(item => item.tabKey).sort() as ContextTabKey[]
  }, [contextItems])

  // ── View info by ID ──
  const viewInfoById = useMemo(() => {
    const map = new Map<string, CrawlspaceViewInfo>()
    browserSource.viewList.forEach(view => {
      map.set(view.viewId, view)
    })
    return map
  }, [browserSource.viewList])

  // ── Tab key resolution ──
  const { currentTabKeySet, currentTabKeys, contextItemByTabKey } = useTabKeyResolution({
    spaceId,
    tabScopeKey: storageKey,
    crawlspaceId,
    tabOrder,
    isIsolatedScope,
    contextItemKeys,
    contextItems,
    groupedTabKeys,
    safeActiveTabKey,
    browserSourceReady,
    coldStartPending,
    closingViewIdSet,
    recentlyClosedViewIds,
    splitSubPaneSessionIds,
    isAppEnabled,
    viewInfoById,
  })

  /**
   * Fallback tab key selection（PRD §4.4 P0-B 单一来源）。
   *
   * **重要**：参数 `keys` 必须传 `visibleTabKeys`（已过滤）而**不是** `currentTabKeys`
   * （全量）——否则 fallback 可能选到隐藏的 subagent_session（属于别 chat session），
   * 用户切 session 后会看到"切到一个看不见的 tab"的死状态。
   *
   * 不闭包绑定列表：让 effect 显式传入 `visibleTabKeys`，避免与 callback 派生顺序耦合。
   */
  const pickFallbackTabKey = useCallback((keys: string[]) => {
    if (keys.length === 0) return null
    if (!activeTabKey) {
      return keys[keys.length - 1] ?? null
    }
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const candidate = keys[index]
      if (candidate !== activeTabKey) return candidate
    }
    return null
  }, [activeTabKey])

  // ── Cold-start sync guard（按 storageKey 生命周期；结构裁决在 store.syncTabOrder）──
  const hasSyncedItemsRef = useRef(false)
  const prevStorageKeyRef = useRef(storageKey)
  useEffect(() => {
    if (prevStorageKeyRef.current !== storageKey) {
      prevStorageKeyRef.current = storageKey
      hasSyncedItemsRef.current = false
      traceTabRestore('tabSync:scopeReset', { spaceId, storageKey })
    }
  }, [spaceId, storageKey])
  useEffect(() => {
    if (currentTabKeys.length > 0) {
      hasSyncedItemsRef.current = true
    }
  }, [currentTabKeys])

  // ── Main sync effect ──
  useEffect(() => {
    if (!isForeground) return
    if (!tabStoreHydrated) {
      traceTabRestore('tabSync:skip:notHydrated', { spaceId, tabOrder })
      if (shouldDebugTabSync) {
        log.debug('syncTabOrder skipped: store not hydrated', { spaceId })
      }
      return
    }
    if (!restoreSettled) {
      traceTabRestore('tabSync:skip:restorePending', { spaceId, tabOrder })
      return
    }
    const currentOrder = useSpaceContextTabsStore.getState().tabOrderBySpace[storageKey] ?? []
    if (!hasSyncedItemsRef.current && currentTabKeys.length === 0 && currentOrder.length > 0) {
      traceTabRestore('tabSync:skip:coldStartGuard', {
        spaceId,
        storageKey,
        currentOrder,
        currentTabKeys,
        browserSourceReady,
        coldStartPending,
      })
      if (shouldDebugTabSync) {
        log.debug('syncTabOrder cold-start guard active', {
          spaceId,
          currentOrderCount: currentOrder.length,
          currentTabKeysCount: currentTabKeys.length,
        })
      }
      return
    }
    traceTabRestore('tabSync:syncTabOrder', {
      spaceId,
      storageKey,
      activeTabKey,
      safeActiveTabKey,
      currentTabKeys,
      tabOrder,
      browserSourceReady,
      coldStartPending,
      browserItems: browserSource.items.map(item => item.tabKey),
      tableItems: tableSource.items.map(item => item.tabKey),
      terminalItems: terminalSource.items.map(item => item.tabKey),
      groupedTabKeys: Array.from(groupedTabKeys),
    })
    if (shouldDebugTabSync) {
      const browserKeysInCurrent = currentTabKeys.filter(k => contextRegistry.parseTabKey(k)?.type === 'tabweb')
      if (browserKeysInCurrent.length > 0) {
        log.debug('syncTabOrder executed', {
          spaceId,
          browserKeysInCurrent,
          browserSourceReady,
        })
      }
    }
    log.debug('syncTabOrder()', {
      spaceId: spaceId.slice(0, 8),
      tabsLen: currentTabKeys.length,
      activeKey: safeActiveTabKey,
    })
    syncTabOrder(currentTabKeys, safeActiveTabKey)
  // browserSourceReady 已通过 currentTabKeySet → currentTabKeys 传递变化，无需重复放入依赖
  }, [
    activeTabKey,
    isForeground,
    browserSource.items,
    browserSourceReady,
    coldStartPending,
    currentTabKeys,
    groupedTabKeys,
    safeActiveTabKey,
    syncTabOrder,
    tabOrder,
    tableSource.items,
    restoreSettled,
    tabStoreHydrated,
    terminalSource.items,
    spaceId,
    storageKey,
  ])

  // ── Cold-start timeout fallback ──
  useEffect(() => {
    if (!isForeground || !coldStartPending || !crawlspaceId) return
    const timer = setTimeout(() => {
      log.warn('cold-start timeout, force-clearing coldStartPending', { crawlspaceId })
      traceTabRestore('tabSync:coldStartTimeout', { crawlspaceId })
      useCrawlTabStore.getState().markColdStartComplete(crawlspaceId)
    }, 15_000)
    return () => clearTimeout(timer)
  }, [isForeground, coldStartPending, crawlspaceId])

  // ── Sync browser items to persisted store ──
  const syncItemsByType = useSpaceContextTabsStore(state => state.syncItemsByType)
  const browserItemsForScope = useMemo(() => {
    if (!isIsolatedScope) return browserSource.items
    const explicitKeys = new Set<string>(tabOrder)
    if (activeTabKey) explicitKeys.add(activeTabKey)
    groupedTabKeys.forEach(key => explicitKeys.add(key))
    return browserSource.items.filter(item => explicitKeys.has(item.tabKey))
  }, [activeTabKey, browserSource.items, groupedTabKeys, isIsolatedScope, tabOrder])
  useEffect(() => {
    if (!isForeground) return
    if (!restoreSettled) {
      traceTabRestore('tabSync:skipSyncBrowserItems:restorePending', {
        spaceId,
        keys: browserItemsForScope.map(item => item.tabKey),
      })
      return
    }
    log.debug('syncItemsByType(tabweb)', {
      spaceId: spaceId.slice(0, 8),
      itemsLen: browserItemsForScope.length,
      keys: browserItemsForScope.map(item => item.tabKey).slice(0, 10),
    })
    traceTabRestore('tabSync:syncBrowserItems', {
      spaceId,
      keys: browserItemsForScope.map(item => item.tabKey),
      viewIds: browserSource.viewList.map(view => view.viewId),
      activeViewId: browserSource.activeViewId,
    })
    syncItemsByType(storageKey, 'tabweb', browserItemsForScope)
  }, [isForeground, browserSource.activeViewId, browserItemsForScope, browserSource.viewList, restoreSettled, spaceId, storageKey, syncItemsByType])

  // ── Cold-start 守卫：在 crawlspace view 还没从 seeds 恢复完成前，
  //    不要让 fallback / stale-guard effect 改 active tab key。
  //    否则会破坏"重启后自动恢复到持久化的 active tab"的预期行为
  //    （bug: 重启后 active 被错误地切到 fallback tab 或 home，画布出现幽灵态）。
  //
  // 触发条件（任一即视为 cold-start 进行中，跳过 active 修正）：
  //   1. coldStartPending: useCrawlTabStore 派生的 cold-start 标志（有 seeds 待恢复）
  //   2. browserSource 还没 ready 但 tabOrder 里有 tabweb tab：这是经典 race —
  //      tabOrder 已水合（包含历史 tabweb tabKey），但 main 进程的 view list 还没回来
  //
  // 退出时机：seedManager.markRestored / markColdStartComplete 触发 → coldStartPending=false；
  //         或 main 进程推完第一批 view list → browserSourceReady=true。
  const tabOrderHasTabwebKey = useMemo(
    () => tabOrder.some(key => key.startsWith('tabweb:')),
    [tabOrder],
  )
  const isColdStartInProgress =
    coldStartPending ||
    (!browserSourceReady && Boolean(crawlspaceId) && tabOrderHasTabwebKey)

  /**
   * Electron 全局当前 chat session ID。
   *
   * 用途（PRD §4.3 三集合分离）：传给 handler.isVisibleInContext，让
   * subagent_session 这类「按当前 chat session 过滤」的 tab 在切 session 时
   * 隐藏（不删，仍在 tabOrder 里）。
   */
  const currentSessionId = useChatStore(s => s.currentSessionId)

  /**
   * P0-B 水合时序保护（PRD §4.4 / 红线 #11）：当前 scope 存在子 Agent 标签且
   * chat sessions 还没 hydrate 完成时，
   * `currentSessionId` 可能瞬时为 null，导致所有 subagent_session 全部被 isVisibleInContext
   * 过滤掉、`visibleTabKeys` 暂时为空。此时**保留 active 不动**，等 hydrate 完成后再
   * reconcile（避免初始化窗口期 fallback 到 home 后又跳回的视觉抖动）。
   */
  const sessionsHydrated = useChatStore(s => s.sessionsHydrated)
  const chatSessionIndexReady = sessionsHydrated
    || !requiresChatSessionIndex(contextItemByTabKey.values())

  /**
   * 通过当前上下文可见性过滤、但尚未按 canvas group 折叠的 tab key 列表。
   *
   * 用途：GroupTab 的 lookup 需要找回 grouped pane 对应的 item；但不能从
   * currentTabKeys 全量补，否则会把跨 session 隐藏的 subagent_session 重新暴露。
   */
  const contextVisibleTabKeys = useMemo(() => {
    const ctx = { spaceId, currentSessionId }
    return currentTabKeys.filter(key => {
      const item = contextItemByTabKey.get(key)
      if (!item) return true
      const handler = contextRegistry.getHandler(item.type)
      if (!handler?.isVisibleInContext) return true
      return handler.isVisibleInContext(item, ctx)
    })
  }, [currentTabKeys, contextItemByTabKey, currentSessionId, spaceId])

  const effectiveGroupedTabKeys = useMemo(() => {
    return deriveContextVisibleCanvasGroups(canvasGroups, contextVisibleTabKeys).visibleGroupedTabKeys
  }, [canvasGroups, contextVisibleTabKeys])

  /**
   * UI 消费的过滤后 tab key 列表（PRD §4.3 三集合分离）。
   *
   * 计算流程：contextVisibleTabKeys → 去掉当前上下文里仍是有效分屏组的 tab。
   * 关键约束：`syncTabOrder` 输入永远用 `currentTabKeys`，**不能**改用本列表——否则
   * 被 isVisibleInContext 隐藏的 tab 会从 tabOrder 物理删除，违反「隐藏不删」决策。
   */
  const visibleTabKeys = useMemo(() => {
    return contextVisibleTabKeys.filter(key => !effectiveGroupedTabKeys.has(key))
  }, [contextVisibleTabKeys, effectiveGroupedTabKeys])

  const lastSyncedBrowserActiveViewIdRef = useRef<string | null>(browserSource.activeViewId ?? null)
  useEffect(() => {
    if (!isForeground || !restoreSettled || isColdStartInProgress || !chatSessionIndexReady) {
      lastSyncedBrowserActiveViewIdRef.current = browserSource.activeViewId ?? null
      return
    }

    const activeViewId = browserSource.activeViewId ?? null
    if (!activeViewId || activeViewId === lastSyncedBrowserActiveViewIdRef.current) return

    const nextTabKey = `tabweb:${activeViewId}` as ContextTabKey
    if (!visibleTabKeys.includes(nextTabKey)) return

    lastSyncedBrowserActiveViewIdRef.current = activeViewId
    if (activeTabKey === nextTabKey) return

    // 运行时 activeView 是 Agent 与 Browser 的执行目标，不代表工作台选择。
    // 已有任何前景时都保持不动；仅 active 为空时承担恢复兜底。
    if (!shouldFollowBrowserActiveView(activeTabKey)) {
      if (shouldDebugTabSync) {
        traceTabRestore('tabSync:browserActiveViewChanged:skipNonBrowserForeground', {
          spaceId,
          activeViewId,
          previousActive: activeTabKey,
          nextActive: nextTabKey,
        })
      }
      return
    }

    traceTabRestore('tabSync:browserActiveViewChanged', {
      spaceId,
      activeViewId,
      previousActive: activeTabKey,
      nextActive: nextTabKey,
    })
    setActiveKey(storageKey, nextTabKey, {
      writer: 'source_sync',
      reason: 'tabSync:browserActiveViewChanged',
    })
  }, [
    activeTabKey,
    browserSource.activeViewId,
    isForeground,
    isColdStartInProgress,
    restoreSettled,
    chatSessionIndexReady,
    setActiveKey,
    spaceId,
    storageKey,
    visibleTabKeys,
  ])

  // ── Stale activeKey guard: reset when active data tab removed from order ──
  // PRD §4.4 P0-B 单一来源：fallback 用 visibleTabKeys（已过滤），而不是 currentTabKeys。
  useEffect(() => {
    if (!isForeground) return
    if (!restoreSettled) return
    if (isColdStartInProgress) return
    if (!chatSessionIndexReady) return  // 红线 #11：子 Agent 标签仍需等待会话索引
    if (!activeTabKey) return
    // PRD §4.4：activeTabKey 不在 visibleTabKeys 时也触发 fallback（包括"被 isVisibleInContext 隐藏"场景）
    const isActiveVisible = visibleTabKeys.includes(activeTabKey as ContextTabKey)
    const isActiveGrouped = effectiveGroupedTabKeys.has(activeTabKey)
    if (isActiveVisible || isActiveGrouped) return
    // isActiveTabData=false（terminal/tabweb 等持久层 tab）但确实可见 → 已在上面 return；
    // 走到这里要么是 data tab 被移出 order，要么是 subagent_session 被切 session 隐藏。
    const fallback = pickFallbackTabKey(visibleTabKeys)
    if (fallback === activeTabKey) return
    traceTabRestore('tabSync:staleActiveFallback', {
      spaceId,
      activeTabKey,
      fallback,
      visibleTabKeys,
      groupedTabKeys: Array.from(effectiveGroupedTabKeys),
    })
    setActiveKey(storageKey, fallback, {
      writer: 'fallback',
      reason: 'tabSync:staleActiveFallback',
    })
  }, [
    activeTabKey, isActiveTabData, activeTabInOrder,
    chatSessionIndexReady, effectiveGroupedTabKeys, isForeground, isColdStartInProgress,
    visibleTabKeys, pickFallbackTabKey, restoreSettled, spaceId, storageKey, setActiveKey,
  ])

  // ── P2-13（PRD v3.1）：切回 session 时自动 recall 该 session 上次激活的 subagent ──
  //
  // 场景：用户在 session A 看 subagent A1 → 切到 session B（active fallback 到 tabdata）
  // → 切回 session A：期望自动恢复 A1。
  //
  // 设计要点：
  //   - 独立于 P0-B stale guard：切回 A 时 active 通常是 tabdata（A 下也可见），
  //     stale guard 觉得没事不会触发，所以 recall 必须监听 currentSessionId 自身变化。
  //   - 触发条件：currentSessionId 变化 + 该 session 有 lastActiveSubagent 记录 +
  //     对应 tabKey 仍在 visibleTabKeys（用户没手动 × 关掉、handler isVisibleInContext 不拦）。
  //   - 不区分"fallback 触发的 active=tabdata" vs "用户主动切到 tabdata"——后者
  //     切回 A 也会被 recall 回 subagent。可接受的折中：用户不想看可以再切，
  //     UI 不再因丢失"上次正看的 subagent"困扰用户（核心 P2-13 痛点）。
  //   - 用 useRef 防止同一个 sessionId 重复 recall（用户 recall 完手动切到 tabdata，
  //     不希望同次 session 内再被 recall 回去）。
  const lastRecalledSessionRef = useRef<string | null>(null)
  useEffect(() => {
    if (!isForeground) return
    if (!restoreSettled) return
    if (!chatSessionIndexReady) return
    if (!currentSessionId) {
      lastRecalledSessionRef.current = null
      return
    }
    if (lastRecalledSessionRef.current === currentSessionId) return
    lastRecalledSessionRef.current = currentSessionId

    const recalled = useSpaceContextTabsStore.getState().recallActiveSubagentForSession(
      storageKey,
      currentSessionId,
      visibleTabKeys,
    )
    if (recalled) {
      traceTabRestore('tabSync:recallSubagent', {
        spaceId,
        parentSessionId: currentSessionId,
        previousActive: activeTabKey,
      })
    }
    // 故意不把 visibleTabKeys / activeTabKey 加进 deps：避免它们变化引发的 effect
    // 重跑把 lastRecalledSessionRef 锁死后又被同 session 重新触发。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatSessionIndexReady, currentSessionId, spaceId, storageKey, isForeground, restoreSettled])

  // ── Fallback to home when no valid active key ──
  useEffect(() => {
    if (!isForeground) return
    if (!restoreSettled) return
    if (isColdStartInProgress) return
    if (!chatSessionIndexReady) return  // 红线 #11：子 Agent 标签仍需等待会话索引
    if (safeActiveTabKey) return
    if (!activeTabKey) return
    const fallback = pickFallbackTabKey(visibleTabKeys)
    if (fallback) {
      traceTabRestore('tabSync:invalidActiveFallback', {
        spaceId,
        activeTabKey,
        fallback,
        visibleTabKeys,
      })
      setActiveKey(storageKey, fallback, {
        writer: 'fallback',
        reason: 'tabSync:invalidActiveFallback',
      })
      return
    }
    traceTabRestore('tabSync:openHomeFallback', { spaceId, activeTabKey, visibleTabKeys })
    openHome()
  }, [
    activeTabKey, chatSessionIndexReady, openHome, isForeground, isColdStartInProgress,
    visibleTabKeys, pickFallbackTabKey, restoreSettled, spaceId, storageKey, safeActiveTabKey, setActiveKey,
  ])

  // ── Derived ordered/filtered data ──
  const filteredOpenTableIds = useMemo(() => {
    return tableSource.openTableIds.filter(id =>
      currentTabKeySet.has(`tabdata:${id}` as ContextTabKey)
    )
  }, [tableSource.openTableIds, currentTabKeySet])

  const filteredTerminalSessionIds = useMemo(() => {
    return terminalSessionIds.filter(id =>
      currentTabKeySet.has(`terminal:${id}` as ContextTabKey)
    )
  }, [terminalSessionIds, currentTabKeySet])

  const orderedItems = useMemo(() => {
    const items: ContextItem[] = []
    currentTabKeys.forEach(key => {
      const item = contextItemByTabKey.get(key)
      if (item) items.push(item)
    })
    return items
  }, [contextItemByTabKey, currentTabKeys])

  // ── Reorder handler ──
  const handleReorderItem = useCallback((dragged: ContextItem, target: ContextItem, position: 'before' | 'after') => {
    const next = reorderTabOrderBySlot(
      currentTabKeys,
      canvasGroups,
      dragged.tabKey,
      target.tabKey,
      position,
    )
    if (!next) return
    setTabOrder(storageKey, next)
  }, [canvasGroups, currentTabKeys, setTabOrder, storageKey])

  return {
    currentTabKeys,
    currentTabKeySet,
    contextItemByTabKey,
    orderedItems,
    filteredOpenTableIds,
    filteredTerminalSessionIds,
    contextVisibleTabKeys,
    visibleTabKeys,
    handleReorderItem,
  }
}
