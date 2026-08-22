/**
 * SessionShareCard — IM 任务共享卡。
 *
 * 卡片是共享授权行（SessionShare）的展示面：metadata.card 带 share_id + 服务端
 * 回填的快照，挂载后从 getSessionShare 实时拉详情（对齐 HandoffCard 的模式）。
 */

import React, { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Share2, SquareArrowOutUpRight, Undo2 } from 'lucide-react'
import { ConfirmDialog, toast } from '@components/ui'
import { useAuthStore } from '@stores/useAuthStore'
import { useIMStore } from '@stores/useIMStore'
import { useUserProfileCache, useDisplayName, useAvatar } from '@stores/useUserProfileCache'
import {
  createSessionShare,
  revokeSessionShare,
} from '@/services/tabchatApi'
import {
  buildSessionShareCardView,
  resolveSessionShareCardCapabilities,
  resolveSessionShareCardStatus,
} from './sessionShareCardLogic'
import { ShareTierBadge } from './sessionSharePresentation'
import { ColorAvatar } from './ColorAvatar'
import { createLogger } from '@/utils/logger'
import { cn } from '@utils/cn'
import { useOrganizationStore } from '@/stores/useOrganizationStore'
import { openSharedSessionInIm } from '@/components/chat/shared-view/openSharedSessionInIm'
import { resolveIncomingSessionShare } from '@/components/chat/shared-view/resolveIncomingSessionShare'

const log = createLogger('SessionShareCard')

/** 本地点停止/恢复后写回消息快照，避免无 WS 时角标被陈旧 snapshot 盖住。 */
function patchLocalShareCardStatus(shareId: string, status: string) {
  const state = useIMStore.getState()
  const candidates = [
    state.currentConversationId,
    ...Object.keys(state.messages),
  ].filter((id): id is string => Boolean(id))
  const seen = new Set<string>()
  for (const conversationId of candidates) {
    if (seen.has(conversationId)) continue
    seen.add(conversationId)
    const msgs = state.messages[conversationId]
    if (!msgs?.some((m) => {
      const card = m.metadata?.card
      return card?.type === 'session_share' && card.share_id === shareId
    })) {
      continue
    }
    state.reconcileSessionShareStatus({
      share_id: shareId,
      conversation_id: conversationId,
      status,
    })
    return
  }
}

interface Props {
  shareId: string
  sessionIdSnapshot?: string
  sessionTitleSnapshot?: string
  ownerUserIdSnapshot?: string
  granteeUserIdSnapshot?: string
  canForkSnapshot?: boolean
  canChatSnapshot?: boolean
  statusSnapshot?: string
}

