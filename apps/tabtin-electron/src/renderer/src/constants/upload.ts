/**
 * 统一文件上传预设
 *
 * 本地硬编码值作为 fallback，应用启动后通过 fetchUploadConfig()
 * 从后端 GET /services/oss/upload-config 拉取最新配置并覆盖。
 * 所有模块通过 UPLOAD_PRESETS[key] / validateUploadFile() 使用，
 * 不再各自维护 MIME 白名单。
 */

import { joinApiPath } from '@tabtin/config'
import { API_CONFIG } from '@/config/api'
import { useAuthStore } from '@stores/useAuthStore'
import { registerResetAction } from '@/stores/sessionResetRegistry'
import { electronFetch } from '@/services/electronFetch'

const MB = 1024 * 1024

// ======================== 导出的 MIME Set（可变引用，fetch 后原地更新） ========================

export const ACCEPTED_IMAGE_MIMES = new Set([
  'image/jpeg', 'image/jpg', 'image/png', 'image/gif',
  'image/webp', 'image/bmp', 'image/x-ms-bmp', 'image/avif', 'image/svg+xml',
  'image/heic', 'image/heif', 'image/apng', 'image/tiff',
])

export const ACCEPTED_DOCUMENT_MIMES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain', 'text/csv', 'text/markdown', 'text/x-markdown',
  'application/json',
])

export const ACCEPTED_MEDIA_MIMES = new Set([
  'video/mp4', 'video/webm', 'video/quicktime',
  'audio/mpeg', 'audio/wav', 'audio/mp3', 'audio/ogg', 'audio/webm',
])

// ======================== 类型 ========================

export interface UploadPreset {
  maxSize: number
  /** null = 任意类型 */
  accept: Set<string> | null
}

export type UploadPresetKey = keyof typeof UPLOAD_PRESETS

export interface FileValidationResult {
  valid: boolean
  reason?: string
}

// ======================== 预设对象 ========================

export const UPLOAD_PRESETS = {
  IMAGE: { maxSize: 20 * MB, accept: ACCEPTED_IMAGE_MIMES } as UploadPreset,
  FILE: { maxSize: 50 * MB, accept: null } as UploadPreset,
  MEDIA: { maxSize: 200 * MB, accept: ACCEPTED_MEDIA_MIMES } as UploadPreset,
  ATTACHMENT: { maxSize: 100 * MB, accept: null } as UploadPreset,
  DOCUMENT: { maxSize: 50 * MB, accept: ACCEPTED_DOCUMENT_MIMES } as UploadPreset,
}

// ======================== 远程配置拉取 ========================

let _fetched = false

function replaceSetContents(target: Set<string>, items: string[]): void {
  target.clear()
  for (const item of items) target.add(item)
}

/**
 * 重置 _fetched 标记，下次调用 fetchUploadConfig() 会重新拉取。
 * 供 sessionReset（登出）时调用。
 */
export function resetUploadConfigFetched(): void {
  _fetched = false
}

/**
 * 从后端拉取最新上传预设，成功后原地更新 MIME Set 和大小限制。
 * 应在 app 启动时调用一次，失败静默降级到硬编码 fallback。
 * @param force 为 true 时忽略 _fetched 标记强制重新拉取（登录后使用）
 */
export async function fetchUploadConfig(force?: boolean): Promise<void> {
  if (_fetched && !force) return
  try {
    const headers: HeadersInit = { Accept: 'application/json' }
    const token = useAuthStore.getState().accessToken
    if (token) {
      headers['Authorization'] = `Bearer ${token}`
    }

    const resp = await electronFetch(joinApiPath(API_CONFIG.baseURL, `/services/oss/upload-config`), {
      method: 'GET',
      headers,
    })
    if (!resp.ok) return
    const json = await resp.json()
    const presets: Record<string, { maxSize: number; accept: string[] | null }> | undefined =
      json?.data?.presets

    if (!presets || typeof presets !== 'object') return

    for (const [key, remote] of Object.entries(presets)) {
      const local = UPLOAD_PRESETS[key as UploadPresetKey]
      if (!local) continue
      if (typeof remote.maxSize === 'number') local.maxSize = remote.maxSize
      if (Array.isArray(remote.accept) && local.accept) {
        replaceSetContents(local.accept, remote.accept)
      }
    }
    _fetched = true
  } catch {
    // 静默降级
  }
}

