/**
 * SessionShareGranteeList — 某任务已共享用户列表。
 * 供任务顶栏管理 Popover、IM「共享任务」选任务弹窗复用。
 */

import React from 'react'
import { Loader2 } from 'lucide-react'
import { cn } from '@utils/cn'
import { ColorAvatar } from '@components/tabchat/ColorAvatar'
import { ShareTierBadge } from '@components/tabchat/sessionSharePresentation'
import { resolveSessionShareManagementState } from '@components/tabchat/sessionShareManagement'
import { collapseLatestSharesByGrantee } from '@components/tabchat/sessionShareCollaborators'
import type { SessionShareInfo } from '@/services/tabchatApi'

type TranslateFn = (key: string, options?: { defaultValue?: string }) => string

export interface SessionShareGranteeListProps {
  shares: SessionShareInfo[]
  t: TranslateFn
  /** 当前 DM 对端，用于高亮「就是这次要共享的人」 */
  highlightUserId?: string | null
  loading?: boolean
  emptyLabel?: string
  highlightLabel?: string
  revokedLabel?: string
  pendingLabel?: string
  stopLabel?: string
  cancelLabel?: string
  resumeLabel?: string
  revokingId?: string | null
  resumingId?: string | null
  onRevoke?: (share: SessionShareInfo) => void
  onResume?: (share: SessionShareInfo) => void
  className?: string
  /** 为 false 时只展示 active；默认 true 与顶栏管理面板一致 */
  includeRevoked?: boolean
}

export const SessionShareGranteeList: React.FC<SessionShareGranteeListProps> = ({
  shares,
  t,
  highlightUserId = null,
  loading = false,
  emptyLabel,
  highlightLabel,
  revokedLabel,
  pendingLabel,
  stopLabel,
  cancelLabel,
  resumeLabel,
  revokingId = null,
  resumingId = null,
  onRevoke,
  onResume,
  className,
  includeRevoked = true,
}) => {
  const latestShares = collapseLatestSharesByGrantee(shares)
  const visibleShares = includeRevoked
    ? latestShares
    : latestShares.filter((share) => share.status === 'active')

  if (loading) {
    return (
      <div className={cn('flex items-center justify-center gap-2 py-3 text-muted-foreground', className)}>
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        <span className="text-caption">
          {t('loading', { defaultValue: '加载中…' })}
        </span>
      </div>
    )
  }

  if (visibleShares.length === 0) {
    return (
      <p className={cn('px-0.5 py-1 text-caption text-muted-foreground', className)}>
        {emptyLabel ?? t('sessionSharePickerSharedEmpty', {
          defaultValue: '尚未共享给任何人',
        })}
      </p>
    )
  }

  const peerBadge = highlightLabel ?? t('sessionSharePickerCurrentPeer', {
    defaultValue: '当前对方',
  })
  const stopped = revokedLabel ?? t('sessionCollab.revokedBadge', {
    defaultValue: '已停止',
  })
  const awaitingConfirmation = pendingLabel ?? t('sessionCollab.pendingBadge', {
    defaultValue: '待确认',
  })
  const stop = stopLabel ?? t('sessionCollab.stop', {
    defaultValue: '停止',
  })
  const cancel = cancelLabel ?? t('sessionCollab.cancelPending', {
    defaultValue: '取消',
  })
  const resume = resumeLabel ?? t('sessionCollab.resume', {
    defaultValue: '恢复',
  })

  return (
    <div className={cn('flex max-h-40 flex-col gap-0.5 overflow-y-auto', className)}>
      {visibleShares.map((share) => {
        const state = resolveSessionShareManagementState(share.status)
        const revoked = state.statusLabel === 'revoked'
        const name = share.grantee_display_name || share.grantee_user_id
        const isCurrentPeer = Boolean(
          highlightUserId && share.grantee_user_id === highlightUserId,
        )
        return (
          <div
            key={share.id}
            className={cn(
              'flex items-center gap-2 rounded-interactive px-1.5 py-1.5',
              isCurrentPeer && state.showCurrentPeer && 'bg-accent/5',
              revoked && 'opacity-55',
            )}
          >
            <ColorAvatar
              name={name}
              seed={share.grantee_user_id}
              className="h-7 w-7 shrink-0 rounded-full"
            />
            <span className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate text-body text-foreground">{name}</span>
                {isCurrentPeer && state.showCurrentPeer ? (
                  <span className="shrink-0 rounded-md bg-accent/10 px-1.5 py-0.5 text-caption text-accent">
                    {peerBadge}
                  </span>
                ) : null}
              </span>
              {state.statusLabel ? (
                <span className="text-caption text-muted-foreground">
                  {state.statusLabel === 'pending' ? awaitingConfirmation : stopped}
                </span>
              ) : state.showTier ? (
                <ShareTierBadge
                  canFork={Boolean(share.can_fork)}
                  canChat={Boolean(share.can_chat)}
                  t={t}
                />
              ) : null}
            </span>
            {onRevoke && state.canRevoke ? (
              <button
                type="button"
                disabled={revokingId === share.id}
                onClick={() => { onRevoke(share) }}
                className={cn(
                  'shrink-0 rounded-interactive px-2 py-1 text-caption text-muted-foreground transition-colors',
                  'hover:bg-destructive/10 hover:text-destructive',
                )}
              >
                {revokingId === share.id
                  ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                  : state.statusLabel === 'pending' ? cancel : stop}
              </button>
            ) : null}
            {onResume && state.canResume ? (
              <button
                type="button"
                disabled={resumingId === share.id}
                onClick={() => { onResume(share) }}
                className={cn(
                  'shrink-0 rounded-interactive px-2 py-1 text-caption text-accent transition-colors',
                  'hover:bg-accent/10',
                )}
              >
                {resumingId === share.id
                  ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                  : resume}
              </button>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

SessionShareGranteeList.displayName = 'SessionShareGranteeList'
