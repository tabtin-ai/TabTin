import { createLogger } from '@/utils/logger'

const log = createLogger('ImagePreviewClipboard')

function guessMimeType(url: string, mimeType?: string): string {
  if (mimeType) return mimeType
  const dataMime = url.match(/^data:([^;,]+)/)?.[1]
  if (dataMime) return dataMime
  const path = url.split('?')[0].toLowerCase()
  if (path.endsWith('.png')) return 'image/png'
  if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg'
  if (path.endsWith('.gif')) return 'image/gif'
  if (path.endsWith('.webp')) return 'image/webp'
  if (path.endsWith('.bmp')) return 'image/bmp'
  if (path.endsWith('.svg')) return 'image/svg+xml'
  return 'application/octet-stream'
}

async function toPng(blob: Blob): Promise<Blob> {
  if (blob.type === 'image/png') return blob
  const bitmap = await createImageBitmap(blob)
  try {
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Canvas 2D unavailable')
    context.drawImage(bitmap, 0, 0)
    const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
    if (!png?.size) throw new Error('PNG encode failed')
    return png
  } finally {
    bitmap.close()
  }
}

export async function copyImageToClipboard(source: {
  displayUrl: string
  mimeType?: string
  loadBytes?: () => Promise<ArrayBuffer>
}): Promise<void> {
  if (!source.displayUrl) throw new Error('Missing image display URL')
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
    throw new Error('Clipboard image write unsupported')
  }

  const png = (async () => {
    const response = source.loadBytes ? null : await globalThis.fetch(source.displayUrl)
    if (response && !response.ok) throw new Error(`Image fetch failed: HTTP ${response.status}`)
    const bytes = source.loadBytes ? await source.loadBytes() : await response!.arrayBuffer()
    const mimeType = source.mimeType ?? response?.headers.get('content-type') ?? guessMimeType(source.displayUrl)
    return toPng(new Blob([bytes], { type: mimeType === 'application/octet-stream' ? 'image/png' : mimeType }))
  })()

  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
  } catch (error) {
    log.warn('image clipboard write failed', {
      protocol: source.displayUrl.split(':', 1)[0] || 'unknown',
      reason: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}