export function isUploadConfigFetched(): boolean {
  return _fetched
}

// ======================== 扩展名回退（IMAGE 预设专用） ========================

const IMAGE_FILE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.jfif', '.gif', '.webp', '.avif', '.bmp',
  '.tif', '.tiff', '.svg', '.svgz', '.apng', '.heic', '.heif',
])

function getFileExtension(fileName: string | undefined): string {
  if (!fileName) return ''
  const dot = fileName.lastIndexOf('.')
  if (dot <= -1 || dot >= fileName.length - 1) return ''
  return fileName.slice(dot).toLowerCase()
}

// ======================== 校验 & 工具函数 ========================

export function validateUploadFile(
  file: File,
  preset: UploadPresetKey | UploadPreset,
  overrides?: Partial<UploadPreset>,
): FileValidationResult {
  const base = typeof preset === 'string' ? UPLOAD_PRESETS[preset] : preset
  const maxSize = overrides?.maxSize ?? base.maxSize
  const accept = overrides?.accept !== undefined ? overrides.accept : base.accept

  if (accept && !accept.has(file.type)) {
    const isImagePreset = accept === ACCEPTED_IMAGE_MIMES
    if (!isImagePreset || !IMAGE_FILE_EXTENSIONS.has(getFileExtension(file.name))) {
      return { valid: false, reason: 'fileTypeNotAllowed' }
    }
  }
  if (file.size > maxSize) {
    const limitMB = Math.round(maxSize / MB)
    return { valid: false, reason: `fileTooLarge:${limitMB}` }
  }
  return { valid: true }
}

export function isImageMime(mimeType: string): boolean {
  return ACCEPTED_IMAGE_MIMES.has(mimeType)
}

export function isMediaMime(mimeType: string): boolean {
  return ACCEPTED_MEDIA_MIMES.has(mimeType)
}

export function formatFileSize(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const k = 1024
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), units.length - 1)
  return i === 0
    ? `${bytes} ${units[0]}`
    : `${(bytes / Math.pow(k, i)).toFixed(1)} ${units[i]}`
}

export function presetToAcceptString(preset: UploadPresetKey | UploadPreset): string {
  const p = typeof preset === 'string' ? UPLOAD_PRESETS[preset] : preset
  if (!p.accept) return '*/*'
  return Array.from(p.accept).join(',')
}

export const ZIP_ARCHIVE_ACCEPT_TYPES = [
  'application/zip',
  'application/x-zip-compressed',
  '.zip',
] as const

/** OSS 白名单里有、但 IMAGE/DOCUMENT/MEDIA MIME 集未覆盖的扩展名。 */
const ATTACHMENT_PICKER_EXTENSION_FALLBACKS = ['.avi', '.aac', '.flac'] as const

/** 文件选择器 accept：对齐 Agent ChatInput，避免 IMAGE + `*` 在 Electron 里只剩图片 */
export function buildAttachmentPickerAccept(): string {
  return [
    presetToAcceptString('IMAGE'),
    presetToAcceptString('DOCUMENT'),
    presetToAcceptString('MEDIA'),
    ...ZIP_ARCHIVE_ACCEPT_TYPES,
    ...ATTACHMENT_PICKER_EXTENSION_FALLBACKS,
  ].join(',')
}

// 登出时重置拉取标记，确保重新登录后拉取最新配置
registerResetAction('upload-config', 'reset', () => {
  resetUploadConfigFetched()
})
