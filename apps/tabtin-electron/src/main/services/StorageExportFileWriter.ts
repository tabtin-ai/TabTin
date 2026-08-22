/**
 * StorageExportFileWriter — D-5 §6 把 storage-manager 导出 payload
 * 落地到 `~/Downloads/TabTin/exports/` 的主进程 IPC handler。
 *
 * ## 为什么走主进程
 *
 * 1. **可寻址路径**：`~/Downloads/TabTin/exports/storage-{bucketId}-{ts}.json`
 *    在所有平台都是用户能直接打开的"约定俗成"位置；浏览器原生
 *    `a.click` 下载只能落到默认 Downloads 根目录，不能精准放子目录。
 * 2. **路径安全**：渲染进程不能写任意路径——本 handler 在主进程做
 *    `path.resolve` + 前缀校验，把所有写入约束在 `app.getPath('downloads')
 *    /TabTin/exports/` 下，绝不外溢。
 * 3. **审计能容**：写盘前 log 一下 bucketId / size，方便用户事后排查。
 *
 * ## 文件名约束
 *
 * 入参 `filename` 必须是**纯文件名**（无路径分隔符）。任何包含
 * `..` / `/` / `\` 的入参一律拒绝。最终落地路径由本 handler 拼接：
 *
 *   `app.getPath('downloads') + '/TabTin/exports/' + sanitize(filename)`
 *
 * ## 同名文件
 *
 * 用户可能 1 分钟内重复点同一 bucket 的导出按钮。同名直接 overwrite，
 * 不做版本号自动增量——上层 helper（exportToFile.ts）已经在文件名里
 * 编了 ISO timestamp（精确到毫秒），实际不会撞名。
 */

import path from 'node:path'
import fsp from 'node:fs/promises'
import { app, ipcMain } from 'electron'
import { guardedHandle } from '../utils/guarded-handle'
import { createLogger } from '../logger'

const log = createLogger('StorageExportFileWriter')

const CHANNEL_SAVE_EXPORT = 'storage-manager:save-export'
const CHANNEL_RESOLVE_EXPORT_DIR = 'storage-manager:resolve-export-dir'
const SUBDIR = path.join('TabTin', 'exports')

/** 渲染进程传入的 export 落地 payload。 */
export interface SaveExportPayload {
  /** 纯文件名（不含路径分隔符），由 exportFn 的 filename 字段透传 */
  filename: string
  /** 文件内容，按 encoding 解读 */
  data: string
  /** 'utf-8' → JSON 文本；'base64' → 二进制 base64 */
  encoding: 'utf-8' | 'base64'
  /** MIME 类型（仅供日志，落盘时不参与） */
  mimeType?: string
  /** 来源 bucket id，仅供日志 / 审计 */
  bucketId?: string
}

export type SaveExportResult =
  | { success: true; absolutePath: string; bytes: number }
  | { success: false; error: string }

/** Windows 保留设备名（带或不带后缀都不可写）—— sanitize 时拒绝。 */
const WINDOWS_RESERVED_NAMES = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i

function _sanitizeFilename(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  // 拒绝路径分隔符与 `..`，避免目录穿越
  if (trimmed.includes('/') || trimmed.includes('\\')) return null
  if (trimmed.includes('..')) return null
  // 拒绝 NUL 字节与 < > : " | ? * 等 Windows 非法字符
  if (/[<>:"|?*\u0000]/.test(trimmed)) return null
  // 拒绝 Windows 保留设备名（CON / PRN / AUX / NUL / COM1-9 / LPT1-9）
  if (WINDOWS_RESERVED_NAMES.test(trimmed)) return null
  // 长度上限：磁盘文件名通常 ≤ 255。截到 240 留余量。
  return trimmed.length > 240 ? trimmed.slice(0, 240) : trimmed
}

/** 解析最终落盘根目录：`{downloads}/TabTin/exports/`。 */
function resolveExportDir(): string {
  const downloads = app.getPath('downloads')
  return path.join(downloads, SUBDIR)
}

/**
 * 主进程注册 IPC：
 *   - `storage-manager:save-export(payload)` → 写文件到 `~/Downloads/TabTin/exports/`
 *   - `storage-manager:resolve-export-dir()` → 返回上述目录的绝对路径（UI 展示）
 *
 * 幂等：重复调用会 removeHandler 再注册（HMR 友好）。
 */
export function registerStorageExportFileWriter(): void {
  // 幂等：先卸载旧 handler，避免 HMR 抛 "second handler"
  try {
    ipcMain.removeHandler(CHANNEL_SAVE_EXPORT)
    ipcMain.removeHandler(CHANNEL_RESOLVE_EXPORT_DIR)
  } catch { /* removeHandler 抛错可忽略——首次注册 */ }

  guardedHandle(CHANNEL_SAVE_EXPORT, async (_event, payload: unknown): Promise<SaveExportResult> => {
    if (!payload || typeof payload !== 'object') {
      return { success: false, error: 'payload must be an object' }
    }
    const p = payload as SaveExportPayload
    const filename = _sanitizeFilename(p.filename)
    if (!filename) {
      return {
        success: false,
        error: 'filename invalid: must be a non-empty string without path separators / "..", or unsafe chars',
      }
    }
    if (typeof p.data !== 'string') {
      return { success: false, error: 'data must be a string (utf-8 or base64 encoded)' }
    }
    if (p.encoding !== 'utf-8' && p.encoding !== 'base64') {
      return { success: false, error: `encoding must be 'utf-8' or 'base64', got ${JSON.stringify(p.encoding)}` }
    }

    let buffer: Buffer
    try {
      buffer = p.encoding === 'base64'
        ? Buffer.from(p.data, 'base64')
        : Buffer.from(p.data, 'utf-8')
    } catch (err) {
      return {
        success: false,
        error: `decode failed: ${err instanceof Error ? err.message : String(err)}`,
      }
    }

    const exportDir = resolveExportDir()
    const absolutePath = path.join(exportDir, filename)

    // 二次校验：sanitize 之后 join 出来的绝对路径必须在 exportDir 下
    const resolved = path.resolve(absolutePath)
    const resolvedDir = path.resolve(exportDir) + path.sep
    if (!resolved.startsWith(resolvedDir)) {
      return { success: false, error: 'resolved path escapes export directory (sanitizer regression?)' }
    }

    try {
      await fsp.mkdir(exportDir, { recursive: true })
      await fsp.writeFile(absolutePath, buffer)
      log.info(`saved export bucket=${p.bucketId ?? '<unknown>'} bytes=${buffer.length} path=${absolutePath}`)
      return { success: true, absolutePath, bytes: buffer.length }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error(`save failed: ${msg} path=${absolutePath}`)
      return { success: false, error: msg }
    }
  })

  guardedHandle(CHANNEL_RESOLVE_EXPORT_DIR, async (): Promise<{ absolutePath: string }> => {
    return { absolutePath: resolveExportDir() }
  })
}

/** 仅供测试：unit test 直接调 _sanitizeFilename / resolveExportDir 校验逻辑。 */
export const __internal = {
  sanitizeFilename: _sanitizeFilename,
  resolveExportDir,
  CHANNEL_SAVE_EXPORT,
  CHANNEL_RESOLVE_EXPORT_DIR,
}
