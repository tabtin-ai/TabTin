import React, { useMemo, useRef, useEffect, useCallback } from 'react'
import { Archive, Check, GitFork, Loader2, MoreHorizontal, PenLine, Plus, SquarePen, Users } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@components/ui'
import { cn } from '@utils/cn'
import type { ChatSession } from '@tabtin/chat-client'
import { SIDEBAR_ICON_STROKE } from '@components/layout/sidebarUi'
import { ChatIconTooltip } from '../panel/ChatIconTooltip'

const CHAT_SESSION_TAB_CLASS =
  'group relative box-border flex h-7 min-w-[48px] shrink-0 items-center gap-1 overflow-hidden whitespace-nowrap rounded-interactive border border-transparent px-2 text-caption transition-colors duration-150'
const CHAT_SESSION_TAB_ACTIVE_CLASS =
  'bg-foreground/[0.06] text-foreground font-medium dark:bg-foreground/[0.08]'
const CHAT_SESSION_TAB_INACTIVE_CLASS =
  'text-muted-foreground hover:bg-foreground/[0.03] hover:text-foreground dark:hover:bg-foreground/[0.05]'
const CHAT_SESSION_TAB_BADGE_CLASS =
  'shrink-0 max-w-[96px] truncate rounded bg-foreground/[0.045] px-1.5 py-0.5 text-caption leading-none text-muted-foreground/80 dark:bg-foreground/[0.06]'
const MAX_VISIBLE_TABS = 20

export interface ChatSessionSwitcherTabsProps {
  className?: string
  style?: React.CSSProperties
  sortedSessions: ChatSession[]
  currentSessionId: string | null
  isDraftActive: boolean
  draftTitle: string
  draftEntryTitle: string
  draftBadge: string
  isAlreadyOnNewTask: boolean
  alreadyOnNewTaskLabel: string
  suspendedSessionIds: string[]
  forkingSessionId: string | null
  onSelectSession: (sessionId: string) => void | Promise<void>
  onCreateSession?: () => void | Promise<void>
  onDeleteSession?: (sessionId: string) => void | Promise<void>
  onForkSession?: (sessionId: string) => void | Promise<void>
  onRenameSession?: (sessionId: string) => void
  /**  共享任务：共享给同事（脱敏投影 + 可选 fork） */
  onShareToColleague?: (sessionId: string) => void
  onArchiveRequest: (sessionId: string) => void
  getTabLabel: (session: ChatSession) => string
  t: (key: string, opts?: Record<string, unknown>) => string
}

