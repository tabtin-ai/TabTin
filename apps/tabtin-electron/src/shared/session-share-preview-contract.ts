/**
 * SessionShare 本地文件预览契约（ / 方案 B）。
 *
 * 数值权威在 Django：
 * ``apps/chat/conversation/services/workspace_file/constants.py``
 * main / renderer 都从本文件读，避免 Dialog 与物化硬顶漂移。
 */

/** 对齐 ``MAX_MATERIALIZE_BYTES`` */
export const MATERIALIZE_MAX_BYTES = 50 * 1024 * 1024

/** 共享会话远端预览：已知体积超过物化硬顶则前端禁用预览入口。 */
export function isSharedSessionFileTooLargeForPreview(
  fileSize: number | null | undefined,
): boolean {
  return typeof fileSize === 'number'
    && Number.isFinite(fileSize)
    && fileSize > MATERIALIZE_MAX_BYTES
}

/** 对齐 ``SIGNED_URL_TTL_SECONDS``（签链由服务端控制；此处供文档/断言） */
export const SIGNED_URL_TTL_SECONDS = 15 * 60

export const PREVIEW_KIND = {
  text: 'text',
  image: 'image',
  pdf: 'pdf',
  video: 'video',
  audio: 'audio',
  binary: 'binary',
  doc: 'doc',
  docx: 'docx',
  xlsx: 'xlsx',
  pptx: 'pptx',
} as const

export type PreviewKind = (typeof PREVIEW_KIND)[keyof typeof PREVIEW_KIND]

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'])
const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mkv', '.avi', '.mov'])
const AUDIO_EXTS = new Set(['.mp3', '.wav', '.ogg', '.flac', '.aac', '.m4a'])

/** 物化路径 kind 路由（不含 text；text 走 read_file_preview）。 */
export function guessMaterializePreviewKind(filePath: string): PreviewKind {
  const lower = filePath.toLowerCase()
  const dot = lower.lastIndexOf('.')
  const extension = dot >= 0 ? lower.slice(dot) : ''
  if (extension === '.pdf') return PREVIEW_KIND.pdf
  if (extension === '.doc') return PREVIEW_KIND.doc
  if (extension === '.docx') return PREVIEW_KIND.docx
  if (extension === '.xlsx') return PREVIEW_KIND.xlsx
  if (extension === '.pptx') return PREVIEW_KIND.pptx
  if (IMAGE_EXTS.has(extension)) return PREVIEW_KIND.image
  if (VIDEO_EXTS.has(extension)) return PREVIEW_KIND.video
  if (AUDIO_EXTS.has(extension)) return PREVIEW_KIND.audio
  return PREVIEW_KIND.binary
}
