import React, { useCallback, useEffect, useMemo, useState } from 'react'
import i18n from '@/i18n'
import { contextRegistry, type ContextItem, type ContextTabKey, type ContainerContext } from '@components/context-space/registry'
import { useCanvasLayoutStore } from '@stores/useCanvasLayoutStore'
import { EMPTY_CANVAS_GROUPS } from './utils/canvasLayout'
import { deriveContextVisibleCanvasGroups } from './utils/contextVisibleCanvasGroups'
import { useSpaceContextTabsStore, type ContextItemRecord } from '@stores/useSpaceContextTabsStore'
import { useSpaceContextNavigation } from './hooks/useSpaceContextNavigation'
import { useCreateHandlers } from './hooks/useCreateHandlers'
import { useBrowserActions } from './hooks/useBrowserActions'
import { useCloseHandlers } from './hooks/useCloseHandlers'
import { useContextSession } from './hooks/useContextSession'
import { useContextSpaceShortcuts } from './hooks/useContextSpaceShortcuts'
import type { Table } from '@tabtin/table-core'
import { SpaceContextArea } from './SpaceContextArea'
import {
  SpaceContextAreaProvider,
  type SpaceContextAreaState,
  type SpaceContextAreaActions,
} from './SpaceContextAreaContext'
import {
  useBrowserContextSource,
  useFolderContextSource,
  useTableContextSource,
  useTerminalContextSource,
} from './sources'
import { useSpaceApps } from '@stores/useSpaceApps'
import { useSpaceActivity } from '@components/layout/SpaceActivityContext'
import { useResourceEventStream } from '@/hooks/useResourceEventStream'
import { forceRefreshOrganizationCollections } from '@components/context-space/registry/homeSections/cloudFolderRefresh'
import { useCollections } from '@/stores/useCollections'
import { useUnifiedResources } from '@/stores/useUnifiedResources'
import { useSpaceViewPrefsStore } from '@stores/useSpaceViewPrefsStore'
import { useActiveKeyGuard } from './hooks/useActiveKeyGuard'
import { useTabSync } from './hooks/useTabSync'
import { useCanvasGroupIntegration } from './hooks/useCanvasGroupIntegration'
import { useResourceInit } from './hooks/useResourceInit'
import { useEnsureAgentReady } from './hooks/useEnsureAgentReady'
import { useSpaceStore } from '@stores/useSpaceStore'
import { useWorkbenchSurfaceStore } from '@stores/useWorkbenchSurfaceStore'
import {
  buildDesktopTabItem,
  DESKTOP_TAB_KEY,
  DESKTOP_TAB_TYPE,
} from './desktopTabHandler'
import { traceTabRestore } from '@/utils/tabRestoreTrace'
import { useWorkbenchRestoreCoordinator } from './restore/useWorkbenchRestoreCoordinator'
import { isCloudDocsScopeKey } from '@components/layout/cloudDocsDomain'
import { useSpaceListStore } from '@stores/useSpaceListStore'
import { getSpaceFollowTarget } from './utils/spaceFollow'
import { shouldMigrateLegacyCanvasGroups } from './utils/shouldMigrateLegacyCanvasGroups'
import { createLogger } from '@/utils/logger'

const log = createLogger('SpaceContextContainer')
/**
 * 工作台容器所需的最小 Space 接口。
 * Bot / IM Space 传入满足该接口的对象即可。
 */
export interface SpaceContext {
  id: string
  name: string
  organization_id: string
  agent_id?: string | null
  config_version?: number
  suggested_prompts?: string[]
}

interface SpaceContextContainerProps {
  /** 任意类型的 Space（bot / group / dm），只要满足 SpaceContext 即可 */
  space?: SpaceContext
  crawlspaceId?: string | null
  /** 共享 workspace layer 的 DOM 宿主（多实例保活模式） */
  workspaceLayerHost?: HTMLElement | null
  /** 标签组 scope。未传时沿用 legacy per-space scope。 */
  tabScopeKey?: string | null
  renderTabsOnly?: boolean
  hideTabsBar?: boolean
  sidebarPosition?: 'left' | 'right'
  shellCanvasVisible?: boolean
  /** 本 scene 私有的桌面侧栏内容宿主节点（透传给 SpaceContextArea，修全局侧栏双份）。 */
  sidebarPortalHost?: HTMLElement | null
  /** 本 scene 私有的右侧「收起栏」宿主节点（对话模式画布折叠时用，机制同 sidebarPortalHost）。 */
  canvasRailPortalHost?: HTMLElement | null
}

interface SpaceContextContainerResolvedProps extends Omit<SpaceContextContainerProps, 'space'> {
  space: SpaceContext
}