export const ChatSessionSwitcherTabs: React.FC<ChatSessionSwitcherTabsProps> = ({
  className,
  style,
  sortedSessions,
  currentSessionId,
  isDraftActive,
  draftTitle,
  draftEntryTitle,
  draftBadge,
  isAlreadyOnNewTask,
  alreadyOnNewTaskLabel,
  suspendedSessionIds,
  forkingSessionId,
  onSelectSession,
  onCreateSession,
  onDeleteSession,
  onForkSession,
  onRenameSession,
  onShareToColleague,
  onArchiveRequest,
  getTabLabel,
  t,
}) => {
  const tabsContainerRef = useRef<HTMLDivElement>(null)

  const visibleTabs = useMemo(() => {
    if (sortedSessions.length <= MAX_VISIBLE_TABS) return sortedSessions
    const top = sortedSessions.slice(0, MAX_VISIBLE_TABS)
    if (currentSessionId && !top.some(s => s.id === currentSessionId)) {
      const active = sortedSessions.find(s => s.id === currentSessionId)
      if (active) top[MAX_VISIBLE_TABS - 1] = active
    }
    return top
  }, [sortedSessions, currentSessionId])

  useEffect(() => {
    if (!currentSessionId || !tabsContainerRef.current) return
    const activeTab = tabsContainerRef.current.querySelector(`[data-session-id="${currentSessionId}"]`)
    activeTab?.scrollIntoView({ behavior: 'instant', block: 'nearest', inline: 'nearest' })
  }, [currentSessionId, sortedSessions.length])

  const handleTabKeyDown = useCallback((event: React.KeyboardEvent, sessionId: string) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    void onSelectSession(sessionId)
  }, [onSelectSession])

  return (
    <div
      className={cn('relative z-banner flex min-h-10 items-center bg-transparent flex-shrink-0 no-drag px-2 py-1', className)}
      style={style}
    >
      <div className="flex-1 min-w-0 mr-1.5 overflow-x-auto scrollbar-none">
        <div ref={tabsContainerRef} className="flex min-w-max items-center gap-0.5">
          {isDraftActive && (
            <div
              data-session-id="__draft__"
              className={cn(CHAT_SESSION_TAB_CLASS, CHAT_SESSION_TAB_ACTIVE_CLASS)}
              title={draftEntryTitle}
            >
              <SquarePen className="h-3.5 w-3.5 shrink-0 text-accent-text/80" strokeWidth={SIDEBAR_ICON_STROKE} />
              <span className="truncate max-w-[112px]">{draftTitle}</span>
              <span className={CHAT_SESSION_TAB_BADGE_CLASS}>{draftBadge}</span>
            </div>
          )}
          {visibleTabs.map((session) => {
            const isActive = session.id === currentSessionId
            return (
              <div
                key={session.id}
                role="button"
                tabIndex={0}
                data-session-id={session.id}
                onClick={() => { void onSelectSession(session.id) }}
                onKeyDown={(event) => handleTabKeyDown(event, session.id)}
                className={cn(
                  CHAT_SESSION_TAB_CLASS,
                  isActive ? CHAT_SESSION_TAB_ACTIVE_CLASS : CHAT_SESSION_TAB_INACTIVE_CLASS,
                )}
                title={session.title || t('panel.newChat', { defaultValue: '新任务' })}
              >
                {suspendedSessionIds.includes(session.id) && (
                  <Loader2 className="h-3 w-3 shrink-0 text-warning animate-spin" />
                )}
                <span className="truncate max-w-[160px]">{getTabLabel(session)}</span>
                {onDeleteSession && session.status !== 'archived' && (
                  <ChatIconTooltip content={t('session.archiveTitle', { defaultValue: '归档对话' })}>
                    <span
                      className={cn(
                        'ml-0.5 rounded-interactive p-0.5 transition-opacity',
                        isActive ? 'opacity-50 hover:opacity-100' : 'opacity-0 group-hover:opacity-60 group-hover:hover:opacity-100',
                      )}
                      onClick={(event) => {
                        event.stopPropagation()
                        onArchiveRequest(session.id)
                      }}
                      role="button"
                      aria-label={t('session.archiveTitle', { defaultValue: '归档对话' })}
                    >
                      <Archive className="h-2.5 w-2.5" />
                    </span>
                  </ChatIconTooltip>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {onCreateSession && (
        <ChatIconTooltip content={isAlreadyOnNewTask ? alreadyOnNewTaskLabel : t('session.new', { defaultValue: '新建' })}>
          <button
            type="button"
            disabled={isAlreadyOnNewTask}
            onClick={() => {
              if (isAlreadyOnNewTask) return
              void onCreateSession()
            }}
            className={cn(
              'flex-shrink-0 inline-flex items-center justify-center h-7 w-7 rounded-interactive text-muted-foreground/60 hover:text-foreground hover:bg-foreground/[0.03] dark:hover:bg-foreground/[0.05] transition-colors mr-0.5',
              isAlreadyOnNewTask && 'cursor-not-allowed opacity-40 hover:bg-transparent hover:text-muted-foreground/60',
            )}
            aria-label={isAlreadyOnNewTask ? alreadyOnNewTaskLabel : t('session.new', { defaultValue: '新建' })}
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </ChatIconTooltip>
      )}

      <DropdownMenu>
        <ChatIconTooltip content={t('panel.recentSessions', { defaultValue: '最近对话' })}>
          <DropdownMenuTrigger asChild>
            <button
              className="flex-shrink-0 inline-flex items-center justify-center h-7 w-7 rounded-interactive text-muted-foreground/60 hover:text-foreground hover:bg-foreground/[0.03] dark:hover:bg-foreground/[0.05] transition-colors"
              aria-label={t('panel.recentSessions', { defaultValue: '最近对话' })}
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
        </ChatIconTooltip>
        <DropdownMenuContent side="bottom" align="end" className="w-64">
          {!isDraftActive && sortedSessions.length === 0 ? (
            <DropdownMenuItem disabled>
              {t('session.emptyTitle', { defaultValue: '暂无对话' })}
            </DropdownMenuItem>
          ) : (
            <>
              {isDraftActive && (
                <>
                  <DropdownMenuItem disabled>
                    <Check className="h-3.5 w-3.5" />
                    <span className="truncate">{draftTitle}</span>
                    <span className="ml-auto max-w-[45%] truncate text-caption text-muted-foreground/60">{draftBadge}</span>
                  </DropdownMenuItem>
                  {sortedSessions.length > 0 && <DropdownMenuSeparator />}
                </>
              )}
              {sortedSessions.slice(0, 12).map((session) => (
                <DropdownMenuItem
                  key={session.id}
                  onSelect={() => void onSelectSession(session.id)}
                >
                  {session.id === currentSessionId && <Check className="h-3.5 w-3.5" />}
                  <span className="truncate">{session.title || t('panel.newChat', { defaultValue: '新任务' })}</span>
                </DropdownMenuItem>
              ))}
              {onForkSession && currentSessionId && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    disabled={forkingSessionId === currentSessionId}
                    onSelect={() => void onForkSession(currentSessionId)}
                  >
                    {forkingSessionId === currentSessionId
                      ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      : <GitFork className="h-3.5 w-3.5" />}
                    <span>{t('session.forkSession')}</span>
                  </DropdownMenuItem>
                </>
              )}
              {onShareToColleague && currentSessionId && (
                <DropdownMenuItem onSelect={() => onShareToColleague(currentSessionId)}>
                  <Users className="h-3.5 w-3.5" />
                  <span>{t('session.shareToColleague', { defaultValue: '共享给同事' })}</span>
                </DropdownMenuItem>
              )}
              {onRenameSession && currentSessionId && (
                <DropdownMenuItem onSelect={() => onRenameSession(currentSessionId)}>
                  <PenLine className="h-3.5 w-3.5" />
                  <span>{t('session.renameTitle', { defaultValue: '重命名对话' })}</span>
                </DropdownMenuItem>
              )}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
