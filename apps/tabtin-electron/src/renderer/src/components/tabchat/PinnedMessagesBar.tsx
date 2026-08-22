/**
 * PinnedMessagesBar — 聊天区顶部置顶消息条（功能3）。
 *
 * 显示最近一条置顶消息；多条时可展开列表。点击条目跳转到该消息；
 * 有管理权限（群主/管理员，私聊任意成员）时可取消置顶。
 */

import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Pin, X, ChevronDown } from 'lucide-react'
import { toast } from '@tabtin/smartsheet-ui'
import { useIMStore } from '@stores/useIMStore'
import { unpinMessage, type IMMessage } from '@/services/tabchatApi'
import { MESSAGE_TYPE_FILE, MESSAGE_TYPE_IMAGE } from '@/constants/tabchat'

interface Props {
  conversationId: string
  canManage: boolean
}

function pinnedPreview(message: IMMessage, t: (key: string, opts?: Record<string, unknown>) => string): string {
  if (message.message_type === MESSAGE_TYPE_IMAGE) return t('imageMessage', { defaultValue: '[图片]' })
  if (message.message_type === MESSAGE_TYPE_FILE) {
    return message.metadata?.file_name || t('fileMessage', { defaultValue: '[文件]' })
  }
  const card = message.metadata?.card
  if (card?.type === 'contact') return `[${t('contactCard', { defaultValue: '名片' })}] ${card.name ?? ''}`.trim()
  if (card?.type === 'table' || card?.type === 'document' || card?.type === 'space' || card?.type === 'agent_space') {
    return card.name || t('resourceCard', { defaultValue: '[资源]' })
  }
  return message.content || ''
}

export const PinnedMessagesBar: React.FC<Props> = ({ conversationId, canManage }) => {
  const { t } = useTranslation('tabchat')
  const pinned = useIMStore((s) => s.pinnedMessages?.[conversationId])
  const [expanded, setExpanded] = useState(false)
  const [unpinningMessageId, setUnpinningMessageId] = useState<number | null>(null)

  if (!pinned || pinned.length === 0) return null

  const latest = pinned[0]
  const count = pinned.length

  const handleJump = (message: IMMessage) => {
    setExpanded(false)
    useIMStore.getState().navigateToMessage(conversationId, message)
  }

  const handleUnpin = async (e: React.MouseEvent, message: IMMessage) => {
    e.stopPropagation()
    const messageId = message.id
    if (unpinningMessageId !== null) return
    setUnpinningMessageId(messageId)
    try {
      await unpinMessage(conversationId, message)
      useIMStore.getState().onMessageUnpinned(conversationId, messageId)
    } catch (err) {
      console.error('[TabChat] Failed to unpin message:', err)
      toast({ title: t('unpinFailed', { defaultValue: '取消置顶失败' }), variant: 'destructive' })
      void useIMStore.getState().loadPinnedMessages(conversationId)
    } finally {
      setUnpinningMessageId(null)
    }
  }

  return (
    <div className="flex-shrink-0 border-b border-accent/10 bg-[hsl(var(--accent)/0.04)]">
      {/* 顶条：图标 + 最近一条置顶预览 + 计数/展开 */}
      <button
        type="button"
        onClick={() => (count > 1 ? setExpanded((v) => !v) : handleJump(latest))}
        className="flex w-full items-center gap-2 px-4 py-1.5 text-left hover:bg-accent/5 transition-colors"
      >
        <Pin className="h-3.5 w-3.5 flex-shrink-0 text-accent" />
        <div className="min-w-0 flex-1 flex items-center gap-1.5 text-caption">
          <span className="flex-shrink-0 font-medium text-accent">
            {t('pinnedMessages', { defaultValue: '置顶' })}
          </span>
          <span className="truncate text-muted-foreground">
            {latest.sender_name ? `${latest.sender_name}: ` : ''}{pinnedPreview(latest, t)}
          </span>
        </div>
        {count > 1 && (
          <span className="flex-shrink-0 flex items-center gap-0.5 text-caption text-muted-foreground/80">
            {count}
            <ChevronDown className={`h-3.5 w-3.5 transition-transform ${expanded ? 'rotate-180' : ''}`} />
          </span>
        )}
        {count === 1 && canManage && (
          <span
            role="button"
            tabIndex={0}
            aria-disabled={unpinningMessageId === latest.id}
            onClick={(e) => handleUnpin(e, latest)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleUnpin(e as unknown as React.MouseEvent, latest) }}
            className="flex-shrink-0 h-5 w-5 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors aria-disabled:pointer-events-none aria-disabled:opacity-40"
            title={t('unpin', { defaultValue: '取消置顶' })}
          >
            <X className="h-3.5 w-3.5" />
          </span>
        )}
      </button>

      {/* 展开列表（多条置顶） */}
      {expanded && count > 1 && (
        <div className="max-h-48 overflow-y-auto border-t border-accent/10">
          {pinned.map((m) => (
            <div
              key={m.id}
              className="group flex items-center gap-2 px-4 py-1.5 hover:bg-accent/5 transition-colors cursor-pointer"
              onClick={() => handleJump(m)}
            >
              <Pin className="h-3 w-3 flex-shrink-0 text-accent/60" />
              <div className="min-w-0 flex-1 flex items-center gap-1.5 text-caption">
                <span className="flex-shrink-0 font-medium text-foreground/80">
                  {m.sender_name || m.sender_id.slice(0, 8)}
                </span>
                <span className="truncate text-muted-foreground">{pinnedPreview(m, t)}</span>
              </div>
              {canManage && (
                <button
                  type="button"
                  onClick={(e) => handleUnpin(e, m)}
                  className="flex-shrink-0 h-5 w-5 flex items-center justify-center rounded text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground hover:bg-muted/60 transition-all"
                  title={t('unpin', { defaultValue: '取消置顶' })}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
