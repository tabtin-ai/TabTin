/**
 * ChatHeader — 聊天区顶部（会话名/成员数/群名编辑）
 */

import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from '@tabtin/smartsheet-ui'
import { useIMStore } from '@stores/useIMStore'
import { useAuthStore } from '@stores/useAuthStore'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import { useUserProfile, useUserProfileCache } from '@stores/useUserProfileCache'
import { resolveExternalOrganizationName } from './resolveExternalOrganizationName'
import { enterTeamSpaceProject } from '@components/layout/project/teamSpaceProjectNavigation'
import { useSpaceViewPrefsStore } from '@stores/useSpaceViewPrefsStore'
import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'
import { createLogger } from '@/utils/logger'
import { SHELL_MENU_LUCIDE_ICON_CLASS, SHELL_MENU_LUCIDE_ICON_STROKE } from '@components/layout/sidebarUi'
import { resolveConversationCanvasCollapsed } from '@components/layout/taskLayoutState'
import { IM_CHAT_HEADER_EDIT_INPUT, IM_CHAT_HEADER_TITLE } from './tabchatUi'
import { Users, Pencil, Check, X, Info, Cloud, Paperclip, MessageSquare, FolderKanban, ChevronLeft, ChevronRight } from 'lucide-react'
import { cn } from '@utils/cn'
import { useImConversationCanvas } from './ImConversationCanvasContext'
import { ColorAvatar } from './ColorAvatar'
import * as tabchatApi from '@/services/tabchatApi'
import {
  CHAT_CONTENT_FILTER_DOCUMENT,
  CHAT_CONTENT_FILTER_FILE,
  CHAT_CONTENT_FILTER_MESSAGE,
  CONVERSATION_TYPE_GROUP,
  MEMBER_ROLE_ADMIN,
  type ChatContentFilter,
} from '@/constants/tabchat'
import {
  countMemberBreakdown,
} from './conversationMembers'
import { ChipTabBar } from '@components/common/ChipTabBar'
import { PROJECTS_UI_ENABLED } from '@/utils/featureFlags'

const log = createLogger('IMCanvasToggle')

interface Props {
  conversationId: string
  onToggleDetail?: () => void
  isDetailOpen?: boolean
  contentFilter: ChatContentFilter
  onContentFilterChange: (filter: ChatContentFilter) => void
  topBarLeftInset?: number
  topBarRightInset?: number
  /** 会话桌面态下，资源筛选由右侧“会话资产”侧栏承载。 */
  hideContentTabs?: boolean
}

