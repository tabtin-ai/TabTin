/**
 * import-pptx 的纯字符串 / 媒体 / XML 实体工具。
 * 从 import-pptx.ts 抽离，零副作用，便于单测与复用。
 */

const MEDIA_MIME_BY_EXT: Record<string, string> = {
  // image
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  // video
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  ogv: 'video/ogg',
  avi: 'video/x-msvideo',
  wmv: 'video/x-ms-wmv',
  mpeg: 'video/mpeg',
  mpg: 'video/mpeg',
  // audio
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  flac: 'audio/flac',
  wma: 'audio/x-ms-wma',
}

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'tif', 'tiff'])
const VIDEO_EXTS = new Set(['mp4', 'm4v', 'mov', 'webm', 'ogv', 'avi', 'wmv', 'mpeg', 'mpg'])
const AUDIO_EXTS = new Set(['mp3', 'm4a', 'aac', 'wav', 'ogg', 'oga', 'flac', 'wma'])

export function stripQueryAndHash(path: string): string {
  return path.split('#')[0]?.split('?')[0] || path
}

export function extractExtFromPath(path: string): string | undefined {
  const clean = stripQueryAndHash(path || '')
  const file = clean.split('/').pop() || clean
  const parts = file.split('.')
  if (parts.length < 2) return undefined
  const ext = (parts.pop() || '').trim().toLowerCase()
  return ext || undefined
}

export function getMimeByExt(ext?: string): string {
  if (!ext) return 'application/octet-stream'
  return MEDIA_MIME_BY_EXT[ext] || 'application/octet-stream'
}

export function resolveRelTargetFileName(target?: string): string {
  if (!target) return ''
  const clean = stripQueryAndHash(target.trim())
  if (!clean) return ''
  return clean.split('/').pop() || clean
}

/** @internal — exported for unit testing */
export function decodeXmlEntities(text: string): string {
  return text
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&')
}

/** @internal — exported for unit testing */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** @internal — exported for unit testing */
export function sanitizeTextForHtml(text: string): string {
  return escapeHtml(decodeXmlEntities(text))
}

export function classifyRelMediaKind(relType: string, ext?: string): 'image' | 'video' | 'audio' | 'unknown' {
  const lowerType = relType.toLowerCase()
  const lowerExt = (ext || '').toLowerCase()

  if (lowerType.includes('/image') || IMAGE_EXTS.has(lowerExt)) return 'image'
  if (lowerType.includes('/audio') || AUDIO_EXTS.has(lowerExt)) return 'audio'
  if (lowerType.includes('/video') || VIDEO_EXTS.has(lowerExt)) return 'video'
  if (lowerType.includes('/media')) {
    if (AUDIO_EXTS.has(lowerExt)) return 'audio'
    if (VIDEO_EXTS.has(lowerExt)) return 'video'
    if (IMAGE_EXTS.has(lowerExt)) return 'image'
  }
  return 'unknown'
}

export function parseDataUrlMeta(dataUrl: string): { mime: string; base64: string } | null {
  const m = dataUrl.match(/^data:([^;,]+);base64,(.+)$/i)
  if (!m) return null
  return { mime: m[1], base64: m[2] }
}
