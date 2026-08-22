/**
 * ImageBlockView — v2 §3.5.1.f 多模态 block UI 处理。
 *
 * 处理 `image` + `document` 两类 block：
 *   - image: base64 / url / file_id 三种 source
 *   - document (PDF): 文档卡片（标题 + 页数 + 缩略图）
 *
 * UI：
 *   - 缩略图走 IMAGE_PREVIEW（对话内预览；点开放大不受限）
 *   - 点击预览（：接 useResourcePreviewStore，对齐 RichImage 的点击放大）
 *   - 悬停下载入口（：补齐 ImageBlockView 缺失的下载）
 *   - file_id source：通过 useFileIdImageUrl 解析真实 URL，不再 placeholder
 *   - 流式期间（极罕见）按 placeholder 显示
 *   - Phase2 Task6：loading/empty 用 IMAGE_PREVIEW 有界框（无 width/height 元数据）
 */

import React, { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FileText, Image as ImageIcon, Download, Loader2 } from 'lucide-react'
import type { ImageBlock, DocumentBlock } from '@tabtin/agent-wire'
import { cn } from '@utils/cn'
import {
  CARD_RADIUS,
  TEXT,
  TEXT_COLOR,
  BORDER,
  BG,
  ICON_SIZE,
  IMAGE_PREVIEW,
} from '../registry/chatDesignTokens'
import { useResourcePreviewStore } from '../preview/useResourcePreviewStore'
import { downloadPreviewResource } from '../preview/downloadPreviewResource'
import { useFileIdImageUrl } from './useFileIdImageUrl'
import { useChatImageDragSource } from '@/utils/fileRefDrag'
import { blockEntryEqual, type BlockRendererProps } from './types'
import { LazyChatImage } from '../LazyChatImage'

type ImageSrcResult =
  | { mode: 'url'; src: string; alt: string }
  | { mode: 'file_id'; fileId: string }
  | { mode: 'empty' }

/**
 * ImageBlock 无 width/height 元数据（agent-wire ImageBlock 仅 source）。
 * 占位/预览一律对齐 IMAGE_PREVIEW 上限；loading/empty 用稳定 min 预算，
 * ready 去掉 min 以免永久留白。禁止视口级 spacer。
 */
export function imageBlockFrameBudget(state: 'loading' | 'empty' | 'ready'): {
  maxWidth: number
  maxHeight: number
  minWidth: number
  minHeight: number
} {
  const maxWidth = IMAGE_PREVIEW.maxW
  const maxHeight = IMAGE_PREVIEW.maxH
  if (state === 'ready') {
    return { maxWidth, maxHeight, minWidth: 0, minHeight: 0 }
  }
  return {
    maxWidth,
    maxHeight,
    minWidth: maxWidth,
    minHeight: maxHeight,
  }
}

function imageBlockFrameStyle(state: 'loading' | 'empty' | 'ready'): React.CSSProperties {
  const budget = imageBlockFrameBudget(state)
  return {
    maxWidth: budget.maxWidth,
    maxHeight: budget.maxHeight,
    ...(budget.minWidth > 0 ? { minWidth: budget.minWidth } : {}),
    ...(budget.minHeight > 0 ? { minHeight: budget.minHeight } : {}),
  }
}

function resolveImageSrc(block: ImageBlock): ImageSrcResult {
  const source = block.source
  if (!source) return { mode: 'empty' }
  if (source.type === 'base64') {
    return { mode: 'url', src: `data:${source.media_type};base64,${source.data}`, alt: 'image' }
  }
  if (source.type === 'url') {
    return { mode: 'url', src: source.url, alt: 'image' }
  }
  if (source.type === 'file_id') {
    return { mode: 'file_id', fileId: source.file_id }
  }
  return { mode: 'empty' }
}

