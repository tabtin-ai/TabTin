/**
 * ConversationItem — 单个会话条目（含右键菜单、置顶/免打扰指示）
 */

import React, { useState, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type { Conversation } from '@/services/tabchatApi'
import { SYSTEM_LABEL_MENTION_ID, togglePin, toggleMute } from '@/services/tabchatApi'
import { useIMStore } from '@stores/useIMStore'
import { useUserProfile, useUserProfileCache } from '@stores/useUserProfileCache'
import { useSpaceListStore } from '@stores/useSpaceListStore'
import { useScopedEventListener } from '@hooks/spaceActivity'
import { Pin, BellOff, CheckCheck, Hash } from 'lucide-react'
import { toast } from '@tabtin/smartsheet-ui'
import { ColorAvatar } from './ColorAvatar'
import { positionConversationMenu } from './conversationMenuPosition'
import { CONVERSATION_TYPE_DM, CONVERSATION_TYPE_GROUP } from '@/constants/tabchat'
import { formatConversationTime } from '@/lib/dateUtils'
import { formatMentionDisplayText } from './mentionMarkdown'
import { getConversationNavigationKind } from '@tabtin/app-shell'
import { OVERLAY_SURFACE_CLASS } from '@components/ui'
import { cn } from '@utils/cn'
import {
  SIDEBAR_ROW,
  SIDEBAR_ROW_ACTIVE,
  SIDEBAR_ROW_FULL_WIDTH,
  SIDEBAR_ROW_INACTIVE,
  SIDEBAR_ROW_LABEL_GROW,
  SIDEBAR_TEXT_META,
} from '@components/layout/sidebarUi'

interface Props {
  conversation: Conversation
  isActive: boolean
  /** 嵌在 Project 分组下时，隐藏 Space 标签并简化预览 */
  nested?: boolean
  /** 嵌入全局侧栏时，与其它 SidebarMenuItem 共用统一左缘和选中态。 */
  embedded?: boolean
}

export const ConversationItem = React.memo<Props>(({ conversation, isActive, nested = false, embedded = false }) => {
  const selectSpaceById = useSpaceListStore((s) => s.selectSpaceById)
  const onClick = useCallback(() => {
    selectSpaceById(getConversationNavigationKind(conversation), conversation.id)
  }, [conversation, selectSpaceById])
  const { t } = useTranslation('tabchat')
  const unread = useIMStore((s) => s.unreadCounts[conversation.id] || 0)
  const hasUnread = unread > 0
  const isDM = conversation.type === CONVERSATION_TYPE_DM
  const isTeamSpaceChannel = Boolean(conversation.is_team_space_channel && conversation.space_id)
  const peerId = isDM ? conversation.dm_peer_user_id : null
  const peerProfile = useUserProfile(peerId)
  const ensureProfiles = useUserProfileCache((s) => s.ensureProfiles)
  React.useEffect(() => {
    if (peerId) ensureProfiles([peerId])
  }, [ensureProfiles, peerId])
  // DM 身份只读 User profile；未加载时使用通用加载态，不能回退到陈旧列表快照。
  const displayName = isDM
    ? peerProfile?.nickname || peerProfile?.username || (peerProfile ? peerId?.slice(0, 8) || '' : '')
    : conversation.name
  const avatarUrl = isDM ? peerProfile?.avatar || '' : conversation.avatar_url
  const hasUnreadMention = Boolean(
    conversation.labels?.some((label) => label.id === SYSTEM_LABEL_MENTION_ID),
  )

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setContextMenu(positionConversationMenu({ x: e.clientX, y: e.clientY }))
  }, [])

  const handleClickOutside = useCallback((e: MouseEvent) => {
    if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
      setContextMenu(null)
    }
  }, [])
  const docTarget = typeof document === 'undefined' ? null : document
  useScopedEventListener<MouseEvent>(docTarget, 'mousedown', handleClickOutside, {
    enabled: Boolean(contextMenu),
  })

  const handleTogglePin = async () => {
    setContextMenu(null)
    try {
      const result = await togglePin(conversation.id, !conversation.pinned)
      useIMStore.getState().updateConversation(conversation.id, result)
    } catch (err) {
      console.error('[TabChat] Toggle pin failed:', err)
      toast({ title: t('pinFailed'), variant: 'destructive' })
    }
  }

  const handleToggleMute = async () => {
    setContextMenu(null)
    const prevMuted = conversation.is_muted
    useIMStore.getState().updateConversation(conversation.id, { is_muted: !prevMuted })
    try {
      const result = await toggleMute(conversation.id, !prevMuted)
      if (result.muted !== !prevMuted) {
        useIMStore.getState().updateConversation(conversation.id, { is_muted: result.muted })
      }
    } catch (err) {
      console.error('[TabChat] Toggle mute failed:', err)
      useIMStore.getState().updateConversation(conversation.id, { is_muted: prevMuted })
      toast({
        title: t(conversation.last_message_at ? 'muteFailed' : 'muteBeforeFirstMessage'),
        variant: 'destructive',
      })
    }
  }

  const handleMarkAsRead = async () => {
    setContextMenu(null)
    await useIMStore.getState().markAsRead(conversation.id)
  }

  const formatTime = (dateStr: string | null) => formatConversationTime(dateStr, t)
  // 仅新建群聊在没有首条消息时回退到创建时间；私信仍保持无消息时间为空。
  const activityAt = conversation.last_message_at
    || (conversation.type === CONVERSATION_TYPE_GROUP ? conversation.created_at : null)
  const previewText = conversation.last_message_preview
    ? formatMentionDisplayText(conversation.last_message_preview)
    : ''

  const labels = conversation.labels || []
  const visibleLabels = labels.slice(0, 2)
  const hiddenLabelCount = labels.length - visibleLabels.length

  return (
    <>
      <button
        type="button"
        onClick={onClick}
        onContextMenu={handleContextMenu}
        className={cn(
          embedded
            ? cn(
              SIDEBAR_ROW,
              SIDEBAR_ROW_FULL_WIDTH,
              isActive
                ? SIDEBAR_ROW_ACTIVE
                : conversation.pinned
                  ? 'bg-foreground/[0.025] text-foreground/80 hover:bg-foreground/[0.03] dark:bg-black/10 dark:hover:bg-foreground/[0.05]'
                  : SIDEBAR_ROW_INACTIVE,
            )
            : cn(
              'flex w-full items-center gap-2.5 rounded-interactive text-left transition-colors',
              nested ? 'px-2 py-1' : 'px-2 py-1.5',
              isActive
                ? 'surface-row-active'
                : conversation.pinned
                  ? 'bg-foreground/[0.025] hover:bg-foreground/[0.03] dark:bg-black/10 dark:hover:bg-foreground/[0.05]'
                  : 'hover:bg-foreground/[0.03] dark:hover:bg-foreground/[0.05]',
            ),
        )}
      >
        <div className="relative flex-shrink-0 self-start">
          <ColorAvatar
            name={displayName || t(isDM ? 'dm' : 'group')}
            // 群组没有自定义头像时，以群名称生成稳定的彩色首字头像；改名会同步更新。
            seed={isDM ? conversation.dm_peer_user_id || conversation.id : conversation.name || conversation.id}
            imageUrl={avatarUrl || undefined}
            fallbackIcon={isTeamSpaceChannel ? <Hash className="h-[45%] w-[45%] text-white" /> : undefined}
            className={nested ? 'h-8 w-8' : 'h-10 w-10'}
          />
        </div>

        <div className="flex min-w-0 flex-1 flex-col justify-center gap-0.5 py-0.5">
          <div className="flex items-center justify-between">
            <span className={cn(
              'flex truncate items-center gap-1 text-foreground',
              embedded ? SIDEBAR_ROW_LABEL_GROW : 'text-body',
              hasUnread || isActive ? 'font-medium' : 'font-normal',
            )}>
              {displayName || t(isDM ? 'dm' : 'group')}
              {isTeamSpaceChannel && !nested && (
                <span className="shrink-0 rounded bg-foreground/[0.06] px-1.5 py-0.5 text-caption font-medium text-muted-foreground/80">
                  {t('projectBadge', { defaultValue: 'Project' })}
                </span>
              )}
              {conversation.pinned && (
                <Pin className="h-3 w-3 flex-shrink-0 text-muted-foreground/60" />
              )}
            </span>
            <span className={cn('ml-2 flex-shrink-0', SIDEBAR_TEXT_META, 'text-muted-foreground/60')}>
              {formatTime(activityAt)}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className={`truncate text-caption ${hasUnread ? 'text-foreground/80' : 'text-muted-foreground/80'}`}>
              {isTeamSpaceChannel && !nested && conversation.space_name
                ? `${conversation.space_name} · ${previewText || t('previewNoMessages', { defaultValue: '还没有消息' })}`
                : previewText || '\u00A0'}
            </span>
            <div className="flex items-center gap-1 flex-shrink-0 ml-2">
              {conversation.is_muted && (
                <BellOff className="h-3 w-3 text-muted-foreground/60" />
              )}
              {unread > 0 && !isActive && (
                <span
                  className={`min-w-[18px] h-[18px] rounded-full text-caption font-medium flex items-center justify-center px-1 ${
                    conversation.is_muted
                      ? 'bg-muted-foreground/30 text-muted-foreground'
                      : hasUnreadMention
                        ? 'bg-warning text-warning-foreground'
                      : 'bg-accent text-accent-foreground'
                  }`}
                >
                  {unread > 99 ? '99+' : unread}
                </span>
              )}
            </div>
          </div>
          {/* TC-37：label pill（最多显 2 个，多了显 +N） */}
          {!embedded && visibleLabels.length > 0 && (
            <div className="flex items-center gap-1 mt-1 flex-wrap">
              {visibleLabels.map((label) => (
                <span
                  key={label.id}
                  className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] leading-none text-white flex-shrink-0"
                  style={{ backgroundColor: label.color }}
                >
                  <span className="truncate max-w-[60px]">{label.name}</span>
                </span>
              ))}
              {hiddenLabelCount > 0 && (
                <span className="text-[10px] text-muted-foreground flex-shrink-0">
                  {t('labelMoreCount', { count: hiddenLabelCount })}
                </span>
              )}
            </div>
          )}
        </div>
      </button>

      {/*
        会话列表位于可滚动侧栏的 stacking context 中；菜单若留在这里，即使是 fixed
        也会被相邻消息面板盖住。Portal 到 body 后以窗口坐标定位，才能像系统菜单一样
        跨越左右栏显示。
      */}
      {typeof document !== 'undefined' && contextMenu && createPortal(
        <div
          ref={menuRef}
          className={`fixed z-dropdown min-w-[160px] rounded-lg py-1 ${OVERLAY_SURFACE_CLASS}`}
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            type="button"
            onClick={handleTogglePin}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-body text-foreground hover:bg-muted/60 transition-colors"
          >
            <Pin className="h-4 w-4" />
            {conversation.pinned ? t('unpin') : t('pin')}
          </button>
          <button
            type="button"
            onClick={handleToggleMute}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-body text-foreground hover:bg-muted/60 transition-colors"
          >
            <BellOff className="h-4 w-4" />
            {conversation.is_muted ? t('unmute') : t('mute')}
          </button>
          <button
            type="button"
            onClick={handleMarkAsRead}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-body text-foreground hover:bg-muted/60 transition-colors"
          >
            <CheckCheck className="h-4 w-4" />
            {t('markRead')}
          </button>
        </div>,
        document.body,
      )}
    </>
  )
})
