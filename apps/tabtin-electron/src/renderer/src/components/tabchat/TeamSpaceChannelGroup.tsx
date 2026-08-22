/**
 * TeamSpaceChannelGroup — 私信侧栏里按 Project 分组的频道列表
 */

import React, { useCallback, useMemo, useState } from 'react'
import { ChevronDown, FolderKanban } from 'lucide-react'
import type { Conversation } from '@/services/tabchatApi'
import type { TeamSpaceConversationGroup } from '@/lib/groupConversationsForInbox'
import { useIMStore } from '@stores/useIMStore'
import { enterTeamSpaceProject } from '@components/layout/project/teamSpaceProjectNavigation'
import { useSettingsSpaceStore } from '@stores/useSettingsSpaceStore'
import { ConversationItem } from './ConversationItem'
import {
  SIDEBAR_ICON_SM,
  SIDEBAR_ROW_LIST,
  SIDEBAR_SECTION_HEADER,
  SIDEBAR_SECTION_LABEL,
} from '@components/layout/sidebarUi'
import { cn } from '@utils/cn'

interface Props {
  group: TeamSpaceConversationGroup
  currentConversationId: string | null
}

export const TeamSpaceChannelGroup: React.FC<Props> = ({ group, currentConversationId }) => {
  const unreadCounts = useIMStore((state) => state.unreadCounts)
  const closeSettings = useSettingsSpaceStore((state) => state.closeSettings)

  const hasActiveChannel = group.channels.some((channel) => channel.id === currentConversationId)
  const groupUnread = useMemo(
    () => group.channels.reduce((total, channel) => {
      if (channel.id === currentConversationId) return total
      return total + (unreadCounts[channel.id] ?? 0)
    }, 0),
    [currentConversationId, group.channels, unreadCounts],
  )

  const [collapsed, setCollapsed] = useState(() => !hasActiveChannel && groupUnread === 0)

  const openTeamSpace = useCallback(() => {
    closeSettings()
    enterTeamSpaceProject(group.spaceId)
  }, [closeSettings, group.spaceId])

  return (
    <section className="min-w-0">
      <div className={cn(SIDEBAR_SECTION_HEADER, 'flex items-center gap-1 pr-2')}>
        <button
          type="button"
          onClick={() => setCollapsed((value) => !value)}
          className="flex min-w-0 flex-1 items-center gap-1 text-left transition-colors hover:text-foreground"
          aria-expanded={!collapsed}
        >
          <ChevronDown
            className={cn(
              SIDEBAR_ICON_SM,
              'shrink-0 text-muted-foreground/60 transition-transform',
              collapsed && '-rotate-90',
            )}
          />
          <FolderKanban className={cn(SIDEBAR_ICON_SM, 'shrink-0 text-muted-foreground/70')} />
          <span className={cn(SIDEBAR_SECTION_LABEL, 'min-w-0 flex-1')}>
            {group.spaceName}
          </span>
        </button>
        {groupUnread > 0 ? (
          <span className="min-w-[16px] h-4 rounded-full bg-destructive px-1 text-caption font-medium text-white flex items-center justify-center">
            {groupUnread > 99 ? '99+' : groupUnread}
          </span>
        ) : null}
        <button
          type="button"
          onClick={openTeamSpace}
          className="shrink-0 rounded-interactive px-1.5 py-0.5 text-caption text-muted-foreground/80 transition-colors hover:bg-foreground/[0.03] hover:text-foreground"
          title="打开Project"
        >
          进入
        </button>
      </div>
      {!collapsed ? (
        <div className={cn(SIDEBAR_ROW_LIST, 'pl-2 pr-1')}>
          {group.channels.map((channel: Conversation) => (
            <ConversationItem
              key={channel.id}
              conversation={channel}
              isActive={channel.id === currentConversationId}
              nested
            />
          ))}
        </div>
      ) : null}
    </section>
  )
}

TeamSpaceChannelGroup.displayName = 'TeamSpaceChannelGroup'
