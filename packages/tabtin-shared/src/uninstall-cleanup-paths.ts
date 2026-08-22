/**
 * uninstall-cleanup-paths — 卸载 / 重置时要清理的本地路径 SSoT。
 *
 * Windows NSIS、macOS 卸载助手、Electron 主进程 purge IPC 都必须对齐本清单。
 *
 * ## 硬边界（产品约束）
 *
 * 只允许删除**配置 / 凭证 / 缓存**类数据。
 * **禁止**删除：
 *   - `{userData|platformBase}/organizations/**`（默认 workspace 目录下的用户项目文件）
 *   - Agent / Space 绑定的任意本机 `working_dir`（用户自己的静态目录，可能在安装目录外）
 *   - `platform-data` 下的用户产物（sites / downloads 等）——本期也不进清理清单
 *   - `~/.tabtin/checkpoints`、`file-history` 等可能含用户文件快照的目录
 *
 * ## 策略
 *
 *   1. 卸载时一律删除各 profile 下的 credentials.json
 *   2. 用户勾选「删除本地配置与缓存」时，只删本模块列出的配置文件 / 缓存子目录
 *   3. 升级安装不清任何东西
 */

import os from 'node:os'
import path from 'node:path'

/** Electron userData 目录名（与 app-identity.userDataDirName 对齐，含历史遗留） */
export const TABTIN_USER_DATA_DIR_NAMES = [
  'TabTin',
  'TabTin Dev',
  'TabTin Local',
  'TabTin Preprod',
  'tabtin-electron',
] as const

export type TabTinUserDataDirName = (typeof TABTIN_USER_DATA_DIR_NAMES)[number]

/** 登录凭证落盘文件名（safe-credential-store） */
export const CREDENTIALS_FILE_NAME = 'credentials.json'
/** 设备执行身份；默认卸载保留，与 installation fingerprint 同生命周期。 */
export const DEVICE_CREDENTIAL_FILE_NAME = 'device-credential.json'

/**
 * 受保护目录名：出现在 userData / platformBase 下时，清理逻辑不得递归删除。
 * `organizations` = 默认 workspace 根（用户项目静态文件）。
 */
export const TABTIN_PROTECTED_DIR_NAMES = ['organizations'] as const

/** userData 根下可删的配置文件（相对路径） */
export const TABTIN_CONFIG_FILE_RELATIVE_PATHS = [
  CREDENTIALS_FILE_NAME,
  DEVICE_CREDENTIAL_FILE_NAME,
  'app-config.json',
  'device-fingerprint.json',
  'Preferences',
  'Local State',
  'Network Persistent State',
  'TransportSecurity',
  'Cookies',
  'Cookies-journal',
] as const

/**
 * userData 根下可删的配置 / 缓存目录（相对路径）。
 * 不含 organizations、platform-data。
 */
export const TABTIN_CONFIG_DIR_RELATIVE_PATHS = [
  'mcp',
  'organization-configs',
  'logs',
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'Partitions',
  'Local Storage',
  'Session Storage',
  'IndexedDB',
  'blob_storage',
  'Network',
  'agent-sync',
  'Service Worker',
  'WebStorage',
] as const

/** ~/.tabtin 下仅允许删除的配置文件（不含 checkpoints / file-history） */
export const TABTIN_HOME_CONFIG_FILE_RELATIVE_PATHS = [
  'desktop-approval.json',
  'server.json',
  'cli.sock',
] as const

/** electron-updater / electron-builder 可能留下的 updater 缓存目录名 */
export const TABTIN_UPDATER_CACHE_DIR_NAMES = [
  'com.tabtin.app-updater',
  'com.tabtin.app.dev-updater',
  'com.tabtin.app.local-updater',
  'com.tabtin.app.preprod-updater',
  'TabTin-updater',
  'TabTin Dev-updater',
  'TabTin Local-updater',
  'TabTin Preprod-updater',
] as const

/** macOS /Applications 下可能存在的 .app 名（卸载助手移入废纸篓用） */
export const TABTIN_MAC_APP_BUNDLE_NAMES = [
  'TabTin.app',
  'TabTin Local.app',
  'TabTin Dev.app',
] as const

export interface UninstallPathResolveOptions {
  /** 覆盖 homedir（测试用） */
  homeDir?: string
  /** 覆盖 Electron appData 根（测试用）；默认按平台决议 */
  appDataRoot?: string
  /** 覆盖 LocalAppData / Caches 根（测试用） */
  localCacheRoot?: string
}

/**
 * Electron `app.getPath('appData')` 等价根：
 *   - macOS: ~/Library/Application Support
 *   - Windows: %APPDATA%
 *   - Linux: ~/.config
 */
export function getElectronAppDataRoot(options: UninstallPathResolveOptions = {}): string {
  if (options.appDataRoot) return path.resolve(options.appDataRoot)
  const home = options.homeDir ?? os.homedir()
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support')
  }
  if (process.platform === 'win32') {
    return process.env.APPDATA || path.join(home, 'AppData', 'Roaming')
  }
  return process.env.XDG_CONFIG_HOME || path.join(home, '.config')
}

