/**
 * OnlinePresencePopover — 「N 人在线」头像条 + 溢出 ··· 浮层
 *
 * 只表达实时在线身份，不展示权限角色（owner/editor/viewer）。
 * 断线时不渲染（由连接状态徽章承接）。
 */
import React, { useCallback, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Popover, PopoverContent, PopoverTrigger, UserAvatar, cn } from '@tabtin/smartsheet-ui'
import { identityAvatarColor, identityAvatarInitial } from '@tabtin/shared'

export interface OnlinePresenceUser {
  id: string
  name: string
  type?: 'user' | 'agent'
  avatar?: string | null
  color?: string
}

export interface OnlinePresencePopoverProps {
  /** 其他在线者（不含自己） */
  peers: OnlinePresenceUser[]
  /** 当前用户；缺省时不渲染 */
  self: OnlinePresenceUser | null
  /** false 时不渲染整块（断线） */
  isOnline: boolean
  /** 内联最多头像数（含自己），超出显示 ··· */
  maxInline?: number
  className?: string
}

interface Participant extends OnlinePresenceUser {
  isSelf: boolean
}

const CLOSE_DELAY_MS = 180

export const OnlinePresencePopover: React.FC<OnlinePresencePopoverProps> = ({
  peers,
  self,
  isOnline,
  maxInline = 3,
  className,
}) => {
  const { t } = useTranslation('collab')
  const [open, setOpen] = useState(false)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const participants = useMemo<Participant[]>(() => {
    if (!self) return []
    const others = peers.map(peer => ({ ...peer, isSelf: false }))
    return [...others, { ...self, isSelf: true }]
  }, [peers, self])

  const count = participants.length
  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
  }, [])

  const scheduleClose = useCallback(() => {
    clearCloseTimer()
    closeTimerRef.current = setTimeout(() => setOpen(false), CLOSE_DELAY_MS)
  }, [clearCloseTimer])

  const handleOpen = useCallback(() => {
    clearCloseTimer()
    setOpen(true)
  }, [clearCloseTimer])

  if (!isOnline || !self || count === 0) return null

  // maxInline 是「内联头像 + 溢出按钮」总槽位；有溢出时头像只占 maxInline-1。
  // 隐藏人数必须按实际 inline.length 计算，不能用 count-maxInline（会少报 1）。
  const safeMaxInline = Math.max(0, maxInline)
  const needsOverflow = count > safeMaxInline
  const inlineCapacity = needsOverflow ? Math.max(0, safeMaxInline - 1) : count
  const inline = participants.slice(0, inlineCapacity)
  const overflow = Math.max(0, count - inline.length)
  const onlineLabel = t('presence.onlineCount', {
    count,
    defaultValue: '{{count}} 人在线',
  })
  const overflowAria = t('presence.overflowAria', {
    count: overflow,
    defaultValue: '还有 {{count}} 人在线，展开全部',
  })

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <div
        className={cn(
          'flex items-center gap-1 rounded-md border border-border/60 bg-muted/20 px-1.5 py-0.5',
          className,
        )}
        onMouseEnter={handleOpen}
        onMouseLeave={scheduleClose}
      >
        <div className="flex items-center -space-x-1.5">
          {inline.map(participant => (
            <PresenceAvatar
              key={`${participant.id}-${participant.isSelf ? 'self' : 'peer'}`}
              participant={participant}
              title={
                participant.isSelf
                  ? t('presence.self', { defaultValue: '你' })
                  : participant.name
              }
            />
          ))}
          {overflow > 0 && (
            <PopoverTrigger asChild>
              <button
                type="button"
                className="relative z-[1] flex h-5 w-5 items-center justify-center rounded-full border border-border/60 bg-muted text-[10px] font-medium text-muted-foreground hover:bg-muted/80"
                aria-label={overflowAria}
                aria-haspopup="dialog"
                aria-expanded={open}
                onFocus={handleOpen}
                onBlur={scheduleClose}
                onKeyDown={event => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    setOpen(prev => !prev)
                  }
                }}
              >
                ···
              </button>
            </PopoverTrigger>
          )}
        </div>

        {overflow <= 0 ? (
          <PopoverTrigger asChild>
            <button
              type="button"
              className="text-caption tabular-nums text-muted-foreground hover:text-foreground"
              aria-label={onlineLabel}
              aria-haspopup="dialog"
              aria-expanded={open}
              onFocus={handleOpen}
              onBlur={scheduleClose}
            >
              {onlineLabel}
            </button>
          </PopoverTrigger>
        ) : (
          <span className="text-caption tabular-nums text-muted-foreground">{onlineLabel}</span>
        )}
      </div>

      <PopoverContent
        align="end"
        sideOffset={6}
        className="w-56 p-2"
        onMouseEnter={handleOpen}
        onMouseLeave={scheduleClose}
        onOpenAutoFocus={event => event.preventDefault()}
        onCloseAutoFocus={event => event.preventDefault()}
      >
        <div className="px-1.5 pb-1.5 text-caption font-medium text-muted-foreground">
          {t('presence.listTitle', {
            count,
            defaultValue: '当前在线（{{count}}）',
          })}
        </div>
        <ul role="list" className="max-h-64 space-y-0.5 overflow-y-auto">
          {participants.map(participant => (
            <li
              key={`${participant.id}-${participant.isSelf ? 'self' : 'peer'}`}
              role="listitem"
              className="flex items-center gap-2 rounded-md px-1.5 py-1.5"
            >
              <PresenceAvatar participant={participant} size={24} />
              <span className="min-w-0 flex-1 truncate text-body text-foreground/90">
                {participant.name || t('presence.unknown', { defaultValue: '未知用户' })}
              </span>
              {participant.isSelf && (
                <span className="shrink-0 text-caption text-muted-foreground">
                  {t('presence.self', { defaultValue: '你' })}
                </span>
              )}
              {participant.type === 'agent' && !participant.isSelf && (
                <span className="shrink-0 rounded bg-type-agent/15 px-1 py-0.5 text-[10px] font-medium text-type-agent">
                  {t('presence.agent', { defaultValue: 'Agent' })}
                </span>
              )}
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}

const PresenceAvatar: React.FC<{
  participant: Participant
  title?: string
  size?: number
}> = ({ participant, title, size = 20 }) => {
  const isAgent = participant.type === 'agent'
  if (!isAgent && (participant.avatar || participant.name)) {
    return (
      <span title={title} className="inline-flex">
        <UserAvatar
          name={participant.name}
          seed={participant.id}
          avatarUrl={participant.avatar ?? undefined}
          size={size}
          className="border border-border/60"
        />
      </span>
    )
  }

  const initials = isAgent ? 'AI' : identityAvatarInitial(participant.name)
  const bg = isAgent
    ? 'hsl(var(--type-agent))'
    : (participant.color || identityAvatarColor(participant.id))

  return (
    <span
      className="relative flex items-center justify-center overflow-hidden rounded-full border border-border/60 text-[10px] font-bold text-white"
      style={{ width: size, height: size, backgroundColor: bg }}
      title={title}
    >
      {initials}
    </span>
  )
}
