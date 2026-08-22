import React from 'react'
import { AppHostClientProvider } from '@tabtin/app-host-sdk'
import { AppGlobalEffects } from '@components/app/AppGlobalEffects'
import { AppChatSync } from '@components/app/AppChatSync'
import { ApprovalMemoStoreSyncHost } from '@components/ApprovalMemoStoreSyncHost'
import { AgentCodeRootSyncHost } from '@components/AgentCodeRootSyncHost'
import { IMSessionKickedHost } from '@components/auth/IMSessionKickedHost'
import { AppErrorToast } from '@components/app/AppErrorToast'
import { AppGlobalSearch } from '@components/app/AppGlobalSearch'
import { AppNotificationActionHost } from '@components/app/AppNotificationActionHost'
import { AppDeepLink } from '@components/app/AppDeepLink'
import { AppDetachedIM } from '@components/app/AppDetachedIM'
import { ResourceLinkContextMenuHost } from '@components/chat/context/ResourceLinkContextMenu'
import { ChatResourcePreviewModal } from '@components/chat/preview/ChatResourcePreviewModal'
import { CloudDocumentPreviewModal } from '@components/chat/preview/CloudDocumentPreviewModal'
import { GlobalSharedSessionFilePreviewHost } from '@components/chat/shared-view/preview'
import '@components/chat/blocks/BlockTimeline'
import { ShellTitleBar } from '@components/platform/shell-title-bar'
import { ErrorBoundary } from '@components/common/ErrorBoundary'
import { LoadingSpinner } from '@tabtin/smartsheet-ui'
import { getSharedAppHostClient } from '@/adapters/sharedAppHostClient'
import { isDetachedIMWindow } from '@/utils/detachedIM'
import { SHELL_CANVAS_CLASS } from '@components/layout/shellUi'
import { Toaster } from '@tabtin/smartsheet-ui/toast'
import '@fontsource-variable/inter/index.css'
// Noto Sans SC 400/700（SIL OFL）本地打包：与 HTML→TabSlide 抽取端量框字重一致，
// 保证中文文本渲染字宽与量框相同，避免溢出/截断。不走 Google Fonts CDN。
import '@fontsource/noto-sans-sc/400.css'
import '@fontsource/noto-sans-sc/700.css'
import '@styles/globals.css'
import '@tabtin/smartsheet-ui/styles'
import '@styles/table-components.css'

let preloadedAppLayout: React.ComponentType | null = null
let appLayoutLoadPromise: Promise<{ default: React.ComponentType }> | null = null

const loadAppLayout = () => {
  appLayoutLoadPromise ??= import('@components/layout/AppLayout').then(m => {
    preloadedAppLayout = m.AppLayout
    return { default: m.AppLayout }
  }).catch(error => {
    appLayoutLoadPromise = null
    throw error
  })
  return appLayoutLoadPromise
}

const LazyAppLayout = React.lazy(loadAppLayout)
const ContextSpaceToolRuntime = React.lazy(
  () => import('@components/context-space/tools/ContextSpaceToolRuntime').then(m => ({ default: m.ContextSpaceToolRuntime }))
)
const AgentContextSwitchConfirmHost = React.lazy(
  () =>
    import('@components/app/AgentContextSwitchConfirmHost').then((m) => ({
      default: m.AgentContextSwitchConfirmHost,
    })),
)
const TabdocCloseConfirmHost = React.lazy(
  () =>
    import('@components/context-space/tabdoc/TabdocCloseConfirmHost').then((m) => ({
      default: m.TabdocCloseConfirmHost,
    })),
)
const SubagentTabCloseConfirmHost = React.lazy(
  () =>
    import('@components/chat/subagent/SubagentTabCloseConfirmHost').then((m) => ({
      default: m.SubagentTabCloseConfirmHost,
    })),
)
const DirtyExitConfirmHost = React.lazy(
  () =>
    import('@components/context-space/dirtyExitConfirm/DirtyExitConfirmHost').then((m) => ({
      default: m.DirtyExitConfirmHost,
    })),
)
// ChatResourcePreviewModal：顶层静态 import（见文件头），避免 lazy 双 store。
const InvitationInboxHost = React.lazy(
  () =>
    import('@components/invitation/InvitationInboxHost').then((m) => ({
      default: m.InvitationInboxHost,
    })),
)
const ProjectInvitationReminderHost = React.lazy(
  () =>
    import('@components/layout/project/ProjectInvitationReminderHost').then((m) => ({
      default: m.ProjectInvitationReminderHost,
    })),
)
const ResourceAccessRequestConfirmHost = React.lazy(
  () =>
    import('@components/tabchat/ResourceAccessRequestConfirmHost').then((m) => ({
      default: m.ResourceAccessRequestConfirmHost,
    })),
)
const isDetachedIM = isDetachedIMWindow()

