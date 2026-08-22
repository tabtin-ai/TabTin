export type WidgetRenderMode =
  | { mode: 'image_fallback' }
  | { mode: 'iframe' }
  | { mode: 'mermaid_streaming'; streamingCode: string; loadingMessage: string }
  | { mode: 'interrupted_empty' }
  | { mode: 'loading'; loadingMessage: string }

export function selectWidgetRenderMode(params: {
  showImageFallback: boolean
  srcdoc: string
  effectiveFormat: 'svg' | 'html' | 'mermaid'
  streamingCode: string | null | undefined
  isInterrupted: boolean
  loadingMessage: string
}): WidgetRenderMode {
  if (params.showImageFallback) return { mode: 'image_fallback' }
  if (params.srcdoc) return { mode: 'iframe' }
  if (params.effectiveFormat === 'mermaid' && params.streamingCode) {
    return {
      mode: 'mermaid_streaming',
      streamingCode: params.streamingCode,
      loadingMessage: params.loadingMessage,
    }
  }
  if (params.isInterrupted) return { mode: 'interrupted_empty' }
  return { mode: 'loading', loadingMessage: params.loadingMessage }
}
