import React from 'react'
import { LoadingSpinner } from '@tabtin/smartsheet-ui'
import { ErrorBoundary } from '@components/common/ErrorBoundary'
import { useCrawlspaceRegistry } from '@/crawlspace/registry'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import { useSpaceStore } from '@stores/useSpaceStore'
import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'
import { useMainNavStore } from '@stores/useMainNavStore'
import { useSettingsSpaceStore } from '@stores/useSettingsSpaceStore'
import { contextRegistry } from '@components/context-space/registry'
import { resolveContentAreaUiState, resolveEffectivePortalTableIds } from './contentAreaState'
import { useSpaceWorkbenchPortalIds } from './useSpaceWorkbenchPortalIds'

const SettingsSpace = React.lazy(() =>
  import('@components/settings/SettingsSpace').then(m => ({ default: m.SettingsSpace }))
)
const AppFullPageHost = React.lazy(() =>
  import('./AppFullPageHost').then(m => ({ default: m.AppFullPageHost }))
)
const ContentAreaPortalHost = React.lazy(() =>
  import('./ContentAreaPortalHost').then(m => ({ default: m.ContentAreaPortalHost }))
)
const IMWelcomePanel = React.lazy(() =>
  import('./IMWelcomePanel').then(m => ({ default: m.IMWelcomePanel }))
)
const CloudDocsMainCanvas = React.lazy(() =>
  import('./CloudDocsMainCanvas').then(m => ({ default: m.CloudDocsMainCanvas }))
)
const AgentsDetailCanvas = React.lazy(() =>
  import('./AgentsDetailCanvas').then(m => ({ default: m.AgentsDetailCanvas }))
)
const SpaceWorkbenchHost = React.lazy(() =>
  import('./SpaceWorkbenchHost').then(m => ({ default: m.SpaceWorkbenchHost }))
)
// CaptchaInterventionOverlay 已废弃：验证码改走对话 ask_user + captcha_required
// （对齐登录墙），不再弹全局右下角 toast（跨任务粘连 + Agent 不停）。
// 保存密码提示条 + 自动填充建议 ——  起改挂在 overlay **modal** 子窗口
// （见 renderer/overlay/OverlayApp.tsx），不再画在主 renderer，否则会被浏览器
// 原生 WebContentsView 盖住（ 同源问题），且这两者都有可点交互，必须跑在
// focusable 的 modal 子窗口。这里不再渲染。
// Wave 4 视角 1+2 P0 自修：Agent 后台 view 自动登录失败 Toast
const AgentAutofillFailedToast = React.lazy(() =>
  import('@components/crawl/AgentAutofillFailedToast').then(m => ({ default: m.AgentAutofillFailedToast }))
)
// Wave 5c T1：首次引导（PRD Story 1）
const FirstTimeImportBanner = React.lazy(() =>
  import('@components/onboarding/FirstTimeImportBanner').then(m => ({ default: m.FirstTimeImportBanner }))
)
import { useTranslation } from 'react-i18next'
import {
  isOrganizationAccessBlockedFor,
  useWsConnectionStore,
} from '@/stores/useWsConnectionStore'

import { WelcomePage } from './WelcomePage'
import { WorkspaceRootBanner } from '@components/context-space/WorkspaceRootBanner'
import { SHELL_CANVAS_CARD_CLASS } from './shellUi'
import type { SpaceContext } from '@components/context-space/SpaceContextContainer'
import type { WorkbenchMode, WorkbenchPlaceholderKind } from './useShellLayoutState'

const StandaloneModuleEmpty: React.FC<{ title: string }> = ({ title }) => {
  const { t } = useTranslation('chat')
  return (
  <div className="flex h-full items-center justify-center">
    <div className="text-center">
      <h1 className="text-title font-medium">{title}</h1>
      <p className="mt-2 text-body text-muted-foreground/60">{t('input.disabled_no_space')}</p>
    </div>
  </div>
  )
}

interface ContentAreaProps {
  workbenchMode: WorkbenchMode
  activeSpaceContext: SpaceContext | null
  workspaceTabScopeKey?: string | null
  placeholderKind: WorkbenchPlaceholderKind | null
  isInitialAgentViewLoading?: boolean
  shellCanvasVisible?: boolean
  surface?: 'card' | 'bare'
}

