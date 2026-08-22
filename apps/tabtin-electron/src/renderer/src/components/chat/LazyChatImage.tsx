/**
 * LazyChatImage — 对话内图片网络加载占位（AttachmentCard / ImageBlockView 等共用）。
 *
 * 与 RichImage 同气质：柔和灰底 + opacity 淡入，固定 IMAGE_PREVIEW 最小框避免布局跳变。
 *
 * resolving / http→blob 换源时保留已有 <img> 帧，避免拆掉图片只剩占位造成「内容狂闪」。
 */

import React, { useEffect, useRef, useState } from 'react'
import { cn } from '@utils/cn'
import { IMAGE_PREVIEW } from './registry/chatDesignTokens'
import { useCachedChatMediaSrc } from './preview/useCachedChatMediaSrc'

export interface LazyChatImageProps {
  src: string
  alt: string
  fileId?: string
  mimeType?: string
  className?: string
  style?: React.CSSProperties
  imgClassName?: string
  imgStyle?: React.CSSProperties
  loadingTestId?: string
  onClick?: () => void
  draggable?: boolean
  onDragStart?: React.DragEventHandler<HTMLButtonElement>
  onLoad?: () => void
  onError?: () => void
  /** button 模式下的额外属性（aria-label 等） */
  buttonClassName?: string
  buttonAriaLabel?: string
  buttonTitle?: string
}

export const LazyChatImage: React.FC<LazyChatImageProps> = ({
  src,
  alt,
  fileId,
  mimeType,
  className,
  style,
  imgClassName,
  imgStyle,
  loadingTestId = 'chat-image-loading-placeholder',
  onClick,
  draggable,
  onDragStart,
  onLoad,
  onError,
  buttonClassName,
  buttonAriaLabel,
  buttonTitle,
}) => {
  const { displaySrc, resolving, failed } = useCachedChatMediaSrc({
    url: src,
    fileId,
    mimeType,
  })
  // LRU 已给出 blob/data 时直接可见，避免切会话 remount 再 opacity 0→1 闪一次
  const [imgLoading, setImgLoading] = useState(() => {
    if (failed) return false
    if (!resolving && (displaySrc.startsWith('blob:') || displaySrc.startsWith('data:'))) {
      return false
    }
    return true
  })
  const loadedSrcRef = useRef<string | null>(
    !resolving && (displaySrc.startsWith('blob:') || displaySrc.startsWith('data:'))
      ? displaySrc
      : null,
  )

  useEffect(() => {
    if (failed) {
      setImgLoading(false)
      return
    }
    // 已有成功帧时：后台 resolving / http→blob 换源不重新撑占位（切会话闪动主因）
    if (loadedSrcRef.current) {
      setImgLoading(false)
      return
    }
    if (resolving) return
    if (loadedSrcRef.current === displaySrc) {
      setImgLoading(false)
      return
    }
    setImgLoading(true)
  }, [displaySrc, failed, resolving])

  const showPlaceholder = !failed && (resolving || imgLoading) && !loadedSrcRef.current

  const frameStyle: React.CSSProperties | undefined = showPlaceholder
    ? {
        minHeight: IMAGE_PREVIEW.maxH,
        minWidth: Math.min(120, IMAGE_PREVIEW.maxW),
        ...style,
      }
    : style

  const imageNode = (
    <>
      {showPlaceholder && (
        <div
          data-testid={loadingTestId}
          className="absolute inset-0 bg-muted/20"
          aria-hidden
        />
      )}
      <img
        src={displaySrc}
        alt={alt}
        draggable={false}
        loading="lazy"
        className={cn(
          imgClassName,
          'transition-opacity duration-300',
          showPlaceholder ? 'opacity-0' : 'opacity-100',
        )}
        style={imgStyle}
        onLoad={() => {
          loadedSrcRef.current = displaySrc
          setImgLoading(false)
          onLoad?.()
        }}
        onError={() => {
          // 换源失败时若仍有旧成功帧，保持不闪；首帧失败才抬错误
          if (!loadedSrcRef.current) {
            setImgLoading(false)
            onError?.()
          }
        }}
      />
    </>
  )

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        draggable={draggable}
        onDragStart={onDragStart}
        className={cn(
          'group relative block overflow-hidden',
          showPlaceholder && 'bg-muted/20',
          buttonClassName,
          className,
        )}
        style={frameStyle}
        aria-label={buttonAriaLabel}
        title={buttonTitle}
      >
        {imageNode}
      </button>
    )
  }

  return (
    <div
      className={cn(
        'group relative overflow-hidden',
        showPlaceholder && 'bg-muted/20',
        className,
      )}
      style={frameStyle}
    >
      {imageNode}
    </div>
  )
}
