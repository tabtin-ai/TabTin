import React, { useMemo } from 'react'
import { Check } from 'lucide-react'
import type { ChatSession } from '@tabtin/chat-client'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@components/ui'
import { cn } from '@utils/cn'
import { SessionStatusIcon } from '@components/chat/session/SessionStatusIcon'
import { formatRelativeTimeFromTs } from '@components/chat/session/formatRelativeTimeFromTs'
import { ColorAvatar } from '@components/tabchat/ColorAvatar'
import type { SessionShareInfo } from '@/services/tabchatApi'
import {
  buildSharePickerSessionPresentation,
  type SharePickerSessionContext,
} from './sessionSharePickerPresentation'
import { collapseActiveSharesByGrantee } from './sessionShareCollaborators'

/** 超过此数量：只露 1 个头像 + 省略号头像，完整名单进 tooltip */
const COMPACT_AVATAR_THRESHOLD = 3

interface ShareSessionPickerRowProps {
  session: ChatSession
  /** store 桶归属；与左栏计数 / 过滤一致，优先于 session.space_id */
  sourceSpaceId?: string | null
  selected: boolean
  disabled?: boolean
  context: SharePickerSessionContext
  /** 该任务当前 active 的共享行；用于行内头像堆 */
  activeShares?: SessionShareInfo[]
  /** 当前 DM 对端，头像加强调并优先露出 */
  highlightUserId?: string | null
  onSelect: (sessionId: string) => void
  t: (key: string, opts?: Record<string, unknown>) => string
}

function shareDisplayName(share: SessionShareInfo): string {
  return share.grantee_display_name || share.grantee_user_id
}

export const ShareSessionPickerRow: React.FC<ShareSessionPickerRowProps> = ({
  session,
  sourceSpaceId,
  selected,
  disabled,
  context,
  activeShares = [],
  highlightUserId = null,
  onSelect,
  t,
}) => {
  const presentation = buildSharePickerSessionPresentation(
    session,
    context,
    t,
    sourceSpaceId,
  )
  const relativeTime = formatRelativeTimeFromTs(presentation.activityTs, t)
  const previewMuted = (session.message_count ?? 0) === 0 && !session.last_message_preview?.trim()

  const orderedShares = useMemo(() => {
    const collapsed = collapseActiveSharesByGrantee(activeShares)
    if (!highlightUserId || collapsed.length <= 1) return collapsed
    return [...collapsed].sort((a, b) => {
      const aPeer = a.grantee_user_id === highlightUserId ? 0 : 1
      const bPeer = b.grantee_user_id === highlightUserId ? 0 : 1
      return aPeer - bPeer
    })
  }, [activeShares, highlightUserId])

  const compact = orderedShares.length >= COMPACT_AVATAR_THRESHOLD
  const visibleShares = compact ? orderedShares.slice(0, 1) : orderedShares
  const sharedNames = orderedShares.map(shareDisplayName)
  const sharedTitle = sharedNames.length > 0
    ? t('sessionSharePickerRowSharedWith', {
      names: sharedNames.join('、'),
      defaultValue: `已共享给 ${sharedNames.join('、')}`,
    })
    : null

  const shareAvatars = orderedShares.length > 0 ? (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className="flex shrink-0 items-center -space-x-1.5"
            aria-label={sharedTitle ?? undefined}
          >
            {visibleShares.map((share) => {
              const name = shareDisplayName(share)
              const isPeer = Boolean(
                highlightUserId && share.grantee_user_id === highlightUserId,
              )
              return (
                <ColorAvatar
                  key={share.grantee_user_id}
                  name={name}
                  seed={share.grantee_user_id}
                  className={cn(
                    'h-6 w-6 rounded-full ring-2 ring-background',
                    isPeer && 'ring-accent/60',
                  )}
                />
              )
            })}
            {compact ? (
              <span
                className="flex h-6 w-6 items-center justify-center rounded-full bg-muted text-caption leading-none text-muted-foreground ring-2 ring-background"
                aria-hidden
              >
                …
              </span>
            ) : null}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" align="end" className="max-w-[240px] text-body">
          <div className="flex flex-col gap-0.5">
            <span className="text-caption text-muted-foreground">
              {t('sessionSharePickerSharedWith', { defaultValue: '已共享给' })}
            </span>
            {orderedShares.map((share) => (
              <span key={share.id} className="truncate text-foreground">
                {shareDisplayName(share)}
              </span>
            ))}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  ) : null

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onSelect(session.id)}
      className={cn(
        'flex w-full items-start gap-2.5 rounded-interactive px-3 py-2.5 text-left transition-colors disabled:opacity-50',
        selected
          ? 'bg-foreground/[0.04] dark:bg-foreground/[0.06]'
          : 'hover:bg-foreground/[0.03] dark:hover:bg-foreground/[0.05]',
      )}
      title={[presentation.title, presentation.meta, presentation.preview]
        .filter(Boolean)
        .join(' · ')}
    >
      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center">
        <SessionStatusIcon session={session} />
      </span>

      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-body font-medium text-foreground">
            {presentation.title}
          </span>
          {shareAvatars}
        </span>

        {presentation.meta ? (
          <span className="mt-0.5 block truncate text-caption text-muted-foreground">
            {presentation.meta}
          </span>
        ) : null}

        {presentation.trackerLabel ? (
          <span className="mt-0.5 block truncate text-caption text-muted-foreground/80">
            {presentation.trackerLabel}
          </span>
        ) : null}

        {presentation.preview ? (
          <span
            className={cn(
              'mt-0.5 block truncate text-caption',
              previewMuted ? 'text-muted-foreground/60 italic' : 'text-muted-foreground/80',
            )}
          >
            {presentation.preview}
          </span>
        ) : null}
      </span>

      {relativeTime ? (
        <span className="mt-0.5 shrink-0 text-caption text-muted-foreground/80">
          {relativeTime}
        </span>
      ) : null}

      {selected ? <Check className="mt-1 h-4 w-4 shrink-0 text-accent" aria-hidden /> : null}
    </button>
  )
}
