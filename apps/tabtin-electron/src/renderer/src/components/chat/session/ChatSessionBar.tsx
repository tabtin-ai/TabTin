/**
 * ChatSessionBar — 会话切换 + panelActions 的顶部栏
 *
 * 提取自 ChatPanel.tsx，用于 embedded 模式下的顶部区域。
 * 包含 CompactGitStatus、面板操作按钮和 ChatSessionSwitcher。
 *
 * `showInlineNewTopicAction`（默认 false）控制是否在顶部 toolbar 左侧渲染
 * 「新话题」入口。`hideSessionTabs=true` 的场景（如 ChatSidePanel 嵌入式
 * 聊天）下打开它，把原本散落在侧边栏的新话题入口收敛到聊天面板自己的
 * 顶部，让用户在聊天上下文内能直接发起新会话。
 */

import React from 'react'
import { PenLine } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { CompactGitStatus } from '../../space-settings/CompactGitStatus'
import { ChatSessionSwitcher } from './ChatSessionSwitcher'
import { ChatSessionHistoryMenu } from './ChatSessionHistoryMenu'
import { CheckpointBrowseTrigger } from '@components/checkpoint/CheckpointBrowseTrigger'
import { useShellTopBarInset } from '@components/layout/shellTopBarInset'
import { CHAT_PAGE_GUTTER } from '../registry/chatDesignTokens'
import type { ChatSession } from '@tabtin/chat-client'
import type { ExternalArchiveDeleteTarget } from './ExternalArchiveDeleteDialog'

interface ChatSessionBarProps {
  selectedSpaceId: string | null
  draftBadgeSpaceId?: string | null
  sessions: ChatSession[]
  currentSessionId: string | null
  showDraftSession: boolean
  showSessionTabs: boolean
  compactLeft: boolean
  panelActions?: React.ReactNode
  showInlineNewTopicAction?: boolean
  /**
   * 在顶部 toolbar 左侧渲染最近对话标签。
   * 用于 `hideSessionTabs` 的右侧 dock 面板——既没有完整 tabs 又需要切回旧会话。
   */
  showInlineHistoryAction?: boolean
  onSelectSession: (sessionId: string) => void
  onCreateSession: () => void
  onDeleteSession: (sessionId: string) => void
  onDeleteExternalArchive?: (target: ExternalArchiveDeleteTarget) => void | Promise<void>
  onRenameSession?: (sessionId: string, title: string) => void | Promise<void>
  onForkSession: (sessionId: string, messageId?: string) => void
}

export const ChatSessionBar: React.FC<ChatSessionBarProps> = React.memo(({
  selectedSpaceId,
  draftBadgeSpaceId,
  sessions,
  currentSessionId,
  showDraftSession,
  showSessionTabs,
  compactLeft,
  panelActions,
  showInlineNewTopicAction = false,
  showInlineHistoryAction = false,
  onSelectSession,
  onCreateSession,
  onDeleteSession,
  onDeleteExternalArchive,
  onRenameSession,
  onForkSession,
}) => {
  const { t } = useTranslation('chat')
  const { chat: topBarInsetLeft, chatRight: topBarInsetRight } = useShellTopBarInset()
  const topBarInsetStyle: React.CSSProperties | undefined =
    topBarInsetLeft > 0 || topBarInsetRight > 0
      ? {
          paddingLeft: topBarInsetLeft > 0 ? topBarInsetLeft + 8 : undefined,
          paddingRight: topBarInsetRight > 0 ? topBarInsetRight : undefined,
        }
      : undefined
  // 折叠态下聊天是最左列时，即便没有其它工具项也要把 toolbar 撑起来承载展开按钮。
  // 正式任务的快照入口已并入 TaskWorkspaceHeader，避免相机单独撑起一整条空工具栏。
  const showCheckpointEntry = Boolean(selectedSpaceId && showSessionTabs)
  const showToolbar =
    Boolean(panelActions) || showInlineNewTopicAction || showInlineHistoryAction || showCheckpointEntry
  const newTopicLabel = t('sessionList.newTopic', { defaultValue: '新任务' })

  return (
    <>
      {selectedSpaceId && (
        <CompactGitStatus spaceId={selectedSpaceId} className="border-b border-border/10" />
      )}
      {showToolbar ? (
        <div
          className="relative z-banner flex min-h-10 shrink-0 items-center gap-2 border-b border-transparent px-2 py-1"
          style={topBarInsetStyle}
        >
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            {showInlineNewTopicAction ? (
              <div>
                <button
                  type="button"
                  onClick={onCreateSession}
                  className="inline-flex h-7 min-w-[48px] shrink-0 items-center gap-1 whitespace-nowrap rounded-interactive border border-transparent box-border bg-foreground/[0.03] px-2 text-caption text-foreground/80 transition-colors hover:bg-foreground/[0.05] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-1 dark:bg-foreground/[0.05] dark:hover:bg-foreground/[0.08]"
                  title={newTopicLabel}
                  aria-label={newTopicLabel}
                >
                  <PenLine className="h-3 w-3" aria-hidden />
                  <span>{newTopicLabel}</span>
                </button>
              </div>
            ) : null}
            {showInlineHistoryAction ? (
              <ChatSessionHistoryMenu
                sessions={sessions}
                currentSessionId={currentSessionId}
                onSelectSession={onSelectSession}
                onDeleteSession={onDeleteSession}
                onDeleteExternalArchive={onDeleteExternalArchive}
              />
            ) : null}
          </div>
          <div className="app-region-no-drag flex shrink-0 items-center gap-0.5">
            {showCheckpointEntry && selectedSpaceId ? (
              <CheckpointBrowseTrigger spaceId={selectedSpaceId} sessionId={currentSessionId} />
            ) : null}
            {panelActions}
          </div>
        </div>
      ) : null}
      {showSessionTabs ? (
        <ChatSessionSwitcher
          variant="tabs"
          sessions={sessions}
          currentSessionId={currentSessionId}
          showDraftSession={showDraftSession}
          onSelectSession={onSelectSession}
          onCreateSession={onCreateSession}
          onDeleteSession={onDeleteSession}
          onRenameSession={onRenameSession}
          onForkSession={onForkSession}
          className={compactLeft ? CHAT_PAGE_GUTTER.compact.content : undefined}
          style={topBarInsetStyle}
          scopeKey={selectedSpaceId}
          draftBadgeSpaceId={draftBadgeSpaceId}
        />
      ) : null}
    </>
  )
})
ChatSessionBar.displayName = 'ChatSessionBar'
