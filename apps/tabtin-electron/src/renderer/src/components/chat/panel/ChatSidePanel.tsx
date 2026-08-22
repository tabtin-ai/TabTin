/**
 * ChatSidePanel - 主聊天面板（embedded）
 *
 * 右上角折叠按钮的语义统一为"折叠/展开非主位面板"，按钮位置永远稳定在
 * ChatSidePanel 自身的 toolbar 右上角；具体行为随 sidebarMode + canvasCollapsed 变：
 *
 *  | sidebarMode    | canvasCollapsed | 按钮行为                          | 图标          |
 *  |---------------|-----------------|----------------------------------|---------------|
 *  | desktop（聊天次位）  | -               | 折叠聊天自身（自向右收）            | ChevronRight |
 *  | conversations | false (画布展开) | 折叠右侧画布                      | ChevronRight |
 *  | conversations | true (画布折叠)  | 展开右侧画布（画布从右推回来）       | ChevronLeft  |
 *
 * 设计核心：折叠按钮位置稳定（用户肌肉记忆），不污染画布顶部的 tab 栏。
 * 桌面模式下聊天被折叠后整个 ChatSidePanel 消失，那时候由 AppLayout 渲染
 * 一个参与 shell 布局的窄入口栏，与本组件无关。
 */

import React, { useLayoutEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { ChatPanel } from './ChatPanel'
import { useUIStore } from '../../../stores/useUIStore'
import { useChatStore } from '../../../stores/chat/useChatStore'
import { useAuthStore } from '../../../stores/useAuthStore'
import { useSpaceViewPrefsStore } from '../../../stores/useSpaceViewPrefsStore'
import type { SpaceContext } from '@components/context-space/SpaceContextContainer'
import { ChatIconTooltip } from './ChatIconTooltip'
import {
  resolveWorkspaceContextState,
} from '@components/layout/workspaceContextState'
import {
  consumeCapsuleMorph,
  getRailMorphRevealDelayMs,
  shouldHideRailForMorph,
} from '@components/chat/capsule/chatCapsuleMorph'
import { resolveMorphFinalRailRect } from '@components/chat/capsule/resolveMorphFinalRailRect'

const toolbarIconBtn =
  'h-8 w-8 inline-flex items-center justify-center rounded-interactive text-muted-foreground/60 hover:text-foreground hover:bg-foreground/[0.03] dark:hover:bg-foreground/[0.05] transition-colors no-drag'

interface ChatSidePanelProps {
  spaceContext: SpaceContext
  organizationId?: string | null
}

export const ChatSidePanel: React.FC<ChatSidePanelProps> = React.memo(({
  spaceContext,
  organizationId,
}) => {
  const { t } = useTranslation('chat')
  const railRef = useRef<HTMLDivElement>(null)
  const toggleChatSidePanel = useUIStore(state => state.toggleChatSidePanel)
  const currentUserId = useAuthStore(state => state.user?.id ?? null)
  const currentSessionId = useChatStore(state => state.currentSessionId)
  const isTeamSpace = (spaceContext as { type?: string }).type === 'team_space'

  const resolvedOrganizationId = useMemo(() => {
    return (
      organizationId ||
      spaceContext.organization_id ||
      null
    )
  }, [spaceContext.organization_id, organizationId])

  const sidebarMode = useSpaceViewPrefsStore(state =>
    state.getSidebarMode(resolvedOrganizationId, currentUserId, spaceContext.id),
  )
  const workspaceContext = useMemo(() => resolveWorkspaceContextState({
    workbenchMode: 'space',
    sidebarMode,
    organizationId: resolvedOrganizationId,
    userId: currentUserId,
    executionSpaceId: spaceContext.id,
    sessionId: currentSessionId,
  }), [currentSessionId, currentUserId, resolvedOrganizationId, sidebarMode, spaceContext.id])
  const canvasCollapsed = useSpaceViewPrefsStore(state =>
    state.getCanvasCollapsed(workspaceContext.key, spaceContext.id),
  )
  const toggleCanvasCollapsedForScope = useSpaceViewPrefsStore(state => state.toggleCanvasCollapsedForScope)
  const isMac = useMemo(() => {
    if (typeof navigator === 'undefined') return false
    return /Mac|Macintosh/i.test(navigator.platform || '') || /Mac OS X/i.test(navigator.userAgent || '')
  }, [])
  const shortcutLabel = isMac ? '⌘J' : 'Ctrl+J'

  /**
   * 三态：折叠按钮永远存在，行为按 sidebarMode + canvasCollapsed 决定。
   *  - 'collapse-chat'：桌面模式 → 折叠聊天自身
   *  - 'collapse-canvas'：对话模式 + 画布展开 → 折叠右侧画布
   *  - 'expand-canvas'：对话模式 + 画布折叠 → 把画布从右边召回
   */
  const collapseButtonRole: 'collapse-chat' | 'collapse-canvas' | 'expand-canvas' =
    isTeamSpace
      ? 'collapse-chat'
      : sidebarMode === 'conversations'
      ? canvasCollapsed
        ? 'expand-canvas'
        : 'collapse-canvas'
      : 'collapse-chat'

  const handleCollapseClick = () => {
    if (collapseButtonRole === 'collapse-chat') {
      toggleChatSidePanel()
    } else {
      toggleCanvasCollapsedForScope(workspaceContext.key)
    }
  }

  const collapseButtonTitle = (() => {
    switch (collapseButtonRole) {
      case 'collapse-chat':
        return `${t('sidePanel.collapse')} (${shortcutLabel})`
      case 'collapse-canvas':
        return `收起画布 (${shortcutLabel})`
      case 'expand-canvas':
        return `展开画布 (${shortcutLabel})`
    }
  })()

  const collapseButtonIcon = collapseButtonRole === 'expand-canvas'
    ? <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
    : <ChevronRight className="h-3.5 w-3.5" aria-hidden />

  // 正式任务的视图切换收口到 shell 顶栏；这里仅保留桌面辅助聊天的折叠入口。
  const showCollapseButton = collapseButtonRole === 'collapse-chat'

  const panelActionsNode = (
    <div className="flex items-center gap-0.5 no-drag">
      {showCollapseButton ? (
        <ChatIconTooltip content={collapseButtonTitle}>
          <button
            type="button"
            onClick={handleCollapseClick}
            className={toolbarIconBtn}
            aria-label={collapseButtonTitle}
          >
            {collapseButtonIcon}
          </button>
        </ChatIconTooltip>
      ) : null}
    </div>
  )

  useLayoutEffect(() => {
    const el = railRef.current
    if (!el) return
    // 按主位最低可读宽夹紧辅位最终宽，避免小窗口下 ghost 目标与真实列宽不一致
    const finalRect = resolveMorphFinalRailRect(el)
    const morphing = consumeCapsuleMorph('to-rail', el, finalRect ? { finalRect } : undefined)
    // Strict Mode 二次挂载时 consume 只成功一次；用 reveal 窗口对齐胶囊侧 shouldHideCapsuleForMorph。
    const hideMs = morphing ? getRailMorphRevealDelayMs() : (shouldHideRailForMorph() ? getRailMorphRevealDelayMs() : 0)
    if (hideMs <= 0) return
    el.style.opacity = '0'
    const timer = window.setTimeout(() => {
      el.style.opacity = ''
    }, hideMs)
    return () => {
      el.style.opacity = ''
      window.clearTimeout(timer)
    }
  }, [])

  return (
    <div
      ref={railRef}
      data-task-chat-rail
      className="h-full w-full min-w-0 flex flex-col overflow-hidden"
    >
      <div className="h-full w-full min-w-0 flex flex-col overflow-hidden">
        <div className="flex-1 min-h-0 w-full overflow-hidden">
          <ChatPanel
            isActive={true}
            variant="embedded"
            hideSessionTabs
            // ：空 React 容器会让 ChatSessionBar 误撑出 40px 工具栏。
            panelActions={showCollapseButton ? panelActionsNode : undefined}
            // 「任务」模式下侧边栏顶部已有「新任务」草稿入口，顶部 toolbar 的
            // 「新任务」按钮与之重复，关掉；「应用」模式侧栏展示的是应用、
            // 没有会话入口，保留它作为新建入口。
            showInlineNewTopicButton={sidebarMode !== 'conversations'}
            // 同理，「任务」模式下侧边栏已完整展示会话列表，顶部「最近对话」
            // 横向标签条与之重复，关掉；「应用」模式保留作为快速切会话入口。
            showInlineHistory={sidebarMode !== 'conversations'}
            spaceContext={spaceContext}
            organizationId={resolvedOrganizationId}
            sessionListScope={isTeamSpace ? 'selectedSpaceOnly' : 'organization'}
          />
        </div>
      </div>
    </div>
  )
})
ChatSidePanel.displayName = 'ChatSidePanel'
