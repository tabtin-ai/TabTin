import React from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@utils/cn'
import { WidgetContextMenu, type WidgetMenuPosition } from './WidgetContextMenu'
import { WidgetBody } from './WidgetBody'
import { WIDGET_PREVIEW } from '../../registry/chatDesignTokens'
import type { WidgetRenderMode } from './selectWidgetRenderMode'

const INTERRUPTED_OPACITY_CLASS = 'opacity-60'

export const RichWidgetFrame: React.FC<{
  ariaLabel: string
  exposedWidgetId: string
  blockToolCallId: string
  isInterrupted: boolean
  isStreaming: boolean
  finalCode: string
  canZoomPreview: boolean
  widgetTypeLabel: string
  liveAnnouncement: string
  title?: string
  summary?: string
  renderMode: WidgetRenderMode
  imageUrl: string
  srcdoc: string
  iframeRef: React.RefObject<HTMLIFrameElement | null>
  iframeHeight: number | null
  onIframeLoad: () => void
  contextMenuPos: WidgetMenuPosition | null
  canSavePng: boolean
  canCopyCode: boolean
  canOpenInNewWindow: boolean
  copyLabel: string
  onSavePng: () => void
  onCopyCode: () => void
  onOpenInNewWindow: () => void
  onCloseContextMenu: () => void
  widgetDrag: { draggable: boolean; onDragStart: (event: React.DragEvent) => void }
  onContextMenu: (event: React.MouseEvent) => void
  onOpenPreview: () => void
}> = ({
  ariaLabel,
  exposedWidgetId,
  blockToolCallId,
  isInterrupted,
  isStreaming,
  finalCode,
  canZoomPreview,
  widgetTypeLabel,
  liveAnnouncement,
  title,
  summary,
  renderMode,
  imageUrl,
  srcdoc,
  iframeRef,
  iframeHeight,
  onIframeLoad,
  contextMenuPos,
  canSavePng,
  canCopyCode,
  canOpenInNewWindow,
  copyLabel,
  onSavePng,
  onCopyCode,
  onOpenInNewWindow,
  onCloseContextMenu,
  widgetDrag,
  onContextMenu,
  onOpenPreview,
}) => {
  const { t } = useTranslation('chat')

  return (
    <div
      className={cn(
        'group relative flex flex-col rounded-lg border border-border/40 bg-muted/10 overflow-hidden',
        WIDGET_PREVIEW.frame,
        canZoomPreview && 'cursor-zoom-in',
      )}
      role="img"
      aria-label={ariaLabel}
      data-widget-id={exposedWidgetId || undefined}
      data-tool-call-id={blockToolCallId || undefined}
      data-interrupted={isInterrupted ? 'true' : undefined}
      draggable={widgetDrag.draggable}
      onDragStart={widgetDrag.onDragStart}
      onContextMenu={onContextMenu}
      onClick={(e) => {
        if (!canZoomPreview || contextMenuPos) return
        e.stopPropagation()
        onOpenPreview()
      }}
      onKeyDown={(e) => {
        if (!canZoomPreview) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpenPreview()
        }
      }}
      tabIndex={canZoomPreview ? 0 : undefined}
    >
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {liveAnnouncement}
      </span>

      {contextMenuPos && (
        <WidgetContextMenu
          position={contextMenuPos}
          canSavePng={canSavePng}
          canCopyCode={canCopyCode}
          canOpenInNewWindow={canOpenInNewWindow}
          copyLabel={copyLabel}
          onSavePng={onSavePng}
          onCopyCode={onCopyCode}
          onOpenInNewWindow={onOpenInNewWindow}
          onClose={onCloseContextMenu}
        />
      )}

      <div className="flex items-center gap-1 px-3 pt-2 pb-1 text-muted-foreground">
        <span className="text-caption text-muted-foreground">{widgetTypeLabel}</span>
        {isInterrupted ? (
          <span className="ml-1 text-caption text-muted-foreground/60">
            {t('richContent.widgetInterrupted', '已中断')}
          </span>
        ) : isStreaming && !finalCode ? (
          <span className="text-caption text-muted-foreground/80 ml-1">
            {t('richContent.widgetStreaming', '流式中…')}
          </span>
        ) : null}
      </div>

      {title && (
        <div className="px-3 pb-1">
          <p className="text-caption font-medium text-foreground">{title}</p>
        </div>
      )}

      <div className={cn('transition-opacity duration-200', isInterrupted && INTERRUPTED_OPACITY_CLASS)}>
        <WidgetBody
          renderMode={renderMode}
          imageUrl={imageUrl}
          summary={summary}
          title={title}
          srcdoc={srcdoc}
          iframeRef={iframeRef}
          iframeHeight={iframeHeight}
          onIframeLoad={onIframeLoad}
        />
      </div>

      {summary && finalCode && (
        <div className="px-3 py-1.5 bg-muted/20 border-t border-border/20">
          <p className="text-caption text-muted-foreground/80">{summary}</p>
        </div>
      )}

    </div>
  )
}