export const ContentArea: React.FC<ContentAreaProps> = ({
  workbenchMode,
  activeSpaceContext,
  workspaceTabScopeKey = null,
  placeholderKind,
  isInitialAgentViewLoading = false,
  shellCanvasVisible = true,
  surface = 'card',
}) => {

  const { t } = useTranslation(['organization', 'sidebar'])
  // ：按组织 remount 工作台，避免 Activity 保活导致跨 org 残留浮层/列表
  const organizationId = useOrganizationStore((s) => s.selectedOrganization?.id ?? null)
  const isLoadingSpaces = useSpaceStore((state) => state.isLoading)
  const organizationRemountKey = organizationId ?? 'no-org'
  const activeSpaceId = activeSpaceContext?.id ?? null
  const activeTabScopeKey = workspaceTabScopeKey || activeSpaceId
  const {
    configsById: crawlspaceConfigById,
  } = useCrawlspaceRegistry()
  const activeContextKeyFromStore = useSpaceContextTabsStore(state => {
    if (!activeTabScopeKey) return null
    return state.activeKeyBySpace[activeTabScopeKey] ?? null
  })

  const activeContextKey = activeTabScopeKey ? activeContextKeyFromStore : null
  const activeContextMeta = React.useMemo(() => {
    if (!activeContextKey) return null
    return contextRegistry.parseTabKey(activeContextKey)
  }, [activeContextKey])
  const activeContextType = activeContextMeta?.type ?? null
  const activeContextTableId = activeContextMeta?.type === 'tabdata' ? activeContextMeta.id : null

  const { portalTableIds, terminalSessionIds } = useSpaceWorkbenchPortalIds(activeSpaceId, activeTabScopeKey)
  const effectivePortalTableIds = React.useMemo(
    () => resolveEffectivePortalTableIds({
      workbenchMode,
      portalTableIds,
      activeTableId: activeContextTableId,
    }),
    [workbenchMode, portalTableIds, activeContextTableId],
  )

  const contentAreaUiState = React.useMemo(() => {
    return resolveContentAreaUiState({
      workbenchMode,
      hasActiveSpaceContext: Boolean(activeSpaceContext),
      activeContextType,
      shellCanvasVisible,
    })
  }, [workbenchMode, activeSpaceContext, activeContextType, shellCanvasVisible])

  // ✅ 2026-01-20：兼容层已完全移除
  // - 所有组件现在直接从 ContextSpace 获取状态
  // - RunSessionContextTab 已迁移到 useCrawlspaceRegistry

  // ✅ 新模型：crawlspace 关闭由 store.closeCrawlspace 负责销毁内部 views，不再需要 ContentArea 兜底清理。

  // ============================================================================
  // 渲染主内容
  // ============================================================================
  // `ContentArea` 仅根据上层传入的 workbench 模式渲染工作台：
  // Settings / Space / Placeholder / Welcome。
  // 聊天导航模式与回退规则统一由 `useShellLayoutState` 在 AppLayout 中解析。
  // ============================================================================
  let mainContent: React.ReactNode = null
  const loadingFallback = (
    <div className="flex h-full w-full items-center justify-center">
      <LoadingSpinner size="sm" />
    </div>
  )

  if (workbenchMode === 'me') {
    // 「我的」tab 主画布——SettingsSpace 按 activeRoute 渲染对应 panel；
    // activeRoute 为 null 时内部显示「请从左侧选择」占位
    mainContent = (
      <React.Suspense fallback={loadingFallback}>
        <SettingsSpace />
      </React.Suspense>
    )
  } else if (workbenchMode === 'app-page') {
    mainContent = (
      <React.Suspense fallback={loadingFallback}>
        <AppFullPageHost />
      </React.Suspense>
    )
  } else if (workbenchMode === 'agents') {
    mainContent = (
      <React.Suspense fallback={loadingFallback}>
        <AgentsDetailCanvas />
      </React.Suspense>
    )
  } else if (workbenchMode === 'cloud-docs' && activeSpaceContext && activeTabScopeKey) {
    mainContent = (
      <React.Suspense fallback={loadingFallback}>
        <CloudDocsMainCanvas
          activeSpaceContext={activeSpaceContext}
          tabScopeKey={activeTabScopeKey}
          shellCanvasVisible={shellCanvasVisible}
          crawlspaceConfigById={crawlspaceConfigById}
          workspaceLayerVisible={contentAreaUiState.workspaceLayerVisible}
        />
      </React.Suspense>
    )
  } else if (workbenchMode === 'cloud-docs') {
    mainContent = (
      <StandaloneModuleEmpty title={t('sidebar:rail.cloudDocs', { defaultValue: '云文档' })} />
    )
  } else if (workbenchMode === 'im') {
    // 列表+聊天固定在 shell IM rail；主画布只放欢迎引导（默认可折叠）。
    // 切勿再挂 TabChatPanel，否则与 rail 双开、选会话时整页换壳闪烁。
    mainContent = (
      <React.Suspense fallback={loadingFallback}>
        <IMWelcomePanel />
      </React.Suspense>
    )
  } else if (workbenchMode === 'im-chat' && activeSpaceContext) {
    // 「私信」/ 群聊会话桌面（有默认工作空间执行现场）：主画布渲染工作空间桌面
    // （SpaceWorkbenchHost），聊天由 shell 聊天 rail 的 TabChatPanel 承载。标签组按
    // im:{conversationId} 隔离——每条会话一套独立桌面，对齐 Agent 任务模式。
    mainContent = (
      <React.Suspense fallback={loadingFallback}>
        <SpaceWorkbenchHost
          key={organizationRemountKey}
          activeSpaceContext={activeSpaceContext}
          foregroundTabScopeKey={activeTabScopeKey}
          crawlspaceConfigById={crawlspaceConfigById}
          workspaceLayerVisible={contentAreaUiState.workspaceLayerVisible}
          shellCanvasVisible={shellCanvasVisible}
        />
      </React.Suspense>
    )
  } else if (workbenchMode === 'im-chat') {
    // 无默认工作空间：聊天仍在 shell IM rail；主画布回落欢迎引导，不挂第二套消息页。
    mainContent = (
      <React.Suspense fallback={loadingFallback}>
        <IMWelcomePanel />
      </React.Suspense>
    )
  } else if (workbenchMode === 'space' && activeSpaceContext) {
    mainContent = (
      <React.Suspense fallback={loadingFallback}>
        <SpaceWorkbenchHost
          key={organizationRemountKey}
          activeSpaceContext={activeSpaceContext}
          foregroundTabScopeKey={activeTabScopeKey}
          crawlspaceConfigById={crawlspaceConfigById}
          workspaceLayerVisible={contentAreaUiState.workspaceLayerVisible}
          shellCanvasVisible={shellCanvasVisible}
        />
      </React.Suspense>
    )
  } else if (workbenchMode === 'placeholder' && placeholderKind) {
    // 边缘场景：非 im tab + 选了 IM 会话 + 无 selectedSpace（典型来源：全局搜索/
    // 通知跳进 IM 消息，用户当前没工作在任何 Space）。chat panel 已经接管 ChatView，
    // 这里主画布给出明确引导：去「私信」tab 看完整列表。
    const isIMGroup = placeholderKind === 'im-group'
    mainContent = (
      <div className="h-full flex items-center justify-center">
        <div className="text-center space-y-4 max-w-sm">
          <div className="w-12 h-12 mx-auto rounded-full bg-muted/30 border border-border/60 flex items-center justify-center">
            <span className="text-title">
              {isIMGroup ? '👥' : '✉️'}
            </span>
          </div>
          <p className="text-muted-foreground text-body leading-relaxed">
            {isIMGroup
              ? t('groupConversationOpenedHint', '群聊已在右侧面板打开，可在那里继续对话')
              : t('dmConversationOpenedHint', '私信已在右侧面板打开，可在那里继续对话')}
          </p>
          <button
            type="button"
            onClick={() => {
              useSettingsSpaceStore.getState().closeSettings()
              useMainNavStore.getState().setCurrentTab('im')
            }}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border/40 text-body text-muted-foreground hover:text-foreground hover:bg-muted/30 transition-colors"
          >
            {t('openIMTab', '打开私信 tab')}
          </button>
        </div>
      </div>
    )
  } else if (workbenchMode === 'welcome' && (isInitialAgentViewLoading || isLoadingSpaces)) {
    mainContent = <InitialAgentLoading />
  } else {
    mainContent = <WelcomePage />
  }

  const contentBody = contentAreaUiState.portalEnabled ? (
    <React.Suspense fallback={loadingFallback}>
      <ContentAreaPortalHost
        enabled
        tableIds={effectivePortalTableIds}
        retentionTableIds={portalTableIds}
        terminalSessionIds={terminalSessionIds}
      >
        {mainContent}
      </ContentAreaPortalHost>
    </React.Suspense>
  ) : mainContent

  const crawlOverlays = contentAreaUiState.portalEnabled ? (
    <React.Suspense fallback={null}>
      <AgentAutofillFailedToast />
      {/* Wave 5c T1：首次引导仅在 crawl 工作区可见时启用 */}
      <FirstTimeImportBanner enabled={workbenchMode === 'space'} />
    </React.Suspense>
  ) : null

  const surfaceClassName = surface === 'card'
    ? SHELL_CANVAS_CARD_CLASS
    : 'bg-transparent'

  const innerContentClassName = surface === 'card'
    ? 'relative flex flex-col flex-1 min-h-0 min-w-0 overflow-hidden'
    : 'relative flex flex-col flex-1 min-h-0 min-w-0 overflow-hidden'

  return (
    <ErrorBoundary
      variant="region"
      resetKeys={[organizationRemountKey, workbenchMode, activeSpaceId, activeTabScopeKey]}
    >
      <div className={`relative flex h-full w-full min-w-0 flex-col overflow-hidden ${surfaceClassName}`}>
        {/* RT-3：执行根不可达时在顶部显示横幅，参与 flex 流以避免覆盖内容。
            只在 Space 工作台模式下探测/显示——其他工作台模式（me/im）无 Agent working_dir 概念。 */}
        {workbenchMode === 'space' && activeSpaceId ? (
          <WorkspaceRootBanner spaceId={activeSpaceId} />
        ) : null}
        {/* ：content + crawl 浮层一起按组织 remount，避免验证码等本地浮层跨组织残留 */}
        <React.Fragment key={organizationRemountKey}>
          <div className={innerContentClassName}>
            {contentBody}
          </div>
          {crawlOverlays}
        </React.Fragment>
      </div>
    </ErrorBoundary>
  )
}

