import React from 'react'
import { MessageSquare, SquarePen } from 'lucide-react'
import { cn } from '@utils/cn'
import { ChatHistorySkeleton } from '@components/common/ListSkeletons'
import { SidebarMenuItem } from '@components/layout/SidebarMenuItem'
import {
  SIDEBAR_ICON,
  SIDEBAR_MENU_ICON_STROKE,
} from '@components/layout/sidebarUi'
import type { Virtualizer } from '@tanstack/react-virtual'
import type { SessionListVirtualItem } from './buildSessionListVirtualItems'
import { SessionListVirtualRow } from './SessionListVirtualRow'
import type { SessionListVirtualRowProps } from './SessionListVirtualRow'

export interface SessionNewConversationEntryProps {
  isDraftActive: boolean
  draftTitle: string
  draftEntryTitle: string
  draftBadge: string
  createEntryTitle: string
  isAlreadyOnNewTask: boolean
  currentWorkspaceBadge: string | null
  onCreateSession?: () => void | Promise<void>
}

export const SessionNewConversationEntry: React.FC<SessionNewConversationEntryProps> = ({
  isDraftActive,
  draftTitle,
  draftEntryTitle,
  draftBadge,
  createEntryTitle,
  isAlreadyOnNewTask,
  currentWorkspaceBadge,
  onCreateSession,
}) => {
  // 任务侧栏主导航已有固定「新任务」；未注入 onCreateSession 时不再二次渲染。
  if (!onCreateSession) return null

  // 纯草稿 / 预建空会话：由顶部「新任务」承载选中态。
  if (isAlreadyOnNewTask) {
    const activeBadge = (isDraftActive ? draftBadge : currentWorkspaceBadge) ?? draftBadge
    return (
      <SidebarMenuItem
        as="div"
        active
        fullWidth
        className="cursor-default"
        title={isDraftActive ? draftEntryTitle : (activeBadge ? `${draftTitle} · ${activeBadge}` : draftTitle)}
        aria-current="page"
        leading={<SquarePen className={SIDEBAR_ICON} strokeWidth={SIDEBAR_MENU_ICON_STROKE} />}
        label={draftTitle}
        meta={activeBadge}
      />
    )
  }

  return (
    <SidebarMenuItem
      as="button"
      fullWidth
      onClick={() => { void onCreateSession() }}
      title={createEntryTitle}
      aria-label={draftTitle}
      leading={<SquarePen className={SIDEBAR_ICON} strokeWidth={SIDEBAR_MENU_ICON_STROKE} />}
      label={draftTitle}
      meta={currentWorkspaceBadge ?? undefined}
    />
  )
}

export interface ChatSessionSwitcherListProps {
  className?: string
  isTrackerRunsOnly: boolean
  isLoading: boolean
  isDraftActive: boolean
  flatListItems: SessionListVirtualItem[]
  listFooter?: React.ReactNode
  newConversationEntry: React.ReactNode
  listParentRef: React.RefObject<HTMLDivElement | null>
  virtualizer: Virtualizer<HTMLDivElement, Element>
  virtualItems: ReturnType<Virtualizer<HTMLDivElement, Element>['getVirtualItems']>
  virtualRowProps: Omit<SessionListVirtualRowProps, 'item'>
  t: (key: string, opts?: Record<string, unknown>) => string
}

export const ChatSessionSwitcherList: React.FC<ChatSessionSwitcherListProps> = ({
  className,
  isTrackerRunsOnly,
  isLoading,
  isDraftActive,
  flatListItems,
  listFooter,
  newConversationEntry,
  listParentRef,
  virtualizer,
  virtualItems,
  virtualRowProps,
  t,
}) => (
  <div className={cn('flex h-full min-h-0 flex-col', className)}>
    {!isTrackerRunsOnly && newConversationEntry && (
      <div className="pb-1 flex-shrink-0">
        {newConversationEntry}
      </div>
    )}

    {isLoading && flatListItems.length === 0 && !isDraftActive ? (
      <div className="min-h-0 flex-1 px-2 py-2">
        <ChatHistorySkeleton />
      </div>
    ) : flatListItems.length === 0 && !isDraftActive ? (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center text-muted-foreground/60">
        <MessageSquare className="mb-2 h-6 w-6 opacity-30" />
        <p className="text-body">{t('sessionList.empty', { defaultValue: '暂无对话' })}</p>
      </div>
    ) : (
      <div
        ref={listParentRef}
        className="scrollbar-hover min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto pb-1"
      >
        <div
          style={{
            height: virtualizer.getTotalSize(),
            width: '100%',
            position: 'relative',
          }}
        >
          {virtualItems.map((virtualItem) => {
            const item = flatListItems[virtualItem.index]
            if (!item) return null
            return (
              <div
                key={virtualItem.key}
                data-index={virtualItem.index}
                ref={virtualizer.measureElement}
                className="min-w-0 overflow-hidden pb-0.5"
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  // minHeight=size：为虚表占位；内容更高时可撑开并被 measure 纠正。
                  minHeight: `${virtualItem.size}px`,
                  transform: `translateY(${virtualItem.start}px)`,
                }}
              >
                <SessionListVirtualRow item={item} {...virtualRowProps} />
              </div>
            )
          })}
        </div>
        {listFooter}
      </div>
    )}
  </div>
)
