/**
 * ContactsList — 通讯录（团队成员列表）
 *
 * 列出当前 organization 的成员，支持搜索、一键发起 / 打开与 TA 的 DM。
 * 数据复用 useOrganizationStore.members（进入消息域 / 打开通讯录时保鲜重拉，），
 * 头像/昵称走 useUserProfileCache 解析（object key → URL）。
 * 发起 DM 复用 useIMStore.createConversationAndActivate（与 ContactCard 同一路径）。
 */

import React, { useEffect, useMemo, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { ListFilter, Loader2 } from 'lucide-react'
import { toast } from '@components/ui'
import { useAuthStore } from '@stores/useAuthStore'
import { useIMStore } from '@stores/useIMStore'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import { useUserProfileCache, useDisplayName, useAvatar } from '@stores/useUserProfileCache'
import { ColorAvatar } from './ColorAvatar'
import { NavigationListSkeleton } from '@components/common/ListSkeletons'
import { ContextPageToolbar } from '@components/context-space/ContextPageToolbar'
import { CANVAS_TEXT_META } from '@components/layout/canvasUi'
import {
  SIDEBAR_EMPTY_TEXT,
  SIDEBAR_EMBEDDED_CONTROL_INSET,
  SIDEBAR_META,
  SIDEBAR_ROW,
  SIDEBAR_ROW_FULL_WIDTH,
  SIDEBAR_ROW_INACTIVE,
  SIDEBAR_ROW_LABEL_GROW,
} from '@components/layout/sidebarUi'
import { IM_SEARCH_INPUT_TEXT } from './tabchatUi'
import { cn } from '@utils/cn'

interface ContactMember {
  user_id: string
  user?: { nickname?: string; username?: string; email?: string; avatar?: string }
}

interface ContactsListProps {
  embedded?: boolean
  /** 模块页主画布（StandaloneModulePage 内）：工具行 + 列表滚动与边距对齐自动化等模块。 */
  layout?: 'default' | 'module'
  /** 成功打开成员私信后，供局部通讯录切回会话列表。 */
  onConversationOpened?: () => void
}

export const ContactsList: React.FC<ContactsListProps> = ({
  embedded = false,
  layout = 'default',
  onConversationOpened,
}) => {
  const { t } = useTranslation('tabchat')
  const currentUserId = useAuthStore((s) => s.user?.id)
  const organizationId = useOrganizationStore((s) => s.selectedOrganization?.id ?? '')
  const members = useOrganizationStore((s) => s.members)
  const loadMembers = useOrganizationStore((s) => s.loadMembers)
  const isLoading = useOrganizationStore((s) => s.isLoadingMembers)
  const [query, setQuery] = useState('')

  useEffect(() => {
    // ：打开通讯录时始终重拉；仅在 empty 时拉取会让「后加入」的成员长期不可见
    if (organizationId) void loadMembers(organizationId)
  }, [organizationId, loadMembers])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    const filtered = (members as ContactMember[]).filter((m) => {
      if (!q) return true
      const u = m.user || {}
      return (
        (u.nickname || '').toLowerCase().includes(q) ||
        (u.username || '').toLowerCase().includes(q) ||
        (u.email || '').toLowerCase().includes(q)
      )
    })
    return [...filtered].sort((a, b) => {
      const an = (a.user?.nickname || a.user?.username || '').toLowerCase()
      const bn = (b.user?.nickname || b.user?.username || '').toLowerCase()
      return an.localeCompare(bn)
    })
  }, [members, query])

  const filterLabel = t('contactsFilter', { defaultValue: '过滤成员' })
  const isModuleLayout = layout === 'module'

  const listBody = (
    <>
      {isLoading && members.length === 0 ? (
        <NavigationListSkeleton count={6} />
      ) : visible.length === 0 ? (
        <div className="flex items-center justify-center py-8">
          <p className={cn(
            'text-center leading-5',
            embedded || isModuleLayout
              ? cn(SIDEBAR_EMPTY_TEXT, 'text-muted-foreground/80')
              : 'text-body text-muted-foreground',
          )}>
            {t('contactsEmpty', { defaultValue: '暂无成员' })}
          </p>
        </div>
      ) : (
        <>
          {visible.map((m) => (
            <ContactRow
              key={m.user_id}
              member={m}
              isSelf={m.user_id === currentUserId}
              organizationId={organizationId}
              embedded={embedded}
              layout={layout}
              onConversationOpened={onConversationOpened}
            />
          ))}
        </>
      )}
    </>
  )

  if (isModuleLayout) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <ContextPageToolbar
          withHeaderGap={false}
          searchPlaceholder={filterLabel}
          searchValue={query}
          onSearchChange={setQuery}
          searchAriaLabel={filterLabel}
        />
        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-hover [scrollbar-gutter:stable]">
          <div className="space-y-0.5">
            {listBody}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className={cn('flex-shrink-0', embedded ? cn(SIDEBAR_EMBEDDED_CONTROL_INSET, 'pb-2') : 'px-3 pt-3 pb-2')}>
        <div className={cn(
          'flex items-center gap-2 rounded-[12px] bg-foreground/[0.025] transition-colors duration-200 focus-within:bg-foreground/[0.04] dark:bg-black/10 dark:focus-within:bg-foreground/[0.06]',
          embedded ? 'h-8 px-2.5' : 'h-9 px-3',
        )}>
          <ListFilter className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground/60" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={filterLabel}
            aria-label={filterLabel}
            className={cn('min-w-0 flex-1 border-0 bg-transparent placeholder:text-muted-foreground/60 focus:outline-none', IM_SEARCH_INPUT_TEXT)}
          />
        </div>
      </div>

      <div className={cn('flex-1 min-h-0 overflow-y-auto scrollbar-hover space-y-0.5', embedded ? cn(SIDEBAR_EMBEDDED_CONTROL_INSET, 'pb-1') : 'px-2 py-1')}>
        {listBody}
      </div>
    </div>
  )
}