/**
 * 追踪 useSpaceContextTabsStore 的 persist 水合状态。
 * Zustand persist 水合是异步的（通过微任务调度）— 在水合完成前 store 处于空的初始状态。
 * 如果在水合前执行 syncTabOrder，会用空数据覆盖持久化的标签顺序。
 */
interface ZustandPersistApi {
  hasHydrated: () => boolean
  onFinishHydration: (cb: () => void) => () => void
}

const summarizeContainerCanvasGroups = (groups: typeof EMPTY_CANVAS_GROUPS) =>
  groups.map(group => ({
    id: group.id,
    anchorTabKey: group.anchorTabKey,
    activePaneId: group.activePaneId,
    panes: group.panes.map(pane => ({
      id: pane.id,
      tabKey: pane.content?.tabKey ?? null,
    })),
  }))

const EMPTY_PERSISTED_ITEMS: Record<string, ContextItemRecord> = {}

const persistApi = (() => {
  const store = useSpaceContextTabsStore as unknown as { persist?: Partial<ZustandPersistApi> }
  const api = store.persist
  if (api && typeof api.hasHydrated === 'function' && typeof api.onFinishHydration === 'function') {
    return api as ZustandPersistApi
  }
  return undefined
})()

function useTabStoreHydrated(): boolean {
  const [hydrated, setHydrated] = useState(() => persistApi?.hasHydrated?.() ?? true)
  useEffect(() => {
    if (hydrated) return
    if (persistApi?.hasHydrated?.()) {
      setHydrated(true)
      return
    }
    return persistApi?.onFinishHydration?.(() => setHydrated(true))
  }, [hydrated])
  return hydrated
}

const ResourceEventStreamSubscription: React.FC<{
  spaceId: string | null
  organizationId: string | null
  scope: 'space' | 'organization'
  enabled: boolean
}> = ({ spaceId, organizationId, scope, enabled }) => {
  // ：重连后按 scope 强制补拉，避免漏推的 collection_created 留下陈旧缓存
  const onReconnected = useCallback(() => {
    if (scope === 'organization') {
      if (organizationId) {
        void forceRefreshOrganizationCollections(organizationId, 'reconnect')
      }
      if (spaceId) {
        void useUnifiedResources.getState().load(spaceId, true, 'organization')
      }
      return
    }
    if (spaceId) {
      log.info('space collections refresh', { source: 'reconnect', spaceId })
      void useCollections.getState().load(spaceId, true)
      void useUnifiedResources.getState().load(spaceId, true, 'space')
    }
  }, [organizationId, scope, spaceId])

  useResourceEventStream({ spaceId, scope, enabled, onReconnected })
  return null
}

export const SpaceContextContainer: React.FC<SpaceContextContainerProps> = (props) => {
  if (!props.space) return null
  return <SpaceContextContainerInner {...props} space={props.space} />
}

