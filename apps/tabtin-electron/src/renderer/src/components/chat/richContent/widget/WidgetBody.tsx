import React from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@utils/cn'
import { Loader2, Pause } from 'lucide-react'
import { WIDGET_PREVIEW } from '../../registry/chatDesignTokens'
import type { WidgetRenderMode } from './selectWidgetRenderMode'

interface WidgetBodyProps {
  renderMode: WidgetRenderMode
  imageUrl: string
  summary?: string
  title?: string
  srcdoc: string
  iframeRef: React.RefObject<HTMLIFrameElement | null>
  iframeHeight: number | null
  onIframeLoad: () => void
}

export const WidgetBody: React.FC<WidgetBodyProps> = ({
  renderMode,
  imageUrl,
  summary,
  title,
  srcdoc,
  iframeRef,
  iframeHeight,
  onIframeLoad,
}) => {
  const { t } = useTranslation('chat')

  switch (renderMode.mode) {
    case 'image_fallback':
      return (
        <img
          src={imageUrl}
          alt={summary}
          className={cn(WIDGET_PREVIEW.imageFallback, 'pointer-events-none')}
        />
      )
    case 'iframe':
      return (
        <iframe
          ref={iframeRef}
          srcDoc={srcdoc}
          sandbox="allow-scripts"
          className={cn(
            'w-full bg-background pointer-events-none',
            iframeHeight == null && 'min-h-[200px]',
          )}
          style={
            iframeHeight != null
              ? { height: `${iframeHeight}px`, minHeight: 0 }
              : undefined
          }
          title={title || summary || 'widget'}
          referrerPolicy="no-referrer"
          loading="lazy"
          onLoad={onIframeLoad}
        />
      )
    case 'mermaid_streaming':
      return (
        <div className="flex flex-col gap-2 px-4 py-8 min-h-[200px] bg-background">
          <p className="text-caption text-muted-foreground text-center">
            {renderMode.loadingMessage}
          </p>
          <pre className="max-h-[160px] overflow-hidden rounded-md border border-border/30 bg-muted/20 p-3 text-caption text-muted-foreground whitespace-pre-wrap">
            {renderMode.streamingCode}
          </pre>
        </div>
      )
    case 'interrupted_empty':
      return (
        <div className="flex flex-col items-center justify-center gap-2 px-4 py-8 min-h-[200px]">
          <Pause className="h-5 w-5 text-muted-foreground/80" aria-hidden />
          <p className="text-caption text-muted-foreground line-clamp-3 max-w-md text-center">
            {t('richContent.widgetInterruptedDesc', 'Agent 中断了这次可视化生成')}
          </p>
        </div>
      )
    case 'loading':
      return (
        <div className="flex flex-col items-center justify-center gap-2 px-4 py-8 min-h-[200px]">
          <Loader2 className="h-5 w-5 text-muted-foreground animate-spin" aria-hidden />
          <p className="text-caption text-muted-foreground line-clamp-3 max-w-md text-center">
            {renderMode.loadingMessage}
          </p>
        </div>
      )
  }
}

WidgetBody.displayName = 'WidgetBody'