export const ChatHeader: React.FC<Props> = ({
  conversationId,
  onToggleDetail,
  isDetailOpen,
  contentFilter,
  onContentFilterChange,
  topBarLeftInset = 0,
  topBarRightInset = 0,
  hideContentTabs = false,
}) => {
  const { t } = useTranslation('tabchat')
  const conversation = useIMStore((s) =>
    s.conversations.find((c) => c.id === conversationId),
  )
  const currentUserId = useAuthStore((s) => s.user?.id)
  const memberSnapshot = useIMStore((s) => s.conversationMembers[conversationId])
  const [isEditing, setIsEditing] = useState(false)
  const [editName, setEditName] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const savingRef = useRef(false)

  const isGroup = conversation?.type === CONVERSATION_TYPE_GROUP
  const memberBreakdown = useMemo(
    () => (memberSnapshot ? countMemberBreakdown(memberSnapshot) : null),
    [memberSnapshot],
  )
  const canManageGroup = useMemo(() => {
    const myRole = memberSnapshot?.find((member) => member.user_id === currentUserId)?.role ?? 0
    return myRole >= MEMBER_ROLE_ADMIN
  }, [currentUserId, memberSnapshot])
  const isTeamSpaceChannel = Boolean(conversation?.is_team_space_channel && conversation.space_id)
  const canEditGroupName = isGroup && !isTeamSpaceChannel && canManageGroup
  const peerId = conversation?.dm_peer_user_id
  const peerOrganizationId = conversation?.dm_peer_organization_id
  const localPeerOrganizationName = useOrganizationStore((state) => {
    if (!peerOrganizationId) return ''
    return state.organizations.find((organization) => organization.id === peerOrganizationId)?.name || ''
  })
  const externalOrganizationName = resolveExternalOrganizationName({
    isExternal: conversation?.is_external,
    isGroup,
    peerUserId: peerId,
    peerOrganizationId,
    members: memberSnapshot,
    localOrganizationName: localPeerOrganizationName,
  })
  const peerProfile = useUserProfile(isGroup ? null : peerId)
  const ensureProfiles = useUserProfileCache((s) => s.ensureProfiles)
  useEffect(() => {
    if (!isGroup && peerId) ensureProfiles([peerId])
  }, [ensureProfiles, isGroup, peerId])
  // DM 身份只读 profile；未加载时使用通用加载态，不能回退到可能陈旧的会话快照。
  const displayName = isGroup
    ? conversation?.name || ''
    : peerProfile?.nickname || peerProfile?.username || (peerProfile ? peerId?.slice(0, 8) || '' : '')
  const avatarUrl = isGroup ? conversation?.avatar_url || '' : peerProfile?.avatar || ''

  const conversationCanvas = useImConversationCanvas()
  const imScopeKey = conversationCanvas?.scopeKey ?? null
  const imExecutionSpaceId = conversationCanvas?.executionSpaceId ?? null
  const canvasCollapsedPreference = useSpaceViewPrefsStore((s) =>
    imScopeKey ? s.getCanvasCollapsed(imScopeKey, imExecutionSpaceId) : false,
  )
  const taskViewMode = useSpaceViewPrefsStore((s) =>
    imScopeKey ? s.getTaskViewMode(imScopeKey) : null,
  )
  // 三态是实际布局的裁决；历史偏好偶尔脱节时，入口必须按真实可见性显示方向。
  const canvasCollapsed = resolveConversationCanvasCollapsed(canvasCollapsedPreference, taskViewMode)
  const setCanvasCollapsedForScope = useSpaceViewPrefsStore((s) => s.setCanvasCollapsedForScope)
  const canvasHasRealTabs = useSpaceContextTabsStore((s) =>
    imScopeKey ? (s.tabOrderBySpace[imScopeKey]?.length ?? 0) > 0 : false,
  )
  const showCanvasToggle = Boolean(imScopeKey) && canvasHasRealTabs
  const isMac = typeof navigator !== 'undefined'
    && (/Mac|Macintosh/i.test(navigator.platform || '') || /Mac OS X/i.test(navigator.userAgent || ''))
  const canvasToggleTitle = `${canvasCollapsed ? '展开画布' : '收起画布'} (${isMac ? '⌘J' : 'Ctrl+J'})`
  const handleToggleCanvas = useCallback(() => {
    if (!imScopeKey) return
    const nextCollapsed = !canvasCollapsed
    log.info('toggle requested', {
      scopeKey: imScopeKey,
      canvasCollapsedPreference,
      taskViewMode,
      effectiveCanvasCollapsed: canvasCollapsed,
      nextCollapsed,
      tabCount: canvasHasRealTabs ? 1 : 0,
    })
    setCanvasCollapsedForScope(imScopeKey, nextCollapsed)
    const committedState = useSpaceViewPrefsStore.getState()
    log.info('toggle committed', {
      scopeKey: imScopeKey,
      canvasCollapsedPreference: committedState.getCanvasCollapsed(imScopeKey, imExecutionSpaceId),
      taskViewMode: committedState.getTaskViewMode(imScopeKey),
    })
  }, [canvasCollapsed, canvasCollapsedPreference, canvasHasRealTabs, imExecutionSpaceId, imScopeKey, setCanvasCollapsedForScope, taskViewMode])

  useEffect(() => {
    if (!imScopeKey) return
    log.debug('header canvas state', {
      scopeKey: imScopeKey,
      canvasCollapsedPreference,
      taskViewMode,
      effectiveCanvasCollapsed: canvasCollapsed,
      hasRealTabs: canvasHasRealTabs,
    })
  }, [canvasCollapsed, canvasCollapsedPreference, canvasHasRealTabs, imScopeKey, taskViewMode])

  useEffect(() => {
    if (isEditing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [isEditing])

  useEffect(() => {
    if (!canEditGroupName && isEditing) {
      setIsEditing(false)
      setEditName('')
    }
  }, [canEditGroupName, isEditing])

  const handleStartEdit = useCallback(() => {
    if (!canEditGroupName) return
    setEditName(conversation?.name || '')
    setIsEditing(true)
  }, [canEditGroupName, conversation?.name])

  const handleCancelEdit = useCallback(() => {
    setIsEditing(false)
    setEditName('')
  }, [])

  const handleSaveEdit = useCallback(async () => {
    if (savingRef.current) return
    const trimmed = editName.trim()
    if (!trimmed || trimmed === conversation?.name) {
      handleCancelEdit()
      return
    }
    savingRef.current = true
    setIsSaving(true)
    try {
      await tabchatApi.updateConversation(conversationId, { name: trimmed })
      useIMStore.getState().updateConversation(conversationId, { name: trimmed })
      setIsEditing(false)
    } catch (err) {
      console.error('[TabChat] Failed to update group name:', err)
      toast({ title: t('updateNameFailed'), variant: 'destructive' })
    } finally {
      savingRef.current = false
      setIsSaving(false)
    }
  }, [editName, conversation?.name, conversationId, handleCancelEdit, t])

  const handleOpenTeamSpace = useCallback(() => {
    if (!conversation?.space_id) return
    enterTeamSpaceProject(conversation.space_id)
  }, [conversation?.space_id])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        void handleSaveEdit()
      } else if (e.key === 'Escape') {
        handleCancelEdit()
      }
    },
    [handleSaveEdit, handleCancelEdit],
  )

  if (!conversation) return null

  const filterOptions: Array<{
    value: ChatContentFilter
    label: string
    Icon: React.ComponentType<{ className?: string }>
  }> = [
    { value: CHAT_CONTENT_FILTER_DOCUMENT, label: t('contentFilterDocuments'), Icon: Cloud },
    { value: CHAT_CONTENT_FILTER_FILE, label: t('contentFilterFiles'), Icon: Paperclip },
    { value: CHAT_CONTENT_FILTER_MESSAGE, label: t('contentFilterMessages'), Icon: MessageSquare },
  ]

  const subtitle = isTeamSpaceChannel
    ? t('teamSpaceChannelSubtitle', {
        defaultValue: 'Project 频道',
      })
    : isGroup
    ? memberBreakdown
      ? memberBreakdown.agent > 0
        ? t('memberBreakdown', { human: memberBreakdown.human, agent: memberBreakdown.agent })
        : t('memberBreakdownHumanOnly', { human: memberBreakdown.human })
      : ''
    : externalOrganizationName
    ? t('fromExternalOrganization', { organization: externalOrganizationName })
    : t('dm')

  return (
    <div
      className="flex min-h-12 items-center gap-2.5 border-b border-border/20 px-3 py-2 flex-shrink-0"
      style={{
        paddingLeft: topBarLeftInset > 0 ? topBarLeftInset + 12 : undefined,
        paddingRight: topBarRightInset > 0 ? topBarRightInset : undefined,
      }}
    >
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <div className="relative flex-shrink-0">
          <ColorAvatar
            name={displayName || t(isGroup ? 'group' : 'dm')}
            // 群组没有自定义头像时，以群名称生成稳定的彩色首字头像；改名会同步更新。
            seed={isGroup ? conversation.name || conversation.id : conversation.dm_peer_user_id || conversation.id}
            imageUrl={avatarUrl || undefined}
            className="h-9 w-9"
          />
        </div>
        {isEditing ? (
          <div className="flex items-center gap-1.5">
            <input
              ref={inputRef}
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              onKeyDown={handleKeyDown}
              onBlur={() => void handleSaveEdit()}
              maxLength={100}
              disabled={isSaving}
              className={cn('h-7 px-1.5 font-semibold bg-muted/30 border border-accent/60 rounded outline-none min-w-[120px] max-w-[240px]', IM_CHAT_HEADER_EDIT_INPUT)}
            />
            <button
              onClick={() => void handleSaveEdit()}
              className="text-success hover:text-success"
              disabled={isSaving}
            >
              <Check className={SHELL_MENU_LUCIDE_ICON_CLASS} strokeWidth={SHELL_MENU_LUCIDE_ICON_STROKE} />
            </button>
            <button
              onClick={handleCancelEdit}
              className="text-muted-foreground hover:text-foreground"
            >
              <X className={SHELL_MENU_LUCIDE_ICON_CLASS} strokeWidth={SHELL_MENU_LUCIDE_ICON_STROKE} />
            </button>
          </div>
        ) : (
          <div className="min-w-0 flex flex-col justify-center">
            <div className="flex items-center gap-1.5 group min-w-0">
              <h3 className={cn('truncate', IM_CHAT_HEADER_TITLE)}>
                {displayName || t(isGroup ? 'group' : 'dm')}
              </h3>
              {conversation.is_external ? (
                <span className="shrink-0 rounded bg-warning/10 px-1.5 py-0.5 text-caption font-medium text-warning">
                  {t('externalContacts.external')}
                </span>
              ) : null}
              {canEditGroupName && (
                <button
                  onClick={handleStartEdit}
                  className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-foreground transition-opacity flex-shrink-0"
                  title={t('editGroupName')}
                  aria-label={t('editGroupName')}
                >
                  <Pencil className="h-3 w-3" />
                </button>
              )}
            </div>
            <div className="flex min-w-0 items-center gap-1.5">
              {PROJECTS_UI_ENABLED && isTeamSpaceChannel && conversation.space_name ? (
                <button
                  type="button"
                  onClick={handleOpenTeamSpace}
                  className="inline-flex min-w-0 items-center gap-1 rounded-interactive px-1 py-0.5 text-caption font-medium text-muted-foreground/80 hover:bg-foreground/[0.04] hover:text-foreground"
                  title={t('openOwningTeamSpace', { defaultValue: '打开所属 Project' })}
                >
                  <FolderKanban className="h-3 w-3 shrink-0" />
                  <span className="truncate">{conversation.space_name}</span>
                </button>
              ) : null}
              <span className="truncate text-caption text-muted-foreground/80 leading-tight">
                {subtitle}
              </span>
            </div>
          </div>
        )}
      </div>
      {!hideContentTabs && (
        <ChipTabBar
          items={filterOptions}
          value={contentFilter}
          onValueChange={onContentFilterChange}
          ariaLabel={t('contentFilterAria')}
          className="flex-shrink-0"
        />
      )}
      {onToggleDetail && (
        <button
          type="button"
          onClick={onToggleDetail}
          aria-pressed={isDetailOpen}
          className={`no-drag relative h-8 w-8 flex items-center justify-center rounded-md transition-colors before:absolute before:-inset-1.5 before:content-[''] ${
            isDetailOpen
              ? 'bg-accent/10 text-accent'
              : 'text-muted-foreground hover:text-foreground hover:bg-muted/30'
          }`}
          title={isGroup ? t('members') : t('chatInfo')}
          aria-label={isGroup ? t('members') : t('chatInfo')}
        >
          {isGroup ? <Users className={SHELL_MENU_LUCIDE_ICON_CLASS} strokeWidth={SHELL_MENU_LUCIDE_ICON_STROKE} /> : <Info className={SHELL_MENU_LUCIDE_ICON_CLASS} strokeWidth={SHELL_MENU_LUCIDE_ICON_STROKE} />}
        </button>
      )}
      {showCanvasToggle && (
        <button
          type="button"
          onClick={handleToggleCanvas}
          className="no-drag relative h-8 w-8 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/30 transition-colors flex-shrink-0 before:absolute before:-inset-1.5 before:content-['']"
          title={canvasToggleTitle}
          aria-label={canvasToggleTitle}
        >
          {canvasCollapsed ? <ChevronLeft className={SHELL_MENU_LUCIDE_ICON_CLASS} strokeWidth={SHELL_MENU_LUCIDE_ICON_STROKE} /> : <ChevronRight className={SHELL_MENU_LUCIDE_ICON_CLASS} strokeWidth={SHELL_MENU_LUCIDE_ICON_STROKE} />}
        </button>
      )}
    </div>
  )
}