const isComponentPreview = typeof window !== 'undefined'
  && import.meta.env.DEV
  && new URLSearchParams(window.location.search).get('mode') === 'component-preview'

const ChatComponentPreview = isComponentPreview
  ? React.lazy(() => import('@components/chat/dev-preview/ChatComponentPreview').then(m => ({ default: m.ChatComponentPreview })))
  : null

export const preloadAppLayout = () => {
  if (isDetachedIM || isComponentPreview) {
    return Promise.resolve(null)
  }
  return loadAppLayout()
}

/**
 * App 根组件 — 仅做路由分叉和组合，不订阅任何 store。
 *
 * 所有副作用下沉到 AppGlobalEffects（return null），
 * 所有条件 UI 各自独立组件各自订阅各自的状态。
 * 这样任何单一 store 变化只触发对应子树重渲染，不影响整棵 App 树。
 */
function App() {
  if (isDetachedIM) {
    return <AppDetachedIM />
  }

  if (isComponentPreview && ChatComponentPreview) {
    return (
      <div className="app">
        <React.Suspense fallback={<div className="flex h-screen w-screen items-center justify-center text-body text-muted-foreground">Loading preview...</div>}>
          <ChatComponentPreview />
        </React.Suspense>
      </div>
    )
  }

  // 全局兜底 client:share-dialog 等组件在 TabDoc 编辑器外被渲染时,通过 useAppHostClient
  // 找到此 Provider; TabdocPanelApp 内层 Provider 会覆盖, 不影响 TabDoc 编辑器专属 client。
  const sharedHostClient = getSharedAppHostClient()
  const AppLayout = preloadedAppLayout ?? LazyAppLayout

  return (
    <AppHostClientProvider value={sharedHostClient}>
    {/* 主窗 Windows 控件与拖窗由 ShellTopBar 承载。ShellTitleBar 仅在
        无顶栏窗口（如私信独立窗 fallbackDrag）渲染；此处默认 no-op。 */}
    <div className={`app relative flex h-screen flex-col overflow-hidden ${SHELL_CANVAS_CLASS}`}>
      <ShellTitleBar />
      <AppGlobalEffects isDetachedChat={false} hasMainWindowHost />
      <IMSessionKickedHost />
      <AppChatSync />
      <ApprovalMemoStoreSyncHost />
      <AgentCodeRootSyncHost />
      <div className="relative flex min-h-0 flex-1 flex-col">
        <ErrorBoundary
          fallback={
            <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-background text-foreground">
              <p className="text-subtitle text-muted-foreground">出了点问题</p>
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="text-body font-medium text-accent hover:text-accent/80 transition-colors duration-150"
              >
                刷新页面
              </button>
            </div>
          }
        >
          <React.Suspense fallback={<div className="flex h-full w-full items-center justify-center"><LoadingSpinner size="sm" /></div>}>
            <AppLayout />
          </React.Suspense>
        </ErrorBoundary>
      </div>
      <React.Suspense fallback={null}>
        <AgentContextSwitchConfirmHost />
        <TabdocCloseConfirmHost />
        <SubagentTabCloseConfirmHost />
        <DirtyExitConfirmHost />
        <ContextSpaceToolRuntime />
        <InvitationInboxHost />
        <ProjectInvitationReminderHost />
        <ResourceAccessRequestConfirmHost />
      </React.Suspense>
      <ChatResourcePreviewModal />
      <CloudDocumentPreviewModal />
      <GlobalSharedSessionFilePreviewHost />
      <AppGlobalSearch />
      <AppNotificationActionHost />
      <AppDeepLink />
      <AppErrorToast />
      <Toaster />
      <ResourceLinkContextMenuHost />
    </div>
    </AppHostClientProvider>
  )
}

export default App
