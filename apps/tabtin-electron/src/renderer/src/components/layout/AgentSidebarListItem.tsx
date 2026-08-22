/**
 * AgentSidebarListItem — AI 分身侧栏列表行，视觉与 ConversationItem（embedded）同源。
 */

import React from 'react'
import { cn } from '@utils/cn'
import type { OrganizationAgentSummary } from '@/services/organizationAgentsApi'
import { AgentListIdentityAvatar } from '@components/settings/panels/MyAgentsPanel'
import {
  SIDEBAR_BADGE,
  SIDEBAR_ROW,
  SIDEBAR_ROW_ACTIVE,
  SIDEBAR_ROW_FULL_WIDTH,
  SIDEBAR_ROW_INACTIVE,
  SIDEBAR_ROW_LABEL_GROW,
  SIDEBAR_TEXT_META,
} from './sidebarUi'

interface AgentSidebarListItemProps {
  agent: OrganizationAgentSummary
  isActive: boolean
  sourceLabel: string
  relativeTime?: string
  hasDraft?: boolean
  unsavedLabel?: string
  onSelect: () => void
  onKeyDown?: React.KeyboardEventHandler<HTMLButtonElement>
}

export const AgentSidebarListItem: React.FC<AgentSidebarListItemProps> = ({
  agent,
  isActive,
  sourceLabel,
  relativeTime,
  hasDraft = false,
  unsavedLabel,
  onSelect,
  onKeyDown,
}) => (
  <button
    type="button"
    data-agent-option
    onClick={onSelect}
    onKeyDown={onKeyDown}
    aria-pressed={isActive}
    className={cn(
      SIDEBAR_ROW,
      SIDEBAR_ROW_FULL_WIDTH,
      isActive ? SIDEBAR_ROW_ACTIVE : SIDEBAR_ROW_INACTIVE,
    )}
  >
    <div className="relative flex-shrink-0 self-start">
      <AgentListIdentityAvatar agent={agent} size="md" />
    </div>

    <div className="flex min-w-0 flex-1 flex-col justify-center gap-0.5 py-0.5">
      <div className="flex items-center justify-between gap-2">
        <span className={cn(
          'flex min-w-0 items-center gap-1 text-foreground',
          SIDEBAR_ROW_LABEL_GROW,
          isActive ? 'font-medium' : 'font-normal',
        )}>
          <span className="truncate">{agent.name}</span>
          {hasDraft && unsavedLabel ? (
            <span className={cn(SIDEBAR_BADGE, 'max-w-none rounded bg-warning/10 px-1 py-0.5 text-warning')}>
              {unsavedLabel}
            </span>
          ) : null}
        </span>
        {relativeTime ? (
          <span className={cn('ml-2 shrink-0', SIDEBAR_TEXT_META, 'text-muted-foreground/60')}>
            {relativeTime}
          </span>
        ) : null}
      </div>
      <span className="truncate text-caption text-muted-foreground/80">
        {sourceLabel}
      </span>
    </div>
  </button>
)

AgentSidebarListItem.displayName = 'AgentSidebarListItem'
