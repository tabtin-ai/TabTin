import React, { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Image, MessageSquare, X } from 'lucide-react'
import { toast } from '@tabtin/smartsheet-ui'
import type { IMMessage } from '@/services/tabchatApi'
import { MESSAGE_TYPE_IMAGE } from '@/constants/tabchat'
import { useFileAttachmentStore } from '@stores/useFileAttachmentStore'
import { messageStableKey } from '@/services/im/messageMerge'
import { sanitizeUrl } from '@/lib/sanitizeUrl'
import { copyImageToClipboard } from '@components/chat/preview/copyImageToClipboard'
import { ImImageContextMenu } from './ImImageContextMenu'
import { openImImagePreview } from './openImImagePreview'
import { createLogger } from '@/utils/logger'
import { cn } from '@utils/cn'
import { IM_CHAT_BODY_TEXT, IM_CHAT_HEADER_TITLE } from './tabchatUi'

const log = createLogger('ReplyThreadPanel')

interface Props {
  root: IMMessage | null
  replies: IMMessage[]
  isOpen: boolean
  onClose: () => void
}

function messagePreview(message: IMMessage, t: (key: string) => string): string {
  if (message.is_deleted) return t('replyThread.messageUnavailable')
  if (message.message_type === MESSAGE_TYPE_IMAGE) return message.content.trim() || t('imageMessage')
  return message.content.trim() || t('replyThread.messageUnavailable')
}

function ThreadMessage({ message, imageUrl, isRoot = false }: { message: IMMessage; imageUrl?: string; isRoot?: boolean }) {
  const { t } = useTranslation('tabchat')
  const [imageFailed, setImageFailed] = useState(false)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)

  const handleCopyImage = useCallback(() => {
    if (!imageUrl) return
    void copyImageToClipboard({
      url: imageUrl,
      fileId: message.metadata?.file_id,
    })
      .then(() => {
        toast.success(t('copyImageSuccess', { defaultValue: '已复制图片' }))
      })
      .catch((error) => {
        log.warn('copy image failed', {
          messageId: message.id,
          reason: error instanceof Error ? error.message : String(error),
        })
        toast.error(t('copyImageFailed', { defaultValue: '复制图片失败' }))
      })
  }, [imageUrl, message.id, message.metadata?.file_id, t])

  return (
    <article className={isRoot ? 'border-b border-border/60 px-5 py-4' : 'px-5 py-4'}>
      <div className="mb-1 flex items-center gap-2 text-caption text-muted-foreground">
        <span className="font-medium text-foreground">{message.sender_name || message.sender_id}</span>
        {message.created_at && <time>{new Date(message.created_at).toLocaleString()}</time>}
      </div>
      {message.message_type === MESSAGE_TYPE_IMAGE && imageUrl && !imageFailed ? (
        <>
          <button
            type="button"
            onClick={() => openImImagePreview(message, imageUrl)}
            onContextMenu={(e) => {
              e.preventDefault()
              e.stopPropagation()
              setContextMenu({ x: e.clientX, y: e.clientY })
            }}
            className="max-w-full rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={t('replyThread.openImage')}
          >
            <img
              src={imageUrl}
              alt={message.metadata?.file_name || t('imageMessage')}
              className="max-h-72 max-w-full rounded-md object-contain"
              loading="lazy"
              onError={() => setImageFailed(true)}
            />
          </button>
          {message.content.trim() && (
            <div className={cn('mt-2 whitespace-pre-wrap break-words', IM_CHAT_BODY_TEXT)}>
              {message.content}
            </div>
          )}
          {contextMenu && (
            <ImImageContextMenu
              x={contextMenu.x}
              y={contextMenu.y}
              onCopy={handleCopyImage}
              onClose={() => setContextMenu(null)}
            />
          )}
        </>
      ) : (
        <div className={cn('whitespace-pre-wrap break-words', IM_CHAT_BODY_TEXT)}>
          {message.message_type === MESSAGE_TYPE_IMAGE && <Image className="mr-1 inline h-4 w-4 text-muted-foreground" aria-hidden="true" />}
          {messagePreview(message, t)}
        </div>
      )}
    </article>
  )
}

/** 回复详情首期只读：用户在主消息流发起回复，侧栏只用于连续阅读上下文。 */
export const ReplyThreadPanel: React.FC<Props> = ({ root, replies, isOpen, onClose }) => {
  const { t } = useTranslation('tabchat')
  const statuses = useFileAttachmentStore((state) => state.statuses)
  const ensureChecked = useFileAttachmentStore((state) => state.ensureChecked)

  useEffect(() => {
    if (!isOpen) return
    ensureChecked((root ? [root, ...replies] : replies).filter(message => message.message_type === MESSAGE_TYPE_IMAGE))
  }, [ensureChecked, isOpen, replies, root])

  if (!isOpen || !root) return null

  const imageUrlFor = (message: IMMessage): string | undefined => {
    if (message.is_deleted || message.message_type !== MESSAGE_TYPE_IMAGE) return undefined
    const status = statuses[messageStableKey(message)]
    return status?.status === 'available'
      ? sanitizeUrl(status.downloadUrl || message.metadata?.access_url) || undefined
      : undefined
  }

  return (
  <div className={`absolute inset-0 z-overlay ${isOpen ? '' : 'pointer-events-none'}`} aria-hidden={!isOpen}>
    <button
      type="button"
      className={`absolute inset-0 bg-black/10 transition-opacity ${isOpen ? 'opacity-100' : 'opacity-0'}`}
      aria-label={t('replyThread.close')}
      tabIndex={isOpen ? 0 : -1}
      onClick={onClose}
    />
    <aside
      className={`absolute right-0 top-0 flex h-full w-80 flex-col border-l border-border/60 bg-background transition-[transform,box-shadow] duration-300 ease-out ${
        isOpen ? 'translate-x-0 shadow-xl' : 'translate-x-full shadow-none'
      }`}
      aria-label={t('replyThread.title')}
    >
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-border/60 px-5">
        <div className={cn('flex items-center gap-2', IM_CHAT_HEADER_TITLE)}>
          <MessageSquare className="h-4 w-4 text-primary" aria-hidden="true" />
          {t('replyThread.title')}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={t('replyThread.close')}
        >
          <X className="h-5 w-5" />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {root && <ThreadMessage message={root} imageUrl={imageUrlFor(root)} isRoot />}
        {replies.length > 0 ? replies.map(message => <ThreadMessage key={messageStableKey(message)} message={message} imageUrl={imageUrlFor(message)} />) : (
          <p className={cn('px-5 py-4 text-muted-foreground', IM_CHAT_BODY_TEXT)}>{t('replyThread.empty')}</p>
        )}
      </div>
    </aside>
  </div>
  )
}
