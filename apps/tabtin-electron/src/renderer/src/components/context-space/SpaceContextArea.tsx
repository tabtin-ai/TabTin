import React, { Activity, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { StableSlot } from '@/utils/portal-host'

import { ContextTabs } from '@components/context-space/ContextTabs'
import { ErrorBoundary } from '@components/common/ErrorBoundary'
import { contextRegistry } from '@components/context-space/registry'
import type { CanvasTabKey } from '@stores/useCanvasLayoutStore'
import type { ContextItem } from './registry/types'
import { cn } from '@utils/cn'
import { CANVAS_TEXT_SECONDARY } from '@components/layout/canvasUi'
import { useTranslation } from 'react-i18next'
import {
  useSpaceViewPrefsStore,
  type SidebarMode,
} from '@stores/useSpaceViewPrefsStore'
import { useWorkbenchSurfaceStore } from '@stores/useWorkbenchSurfaceStore'
import { getNavigationIntent } from '@stores/useSpaceContextTabsStore'
import { useSpaceContextState, useSpaceContextActions } from './SpaceContextAreaContext'
import { useIsRemoteViewer } from './hooks/useIsRemoteViewer'
import { RemoteAgentBanner } from './folder/RemoteAgentBanner'
import { EXECUTION_DEVICE_APP_IDS, EXECUTION_DEVICE_APP_LABEL_FALLBACK } from './executionDeviceApps'
import { useAuthStore } from '@stores/useAuthStore'
import { useSpaceStore } from '@stores/useSpaceStore'
import {
  Button,
  OverlayContainerProvider,
} from '@components/ui'
import { useSidebarContentPortal } from '@components/layout/SidebarContentPortalContext'
import { useCanvasRailPortal } from '@components/layout/CanvasRailPortalContext'
import { CollapsedCanvasRail } from './CollapsedCanvasRail'
import { useShellTopBarInset } from '@components/layout/shellTopBarInset'
import { SHELL_WORKBENCH_TOP_BAR_HEIGHT_CLASS } from '@components/layout/shellUi'
import { useSpaceActivity } from '@components/layout/SpaceActivityContext'
import { DESKTOP_TAB_TYPE } from '@components/context-space/desktopTabHandler'
import {
  isConversationScopeKey,
  isImConversationScopeKey,
  sessionIdFromConversationScopeKey,
} from '@components/layout/workspaceContextState'
import { useSessionAccessStore } from '@/stores/chat/session/sessionAccessStore'
import { isCloudDocsScopeKey } from '@components/layout/cloudDocsDomain'
import { captureTaskViewModeMorph } from '@components/chat/capsule/chatCapsuleMorph'
import {
  retryBrowserViewActivation,
  useBrowserViewActivationIntent,
  useBrowserViewActivationState,
} from '@/services/browserViewActivation'
import { BrowserViewRecoveryPanel } from './registry/handlers/renderers/BrowserViewRecoveryPanel'
import { buildWorkbenchTabBarModel } from './workbenchTabBarModel'

const PersistentCanvasGroups = React.lazy(() =>
  import('@components/layout/PersistentCanvasGroups').then(m => ({ default: m.PersistentCanvasGroups }))
)
const PersistentTableTabs = React.lazy(() =>
  import('@components/layout/PersistentTableTabs').then(m => ({ default: m.PersistentTableTabs }))
)
const PersistentTerminalSessions = React.lazy(() =>
  import('@components/layout/PersistentTerminalSessions').then(m => ({ default: m.PersistentTerminalSessions }))
)
const CanvasDragLayer = React.lazy(() =>
  import('@components/layout/CanvasDragLayer').then(m => ({ default: m.CanvasDragLayer }))
)
const CreateSiteDialog = React.lazy(() =>
  import('@components/tabsite/CreateSiteDialog')
)
const DesktopSidebarPanel = React.lazy(() =>
  import('@components/context-space/DesktopSidebarPanel').then(m => ({ default: m.DesktopSidebarPanel }))
)
const DesktopHomePane = React.lazy(() =>
  import('@components/context-space/DesktopHomePane').then(m => ({ default: m.DesktopHomePane }))
)

const BrowserRecoveryOverlay: React.FC<{
  crawlspaceId: string
  spaceId: string
  tabScopeKey: string
  tabLookupItems: readonly ContextItem[]
  onCloseItem: (item: ContextItem) => void
}> = ({ crawlspaceId, spaceId, tabScopeKey, tabLookupItems, onCloseItem }) => {
  const viewId = useBrowserViewActivationIntent(crawlspaceId)
  const state = useBrowserViewActivationState(crawlspaceId, viewId)
  const item = useMemo(() => {
    if (!viewId) return null
    const tabKey = contextRegistry.buildTabKey('tabweb', viewId)
    return tabLookupItems.find(candidate => candidate.tabKey === tabKey) ?? null
  }, [tabLookupItems, viewId])

  if (!viewId || state.phase === 'idle') return null

  return (
    <div className="absolute inset-0 z-banner bg-background">
      <BrowserViewRecoveryPanel
        state={state}
        onRetry={() => {
          void retryBrowserViewActivation(crawlspaceId, viewId, {
            spaceId,
            selection: {
              tabScopeKey,
              tabKey: contextRegistry.buildTabKey('tabweb', viewId),
            },
          })
        }}
        onClose={item ? () => onCloseItem(item) : undefined}
      />
    </div>
  )
}
/**
 * B1+B2：桌面模式空白态 fallback。
 * 当 sidebarMode='desktop'、没有任何 active pane（既没真实 tab 也没画板）时，
 * 在画布区显示桌面主页，避免桌面入口退回到 Space / Agent 设置语义。
 */

export interface SpaceContextAreaProps {
  workspaceLayerHost?: HTMLElement | null
  renderTabsOnly?: boolean
  hideTabsBar?: boolean
  sidebarPosition?: 'left' | 'right'
  shellCanvasVisible?: boolean
  /**
   * 本 scene 私有的桌面侧栏内容宿主节点（由 SpaceWorkbenchScene 提供）。
   * 传入时，桌面侧栏内容 portal 进该宿主，再由 scene 在 `<Activity>` 之外按 isForeground
   * 同步挂到全局侧栏槽位（PortalHostBridge），避免切 Space 时全局侧栏出现双份内容。
   * 未传入时回退到「前台直接 portal 进全局槽位」的旧行为（测试 / 非 scene 调用方）。
   */
  sidebarPortalHost?: HTMLElement | null
  /** 本 scene 私有的右侧「收起栏」宿主节点（对话模式画布折叠时用，机制同 sidebarPortalHost）。 */
  canvasRailPortalHost?: HTMLElement | null
}

export type { SidebarMode } from '@stores/useSpaceViewPrefsStore'

// ── 选 Space / Agent 目录已移除（Phase 2 去 Space 化）──
// 原 AgentMorePopover + SidebarHeader（左侧栏内联「选 Space 模块」）已删除。桌面是
// 跨 Space 共享的公共工作面，不做 Space 导航；选 / 切执行 Space 收口到对话面板执行区
// （ChatInput 的「执行于」→ SpaceSwitcherPopover）。
// 见 docs/prd/desktop-conversation-space-boundary.md §1.1 / §5。

// 选 Space / Agent 目录（SidebarHeader）已移除：见上方 Phase 2 去 Space 化说明。

export const SpaceContextArea: React.FC<SpaceContextAreaProps> = ({
  workspaceLayerHost,
  renderTabsOnly = false,
  hideTabsBar = false,
  sidebarPosition = 'left',
  shellCanvasVisible = true,
  sidebarPortalHost = null,
  canvasRailPortalHost = null,
}) => {
  const {
    spaceId,
    tabScopeKey,
    restoreSettled = true,
    activeTabKey,
    activeTabType,
    activeTableId,
    orderedItems,
    tabLookupItems,
    visibleItems,
    groupedTabKeys,
    canvasGroups,
    shouldShowCanvasGroup,
    activeCanvasGroupId,
    openTableTabs,
    groupedTableIds,
    terminalSessionIds,
    groupedTerminalIds,
    crawlspaceId,
    isCrawlspaceReady,
  } = useSpaceContextState()

  const {
    createHandlers,
    onOpenAppHome,
    onSelectHome,
    onSelectItem,
    onCloseItem,
    onRefreshItem,
    onCloseOtherItems,
    onCloseLeftItems,
    onCloseRightItems,
    onCloseOthersForGroup,
    onCloseLeftForGroup,
    onCloseRightForGroup,
    onReorderItem,
    onReopenClosedTab,
    onRestoreGroup,
    buildContentFromActiveTab,
    buildContentFromDrag,
  } = useSpaceContextActions()

  const { t } = useTranslation(['context', 'sidebar'])
  // 遥控器占位（取向 B）：当前客户端 ≠ Agent.control_device 时,执行设备型 App（终端/浏览器/
  // 手机/Agent 目录…）点开统一显示 RemoteAgentBanner,而不是各自报错/渲染失效内容。
  // isRemoteViewer 已在 hook 内收敛三态（isResolving 不闪 banner、无 control_device 自愈窗口不拦）。
  const {
    isRemoteViewer,
    isResolving: isRemoteResolving,
    controlDeviceName: remoteControlDeviceName,
    workingDir: remoteWorkingDir,
  } = useIsRemoteViewer(spaceId)
  const remoteAppLabel = useCallback((type: string): string | undefined => {
    const fallback = EXECUTION_DEVICE_APP_LABEL_FALLBACK[type]
    if (!fallback) return undefined
    return t(`remoteApp.${type}`, { defaultValue: fallback })
  }, [t])
  const sidebarContentPortal = useSidebarContentPortal()
  const canvasRailPortal = useCanvasRailPortal()
  const { canvas: topBarInsetLeft, canvasRight: topBarInsetRight } = useShellTopBarInset()
  const isImConversationScope = isImConversationScopeKey(tabScopeKey)
  const conversationSessionId = sessionIdFromConversationScopeKey(tabScopeKey)
  const isSharedSessionScope = useSessionAccessStore(state => Boolean(
    conversationSessionId && state.bySessionId[conversationSessionId],
  ))
  const isCloudDocsScope = isCloudDocsScopeKey(tabScopeKey)
  const topBarInsetStyle = (() => {
    const paddingLeft = topBarInsetLeft > 0 ? topBarInsetLeft + 8 : undefined
    const paddingRight = topBarInsetRight > 0 ? topBarInsetRight : undefined
    if (paddingLeft == null && paddingRight == null) return undefined
    return { paddingLeft, paddingRight }
  })()
  const { isForeground } = useSpaceActivity()
  const currentSpace = useSpaceStore(state => state.spaces.find(item => item.id === spaceId) ?? null)
  const organizationId = currentSpace?.organization_id ?? null
  const userId = useAuthStore(state => state.user?.id ?? null)
  const sidebarModeFromPrefs = useSpaceViewPrefsStore(state =>
    state.getSidebarMode(organizationId, userId),
  )
  const [sidebarMode, setSidebarModeLocal] = useState<SidebarMode>(sidebarModeFromPrefs ?? 'desktop')

  useLayoutEffect(() => {
    setSidebarModeLocal(sidebarModeFromPrefs ?? 'desktop')
  }, [sidebarModeFromPrefs])

  const sidebarLayoutRef = useRef<HTMLDivElement | null>(null)

  const activeTabParsed = useMemo(() => {
    if (!activeTabKey) return null
    return contextRegistry.parseTabKey(activeTabKey)
  }, [activeTabKey])
  const activeTerminalId = useMemo(() => {
    return activeTabParsed?.type === 'terminal' ? activeTabParsed.id : null
  }, [activeTabParsed])
  const activeContextItem = useMemo(() => (
    activeTabKey
      ? orderedItems.find(item => item.tabKey === activeTabKey) ?? null
      : null
  ), [activeTabKey, orderedItems])
  const activeAppHomeId = useMemo(() => {
    if (activeContextItem?.type !== 'apphome') return null
    const metaAppId = activeContextItem.meta?.appId
    return typeof metaAppId === 'string' ? metaAppId : activeContextItem.id
  }, [activeContextItem])

  // PRD §4.3 红线 #5：paneItems 必须用 visibleItems。
  // 若沿用 orderedItems，隐藏的 subagent_session（非当前 session）会继续挂载、
  // 计入 LRU 候选——其他 session 的 Pane 还在跑 effect，违反"隐藏不挂载"决策。
  const paneItems = useMemo(
    () => visibleItems.filter(item => {
      const h = contextRegistry.getHandler(item.type)
      return h?.renderPane && h.renderMode !== 'persistent'
    }),
    [visibleItems]
  )

  const activeCanvasTabKey = useMemo<CanvasTabKey | null>(() => {
    if (!activeTabKey) return null
    const delimiterIndex = activeTabKey.indexOf(':')
    if (delimiterIndex <= 0 || delimiterIndex >= activeTabKey.length - 1) return null
    return activeTabKey as CanvasTabKey
  }, [activeTabKey])

  const handleOpenDesktopAppHome = useCallback((appId: string) => {
    onOpenAppHome(appId)
  }, [onOpenAppHome])
  const handleSelectDesktopOpenTab = useCallback((item: typeof orderedItems[number]) => {
    onSelectItem(item)
  }, [onSelectItem])

  // replaceTabKey 会改变 item.tabKey，若直接用 tabKey 作 React key
  // 会导致组件卸载重建和闪烁。此处为每个 pane 维护稳定 key：
  // originTabKey 由 replaceTabKey 记录首次创建时的 tabKey，确保身份连续。
  const stableKeyMapRef = useRef(new Map<string, string>())
  const keepAliveLastActiveRef = useRef(new Map<string, number>())

  const MAX_KEEP_ALIVE_TABS = 10

  useEffect(() => {
    if (activeTabKey) {
      keepAliveLastActiveRef.current.set(activeTabKey, Date.now())
    }
  }, [activeTabKey])

  const paneItemsWithStableKey = useMemo(() => {
    const prevMap = stableKeyMapRef.current
    return paneItems.map(item => {
      const stableKey = item.originTabKey || prevMap.get(item.tabKey) || item.tabKey
      return { item, stableKey }
    })
  }, [paneItems])

  useEffect(() => {
    const nextMap = new Map<string, string>()
    for (const { item, stableKey } of paneItemsWithStableKey) {
      nextMap.set(item.tabKey, stableKey)
    }
    stableKeyMapRef.current = nextMap
  }, [paneItemsWithStableKey])

  const paneOverlays = useMemo(() => {
    if (paneItemsWithStableKey.length === 0) return null

    const lastActiveMap = keepAliveLastActiveRef.current
    // 区分驱逐候选 vs 免疫：keepAliveEvictionImmune 的 tab（如对话画板）不参与排序，
    // 永远留在挂载列表，避免重挂时丢失内部状态（滚动位置 / 折叠态等）。
    const keepAliveInactiveCandidates = paneItemsWithStableKey.filter(({ item }) => {
      if (!contextRegistry.isKeepAlive(item) || item.tabKey === activeTabKey) return false
      return !contextRegistry.isKeepAliveEvictionImmune(item)
    })

    const evictedKeys = new Set<string>()
    if (keepAliveInactiveCandidates.length >= MAX_KEEP_ALIVE_TABS) {
      const sorted = [...keepAliveInactiveCandidates].sort((a, b) =>
        (lastActiveMap.get(a.item.tabKey) ?? 0) - (lastActiveMap.get(b.item.tabKey) ?? 0),
      )
      const toEvict = sorted.slice(0, sorted.length - MAX_KEEP_ALIVE_TABS + 1)
      for (const { item } of toEvict) {
        evictedKeys.add(item.tabKey)
        lastActiveMap.delete(item.tabKey)
      }
    }

    return (
      <div className="pointer-events-none absolute inset-0">
        {paneItemsWithStableKey.map(({ item, stableKey }) => {
          const h = contextRegistry.getHandler(item.type)
          if (!h?.renderPane) return null
          const isActive = item.tabKey === activeTabKey
          if (!isActive && !contextRegistry.isKeepAlive(item)) return null
          if (!isActive && evictedKeys.has(item.tabKey)) return null
          // keepAlive tab：
          // - 默认 `<Activity mode="hidden">`：effect cleanup（避免 zombie 副作用）
          // - TabDoc 等声明 `keepAliveSuspendMode: 'visibility'`：仅 CSS 隐藏，
          //   不 cleanup Collab Provider / Y.Doc
          // handler 仍能通过 isPaneActive / isVisible props 表达更精细
          // 的「DOM 自带副作用」清理（如 video.pause()）。
          // Gate1（取向 B）：遥控器视角下,执行设备型 pane App（tabphone,以及 tabcode/tabfolder
          // 若以独立 pane tab 存在）统一替换为占位 banner,而不是渲染需要本机执行环境的内容。
          const remoteBlocked = isRemoteViewer && EXECUTION_DEVICE_APP_IDS.has(item.type)
          const useVisibilityKeepAlive = h.keepAliveSuspendMode === 'visibility'
          const paneBody = (
            <div
              className="absolute inset-0"
              aria-hidden={!isActive ? true : undefined}
              {...(!isActive && useVisibilityKeepAlive
                ? ({ inert: true } as React.HTMLAttributes<HTMLDivElement>)
                : {})}
              style={
                !isActive && useVisibilityKeepAlive
                  ? { visibility: 'hidden', pointerEvents: 'none' }
                  : { pointerEvents: 'auto' }
              }
            >
              <ErrorBoundary resetKeys={[item.tabKey]}>
                {remoteBlocked ? (
                  <RemoteAgentBanner
                    controlDeviceName={remoteControlDeviceName}
                    workingDir={remoteWorkingDir ?? undefined}
                    appLabel={remoteAppLabel(item.type)}
                  />
                ) : (
                  h.renderPane(item, {
                    spaceId,
                    tabScopeKey,
                    crawlspaceId,
                    isPaneActive: isActive,
                    isVisible: isActive,
                  })
                )}
              </ErrorBoundary>
            </div>
          )
          if (useVisibilityKeepAlive) {
            return <React.Fragment key={stableKey}>{paneBody}</React.Fragment>
          }
          return (
            <Activity key={stableKey} mode={isActive ? 'visible' : 'hidden'}>
              {paneBody}
            </Activity>
          )
        })}
      </div>
    )
  }, [activeTabKey, paneItemsWithStableKey, crawlspaceId, spaceId, tabScopeKey, isRemoteViewer, remoteControlDeviceName, remoteWorkingDir, remoteAppLabel])

  const shouldShowWorkspaceLayerFallback = shouldShowCanvasGroup || activeTabType === 'tabdata' || activeTabType === 'terminal'
  const workspaceLayerFallback = shouldShowWorkspaceLayerFallback ? (
    <div className="absolute inset-0 flex items-center justify-center text-body text-muted-foreground">
      {t('organization.initializing')}
    </div>
  ) : null

  // 遥控器视角 + 当前 active tab 是执行设备型 App（terminal/tabweb/tabdesktop/tabphone…）：
  // 主区走 RemoteAgentBanner 占位（见下）,需让常驻渲染层（workspaceLayerHost crawlspace）让位,
  // 否则 absolute 的 portal-host 会盖住 banner。
  const activeIsExecutionDevice =
    !!activeTabParsed?.type && EXECUTION_DEVICE_APP_IDS.has(activeTabParsed.type)
  const isRemoteBlockedActive = isRemoteViewer && activeIsExecutionDevice
  // device store 解析中（isResolving）：对执行设备型 active tab 先显示骨架,避免真实内容/原生层
  // 闪现后再翻成 banner（与 orchestration 的 resolving→骨架 对齐;也收窄 tabweb 原生 view 暴露窗口）。
  const isRemoteResolvingActive = isRemoteResolving && activeIsExecutionDevice

  let mainContent: React.ReactNode = null

  if (!shouldShowCanvasGroup) {
    const handler = activeTabParsed ? contextRegistry.getHandler(activeTabParsed.type) : null
    // Gate2/Gate3（取向 B）：遥控器视角下,执行设备型 App 的主区统一显示占位 banner。
    // 一处覆盖两类:① persistent 型（terminal/tabweb——其常驻层 workspaceLayerHost /
    // PersistentTerminalSessions 在下方一并抑制,避免盖住 banner）；② 无 handler 型
    //（tabdesktop 在 renderer 没注册 context handler,否则会落到下面「已下架」分支显示错误占位。
    // 注:tabdesktop 当前无创建入口、开不出 tab,此分支对它是防御性兜底,将来有入口即自动覆盖）。
    // pane 型（tabphone 等）不在此拦——走 paneOverlays 内 Gate1,以保留同屏其它 pane tab 的 keepAlive。
    const isPaneHandler = !!handler?.renderPane && handler.renderMode !== 'persistent'
    if ((isRemoteBlockedActive || isRemoteResolvingActive) && !isPaneHandler && activeTabParsed) {
      mainContent = (
        <RemoteAgentBanner
          isResolving={isRemoteResolvingActive && !isRemoteBlockedActive}
          controlDeviceName={remoteControlDeviceName}
          workingDir={remoteWorkingDir ?? undefined}
          appLabel={remoteAppLabel(activeTabParsed.type)}
        />
      )
    } else if (handler?.renderMode === 'persistent') {
      if (activeTabParsed?.type === 'tabweb' && !isCrawlspaceReady) {
        mainContent = (
          <div className="h-full w-full flex items-center justify-center text-body text-muted-foreground">
            {t('organization.initializing')}
          </div>
        )
      }
    } else if (activeTabParsed && !handler) {
      // 单根契约 §2.6 P0 修复：HIDDEN_APPS 命中（如 TabSite 下架）后 handler
      // 不再注册，但用户老 tab 持久化里仍有该 type → mainContent 之前 null →
      // 主区一片空白，用户没任何引导。改为显示"应用已下架"占位 + 关闭按钮。
      const deprecatedAppId = activeTabParsed.type
      mainContent = (
        <div className="h-full w-full flex flex-col items-center justify-center gap-3 text-body text-muted-foreground/80">
          <div className="text-subtitle font-medium text-foreground/80">
            {t('context.deprecatedAppTitle', { defaultValue: '此应用已下架' })}
          </div>
          <p className={cn('max-w-[420px] text-center', CANVAS_TEXT_SECONDARY)}>
            {t('context.deprecatedAppDesc', {
              app: deprecatedAppId,
              defaultValue: `"${deprecatedAppId}" 已从当前版本下架。这个标签页的内容暂时无法显示——你可以关闭它继续工作。`,
            })}
          </p>
          {activeContextItem && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => onCloseItem(activeContextItem)}
              className="gap-1.5"
            >
              {t('context.deprecatedAppClose', { defaultValue: '关闭这个标签页' })}
            </Button>
          )}
        </div>
      )
    }
  }

  /**
   * B1+B2：桌面模式下空白态 fallback。
   * 触发条件（必须同时满足）：
   *   - sidebarMode='desktop'
   *   - activeTabType='home'（没有真实 active tab、没停在虚拟桌面 surface）
   *   - !shouldShowCanvasGroup（不在 canvasGroup 渲染中）
   *   - **真的没有任何真实 tab**（orderedItems 排除虚拟系统标签后为空）
   *
   * 最后一条是关键的"防 cold-start race"判断：
   *   重启时 store.activeKey 持久化恢复（比如指向 tabweb tabKey），
   *   但 main 进程的 view list 还在恢复中，syncTabOrder 会把 active 暂时降级到 'home'。
   *   如果只看 activeTabType，这一瞬间会错误地 fallback 到桌面空态，
   *   覆盖掉用户期望恢复的 active tab。加 hasNoRealTab 后，
   *   只有真的没有任何 tab 持久化时才显示桌面应用列表 fallback。
   *
   * 渲染：DesktopHomePane（桌面主页）。
   * 用 absolute 叠加在 contentPane 内部，不替换 mainContent —— 保留 paneOverlays / persistent
   * 层的挂载状态（keepAlive 等）。
   */
  const hasNoRealTab = useMemo(
    () => orderedItems.every(item => item.type === DESKTOP_TAB_TYPE),
    [orderedItems],
  )
  // IM 的主任务是收发消息；会话资产只在用户实际打开后才占用画布。
  // 不论用户此前选的是桌面还是对话侧栏，都不能在空画布回退到应用/任务工作台。
  const isEmptyImConversationCanvas =
    isImConversationScope &&
    (activeTabType === 'home' || activeTabType === DESKTOP_TAB_TYPE)
  const navigationIntent = getNavigationIntent(tabScopeKey)
  const userOpenedWorkbenchHome =
    navigationIntent?.writer === 'user' &&
    navigationIntent.reason === 'openHome' &&
    navigationIntent.targetKey === null
  const showDesktopBlankFallback =
    restoreSettled &&
    !isCloudDocsScope &&
    !isEmptyImConversationCanvas &&
    !isSharedSessionScope &&
    !shouldShowCanvasGroup &&
    sidebarMode === 'desktop' &&
    activeTabType === 'home' &&
    hasNoRealTab
  const showConversationWorkbenchHome =
    (restoreSettled || userOpenedWorkbenchHome) &&
    !isCloudDocsScope &&
    !isEmptyImConversationCanvas &&
    !isSharedSessionScope &&
    !shouldShowCanvasGroup &&
    sidebarMode === 'conversations' &&
    activeTabType === 'home'
  const shouldShowShellCanvasGroup = shellCanvasVisible && shouldShowCanvasGroup

  const contentContainerClass = cn(
    'relative flex-1 w-full overflow-hidden no-drag min-w-0 bg-transparent',
  )
  const tabOverlayContainerRef = useRef<HTMLDivElement>(null)

  // ====== 内容渲染区域 ======
  const contentPane = (
    <OverlayContainerProvider containerRef={tabOverlayContainerRef}>
      <div
        ref={tabOverlayContainerRef}
        className={contentContainerClass}
        data-canvas-content-root="true"
      >
        {workspaceLayerHost && (
          // portal-host 视觉/交互互斥层（工具类，不是"挂载但隐藏"业务模式）：
          // 这一层只用 StableSlot 把 SpaceWorkbenchHost 创建的 workspaceLayerHost
          // div 物理挂在 contentPane 内的对应位置。
          //
          // **effect 生命周期（不归本层管）**：
          //   CrawlspaceWorkspace 的 React 树父级在 SpaceWorkbenchHost 的内层
          //   Activity 子树里——effect 调度由 SpaceWorkbenchHost 的
          //   `<Activity mode={(workspaceLayerVisible && !isCanvasMode) ? ...}>`
          //   控制（"切到非 tabweb tab" 与 "在 tabweb 上启用 canvas group" 两类
          //   让位场景都已覆盖）。
          //
          // **本层职责（DOM 视觉互斥 + pointer-event 让位）**：
          //   - canvas mode 时整个 portal-host wrapper `display:none`，让位给底层
          //     兄弟 PersistentCanvasGroups（双保险：除了 React Activity 的 hidden
          //     视觉收口，DOM 上再叠一层 display:none，不依赖 React runtime 的
          //     hidden 实现细节）
          //   - 非 tabweb 类型 active tab 时 `pointer-events:none`，避免 portal
          //     占位层吞掉鼠标事件遮挡底下的 table / terminal pane
          <div
            className="absolute inset-0"
            style={{
              // 遥控器视角下,执行设备型 App（tabweb/tabdesktop 等走 crawlspace 的）隐藏 portal-host,
              // 让位给 mainContent 的 RemoteAgentBanner 占位（Gate3）。
              display: (shouldShowCanvasGroup || isRemoteBlockedActive || isRemoteResolvingActive) ? 'none' : 'block',
              pointerEvents: activeTabParsed?.type === 'tabweb' ? 'auto' : 'none'
            }}
          >
            <StableSlot host={workspaceLayerHost} className="h-full w-full" />
          </div>
        )}
        <React.Suspense fallback={workspaceLayerFallback}>
          {canvasGroups.length > 0 ? (
            <PersistentCanvasGroups
              groups={canvasGroups}
              activeGroupId={isForeground && shouldShowShellCanvasGroup ? activeCanvasGroupId : null}
              crawlspaceId={crawlspaceId}
              className="h-full w-full"
            />
          ) : null}
          {openTableTabs.length > 0 ? (
            <PersistentTableTabs
              tableIds={openTableTabs}
              activeTableId={!shouldShowCanvasGroup ? activeTableId : null}
              excludeTableIds={groupedTableIds}
              className="h-full w-full"
            />
          ) : null}
          {/* Gate2（取向 B）：遥控器视角下不在本机挂载终端常驻层——终端应跑在 control_device 上,
              本机只显示 mainContent 的 RemoteAgentBanner 占位。 */}
          {!isRemoteViewer && terminalSessionIds.length > 0 ? (
            <PersistentTerminalSessions
              sessionIds={terminalSessionIds}
              activeSessionId={!shouldShowCanvasGroup ? activeTerminalId : null}
              excludeSessionIds={groupedTerminalIds}
              className="h-full w-full"
            />
          ) : null}
          <CanvasDragLayer
            spaceId={tabScopeKey}
            contentRootRef={tabOverlayContainerRef}
            activeTabKey={activeCanvasTabKey}
            isHomeActive={activeTabType === 'home'}
            spaceGroups={canvasGroups}
            shouldShowCanvasGroup={shouldShowShellCanvasGroup}
            buildContentFromActiveTab={buildContentFromActiveTab}
            buildContentFromDrag={buildContentFromDrag}
          />
        </React.Suspense>
        {!shouldShowCanvasGroup && paneOverlays}
        {!shouldShowCanvasGroup && mainContent}
        {(showDesktopBlankFallback || showConversationWorkbenchHome) && (
          <div className="absolute inset-0 bg-transparent overflow-hidden">
            <React.Suspense
              fallback={
                <div className="flex h-full w-full items-center justify-center text-body text-muted-foreground/60">
                  {t('organization.initializing')}
                </div>
              }
            >
              <DesktopHomePane
                variant={showConversationWorkbenchHome ? 'task-workbench' : 'apps'}
              />
            </React.Suspense>
          </div>
        )}
        {crawlspaceId ? (
          <BrowserRecoveryOverlay
            crawlspaceId={crawlspaceId}
            spaceId={spaceId}
            tabScopeKey={tabScopeKey}
            tabLookupItems={tabLookupItems}
            onCloseItem={onCloseItem}
          />
        ) : null}
      </div>
    </OverlayContainerProvider>
  )
  const siteDialog = (
    <React.Suspense fallback={null}>
      <CreateSiteDialog />
    </React.Suspense>
  )

  // 工作台由固定标签承载（桌面 / 普通对话）；「更多应用」是独立 apphome 标签。
  const tabBarModel = useMemo(() => buildWorkbenchTabBarModel({
    visibleItems,
    sidebarMode,
    isImConversationScope,
    isSharedSessionScope,
    activeTabType,
    canCollapseHomeToChatFocus: isConversationScopeKey(tabScopeKey),
  }), [activeTabType, isImConversationScope, isSharedSessionScope, sidebarMode, tabScopeKey, visibleItems])
  const tabBarItems = tabBarModel.items
  const tabBarLookupItems = tabLookupItems
  const handleSelectHome = useCallback(() => {
    if (sidebarMode === 'desktop') {
      useWorkbenchSurfaceStore.getState().setLastActiveSurface(tabScopeKey, 'desktop')
    } else if (sidebarMode === 'conversations') {
      // 对话工作台走 activeTabType=home 的 DesktopHomePane 叠层，勿切到 desktop surface。
      useWorkbenchSurfaceStore.getState().setLastActiveSurface(tabScopeKey, 'real_tab')
    }
    onSelectHome()
  }, [onSelectHome, sidebarMode, tabScopeKey])
  const handleCloseHome = useCallback(() => {
    // 关工作台 ≡ 对话聚焦（与 TaskViewModeSwitch 最左侧一致）
    const prevMode = useSpaceViewPrefsStore.getState().getTaskViewMode(tabScopeKey)
    captureTaskViewModeMorph(prevMode, 'chat-focus')
    useSpaceViewPrefsStore.getState().setTaskViewModeForScope(tabScopeKey, 'chat-focus')
  }, [tabScopeKey])

  const shouldShowHomeTab = tabBarModel.showHome
  const tabsProps = {
    activeTabKey,
    isHomeActive: tabBarModel.isHomeActive,
    showHome: shouldShowHomeTab,
    homeClosable: tabBarModel.homeClosable,
    homeLabel: shouldShowHomeTab
      ? t('canvasRail.apps', { defaultValue: '工作台' })
      : undefined,
    // PRD §4.3 红线 #5：标签栏渲染必须用 visibleItems（这里再去掉虚拟画板）。
    // 隐藏的 subagent_session（非当前 session）在 tabOrder 持久化里仍存在，
    // 但用户不应在 UI 上看到——切回对应 session 才显示。
    items: tabBarItems,
    // lookup 包含当前上下文可见的 grouped panes，但不扩大标签栏渲染集合。
    allItems: tabBarLookupItems,
    registry: contextRegistry,
    onSelectHome: handleSelectHome,
    onCloseHome: tabBarModel.homeClosable ? handleCloseHome : undefined,
    onSelectItem,
    onCloseItem,
    onRefreshItem,
    onCloseOtherItems,
    onCloseLeftItems,
    onCloseRightItems,
    onCloseOthersForGroup,
    onCloseLeftForGroup,
    onCloseRightForGroup,
    onCreateWebTab: createHandlers.tabweb,
    onReopenClosedTab,
    onReorderItem,
    onRestoreGroup,
    groupedTabKeys,
    canvasGroups,
  } as const

  if (renderTabsOnly) {
    return (
      <>
        <div className="w-full min-w-0">
          <ContextTabs {...tabsProps} />
        </div>
        {siteDialog}
      </>
    )
  }

  if (hideTabsBar) {
    return (
      <>
        <div className="h-full w-full flex flex-col overflow-hidden min-w-0">
          <div className="flex-1 min-h-0 flex overflow-hidden min-w-0">
            {contentPane}
          </div>
        </div>
        {siteDialog}
      </>
    )
  }

  const shouldRenderTopTabs = tabBarModel.shouldRender
  const shouldUseGlobalSidebarFrame = sidebarContentPortal.enabled && sidebarPosition === 'left' && isForeground
  const desktopSidebarContent = (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <React.Suspense fallback={null}>
        <DesktopSidebarPanel
          activeAppHomeId={activeAppHomeId}
          onOpenAppHome={handleOpenDesktopAppHome}
          onSelectOpenTab={handleSelectDesktopOpenTab}
        />
      </React.Suspense>
    </div>
  )

  // 桌面侧栏内容的 portal 目标：
  //  - 提供了 sidebarPortalHost（scene 私有宿主）→ 恒定 portal 进宿主（不看 isForeground），
  //    由 scene 在 Activity 外按 isForeground 同步把宿主挂/摘全局槽位（修双份闪烁）。
  //  - 未提供 → 回退旧行为：仅前台直接 portal 进全局槽位。
  const sidebarPortalTarget = sidebarPortalHost ?? (isForeground ? sidebarContentPortal.target : null)
  const sidebarPortal =
    sidebarContentPortal.enabled
    && sidebarPosition === 'left'
    && sidebarMode === 'desktop'
    && sidebarPortalTarget
      ? createPortal(desktopSidebarContent, sidebarPortalTarget)
      : null

  // 对话模式画布折叠时的右侧收起栏——机制同左侧栏（scene 私有宿主优先，回退前台全局槽位）。
  // enabled 由 shell 判定（对话模式 + 画布折叠 + 选中真实 Space），这里只负责把内容投递过去。
  const canvasRailTarget = canvasRailPortalHost ?? (isForeground ? canvasRailPortal.target : null)
  const canvasRailNode =
    canvasRailPortal.enabled && sidebarPosition === 'left' && canvasRailTarget
      ? createPortal(
          <CollapsedCanvasRail expandCanvas={canvasRailPortal.expandCanvas} />,
          canvasRailTarget,
        )
      : null

  if (shouldUseGlobalSidebarFrame) {
    return (
      <>
        {sidebarPortal}
        {canvasRailNode}
        <div
          ref={sidebarLayoutRef}
          className="h-full w-full flex flex-col overflow-hidden min-w-0"
        >
          {shouldRenderTopTabs ? (
            <div
              className={cn(
                'relative z-banner flex flex-shrink-0 items-center gap-1.5 min-w-0 w-full bg-transparent border-b border-border/60',
                SHELL_WORKBENCH_TOP_BAR_HEIGHT_CLASS,
              )}
              style={topBarInsetStyle}
            >
              <div className="min-w-0 flex-1">
                {shouldRenderTopTabs ? <ContextTabs {...tabsProps} /> : null}
              </div>
            </div>
          ) : null}
          {contentPane}
        </div>
        {siteDialog}
      </>
    )
  }

  return (
    <>
      {sidebarPortal}
      {canvasRailNode}
      <div
        ref={sidebarLayoutRef}
        className="h-full w-full flex flex-col overflow-hidden min-w-0"
      >
        {shouldRenderTopTabs ? (
          <div
            className={cn(
              'relative z-banner flex flex-shrink-0 items-center min-w-0 w-full bg-transparent border-b border-border/60',
              SHELL_WORKBENCH_TOP_BAR_HEIGHT_CLASS,
            )}
            style={topBarInsetStyle}
          >
            <div className="min-w-0 flex-1">
              {shouldRenderTopTabs ? <ContextTabs {...tabsProps} /> : null}
            </div>
          </div>
        ) : null}
        {contentPane}
      </div>
      {siteDialog}
    </>
  )
}

SpaceContextArea.displayName = 'SpaceContextArea'
