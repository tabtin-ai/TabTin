/**
 * SessionCollaborators —— 任务顶栏「共享协作区」（，类文档协同）。
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { MessageSquare, UserPlus, Users } from 'lucide-react'
import { Popover, PopoverTrigger, PopoverContent, toast } from '@components/ui'
import { cn } from '@utils/cn'
import {
  createSessionShare,
  listSessionSharesBySession,
  revokeSessionShare,
  type SessionShareInfo,
} from '@/services/tabchatApi'
import { useIMStore } from '@stores/useIMStore'
import { ColorAvatar } from '@components/tabchat/ColorAvatar'
import { SessionShareGranteeList } from '@components/tabchat/SessionShareGranteeList'
import { forgetPendingShareIntentForShare } from '@components/tabchat/sessionSharePendingIntent'
import { resolveShareTierLevel } from '@components/tabchat/sessionSharePresentation'
import {
  collapseActiveSharesByGrantee,
  shouldShowSessionShareManager,
} from '@components/tabchat/sessionShareCollaborators'
import { ShareSessionDialog } from '@components/chat/composer/ShareSessionDialog'
import { CANVAS_TEXT_META } from '@components/layout/canvasUi'
import { createLogger } from '@/utils/logger'
import { useAvatar, useUserProfile, useUserProfileCache } from '@stores/useUserProfileCache'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import {
  planGroupMemberDirectChat,
  resolveGroupMemberDirectChat,
} from '@components/tabchat/resolveGroupMemberDirectChat'
import { collectSiblingShareIds } from '@/services/sessionCollaborationEventHandler'

const log = createLogger('SessionCollaborators')

const MAX_STACK_AVATARS = 4

function reloadSiblingShareCards(
  imState: ReturnType<typeof useIMStore.getState>,
  share: Pick<SessionShareInfo, 'id' | 'session_id'>,
) {
  collectSiblingShareIds(imState.sessionShares, {
    objectId: share.id,
    sessionId: share.session_id,
  }).forEach((shareId) => {
    void imState.loadSessionShareV2(shareId)
  })
}

interface Props {
  sessionId: string | null | undefined
  /** 传给 ShareSessionDialog 解析任务标题 */
  spaceId?: string | null
  className?: string
  sourceUserId?: string | null
  sourceDisplayName?: string
  sourceOrganizationId?: string | null
}