/**
 * updater / 本地缓存父目录：
 *   - macOS: ~/Library/Caches
 *   - Windows: %LOCALAPPDATA%
 *   - Linux: ~/.cache
 */
export function getLocalCacheRoot(options: UninstallPathResolveOptions = {}): string {
  if (options.localCacheRoot) return path.resolve(options.localCacheRoot)
  const home = options.homeDir ?? os.homedir()
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Caches')
  }
  if (process.platform === 'win32') {
    return process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
  }
  return process.env.XDG_CACHE_HOME || path.join(home, '.cache')
}

/** 各 profile 下 credentials.json 的绝对路径（卸载时一律删除） */
export function resolveCredentialFilePaths(
  options: UninstallPathResolveOptions = {},
): string[] {
  const appData = getElectronAppDataRoot(options)
  return TABTIN_USER_DATA_DIR_NAMES.map((name) =>
    path.join(appData, name, CREDENTIALS_FILE_NAME),
  )
}

/** updater 缓存目录绝对路径 */
export function resolveUpdaterCachePaths(
  options: UninstallPathResolveOptions = {},
): string[] {
  const cacheRoot = getLocalCacheRoot(options)
  return TABTIN_UPDATER_CACHE_DIR_NAMES.map((name) => path.join(cacheRoot, name))
}

/**
 * 勾选「删除本地配置与缓存」时要删除的路径（文件 + 目录，去重后）。
 *
 * 只含配置 / 缓存；**绝不**包含 organizations（workspace）或绑定 working_dir。
 */
export function resolveConfigAndCacheWipePaths(
  options: UninstallPathResolveOptions = {},
): string[] {
  const home = options.homeDir ?? os.homedir()
  const appData = getElectronAppDataRoot(options)
  const paths: string[] = []

  for (const profile of TABTIN_USER_DATA_DIR_NAMES) {
    const root = path.join(appData, profile)
    for (const rel of TABTIN_CONFIG_FILE_RELATIVE_PATHS) {
      paths.push(path.join(root, rel))
    }
    for (const rel of TABTIN_CONFIG_DIR_RELATIVE_PATHS) {
      paths.push(path.join(root, rel))
    }
  }

  const homeTabtin = path.join(home, '.tabtin')
  for (const rel of TABTIN_HOME_CONFIG_FILE_RELATIVE_PATHS) {
    paths.push(path.join(homeTabtin, rel))
  }

  // Daemon 私有目录全是配置，可整目录删除
  paths.push(path.join(home, '.tabtin-daemon'))
  paths.push(...resolveUpdaterCachePaths(options))

  return uniqueAbsolutePaths(paths)
}

/**
 * @deprecated 使用 resolveConfigAndCacheWipePaths。保留别名避免调用方短暂漂移。
 * 语义已改为「仅配置与缓存」，不再删除 workspace。
 */
export function resolveFullWipeDirectoryPaths(
  options: UninstallPathResolveOptions = {},
): string[] {
  return resolveConfigAndCacheWipePaths(options)
}

/** 判断某绝对路径是否落在受保护的 workspace 树下（禁止删除） */
export function isProtectedWorkspacePath(
  targetPath: string,
  options: UninstallPathResolveOptions = {},
): boolean {
  const resolved = path.resolve(targetPath)
  const appData = getElectronAppDataRoot(options)
  const home = options.homeDir ?? os.homedir()

  const candidates = [
    ...TABTIN_USER_DATA_DIR_NAMES.map((name) =>
      path.join(appData, name, 'organizations'),
    ),
    path.join(home, 'Library', 'Application Support', 'TabTin', 'organizations'),
    path.join(appData, 'TabTin', 'organizations'),
    path.join(home, '.tabtin', 'organizations'),
  ]

  for (const orgRoot of uniqueAbsolutePaths(candidates)) {
    const prefix = orgRoot.endsWith(path.sep) ? orgRoot : orgRoot + path.sep
    if (resolved === orgRoot || resolved.startsWith(prefix)) {
      return true
    }
    // Windows 大小写不敏感
    if (process.platform === 'win32') {
      const lower = resolved.toLowerCase()
      const orgLower = orgRoot.toLowerCase()
      const prefixLower = orgLower.endsWith(path.sep) ? orgLower : orgLower + path.sep
      if (lower === orgLower || lower.startsWith(prefixLower)) return true
    }
  }
  return false
}

/** macOS /Applications 下候选 App bundle 路径 */
export function resolveMacAppBundlePaths(): string[] {
  return TABTIN_MAC_APP_BUNDLE_NAMES.map((name) => path.join('/Applications', name))
}

function uniqueAbsolutePaths(paths: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const p of paths) {
    const resolved = path.resolve(p)
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved
    if (seen.has(key)) continue
    seen.add(key)
    out.push(resolved)
  }
  return out
}
