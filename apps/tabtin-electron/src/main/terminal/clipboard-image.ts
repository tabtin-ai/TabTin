/**
 * clipboard-image.ts - 终端图片粘贴：主进程侧保存逻辑
 *
 * 将渲染进程传来的图片 buffer 保存到本地文件系统，
 * 返回绝对路径供终端使用。
 */

import { join } from 'path'
import { getHomeTabtinPath } from '@tabtin/shared/storage-paths'
import { mkdir, writeFile, readdir, stat, rm } from 'fs/promises'
import { createHash } from 'crypto'

const MAX_IMAGE_SIZE = 10 * 1024 * 1024 // 10MB
// Base64 编码比率约 4:3，10MB 图片 ≈ 13.4MB base64 字符串，留余量取 14MB
const MAX_BASE64_LENGTH = 14 * 1024 * 1024
const CLEANUP_AGE_DAYS = 7

const SAFE_ID_RE = /^[a-zA-Z0-9_-]+$/

const MIME_TO_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/svg+xml': '.svg',
}

function getTerminalImagesBaseDir(): string {
  return getHomeTabtinPath('terminal-images')
}

function formatDate(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function shortHash(buffer: Buffer): string {
  return createHash('md5').update(buffer).digest('hex').slice(0, 8)
}

export interface PasteImageParams {
  imageBase64: string
  mimeType: string
  spaceId?: string
}

export interface PasteImageResult {
  success: boolean
  filePath?: string
  error?: string
}

/**
 * 保存粘贴的图片到本地文件系统
 */
export async function saveClipboardImage(params: PasteImageParams): Promise<PasteImageResult> {
  const { imageBase64, mimeType, spaceId } = params

  const ext = MIME_TO_EXT[mimeType]
  if (!ext) {
    return { success: false, error: `unsupported_mime:${mimeType}` }
  }

  // EM-13: 在 Buffer.from 解码前检查 base64 字符串长度，避免超大数据消耗内存
  if (imageBase64.length > MAX_BASE64_LENGTH) {
    return { success: false, error: `base64_too_large:${imageBase64.length}` }
  }

  const buffer = Buffer.from(imageBase64, 'base64')

  if (buffer.length > MAX_IMAGE_SIZE) {
    return { success: false, error: `too_large:${buffer.length}` }
  }

  if (buffer.length === 0) {
    return { success: false, error: 'empty_image' }
  }

  const now = new Date()
  const dateStr = formatDate(now)
  const baseDir = getTerminalImagesBaseDir()
  const spaceSegment = (spaceId && SAFE_ID_RE.test(spaceId)) ? spaceId : '_default'
  const dir = join(baseDir, spaceSegment, dateStr)

  try {
    await mkdir(dir, { recursive: true })

    const timestamp = now.getTime()
    const hash = shortHash(buffer)
    const filename = `paste-${timestamp}-${hash}${ext}`
    const filePath = join(dir, filename)

    await writeFile(filePath, buffer)

    return { success: true, filePath }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { success: false, error: `write_failed:${message}` }
  }
}

/**
 * 清理过期的终端图片（启动时调用）
 * 删除超过 CLEANUP_AGE_DAYS 天的日期目录
 */
export async function cleanupExpiredImages(): Promise<void> {
  const baseDir = getTerminalImagesBaseDir()

  let spaceDirs: string[]
  try {
    spaceDirs = await readdir(baseDir)
  } catch {
    return // 目录不存在就不处理
  }

  const cutoff = Date.now() - CLEANUP_AGE_DAYS * 24 * 60 * 60 * 1000

  for (const spaceDir of spaceDirs) {
    const spacePath = join(baseDir, spaceDir)
    let dateDirs: string[]
    try {
      const s = await stat(spacePath)
      if (!s.isDirectory()) continue
      dateDirs = await readdir(spacePath)
    } catch {
      continue
    }

    for (const dateDir of dateDirs) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateDir)) continue
      const datePath = join(spacePath, dateDir)
      try {
        const s = await stat(datePath)
        if (s.isDirectory() && s.mtimeMs < cutoff) {
          await rm(datePath, { recursive: true, force: true })
        }
      } catch {
        // ignore
      }
    }

    // 如果 space 目录为空则删除
    try {
      const remaining = await readdir(spacePath)
      if (remaining.length === 0) {
        await rm(spacePath, { recursive: true, force: true })
      }
    } catch {
      // ignore
    }
  }
}
