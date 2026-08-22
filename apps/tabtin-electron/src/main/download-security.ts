/**
 * DownloadSecurity - 下载安全检查
 *
 * 负责危险文件检测、路径安全校验、文件名清理、URL 协议白名单。
 */

import * as path from 'path'
import { realpathSync, existsSync } from 'fs'
import { app, dialog, type BrowserWindow } from 'electron'
import { DOWNLOAD_MESSAGES } from './download-messages'

const DANGEROUS_EXTENSIONS = new Set([
  // Windows 可执行
  'exe', 'msi', 'bat', 'cmd', 'ps1', 'vbs', 'vbe',
  'com', 'scr', 'pif', 'reg', 'hta', 'cpl', 'inf',
  'lnk', 'msp', 'mst', 'sct',
  // Windows Script
  'jse', 'wsf', 'wsh', 'ws',
  // macOS
  'app', 'dmg', 'pkg', 'command',
  // Linux
  'sh', 'deb', 'rpm',
  // 跨平台
  'jar',
  // Office 宏文件
  'docm', 'xlsm', 'pptm',
])

const MAX_FILENAME_LENGTH = 200
const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:'])

export function isDangerousFile(filename: string): boolean {
  const ext = path.extname(filename).slice(1).toLowerCase()
  return DANGEROUS_EXTENSIONS.has(ext)
}

/**
 * When the target path doesn't exist, walk up to find the nearest existing
 * ancestor, resolve it via realpathSync (following symlinks), then re-append
 * the remaining segments. This prevents symlinks in intermediate directories
 * from escaping the allowlist boundary.
 *
 * Returns null when no ancestor can be resolved (e.g. all realpathSync calls
 * fail due to permissions), so the caller can default to denying access
 * instead of falling back to an unresolved path.
 */
function resolveWithNearestRealAncestor(filePath: string): string | null {
  const absolute = path.resolve(filePath)
  let current = absolute
  const trailing: string[] = []

  while (current !== path.dirname(current)) {
    if (existsSync(current)) {
      try {
        const realAncestor = realpathSync(current)
        return trailing.length > 0
          ? path.join(realAncestor, ...trailing)
          : realAncestor
      } catch {
        break
      }
    }
    trailing.unshift(path.basename(current))
    current = path.dirname(current)
  }

  // EEL-015: try the filesystem root as last resort before giving up
  try {
    const realRoot = realpathSync(current)
    return trailing.length > 0
      ? path.join(realRoot, ...trailing)
      : realRoot
  } catch {
    return null
  }
}

export function isPathSafe(filePath: string, allowedDirs?: string[]): boolean {
  const dirs = allowedDirs ?? [app.getPath('downloads')]
  const normalizedAllowedDirs = dirs
    .map((dir) => {
      try {
        return realpathSync(path.resolve(dir))
      } catch {
        return null
      }
    })
    .filter((dir): dir is string => Boolean(dir))

  // 没有任何可验证的白名单目录时，默认拒绝
  if (normalizedAllowedDirs.length === 0) return false

  const resolvedTarget = (() => {
    try {
      return realpathSync(path.resolve(filePath))
    } catch {
      return resolveWithNearestRealAncestor(filePath)
    }
  })()

  // EEL-015: if resolution failed entirely, deny access
  if (!resolvedTarget) return false

  return normalizedAllowedDirs.some((resolvedDir) =>
    resolvedTarget.startsWith(resolvedDir + path.sep) || resolvedTarget === resolvedDir
  )
}

export function sanitizeFilename(raw: string): string {
  let name = raw.replace(/[\x00-\x1f<>:"/\\|?*]/g, '_')
  if (WINDOWS_RESERVED_NAMES.test(name)) {
    name = `_${name}`
  }
  if (name.length > MAX_FILENAME_LENGTH) {
    const ext = path.extname(name)
    name = name.slice(0, MAX_FILENAME_LENGTH - ext.length) + ext
  }
  return name || 'download'
}

export function normalizeDownloadFilename(raw: string, fallback = 'download'): string {
  const candidate = (raw || '').trim() || fallback
  const normalized = candidate.replace(/\\/g, '/')
  const hasPathSegments = normalized.split('/').length > 1
  const hasTraversal = normalized.includes('..')
  const isAbsolute = path.posix.isAbsolute(normalized) || path.win32.isAbsolute(candidate)

  if (hasPathSegments || hasTraversal || isAbsolute) {
    throw new Error(DOWNLOAD_MESSAGES.pathUnsafe)
  }

  return sanitizeFilename(path.basename(candidate))
}

export function validateDownloadUrl(url: string): { valid: boolean; error?: string } {
  try {
    const urlObj = new URL(url)
    if (!ALLOWED_PROTOCOLS.has(urlObj.protocol)) {
      return { valid: false, error: DOWNLOAD_MESSAGES.unsupportedProtocol }
    }
    return { valid: true }
  } catch {
    return { valid: false, error: DOWNLOAD_MESSAGES.invalidUrl }
  }
}

export async function confirmDangerousDownload(
  win: BrowserWindow | null,
  filename: string
): Promise<boolean> {
  const options: Electron.MessageBoxOptions = {
    type: 'warning',
    buttons: [...DOWNLOAD_MESSAGES.dangerousButtons],
    defaultId: 1,
    cancelId: 1,
    title: DOWNLOAD_MESSAGES.dangerousTitle,
    message: DOWNLOAD_MESSAGES.dangerousMessage(filename),
    detail: DOWNLOAD_MESSAGES.dangerousDetail,
  }
  const result = win
    ? await dialog.showMessageBox(win, options)
    : await dialog.showMessageBox(options)
  return result.response === 0
}
