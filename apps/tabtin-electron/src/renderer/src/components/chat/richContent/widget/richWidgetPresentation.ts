import type { RichContentBlock } from '@tabtin/chat-client'
import { htmlPreviewLooksUnsafe } from './htmlPreviewLooksUnsafe'

export function normalizeWidgetFormat(format: unknown): 'svg' | 'html' | 'mermaid' {
  return format === 'html' || format === 'mermaid' ? format : 'svg'
}

export function parseRichWidgetBlockFields(block: RichContentBlock) {
  const widgetId = block.widget_id ?? ''
  const blockToolCallId = typeof block.tool_call_id === 'string' ? block.tool_call_id : ''
  const blockFormat = normalizeWidgetFormat(block.format)
  const blockRenderedCode = typeof block.rendered_code === 'string' ? block.rendered_code : ''
  const blockCode = typeof block.code === 'string' ? block.code : ''
  const finalCode =
    blockFormat === 'mermaid'
      ? (blockRenderedCode || (blockCode.trimStart().startsWith('<svg') ? blockCode : ''))
      : blockCode
  const imageUrl = typeof block.image_url === 'string' ? block.image_url : ''
  const isPendingPlaceholder = widgetId.startsWith('pending:')
  const exposedWidgetId = isPendingPlaceholder ? '' : widgetId
  const isInterrupted = !!block.interrupted_at && !finalCode

  return {
    widgetId,
    blockToolCallId,
    blockFormat,
    finalCode,
    imageUrl,
    isPendingPlaceholder,
    exposedWidgetId,
    isInterrupted,
  }
}

export function resolveRichWidgetEffectiveFormat(
  finalCode: string,
  blockFormat: 'svg' | 'html' | 'mermaid',
  streamingFormat: 'svg' | 'html' | 'mermaid' | null,
): 'svg' | 'html' | 'mermaid' {
  return finalCode ? blockFormat : (streamingFormat ?? blockFormat)
}

export function resolveSafeStreamingCode(
  streamingCode: string,
  effectiveFormat: 'svg' | 'html' | 'mermaid',
): string {
  if (!streamingCode) return ''
  if (effectiveFormat === 'html' && htmlPreviewLooksUnsafe(streamingCode)) return ''
  return streamingCode
}

export function resolveRichWidgetRenderCode(
  finalCode: string,
  effectiveFormat: 'svg' | 'html' | 'mermaid',
  safeStreamingCode: string,
): string {
  return finalCode || (effectiveFormat === 'mermaid' ? '' : safeStreamingCode) || ''
}

export function resolveRichWidgetLoadingMessage(
  streamingLoadingMessage: string,
  blockLoadingMessage: unknown,
  fallback: string,
): string {
  if (streamingLoadingMessage) return streamingLoadingMessage
  if (typeof blockLoadingMessage === 'string' && blockLoadingMessage) return blockLoadingMessage
  return fallback
}

export function canOpenRichWidgetPreview(
  isPendingPlaceholder: boolean,
  finalCode: string,
  renderCode: string,
  imageUrl: string,
): boolean {
  return !isPendingPlaceholder && !!(finalCode || renderCode || imageUrl)
}