export const SessionShareCard: React.FC<Props> = ({
  shareId,
  sessionIdSnapshot,
  sessionTitleSnapshot,
  ownerUserIdSnapshot,
  granteeUserIdSnapshot,
  canForkSnapshot,
  canChatSnapshot,
  statusSnapshot,
}) => {
  const { t } = useTranslation('tabchat')
  const currentUserId = useAuthStore((s) => s.user?.id)
  const ensureProfiles = useUserProfileCache((s) => s.ensureProfiles)

  const [revoking, setRevoking] = useState(false)
  const [resuming, setResuming] = useState(false)
  const [confirmRevokeOpen, setConfirmRevokeOpen] = useState(false)
  // ：对齐 HandoffCard ← handoffVersions
  const shareDetailVersion = useIMStore(
    (s) => s.sessionShareDetailVersions[shareId] ?? 0,
  )
  const shareEntry = useIMStore((s) => s.sessionShares[shareId])
  const detail = shareEntry?.detail ?? null
  const loadFailed = shareEntry?.loadState === 'error' && !shareEntry.accessDenied

  useEffect(() => {
    const state = useIMStore.getState()
    if (!state.sessionShares[shareId]?.detail) {
      state.patchSessionShare(shareId, {
        ...(sessionIdSnapshot ? { session_id: sessionIdSnapshot } : {}),
        ...(sessionTitleSnapshot ? { session_title: sessionTitleSnapshot } : {}),
        ...(ownerUserIdSnapshot ? { owner_user_id: ownerUserIdSnapshot } : {}),
        ...(granteeUserIdSnapshot ? { grantee_user_id: granteeUserIdSnapshot } : {}),
        ...(canForkSnapshot !== undefined ? { can_fork: canForkSnapshot } : {}),
        ...(canChatSnapshot !== undefined ? { can_chat: canChatSnapshot } : {}),
        ...(statusSnapshot === 'pending' || statusSnapshot === 'active' || statusSnapshot === 'revoked'
          ? { status: statusSnapshot }
          : {}),
      })
    }
    void state.loadSessionShare(shareId)
  }, [
    shareId,
    sessionIdSnapshot,
    sessionTitleSnapshot,
    ownerUserIdSnapshot,
    granteeUserIdSnapshot,
    canForkSnapshot,
    canChatSnapshot,
    statusSnapshot,
    shareDetailVersion,
  ])

  const ownerUserId = detail?.owner_user_id ?? ownerUserIdSnapshot
  const granteeUserId = detail?.grantee_user_id ?? granteeUserIdSnapshot

  useEffect(() => {
    const ids = [ownerUserId, granteeUserId].filter(
      (id): id is string => Boolean(id),
    )
    if (ids.length > 0) ensureProfiles(ids)
  }, [ownerUserId, granteeUserId, ensureProfiles])

  const cachedOwnerName = useDisplayName(ownerUserId ?? '')
  const cachedGranteeName = useDisplayName(granteeUserId ?? '')
  const ownerAvatar = useAvatar(ownerUserId)
  const ownerName = cachedOwnerName || detail?.owner_display_name || ''
  const granteeName = cachedGranteeName || detail?.grantee_display_name || ''

  const sessionId = detail?.session_id ?? sessionIdSnapshot ?? ''
  const sessionTitle =
    detail?.session_title
    || sessionTitleSnapshot
    || t('sessionShareTitleFallback', { defaultValue: '未命名任务' })
  const { canFork, canChat } = resolveSessionShareCardCapabilities(
    detail?.can_fork,
    detail?.can_chat,
    canForkSnapshot,
    canChatSnapshot,
  )
  const status = resolveSessionShareCardStatus(detail?.status, statusSnapshot)

  const view = buildSessionShareCardView({
    currentUserId,
    ownerUserId,
    granteeUserId,
    status,
    canFork,
    canChat,
  })
  const revoked = view.status === 'revoked'
  const pending = view.status === 'pending'

  const relationLine = (() => {
    if (view.role === 'owner' && granteeName) {
      return t('sessionShareToGrantee', {
        name: granteeName,
        defaultValue: `你共享给 ${granteeName}`,
      })
    }
    if (view.role === 'grantee' && ownerName) {
      return t('sessionShareFromOwner', {
        name: ownerName,
        defaultValue: `${ownerName} 共享给你`,
      })
    }
    if (ownerName) {
      return t('sessionShareOwner', { defaultValue: '发起人' }) + ` · ${ownerName}`
    }
    return null
  })()

  const handleOpen = useCallback(async () => {
    if (!sessionId) {
      toast({
        title: t('sessionShareOpenFailed', { defaultValue: '无法打开任务' }),
        variant: 'destructive',
      })
      return
    }
    const conversationId = useIMStore.getState().currentConversationId
    if (!conversationId) {
      toast({
        title: t('sessionShareOpenFailed', { defaultValue: '无法打开任务' }),
        variant: 'destructive',
      })
      return
    }
    const organizationId = useOrganizationStore.getState().selectedOrganization?.id
    let shareForOpen = detail
    if (view.role === 'grantee' && organizationId) {
      try {
        shareForOpen = await resolveIncomingSessionShare(organizationId, sessionId)
      } catch (error) {
        log.warn('resolve latest incoming session share failed', { shareId, sessionId }, error)
        toast({
          title: t('sessionShareOpenFailed', { defaultValue: '无法打开任务' }),
          variant: 'destructive',
        })
        return
      }
      if (!shareForOpen) {
        toast({
          title: t('sessionShareRevokedNote', { defaultValue: '共享已停止' }),
          variant: 'destructive',
        })
        return
      }
    }
    const opened = openSharedSessionInIm({
      conversationId,
      sessionId,
      shareId: shareForOpen?.id ?? shareId,
      title: sessionTitle,
      organizationId,
      workspaceId: shareForOpen?.workspace_id ?? null,
      workspaceName: shareForOpen?.workspace_name || undefined,
      ownerUserId: shareForOpen?.owner_user_id ?? ownerUserId ?? undefined,
      ownerDisplayName: shareForOpen?.owner_display_name || ownerName || undefined,
      incoming: view.role === 'grantee',
    })
    if (!opened) toast({ title: t('sessionShareOpenFailed', { defaultValue: '无法打开任务' }), variant: 'destructive' })
  }, [detail, ownerName, ownerUserId, sessionId, sessionTitle, shareId, t, view.role])

  const handleRevoke = useCallback(async () => {
    if (revoking) return
    setRevoking(true)
    try {
      const updated = await revokeSessionShare(shareId)
      useIMStore.getState().setSessionShare(updated)
      patchLocalShareCardStatus(shareId, updated.status)
      toast({ title: t('sessionShareRevoked', { defaultValue: '已停止共享' }) })
    } catch (err) {
      log.warn('revoke session share failed', { shareId, err })
      toast({
        title: t('sessionShareRevokeFailed', { defaultValue: '停止共享失败' }),
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      })
      throw err
    } finally {
      setRevoking(false)
    }
  }, [revoking, shareId, t])

  const handleResume = useCallback(async () => {
    if (resuming || !detail?.grantee_user_id || !sessionId) return
    setResuming(true)
    try {
      const updated = await createSessionShare({
        sessionId,
        granteeUserId: detail.grantee_user_id,
        canFork: canFork,
        canChat: canChat,
        restoreShareId: shareId,
      })
      useIMStore.getState().setSessionShare(updated)
      patchLocalShareCardStatus(shareId, updated.status)
      toast({ title: t('sessionShareResumed', { defaultValue: '已恢复共享' }) })
    } catch (err) {
      log.warn('resume session share failed', { shareId, err })
      useIMStore.getState().bumpSessionShareDetailVersion(shareId)
      toast({
        title: t('sessionShareResumeFailed', { defaultValue: '恢复共享失败' }),
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      })
    } finally {
      setResuming(false)
    }
  }, [resuming, detail?.grantee_user_id, sessionId, canFork, canChat, shareId, t])

  return (
    <div className="w-[320px] max-w-full overflow-hidden rounded-xl border border-border/60 bg-card">
      <div className="flex items-center gap-2 px-3.5 pt-3">
        <span className="inline-flex items-center gap-1.5 text-caption font-medium text-accent">
          <Share2 className="h-3.5 w-3.5" aria-hidden />
          {t('sessionShareCardTitle', { defaultValue: '任务共享' })}
        </span>
        <span className="flex-1" />
        <span
          className={cn(
            'rounded-md px-1.5 py-0.5 text-caption',
            revoked
              ? 'bg-muted/40 text-muted-foreground'
              : 'bg-foreground/[0.04] text-muted-foreground dark:bg-foreground/[0.06]',
          )}
        >
          {pending
            ? t('sessionShareStatusPending', { defaultValue: '待确认' })
            : revoked
            ? t('sessionShareStatusRevoked', { defaultValue: '已停止' })
            : t('sessionShareStatusActive', { defaultValue: '共享中' })}
        </span>
      </div>

      <div className={cn('space-y-2 px-3.5 pb-3 pt-2', revoked && 'opacity-60')}>
        <div className="text-subtitle font-semibold leading-snug text-foreground">
          {sessionTitle}
        </div>

        {relationLine && (
          <div className="flex items-center gap-2 text-caption text-muted-foreground">
            {ownerUserId && ownerName ? (
              <ColorAvatar
                name={ownerName}
                seed={ownerUserId}
                imageUrl={ownerAvatar}
                className="h-5 w-5 shrink-0 rounded-full"
                fallbackClassName="text-[10px]"
              />
            ) : null}
            <span className="min-w-0 truncate">{relationLine}</span>
          </div>
        )}

        {!revoked && !pending && (
          <ShareTierBadge canFork={canFork} canChat={canChat} t={t} />
        )}
      </div>

      {loadFailed && !revoked && (
        <div className="px-3.5 pb-3 text-caption text-muted-foreground">
          {t('sessionShareLoadFailed', { defaultValue: '共享详情加载失败' })}
        </div>
      )}

      {(view.showOpen || view.showRevoke || view.showResume || view.showRevokedNote) && (
        <div className="flex items-center gap-2 border-t border-border/40 px-3.5 py-2.5">
          {view.showOpen && (
            <button
              type="button"
              onClick={handleOpen}
              className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-interactive bg-accent px-3 py-2 text-body font-medium text-accent-foreground transition-colors hover:bg-accent/90"
            >
              <SquareArrowOutUpRight className="h-3.5 w-3.5" aria-hidden />
              {t('sessionShareOpen', { defaultValue: '打开任务' })}
            </button>
          )}
          {view.showRevokedNote && (
            <span className="flex-1 text-center text-body text-muted-foreground/60">
              {t('sessionShareRevokedNote', { defaultValue: '共享已停止' })}
            </span>
          )}
          {view.showResume && (
            <button
              type="button"
              disabled={resuming}
              onClick={() => { void handleResume() }}
              className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-interactive bg-accent px-3 py-2 text-body font-medium text-accent-foreground transition-colors hover:bg-accent/90 disabled:opacity-50"
            >
              {resuming ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <Share2 className="h-3.5 w-3.5" aria-hidden />
              )}
              {t('sessionShareResumeAction', { defaultValue: '恢复共享' })}
            </button>
          )}
          {view.showRevoke && (
            <button
              type="button"
              disabled={revoking}
              onClick={() => setConfirmRevokeOpen(true)}
              className={cn(
                'inline-flex items-center gap-1 rounded-interactive px-2 py-1.5 text-body text-muted-foreground transition-colors',
                'hover:bg-destructive/10 hover:text-destructive disabled:opacity-50',
                !view.showOpen && 'ml-auto',
              )}
            >
              {revoking ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <Undo2 className="h-3.5 w-3.5" aria-hidden />
              )}
              {t('sessionShareRevokeAction', { defaultValue: '停止共享' })}
            </button>
          )}
        </div>
      )}

      {confirmRevokeOpen && (
        <ConfirmDialog
          open
          onOpenChange={setConfirmRevokeOpen}
          title={t('sessionShareRevokeConfirmTitle', { defaultValue: '停止共享该任务？' })}
          description={t('sessionShareRevokeConfirmDesc', {
            defaultValue: '停止后对方将无法再查看这个任务；你已 fork 出去的副本不受影响。',
          })}
          confirmText={t('sessionShareRevokeAction', { defaultValue: '停止共享' })}
          variant="destructive"
          onConfirm={handleRevoke}
          container={null}
        />
      )}
    </div>
  )
}
