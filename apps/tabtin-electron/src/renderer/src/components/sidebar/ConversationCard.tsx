import React, { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { GitFork } from 'lucide-react'
import { ContextMenu, ContextMenuItem } from '@tabtin/smartsheet-ui'
import type { ChatSessionWithAgent } from '@tabtin/chat-client'
import { cn } from '@utils/cn'

interface ConversationCardProps {
  session: ChatSessionWithAgent
  isSelected: boolean
  onSelect: (sessionId: string) => void
  onAgentClick?: (agentId: string) => void
  onOrganizationClick?: (organizationId: string) => void
  onFork?: (sessionId: string) => void
  isForkingThis?: boolean
  /** 用于团队筛选回调，通常传 session.organization_id */
  organizationId?: string
  isUnread?: boolean
  showAgentMeta?: boolean
  organizationInfo?: { type: string; name: string } | null
}

function formatRelativeTime(
  dateStr: string | null | undefined,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  if (!dateStr) return ''
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMin = Math.floor(diffMs / 60000)
  if (diffMin < 1) return t('conversations.justNow')
  if (diffMin < 60) return t('conversations.minutesAgo', { count: diffMin })
  const diffHour = Math.floor(diffMin / 60)
  if (diffHour < 24) return t('conversations.hoursAgo', { count: diffHour })
  const diffDay = Math.floor(diffHour / 24)
  if (diffDay < 7) return t('conversations.daysAgo', { count: diffDay })
  return date.toLocaleDateString()
}

export const ConversationCard: React.FC<ConversationCardProps> = React.memo(
  ({
    session,
    isSelected,
    onSelect,
    onAgentClick,
    onOrganizationClick,
    onFork,
    isForkingThis,
    organizationId,
    isUnread,
    showAgentMeta = false,
    organizationInfo,
  }) => {
    const { t } = useTranslation('sidebar')
    const { t: tChat } = useTranslation('chat')
    const [ctxMenu, setCtxMenu] = useState<{ open: boolean; x: number; y: number }>({ open: false, x: 0, y: 0 })

    const displayTitle =
      session.title || t('conversations.untitledSession', { agent: session.agent_name || 'Agent' })

    const timeText = formatRelativeTime(
      session.last_message_at || session.updated_at,
      t,
    )

    const handleAgentClick = useCallback(
      (e: React.MouseEvent) => {
        e.stopPropagation()
        if (onAgentClick && session.agent_id) {
          onAgentClick(session.agent_id)
        }
      },
      [onAgentClick, session.agent_id],
    )

    const effectiveOrganizationId = organizationId ?? session.organization_id
    const organizationTagInteractive = Boolean(onOrganizationClick && effectiveOrganizationId && organizationInfo)

    const handleOrganizationTagClick = useCallback(
      (e: React.MouseEvent) => {
        e.stopPropagation()
        if (onOrganizationClick && effectiveOrganizationId) {
          onOrganizationClick(effectiveOrganizationId)
        }
      },
      [onOrganizationClick, effectiveOrganizationId],
    )

    const shouldRenderMetaRow = showAgentMeta

    const agentNameInteractive = Boolean(onAgentClick && session.agent_id)

    return (
      <>
      <button
        type="button"
        onClick={() => onSelect(session.id)}
        onContextMenu={(e) => {
          if (!onFork) return
          e.preventDefault()
          setCtxMenu({ open: true, x: e.clientX, y: e.clientY })
        }}
        className={cn(
          'group relative w-full rounded-xl border px-2.5 py-2 text-left transition-all',
          isSelected
            ? 'bg-accent/15 border-accent/45'
            : 'bg-transparent border-transparent hover:bg-muted/45 hover:border-border/35',
        )}
      >
        <div className="min-w-0 space-y-1">
          <div className="flex items-start gap-2">
            <div className="flex min-w-0 flex-1 items-center gap-1">
              {session.has_active_task && (
                <span className="mt-0.5 h-2 w-2 shrink-0 rounded-full bg-primary" />
              )}
              <span className="truncate text-body font-medium">
                {displayTitle}
              </span>
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-1.5">
              {onFork && (
                <span
                  role="button"
                  tabIndex={0}
                  title={tChat('session.forkSession')}
                  aria-label={tChat('session.forkSession')}
                  className={cn(
                    'h-5 w-5 inline-flex items-center justify-center rounded-md text-muted-foreground/40 transition-all',
                    'opacity-100 [@media(hover:hover)_and_(pointer:fine)]:opacity-0 [@media(hover:hover)_and_(pointer:fine)]:group-hover:opacity-100',
                    'hover:bg-muted/30 hover:text-foreground',
                    isForkingThis && 'pointer-events-none opacity-50',
                  )}
                  onClick={(e) => { e.stopPropagation(); onFork(session.id) }}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter' && e.key !== ' ') return
                    e.preventDefault()
                    e.stopPropagation()
                    onFork(session.id)
                  }}
                >
                  <GitFork className="h-3 w-3" />
                </span>
              )}
              {timeText && (
                <span className="text-caption text-muted-foreground/60">
                  {timeText}
                </span>
              )}
              {isUnread && (
                <span className="h-2 w-2 rounded-full bg-blue-500" />
              )}
            </div>
          </div>

          {shouldRenderMetaRow && (
            <div className="flex min-w-0 flex-wrap items-center gap-1 text-caption text-muted-foreground/60">
              {showAgentMeta && session.agent_name && (
                <>
                  <span
                    className={cn(
                      'truncate',
                      agentNameInteractive &&
                        'cursor-pointer transition-colors hover:text-foreground/80',
                    )}
                    onClick={agentNameInteractive ? handleAgentClick : undefined}
                    role={agentNameInteractive ? 'button' : undefined}
                    tabIndex={agentNameInteractive ? 0 : undefined}
                    onKeyDown={
                      agentNameInteractive
                        ? (e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault()
                              handleAgentClick(e as unknown as React.MouseEvent)
                            }
                          }
                        : undefined
                    }
                  >
                    {session.agent_name}
                  </span>
                  {organizationInfo && (
                    <>
                      <span className="shrink-0 text-muted-foreground/60">·</span>
                      <span
                        className={cn(
                          'shrink-0 text-muted-foreground/60',
                          organizationTagInteractive &&
                            'cursor-pointer transition-colors hover:text-foreground/80',
                        )}
                        role={organizationTagInteractive ? 'button' : undefined}
                        tabIndex={organizationTagInteractive ? 0 : undefined}
                        onClick={organizationTagInteractive ? handleOrganizationTagClick : undefined}
                        onKeyDown={
                          organizationTagInteractive
                            ? (e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                  e.preventDefault()
                                  handleOrganizationTagClick(e as unknown as React.MouseEvent)
                                }
                              }
                            : undefined
                        }
                      >
                        @
                        {organizationInfo.type === 'personal'
                          ? t('conversations.personalIdentity', { defaultValue: '个人身份' })
                          : organizationInfo.name}
                      </span>
                    </>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </button>
      {onFork && (
        <ContextMenu
          open={ctxMenu.open}
          onClose={() => setCtxMenu({ open: false, x: 0, y: 0 })}
          anchorPosition={{ x: ctxMenu.x, y: ctxMenu.y }}
          className="w-52"
        >
          <ContextMenuItem
            icon={<GitFork className="h-4 w-4" />}
            label={tChat('session.forkSession')}
            onClick={() => {
              setCtxMenu({ open: false, x: 0, y: 0 })
              onFork(session.id)
            }}
          />
        </ContextMenu>
      )}
      </>
    )
  },
)

ConversationCard.displayName = 'ConversationCard'
