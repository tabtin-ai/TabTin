/**
 * ImSharedSessionsPane —— IM 会话桌面画布内的「共享对话」列表页。
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArrowDownLeft,
  ArrowUpRight,
  ChevronRight,
  Loader2,
  RefreshCw,
  Share2,
} from 'lucide-react'
import { Button } from '@components/ui'
import { cn } from '@utils/cn'
import { useAuthStore } from '@stores/useAuthStore'
import { useIMStore } from '@stores/useIMStore'
import { CONVERSATION_TYPE_DM } from '@/constants/tabchat'
import { listSessionShares, type SessionShareInfo } from '@/services/tabchatApi'
import { ShareTierBadge } from './sessionSharePresentation'
import { isOutgoingSessionShare, resolveSharedSessionRowState } from './sessionShareManagement'
import { formatConversationTime } from '@/lib/dateUtils'
import { createLogger } from '@/utils/logger'
import { openSharedSessionInIm } from '@/components/chat/shared-view/openSharedSessionInIm'

const log = createLogger('ImSharedSessionsPane')

interface Props {
  conversationId: string
}

export const ImSharedSessionsPane: React.FC<Props> = ({ conversationId }) => {
  const { t } = useTranslation('tabchat')
  const conversation = useIMStore(
    (state) => state.conversations.find((c) => c.id === conversationId) ?? null,
  )
  // 创建 / 撤销 / 改权共享时由 useIMStore bump；对齐 HandoffCard ← handoffVersions
  const listVersion = useIMStore(
    (state) => state.sessionShareListVersions[conversationId] ?? 0,
  )
  const myUserId = useAuthStore.getState().user?.id ? String(useAuthStore.getState().user!.id) : ''
  const peerUserId = conversation?.type === CONVERSATION_TYPE_DM
    ? (conversation.dm_peer_user_id ?? null)
    : null

  const [shares, setShares] = useState<SessionShareInfo[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [loadError, setLoadError] = useState(false)

  const load = useCallback(async () => {
    if (!peerUserId) return
    setIsLoading(true)
    setLoadError(false)
    try {
      const result = await listSessionShares(peerUserId, conversation?.organization_id)
      setShares(result)
    } catch (err) {
      log.error('load session shares failed', { conversationId, err })
      setLoadError(true)
    } finally {
      setIsLoading(false)
    }
  }, [conversation?.organization_id, conversationId, peerUserId])

  useEffect(() => {
    void load()
  }, [load, listVersion])

  const rows = useMemo(() => shares.map((share) => {
    const outgoing = isOutgoingSessionShare({
      ownerUserId: share.owner_user_id,
      currentUserId: myUserId,
    })
    const rowState = resolveSharedSessionRowState(share.status, outgoing)
    return { share, outgoing, ...rowState }
  }), [myUserId, shares])

  const handleOpen = useCallback((share: SessionShareInfo, outgoing: boolean) => {
    openSharedSessionInIm({
      conversationId,
      sessionId: share.session_id,
      shareId: share.id,
      title: share.session_title || undefined,
      organizationId: conversation?.organization_id,
      workspaceId: share.workspace_id ?? null,
      workspaceName: share.workspace_name || undefined,
      ownerUserId: share.owner_user_id,
      ownerDisplayName: share.owner_display_name || undefined,
      incoming: !outgoing,
    })
  }, [conversation?.organization_id, conversationId])

  if (!peerUserId) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <Share2 className="h-8 w-8 text-muted-foreground/30" aria-hidden />
        <p className="text-body text-muted-foreground">
          {t('sharedSessionsDmOnly', { defaultValue: '仅私聊会话支持共享对话' })}
        </p>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 w-full max-w-full flex-col overflow-hidden bg-transparent">
      <div className="flex shrink-0 items-start justify-between gap-3 border-b border-border/40 px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-body font-medium text-foreground">
            {t('sharedSessionsTitle', { defaultValue: '共享对话' })}
          </h2>
          <p className="mt-0.5 text-caption text-muted-foreground">
            {t('sharedSessionsSubtitle', { defaultValue: '你和对方互相共享的 Agent 任务' })}
          </p>
        </div>
        <button
          type="button"
          className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-interactive text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
          title={t('sharedSessionsRefresh', { defaultValue: '刷新' })}
          aria-label={t('sharedSessionsRefresh', { defaultValue: '刷新' })}
          onClick={() => { void load() }}
          disabled={isLoading}
        >
          {isLoading
            ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            : <RefreshCw className="h-3.5 w-3.5" aria-hidden />}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-2">
        {loadError && (
          <div className="flex flex-col items-center gap-3 py-12 text-center">
            <p className="text-body text-muted-foreground">
              {t('sharedSessionsLoadFailed', { defaultValue: '共享列表加载失败' })}
            </p>
            <Button type="button" variant="outline" size="sm" onClick={() => { void load() }}>
              {t('sharedSessionsRetry', { defaultValue: '重试' })}
            </Button>
          </div>
        )}

        {!loadError && isLoading && shares.length === 0 && (
          <div className="flex flex-col items-center gap-2 py-12 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
            <span className="text-body">{t('loading', { defaultValue: '加载中…' })}</span>
          </div>
        )}

        {!loadError && !isLoading && rows.length === 0 && (
          <div className="flex flex-col items-center gap-2 px-4 py-12 text-center">
            <Share2 className="h-8 w-8 text-muted-foreground/30" aria-hidden />
            <p className="text-body text-muted-foreground">
              {t('sharedSessionsEmpty', { defaultValue: '还没有互相共享的任务' })}
            </p>
            <p className="text-caption text-muted-foreground/80">
              {t('sharedSessionsEmptyHint', {
                defaultValue: '在 Agent 任务里点「共享任务」，或让对方共享给你。',
              })}
            </p>
          </div>
        )}

        {rows.map(({ share, outgoing, statusLabel, showTier, disabled }) => (
          <button
            key={share.id}
            type="button"
            disabled={disabled}
            onClick={() => handleOpen(share, outgoing)}
            className={cn(
              'mb-1 flex w-full items-center gap-2.5 rounded-interactive px-2.5 py-2.5 text-left transition-colors',
              disabled
                ? 'cursor-not-allowed opacity-50'
                : 'hover:bg-foreground/[0.03] dark:hover:bg-foreground/[0.05]',
            )}
          >
            <span
              className={cn(
                'flex h-8 w-8 shrink-0 items-center justify-center rounded-interactive',
                outgoing ? 'bg-muted/40 text-muted-foreground' : 'bg-accent/10 text-accent',
              )}
            >
              {outgoing
                ? <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
                : <ArrowDownLeft className="h-3.5 w-3.5" aria-hidden />}
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="truncate text-body font-medium text-foreground">
                {share.session_title
                  || t('sessionShareTitleFallback', { defaultValue: '未命名任务' })}
              </span>
              <span className="flex flex-wrap items-center gap-2 text-caption text-muted-foreground">
                <span>
                  {outgoing
                    ? t('sharedSessionsOutgoing', { defaultValue: '我共享的' })
                    : t('sharedSessionsIncoming', { defaultValue: '对方共享的' })}
                </span>
                {showTier && (
                  <ShareTierBadge
                    canFork={Boolean(share.can_fork)}
                    canChat={Boolean(share.can_chat)}
                    t={t}
                  />
                )}
                {statusLabel && (
                  <span className="rounded-md bg-muted/40 px-1.5 py-0.5">
                    {statusLabel === 'pending'
                      ? t('sessionShareStatusPending', { defaultValue: '待确认' })
                      : t('sessionShareStatusRevoked', { defaultValue: '已停止' })}
                  </span>
                )}
                {share.created_at && (
                  <span className="text-muted-foreground/80">
                    {formatConversationTime(share.created_at, t)}
                  </span>
                )}
              </span>
            </span>
            {!disabled && (
              <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/50" aria-hidden />
            )}
          </button>
        ))}
      </div>
    </div>
  )
}

ImSharedSessionsPane.displayName = 'ImSharedSessionsPane'