const InitialAgentLoading: React.FC = () => {
  const { t } = useTranslation('organization')
  const selectedOrganizationId = useOrganizationStore(
    (state) => state.selectedOrganization?.id ?? null,
  )
  const organizationAccessRecoveryInFlight = useWsConnectionStore(
    (state) => state.organizationAccessRecoveryInFlight,
  )
  const organizationAccessBlocked = useWsConnectionStore(
    (state) => state.organizationAccessBlocked,
  )
  const organizationAccessBlockedId = useWsConnectionStore(
    (state) => state.organizationAccessBlockedId,
  )
  const organizationAccessBlockedName = useWsConnectionStore(
    (state) => state.organizationAccessBlockedName,
  )

  if (isOrganizationAccessBlockedFor(
    organizationAccessBlocked,
    organizationAccessBlockedId,
    selectedOrganizationId,
  )) {
    return (
      <div className="h-full flex items-center justify-center overflow-y-auto">
        <div className="flex flex-col items-center gap-3 px-8 py-12 text-center max-w-md">
          <div className="space-y-1">
            <p className="text-body font-medium text-foreground">
              {t('welcome.organizationBlockedTitle', '无法访问当前组织')}
            </p>
            <p className="text-body text-muted-foreground">
              {t('welcome.organizationBlockedDesc', '组织「{{name}}」已不存在或你已无访问权限，请在左侧选择其他组织', {
                name: organizationAccessBlockedName ?? t('unnamed', '组织'),
              })}
            </p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full flex items-center justify-center overflow-y-auto">
      <div className="flex flex-col items-center gap-3 px-8 py-12 text-center">
        <span
          aria-hidden
          className="block h-8 w-8 rounded-full border-2 border-border border-t-accent animate-spin"
        />
        <div className="space-y-1">
          <p className="text-body font-medium text-foreground">
            {organizationAccessRecoveryInFlight
              ? t('welcome.switchingOrganizationTitle', '正在切换组织...')
              : t('welcome.loadingTitle', '正在加载 Space...')}
          </p>
          <p className="text-body text-muted-foreground">
            {organizationAccessRecoveryInFlight
              ? t('welcome.switchingOrganizationDesc', '当前组织已无法访问，正在为你切换到可用组织')
              : t('welcome.loadingDesc', '正在同步你的组织和 Space 列表')}
          </p>
        </div>
      </div>
    </div>
  )
}
