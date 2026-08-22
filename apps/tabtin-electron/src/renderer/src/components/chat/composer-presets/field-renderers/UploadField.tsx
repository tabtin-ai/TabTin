import React, { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { registerFieldRenderer } from '../registry/fieldRenderers'
import type { FieldRendererProps } from '../registry/types'
import { COMPOSER_TEXT_META_BASE, TEXT, BORDER, TEXT_COLOR, CARD_RADIUS } from '../../registry/chatDesignTokens'
import { isFileTooLarge, isImageType, isMediaType, formatFileSize, FILE_LIMITS } from '../../types'

const UploadFieldRenderer: React.FC<FieldRendererProps> = ({
  field,
  error,
  disabled,
  slotAttachments,
  onAddSlotAttachment,
  onRemoveSlotAttachment,
}) => {
  const { t } = useTranslation('composerPreset')
  const inputRef = useRef<HTMLInputElement>(null)
  const [sizeError, setSizeError] = useState<string | null>(null)
  const accept = (field.config?.accept as string) ?? 'image/*'
  const maxCount = (field.config?.maxCount as number) ?? 1
  const attachments = slotAttachments ?? []
  const canAddMore = attachments.length < maxCount

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    setSizeError(null)
    if (file && onAddSlotAttachment) {
      if (isFileTooLarge(file)) {
        const maxSize = isImageType(file.type) ? FILE_LIMITS.MAX_IMAGE_SIZE : isMediaType(file.type) ? FILE_LIMITS.MAX_MEDIA_SIZE : FILE_LIMITS.MAX_FILE_SIZE
        console.warn(`[UploadField] File too large: ${file.name} (${formatFileSize(file.size)}, max ${formatFileSize(maxSize)})`)
        setSizeError(t('upload.fileTooLarge'))
        return
      }
      onAddSlotAttachment(file)
    }
    if (inputRef.current) inputRef.current.value = ''
  }

  return (
    <div className="flex flex-col gap-1">
      {field.label && (
        <label className={`${TEXT.label} ${TEXT_COLOR.secondary}`}>
          {field.label}
          {field.required && <span className={TEXT_COLOR.error}> *</span>}
        </label>
      )}

      {attachments.length > 0 && (
        <div className="flex flex-col gap-1">
          {attachments.map(att => (
            <div key={att.id} className={`${CARD_RADIUS} ${BORDER.default} flex min-w-0 items-center gap-2 border p-2`}>
              {att.previewUrl ? (
                <img
                  src={att.previewUrl}
                  alt={att.filename}
                  className="h-12 w-12 rounded object-cover"
                />
              ) : (
                <div className="flex h-12 w-12 items-center justify-center rounded bg-muted/20">
                  <span className={`${COMPOSER_TEXT_META_BASE} ${TEXT_COLOR.muted}`}>FILE</span>
                </div>
              )}
              <div className="min-w-0 flex-1 truncate">
                <div className={`${COMPOSER_TEXT_META_BASE} ${TEXT_COLOR.primary} truncate`}>
                  {att.filename}
                </div>
              </div>
              <button
                type="button"
                className={`${COMPOSER_TEXT_META_BASE} text-muted-foreground/60 hover:text-destructive transition-colors`}
                onClick={() => onRemoveSlotAttachment?.(att.id)}
                disabled={disabled}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      {canAddMore && (
        <button
          type="button"
          className={`${CARD_RADIUS} ${BORDER.default} flex h-16 items-center justify-center border border-dashed transition-colors hover:bg-muted/10`}
          onClick={() => {
            setSizeError(null)
            inputRef.current?.click()
          }}
          disabled={disabled}
        >
          <span className={`${COMPOSER_TEXT_META_BASE} ${TEXT_COLOR.muted}`}>
            + {attachments.length > 0 ? t('upload.addMore', '添加') : (field.placeholder ?? t('upload.clickToUpload'))}
          </span>
        </button>
      )}

      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="hidden"
        onChange={handleFileChange}
        disabled={disabled}
      />
      {(sizeError || error) && (
        <span className={`${COMPOSER_TEXT_META_BASE} ${TEXT_COLOR.error}`}>{sizeError ?? error}</span>
      )}
    </div>
  )
}

registerFieldRenderer('upload', UploadFieldRenderer)