const SpaceContextContainerInner: React.FC<SpaceContextContainerResolvedProps> = ({
  space,
  crawlspaceId,
  workspaceLayerHost,
  tabScopeKey,
  renderTabsOnly = false,
  hideTabsBar = false,
  sidebarPosition,
  shellCanvasVisible = true,
  sidebarPortalHost = null,
  canvasRailPortalHost = null,
}) => {
  const { isForeground } = useSpaceActivity()
  const effectiveTabScopeKey = tabScopeKey || space.id
  const requestedResourceScope = useSpaceViewPrefsStore(s => s.getPrefs(space.id).resourceScope)
  const resourceEventScope: 'space' | 'organization' = requestedResourceScope === 'organization' ? 'organization' : 'space'

  const tabStoreHydrated = useTabStoreHydrated()

  // ── Session ──
  const session = useContextSession(effectiveTabScopeKey)
  const activeTabKey = session.activeKey as ContextTabKey | null
  const tabOrder = session.tabOrder
  const setTabOrder = session.setTabOrder
  const syncTabOrder = session.syncTabOrder
  const setActiveKey = useSpaceContextTabsStore(state => state.setActiveKey)
  const displayTabKey = useSpaceContextTabsStore(state => state.displayKeyBySpace[effectiveTabScopeKey] ?? null)
  const persistedItems = useSpaceContextTabsStore(state => state.itemsBySpace[effectiveTabScopeKey] ?? EMPTY_PERSISTED_ITEMS)

  // ── Workbench surface（真实 tab / 虚拟桌面主页）持久记忆 ──
  // Phase2：surface 属于当前 tab scope，而不是 execution Space——
  // 否则同一个 Space 下多个 conversation 标签组会共享 surface 状态，
  // 破坏「每条对话独立标签组」的隔离。
  // 读「原始」持久 surface（可能 undefined = 从没设过），默认值按 Space 类型决定：
  // workspace 默认 surface = 'desktop'（默认展示桌面主页），
  // 让用户先看到可行动的公共工作台引导；其他类型（group / dm）默认 'real_tab'。
  // 一旦用户显式停留过某 surface，持久值固定下来，下次进来尊重上次停留处。
  const persistedSurface = useWorkbenchSurfaceStore(
    state => state.lastActiveSurfaceBySpace[effectiveTabScopeKey],
  )
  const isWorkspace = useSpaceStore(state =>
    state.spaces.find(s => s.id === space.id)?.type === 'workspace',
  )
  const isCloudDocsScope = isCloudDocsScopeKey(effectiveTabScopeKey)
  const lastActiveSurface = persistedSurface ?? (
    isCloudDocsScope ? 'real_tab' : isWorkspace ? 'desktop' : 'real_tab'
  )
  const setLastActiveSurface = useWorkbenchSurfaceStore(state => state.setLastActiveSurface)

  // ── Data sources ──
  // 标签桶（哪些标签 / active / 顺序 / 持久化）已按 effectiveTabScopeKey 提层到
  // desktop / conversation scope。但**运行载体仍 per-space**（本阶段刻意不动）：
  //   - browser：crawlspaceId 来自 ensureSpaceCrawlspace(space.id)，WebContentsView / cookie
  //     partition 仍 per-space（cookie 未改 organizationId）。
  //   - terminal：PTY / session 仍按 space.id 编组。
  //   - folder：浏览面仍按 space.id。
  // 因此 useTabSync / reconcileWorkbenchRestore 用 isIsolatedScope 把 conversation scope 的
  // 标签限定到 explicit keys，避免 per-space 载体 source 把别的对话/桌面的 view 灌进来。
  // TODO(Phase 3 — browser): cookie partition 改 organizationId、crawlspace/view 载体提到
  //   desktop/对话 scope（见 desktop-conversation-space-boundary.md §1.4、§6.2 步骤 3）。
  // Phase 4a（terminal §1.5、§6.2 步骤 4）：用户终端载体已按 tabScopeKey 编组（桌面入口=
  //   desktop 共享池、对话入口=该对话组），cwd 桌面入沙箱 / 对话切 working_dir；PTY spaceId
  //   显式传递。剩 overview/splitlayout 分组与历史会话迁移到 scope 口径 = 4b。
  const tableSource = useTableContextSource({ spaceId: space.id, tabScopeKey: effectiveTabScopeKey, tabOrder })
  const browserSource = useBrowserContextSource({
    crawlspaceId: crawlspaceId ?? null,
    spaceId: space.id,
    tabScopeKey: effectiveTabScopeKey,
  })
  const _folderSource = useFolderContextSource({ spaceId: space.id })
  const terminalSource = useTerminalContextSource({ spaceId: space.id, tabScopeKey: effectiveTabScopeKey })

  const spaceAppsData = useSpaceApps(state => state.appsBySpace[space.id])
  const isAppEnabled = useCallback((appId?: string) => {
    if (!appId) return true
    if (!spaceAppsData) return true
    return spaceAppsData.find(a => a.id === appId)?.enabled ?? true
  }, [spaceAppsData])

  // ── Canvas store: groupedTabKeys 在 guard 和 tabSync 之间共享 ──
  // Phase 5b：canvas group 的分组 key 跟随 workspace scope，而不是执行 Space。
  // 旧 per-space 布局只作为一次性读取 fallback，避免升级后用户已打开画布瞬间消失。
  // ：关光后 scoped 为 `[]`；不得再用 `?.length` 当成「未迁移」从 space 桶回灌。
  const scopedCanvasGroups = useCanvasLayoutStore(state => state.spaceGroups[effectiveTabScopeKey])
  const legacyCanvasGroups = useCanvasLayoutStore(state => state.spaceGroups[space.id])
  const explicitCloseRevision = useSpaceContextTabsStore(
    state => state.explicitCloseRevisionByScope[effectiveTabScopeKey] ?? 0,
  )
  useEffect(() => {
    if (!shouldMigrateLegacyCanvasGroups({
      isSameScope: effectiveTabScopeKey === space.id,
      scopedCanvasGroups,
      legacyCanvasGroups,
      explicitCloseRevision,
    })) {
      return
    }
    // shouldMigrate 已保证 legacy 非空；本地收窄供 map
    const groupsToMigrate = legacyCanvasGroups
    if (!groupsToMigrate?.length) return
    useCanvasLayoutStore.setState(state => ({
      spaceGroups: {
        ...state.spaceGroups,
        [effectiveTabScopeKey]: groupsToMigrate.map(group => ({
          ...group,
          spaceId: effectiveTabScopeKey,
        })),
      },
    }))
  }, [effectiveTabScopeKey, legacyCanvasGroups, scopedCanvasGroups, space.id, explicitCloseRevision])
  const spaceGroups = scopedCanvasGroups
  const safeSpaceGroups = spaceGroups ?? EMPTY_CANVAS_GROUPS
  const groupedTabKeys = useMemo(() => {
    const keys = new Set<string>()
    safeSpaceGroups.forEach(group => {
      group.panes.forEach(pane => {
        if (pane.content?.tabKey) keys.add(pane.content.tabKey)
      })
    })
    return keys
  }, [safeSpaceGroups])

  const restoreCoordinator = useWorkbenchRestoreCoordinator({
    spaceId: space.id,
    tabScopeKey: effectiveTabScopeKey,
    crawlspaceId,
    isForeground,
    tabOrder,
    activeKey: activeTabKey,
    displayKey: displayTabKey,
    itemsByTabKey: persistedItems,
    canvasGroups: safeSpaceGroups,
    browserSource,
    tableSource,
    terminalSource,
    appsReady: Boolean(spaceAppsData),
    isAppEnabled,
    lastActiveSurface,
  })
  const restoreSettled = restoreCoordinator.restoreSettled
  // ── 1. Active key guard (pure computation) ──
  const {
    safeActiveTabKey, activeTabType, activeTableId,
    activeTabInOrder, isActiveTabData,
  } = useActiveKeyGuard({
    spaceId: space.id,
    tabScopeKey: effectiveTabScopeKey,
    activeTabKey,
    groupedTabKeys,
    tabOrder,
    isAppEnabled,
  })

  // ── 2. Navigation (before tabSync — tabSync needs openHome) ──
  // 单根契约：openCodeProject 已不再用于 createHandlers（TabCode 不存在
  // "用户主动打开独立 Tab"语义）。useSpaceContextNavigation 仍 export 该 helper
  // 供其他工件流路径使用，这里仅按需解构。
  const {
    openHome, openAppHome, openTable,
    closeBrowserView, createWebTab, openEmbeddedWebApp,
    openSpaceSettings, openResource,
    openSlide,
    openDocument, openSite,
  } = useSpaceContextNavigation({
    spaceId: space.id,
    tabScopeKey: effectiveTabScopeKey,
    spaceName: space.name,
    tables: tableSource.tables,
  })

  // ── 3. Tab sync ──
  const {
    currentTabKeys, contextItemByTabKey,
    orderedItems, filteredOpenTableIds, filteredTerminalSessionIds,
    contextVisibleTabKeys, visibleTabKeys, handleReorderItem,
  } = useTabSync({
    spaceId: space.id,
    tabScopeKey: effectiveTabScopeKey,
    crawlspaceId,
    activeTabKey,
    safeActiveTabKey,
    activeTabInOrder,
    isActiveTabData,
    tabOrder,
    groupedTabKeys,
    canvasGroups: safeSpaceGroups,
    isForeground,
    tabStoreHydrated,
    restoreSettled,
    browserSource,
    tableSource,
    terminalSource,
    isAppEnabled,
    syncTabOrder,
    setActiveKey,
    openHome,
  })

  const { visibleGroups: visibleCanvasGroups, visibleGroupedTabKeys } = useMemo(
    () => deriveContextVisibleCanvasGroups(safeSpaceGroups, contextVisibleTabKeys),
    [contextVisibleTabKeys, safeSpaceGroups],
  )

  // ── 4. Canvas group integration ──
  const {
    groupedTableIds,
    groupedTerminalIds,
    shouldShowCanvasGroup,
    activeCanvasGroupId,
    handleRestoreGroup,
    buildContentFromActiveTab,
    buildContentFromDrag,
  } = useCanvasGroupIntegration({
    spaceId: space.id,
    tabScopeKey: effectiveTabScopeKey,
    activeTabKey,
    activeTabType,
    safeSpaceGroups: visibleCanvasGroups,
    contextItemByTabKey,
    currentTabKeys,
    contextVisibleTabKeys,
    browserViewList: browserSource.viewList,
    setTabOrder,
    isForeground,
  })

  // ── 5. Resource init ──
  const { handleSearchNavigate, handleReopenClosedTab } = useResourceInit({
    spaceId: space.id,
    tabScopeKey: effectiveTabScopeKey,
    spaceName: space.name,
    spaceOrganizationId: space.organization_id,
    crawlspaceId,
    activeTabType,
    isForeground,
  })

  // ── Create handlers ──
  // 单根契约：tabcode / tabfolder 不参与 createHandlers，因此这里不再注入
  // folderSource、navigation.openCodeProject。Agent 目录的代码 / 文件视角由
  // Orchestration HomeSection 按 working_dir_type 内嵌渲染。
  const { createHandlers, creatingAppIds } = useCreateHandlers({
    spaceId: space.id,
    spaceOrganizationId: space.organization_id,
    isAppEnabled,
    tableSource: {
      selectedOrganizationId: tableSource.selectedOrganizationId,
      createTable: tableSource.createTable,
    },
    terminalSource: {
      createSession: terminalSource.createSession,
    },
    navigation: {
      openTable,
      openDocument,
      openSlide,
      openSite,
      createWebTab,
      openEmbeddedWebApp,
    },
  })

  // ── Agent 起始页旧标签清理 ──
  // TabFolder 侧栏子项会按目标 Space 打开可关闭的 `apphome:orchestration-*` 标签；
  // 旧的默认 `apphome:orchestration` 常驻标签不再作为桌面入口展示，进入后清掉历史持久化残留。
  // 注：Space 是执行现场；执行身份优先按 execution_agent_id，兼容旧 Space.agent_id。
  const selectedAgentForSpace = useSpaceStore(state => {
    const cached = state.agentCache
    const targetSpace = state.spaces.find(s => s.id === space.id)
    const agentId = targetSpace?.execution_agent_id ?? targetSpace?.agent_id ?? null
    if (!agentId) return null
    return cached[agentId] ?? (state.selectedAgent?.id === agentId ? state.selectedAgent : null)
  })
  const spaceTypeForInjection = useSpaceStore(state =>
    state.spaces.find(s => s.id === space.id)?.type,
  )
  useEffect(() => {
    if (!tabStoreHydrated || !restoreSettled) return
    const agentHomeTabKey = contextRegistry.buildTabKey('apphome', 'orchestration')
    const item = useSpaceContextTabsStore.getState().itemsBySpace[effectiveTabScopeKey]?.[agentHomeTabKey]
    if (!item || typeof item.meta?.targetSpaceId === 'string') return
    useSpaceContextTabsStore.getState().batchCloseTab(effectiveTabScopeKey, [agentHomeTabKey])
  }, [effectiveTabScopeKey, restoreSettled, tabStoreHydrated])

  // ：TabPhone 的 flat 列表主页（apphome:tabphone）已下线——设备主页由
  // TabPhone 面板自身的 DeviceGridHome 承载。清掉历史持久化残留，否则旧标签
  // 恢复后只渲染一个「安卓手机」标题的死页面。
  useEffect(() => {
    if (!tabStoreHydrated || !restoreSettled) return
    const phoneHomeTabKey = contextRegistry.buildTabKey('apphome', 'tabphone')
    const tabOrder = useSpaceContextTabsStore.getState().tabOrderBySpace[effectiveTabScopeKey] ?? []
    if (!tabOrder.includes(phoneHomeTabKey)) return
    useSpaceContextTabsStore.getState().batchCloseTab(effectiveTabScopeKey, [phoneHomeTabKey])
  }, [effectiveTabScopeKey, restoreSettled, tabStoreHydrated])

  //  开箱即用自愈：进入 workspace 即静默绑本机设备 + 补默认目录。
  // 放在容器层（而非 OrchestrationSection）确保「无论当前是对话视图还是起始页」
  // 都会触发——OrchestrationSection 没挂载时也能自愈历史/新建 Agent。
  useEnsureAgentReady(space.id, spaceTypeForInjection === 'workspace' ? selectedAgentForSpace : null)

  // 有真实 active tab 时同步 surface 记忆回 real_tab（用户从桌面主页切到真实 tab）。
  useEffect(() => {
    if (!restoreSettled) return
    if (safeActiveTabKey) {
      setLastActiveSurface(effectiveTabScopeKey, 'real_tab')
    }
  }, [effectiveTabScopeKey, restoreSettled, safeActiveTabKey, setLastActiveSurface])

  // 虚拟系统标签 item — 稳定引用，避免 useMemo 依赖链 over-invalidate
  const virtualDesktopItem = useMemo(() => buildDesktopTabItem(), [])

  // Agent 起始页标签（apphome:orchestration）按当前 Space 名展示「xxx的目录」。
  // 起始页内容即 Agent 的 working_dir 视图，用 Space 名命名比统一的「Agent」更可辨识，
  // 也跟随 Space rename 实时更新。targetSpaceId 跳转态不在此改名（沿用目标 Space 标题）。
  const agentHomeTitle = useMemo(
    () => (space.name ? i18n.t('tab.agentWorkingDir', { ns: 'context', name: space.name }) : null),
    [space.name],
  )
  const relabelAgentHome = useCallback((item: ContextItem): ContextItem => {
    if (
      agentHomeTitle &&
      item.type === 'apphome' &&
      item.meta?.appId === 'orchestration' &&
      !item.meta?.targetSpaceId &&
      item.title !== agentHomeTitle
    ) {
      return { ...item, title: agentHomeTitle }
    }
    return item
  }, [agentHomeTitle])

  // ── Container context + select/refresh ──
  const containerCtx = useMemo<ContainerContext>(() => ({
    spaceId: space.id,
    tabScopeKey: effectiveTabScopeKey,
    crawlspaceId,
    closeBrowserView,
  }), [space.id, effectiveTabScopeKey, crawlspaceId, closeBrowserView])

  const handleSelectItem = useCallback((item: ContextItem) => {
    if (item.type === DESKTOP_TAB_TYPE) {
      setLastActiveSurface(effectiveTabScopeKey, 'desktop')
      // 桌面是虚拟系统标签，不写入真实 activeKey / tabOrder。
      setActiveKey(effectiveTabScopeKey, null)
      return
    }
    setLastActiveSurface(effectiveTabScopeKey, 'real_tab')
    // Space 目录起始页承载「某个 Space 的工作目录」身份：激活它时对话跟随切到该 Space，
    // 保持工作台与对话一致。先切 Space 再 dispatchSelect/setActiveKey，与 openBoundDir
    // 已验证的顺序一致（两步都是同步 store 写入，desktop scope 共享，带 targetSpaceId 的
    // 页签不会被旧标签清理 effect 打回）。
    const followSpaceId = getSpaceFollowTarget(item)
    if (followSpaceId && followSpaceId !== space.id) {
      if (!useSpaceListStore.getState().selectSpaceBySpaceId(followSpaceId)) {
        log.warn('space follow skipped: target space not selectable', {
          followSpaceId,
          fromSpaceId: space.id,
        })
      }
    }
    if (!contextRegistry.dispatchSelect(item, containerCtx)) {
      setActiveKey(effectiveTabScopeKey, item.tabKey)
    }
  }, [containerCtx, effectiveTabScopeKey, setActiveKey, setLastActiveSurface, space.id])

  const {
    handleCloseItem: rawHandleCloseItem,
    handleCloseOtherItems,
    handleCloseLeftItems,
    handleCloseRightItems,
    handleCloseOthersForGroup,
    handleCloseLeftForGroup,
    handleCloseRightForGroup,
  } = useCloseHandlers({
    spaceId: space.id,
    containerCtx,
    visibleTabKeys,
    currentTabKeys,
    groupedTabKeys: visibleGroupedTabKeys,
    canvasGroups: visibleCanvasGroups,
    contextItemByTabKey,
    tabScopeKey: effectiveTabScopeKey,
    setActiveKey,
    handleSelectItem,
  })

  /**
   * 拦截虚拟桌面标签的关闭：桌面主页始终存在，"关闭"语义实际上是"退出桌面视图"。
   */
  const handleCloseItem = useCallback((item: ContextItem) => {
    if (item.type === DESKTOP_TAB_TYPE) {
      setLastActiveSurface(effectiveTabScopeKey, 'real_tab')
      return
    }
    rawHandleCloseItem(item)
  }, [effectiveTabScopeKey, rawHandleCloseItem, setLastActiveSurface])

  const handleRefreshItem = useCallback((item: ContextItem) => {
    contextRegistry.dispatchRefresh(item, containerCtx)
  }, [containerCtx])

  const {
    handleBackItem,
    handleForwardItem,
    handleFindItem,
    handleZoomItem,
    handleFocusUrl,
  } = useBrowserActions()

  // ── Shortcuts ──
  useContextSpaceShortcuts({
    enabled: isForeground,
    activeTabKey: safeActiveTabKey,
    orderedTabKeys: currentTabKeys,
    visibleTabKeys,
    itemsByTabKey: contextItemByTabKey,
    onSelectItem: handleSelectItem,
    onCloseItem: handleCloseItem,
    onRefreshItem: handleRefreshItem,
    onCreateWebTab: createHandlers.tabweb,
    onBackItem: handleBackItem,
    onForwardItem: handleForwardItem,
    onFindItem: handleFindItem,
    onZoomItem: handleZoomItem,
    onFocusUrl: handleFocusUrl,
    onReopenClosedTab: handleReopenClosedTab,
  })

  const handleTableClick = useCallback(
    (table: Table) => openTable(table.id),
    [openTable],
  )

  // ── Effective active key（合并虚拟桌面态 + 真实 tab 态） ──
  // desktopActive → 用 DESKTOP_TAB_KEY / DESKTOP_TAB_TYPE
  // 否则沿用原有 safeActiveTabKey / activeTabType
  // canvasGroup 优先级最高（已 active 一组 panes 时虚拟桌面让位）
  const desktopActive =
    restoreSettled
    && !safeActiveTabKey
    && lastActiveSurface === 'desktop'
    && !isCloudDocsScope
  const effectiveActiveTabKey = desktopActive && !shouldShowCanvasGroup
    ? DESKTOP_TAB_KEY
    : safeActiveTabKey
  const effectiveActiveTabType = desktopActive && !shouldShowCanvasGroup
    ? DESKTOP_TAB_TYPE
    : activeTabType
  const effectiveActiveTableId = activeTableId

  // 渲染层注入虚拟系统标签到 orderedItems 最前面：桌面永远第一，不污染持久 tabOrder。
  const augmentedOrderedItems = useMemo(() => {
    return [virtualDesktopItem, ...orderedItems.map(relabelAgentHome)]
  }, [virtualDesktopItem, orderedItems, relabelAgentHome])

  // PRD §4.3 三集合分离：UI 渲染用 visibleItems（已过滤），逻辑判断（keepAlive 计算
  // / dedup 等）可继续看 orderedItems 全量。这里基于 visibleTabKeys 解析 item——
  // 虚拟系统标签永远 visible，且桌面固定首位。
  const visibleItems = useMemo(() => {
    const itemsByKey = new Map<string, ContextItem>()
    for (const it of orderedItems) itemsByKey.set(it.tabKey, it)
    const result: ContextItem[] = [virtualDesktopItem]
    for (const key of visibleTabKeys) {
      const it = itemsByKey.get(key)
      if (it) result.push(relabelAgentHome(it))
    }
    return result
  }, [orderedItems, visibleTabKeys, virtualDesktopItem, relabelAgentHome])

  const tabLookupItems = useMemo(() => {
    const itemsByKey = new Map<string, ContextItem>()
    for (const it of orderedItems) itemsByKey.set(it.tabKey, it)
    const result: ContextItem[] = [virtualDesktopItem]
    for (const key of contextVisibleTabKeys) {
      const it = itemsByKey.get(key)
      if (it) result.push(relabelAgentHome(it))
    }
    return result
  }, [contextVisibleTabKeys, orderedItems, virtualDesktopItem, relabelAgentHome])

  // ── Provider state ──
  const ctxState = useMemo<SpaceContextAreaState>(() => ({
    spaceId: space.id,
    tabScopeKey: effectiveTabScopeKey,
    restoreSettled,
    activeTabKey: effectiveActiveTabKey,
    activeTabType: effectiveActiveTabType,
    activeTableId: effectiveActiveTableId,
    orderedItems: augmentedOrderedItems,
    tabLookupItems,
    visibleItems,
    groupedTabKeys: visibleGroupedTabKeys,
    canvasGroups: visibleCanvasGroups,
    shouldShowCanvasGroup,
    activeCanvasGroupId,
    // 云文档域：只常驻当前激活表，避免历史 tabdata 经 PersistentTableTabs 全量挂载
    openTableTabs: isCloudDocsScope
      ? (effectiveActiveTableId ? [effectiveActiveTableId] : [])
      : filteredOpenTableIds,
    groupedTableIds,
    terminalSessionIds: filteredTerminalSessionIds,
    groupedTerminalIds,
    crawlspaceId,
    homeTables: tableSource.tables,
    isLoading: tableSource.isLoading,
    error: tableSource.error,
    isCrawlspaceReady: Boolean(crawlspaceId),
    creatingAppIds,
  }), [
    space.id, effectiveTabScopeKey, restoreSettled, effectiveActiveTabKey, effectiveActiveTabType, effectiveActiveTableId,
    augmentedOrderedItems, tabLookupItems, visibleItems, visibleGroupedTabKeys, visibleCanvasGroups,
    shouldShowCanvasGroup, activeCanvasGroupId,
    isCloudDocsScope, filteredOpenTableIds, groupedTableIds,
    filteredTerminalSessionIds, groupedTerminalIds,
    crawlspaceId, tableSource.tables, tableSource.isLoading, tableSource.error,
    creatingAppIds,
  ])

  useEffect(() => {
    traceTabRestore('spaceContainer:state', {
      spaceId: space.id,
      tabScopeKey: effectiveTabScopeKey,
      crawlspaceId: crawlspaceId ?? null,
      tabStoreHydrated,
      isForeground,
      activeTabKey,
      safeActiveTabKey,
      effectiveActiveTabKey,
      activeTabType,
      effectiveActiveTabType,
      activeTabInOrder,
      isActiveTabData,
      tabOrder,
      currentTabKeys,
      contextVisibleTabKeys,
      visibleTabKeys,
      groupedTabKeys: Array.from(visibleGroupedTabKeys),
      shouldShowCanvasGroup,
      activeCanvasGroupId,
      restore: {
        settled: restoreSettled,
        activeSurface: restoreCoordinator.activeSurface,
        desiredActiveViewId: restoreCoordinator.desiredActiveViewId,
        generation: restoreCoordinator.generation,
        trace: restoreCoordinator.lastDecision?.trace ?? null,
      },
      canvasGroups: summarizeContainerCanvasGroups(visibleCanvasGroups),
      browser: {
        activeViewId: browserSource.activeViewId,
        itemKeys: browserSource.items.map(item => item.tabKey),
        views: browserSource.viewList.map(view => ({
          viewId: view.viewId,
          title: view.title ?? null,
          url: view.url ?? null,
          isClosing: Boolean(view.isClosing),
        })),
      },
      table: {
        itemKeys: tableSource.items.map(item => item.tabKey),
        openTableIds: tableSource.openTableIds,
      },
      terminal: {
        itemKeys: terminalSource.items.map(item => item.tabKey),
        sessionIds: terminalSource.sessions.map(session => session.id),
      },
    })
  }, [
    activeCanvasGroupId,
    activeTabInOrder,
    activeTabKey,
    activeTabType,
    isForeground,
    browserSource.items,
    browserSource.activeViewId,
    browserSource.viewList,
    crawlspaceId,
    currentTabKeys,
    effectiveTabScopeKey,
    effectiveActiveTabKey,
    effectiveActiveTabType,
    visibleGroupedTabKeys,
    isActiveTabData,
    restoreCoordinator.activeSurface,
    restoreCoordinator.desiredActiveViewId,
    restoreCoordinator.generation,
    restoreCoordinator.lastDecision,
    restoreSettled,
    safeActiveTabKey,
    visibleCanvasGroups,
    shouldShowCanvasGroup,
    space.id,
    tabOrder,
    tabStoreHydrated,
    tableSource.items,
    tableSource.openTableIds,
    terminalSource.items,
    terminalSource.sessions,
    contextVisibleTabKeys,
    visibleTabKeys,
  ])

  // ── Provider actions ──
  // 单根契约：onOpenFolder / onOpenAgentFolder 不再 expose——TabFolder 视图由
  // Orchestration HomeSection 内嵌渲染，不需要外部 action 触发"打开 Agent 目录"。
  const ctxActions = useMemo<SpaceContextAreaActions>(() => ({
    createHandlers,
    onOpenAppHome: openAppHome,
    onOpenSpaceSettings: openSpaceSettings,
    onTableClick: handleTableClick,
    onSearchNavigate: handleSearchNavigate,
    onSelectHome: openHome,
    onSelectItem: handleSelectItem,
    onCloseItem: handleCloseItem,
    onRefreshItem: handleRefreshItem,
    onCloseOtherItems: handleCloseOtherItems,
    onCloseLeftItems: handleCloseLeftItems,
    onCloseRightItems: handleCloseRightItems,
    onCloseOthersForGroup: handleCloseOthersForGroup,
    onCloseLeftForGroup: handleCloseLeftForGroup,
    onCloseRightForGroup: handleCloseRightForGroup,
    onReorderItem: handleReorderItem,
    onReopenClosedTab: handleReopenClosedTab,
    onRestoreGroup: handleRestoreGroup,
    buildContentFromActiveTab,
    buildContentFromDrag,
  }), [
    createHandlers, openAppHome, openSpaceSettings,
    handleTableClick, handleSearchNavigate, openHome,
    handleSelectItem, handleCloseItem, handleRefreshItem,
    handleCloseOtherItems, handleCloseLeftItems, handleCloseRightItems,
    handleCloseOthersForGroup, handleCloseLeftForGroup, handleCloseRightForGroup,
    handleReorderItem, handleReopenClosedTab, handleRestoreGroup,
    buildContentFromActiveTab, buildContentFromDrag,
  ])

  return (
    <>
      <ResourceEventStreamSubscription
        key={`${resourceEventScope}:${space.id}`}
        scope={resourceEventScope}
        spaceId={isForeground ? space.id : null}
        organizationId={isForeground ? space.organization_id : null}
        enabled={isForeground}
      />
      <SpaceContextAreaProvider state={ctxState} actions={ctxActions}>
        <SpaceContextArea
          workspaceLayerHost={workspaceLayerHost}
          renderTabsOnly={renderTabsOnly}
          hideTabsBar={hideTabsBar}
          sidebarPosition={sidebarPosition}
          shellCanvasVisible={shellCanvasVisible}
          sidebarPortalHost={sidebarPortalHost}
          canvasRailPortalHost={canvasRailPortalHost}
        />
      </SpaceContextAreaProvider>
    </>
  )
}

SpaceContextContainer.displayName = 'SpaceContextContainer'
