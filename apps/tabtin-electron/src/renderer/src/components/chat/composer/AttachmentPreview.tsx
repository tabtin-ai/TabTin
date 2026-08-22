import React from 'react'
import { X, FileText } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@utils/cn'
import { COMPOSER_TEXT_META, COMPOSER_TEXT_META_BASE, COMPOSER_TEXT_MICRO } from '../registry/chatDesignTokens'
import { ChatIconTooltip } from '../panel/ChatIconTooltip'
import { useComposerAttachmentPreview } from './useComposerAttachmentPreview'
import type { ChatAttachment } from '../types'
import { formatFileSize } from '../types'

export const AttachmentPreview: React.FC<{
  attachment: ChatAttachment
  onRemove: (id: string) => void
}> = ({ attachment, onRemove }) => {
  const { t } = useTranslation('chat')
  const isImage = attachment.type === 'image'
  const { canPreview, handlePreview } = useComposerAttachmentPreview(attachment)

  return (
    <div className="group/att relative flex items-center gap-2 rounded-[12px] bg-muted/15 px-2.5 py-2 text-body">
      {isImage && attachment.previewUrl ? (
        <button
          type="button"
          onClick={handlePreview}
          className="h-10 w-10 overflow-hidden rounded-md border border-border/30 transition-colors hover:border-primary/60 focus:outline-none focus:ring-2 focus:ring-primary/30"
          aria-label={t('preview.openImage', { defaultValue: '查看图片' })}
        >
          <img
            src={attachment.previewUrl}
            alt={attachment.filename}
            className="h-full w-full object-cover"
          />
        </button>
      ) : (
        <div
          className={cn(
            'flex h-10 w-10 items-center justify-center rounded-md bg-muted/40',
            canPreview && 'cursor-pointer hover:bg-muted/60 transition-colors focus:outline-none focus:ring-2 focus:ring-primary/30',
          )}
          onClick={canPreview ? handlePreview : undefined}
          role={canPreview ? 'button' : undefined}
          tabIndex={canPreview ? 0 : undefined}
          aria-label={canPreview ? t('preview.openFile', { defaultValue: '预览文件' }) : undefined}
          onKeyDown={canPreview ? (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              handlePreview()
            }
          } : undefined}
        >
          <FileText className="h-5 w-5 text-muted-foreground" />
        </div>
      )}
      <button
        type="button"
        onClick={handlePreview}
        disabled={!canPreview}
        className={cn(
          'min-w-0 flex-1 text-left',
          canPreview && 'rounded-sm focus:outline-none focus:ring-2 focus:ring-primary/30',
          !canPreview && 'cursor-default',
        )}
      >
        <div className="truncate font-medium text-foreground">{attachment.filename}</div>
        <div className={COMPOSER_TEXT_META}>
          {attachment.status === 'uploading'
            ? t('input.uploadingProgress', {
                percent: Math.round((attachment.uploadProgress ?? 0) * 100),
                defaultValue: '上传中 {{percent}}%',
              })
            : formatFileSize(attachment.size)}
        </div>
      </button>
      {attachment.status === 'error' ? (
        <span className={cn(COMPOSER_TEXT_META_BASE, 'text-destructive')}>{attachment.error || t('input.uploadFailed')}</span>
      ) : null}
      <ChatIconTooltip content={t('input.remove')}>
        <button
          type="button"
          onClick={() => onRemove(attachment.id)}
          className="flex h-5 w-5 items-center justify-center rounded-full bg-muted/60 text-muted-foreground hover:bg-destructive/5 hover:text-destructive transition-colors"
          aria-label={t('input.remove')}
        >
          <X className="h-3 w-3" />
        </button>
      </ChatIconTooltip>
    </div>
  )
}
