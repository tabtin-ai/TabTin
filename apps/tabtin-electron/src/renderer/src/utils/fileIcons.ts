import {
  File,
  FileAudio,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Presentation,
  type LucideIcon,
} from 'lucide-react'
import { ACCEPTED_IMAGE_MIMES } from '@/constants/upload'

export const IMAGE_MIME_PREFIX = 'image/'

const BROWSER_PREVIEWABLE = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml', 'image/avif',
])

/**
 * 可在浏览器中直接预览的图片 MIME 类型。
 * 取 ACCEPTED_IMAGE_MIMES（远程配置同步） ∩ 浏览器原生支持 的交集。
 */
export function isPreviewable(mime: string): boolean {
  return ACCEPTED_IMAGE_MIMES.has(mime) && BROWSER_PREVIEWABLE.has(mime)
}

const SPREADSHEET_MIMES = new Set([
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv',
])

const PRESENTATION_MIMES = new Set([
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
])

export function getFileIcon(mimeType: string): LucideIcon {
  if (mimeType.startsWith('image/')) return FileImage
  if (mimeType.startsWith('audio/')) return FileAudio
  if (mimeType.startsWith('video/')) return FileVideo
  if (SPREADSHEET_MIMES.has(mimeType)) return FileSpreadsheet
  if (PRESENTATION_MIMES.has(mimeType)) return Presentation
  if (
    mimeType.startsWith('text/') ||
    mimeType.includes('pdf') ||
    mimeType.includes('word') ||
    mimeType.includes('wordprocessingml') ||
    mimeType === 'application/json'
  )
    return FileText
  return File
}
