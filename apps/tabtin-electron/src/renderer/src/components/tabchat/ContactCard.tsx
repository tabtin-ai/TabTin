/**
 * ContactCard — 个人名片卡片
 *
 * 在 IM 消息里渲染某个 organization 成员的名片（头像 + 昵称 + 用户名），
 * 点「发消息」一键发起 / 打开与该成员的 DM。身份字段由后端以 DB 真实值回填。
 */

import React, { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { MessageSquare } from 'lucide-react'
import { toast } from '@tabtin/smartsheet-ui'
import { useAuthStore } from '@stores/useAuthStore'
import { useIMStore } from '@stores/useIMStore'
import { useUserProfileCache, useDisplayName, useAvatar } from '@stores/useUserProfileCache'
import { ColorAvatar } from './ColorAvatar'
import {
  planGroupMemberDirectChat,
  resolveGroupMemberDirectChat,
} from './resolveGroupMemberDirectChat'

interface Props {
  /** 名片指向的成员 user_id（后端回填） */
  userId: string
  /** 后端回填的真实昵称 */
  name: string
  /** 后端回填的用户名 */
  username?: string
  /** 后端回填的头像（object key 或 URL） */
  avatar?: string
  /** 名片所在会话，用于解析 organization 发起 DM */
  conversationId: string
}

export const ContactCard: React.FC<Props> = ({ userId, name, username, avatar, conversationId }) => {
  const { t } = useTranslation('tabchat')
  const currentUserId = useAuthStore((s) => s.user?.id)
  const ensureProfiles = useUserProfileCache((s) => s.ensureProfiles)
  const conversation = useIMStore(
    (s) => s.conversations.find((item) => item.id === conversationId),
  )
  const organizationId = conversation?.organization_id
  const contactMember = useIMStore(
    (s) => s.conversationMembers[conversationId]?.find((member) => member.user_id === userId),
  )
  const [opening, setOpening] = useState(false)

  // 优先用 profile cache 的实时头像/昵称（object key→URL 已解析），回退到名片回填值
  useEffect(() => {
    if (userId) ensureProfiles([userId])
  }, [userId, ensureProfiles])
  const cachedName = useDisplayName(userId)
  const cachedAvatar = useAvatar(userId)
  const displayName = cachedName || name || username || t('contactCardFallback', { defaultValue: '用户' })
  const displayAvatar = cachedAvatar || avatar || ''

  const isSelf = !!currentUserId && currentUserId === userId

  const handleStartDM = useCallback(async () => {
    if (opening || !organizationId || isSelf) return
    setOpening(true)
    try {
      const plan = planGroupMemberDirectChat(
        organizationId,
        userId,
        await resolveGroupMemberDirectChat({
          organizationId,
          userId,
          participantOrganizationId: contactMember?.participant_organization_id,
          memberIsExternal: Boolean(contactMember?.is_external),
          conversationIsExternal: Boolean(conversation?.is_external),
        }),
      )
      if (plan.type === 'reject') {
        toast({ title: t(plan.messageKey), variant: 'destructive' })
        return
      }
      await useIMStore.getState().createConversationAndActivate(plan.input)
    } catch (err) {
      console.error('[TabChat] start DM from contact card failed:', err)
      toast({
        title: t('contactCardDMFailed', { defaultValue: '无法打开私信' }),
        variant: 'destructive',
      })
    } finally {
      setOpening(false)
    }
  }, [
    contactMember?.is_external,
    contactMember?.participant_organization_id,
    conversation?.is_external,
    isSelf,
    opening,
    organizationId,
    t,
    userId,
  ])

  return (
    <div className="w-[240px] max-w-full overflow-hidden rounded-xl bg-card border border-border/60 shadow-sm">
      <div className="flex items-center gap-3 px-3.5 pt-3.5 pb-3">
        <ColorAvatar
          name={displayName}
          seed={userId}
          imageUrl={displayAvatar}
          className="h-12 w-12"
          fallbackClassName="text-title"
        />
        <div className="flex-1 min-w-0">
          <div className="text-body font-semibold text-foreground truncate">{displayName}</div>
          <div className="text-caption text-muted-foreground truncate">
            {username ? `@${username}` : t('contactCard', { defaultValue: '个人名片' })}
          </div>
        </div>
      </div>
      {!isSelf && (
        <button
          type="button"
          onClick={handleStartDM}
          disabled={opening || !organizationId}
          className="w-full flex items-center justify-center gap-1.5 border-t border-border/30 py-2.5 text-accent hover:bg-accent/10 disabled:opacity-50 transition-colors text-body font-medium"
          title={t('contactCardSendMessage', { defaultValue: '发消息' })}
        >
          <MessageSquare className="h-4 w-4" />
          <span>{t('contactCardSendMessage', { defaultValue: '发消息' })}</span>
        </button>
      )}
    </div>
  )
}
