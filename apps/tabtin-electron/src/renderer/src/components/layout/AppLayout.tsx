import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft } from 'lucide-react'
import { ThemeProvider } from '@/components/theme/ThemeProvider'
import { useUIStore } from '@stores/useUIStore'
import { useMainNavStore } from '@stores/useMainNavStore'
import { MembershipExpiredBanner } from '@components/billing/MembershipExpiredBanner'
import { OrganizationMembershipNoticeDialogHost } from '@components/organization/OrganizationMembershipNoticeDialogHost'
import { UploadNotificationPanel } from '@components/common/UploadNotificationPanel'
import {
  ExternalImportWizardHost,
  ImportProgressPanel,
} from '@components/onboarding/external-import'
import { FeishuImportProgressPanel } from '@components/context-space/feishu/FeishuImportProgressPanel'
import { RelationScanProgressPanel } from '@components/context-space/relation-scan'
import { UpdatePromptDialog } from '@components/common/UpdatePromptDialog'
import { useAuthStore, selectIsAuthenticated } from '@stores/useAuthStore'
import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'
import { useSpaceViewPrefsStore } from '@stores/useSpaceViewPrefsStore'
import { useChatStore } from '@stores/chat/useChatStore'
import { useSpaceListLifecycle } from '@components/sidebar/useSpaceListLifecycle'
import {
  isOrganizationAccessBlockedFor,
  useWsConnectionStore,
} from '@/stores/useWsConnectionStore'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import { useSpaceListStore } from '@stores/useSpaceListStore'
import { useSpaceStore } from '@stores/useSpaceStore'
import { useShellLayoutState } from './useShellLayoutState'
import { useEnsureCloudDocsHomeTab } from './cloudDocsDomain'
import { useShellRuntimeEffects } from './useShellRuntimeEffects'
import { ShellSidePanelContent } from './ShellSidePanelContent'
import { AgentChatCapsuleHost } from '@components/chat/capsule/AgentChatCapsuleHost'
// 常驻窄栏 / 顶栏静态引入：lazy + fallback null 会让登录后首帧闪空。
import { ActivityRail } from './ActivityRail'
import { ShellTopBar } from './ShellTopBar'
import { ShellTopBarInsetContext, type ShellTopBarInset } from './shellTopBarInset'
import { dispatchCrawlViewLayoutChange } from '@/utils/crawl-view-bounds'
import { useWindowFullScreen } from '@/hooks/useWindowFullScreen'
import {
  resolveCanvasRailIconOnly,
  resolveTaskLayoutState,
} from './taskLayoutState'
import {
  allowsLegacyCanvasFocus,
  resolveUnifiedAppPageModuleFlags,
  shouldClearLegacyCanvasFocus,
  shouldRenderUnifiedSecondary,
} from './appLayoutState'
import { StableSlot, useStablePortalHost } from '@/utils/portal-host'
import { WorkbenchLifecycleProvider } from './WorkbenchLifecycleContext'
import { useWorkbenchSceneStore } from '@/stores/useWorkbenchSceneStore'
import { SidebarContentPortalProvider } from './SidebarContentPortalContext'
import { CanvasRailPortalProvider } from './CanvasRailPortalContext'
import { ImConversationCanvasProvider } from '@components/tabchat/ImConversationCanvasContext'
import {
  ShellChatCanvasSplit,
  ShellSpaceWorkspaceSplit,
  SHELL_CONVERSATION_CANVAS_MIN_WIDTH,
  SHELL_WORKBENCH_MIN_WIDTH,
} from './ShellResizableSplits'
import {
  SHELL_CANVAS_CARD_CLASS,
  SHELL_COLLAPSED_CANVAS_RAIL_ICON_WIDTH,
  SHELL_COLLAPSED_CANVAS_RAIL_WIDTH,
} from './shellUi'
import {
  resolveWorkspaceContextState,
  shouldReadCanvasCollapsedPreference,
} from './workspaceContextState'
import { useAppPageStore } from '@stores/useAppPageStore'
import { createLogger } from '@/utils/logger'
import { useProjectWorkspaceSelectionStore } from './projectWorkspaceSelectionStore'
import {
  DraftTaskWorkspaceHeader,
  resolveTaskHeaderAgentName,
  TaskWorkspaceHeader,
} from './TaskWorkspaceHeader'
import { TaskViewModeSwitch } from './TaskViewModeSwitch'
import { dedupePersistedTabDocScopes } from '@components/context-space/tabdoc/tabdocScopeDedupe'

/** 工作区右上角三态切换 overlay 宽度（约 100px）+ right-4，给画布顶栏 ContextTabs 留白。 */
const TASK_VIEW_MODE_SWITCH_CANVAS_RIGHT_INSET_PX = 112
const log = createLogger('IMCanvasLayout')

const SpaceSidebarGlobal = React.lazy(
  () => import('./SpaceSidebarGlobal').then(m => ({ default: m.SpaceSidebarGlobal }))
)
const NewUserOrganizationOnboardingLayer = React.lazy(() =>
  import('@components/onboarding/NewUserOrganizationOnboardingLayer').then(m => ({
    default: m.NewUserOrganizationOnboardingLayer,
  }))
)
const GlobalAgentSettingsSheetHost = React.lazy(() =>
  import('@components/space-settings/GlobalAgentSettingsSheetHost').then(m => ({
    default: m.GlobalAgentSettingsSheetHost,
  }))
)
const GlobalSpaceAgentDialogHost = React.lazy(() =>
  import('@components/sidebar/GlobalSpaceAgentDialogHost').then(m => ({
    default: m.GlobalSpaceAgentDialogHost,
  }))
)
const AppCollaborationDialogHost = React.lazy(() =>
  import('./AppCollaborationDialogHost').then(m => ({
    default: m.AppCollaborationDialogHost,
  }))
)

interface PersistHydrationApi {
  hasHydrated?: () => boolean
  onFinishHydration?: (cb: () => void) => (() => void) | void
}

const uiStorePersistApi = (useUIStore as unknown as { persist?: PersistHydrationApi }).persist
const spaceViewPrefsPersistApi =
  (useSpaceViewPrefsStore as unknown as { persist?: PersistHydrationApi }).persist
const spaceContextTabsPersistApi =
  (useSpaceContextTabsStore as unknown as { persist?: PersistHydrationApi }).persist
const PERSIST_HYDRATION_TIMEOUT_MS = 1500

function usePersistHydrated(persistApi?: PersistHydrationApi): boolean {
  const [hydrated, setHydrated] = useState(() => persistApi?.hasHydrated?.() ?? true)

  useEffect(() => {
    if (hydrated) return
    if (persistApi?.hasHydrated?.()) {
      setHydrated(true)
      return
    }
    return persistApi?.onFinishHydration?.(() => setHydrated(true))
  }, [hydrated, persistApi])

  useEffect(() => {
    if (hydrated || !persistApi) return

    const timeoutId = window.setTimeout(() => {
      if (persistApi.hasHydrated?.()) return
      console.warn('[AppLayout] persist hydration timed out; falling back to interactive layout')
      setHydrated(true)
    }, PERSIST_HYDRATION_TIMEOUT_MS)

    return () => window.clearTimeout(timeoutId)
  }, [hydrated, persistApi])

  return hydrated
}

// SettingsSidebar 已退役——新 IA 下「我的」是 SpaceSidebarGlobal 内的一个 tab，
// 侧栏内容由 SidebarMePanel 渲染（同 SpaceSidebarGlobal 树内），不再需要顶层切换。
const ContentArea = React.lazy(
  () => import('./ContentArea').then(m => ({ default: m.ContentArea }))
)

