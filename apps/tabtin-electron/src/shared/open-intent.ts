/**
 * Unified Open Intent Resolver — pure judgment only.
 *
 * Shared by Electron main + renderer. No React, no Preview Modal, no loadURL.
 * Callers decide what to do with `{ kind: 'preview' | 'browser' | 'unknown' }`.
 *
 * Priority (see resolveOpenIntent):
 *   1. forceBrowser
 *   2. mimeType
 *   3. filename
 *   4. url extension / data: mime
 */

export type OpenIntentPreviewKind =
  | 'image'
  | 'video'
  | 'audio'
  | 'pdf'
  | 'docx'
  | 'xlsx'
  | 'pptx'
  | 'csv'
  | 'txt'
  | 'md'
  | 'json'

export type OpenIntentConfidence = 'mime' | 'filename' | 'url'

export type OpenIntent =
  | {
      kind: 'preview'
      previewKind: OpenIntentPreviewKind
      confidence: OpenIntentConfidence
    }
  | { kind: 'browser' }
  | { kind: 'unknown' }

export interface ResolveOpenIntentInput {
  url: string
  filename?: string
  mimeType?: string
  /** Reserved for future asset-metadata lookup; ignored today. */
  assetId?: string
  forceBrowser?: boolean
}

export interface OpenIntentHints {
  filename?: string
  mimeType?: string
  assetId?: string
}

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|ico|bmp|avif|heic|heif|tiff?)(\?|#|$)/i
const VIDEO_EXT_RE = /\.(mp4|webm|mkv|avi|mov|m4v|ogv)(\?|#|$)/i
const AUDIO_EXT_RE = /\.(mp3|wav|ogg|flac|aac|m4a)(\?|#|$)/i
const PDF_EXT_RE = /\.pdf(\?|#|$)/i
const DOC_EXT_RE = /\.(docx|xlsx|xls|pptx|csv|txt|json|md|markdown)(\?|#|$)/i

/** Schemes that may carry a direct binary/file payload into Preview Modal. */
export function isDirectOpenIntentUrl(url: string): boolean {
  return /^(https?:|blob:|data:)/i.test(url.trim())
}

function kindFromDocExtension(ext: string): OpenIntentPreviewKind | null {
  const e = ext.toLowerCase()
  if (e === 'markdown') return 'md'
  if (
    e === 'docx' || e === 'xlsx' || e === 'pptx' || e === 'csv'
    || e === 'txt' || e === 'json' || e === 'md'
  ) {
    return e
  }
  if (e === 'xls') return 'xlsx'
  return null
}

function kindFromPath(pathOrName?: string): OpenIntentPreviewKind | null {
  if (!pathOrName) return null
  if (IMAGE_EXT_RE.test(pathOrName)) return 'image'
  if (VIDEO_EXT_RE.test(pathOrName)) return 'video'
  if (AUDIO_EXT_RE.test(pathOrName)) return 'audio'
  if (PDF_EXT_RE.test(pathOrName)) return 'pdf'
  const docMatch = DOC_EXT_RE.exec(pathOrName)
  if (docMatch) return kindFromDocExtension(docMatch[1])
  return null
}

function kindFromMime(mime?: string): OpenIntentPreviewKind | null {
  const m = (mime || '').toLowerCase().trim()
  if (!m) return null
  if (m.startsWith('image/')) return 'image'
  if (m.startsWith('video/')) return 'video'
  if (m.startsWith('audio/')) return 'audio'
  if (m === 'application/pdf') return 'pdf'
  if (m === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'docx'
  if (
    m === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    || m === 'application/vnd.ms-excel'
  ) {
    return 'xlsx'
  }
  if (m === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') return 'pptx'
  if (m === 'text/csv' || m === 'application/csv') return 'csv'
  if (m === 'text/plain') return 'txt'
  if (m === 'application/json' || m === 'text/json') return 'json'
  if (m === 'text/markdown' || m === 'text/x-markdown') return 'md'
  return null
}

function mimeFromDataUrl(url: string): string | undefined {
  const match = /^data:([^;,]+)/i.exec(url.trim())
  return match?.[1]
}

function filenameFromUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname
    const leaf = pathname.split('/').pop()
    if (leaf) return decodeURIComponent(leaf)
  } catch {
    // fall through
  }
  const leaf = url.split('/').pop() || ''
  return leaf.replace(/[?#].*$/, '')
}

function urlPathForExtension(url: string): string {
  try {
    return new URL(url).pathname
  } catch {
    return url
  }
}

/**
 * Core kind inference with priority: mime → filename → url path/extension.
 * Preserves legacy text/plain vs .md/.json path override (Windows mime quirks).
 */
export function resolvePreviewKindHints(input: {
  mimeType?: string
  filename?: string
  url?: string
}): { previewKind: OpenIntentPreviewKind; confidence: OpenIntentConfidence } | null {
  const mime = (input.mimeType || '').toLowerCase().trim()
  const filename = input.filename?.trim() || ''
  const url = input.url?.trim() || ''
  const fromFilename = kindFromPath(filename)
  const fromUrl = kindFromPath(urlPathForExtension(url) || url)

  // Legacy: text/plain + .md/.json → prefer path (Windows often labels markdown as plain)
  if (mime === 'text/plain' && (fromFilename === 'md' || fromFilename === 'json')) {
    return { previewKind: fromFilename, confidence: 'filename' }
  }
  if (mime === 'text/plain' && (fromUrl === 'md' || fromUrl === 'json') && !fromFilename) {
    return { previewKind: fromUrl, confidence: 'url' }
  }

  const fromMime = kindFromMime(mime)
  if (fromMime) return { previewKind: fromMime, confidence: 'mime' }
  if (fromFilename) return { previewKind: fromFilename, confidence: 'filename' }
  if (fromUrl) return { previewKind: fromUrl, confidence: 'url' }
  return null
}

/**
 * Decide whether a URL should open as Preview, Browser, or Unknown.
 * Does not open anything.
 */
export function resolveOpenIntent(input: ResolveOpenIntentInput): OpenIntent {
  if (input.forceBrowser) return { kind: 'browser' }

  const url = (input.url || '').trim()
  if (!url) return { kind: 'unknown' }

  if (!isDirectOpenIntentUrl(url)) {
    return { kind: 'unknown' }
  }

  const mimeType = input.mimeType?.trim() || mimeFromDataUrl(url)
  const filename = input.filename?.trim() || undefined

  const resolved = resolvePreviewKindHints({
    mimeType,
    filename,
    url,
  })

  if (resolved) {
    return {
      kind: 'preview',
      previewKind: resolved.previewKind,
      confidence: resolved.confidence,
    }
  }

  // https/blob/data with no previewable signal → treat as ordinary web navigation
  return { kind: 'browser' }
}

/** Convenience: derived filename leaf for callers that still need a display name. */
export function deriveFilenameFromOpenIntentUrl(url: string): string {
  return filenameFromUrl(url) || 'file'
}
