/**
 * ConversationReferenceCard — 「引用对话」摘要卡
 *
 * - 消息气泡阅读态：替换原始 XML；可点击打开源对话
 * - 输入框附件态：粘贴引用后展示，可移除
 */

import React from 'react'
import { MessageSquareText, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@utils/cn'
import type { ConversationReferenceDisplay } from '@utils/chat/conversationReference'

export interface ConversationReferenceCardProps {
  reference: ConversationReferenceDisplay
  align?: 'left' | 'right'
  onOpen?: (reference: ConversationReferenceDisplay) => void
  /** 输入框附件态：显示移除按钮 */
  onRemove?: () => void
}

function canOpenConversationReference(
  reference: ConversationReferenceDisplay,
  onOpen?: ConversationReferenceCardProps['onOpen'],
): boolean {
  if (!onOpen) return false
  // 有 spaceId+sessionId 可跳转源会话；或有 title/preview（交接场景）可弹窗查看
  return Boolean(
    (reference.spaceId?.trim() && reference.sessionId?.trim())
    || reference.title?.trim()
    || reference.preview?.trim(),
  )
}

function buildMetaLine(
  reference: ConversationReferenceDisplay,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const parts: string[] = []
  if (typeof reference.messageCount === 'number') {
    parts.push(t('session.conversationReference.messageCount', {
      count: reference.messageCount,
      defaultValue: '{{count}} 条消息',
    }))
  }
  if (reference.lastActivityLabel) {
    parts.push(reference.lastActivityLabel)
  }
  return parts.join(' · ')
}

export const ConversationReferenceCard: React.FC<ConversationReferenceCardProps> = ({
  reference,
  align = 'right',
  onOpen,
  onRemove,
}) => {
  const { t } = useTranslation('chat')
  const title = reference.title?.trim()
    || t('session.conversationReference.untitled', { defaultValue: '未命名对话' })
  const meta = buildMetaLine(reference, t)
  const preview = reference.preview?.trim()
  const canOpen = canOpenConversationReference(reference, onOpen)

  return (
    <div
      data-testid="conversation-reference-card"
      className={cn(
        'relative w-fit max-w-[320px] rounded-2xl border border-primary/30 bg-primary/5 text-left',
        align === 'left' ? 'mr-auto rounded-bl-md' : 'ml-auto rounded-br-md',
      )}
    >
      {onRemove ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
          className="absolute right-1.5 top-1.5 z-sticky flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground/60 hover:bg-foreground/5 hover:text-foreground"
          aria-label={t('session.conversationReference.remove', { defaultValue: '移除引用' })}
        >
          <X className="h-3 w-3" />
        </button>
      ) : null}
      <button
        type="button"
        disabled={!canOpen}
        onClick={(e) => {
          e.stopPropagation()
          onOpen?.(reference)
        }}
        className={cn(
          'w-full px-3.5 py-2.5 text-left transition-colors',
          canOpen && 'cursor-pointer hover:bg-primary/10',
          !canOpen && 'cursor-default',
          onRemove && 'pr-8',
        )}
      >
        <div className="flex items-start gap-2">
          <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
            <MessageSquareText className="h-3.5 w-3.5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-caption text-muted-foreground/80">
              {t('session.conversationReference.label', { defaultValue: '引用对话' })}
            </div>
            <div className="truncate text-body font-medium text-foreground">
              {title}
            </div>
            {meta ? (
              <div className="mt-0.5 text-caption text-muted-foreground/60">
                {meta}
              </div>
            ) : null}
            {preview ? (
              <div className="mt-1.5 line-clamp-2 border-t border-primary/20 pt-1.5 text-caption leading-relaxed text-foreground/80">
                {preview}
              </div>
            ) : null}
          </div>
        </div>
      </button>
    </div>
  )
}
