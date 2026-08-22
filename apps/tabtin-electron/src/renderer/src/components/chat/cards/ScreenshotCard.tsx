/**
 * ScreenshotCard — renders capture_screenshot tool output.
 *
 * Displays browser/desktop screenshots with IMAGE_PREVIEW thumbnail sizing,
 * lightbox zoom, and IPC fallback for loading local files when base64 is unavailable.
 */

import React, { useState, useCallback, useEffect, useLayoutEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Camera, ZoomIn } from 'lucide-react'
import { cn } from '@utils/cn'
import type { CardRendererProps } from '../registry/types'
import {
  CARD_RADIUS,
  CARD_HEADER_PADDING,
  TEXT,
  BORDER,
  BG,
  TEXT_COLOR,
  ICON_SIZE,
  ANIMATION,
  IMAGE_PREVIEW,
} from '../registry/chatDesignTokens'
import { registerCardRenderer } from '../registry/cardRenderers'
import { ErrorBanner, LoadingPlaceholder } from './primitives'
import { syncNativeViewOverlayCountFromDom } from '@/utils/native-view-overlays'

// ---------------------------------------------------------------------------
// Data shape — matches capture_screenshot tool output
// ---------------------------------------------------------------------------

interface CaptureScreenshotOutput {
  success?: boolean
  error?: string
  data?: ScreenshotPayload
}

interface ScreenshotPayload {
  path?: string
  width?: number
  height?: number
  format?: string
  sizeBytes?: number
  base64?: string
  base64_degraded?: boolean
  base64_format?: string
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function humanReadableSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// ---------------------------------------------------------------------------
// Inner display component
// ---------------------------------------------------------------------------

interface ScreenshotCardInnerProps {
  imageUrl: string
  width?: number
  height?: number
  format?: string
  sizeBytes?: number
  base64Degraded?: boolean
  filePath?: string
}

const ScreenshotCardInner: React.FC<ScreenshotCardInnerProps> = React.memo(
  ({ imageUrl, width, height, format, sizeBytes, base64Degraded, filePath }) => {
    const { t } = useTranslation('chat')
    const [isZoomed, setIsZoomed] = useState(false)
    const [imgError, setImgError] = useState(false)

    const openZoom = useCallback(() => setIsZoomed(true), [])
    const closeZoom = useCallback(() => setIsZoomed(false), [])

    useEffect(() => {
      if (!isZoomed) return
      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') closeZoom()
      }
      window.addEventListener('keydown', onKey)
      return () => window.removeEventListener('keydown', onKey)
    }, [isZoomed, closeZoom])

    useLayoutEffect(() => {
      if (!isZoomed || !imageUrl || imgError) return
      syncNativeViewOverlayCountFromDom(document)
      return () => {
        queueMicrotask(() => syncNativeViewOverlayCountFromDom(document))
      }
    }, [imageUrl, imgError, isZoomed])

    const metaLine = useMemo(() => {
      const parts: string[] = []
      if (width != null && height != null) parts.push(`${width}×${height}`)
      if (format) parts.push(format.toUpperCase())
      if (sizeBytes != null) parts.push(humanReadableSize(sizeBytes))
      return parts.join(' · ')
    }, [width, height, format, sizeBytes])

    const hasImage = imageUrl.length > 0

    return (
      <div className={'overflow-hidden'}>
        {/* ── Header ─────────────────────────────────────────────────── */}
        <div
          className={cn(
            'flex items-center gap-2',
            CARD_HEADER_PADDING.x,
            CARD_HEADER_PADDING.y,
            BG.header,
            'border-b',
            BORDER.subtle,
          )}
        >
          <Camera className={cn(ICON_SIZE.md, TEXT_COLOR.muted)} />
          <span className={cn(TEXT.header, TEXT_COLOR.secondary)}>
            {t('card.capture_screenshot', { defaultValue: '屏幕截图' })}
          </span>
          {metaLine && (
            <span className={cn(TEXT.meta, TEXT_COLOR.faint, 'ml-auto shrink-0 font-mono')}>
              {metaLine}
            </span>
          )}
        </div>

        {/* ── Screenshot preview ─────────────────────────────────────── */}
        <div className={cn('flex justify-center', BG.card, 'p-3')}>
          {!hasImage || imgError ? (
            <div
              className={cn(
                'flex flex-col items-center justify-center gap-1',
                IMAGE_PREVIEW.frame,
                'py-8',
                BG.header,
                CARD_RADIUS,
              )}
            >
              <span className={cn(TEXT.meta, TEXT_COLOR.faint)}>
                {t('card.image_load_failed', { defaultValue: '图片加载失败' })}
              </span>
              {filePath && (
                <span
                  className={cn(
                    TEXT.meta,
                    TEXT_COLOR.faint,
                    'font-mono break-all px-2 text-center',
                  )}
                >
                  {filePath}
                </span>
              )}
            </div>
          ) : (
            <button
              type="button"
              onClick={openZoom}
              className={cn(
                'relative group overflow-hidden cursor-zoom-in',
                IMAGE_PREVIEW.frame,
                CARD_RADIUS,
                'border',
                BORDER.subtle,
                'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60',
              )}
              aria-label={t('card.zoom_screenshot', { defaultValue: '点击放大截图' })}
            >
              <img
                src={imageUrl}
                alt={t('card.capture_screenshot', { defaultValue: '屏幕截图' })}
                className={IMAGE_PREVIEW.img}
                onError={() => setImgError(true)}
              />
              {base64Degraded && (
                <span
                  className={cn(
                    'absolute top-1.5 right-1.5',
                    'px-1.5 py-0.5 rounded',
                    'bg-black/50 text-white',
                    TEXT.meta,
                  )}
                >
                  {t('card.compressed', { defaultValue: '已压缩' })}
                </span>
              )}
              <div
                className={cn(
                  'absolute inset-0 flex items-center justify-center',
                  'opacity-0 group-hover:opacity-100',
                  ANIMATION.fadeIn,
                  'bg-black/30',
                )}
              >
                <ZoomIn className="h-5 w-5 text-white/90" />
              </div>
            </button>
          )}
        </div>

        {/* ── Zoom lightbox ──────────────────────────────────────────── */}
        {isZoomed && hasImage && !imgError && (
          <div
            className={cn(
              'fixed inset-0 flex items-center justify-center',
              'bg-black/80 cursor-zoom-out z-toast',
              ANIMATION.fadeIn,
            )}
            onClick={closeZoom}
            role="dialog"
            aria-modal="true"
            aria-label={t('card.screenshot_lightbox', { defaultValue: '截图预览' })}
            data-native-view-overlay="true"
          >
            <img
              src={imageUrl}
              alt={t('card.capture_screenshot', { defaultValue: '屏幕截图' })}
              className="max-h-[90vh] max-w-[90vw] object-contain rounded-lg shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            />
          </div>
        )}
      </div>
    )
  },
)

