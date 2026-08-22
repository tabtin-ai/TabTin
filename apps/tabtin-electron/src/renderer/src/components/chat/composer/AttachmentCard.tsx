import React, { useState, useCallback, useEffect } from 'react'
import { cn } from '@utils/cn'
import { FileText, Download, AlertCircle, Play } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from '@tabtin/smartsheet-ui'
import type { MessageAttachment } from '@tabtin/chat-client'
import { formatFileSize } from '../types'
// ：去掉 DocParse badge；保留 base 的 COMPOSER_TEXT_META 字号 token
import { IMAGE_PREVIEW, COMPOSER_TEXT_META } from '../registry/chatDesignTokens'
import { useResourcePreviewStore } from '../preview/useResourcePreviewStore'
import type { PreviewResource } from '../preview/types'
import { ChatIconTooltip } from '../panel/ChatIconTooltip'
import { useChatImageDragSource } from '@/utils/fileRefDrag'
import { inferPreviewableKind } from '../preview/inferPreviewableKind'
import { LazyChatImage } from '../LazyChatImage'

export { inferPreviewableKind }

interface AttachmentCardProps {
  attachment: MessageAttachment
  /** 所属消息 id；用于打开预览时聚合同回合资源 */
  messageId?: string
  /** 所属会话 id；用于从 store 取该会话消息列表 */
  sessionId?: string | null
}

export const AttachmentCard: React.FC<AttachmentCardProps> = ({ attachment, messageId, sessionId }) => {
  const { t } = useTranslation('chat')
  const isImage = attachment.type === 'image'
  const isVideo = attachment.type === 'video'
  const displayUrl = attachment.url || attachment.preview_url
  const fileId = attachment.file_id || null
  const previewKind = inferPreviewableKind(attachment.mime_type, attachment.filename)
    ?? (isImage ? 'image' : isVideo ? 'video' : null)
  const canOpenLightbox = !!previewKind && !!displayUrl
  // 图片/视频：有预览 URL 才可点；其它文件一律可点（不支持预览则 toast）
  const isClickable = (isImage || isVideo) ? canOpenLightbox : true

  const openPreview = useCallback(() => {
    if (!displayUrl || !previewKind) return
    const previewStore = useResourcePreviewStore.getState()
    if (messageId && sessionId
        && previewStore.openFromMessage(sessionId, messageId, { url: displayUrl })) {
      return
    }
    // Fallback：消息不在缓存或无上下文时单项预览
    previewStore.open([{
      id: `att:${attachment.file_id || displayUrl}`,
      kind: previewKind,
      url: displayUrl,
      name: attachment.filename,
      mimeType: attachment.mime_type,
      size: attachment.size,
      sourceMessageId: messageId,
      fileId: attachment.file_id,
    } as PreviewResource], 0)
  }, [attachment.file_id, attachment.filename, attachment.mime_type, attachment.size, displayUrl, messageId, previewKind, sessionId])

  const handleClick = useCallback(() => {
    if (canOpenLightbox) {
      openPreview()
      return
    }
    toast({
      title: t('preview.typeUnsupported', {
        defaultValue: '暂不支持预览此类型文件',
      }),
    })
  }, [canOpenLightbox, openPreview, t])

  const [imgError, setImgError] = useState(false)
  const [videoError, setVideoError] = useState(false)

  useEffect(() => {
    setImgError(false)
    setVideoError(false)
  }, [displayUrl])

  const imageDrag = useChatImageDragSource({
    fileId,
    url: displayUrl,
    name: attachment.filename,
    mimeType: attachment.mime_type,
    size: attachment.size,
  })

  if (isImage && displayUrl && !imgError) {
    return (
      <LazyChatImage
        src={displayUrl}
        alt={attachment.filename}
        fileId={fileId ?? undefined}
        mimeType={attachment.mime_type}
        onClick={openPreview}
        draggable={imageDrag.draggable}
        onDragStart={imageDrag.onDragStart}
        onError={() => setImgError(true)}
        buttonClassName="cursor-zoom-in rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        buttonAriaLabel={t('preview.openImageShort', { defaultValue: '查看图片' })}
        buttonTitle={attachment.filename}
        imgClassName={cn(IMAGE_PREVIEW.img, 'rounded-lg border border-border/30 hover:opacity-90')}
        loadingTestId="attachment-image-loading-placeholder"
      />
    )
  }

  if (isVideo && displayUrl && !videoError) {
    return (
      <button
        type="button"
        onClick={openPreview}
        className="group relative cursor-zoom-in overflow-hidden rounded-lg border border-border/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 hover:opacity-90"
        aria-label={t('preview.openVideoShort', { defaultValue: '查看视频' })}
        title={attachment.filename}
      >
        <video
          src={displayUrl}
          muted
          playsInline
          preload="metadata"
          className={cn(IMAGE_PREVIEW.img, 'block bg-muted/20')}
          onError={() => setVideoError(true)}
        />
        <span
          className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/20"
          aria-hidden
        >
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-black/55 text-white">
            <Play className="h-4 w-4 fill-current translate-x-0.5" />
          </span>
        </span>
      </button>
    )
  }

  if ((isImage && imgError) || (isVideo && videoError)) {
    return (
      <div className={cn('flex items-center gap-2 rounded-lg border border-border/30 bg-muted/10 px-3 py-2 text-body', IMAGE_PREVIEW.maxWClass)}>
        <AlertCircle className="h-5 w-5 text-muted-foreground/60 flex-shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium text-foreground">{attachment.filename}</div>
          <div className={COMPOSER_TEXT_META}>
            {isVideo
              ? t('attachment.videoLoadFailed', { defaultValue: '视频加载失败' })
              : t('attachment.imageLoadFailed', { defaultValue: '图片加载失败' })}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-lg border border-border/30 bg-muted/10 px-3 py-2 text-body',
        isClickable && 'cursor-pointer hover:bg-muted/20 transition-colors',
      )}
      onClick={isClickable ? handleClick : undefined}
      role={isClickable ? 'button' : undefined}
      tabIndex={isClickable ? 0 : undefined}
      onKeyDown={isClickable ? (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          handleClick()
        }
      } : undefined}
    >
      <FileText className="h-5 w-5 text-muted-foreground/60 flex-shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium text-foreground">{attachment.filename}</div>
        <div className={cn('flex items-center gap-1.5', COMPOSER_TEXT_META)}>
          <span>{formatFileSize(attachment.size)}</span>
        </div>
      </div>
      {displayUrl && (
        <ChatIconTooltip content={t('input.download')}>
          <a
            href={displayUrl}
            download={attachment.filename}
            rel="noopener noreferrer"
            className="text-muted-foreground hover:text-foreground transition-colors"
            onClick={(e) => e.stopPropagation()}
            aria-label={t('input.download')}
          >
            <Download className="h-3.5 w-3.5" />
          </a>
        </ChatIconTooltip>
      )}
    </div>
  )
}
