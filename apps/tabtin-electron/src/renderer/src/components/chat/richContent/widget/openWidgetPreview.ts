import type { PreviewResource } from '../../preview/types'
import { useResourcePreviewStore } from '../../preview/useResourcePreviewStore'

function buildWidgetPreviewResource(params: {
  previewCode: string
  resourceId: string | undefined
  exposedWidgetId: string
  messageId?: string
  effectiveFormat: 'svg' | 'html' | 'mermaid'
  imageUrl: string
  title?: string
  summary?: string
}): PreviewResource {
  return {
    id: params.resourceId || `widget:${params.exposedWidgetId || params.messageId || 'one'}`,
    kind: 'widget',
    url: params.imageUrl,
    name: params.title || params.summary || 'widget',
    sourceMessageId: params.messageId,
    widgetId: params.exposedWidgetId || undefined,
    format: params.effectiveFormat,
    code: params.previewCode || undefined,
    imageUrl: params.imageUrl || undefined,
  }
}

export function openWidgetPreview(params: {
  canZoomPreview: boolean
  finalCode: string
  renderCode: string
  effectiveFormat: 'svg' | 'html' | 'mermaid'
  exposedWidgetId: string
  messageId?: string
  sessionId?: string | null
  imageUrl: string
  title?: string
  summary?: string
}): void {
  if (!params.canZoomPreview) return
  const previewCode = params.finalCode
    || (params.effectiveFormat === 'mermaid' ? '' : params.renderCode)
    || ''
  const resourceId = params.exposedWidgetId && params.messageId
    ? `${params.messageId}:widget:${params.exposedWidgetId}`
    : undefined
  const store = useResourcePreviewStore.getState()
  if (params.messageId && params.sessionId && resourceId
      && store.openFromMessage(params.sessionId, params.messageId, { resourceId })) {
    return
  }
  store.open([buildWidgetPreviewResource({
    previewCode,
    resourceId,
    exposedWidgetId: params.exposedWidgetId,
    messageId: params.messageId,
    effectiveFormat: params.effectiveFormat,
    imageUrl: params.imageUrl,
    title: params.title,
    summary: params.summary,
  })], 0)
}
