import * as path from 'path'
import * as fs from 'fs'

/**
 * 为文件路径生成唯一名称（不覆盖已存在文件）。
 * 例如 "video.ts" → "video (1).ts" → "video (2).ts"
 */
export function getUniquePath(filePath: string): string {
  if (!fs.existsSync(filePath)) return filePath

  const dir = path.dirname(filePath)
  const ext = path.extname(filePath)
  const base = path.basename(filePath, ext)

  for (let i = 1; i < 1000; i++) {
    const candidate = path.join(dir, `${base} (${i})${ext}`)
    if (!fs.existsSync(candidate)) return candidate
  }

  return path.join(dir, `${base}_${Date.now()}${ext}`)
}

/**
 * 将字节数格式化为可读字符串（B / KB / MB / GB）
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1)
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`
}
