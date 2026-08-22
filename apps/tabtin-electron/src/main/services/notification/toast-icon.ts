/**
 * WinRT toast 图标路径解析。
 *
 * Windows 通知平台在 Electron 进程外解析 file:// URI，读不到 app.asar 虚拟文件系统。
 * 因此必须指向物理文件（extraResources 或 app.asar.unpacked），不能用 asar 内路径。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** 路径是否可被 WinRT / WPN 直接读取（排除 app.asar，保留 app.asar.unpacked）。 */
export function isWinRtReadableFsPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/')
  return !/(?:^|\/)app\.asar(?:\/|$)/.test(normalized)
}

export function resolveWinRtToastIconCandidates(input: {
  resourcesPath?: string | null
  appPath?: string | null
}): string[] {
  const candidates: string[] = []
  const resourcesPath = input.resourcesPath?.trim()
  if (resourcesPath) {
    // electron-builder extraResources → resources/static/icon.png
    candidates.push(join(resourcesPath, 'static', 'icon.png'))
    // 若改为 asarUnpack 的兜底
    candidates.push(join(resourcesPath, 'app.asar.unpacked', 'static', 'icon.png'))
  }
  const appPath = input.appPath?.trim()
  if (appPath) {
    // 开发态：appPath 是真实目录；打包态若落在 asar 内会被 isWinRtReadableFsPath 滤掉
    candidates.push(join(appPath, 'static', 'icon.png'))
  }
  return candidates
}

export function resolveWinRtToastIconFileUrl(input: {
  resourcesPath?: string | null
  appPath?: string | null
  existsSync?: (path: string) => boolean
}): string | undefined {
  const exists = input.existsSync ?? existsSync
  for (const candidate of resolveWinRtToastIconCandidates(input)) {
    if (!exists(candidate)) continue
    if (!isWinRtReadableFsPath(candidate)) continue
    return pathToFileURL(candidate).href
  }
  return undefined
}
