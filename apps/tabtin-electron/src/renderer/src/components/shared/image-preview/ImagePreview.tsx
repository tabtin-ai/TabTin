import React, { useEffect, useState } from 'react'
import { AlertCircle, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from '@tabtin/smartsheet-ui/toast'
import { cn } from '@utils/cn'
import { createLogger } from '@/utils/logger'
import { ImageContextMenu } from './ImageContextMenu'
import { copyImageToClipboard } from './copyImageToClipboard'

const log = createLogger('ImagePreview')

export interface ImagePreviewSource {
  /** URL used exclusively to render the image. */
  displayUrl: string
  mimeType?: string
  /** Optional byte loader for authenticated or refreshable image sources. */
  loadBytes?: () => Promise<ArrayBuffer>
}

export interface ImagePreviewProps {
  source: ImagePreviewSource
  alt: string
  viewport: 'embedded' | 'scrollable' | 'lightbox'
  className?: string
  imageClassName?: string
  imageStyle?: React.CSSProperties
  isLoading?: boolean
  onClick?: React.MouseEventHandler<HTMLImageElement>
  onPointerDown?: React.PointerEventHandler<HTMLImageElement>
  onPointerMove?: React.PointerEventHandler<HTMLImageElement>
  onPointerUp?: React.PointerEventHandler<HTMLImageElement>
  onPointerCancel?: React.PointerEventHandler<HTMLImageElement>
}

export const ImagePreview: React.FC<ImagePreviewProps> = ({
  source,
  alt,
  viewport,
  className,
  imageClassName,
  imageStyle,
  isLoading = false,
  onClick,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
}) => {
  const { t } = useTranslation('common')
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    setFailed(false)
    setMenu(null)
  }, [source.displayUrl])

  const image = failed ? (
    <div role="status" className="flex flex-col items-center justify-center gap-2 text-muted-foreground/60">
      <AlertCircle className="h-6 w-6" />
      <span className="text-body">{t('imagePreview.loadFailed', { defaultValue: '图片加载失败' })}</span>
    </div>
  ) : (
    <img
      src={source.displayUrl}
      alt={alt}
      className={imageClassName}
      style={imageStyle}
      draggable={false}
      onClick={onClick}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLoad={() => setFailed(false)}
      onError={() => setFailed(true)}
      onContextMenu={(event) => {
        event.preventDefault()
        event.stopPropagation()
        setMenu({ x: event.clientX, y: event.clientY })
      }}
    />
  )

  const handleCopy = () => {
    void copyImageToClipboard(source)
      .then(() => toast.success(t('imagePreview.copySuccess', { defaultValue: '已复制图片' })))
      .catch((error) => {
        log.warn('image copy failed', {
          protocol: source.displayUrl.split(':', 1)[0] || 'unknown',
          reason: error instanceof Error ? error.message : String(error),
        })
        toast.error(t('imagePreview.copyFailed', { defaultValue: '复制图片失败' }))
      })
  }

  const content = isLoading && !failed
    ? <Loader2 className="h-6 w-6 animate-spin text-muted-foreground/60" />
    : image
  const containerClassName = cn(
    'relative flex items-center justify-center',
    viewport === 'embedded' && 'h-full w-full p-4',
    viewport === 'scrollable' && 'min-h-full min-w-full p-4',
    viewport === 'lightbox' && 'h-full w-full',
    className,
  )

  return (
    <div className={containerClassName}>
      {content}
      {menu && (
        <ImageContextMenu
          x={menu.x}
          y={menu.y}
          label={t('imagePreview.copy', { defaultValue: '复制图片' })}
          menuLabel={t('imagePreview.menu', { defaultValue: '图片菜单' })}
          onCopy={handleCopy}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  )
}