const GUEST_AUTH_SIDEBAR_WIDTH = 380
const TOAST_VIEWPORT_CENTER_X_VAR = '--tabtin-toast-viewport-center-x'
const TOAST_VIEWPORT_WIDTH_VAR = '--tabtin-toast-viewport-width'

function useToastViewportAnchor(anchor: HTMLElement | null) {
  const refreshRef = useRef<() => void>(() => {})
  const refresh = useCallback(() => {
    refreshRef.current()
  }, [])

  useEffect(() => {
    if (typeof document === 'undefined') return

    const root = document.documentElement
    const clear = () => {
      root.style.removeProperty(TOAST_VIEWPORT_CENTER_X_VAR)
      root.style.removeProperty(TOAST_VIEWPORT_WIDTH_VAR)
    }

    if (!anchor || typeof window === 'undefined') {
      clear()
      return
    }

    let rafId: number | null = null
    const update = () => {
      rafId = null
      const rect = anchor.getBoundingClientRect()
      if (rect.width <= 2 || rect.height <= 2) {
        clear()
        return
      }
      root.style.setProperty(TOAST_VIEWPORT_CENTER_X_VAR, `${Math.round(rect.left + rect.width / 2)}px`)
      root.style.setProperty(TOAST_VIEWPORT_WIDTH_VAR, `${Math.round(rect.width)}px`)
    }
    const schedule = () => {
      if (rafId != null) return
      rafId = window.requestAnimationFrame(update)
    }
    refreshRef.current = schedule

    schedule()
    const resizeObserver = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(schedule)
      : null
    resizeObserver?.observe(anchor)
    window.addEventListener('resize', schedule)

    return () => {
      if (rafId != null) window.cancelAnimationFrame(rafId)
      resizeObserver?.disconnect()
      window.removeEventListener('resize', schedule)
      refreshRef.current = () => {}
      clear()
    }
  }, [anchor])

  return refresh
}