export const SessionCollaborators: React.FC<Props> = ({
  sessionId,
  spaceId,
  className,
  sourceUserId = null,
  sourceDisplayName,
  sourceOrganizationId = null,
}) => {
  const { t } = useTranslation('chat')
  const [shares, setShares] = useState<SessionShareInfo[]>([])
  const [visible, setVisible] = useState(false)
  const [shareDialogOpen, setShareDialogOpen] = useState(false)
  const [manageOpen, setManageOpen] = useState(false)
  const [revokingId, setRevokingId] = useState<string | null>(null)
  const [resumingId, setResumingId] = useState<string | null>(null)
  const [openingSourceChat, setOpeningSourceChat] = useState(false)
  const currentOrganizationId = useOrganizationStore(
    (state) => state.selectedOrganization?.id ?? null,
  )
  const sourceProfile = useUserProfile(sourceUserId)
  const sourceAvatar = useAvatar(sourceUserId)
  const sourceName = [
    sourceProfile?.nickname,
    sourceProfile?.username,
    sourceDisplayName,
    sourceUserId,
  ].find(Boolean) ?? ''

  useEffect(() => {
    if (!sourceUserId) return
    useUserProfileCache.getState().ensureProfiles([sourceUserId])
  }, [sourceUserId])

  const load = useCallback(async () => {
    if (!sessionId || sourceUserId) {
      setVisible(false)
      setShares([])
      return
    }
    try {
      const result = await listSessionSharesBySession(sessionId)
      setShares(result)
      setVisible(true)
    } catch (err) {
      log.info('session shares unavailable, hide collaborators area', { sessionId, err })
      setVisible(false)
      setShares([])
    }
  }, [sessionId, sourceUserId])

  useEffect(() => {
    void load()
  }, [load])

  const collaboratorShares = useMemo(
    () => collapseActiveSharesByGrantee(shares),
    [shares],
  )
  const stack = collaboratorShares.slice(0, MAX_STACK_AVATARS)
  const overflow = collaboratorShares.length - stack.length

  const handleRevoke = useCallback(async (share: SessionShareInfo) => {
    setRevokingId(share.id)
    try {
      const updated = await revokeSessionShare(share.id)
      const imState = useIMStore.getState()
      imState.setSessionShare(updated)
      imState.bumpSessionShareDetailVersion(share.id)
      reloadSiblingShareCards(imState, share)
      if (share.status === 'pending') {
        forgetPendingShareIntentForShare({
          sessionId: share.session_id,
          granteeUserId: share.grantee_user_id,
          tier: resolveShareTierLevel(share.can_fork, share.can_chat),
        })
      }
      toast.success(t('sessionCollab.revoked', { defaultValue: '已停止共享' }))
      await load()
    } catch (err) {
      log.error('revoke share failed', { shareId: share.id, err })
      toast.error(t('sessionCollab.revokeFailed', { defaultValue: '停止共享失败' }))
    } finally {
      setRevokingId(null)
    }
  }, [load, t])

  const handleResume = useCallback(async (share: SessionShareInfo) => {
    setResumingId(share.id)
    try {
      const updated = await createSessionShare({
        sessionId: share.session_id,
        granteeUserId: share.grantee_user_id,
        canFork: share.can_fork,
        canChat: share.can_chat,
        restoreShareId: share.id,
      })
      const imState = useIMStore.getState()
      imState.setSessionShare(updated)
      imState.bumpSessionShareDetailVersion(share.id)
      reloadSiblingShareCards(imState, share)
      toast.success(t('sessionCollab.resumed', { defaultValue: '已恢复共享' }))
      await load()
    } catch (err) {
      log.error('resume share failed', { shareId: share.id, err })
      toast.error(t('sessionCollab.resumeFailed', { defaultValue: '恢复共享失败' }))
      await load()
    } finally {
      setResumingId(null)
    }
  }, [load, t])

  const handleShareDialogChange = useCallback((open: boolean) => {
    setShareDialogOpen(open)
    if (!open) void load()
  }, [load])

  const handleOpenSourceChat = useCallback(async () => {
    if (!sourceUserId || !sourceOrganizationId || !currentOrganizationId || openingSourceChat) return
    setOpeningSourceChat(true)
    try {
      const imStore = useIMStore.getState()
      const plan = planGroupMemberDirectChat(
        currentOrganizationId,
        sourceUserId,
        await resolveGroupMemberDirectChat({
          organizationId: currentOrganizationId,
          userId: sourceUserId,
          participantOrganizationId: sourceOrganizationId,
          memberIsExternal: sourceOrganizationId !== currentOrganizationId,
        }),
      )
      if (plan.type === 'reject') {
        throw new Error(plan.messageKey)
      }
      await imStore.createConversationAndActivate(plan.input)
      imStore.setImSidebarView('inbox')
      log.info('opened source user chat from shared session header', {
        sessionId,
        sourceUserId,
        organizationId: currentOrganizationId,
        sourceOrganizationId,
      })
    } catch (err) {
      log.error('failed to open source user chat from shared session header', {
        sessionId,
        sourceUserId,
        organizationId: currentOrganizationId,
        sourceOrganizationId,
        err,
      })
      toast.error(t('sessionCollab.openSourceChatFailed', { defaultValue: '无法打开私信' }))
    } finally {
      setOpeningSourceChat(false)
    }
  }, [currentOrganizationId, openingSourceChat, sessionId, sourceOrganizationId, sourceUserId, t])

  if (!sessionId) return null

  if (sourceUserId) {
    return (
      <div
        className={cn('flex shrink-0 items-center gap-1.5 no-drag', className)}
        title={t('sessionCollab.sharedBy', {
          name: sourceName,
          defaultValue: '由 {{name}} 共享',
        })}
      >
        <ColorAvatar
          name={sourceName}
          seed={sourceUserId}
          imageUrl={sourceAvatar || undefined}
          className="h-6 w-6 rounded-full ring-2 ring-background"
        />
        <span className="max-w-40 truncate text-body text-foreground/80">
          {sourceName}
        </span>
        <button
          type="button"
          onClick={() => { void handleOpenSourceChat() }}
          disabled={!sourceOrganizationId || !currentOrganizationId || openingSourceChat}
          className={cn(
            'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-interactive',
            'text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground',
            'disabled:cursor-not-allowed disabled:opacity-60',
          )}
          aria-label={t('sessionCollab.openSourceChat', {
            name: sourceName,
            defaultValue: '打开与 {{name}} 的私信',
          })}
        >
          <MessageSquare className="h-[1em] w-[1em] text-body" aria-hidden />
        </button>
      </div>
    )
  }

  if (!visible) return null

  return (
    <div className={cn('flex shrink-0 items-center gap-1.5 no-drag', className)}>
      {shouldShowSessionShareManager(shares) && (
        <Popover open={manageOpen} onOpenChange={setManageOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="flex items-center -space-x-1.5 rounded-full px-0.5 py-0.5 transition-colors hover:bg-foreground/[0.05]"
              title={t('sessionCollab.manageTitle', { defaultValue: '管理共享' })}
            >
              {stack.map((share) => (
                <ColorAvatar
                  key={share.grantee_user_id}
                  name={share.grantee_display_name || share.grantee_user_id}
                  seed={share.grantee_user_id}
                  className="h-6 w-6 rounded-full ring-2 ring-background"
                />
              ))}
              {stack.length === 0 && (
                <Users className="h-4 w-4 text-muted-foreground" aria-hidden />
              )}
              {overflow > 0 && (
                <span
                  className={cn(
                    'flex h-6 w-6 items-center justify-center rounded-full bg-muted text-muted-foreground ring-2 ring-background',
                    CANVAS_TEXT_META,
                  )}
                >
                  +{overflow}
                </span>
              )}
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-80 p-2">
            <div className="px-2 pb-2 pt-1">
              <div className="text-body font-medium text-foreground">
                {t('sessionCollab.manageTitle', { defaultValue: '管理共享' })}
              </div>
              <p className={cn('mt-0.5', CANVAS_TEXT_META)}>
                {t('sessionCollab.manageHint', {
                  defaultValue: '已共享的同事可实时查看本次任务，不会获得工作空间访问权。',
                })}
              </p>
            </div>
            <SessionShareGranteeList
              shares={shares}
              t={t}
              revokingId={revokingId}
              resumingId={resumingId}
              onRevoke={(share) => { void handleRevoke(share) }}
              onResume={(share) => { void handleResume(share) }}
              className="max-h-64 px-0.5"
            />
          </PopoverContent>
        </Popover>
      )}
      <button
        type="button"
        onClick={() => setShareDialogOpen(true)}
        title={t('session.shareToColleague', { defaultValue: '共享任务' })}
        className={cn(
          'inline-flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-interactive',
          'bg-muted/30 text-muted-foreground transition-colors hover:bg-muted/45 hover:text-foreground',
        )}
      >
        <UserPlus className="h-3.5 w-3.5" aria-hidden />
      </button>
      <ShareSessionDialog
        open={shareDialogOpen}
        onOpenChange={handleShareDialogChange}
        sessionId={sessionId}
        spaceId={spaceId}
      />
    </div>
  )
}

SessionCollaborators.displayName = 'SessionCollaborators'
