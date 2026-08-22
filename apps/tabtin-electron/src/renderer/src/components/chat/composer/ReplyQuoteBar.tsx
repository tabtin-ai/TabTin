import React from 'react'
import { X, Reply } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@utils/cn'
import { COMPOSER_TEXT_META_BASE } from '../registry/chatDesignTokens'
import type { ReplyToPreview } from '@tabtin/chat-client'

/**
 *  引用回复：引用条。两处复用：
 *   - 消息气泡内只读展示；
 *   - composer 输入框上方（草稿态，可点 X 取消）—— 传 `onClose`。
 *
 * preview 与被引用消息同源，直接渲染快照，不依赖被引用消息是否仍在窗口内。
 */
export const ReplyQuoteBar: React.FC<{
  preview: ReplyToPreview
  /** 关闭引用（composer 草稿态用） */
  onClose?: () => void
  className?: string
}> = ({ preview, onClose, className }) => {
  const { t } = useTranslation('chat')

  const roleLabel = preview.role === 'assistant'
    ? t('reply.roleAssistant', { defaultValue: 'AI' })
    : preview.role === 'user'
      ? t('reply.roleUser', { defaultValue: '用户' })
      : preview.role
  const author = preview.author?.trim() || roleLabel

  return (
    <div
      className={cn(
        'flex items-start gap-1.5 rounded-md border-l-2 border-primary/60 bg-muted/40 px-2 py-1',
        COMPOSER_TEXT_META_BASE,
        className,
      )}
    >
      <Reply className="mt-0.5 h-3 w-3 shrink-0 text-primary/60" />
      <div className="min-w-0 flex-1">
        <div className="font-medium text-muted-foreground/90">{author}</div>
        <div className="truncate text-muted-foreground/60">{preview.text}</div>
      </div>
      {onClose && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onClose()
          }}
          className="shrink-0 rounded p-0.5 text-muted-foreground/60 hover:bg-muted hover:text-foreground transition-colors"
          aria-label={t('reply.cancel', { defaultValue: '取消引用' })}
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  )
}