const ImageOnlyView: React.FC<{
  entry: BlockRendererProps['entry']
  sessionId: string | null
  messageId: string
}> = ({ entry, sessionId, messageId }) => {
  const { t } = useTranslation('chat')
  const block = entry.block as ImageBlock
  const result = resolveImageSrc(block)
  const [imgReady, setImgReady] = useState(false)

  // ：file_id source 解析真实 URL（base64 / url 不走此路径，fileId 传 null）。
  const fileId = result.mode === 'file_id' ? result.fileId : null
  const { data: fileIdData, loading: fileIdLoading } = useFileIdImageUrl(fileId)

  const src = result.mode === 'url' ? result.src : fileIdData?.url ?? ''

  // src 变化（含 file_id 解析完成）后重置，直到 <img> onload。
  useEffect(() => {
    setImgReady(false)
  }, [src])
  const name = fileIdData?.name ?? 'image'
  const previewFileId = result.mode === 'file_id' ? result.fileId : undefined

  const handlePreview = useCallback(() => {
    if (!src) return
    const store = useResourcePreviewStore.getState()
    // 优先聚合同回合资源（与 RichImage / AttachmentCard 一致）；命中失败再单项预览。
    // file_id 图片尚未进入回合资源聚合；直接单项打开，避免 URL 未命中时退化到同消息的其他资源。
    if (!previewFileId && sessionId && messageId && store.openFromMessage(sessionId, messageId, { url: src })) {
      return
    }
    store.open([{
      id: `block-image:${messageId}:${src}`,
      kind: 'image',
      url: src,
      name,
      sourceMessageId: messageId,
      fileId: previewFileId,
    }])
  }, [src, name, sessionId, messageId, previewFileId])

  // ：跨域 OSS 上 `<a download>` 无效；与 Lightbox 统一走主进程下载。
  const handleDownload = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (!src) return
      void downloadPreviewResource({
        url: src,
        fileName: name || 'image',
        t,
        fileId: previewFileId,
      })
    },
    [src, name, t, previewFileId],
  )

  const imageMime = result.mode === 'url' && block.source?.type === 'base64'
    ? block.source.media_type
    : fileIdData?.mimeType
  const imageDrag = useChatImageDragSource({
    fileId: previewFileId,
    url: src || null,
    name,
    mimeType: imageMime,
    size: fileIdData?.fileSize,
  })

  // file_id 解析中：IMAGE_PREVIEW 有界框占位（非一行 spinner），避免加载后撑开虚拟行。
  if (result.mode === 'file_id' && fileIdLoading) {
    return (
      <div
        className={cn(
          'my-1.5 inline-flex flex-col items-center justify-center gap-1.5 border',
          IMAGE_PREVIEW.frame,
          CARD_RADIUS,
          BORDER.subtle,
          BG.header,
          TEXT.body,
          TEXT_COLOR.muted,
        )}
        style={imageBlockFrameStyle('loading')}
        data-testid="block-image-loading"
      >
        <Loader2 className={cn(ICON_SIZE.md, 'flex-shrink-0 animate-spin')} />
        <span>{t('blockTimeline.image.loading', { defaultValue: '图片加载中…' })}</span>
      </div>
    )
  }

  if (!src) {
    return (
      <div
        className={cn(
          'my-1 inline-flex flex-col items-center justify-center gap-1.5 border',
          IMAGE_PREVIEW.frame,
          CARD_RADIUS,
          BORDER.subtle,
          BG.header,
          TEXT.body,
          TEXT_COLOR.muted,
        )}
        style={imageBlockFrameStyle('empty')}
        data-testid="block-image-placeholder"
      >
        <ImageIcon className={cn(ICON_SIZE.md, 'flex-shrink-0')} />
        <span>{t('blockTimeline.image.unavailable', { defaultValue: '图片暂不可用' })}</span>
        {result.mode === 'file_id' && (
          <span className={cn(TEXT.meta, TEXT_COLOR.faint)}>file:{result.fileId}</span>
        )}
      </div>
    )
  }

  const frameState = imgReady ? 'ready' : 'loading'

  return (
    <div
      className={cn('group relative my-1.5 inline-block overflow-hidden', IMAGE_PREVIEW.frame, CARD_RADIUS)}
      style={imageBlockFrameStyle(frameState)}
      data-testid="block-image"
    >
      <LazyChatImage
        src={src}
        alt={result.mode === 'url' ? result.alt : name}
        fileId={previewFileId}
        mimeType={imageMime}
        onClick={handlePreview}
        draggable={imageDrag.draggable}
        onDragStart={imageDrag.onDragStart}
        onLoad={() => setImgReady(true)}
        buttonClassName="cursor-zoom-in rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        buttonAriaLabel={t('preview.openImageShort', { defaultValue: '查看图片' })}
        imgClassName={cn(IMAGE_PREVIEW.img, 'rounded-lg border', BORDER.subtle)}
        loadingTestId="block-image-img-loading-placeholder"
      />
      <button
        type="button"
        data-testid="block-image-download"
        aria-label={t('preview.download', { defaultValue: '下载' })}
        className="absolute right-1.5 top-1.5 inline-flex h-6 w-6 items-center justify-center rounded-md bg-background/80 text-foreground/70 opacity-0 transition-opacity hover:bg-background hover:text-foreground group-hover:opacity-100"
        onClick={handleDownload}
      >
        <Download className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}
ImageOnlyView.displayName = 'ImageOnlyView'

const DocumentView: React.FC<{ entry: BlockRendererProps['entry'] }> = ({ entry }) => {
  const { t } = useTranslation('chat')
  const block = entry.block as DocumentBlock
  const title = block.title || t('blockTimeline.document.untitled', { defaultValue: '文档' })
  return (
    <div
      className={cn(
        'my-1 inline-flex items-center gap-2 max-w-full px-3 py-2 border',
        CARD_RADIUS,
        BORDER.subtle,
        BG.header,
      )}
      data-testid="block-document"
    >
      <FileText className={cn(ICON_SIZE.lg, 'text-accent/80 flex-shrink-0')} />
      <div className="min-w-0 flex flex-col">
        <span className={cn(TEXT.body, TEXT_COLOR.secondary, 'truncate')}>{title}</span>
        {block.context && (
          <span className={cn(TEXT.meta, TEXT_COLOR.faint, 'truncate')}>{block.context}</span>
        )}
      </div>
    </div>
  )
}
DocumentView.displayName = 'DocumentView'

export const ImageBlockView: React.FC<BlockRendererProps> = React.memo((props) => {
  const block = props.entry.block
  if (block.type === 'document') return <DocumentView entry={props.entry} />
  return <ImageOnlyView entry={props.entry} sessionId={props.sessionId} messageId={props.messageId} />
}, blockEntryEqual)
ImageBlockView.displayName = 'ImageBlockView'
