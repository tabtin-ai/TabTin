/**
 * PhoneScreenshotCard — renders screen_capture / screen_snapshot tool output.
 *
 * Handles both formats:
 *   screen_capture:  { image_url, file_id, size }
 *   screen_snapshot: { image_url, has_screenshot, ui_tree, screen_width, screen_height, element_count, mode }
 */

import React, { useState, useCallback, useEffect, useLayoutEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Smartphone, ChevronDown, ChevronUp, ZoomIn } from 'lucide-react'
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
// Data shape
// ---------------------------------------------------------------------------

interface ScreenCaptureData {
  image_url?: string
  file_id?: string
  size?: number
  // screen_snapshot additional fields
  has_screenshot?: boolean
  ui_tree?: string
  screen_width?: number
  screen_height?: number
  element_count?: number
  mode?: string
}

// ---------------------------------------------------------------------------
// Inner display component
// ---------------------------------------------------------------------------

interface PhoneScreenshotCardProps {
  imageUrl: string
  uiTree?: string
  screenWidth?: number
  screenHeight?: number
  elementCount?: number
  mode?: string
}

const PhoneScreenshotCard: React.FC<PhoneScreenshotCardProps> = React.memo(
  ({ imageUrl, uiTree, screenWidth, screenHeight, elementCount, mode }) => {
    const { t } = useTranslation('chat')
    const [isZoomed, setIsZoomed] = useState(false)
    const [isTreeExpanded, setIsTreeExpanded] = useState(false)
    const [imgError, setImgError] = useState(false)

    const openZoom = useCallback(() => setIsZoomed(true), [])
    const closeZoom = useCallback(() => setIsZoomed(false), [])

    // Close zoom overlay on Escape
    useEffect(() => {
      if (!isZoomed) return
      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') closeZoom()
      }
      window.addEventListener('keydown', onKey)
      return () => window.removeEventListener('keydown', onKey)
    }, [isZoomed, closeZoom])

    useLayoutEffect(() => {
      if (!isZoomed || imgError) return
      syncNativeViewOverlayCountFromDom(document)
      return () => {
        queueMicrotask(() => syncNativeViewOverlayCountFromDom(document))
      }
    }, [imgError, isZoomed])

    const hasUiTree = Boolean(uiTree)

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
          <Smartphone className={cn(ICON_SIZE.md, TEXT_COLOR.muted)} />
          <span className={cn(TEXT.header, TEXT_COLOR.secondary)}>
            {t('card.phone_screenshot', { defaultValue: '屏幕截图' })}
          </span>
          {screenWidth != null && screenHeight != null && (
            <span className={cn(TEXT.meta, TEXT_COLOR.faint, 'ml-auto shrink-0 font-mono')}>
              {screenWidth}×{screenHeight}
            </span>
          )}
        </div>

        {/* ── Screenshot preview ─────────────────────────────────────── */}
        <div className={cn('flex justify-center', BG.card, 'p-3')}>
          {imgError ? (
            <div
              className={cn(
                'flex items-center justify-center',
                IMAGE_PREVIEW.frame,
                'min-h-[96px]',
                BG.header,
                CARD_RADIUS,
                TEXT.meta,
                TEXT_COLOR.faint,
              )}
            >
              {t('card.image_load_failed', { defaultValue: '图片加载失败' })}
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
                alt={t('card.phone_screenshot', { defaultValue: '屏幕截图' })}
                className={IMAGE_PREVIEW.img}
                onError={() => setImgError(true)}
              />
              {/* Hover overlay */}
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

        {/* ── UI tree section ────────────────────────────────────────── */}
        {hasUiTree && (
          <div className={cn('border-t', BORDER.subtle)}>
            {/* Toggle button */}
            <button
              type="button"
              onClick={() => setIsTreeExpanded((prev) => !prev)}
              className={cn(
                'w-full flex items-center justify-between gap-2',
                CARD_HEADER_PADDING.x,
                'py-1.5',
                TEXT.meta,
                TEXT_COLOR.muted,
                'hover:bg-muted/10',
                ANIMATION.collapse,
              )}
            >
              <span className="flex items-center gap-1.5">
                <span>{t('card.ui_tree', { defaultValue: 'UI 元素树' })}</span>
                {elementCount != null && (
                  <span className={cn(TEXT.meta, TEXT_COLOR.faint)}>
                    ({elementCount}{' '}
                    {t('card.elements', { defaultValue: '个元素' })})
                  </span>
                )}
                {mode && (
                  <span className={cn(TEXT.meta, TEXT_COLOR.faint, 'font-mono')}>
                    [{mode}]
                  </span>
                )}
              </span>
              {isTreeExpanded ? (
                <ChevronUp className={ICON_SIZE.md} />
              ) : (
                <ChevronDown className={ICON_SIZE.md} />
              )}
            </button>

            {/* Tree content */}
            {isTreeExpanded && (
              <div
                className={cn(
                  'overflow-auto max-h-[200px]',
                  CARD_HEADER_PADDING.x,
                  'py-2',
                  BG.terminal,
                )}
              >
                <pre className={cn(TEXT.code, TEXT_COLOR.secondary, 'whitespace-pre-wrap break-words')}>
                  {uiTree}
                </pre>
              </div>
            )}
          </div>
        )}

        {/* ── Zoom lightbox ──────────────────────────────────────────── */}
        {isZoomed && !imgError && (
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
              alt={t('card.phone_screenshot', { defaultValue: '屏幕截图' })}
              className="max-h-[90vh] max-w-[90vw] object-contain rounded-lg shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            />
          </div>
        )}
      </div>
    )
  },
)

PhoneScreenshotCard.displayName = 'PhoneScreenshotCard'

// ---------------------------------------------------------------------------
// Renderer adapter
// ---------------------------------------------------------------------------

/**
 * Renderer adapter conforming to CardRendererProps.
 * Extracts screenshot data from props.data or props.output.
 */
export const PhoneScreenshotCardRenderer: React.FC<CardRendererProps> = React.memo((props) => {
  const { error, phase } = props
  const data =
    (props.data as ScreenCaptureData | null | undefined) ??
    (props.output as ScreenCaptureData | null | undefined)

  if (error) return <ErrorBanner error={error} />

  if (!data || typeof data !== 'object') {
    if (phase === 'start' || phase === 'running') return <LoadingPlaceholder />
    return null
  }

  // screen_snapshot: has_screenshot may be false even when success === true
  if ('has_screenshot' in data && !data.has_screenshot) {
    if (phase === 'start' || phase === 'running') return <LoadingPlaceholder />
    return null
  }

  const imageUrl = data.image_url ?? ''
  if (!imageUrl) {
    if (phase === 'start' || phase === 'running') return <LoadingPlaceholder />
    return null
  }

  return (
    <PhoneScreenshotCard
      imageUrl={imageUrl}
      uiTree={data.ui_tree}
      screenWidth={data.screen_width}
      screenHeight={data.screen_height}
      elementCount={data.element_count}
      mode={data.mode}
    />
  )
})

PhoneScreenshotCardRenderer.displayName = 'PhoneScreenshotCardRenderer'

registerCardRenderer('PhoneScreenshotCard', PhoneScreenshotCardRenderer)

export { PhoneScreenshotCard }
export default PhoneScreenshotCard