ScreenshotCardInner.displayName = 'ScreenshotCardInner'

// ---------------------------------------------------------------------------
// Renderer adapter — conforms to CardRendererProps
// ---------------------------------------------------------------------------

/**
 * Extracts ScreenshotPayload from the raw tool output.
 * The output may be `{ success, data: {...} }` or the payload itself.
 */
function extractPayload(raw: unknown): ScreenshotPayload | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  if (obj.data && typeof obj.data === 'object') {
    return obj.data as ScreenshotPayload
  }
  if ('path' in obj || 'base64' in obj) {
    return obj as unknown as ScreenshotPayload
  }
  return null
}

export const ScreenshotCardRenderer: React.FC<CardRendererProps> = React.memo((props) => {
  const { error, phase, output } = props
  const [ipcImageUrl, setIpcImageUrl] = useState<string | null>(null)
  const [ipcLoading, setIpcLoading] = useState(false)

  const raw = props.data ?? output
  const rawObj = raw as CaptureScreenshotOutput | null | undefined

  const payload = useMemo(() => extractPayload(raw), [raw])

  const base64Url = useMemo(() => {
    if (!payload?.base64) return null
    const fmt = payload.base64_format ?? payload.format ?? 'png'
    return `data:image/${fmt};base64,${payload.base64}`
  }, [payload])

  const filePath = payload?.path
  useEffect(() => {
    if (base64Url || !filePath) return
    let cancelled = false
    const load = async () => {
      setIpcLoading(true)
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const dataUrl = await (window as any).tabtin?.screenshot?.readFileAsDataURL(filePath)
        if (!cancelled && dataUrl && typeof dataUrl === 'string') {
          setIpcImageUrl(dataUrl)
        }
      } catch {
        // IPC not available or failed — inner component will show error state
      } finally {
        if (!cancelled) setIpcLoading(false)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [base64Url, filePath])

  if (error) return <ErrorBanner error={error} />

  if (!payload) {
    if (rawObj && typeof rawObj === 'object' && 'success' in rawObj && rawObj.success === false) {
      return <ErrorBanner error={rawObj.error ?? 'Screenshot failed'} />
    }
    if (phase === 'start' || phase === 'running') return <LoadingPlaceholder />
    return null
  }

  if (phase === 'start' || phase === 'running' || ipcLoading) {
    const imageUrl = base64Url ?? ipcImageUrl ?? ''
    if (!imageUrl) return <LoadingPlaceholder />
  }

  const imageUrl = base64Url ?? ipcImageUrl ?? ''

  return (
    <ScreenshotCardInner
      imageUrl={imageUrl}
      width={payload.width}
      height={payload.height}
      format={payload.format}
      sizeBytes={payload.sizeBytes}
      base64Degraded={payload.base64_degraded}
      filePath={payload.path}
    />
  )
})

ScreenshotCardRenderer.displayName = 'ScreenshotCardRenderer'

registerCardRenderer('ScreenshotCard', ScreenshotCardRenderer)

export { ScreenshotCardInner as ScreenshotCard }
export default ScreenshotCardInner
