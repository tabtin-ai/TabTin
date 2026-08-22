/**
 * 重构来源：apps/tabtin-electron/src/renderer/src/components/chat/RichContentRenderer.tsx（行 166-241）
 * 拆分时间：2026-04-30
 * 重构原因：RichContentRenderer.tsx 1352 行单文件过大，按职责拆分
 * 职责：富图片 kind 渲染 —— 含加载态 / 错误态 / 放大预览 / preview store 集成。
 * 业务逻辑版本：与拆分前完全相同，只是 module 边界调整
 *
 * 加载态：与 ImageGeneratingCard 同气质——柔和灰底占位 + opacity 淡入，
 * 不用 Loader2 / sr-only（避免布局跳变）。
 */

import React, { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, ZoomIn } from 'lucide-react'
import type { RichContentBlock } from '@tabtin/chat-client'
import { cn } from '@utils/cn'
import { IMAGE_PREVIEW } from '../registry/chatDesignTokens'
import { useResourcePreviewStore } from '../preview/useResourcePreviewStore'
import type { PreviewResource } from '../preview/types'
import { RichFallback } from './RichFallback'
import { useChatImageDragSource } from '@/utils/fileRefDrag'
import { normalizeMediaImageUrl } from '../cards/parseMediaImageGenerateResult'
import { useFileIdImageUrl } from '../blocks/useFileIdImageUrl'

export const RichImage: React.FC<{
  block: RichContentBlock
  messageId?: string
  sessionId?: string | null
}> = React.memo(({ block, messageId, sessionId }) => {
  const { t } = useTranslation('chat')
  const [imgError, setImgError] = useState(false)
  const [imgLoading, setImgLoading] = useState(true)
  const artifact = block as RichContentBlock & {
    artifact_kind?: string
    file_id?: string
    filename?: string
    access_url?: string
    mime_type?: string
    file_size?: number
  }
  const fileId = artifact.artifact_kind === 'oss_file' && artifact.file_id
    ? artifact.file_id
    : null
  const { data: resolvedFile } = useFileIdImageUrl(fileId)
  // present_to_user / 落库可能残留字面量 \u0026，必须先还原才能加载
  // 正式 OSS 产物以 file_id 为稳定身份；签名 URL 只作首屏兜底，resolver 会在
  // 临期/过期时换取新地址。tabtin:// 仅用于产物导航，不能直接交给 <img>。
  const rawBlockUrl = typeof block.url === 'string' ? block.url : undefined
  const imageUrl = resolvedFile?.url
    ?? normalizeMediaImageUrl(artifact.access_url)
    ?? normalizeMediaImageUrl(rawBlockUrl)
    ?? (rawBlockUrl && !rawBlockUrl.startsWith('tabtin://') ? rawBlockUrl : undefined)
  const imageName = resolvedFile?.name
    ?? artifact.filename
    ?? block.alt_text
    ?? block.caption
    ?? block.summary
    ?? 'image'

  useEffect(() => {
    setImgError(false)
    setImgLoading(true)
  }, [imageUrl])

  const openPreview = useCallback(() => {
    if (!imageUrl) return
    const previewStore = useResourcePreviewStore.getState()
    if (!fileId && messageId && sessionId
        && previewStore.openFromMessage(sessionId, messageId, { url: imageUrl })) {
      return
    }
    previewStore.open([{
      id: `rich:${messageId ?? 'one'}:${imageUrl}`,
      kind: 'image',
      url: imageUrl,
      name: imageName,
      sourceMessageId: messageId,
      fileId: fileId ?? undefined,
    } as PreviewResource], 0)
  }, [fileId, imageName, imageUrl, messageId, sessionId])

  const imageDrag = useChatImageDragSource({
    fileId: fileId ?? undefined,
    url: imageUrl,
    name: imageName,
    mimeType: resolvedFile?.mimeType ?? artifact.mime_type,
    size: resolvedFile?.fileSize ?? artifact.file_size,
  })

  if (!imageUrl) {
    return <RichFallback block={block} />
  }

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        className={cn(
          'group relative self-start inline-flex overflow-hidden rounded-lg border border-border/40 cursor-zoom-in',
          IMAGE_PREVIEW.maxWClass,
          imgLoading && !imgError && 'bg-muted/20',
        )}
        style={
          imgLoading && !imgError
            ? {
                // 加载态固定 IMAGE_PREVIEW 高，避免 onload 后跳变
                minHeight: IMAGE_PREVIEW.maxH,
                minWidth: Math.min(120, IMAGE_PREVIEW.maxW),
              }
            : undefined
        }
        onClick={() => !imgError && openPreview()}
        draggable={imageDrag.draggable}
        onDragStart={imageDrag.onDragStart}
      >
        {imgError ? (
          <div className="flex flex-col items-center justify-center h-24 bg-muted/30 text-muted-foreground text-caption gap-1 px-4">
            <AlertCircle className="h-4 w-4" />
            <span>{t('richContent.imageLoadFailed')}</span>
            {block.summary && (
              <span className="text-muted-foreground/60 text-center">{block.summary}</span>
            )}
          </div>
        ) : (
          <>
            {imgLoading && (
              <div
                data-testid="rich-image-loading-placeholder"
                className="absolute inset-0 bg-muted/20"
                aria-hidden
              />
            )}
            <img
              src={imageUrl}
              alt={block.alt_text ?? block.summary}
              draggable={false}
              className={cn(
                IMAGE_PREVIEW.img,
                'transition-opacity duration-300',
                imgLoading ? 'opacity-0' : 'opacity-100',
              )}
              style={
                block.width || block.height
                  ? {
                      maxWidth: block.width
                        ? Math.min(block.width, IMAGE_PREVIEW.maxW)
                        : IMAGE_PREVIEW.maxW,
                      maxHeight: block.height
                        ? Math.min(block.height, IMAGE_PREVIEW.maxH)
                        : IMAGE_PREVIEW.maxH,
                    }
                  : undefined
              }
              onLoad={() => setImgLoading(false)}
              onError={() => {
                setImgError(true)
                setImgLoading(false)
              }}
            />
            {!imgLoading && (
              <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors flex items-center justify-center">
                <ZoomIn className="h-5 w-5 text-white opacity-0 group-hover:opacity-80 transition-opacity drop-shadow" />
              </div>
            )}
          </>
        )}
      </button>
      {block.caption && (
        <p className="text-caption text-muted-foreground/80">{block.caption}</p>
      )}
    </div>
  )
})
