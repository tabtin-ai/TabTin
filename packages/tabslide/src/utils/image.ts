/**
 * 图片粘贴/拖放相关工具函数
 *
 * 提供剪贴板图片检测、文件提取、尺寸约束、上传等能力，
 * 供 useClipboardPaste / useImageDrop / SlideInsertPanel 复用。
 */

import { createElementId } from './id'

// ── MIME 检测 ──

const ACCEPTED_IMAGE_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/svg+xml',
  'image/bmp',
  'image/x-ms-bmp',
  'image/tiff',
  'image/heic',
  'image/heif',
  'image/apng',
])

function isAcceptedImageMime(mime: string): boolean {
  const normalized = mime.trim().toLowerCase()
  return ACCEPTED_IMAGE_MIMES.has(normalized)
}
import type { PPTImageElement } from '../types/slides'

// ── 常量 ──

const MAX_IMAGE_W = 800
const MAX_IMAGE_H = 600
const MAX_FILE_SIZE = 20 * 1024 * 1024 // 20MB (aligned with TabDoc)
const IMAGE_LOAD_TIMEOUT = 30_000 // 30s

const IMAGE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif',
  '.bmp', '.tif', '.tiff', '.svg', '.heic', '.heif', '.apng',
])

function getFileExtension(name: string | undefined): string {
  if (!name) return ''
  const dot = name.lastIndexOf('.')
  if (dot <= -1 || dot >= name.length - 1) return ''
  return name.slice(dot).toLowerCase()
}

const MIME_TO_EXT: Record<string, string> = {
  'image/svg+xml': 'svg',
  'image/jpeg': 'jpg',
  'image/tiff': 'tiff',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
}

export function mimeToExtension(mime: string): string {
  if (MIME_TO_EXT[mime]) return MIME_TO_EXT[mime]
  const sub = mime.split('/')[1]
  return sub || 'png'
}

// ── 剪贴板检测 ──

export function hasClipboardImage(e: ClipboardEvent): boolean {
  const items = e.clipboardData?.items
  if (!items) return false
  for (let i = 0; i < items.length; i++) {
    if (items[i].type.startsWith('image/')) return true
  }
  return false
}

export function isEditableTarget(e: ClipboardEvent | DragEvent): boolean {
  const target = e.target as HTMLElement | null
  if (!target) return false
  const tag = target.tagName?.toLowerCase()
  if (tag === 'input' || tag === 'textarea') return true
  if (target.isContentEditable) return true
  if (
    target.closest?.('.tiptap') ||
    target.closest?.('.ProseMirror') ||
    target.closest?.('[data-tabslide-text-editor]')
  ) return true
  return false
}

export function extractImageFile(e: ClipboardEvent): File | null {
  const items = e.clipboardData?.items
  if (!items) return null
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (item.type.startsWith('image/')) {
      const blob = item.getAsFile()
      if (blob) {
        const ext = mimeToExtension(item.type)
        return new File([blob], `pasted-image-${Date.now()}.${ext}`, { type: item.type })
      }
    }
  }
  return null
}

export async function readClipboardImageFile(): Promise<File | null> {
  if (typeof navigator === 'undefined' || !navigator.clipboard?.read) return null
  try {
    const items = await navigator.clipboard.read()
    for (const item of items) {
      const imageType = item.types.find((t) => t.startsWith('image/'))
      if (!imageType) continue
      const blob = await item.getType(imageType)
      const ext = mimeToExtension(imageType)
      return new File([blob], `pasted-image-${Date.now()}.${ext}`, { type: imageType })
    }
  } catch {
    // Permission denied / unsupported / user gesture mismatch
  }
  return null
}

// ── 校验 ──

export interface ImageValidationResult {
  valid: boolean
  reason?: string
}

export function validateImageFile(file: File): ImageValidationResult {
  if (!isAcceptedImageMime(file.type) && !IMAGE_EXTENSIONS.has(getFileExtension(file.name))) {
    return { valid: false, reason: 'not_image' }
  }
  if (file.size > MAX_FILE_SIZE) {
    return { valid: false, reason: 'too_large' }
  }
  return { valid: true }
}

// ── 尺寸约束 ──

const SVG_FALLBACK_W = 400
const SVG_FALLBACK_H = 300

export function constrainImageSize(
  naturalW: number,
  naturalH: number,
  maxW = MAX_IMAGE_W,
  maxH = MAX_IMAGE_H,
): { width: number; height: number } {
  const w = naturalW > 0 ? naturalW : SVG_FALLBACK_W
  const h = naturalH > 0 ? naturalH : SVG_FALLBACK_H
  const scale = Math.min(maxW / w, maxH / h, 1)
  return {
    width: Math.round(w * scale),
    height: Math.round(h * scale),
  }
}

// ── 图片元素创建 ──

export interface InsertImageOptions {
  x?: number
  y?: number
  canvasWidth?: number
  canvasHeight?: number
  offlinePendingUpload?: boolean
}

/**
 * 加载图片获取真实尺寸，然后创建 PPTImageElement。
 * 默认居中放置在画布上。带 30 秒超时保护。
 */
export function createImageElement(
  src: string,
  options: InsertImageOptions = {},
): Promise<PPTImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const timer = setTimeout(() => {
      img.onload = null
      img.onerror = null
      reject(new Error('Image load timeout'))
    }, IMAGE_LOAD_TIMEOUT)

    img.onload = () => {
      clearTimeout(timer)
      const { width, height } = constrainImageSize(img.naturalWidth, img.naturalHeight)
      const cw = options.canvasWidth ?? 1280
      const ch = options.canvasHeight ?? 720
      const x = options.x ?? Math.max(0, Math.round((cw - width) / 2))
      const y = options.y ?? Math.max(0, Math.round((ch - height) / 2))
      resolve({
        id: createElementId(),
        type: 'image',
        x,
        y,
        width,
        height,
        rotate: 0,
        opacity: 1,
        locked: false,
        fixedRatio: true,
        src,
        ...(options.offlinePendingUpload ? { offlinePendingUpload: true } : {}),
      })
    }
    img.onerror = () => {
      clearTimeout(timer)
      reject(new Error('Failed to load image'))
    }
    img.src = src
  })
}

export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('Failed to read file'))
    reader.onload = () => {
      const result = reader.result
      if (typeof result === 'string') {
        resolve(result)
      } else {
        reject(new Error('Failed to encode file'))
      }
    }
    reader.readAsDataURL(file)
  })
}

// ── 图片文件类型检测 ──

export function isImageFile(file: File): boolean {
  return isAcceptedImageMime(file.type) || IMAGE_EXTENSIONS.has(getFileExtension(file.name))
}

// ── 上传解析（统一入口） ──

/**
 * 将图片文件转换为可访问的 URL。
 * 有 onUploadImage 时上传到 OSS，失败或无回调时 fallback 为 base64。
 * 返回 { src, fallback } 标记是否降级。
 */
export async function resolveImageSrc(
  file: File,
  onUploadImage?: (file: File) => Promise<string>,
): Promise<{ src: string; fallback: boolean }> {
  if (onUploadImage) {
    try {
      const src = await onUploadImage(file)
      return { src, fallback: false }
    } catch {
      // upload failed, fallback to base64
    }
  }
  const src = await fileToDataUrl(file)
  return { src, fallback: true }
}
