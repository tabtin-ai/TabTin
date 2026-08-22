import React from 'react'
import type { ShellSidePanelMode } from './useShellLayoutState'
import { NavigationListSkeleton } from '@components/common/ListSkeletons'
import { ErrorBoundary } from '@components/common/ErrorBoundary'
import type { SpaceContext } from '@components/context-space/SpaceContextContainer'
import { useShellTopBarInset } from './shellTopBarInset'

const loadSpaceChatRailHost = () =>
  import('./SpaceChatRailHost').then((m) => ({ default: m.SpaceChatRailHost }))
const SpaceChatRailHost = React.lazy(loadSpaceChatRailHost)
const TabChatPanel = React.lazy(
  () => import('@components/tabchat/TabChatPanel').then((m) => ({ default: m.TabChatPanel })),
)

/**
 * 预热聊天栏 chunk（SpaceChatRailHost → ChatSidePanel → ChatPanel 同 chunk）。
 * 与 renderPane 内 React.lazy 共用同一个 loader，供首屏 preload 提前拉取，
 * 减少「外壳挂载后右侧聊天栏闪骨架」的阶段。
 */
export const preloadChatRail = (): Promise<unknown> => loadSpaceChatRailHost()

interface ShellSidePanelContentProps {
  mode: ShellSidePanelMode
  activeSpaceContext?: SpaceContext | null
  /** IM 会话桌面由右侧收起栏和画布承载资源入口时，隐藏聊天头部重复筛选。 */
  hideImContentTabs?: boolean
}

export const ShellSidePanelContent: React.FC<ShellSidePanelContentProps> = ({
  mode,
  activeSpaceContext = null,
  hideImContentTabs = false,
}) => {
  const { chat: topBarLeftInset, chatRight: topBarRightInset } = useShellTopBarInset()

  return (
    <ErrorBoundary
      variant="region"
      resetKeys={[mode, activeSpaceContext?.id ?? null]}
    >
      <React.Suspense fallback={<ShellChatPanelSkeleton />}>
        {mode === 'im' ? (
          <TabChatPanel
            // IM 会话列表在 shell 第二列（SpaceSidebarGlobal → SidebarIMPanel），
            // 这条 rail 只渲染当前会话聊天区。
            mode="panel"
            topBarLeftInset={topBarLeftInset}
            topBarRightInset={topBarRightInset}
            hideContentTabs={hideImContentTabs}
          />
        ) : activeSpaceContext ? (
          <SpaceChatRailHost activeSpaceContext={activeSpaceContext} />
        ) : (
          <ShellChatPanelSkeleton />
        )}
      </React.Suspense>
    </ErrorBoundary>
  )
}

const ShellChatPanelSkeleton: React.FC = () => (
  <div className="h-full w-full overflow-y-auto bg-background py-2">
    <NavigationListSkeleton count={7} />
  </div>
)