const ContactRow: React.FC<{
  member: ContactMember
  isSelf: boolean
  organizationId: string
  embedded?: boolean
  layout?: 'default' | 'module'
  onConversationOpened?: () => void
}> = ({
  member,
  isSelf,
  organizationId,
  embedded = false,
  layout = 'default',
  onConversationOpened,
}) => {
  const { t } = useTranslation('tabchat')
  const ensureProfiles = useUserProfileCache((s) => s.ensureProfiles)
  const [opening, setOpening] = useState(false)

  useEffect(() => {
    if (member.user_id) ensureProfiles([member.user_id])
  }, [member.user_id, ensureProfiles])

  const cachedName = useDisplayName(member.user_id)
  const cachedAvatar = useAvatar(member.user_id)
  const name = cachedName || member.user?.nickname || member.user?.username || member.user_id.slice(0, 8)
  const username = member.user?.username
  const avatar = cachedAvatar || member.user?.avatar || ''

  const handleStartDM = useCallback(async () => {
    if (opening || !organizationId || isSelf) return
    setOpening(true)
    try {
      await useIMStore.getState().createConversationAndActivate({
        organizationId,
        kind: 'dm',
        memberIds: [member.user_id],
      })
      // 从通讯录打开会话后回到收件箱路由，让 Shell 进入该会话桌面而非停留通讯录。
      useIMStore.getState().setImSidebarView('inbox')
      onConversationOpened?.()
    } catch (err) {
      console.error('[TabChat] start DM from contacts failed:', err)
      toast({ title: t('contactCardDMFailed', { defaultValue: '无法打开私信' }), variant: 'destructive' })
    } finally {
      setOpening(false)
    }
  }, [opening, organizationId, isSelf, member.user_id, onConversationOpened, t])

  const openLabel = t('contactCardOpenConversation', {
    name,
    defaultValue: '打开与 {{name}} 的私信',
  })

  const isModuleLayout = layout === 'module'

  return (
    <button
      type="button"
      onClick={() => void handleStartDM()}
      disabled={isSelf || opening || !organizationId}
      title={isSelf ? undefined : openLabel}
      aria-label={isSelf ? undefined : openLabel}
      className={cn(
        embedded
          ? cn(SIDEBAR_ROW, SIDEBAR_ROW_FULL_WIDTH, isSelf ? 'cursor-default' : SIDEBAR_ROW_INACTIVE)
          : isModuleLayout
            ? cn(
              'group flex w-full items-center gap-3 rounded-interactive px-1 py-2 text-left transition-colors',
              isSelf
                ? 'cursor-default'
                : 'cursor-pointer hover:bg-foreground/[0.03] focus-visible:bg-foreground/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 dark:hover:bg-foreground/[0.05]',
            )
            : cn(
              'group flex w-full items-center gap-2.5 rounded-interactive px-2 py-1.5 text-left transition-colors',
              isSelf
                ? 'cursor-default'
                : 'cursor-pointer hover:bg-foreground/[0.03] focus-visible:bg-foreground/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 dark:hover:bg-foreground/[0.05]',
            ),
      )}
    >
      <div className="relative flex-shrink-0 self-start">
        <ColorAvatar
          name={name}
          seed={member.user_id}
          imageUrl={avatar}
          className={isModuleLayout ? 'h-9 w-9' : 'h-10 w-10'}
        />
      </div>
      <div className="flex min-w-0 flex-1 flex-col justify-center gap-0.5 py-0.5">
        <div className={cn(
          'truncate font-medium text-foreground',
          embedded ? SIDEBAR_ROW_LABEL_GROW : 'text-body',
        )}>
          {name}
          {isSelf && <span className={cn('ml-1', embedded ? SIDEBAR_META : CANVAS_TEXT_META)}>({t('you')})</span>}
        </div>
        <div className={cn(
          'truncate',
          embedded ? SIDEBAR_META : isModuleLayout ? CANVAS_TEXT_META : 'text-caption text-muted-foreground/80',
        )}>
          {username ? `@${username}` : '\u00A0'}
        </div>
      </div>
      {opening ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" /> : null}
    </button>
  )
}