export const AppLayout: React.FC = () => {
  useShellRuntimeEffects()
  const { isInitialAgentDataLoading } = useSpaceListLifecycle()
  const organizationAccessBlocked = useWsConnectionStore(
    (state) => state.organizationAccessBlocked,
  )
  const organizationAccessBlockedId = useWsConnectionStore(
    (state) => state.organizationAccessBlockedId,
  )
  const selectedOrganizationId = useOrganizationStore(
    (state) => state.selectedOrganization?.id ?? null,
  )
  const isSelectedOrganizationAccessBlocked = isOrganizationAccessBlockedFor(
    organizationAccessBlocked,
    organizationAccessBlockedId,
    selectedOrganizationId,
  )
  // 新 IA：「我的」tab 选中替代旧的 Settings 全屏。命名保持 isSettingsOpen
  // 因为下游一堆变量名 / props 都基于这个，整体重命名风险大；语义上
  // 等价于"主画布被 me 工作台占用"。
  const isSettingsOpen = useMainNavStore(state => state.currentTab === 'me')
  const isAuthenticated = useAuthStore(selectIsAuthenticated)
  const currentUserId = useAuthStore(state => state.user?.id ?? null)

  // useShellLayoutState 已按 isAuthenticated 门控：未登录态统一返回 welcome / 关闭聊天
  // rail，所以下面这些值在访客态已是安全兜底，主画布与右侧 rail 共享同一语义。
  const {
    chatPanelEnabled,
    sidePanelMode,
    workbenchMode,
    workbenchSpaceContext,
    sidebarSpaceContext,
    placeholderKind,
    layoutScopeKey,
    imConversationId,
  } = useShellLayoutState()
  const selectedSpaceKind = useSpaceListStore(state => state.selectedSpaceKind)
  const selectedSpace = useSpaceStore(state => state.selectedSpace)
  const spaces = useSpaceStore(state => state.spaces)
  const agentCache = useSpaceStore(state => state.agentCache)
  const selectedAgent = useSpaceStore(state => state.selectedAgent)
  const selectedProjectId = useProjectWorkspaceSelectionStore(state => state.selectedProjectId)
  const activeAppPage = useAppPageStore(state => state.activePage)
  const syncForegroundSpace = useWorkbenchSceneStore(state => state.syncForegroundSpace)
  const clearForegroundScene = useWorkbenchSceneStore(state => state.clearForegroundScene)
  const sidebarCollapsed = useUIStore(state => state.sidebarCollapsed)
  // 未登录态的核心入口就是左侧登录表单，不能继承工作台里的侧栏折叠偏好。
  // 折叠态顶部还会被窗口拖拽区覆盖，导致展开按钮在未登录页不可点。
  const effectiveSidebarCollapsed = isAuthenticated && sidebarCollapsed
  const isProjectWorkbench =
    workbenchMode === 'app-page' && activeAppPage === 'project'
  const projectSpaceContext = useMemo(() => {
    if (!isProjectWorkbench) return null
    const organizationId = sidebarSpaceContext?.organization_id ?? selectedSpace?.organization_id ?? null
    const teamSpaces = spaces.filter(space => (
      space.type === 'team_space' &&
      !space.is_archived &&
      (!organizationId || space.organization_id === organizationId)
    ))
    if (!selectedProjectId) return null
    return teamSpaces.find(space => space.id === selectedProjectId) ?? null
  }, [isProjectWorkbench, selectedProjectId, selectedSpace?.organization_id, sidebarSpaceContext?.organization_id, spaces])
  const shellChatSpaceContext = isProjectWorkbench
    ? projectSpaceContext
    : workbenchSpaceContext

  useEffect(() => {
    if (isProjectWorkbench) {
      if (projectSpaceContext?.id) {
        syncForegroundSpace(projectSpaceContext.id)
      } else {
        clearForegroundScene()
      }
      return
    }
    if (workbenchMode === 'im-chat' && workbenchSpaceContext?.id) {
      syncForegroundSpace(workbenchSpaceContext.id)
      return
    }
    if (selectedSpaceKind === 'workspace' && selectedSpace?.id) {
      syncForegroundSpace(selectedSpace.id)
      return
    }
    clearForegroundScene()
  }, [clearForegroundScene, isProjectWorkbench, projectSpaceContext?.id, selectedSpace?.id, selectedSpaceKind, syncForegroundSpace, workbenchMode, workbenchSpaceContext?.id])

  // 右侧 Agent 面板状态
  const chatSidePanelWidth = useUIStore(state => state.chatSidePanelWidth)
  const setChatSidePanelWidth = useUIStore(state => state.setChatSidePanelWidth)
  const canvasSidePanelWidth = useUIStore(state => state.canvasSidePanelWidth)
  const setCanvasSidePanelWidth = useUIStore(state => state.setCanvasSidePanelWidth)
  const chatSidePanelCollapsed = useUIStore(state => state.chatSidePanelCollapsed)
  const toggleChatSidePanel = useUIStore(state => state.toggleChatSidePanel)
  const setChatSidePanelCollapsed = useUIStore(state => state.setChatSidePanelCollapsed)
  const currentSessionId = useChatStore(state => state.currentSessionId)
  const sessionsBySpaceId = useChatStore(state => state.sessionsBySpaceId)
  const trackerRunSessionsBySpaceId = useChatStore(state => state.trackerRunSessionsBySpaceId)
  const getSessionById = useChatStore(state => state.getSessionById)
  const messagesBySessionId = useChatStore(state => state.messagesBySessionId ?? {})
  const draftSessionBySpaceId = useChatStore(state => state.draftSessionBySpaceId)
  /**
   * Phase 2：根据 SidebarMode 决定 chat / canvas 在 shell 中的左右顺序。
   * - 'conversations'：[侧栏][聊天][画布] —— 聊天主位（多对话协作）
   * - 'desktop'：[侧栏][画布][聊天] —— 画布主位（浏览内容 + 聊天辅助）
   *
   * Phase 5：sidebarMode 按 Organization+User 记忆，不再 per-Space 串台。
   */
  const sidebarMode = useSpaceViewPrefsStore(state =>
    state.getSidebarMode(
      workbenchSpaceContext?.organization_id ?? sidebarSpaceContext?.organization_id ?? null,
      currentUserId,
    ),
  )
  // 「应用」桌面默认不携带任务对话；但用户主动进入「消息」时，IM 是
  // 当前工作空间旁的明确沟通面，不能再被 desktop 偏好静默隐藏。
  const layoutChatPanelEnabled =
    chatPanelEnabled && !(workbenchMode === 'space' && sidebarMode === 'desktop' && sidePanelMode !== 'im')
  const workspaceContext = useMemo(() => resolveWorkspaceContextState({
    workbenchMode,
    sidebarMode,
    organizationId: workbenchSpaceContext?.organization_id ?? sidebarSpaceContext?.organization_id ?? null,
    userId: currentUserId,
    executionSpaceId: workbenchSpaceContext?.id ?? null,
    sessionId: currentSessionId,
    imConversationId,
  }), [
    currentSessionId,
    imConversationId,
    currentUserId,
    sidebarMode,
    sidebarSpaceContext?.organization_id,
    workbenchMode,
    workbenchSpaceContext?.id,
    workbenchSpaceContext?.organization_id,
  ])
  useEnsureCloudDocsHomeTab({
    workbenchMode,
    tabScopeKey: workspaceContext.kind === 'cloud-docs' ? workspaceContext.key : null,
  })
  const chatPosition: 'middle' | 'right' = workspaceContext.legacyChatPosition
  const ensureScopeInitializedFromLegacy = useSpaceContextTabsStore(state => state.ensureScopeInitializedFromLegacy)
  // 仅 desktop←space 做空桶初始化。conversation←draft 禁止在「进入已有会话」时拷贝
  // （会把草稿里的工作空间管理等系统页污染正式会话画布，）。
  // 草稿首发转正的标签迁移只走 useChatCallbacks 的 rehome + ensure 路径。
  useEffect(() => {
    if (workspaceContext.kind !== 'desktop') return
    const legacySpaceId = workbenchSpaceContext?.id
    if (!legacySpaceId) return
    ensureScopeInitializedFromLegacy(workspaceContext.key, legacySpaceId)
  }, [
    ensureScopeInitializedFromLegacy,
    workbenchSpaceContext?.id,
    workspaceContext.key,
    workspaceContext.kind,
  ])
  /**
   * 对话模式下右侧画布的折叠态（per workspace scope key）。
   * 桌面模式 chatPosition='right' 时 resolveAppLayoutUiState 会忽略它。
   */
  const canvasCollapsed = useSpaceViewPrefsStore(state => {
    // 消息一级页（non-space:im）必须读折叠偏好；否则欢迎画布恒展开，
    // 与 TabChatPanel 空态并排（见 shouldReadCanvasCollapsedPreference）。
    if (!shouldReadCanvasCollapsedPreference(workspaceContext)) return false
    return state.getCanvasCollapsed(workspaceContext.key, workbenchSpaceContext?.id ?? null)
  })
  const taskViewMode = useSpaceViewPrefsStore(state => {
    // IM 会话桌面与 Agent 任务同属聊天主位，共用三态视图；否则标签栏「收起」
    // 只写 taskViewMode、布局却只读 canvasCollapsed，会在不同步时失效。
    if (
      workspaceContext.kind !== 'conversation'
      && workspaceContext.kind !== 'im-conversation'
    ) return null
    return state.getTaskViewMode(workspaceContext.key)
  })
  // 当前 workspace scope 有没有真实打开的标签（虚拟「桌面」标签不进 tabOrder）。
  const canvasScopeHasRealTabs = useSpaceContextTabsStore(state =>
    workspaceContext.kind === 'non-space'
      ? true
      : (state.tabOrderBySpace[workspaceContext.key]?.length ?? 0) > 0,
  )
  const toggleCanvasCollapsedForScope = useSpaceViewPrefsStore(state => state.toggleCanvasCollapsedForScope)
  const setCanvasCollapsedForScope = useSpaceViewPrefsStore(state => state.setCanvasCollapsedForScope)
  const focusedCanvas = useUIStore(state => state.focusedCanvas)
  const setFocusedCanvas = useUIStore(state => state.setFocusedCanvas)
  const [sidebarContentPortalNode, setSidebarContentPortalNode] = useState<HTMLDivElement | null>(null)
  const sidebarContentPortalCallbackRef = useCallback((node: HTMLDivElement | null) => {
    setSidebarContentPortalNode(node)
  }, [])
  const sidebarContentPortalValue = useMemo(() => ({
    enabled: !isSettingsOpen,
    target: sidebarContentPortalNode,
  }), [isSettingsOpen, sidebarContentPortalNode])
  // 对话模式画布折叠时，右侧收起栏（打开的标签 + 应用入口）的 portal 宿主。
  const [canvasRailPortalNode, setCanvasRailPortalNode] = useState<HTMLDivElement | null>(null)
  const canvasRailPortalCallbackRef = useCallback((node: HTMLDivElement | null) => {
    setCanvasRailPortalNode(node)
  }, [])
  const [toastAnchorNode, setToastAnchorNode] = useState<HTMLDivElement | null>(null)
  const toastAnchorRef = useCallback((node: HTMLDivElement | null) => {
    setToastAnchorNode(node)
  }, [])
  const refreshToastViewport = useToastViewportAnchor(toastAnchorNode)
  // 收起栏「窄时只图标」：观测「聊天+收起栏」所在容器的总宽（不观测收起栏自身宽，
  // 否则图标/文字模式切换会改自身宽形成反馈抖动），窄于阈值就切成纯图标态，随窗口自适应。
  const [railIconOnly, setRailIconOnly] = useState(false)
  const railResizeObserverRef = useRef<ResizeObserver | null>(null)
  const railWidthProbeRef = useCallback((el: HTMLDivElement | null) => {
    railResizeObserverRef.current?.disconnect()
    railResizeObserverRef.current = null
    if (!el || typeof ResizeObserver === 'undefined') return
    // 阈值取值：observe 的是「聊天+收起栏」主区总宽（= 窗口 − padding16 − 侧栏宽）。
    // 侧栏 160~360、窗口最小 900：
    //   · 最小窗口最窄侧栏时主区最宽 ≈ 900-16-160 = 724 → 阈值须 > 724 才能保证最小窗口必收成图标；
    //   · 默认窗口(1400)最宽侧栏时主区最窄 ≈ 1400-16-360 = 1024 → 阈值须 < 1024 才能保证大窗口仍是文字。
    // 取 800：两头都稳，窗口拖到 ~1000 以下即开始收成图标条。
    const apply = (width: number) => setRailIconOnly(prev => {
      const next = resolveCanvasRailIconOnly(width)
      return prev === next ? prev : next
    })
    apply(el.getBoundingClientRect().width)
    const observer = new ResizeObserver(entries => {
      for (const entry of entries) apply(entry.contentRect.width)
    })
    observer.observe(el)
    railResizeObserverRef.current = observer
  }, [])
  // 必须观测主区共同父容器（聊天 + 画布收起栏），不能观测聊天列自身。
  // 收起栏的文字/图标模式会改变自身宽度；若以聊天列宽做判定，就会形成
  // 「文字栏挤窄聊天 → 切图标 → 聊天变宽 → 切文字」的逐帧反馈环。
  const unifiedMainPanelRef = useCallback((el: HTMLDivElement | null) => {
    toastAnchorRef(el)
    railWidthProbeRef(el)
  }, [railWidthProbeRef, toastAnchorRef])
  useEffect(() => () => railResizeObserverRef.current?.disconnect(), [])
  // shell 最外层 sidebar 宽度——走 useUIStore.sidebarWidth（全局偏好），桌面 / 设置 / Agent 共享。
  const sidebarWidth = useUIStore(state => state.sidebarWidth)
  const setSidebarWidth = useUIStore(state => state.setSidebarWidth)
  const effectiveSidebarWidth = isAuthenticated
    ? sidebarWidth
    : GUEST_AUTH_SIDEBAR_WIDTH
  const shellLayoutRafRef = useRef<number | null>(null)
  const uiStoreHydrated = usePersistHydrated(uiStorePersistApi)
  const spaceViewPrefsHydrated = usePersistHydrated(spaceViewPrefsPersistApi)
  const spaceContextTabsHydrated = usePersistHydrated(spaceContextTabsPersistApi)
  // 等待持久化布局状态完成水合后，再挂载可拖拽的 shell 分栏，
  // 避免 react-resizable-panels 在默认值上初始化并把错误布局锁住。
  const shellLayoutHydrated =
    uiStoreHydrated &&
    (!workbenchSpaceContext || (spaceViewPrefsHydrated && spaceContextTabsHydrated))

  // ：persist + 会话态 hydrate 完成后，按 foreground workspaceContext 保守收口历史双桶
  const tabDocDedupeDoneRef = useRef(false)
  useEffect(() => {
    if (!spaceContextTabsHydrated || tabDocDedupeDoneRef.current) return
    tabDocDedupeDoneRef.current = true
    try {
      dedupePersistedTabDocScopes({
        foregroundScopeKey: workspaceContext.key,
      })
    } catch (err) {
      log.warn('tabdoc scope dedupe failed', err)
    }
  }, [spaceContextTabsHydrated, workspaceContext.key])

  // Tracker 执行记录在 trackerRunSessionsBySpaceId，必须走 getSessionById（桶优先），
  // 否则顶栏拿不到 tracker_run，标题会落成「未命名任务」。
  const currentTaskSession = useMemo(() => {
    if (!currentSessionId) return null
    return getSessionById(currentSessionId) ?? null
  }, [currentSessionId, getSessionById, sessionsBySpaceId, trackerRunSessionsBySpaceId])
  const currentTaskLocalMessageCount = currentSessionId
    ? (messagesBySessionId[currentSessionId]?.length ?? 0)
    : 0
  const currentTaskLooksEmpty = Boolean(
    currentTaskSession &&
    (
      currentTaskSession.message_count === 0 ||
      (
        currentTaskSession.message_count == null &&
        !currentTaskSession.title?.trim()
      )
    ) &&
    currentTaskLocalMessageCount === 0,
  )
  const isNewTaskWelcome =
    workspaceContext.kind === 'conversation' &&
    (
      Boolean(
        workspaceContext.executionSpaceId &&
        draftSessionBySpaceId[workspaceContext.executionSpaceId],
      ) ||
      Boolean(
        currentSessionId && currentTaskLooksEmpty,
      )
    )

  const taskLayoutState = useMemo(() => {
    return resolveTaskLayoutState({
      shellLayoutHydrated,
      chatPanelEnabled: layoutChatPanelEnabled,
      chatSidePanelCollapsed,
      chatPosition,
      canvasCollapsed,
      taskViewMode,
      // IM 会话与 Agent 任务会话同属聊天主位：两者画布收起后都必须启用右侧资产栏。
      isConversationWorkspace:
        workspaceContext.kind === 'conversation' || workspaceContext.kind === 'im-conversation',
      // IM 只是复用对话主位和资产栏，不是任务；不可带入任务标题、快照或视图切换。
      isTaskConversation: workspaceContext.kind === 'conversation',
      isNewTaskWelcome,
      hasCanvasTabs: canvasScopeHasRealTabs,
    })
  }, [
    shellLayoutHydrated,
    layoutChatPanelEnabled,
    chatSidePanelCollapsed,
    chatPosition,
    canvasCollapsed,
    canvasScopeHasRealTabs,
    isNewTaskWelcome,
    taskViewMode,
    workspaceContext.kind,
  ])
  const canResizeChatRail = taskLayoutState.canResizeChatRail
  const effectiveChatCollapsed = taskLayoutState.effectiveChatCollapsed
  const effectiveCanvasCollapsed = taskLayoutState.effectiveCanvasCollapsed
  const collapsedChatRailVisible = taskLayoutState.collapsedChatRailVisible
  // IM 侧边打不开时需同时看到偏好、三态投影和标签数，定位是状态未写入还是布局未渲染。
  useEffect(() => {
    if (workspaceContext.kind !== 'im-conversation') return
    log.debug('layout projection', {
      scopeKey: workspaceContext.key,
      canvasCollapsed,
      taskViewMode,
      hasRealTabs: canvasScopeHasRealTabs,
      effectiveCanvasCollapsed,
      effectiveChatCollapsed,
      canvasRailEnabled: taskLayoutState.canvasRailEnabled,
    })
  }, [
    canvasCollapsed,
    canvasScopeHasRealTabs,
    effectiveCanvasCollapsed,
    effectiveChatCollapsed,
    taskLayoutState.canvasRailEnabled,
    taskViewMode,
    workspaceContext.key,
    workspaceContext.kind,
  ])
  // 任务 / IM 的应用聚焦只认 taskViewMode。focusedCanvas 仅保留给没有三态布局的
  // 桌面临时铺满，避免两个状态通过 OR 叠加后无法正确退出。
  const usesUnifiedAppFocus = !allowsLegacyCanvasFocus(workspaceContext.kind)
  const focusedCanvasTabIsOpen = useSpaceContextTabsStore(state =>
    focusedCanvas?.scopeKey === workspaceContext.key && focusedCanvas != null
      ? Boolean(state.itemsBySpace[workspaceContext.key]?.[focusedCanvas.tabKey])
      : false,
  )
  const focusedCanvasTabIsActive = useSpaceContextTabsStore(state =>
    focusedCanvas?.scopeKey === workspaceContext.key && focusedCanvas != null
      ? state.activeKeyBySpace[workspaceContext.key] === focusedCanvas.tabKey
      : false,
  )
  const isCanvasFocused =
    !usesUnifiedAppFocus &&
    chatPanelEnabled &&
    Boolean(workbenchSpaceContext) &&
    focusedCanvas?.scopeKey === workspaceContext.key &&
    focusedCanvasTabIsOpen &&
    focusedCanvasTabIsActive

  // 统一三态 scope 清理热更新/旧会话遗留临时态；桌面仍在标签关闭后退出临时铺满。
  useEffect(() => {
    if (shouldClearLegacyCanvasFocus({
      kind: workspaceContext.kind,
      focusMatchesWorkspace: focusedCanvas?.scopeKey === workspaceContext.key,
      focusedTabIsOpen: focusedCanvasTabIsOpen,
    })) {
      setFocusedCanvas(null)
    }
  }, [
    focusedCanvas,
    focusedCanvasTabIsOpen,
    setFocusedCanvas,
    workspaceContext.key,
    workspaceContext.kind,
  ])
  // 对话模式（chatPosition='middle'）+ 画布折叠 + 选中真实 Space 时，右侧常驻收起栏。
  const canvasRailEnabled =
    taskLayoutState.canvasRailEnabled && Boolean(workbenchSpaceContext)
  const expandCanvas = useCallback(() => {
    if (workspaceContext.kind === 'non-space') return
    setCanvasCollapsedForScope(workspaceContext.key, false)
  }, [setCanvasCollapsedForScope, workspaceContext.key, workspaceContext.kind])
  const canvasRailPortalValue = useMemo(() => ({
    enabled: canvasRailEnabled,
    target: canvasRailPortalNode,
    expandCanvas,
    iconOnly: railIconOnly,
  }), [canvasRailEnabled, canvasRailPortalNode, expandCanvas, railIconOnly])
  const showChatCanvasRail =
    layoutChatPanelEnabled &&
    !effectiveChatCollapsed &&
    !effectiveCanvasCollapsed &&
    !isCanvasFocused
  const isMac = useMemo(() => {
    if (typeof navigator === 'undefined') return false
    return /Mac|Macintosh/i.test(navigator.platform || '') || /Mac OS X/i.test(navigator.userAgent || '')
  }, [])
  const isWindowFullScreen = useWindowFullScreen()
  // 侧栏展开/折叠入口在 ShellTopBar 组织名旁（折叠态与展开态同一位置）。
  // 顶部拖拽由 ShellTopBar（QQ 式实体外框行）承载，内容区不再需要透明 overlay 让位。
  const topBarSafeArea = 0
  const windowsControlSafeAreaRight = 0
  const chatTopBarVisible = layoutChatPanelEnabled && !effectiveChatCollapsed
  const canvasTopBarVisible = !effectiveCanvasCollapsed || isCanvasFocused
  const rightmostTopBar: 'canvas' | 'chat' = chatPosition === 'right'
    ? (chatTopBarVisible ? 'chat' : 'canvas')
    : (canvasTopBarVisible ? 'canvas' : 'chat')
  const taskViewSwitchVisible = taskLayoutState.taskViewSwitchPlacement === 'shell-header'
  const topBarInset = useMemo<ShellTopBarInset>(() => {
    const viewSwitchInset = taskViewSwitchVisible ? TASK_VIEW_MODE_SWITCH_CANVAS_RIGHT_INSET_PX : 0
    return {
      canvas: chatPosition === 'right' ? topBarSafeArea : 0,
      chat: chatPosition === 'right' ? 0 : topBarSafeArea,
      // 分屏时 overlay 钉在工作区右上角，会压到右侧画布 ContextTabs——给画布顶栏加右留白。
      canvasRight: (rightmostTopBar === 'canvas' ? windowsControlSafeAreaRight : 0) + (
        rightmostTopBar === 'canvas' ? viewSwitchInset : 0
      ),
      chatRight: rightmostTopBar === 'chat' ? windowsControlSafeAreaRight : 0,
    }
  }, [chatPosition, rightmostTopBar, taskViewSwitchVisible, topBarSafeArea, windowsControlSafeAreaRight])

  const scheduleShellLayoutSync = useCallback(() => {
    if (typeof window === 'undefined') return
    if (shellLayoutRafRef.current != null) return
    shellLayoutRafRef.current = window.requestAnimationFrame(() => {
      shellLayoutRafRef.current = null
      dispatchCrawlViewLayoutChange('shell-layout')
    })
  }, [])

  const handleSidebarWidthCommit = useCallback((width: number) => {
    setSidebarWidth(width)
  }, [setSidebarWidth])

  useEffect(() => {
    return () => {
      if (shellLayoutRafRef.current != null) {
        cancelAnimationFrame(shellLayoutRafRef.current)
        shellLayoutRafRef.current = null
      }
    }
  }, [])

  // 右侧面板宽度来自 store 或布局分支切换时，同步嵌入视图 bounds（不依赖 window resize）
  useEffect(() => {
    scheduleShellLayoutSync()
  }, [
    sidebarWidth,
    chatSidePanelWidth,
    canResizeChatRail,
    effectiveSidebarCollapsed,
    effectiveChatCollapsed,
    effectiveCanvasCollapsed,
    collapsedChatRailVisible,
    chatPosition,
    isCanvasFocused,
    scheduleShellLayoutSync,
  ])

  /**
   * 切到对话模式时，保证主位（聊天）展开。
   *
   * chatSidePanelCollapsed 是**全局**态：用户在桌面模式把（次位的）聊天折起来后，
   * 切到对话模式聊天升为主位，必须清掉这个折叠态，否则主位聊天却是收起的。
   * 用 ref 只在 chatPosition 切换的"边沿"重置，避免和用户主动 toggle 撞车。
   *
   * 反方向（切到桌面模式）**不再重置 canvasCollapsed**：桌面模式画布是主位、
   * effectiveCanvasCollapsed 恒为 false，画布本就展开，无需重置；而 canvasCollapsed
   * 是 per-scope 态，切桌面时强写 false 会把用户在对话模式下对该 Space 的画布折叠
   * 偏好（含新的「默认折叠」）清成展开，属于污染——去掉。
   */
  const prevChatPositionRef = useRef<'middle' | 'right'>(chatPosition)
  const prevSpaceIdRef = useRef<string | null>(workbenchSpaceContext?.id ?? null)
  useEffect(() => {
    const currentSpaceId = workbenchSpaceContext?.id ?? null
    const positionChanged = prevChatPositionRef.current !== chatPosition
    const spaceChanged = prevSpaceIdRef.current !== currentSpaceId
    prevChatPositionRef.current = chatPosition
    prevSpaceIdRef.current = currentSpaceId

    // 切换 space 时不动用户偏好，沿用各自 space 自己的状态。
    if (!positionChanged || spaceChanged) return

    if (chatPosition === 'middle' && chatSidePanelCollapsed) {
      setChatSidePanelCollapsed(false)
    }
  }, [
    chatPosition,
    workbenchSpaceContext?.id,
    chatSidePanelCollapsed,
    setChatSidePanelCollapsed,
  ])

  // 点击「消息」是显式的展开意图。chatSidePanelCollapsed 是跨页面持久化偏好，
  // 若不在这里恢复，用户会只看到工作空间、完全看不到刚刚打开的消息面板。
  useEffect(() => {
    if (sidePanelMode === 'im' && chatSidePanelCollapsed) {
      setChatSidePanelCollapsed(false)
    }
  }, [chatSidePanelCollapsed, setChatSidePanelCollapsed, sidePanelMode])

  // 全局快捷键
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Cmd+J / Ctrl+J: 折叠/展开"非主位"面板
      // - 桌面模式（聊天非主）：toggle 聊天
      // - 对话模式（画布非主）：toggle 画布
      if ((e.metaKey || e.ctrlKey) && e.key === 'j') {
        e.preventDefault()
        if (chatPosition === 'middle' && workspaceContext.kind !== 'non-space') {
          toggleCanvasCollapsedForScope(workspaceContext.key)
        } else {
          toggleChatSidePanel()
        }
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [toggleChatSidePanel, toggleCanvasCollapsedForScope, chatPosition, workbenchSpaceContext?.id, workspaceContext.key, workspaceContext.kind])

  const contentAreaFallback = (
    <div className="flex h-full w-full items-center justify-center text-body text-muted-foreground">
      Loading...
    </div>
  )
  // 未登录时左侧已经由 GuestSidebar 承载登录/注册入口，主画布应始终展示访客欢迎页。
  // 否则持久化的 mainNavTab='me' 会把 SettingsSpace 空态渲染到登录页右侧。
  // useShellLayoutState 已在源头按 isAuthenticated 门控：未登录时 workbenchMode
  // 回退 welcome、workbenchSpaceContext/placeholderKind 置 null、chatPanelEnabled=false，
  // 主画布与右侧聊天 rail 共享同一套访客兜底语义，这里直接复用即可。
  const contentWorkbenchMode = workbenchMode
  const contentWorkbenchSpaceContext = workbenchSpaceContext
  const contentPlaceholderKind = placeholderKind
  const isImConversationWorkbench =
    contentWorkbenchMode === 'im-chat' && Boolean(workbenchSpaceContext)
  const imConversationCanvasTarget = useMemo(
    () => (isImConversationWorkbench && imConversationId && workbenchSpaceContext
      ? {
          conversationId: imConversationId,
          scopeKey: workspaceContext.key,
          executionSpaceId: workbenchSpaceContext.id,
        }
      : null),
    [isImConversationWorkbench, imConversationId, workbenchSpaceContext, workspaceContext.key],
  )
  const showInitialAgentLoading =
    isAuthenticated
    && (isInitialAgentDataLoading || isSelectedOrganizationAccessBlocked)
    && contentWorkbenchMode === 'welcome'
  const shouldRenderHydratedContentArea = contentWorkbenchMode !== 'space' || shellLayoutHydrated
  // 已登录态一律走 ShellSpaceWorkspaceSplit 一体壳；不再按 workbenchMode 逐条 opt-in，
  // 避免新增一级域漏注册退回 legacy 双 card 布局。
  const useUnifiedWorkspaceShell = isAuthenticated
  const contentAreaSurface = isAuthenticated ? 'bare' : 'card'

  // ContentArea 稳定挂载：通过 createPortal 渲染到固定 DOM 节点，
  // 避免 canResizeChatRail 切换时整个子树被卸载/重装。
  const contentPortalHost = useStablePortalHost()
  // 全局侧栏只保留一棵 React 子树（portal host）；切换模块只换内容，不重建侧栏实例。
  const sidebarPortalHost = useStablePortalHost()
  // fallback 仅在 showChatCanvasRail=false 时使用（折叠、聊天关闭等）。
  // 此时最多只显示一栏，可见栏必须 flex-1 占满；固定像素宽只留给 ShellChatCanvasSplit 双栏态。
  const showFallbackChat =
    layoutChatPanelEnabled && !effectiveChatCollapsed
  const showFallbackCanvas = !effectiveCanvasCollapsed
  const fallbackChatNode = useMemo(() => showFallbackChat ? (
    <div
      ref={chatPosition === 'middle' ? toastAnchorRef : undefined}
      key="fallback-chat"
      className="relative z-sticky isolate flex h-full min-w-0 flex-1 overflow-hidden"
    >
      <ShellSidePanelContent
        mode={sidePanelMode}
        activeSpaceContext={shellChatSpaceContext}
        hideImContentTabs={isImConversationWorkbench}
      />
    </div>
  ) : null, [showFallbackChat, chatPosition, toastAnchorRef, sidePanelMode, shellChatSpaceContext, isImConversationWorkbench])
  const fallbackCanvasNode = useMemo(() => showFallbackCanvas ? (
    <div
      ref={chatPosition === 'right' ? toastAnchorRef : undefined}
      key="fallback-canvas"
      className={`${SHELL_CANVAS_CARD_CLASS} z-sticky flex-1 overflow-visible`}
      style={{
        minWidth: chatPosition === 'middle'
          ? SHELL_CONVERSATION_CANVAS_MIN_WIDTH
          : SHELL_WORKBENCH_MIN_WIDTH,
      }}
      data-canvas-drag-root="true"
    >
      <StableSlot
        host={contentPortalHost}
        owner="shell-fallback-canvas"
        className="relative min-w-0 h-full w-full flex-1 overflow-visible"
      />
    </div>
  ) : null, [contentPortalHost, showFallbackCanvas, chatPosition, toastAnchorRef])
  const collapsedChatEntryRail = useMemo(() => {
    if (!collapsedChatRailVisible) return null

    return (
      <div
        key="collapsed-chat-rail"
        className="relative z-sticky flex h-full w-10 shrink-0 items-start justify-center overflow-hidden rounded-[12px] border-l border-border/40 bg-background/80 pt-1 no-drag"
      >
        <button
          type="button"
          onClick={toggleChatSidePanel}
          title={`展开聊天 (${isMac ? '⌘J' : 'Ctrl+J'})`}
          aria-label="展开聊天"
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground no-drag"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
      </div>
    )
  }, [collapsedChatRailVisible, isMac, toggleChatSidePanel])

  const sidebarSurface = useUnifiedWorkspaceShell ? 'embedded' : 'card'
  const sidebarContent = (
    <StableSlot
      host={sidebarPortalHost}
      owner="shell-sidebar"
      className="relative h-full w-full min-w-0 overflow-hidden"
    />
  )

  const canvasSlot = useMemo(
    () => (
      <StableSlot
        host={contentPortalHost}
        owner="shell-content-canvas"
        className="relative min-w-0 h-full w-full flex-1 overflow-visible"
      />
    ),
    [contentPortalHost],
  )

  const mainRailContent = useMemo(() => {
    if (isCanvasFocused) {
      return (
        <div ref={toastAnchorRef} className="relative flex h-full min-w-0 flex-1 overflow-hidden">
          {canvasSlot}
          {/* 对话保活以免会话状态/订阅被重置，但视觉与指针都完全退出当前工作流。 */}
          <div aria-hidden className="pointer-events-none invisible absolute inset-0">
            <ShellSidePanelContent
              mode={sidePanelMode}
              activeSpaceContext={shellChatSpaceContext}
              hideImContentTabs={isImConversationWorkbench}
            />
          </div>
        </div>
      )
    }

    if (showChatCanvasRail) {
      return (
        <ShellChatCanvasSplit
          chatPosition={chatPosition}
          chatRailWidth={chatSidePanelWidth}
          canvasRailWidth={canvasSidePanelWidth}
          onChatRailWidthCommit={setChatSidePanelWidth}
          onCanvasRailWidthCommit={setCanvasSidePanelWidth}
          onLayoutSync={scheduleShellLayoutSync}
          chatPanel={
            <ShellSidePanelContent
              mode={sidePanelMode}
              activeSpaceContext={shellChatSpaceContext}
              hideImContentTabs={isImConversationWorkbench}
            />
          }
          canvasSlot={canvasSlot}
          primaryRailRef={toastAnchorRef}
          onPrimaryRailLayoutComplete={refreshToastViewport}
        />
      )
    }

    if (layoutChatPanelEnabled && effectiveCanvasCollapsed && workbenchSpaceContext) {
      return (
        <div ref={toastAnchorRef} className="relative flex h-full min-w-0 flex-1 overflow-hidden">
          <ShellSidePanelContent
            mode={sidePanelMode}
            activeSpaceContext={shellChatSpaceContext}
            hideImContentTabs={isImConversationWorkbench}
          />
          {/*
            画布折叠时聊天独占可见区，但工作台 portal 宿主（contentPortalHost）仍必须挂在
            文档内：ContentArea 是 createPortal 到该宿主的，缺挂载点会让整棵工作台子树脱离
            document，依赖工作台 overlay 容器的浮层（侧栏会话右键菜单 / Popover / 下拉等）
            会被 portal 到游离节点而失效。这里用 invisible 隐藏但保活（保留布局尺寸）；
            crawlspace / BrowserView 的显隐由 workspaceLayerVisible(=false) 独立控制，不会
            因此误显示。
          */}
          <div aria-hidden className="pointer-events-none invisible absolute inset-0">
            {canvasSlot}
          </div>
        </div>
      )
    }

    return (
      <div className="relative flex h-full min-w-0 flex-1 gap-0.5 overflow-visible">
        {chatPosition === 'middle' ? (
          <>
            {fallbackChatNode}
            {fallbackCanvasNode}
          </>
        ) : (
          <>
            {fallbackCanvasNode}
            {collapsedChatEntryRail}
            {fallbackChatNode}
          </>
        )}
      </div>
    )
  }, [
    isCanvasFocused,
    showChatCanvasRail,
    chatPosition,
    chatSidePanelWidth,
    canvasSidePanelWidth,
    setChatSidePanelWidth,
    setCanvasSidePanelWidth,
    scheduleShellLayoutSync,
    sidePanelMode,
    shellChatSpaceContext,
    isImConversationWorkbench,
    canvasSlot,
    toastAnchorRef,
    refreshToastViewport,
    layoutChatPanelEnabled,
    effectiveCanvasCollapsed,
    workbenchSpaceContext,
    collapsedChatEntryRail,
    fallbackChatNode,
    fallbackCanvasNode,
  ])

  const unifiedCanvasNode = useMemo(() => (
    <div className="relative flex h-full min-w-0 flex-1 overflow-visible">
      <div
        className="relative flex h-full min-w-0 flex-1 overflow-visible"
        data-canvas-drag-root="true"
      >
        {canvasSlot}
      </div>
      {chatPosition === 'right' ? collapsedChatEntryRail : null}
    </div>
  ), [canvasSlot, chatPosition, collapsedChatEntryRail])

  const unifiedSettingsNode = useMemo(() => (
    <div
      className="relative flex h-full min-w-0 flex-1 overflow-hidden"
      data-canvas-drag-root="true"
    >
      {canvasSlot}
    </div>
  ), [canvasSlot])

  const unifiedTaskChatNode = useMemo(() => (
    <div className="relative flex h-full min-w-0 flex-1 overflow-hidden">
      <ShellSidePanelContent
        mode={sidePanelMode}
        activeSpaceContext={shellChatSpaceContext}
        hideImContentTabs={isImConversationWorkbench}
      />
    </div>
  ), [
    sidePanelMode,
    shellChatSpaceContext,
    isImConversationWorkbench,
  ])

  // 任务三态开启时画布宿主由 taskCanvas（unifiedCanvasNode）独占；
  // 禁止再在聊天列 invisible 槽位并行 claim，否则退出任务域时临时槽位 cleanup
  // 会把 host 移出 document，而仍存活的可见槽位不会重跑 effect → 整页白屏。
  const parkContentPortalInChatColumn =
    chatPosition === 'middle'
    && effectiveCanvasCollapsed
    && taskLayoutState.effectiveTaskViewMode == null

  const unifiedChatNode = useMemo(() => (
    <div className="relative flex h-full min-w-0 flex-1 overflow-hidden">
      {unifiedTaskChatNode}
      {parkContentPortalInChatColumn ? (
        // 画布折叠时 ContentArea portal 宿主仍须保活；收起栏改挂 unified secondary 列。
        <div aria-hidden className="pointer-events-none invisible absolute inset-0">
          {canvasSlot}
        </div>
      ) : null}
    </div>
  ), [
    canvasSlot,
    parkContentPortalInChatColumn,
    unifiedTaskChatNode,
  ])

  const showCollapsedCanvasRailSecondary =
    chatPosition === 'middle' &&
    effectiveCanvasCollapsed &&
    canvasRailEnabled

  const collapsedCanvasRailHost = useMemo(() => (
    <div
      ref={canvasRailPortalCallbackRef}
      className="h-full min-h-0 min-w-0 overflow-hidden"
    />
  ), [canvasRailPortalCallbackRef])

  const unifiedPrimaryNode = chatPosition === 'right' ? unifiedCanvasNode : unifiedChatNode
  const unifiedSecondaryNode = !layoutChatPanelEnabled
    ? null
    : chatPosition === 'right'
    ? (effectiveChatCollapsed ? null : unifiedChatNode)
    : showCollapsedCanvasRailSecondary
      ? collapsedCanvasRailHost
      : effectiveCanvasCollapsed
        ? null
        : unifiedCanvasNode
  const collapsedCanvasRailWidth = railIconOnly
    ? SHELL_COLLAPSED_CANVAS_RAIL_ICON_WIDTH
    : SHELL_COLLAPSED_CANVAS_RAIL_WIDTH
  const unifiedSecondaryWidth = chatPosition === 'right'
    ? chatSidePanelWidth
    : showCollapsedCanvasRailSecondary
      ? collapsedCanvasRailWidth
      : canvasSidePanelWidth
  const handleUnifiedSecondaryWidthCommit = chatPosition === 'right'
    ? setChatSidePanelWidth
    : setCanvasSidePanelWidth

  // 消息页（im / im-chat）不再算全屏模块：列表+聊天固定在 shell IM rail，
  // 选会话只换主画布，避免 ContentArea 再挂一套 TabChatPanel 整页闪烁。
  // Project（app-page）默认只挂画布；显式打开任务会话后 chatPanelEnabled=true，
  // 必须放开 fullscreen/canvas-only，否则右侧对话 rail 永不挂载。
  const {
    isFullscreenModule: isUnifiedFullscreenModule,
    isCanvasOnlyModule: isUnifiedCanvasOnlyModule,
  } = resolveUnifiedAppPageModuleFlags({
    workbenchMode: contentWorkbenchMode,
    chatPanelEnabled: layoutChatPanelEnabled,
  })
  const effectiveTaskViewMode = taskLayoutState.effectiveTaskViewMode
  const focusedCanvasNode = useMemo(() => (
    <div className="relative flex h-full min-w-0 flex-1 overflow-hidden">
      {canvasSlot}
      <div aria-hidden className="pointer-events-none invisible absolute inset-0">
        <ShellSidePanelContent
          mode={sidePanelMode}
          activeSpaceContext={shellChatSpaceContext}
          hideImContentTabs={isImConversationWorkbench}
        />
      </div>
    </div>
  ), [canvasSlot, isImConversationWorkbench, shellChatSpaceContext, sidePanelMode])

  const unifiedWorkspacePrimaryNode =
    effectiveTaskViewMode === 'app-focus' || isCanvasFocused || isUnifiedFullscreenModule
    ? (isCanvasFocused ? focusedCanvasNode : effectiveTaskViewMode === 'app-focus' ? unifiedCanvasNode : unifiedSettingsNode)
    : isUnifiedCanvasOnlyModule
      ? unifiedCanvasNode
      : unifiedPrimaryNode
  const unifiedWorkspaceSecondaryNode =
    effectiveTaskViewMode !== 'app-focus' &&
    !isCanvasFocused &&
    !isUnifiedCanvasOnlyModule &&
    shouldRenderUnifiedSecondary({
    isFullscreenModule: isUnifiedFullscreenModule,
    chatPanelEnabled: layoutChatPanelEnabled,
  })
    ? (unifiedSecondaryNode ?? undefined)
    : undefined
  const unifiedWorkspacePrimaryIsCanvas =
    effectiveTaskViewMode === 'app-focus' ||
    isCanvasFocused ||
    isUnifiedFullscreenModule ||
    isUnifiedCanvasOnlyModule
      ? true
      : undefined
  const stableTaskLayoutEnabled =
    effectiveTaskViewMode != null &&
    layoutChatPanelEnabled &&
    !isCanvasFocused &&
    !isUnifiedFullscreenModule &&
    !isUnifiedCanvasOnlyModule
  const taskHeaderWorkspaceId =
    currentTaskSession?.workspace_id ??
    currentTaskSession?.space_id ??
    shellChatSpaceContext?.id ??
    null
  // ：pending / 预建首发尚无 session 行时，用 selectedAgent 同帧填顶栏名
  const taskHeaderAgentName = resolveTaskHeaderAgentName(
    currentTaskSession?.agent_id,
    agentCache,
    selectedAgent,
  )
  const taskHeaderNode = taskLayoutState.showFormalTaskHeader ? (
    <TaskWorkspaceHeader
      scopeKey={workspaceContext.key}
      title={currentTaskSession?.title ?? '未命名任务'}
      workspaceId={taskHeaderWorkspaceId}
      sessionId={currentTaskSession?.id ?? null}
      activeViewMode={taskLayoutState.effectiveTaskViewMode ?? 'chat-focus'}
      trackerRun={currentTaskSession?.tracker_run ?? null}
    />
  ) : taskLayoutState.showDraftTaskHeader ? (
    <DraftTaskWorkspaceHeader
      scopeKey={workspaceContext.key}
      activeViewMode={taskLayoutState.effectiveTaskViewMode ?? 'split'}
    />
  ) : undefined
  // 三态切换仍钉在 Shell overlay；标题栏通过实测宽度动态避让，不移动按钮。
  const taskViewModeSwitchNode = taskViewSwitchVisible ? (
    <TaskViewModeSwitch
      scopeKey={workspaceContext.key}
      activeMode={taskLayoutState.effectiveTaskViewMode ?? 'chat-focus'}
    />
  ) : undefined

  const activityRailNode = useMemo(() => (
    <ActivityRail executionSpaceId={sidebarSpaceContext?.id ?? null} />
  ), [sidebarSpaceContext?.id])

  return (
    // h-full 必填：下方 shell 根用 h-full（百分比高度），需要本层 div 有确定高度才能解析。
    // ThemeProvider 渲染一个普通 div，缺省是 auto 高；shell 根用 h-full 时，这层必须给
    // 确定高度，否则百分比高度链会塌缩，导致内容溢出视口。
    <ThemeProvider className="h-full">
      <WorkbenchLifecycleProvider>
        <SidebarContentPortalProvider value={sidebarContentPortalValue}>
        <CanvasRailPortalProvider value={canvasRailPortalValue}>
        <ImConversationCanvasProvider value={imConversationCanvasTarget}>
        <ShellTopBarInsetContext.Provider value={topBarInset}>
        <div className="flex flex-col h-full overflow-hidden relative min-w-0 bg-transparent">
          {/* QQ 式顶部外框：实体标题栏行（红绿灯让位 + 头像 + 整行拖拽）。 */}
          <ShellTopBar isMac={isMac} isWindowFullScreen={isWindowFullScreen} />
          <MembershipExpiredBanner />
          <OrganizationMembershipNoticeDialogHost />
          <React.Suspense fallback={null}>
            <NewUserOrganizationOnboardingLayer />
          </React.Suspense>

          {/* ContentArea 始终通过 portal 渲染到同一 DOM 节点，生命周期不受布局切换影响 */}
          {createPortal(
            <React.Suspense fallback={<div className="h-full w-full bg-transparent" />}>
              <SpaceSidebarGlobal
                executionSpaceId={sidebarSpaceContext?.id ?? null}
                workspaceScopeKey={
                  workspaceContext.kind === 'non-space'
                    ? null
                    : workspaceContext.key
                }
                isAgentListLoading={isAuthenticated && isInitialAgentDataLoading}
                sidebarContentPortalRef={sidebarContentPortalCallbackRef}
                surface={sidebarSurface}
              />
            </React.Suspense>,
            sidebarPortalHost,
          )}
          {createPortal(
            <React.Suspense fallback={contentAreaFallback}>
              {shouldRenderHydratedContentArea ? (
                <ContentArea
                  workbenchMode={contentWorkbenchMode}
                  activeSpaceContext={contentWorkbenchSpaceContext}
                  workspaceTabScopeKey={workspaceContext.kind === 'non-space' ? null : workspaceContext.key}
                  placeholderKind={contentPlaceholderKind}
                  isInitialAgentViewLoading={showInitialAgentLoading}
                  shellCanvasVisible={!effectiveCanvasCollapsed || isCanvasFocused}
                  surface={contentAreaSurface}
                />
              ) : (
                contentAreaFallback
              )}
            </React.Suspense>,
            contentPortalHost,
          )}

          <div className="relative flex flex-1 min-h-0 overflow-hidden min-w-0 w-full px-2 pb-2 pt-0">
          {/* 双列侧栏：窄栏与宽栏共享实色底；折叠只压缩第二列，不换工作台壳。 */}
          {isAuthenticated ? (
              <ShellSpaceWorkspaceSplit
                chatPosition={chatPosition}
                sidebarWidth={sidebarWidth}
                sidebarContentCollapsed={effectiveSidebarCollapsed}
                onSidebarWidthCommit={handleSidebarWidthCommit}
                onSecondaryWidthCommit={handleUnifiedSecondaryWidthCommit}
                onLayoutSync={scheduleShellLayoutSync}
                sidebar={sidebarContent}
                header={taskHeaderNode}
                viewModeSwitch={taskViewModeSwitchNode}
                primary={unifiedWorkspacePrimaryNode}
                primaryIsCanvas={unifiedWorkspacePrimaryIsCanvas}
                layoutTransitionScopeKey={layoutScopeKey}
                taskViewMode={effectiveTaskViewMode}
                taskChat={stableTaskLayoutEnabled ? unifiedTaskChatNode : undefined}
                taskCanvas={stableTaskLayoutEnabled ? unifiedCanvasNode : undefined}
                taskCollapsedCanvasRail={
                  stableTaskLayoutEnabled && showCollapsedCanvasRailSecondary
                    ? collapsedCanvasRailHost
                    : undefined
                }
                taskCanvasWidth={canvasSidePanelWidth}
                taskCollapsedCanvasRailWidth={collapsedCanvasRailWidth}
                primaryPanelRef={unifiedMainPanelRef}
                secondary={unifiedWorkspaceSecondaryNode}
                secondaryWidth={unifiedSecondaryWidth}
                secondaryResizable={!showCollapsedCanvasRailSecondary}
                secondaryRailMinWidth={
                  showCollapsedCanvasRailSecondary ? collapsedCanvasRailWidth : undefined
                }
                leadingRail={activityRailNode}
              />
          ) : (
            <>
              <div
                className="h-full shrink-0 overflow-hidden"
                style={{ width: effectiveSidebarWidth }}
              >
                {sidebarContent}
              </div>
              <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
                {mainRailContent}
              </div>
            </>
          )}

          {taskLayoutState.chatCapsuleVisible &&
          !isCanvasFocused &&
          workspaceContext.kind === 'conversation' &&
          shellChatSpaceContext ? (
            <AgentChatCapsuleHost
              scopeKey={workspaceContext.key}
              sessionId={currentSessionId ?? null}
              agentId={currentTaskSession?.agent_id ?? selectedAgent?.id ?? null}
              agentName={taskHeaderAgentName}
              spaceContext={shellChatSpaceContext}
              organizationId={shellChatSpaceContext.organization_id}
            />
          ) : null}

          <UploadNotificationPanel />
          {/* ：外部 Agent 数据导入向导 + 后台进度悬浮面板（入口收拢至任务侧栏「导入数据」） */}
          <ExternalImportWizardHost />
          <ImportProgressPanel />
          {/* 飞书多维表导入：全局视口进度，切换应用不丢 */}
          <FeishuImportProgressPanel />
          {/* 第三方源关联扫描：多任务折叠卡片，彼此独立可并行 */}
          <RelationScanProgressPanel />
          <UpdatePromptDialog />
          <React.Suspense fallback={null}>
            <GlobalAgentSettingsSheetHost />
            <GlobalSpaceAgentDialogHost />
            <AppCollaborationDialogHost />
          </React.Suspense>
          </div>
        </div>
        </ShellTopBarInsetContext.Provider>
        </ImConversationCanvasProvider>
        </CanvasRailPortalProvider>
        </SidebarContentPortalProvider>
      </WorkbenchLifecycleProvider>
    </ThemeProvider>
  )
}
