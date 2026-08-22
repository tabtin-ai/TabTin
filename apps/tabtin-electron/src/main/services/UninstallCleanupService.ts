/**
 * UninstallCleanupService — Windows 卸载相关的登录凭证 / 配置缓存清理。
 *
 * 正式卸程序走 NSIS（installer.nsh）：卸载时一律清 credentials，可选清配置缓存。
 * 本服务供设置页「清除登录凭证 / 清除本地配置与缓存」及卸载前预清理使用。
 *
 * 「清除本地配置与缓存」走重启清理：运行中硬删会撞 EBUSY。
 * 硬边界：绝不删除 organizations（workspace）或任意绑定 working_dir。
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import {
  isProtectedWorkspacePath,
  resolveConfigAndCacheWipePaths,
  resolveCredentialFilePaths,
  resolveUpdaterCachePaths,
  TABTIN_CONFIG_DIR_RELATIVE_PATHS,
  TABTIN_CONFIG_FILE_RELATIVE_PATHS,
  TABTIN_HOME_CONFIG_FILE_RELATIVE_PATHS,
} from '@tabtin/shared'
import { TokenManager } from '../auth'
import { createLogger } from '../logger'
import { guardedHandle } from '../utils/guarded-handle'

const requireFromHere = createRequire(import.meta.url)

const log = createLogger('UninstallCleanup')

/** 落在当前 userData 根下；不在配置/缓存删除清单内，避免被 wipe 自己删掉 */
export const PENDING_LOCAL_DATA_WIPE_FILE = 'pending-local-data-wipe.json'

/** 稳定错误码：UI 只展示对应 i18n，原始 detail 仅写日志 */
export type WipeErrorCode = 'busy' | 'permission' | 'unknown'

export type WipeFailure = {
  path: string
  errorCode: WipeErrorCode
}

export type WipeResult = {
  ok: boolean
  removed: string[]
  failed: WipeFailure[]
  skippedProtected: string[]
  credentialsCleared?: boolean
  /** 已预约重启清理，当前进程即将退出（仅安装包 / 非 electron-vite） */
  willRelaunch?: boolean
  /**
   * 开发模式（pnpm/electron-vite）下无法自动 relaunch：
   * 已写 pending 标记，需用户在终端重启 `pnpm dev`，下次启动会清完。
   */
  needsManualDevRestart?: boolean
}

export type UninstallDesktopOptions = {
  /** 是否同时删除本地配置与缓存（默认 false；凭证始终删除；不含 workspace） */
  deleteLocalData?: boolean
}

const WIPE_RETRY_ATTEMPTS = 3
const WIPE_RETRY_BACKOFF_MS = [50, 150, 350] as const

export function classifyWipeErrorCode(error: unknown): WipeErrorCode {
  const errno =
    typeof error === 'object' && error != null && 'code' in error
      ? String((error as NodeJS.ErrnoException).code)
      : ''
  const message = error instanceof Error ? error.message : String(error)
  const hay = `${errno} ${message}`.toUpperCase()
  if (
    hay.includes('EBUSY') ||
    hay.includes('EAGAIN') ||
    hay.includes('ENOTEMPTY') ||
    hay.includes('RESOURCE BUSY') ||
    hay.includes('LOCKED')
  ) {
    return 'busy'
  }
  if (
    hay.includes('EPERM') ||
    hay.includes('EACCES') ||
    hay.includes('NOT PERMITTED') ||
    hay.includes('ACCESS IS DENIED')
  ) {
    return 'permission'
  }
  return 'unknown'
}

function wipeErrorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

type BeforeWipeHook = () => Promise<void>

/** 由 register 注入；单测不挂 electron，避免 jsdom 模块图污染 */
let beforeWipeHook: BeforeWipeHook | null = null

export function setUninstallCleanupBeforeWipeHook(hook: BeforeWipeHook | null): void {
  beforeWipeHook = hook
}

/**
 * Chromium / Electron 自管目录：session.clear* 后 Windows 上目录句柄仍可能短暂 EBUSY。
 * 逻辑数据已清空时，这类 busy 不应挡住「清凭证」契约。
 */
const SESSION_MANAGED_WIPE_DIR_NAMES = new Set([
  'cache',
  'code cache',
  'gpucache',
  'dawngraphitecache',
  'dawnwebgpucache',
  'partitions',
  'local storage',
  'session storage',
  'indexeddb',
  'network',
  'blob_storage',
  'service worker',
  'webstorage',
  'shared dictionary',
])

export function isSessionManagedWipePath(targetPath: string): boolean {
  const normalized = targetPath.replace(/\\/g, '/').toLowerCase()
  for (const name of SESSION_MANAGED_WIPE_DIR_NAMES) {
    if (normalized.endsWith(`/${name}`) || normalized.includes(`/${name}/`)) {
      return true
    }
  }
  return SESSION_MANAGED_WIPE_DIR_NAMES.has(basename(targetPath).toLowerCase())
}

async function releaseDefaultSessionForWipe(): Promise<boolean> {
  try {
    const { session } = requireFromHere('electron') as typeof import('electron')
    const defaultSession = session?.defaultSession
    if (!defaultSession) return false
    await defaultSession.clearCache()
    await defaultSession.clearStorageData({
      storages: [
        'cookies',
        'localstorage',
        'indexdb',
        'serviceworkers',
        'websql',
        'cachestorage',
      ],
    })
    return true
  } catch (error) {
    log.warn('wipe 前 session 预清理失败（继续磁盘删除）:', error)
    return false
  }
}

async function removePath(
  target: string,
  recursive: boolean,
): Promise<{ removed: boolean; errorCode?: WipeErrorCode }> {
  if (!existsSync(target)) {
    return { removed: false }
  }

  let lastCode: WipeErrorCode = 'unknown'
  for (let attempt = 0; attempt < WIPE_RETRY_ATTEMPTS; attempt++) {
    try {
      await rm(target, { recursive, force: true })
      return { removed: true }
    } catch (error) {
      lastCode = classifyWipeErrorCode(error)
      log.warn('删除路径失败', {
        target,
        attempt: attempt + 1,
        errorCode: lastCode,
        detail: wipeErrorDetail(error),
      })
      const retryable = lastCode === 'busy' || lastCode === 'permission'
      if (retryable && attempt < WIPE_RETRY_ATTEMPTS - 1) {
        await sleep(WIPE_RETRY_BACKOFF_MS[attempt] ?? 350)
        continue
      }
      return { removed: false, errorCode: lastCode }
    }
  }

  return { removed: false, errorCode: lastCode }
}

async function removeCredentialFiles(): Promise<Pick<WipeResult, 'removed' | 'failed' | 'skippedProtected'>> {
  const removed: string[] = []
  const failed: WipeFailure[] = []
  const skippedProtected: string[] = []

  for (const filePath of resolveCredentialFilePaths()) {
    if (isProtectedWorkspacePath(filePath)) {
      skippedProtected.push(filePath)
      continue
    }
    const result = await removePath(filePath, false)
    if (result.removed) {
      removed.push(filePath)
    } else if (result.errorCode) {
      failed.push({ path: filePath, errorCode: result.errorCode })
    }
  }

  return { removed, failed, skippedProtected }
}

/** 删除所有已知 profile 下的 credentials.json，并清空当前进程 auth 缓存 */
export async function wipeLoginCredentials(): Promise<WipeResult> {
  let credentialsCleared = false
  const { removed, failed, skippedProtected } = await removeCredentialFiles()

  if (failed.length === 0) {
    try {
      await TokenManager.clearAuthData({ rethrow: true })
      credentialsCleared = true
    } catch (error) {
      failed.push({
        path: 'auth-cache',
        errorCode: classifyWipeErrorCode(error),
      })
      log.warn('TokenManager.clearAuthData 失败:', {
        errorCode: classifyWipeErrorCode(error),
        detail: wipeErrorDetail(error),
      })
    }
  } else {
    log.warn('wipeLoginCredentials 跳过清登录态：磁盘凭证删除失败', {
      failedCount: failed.length,
      failed,
    })
  }

  log.info('wipeLoginCredentials 完成', {
    removedCount: removed.length,
    failedCount: failed.length,
  })
  return {
    ok: credentialsCleared && failed.length === 0,
    removed,
    failed,
    skippedProtected,
    credentialsCleared,
  }
}

function uniqueWipePaths(paths: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const target of paths) {
    const key = target.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(target)
  }
  return out
}

export type LocalDataWipeScope = 'current' | 'all'

/**
 * - `all`：所有已知 profile（卸载勾选本地数据）
 * - `current`：仅当前 userData + ~/.tabtin 配置文件 + updater 缓存（设置页清除按钮）
 */
export function resolveLocalDataWipePaths(
  currentUserDataDir?: string,
  scope: LocalDataWipeScope = 'all',
): string[] {
  if (scope === 'current') {
    if (!currentUserDataDir) {
      return uniqueWipePaths([
        ...TABTIN_HOME_CONFIG_FILE_RELATIVE_PATHS.map((rel) => join(homedir(), '.tabtin', rel)),
        join(homedir(), '.tabtin-daemon'),
        ...resolveUpdaterCachePaths(),
      ])
    }
    const paths: string[] = []
    for (const rel of TABTIN_CONFIG_FILE_RELATIVE_PATHS) {
      paths.push(join(currentUserDataDir, rel))
    }
    for (const rel of TABTIN_CONFIG_DIR_RELATIVE_PATHS) {
      paths.push(join(currentUserDataDir, rel))
    }
    for (const rel of TABTIN_HOME_CONFIG_FILE_RELATIVE_PATHS) {
      paths.push(join(homedir(), '.tabtin', rel))
    }
    paths.push(join(homedir(), '.tabtin-daemon'))
    paths.push(...resolveUpdaterCachePaths())
    return uniqueWipePaths(paths)
  }

  const paths = [...resolveConfigAndCacheWipePaths()]
  if (currentUserDataDir) {
    for (const rel of TABTIN_CONFIG_FILE_RELATIVE_PATHS) {
      paths.push(join(currentUserDataDir, rel))
    }
    for (const rel of TABTIN_CONFIG_DIR_RELATIVE_PATHS) {
      paths.push(join(currentUserDataDir, rel))
    }
  }
  return uniqueWipePaths(paths)
}

export function getPendingLocalDataWipePath(userDataDir: string): string {
  return join(userDataDir, PENDING_LOCAL_DATA_WIPE_FILE)
}

export function hasPendingLocalDataWipe(userDataDir: string): boolean {
  return existsSync(getPendingLocalDataWipePath(userDataDir))
}

export function writePendingLocalDataWipeMarker(userDataDir: string): void {
  const flagPath = getPendingLocalDataWipePath(userDataDir)
  mkdirSync(dirname(flagPath), { recursive: true })
  writeFileSync(
    flagPath,
    JSON.stringify({
      version: 1,
      createdAt: new Date().toISOString(),
    }),
    { encoding: 'utf-8', mode: 0o600 },
  )
}

export function clearPendingLocalDataWipeMarker(userDataDir: string): void {
  const flagPath = getPendingLocalDataWipePath(userDataDir)
  if (existsSync(flagPath)) {
    rmSync(flagPath, { force: true })
  }
}

/**
 * 删除本地配置与缓存（磁盘凭证、app-config、Partitions、Cache、updater 等）。
 * 只有配置/缓存全部删除成功后，才清空当前进程 auth 缓存。
 * 不触碰 organizations workspace，也不触碰用户绑定的 working_dir。
 */
export async function wipeAllLocalData(options?: {
  currentUserDataDir?: string
  /** 设置页 / pending 重启清理用 current；卸载勾选本地数据用 all（默认） */
  scope?: LocalDataWipeScope
}): Promise<WipeResult> {
  const scope = options?.scope ?? 'all'
  const removed: string[] = []
  const failed: WipeFailure[] = []
  const skippedProtected: string[] = []
  let credentialsCleared = false
  const credentialFilePaths = new Set<string>()
  if (scope === 'all') {
    for (const filePath of resolveCredentialFilePaths()) {
      credentialFilePaths.add(filePath.toLowerCase())
    }
  }
  // 当前实例目录（含 TabTin Local-feature-*）走「缓存先清、凭证最后」契约
  if (options?.currentUserDataDir) {
    credentialFilePaths.add(
      join(options.currentUserDataDir, 'credentials.json').toLowerCase(),
    )
  }

  let sessionReleased = false
  if (beforeWipeHook) {
    try {
      await beforeWipeHook()
      sessionReleased = true
    } catch (error) {
      log.warn('wipe 前 hook 失败（继续磁盘删除）:', error)
    }
  } else {
    sessionReleased = await releaseDefaultSessionForWipe()
  }

  for (const targetPath of resolveLocalDataWipePaths(options?.currentUserDataDir, scope)) {
    // 登录凭证必须最后清：缓存/配置任一失败时要保留登录态。
    if (credentialFilePaths.has(targetPath.toLowerCase())) {
      continue
    }
    // 勿删重启清理标记本身
    if (targetPath.toLowerCase().endsWith(PENDING_LOCAL_DATA_WIPE_FILE.toLowerCase())) {
      continue
    }
    if (isProtectedWorkspacePath(targetPath)) {
      skippedProtected.push(targetPath)
      log.warn('跳过受保护 workspace 路径（不应出现在清理清单）:', targetPath)
      continue
    }
    const result = await removePath(targetPath, true)
    if (result.removed) {
      removed.push(targetPath)
    } else if (result.errorCode) {
      failed.push({ path: targetPath, errorCode: result.errorCode })
    }
  }

  // session 已预清时：Chromium 自管目录的 busy 视为软残留，不挡清凭证
  if (sessionReleased && failed.length > 0) {
    const hardFailed: WipeFailure[] = []
    for (const item of failed) {
      if (item.errorCode === 'busy' && isSessionManagedWipePath(item.path)) {
        log.warn('session 已预清，忽略仍占用的 Chromium 目录', item)
        continue
      }
      hardFailed.push(item)
    }
    failed.length = 0
    failed.push(...hardFailed)
  }

  if (failed.length === 0) {
    // current：只删当前实例凭证；all：扫全部已知 profile 凭证文件
    const credentialTargets =
      scope === 'current' && options?.currentUserDataDir
        ? [join(options.currentUserDataDir, 'credentials.json')]
        : resolveCredentialFilePaths()

    const credentialRemoved: string[] = []
    const credentialFailed: WipeFailure[] = []
    for (const filePath of credentialTargets) {
      if (isProtectedWorkspacePath(filePath)) {
        skippedProtected.push(filePath)
        continue
      }
      const result = await removePath(filePath, false)
      if (result.removed) credentialRemoved.push(filePath)
      else if (result.errorCode) {
        credentialFailed.push({ path: filePath, errorCode: result.errorCode })
      }
    }
    removed.push(...credentialRemoved)
    failed.push(...credentialFailed)

    if (credentialFailed.length === 0) {
      try {
        await TokenManager.clearAuthData({ rethrow: true })
        credentialsCleared = true
      } catch (error) {
        failed.push({
          path: 'auth-cache',
          errorCode: classifyWipeErrorCode(error),
        })
        log.warn('TokenManager.clearAuthData 失败:', {
          errorCode: classifyWipeErrorCode(error),
          detail: wipeErrorDetail(error),
        })
      }
    } else {
      log.warn('wipeAllLocalData 跳过清登录态：磁盘凭证删除失败', {
        failedCount: credentialFailed.length,
        failed: credentialFailed,
      })
    }
  } else {
    log.warn('wipeAllLocalData 跳过清登录态：配置/缓存删除失败', {
      failedCount: failed.length,
      failed,
    })
  }

  log.info('wipeAllLocalData(config+cache) 完成', {
    removedCount: removed.length,
    failedCount: failed.length,
    skippedProtected: skippedProtected.length,
  })
  return { ok: failed.length === 0, removed, failed, skippedProtected, credentialsCleared }
}

/**
 * Windows 卸载前预清理：必清凭证 → 可选配置/缓存。
 * 不卸载程序本身；卸程序请走「设置 → 应用」/ NSIS。
 */
export async function uninstallDesktopApp(
  options: UninstallDesktopOptions = {},
): Promise<{
  ok: boolean
  credentials: WipeResult
  localData: WipeResult | null
  willExit: boolean
}> {
  const deleteLocalData = Boolean(options.deleteLocalData)
  const localData = deleteLocalData ? await wipeAllLocalData() : null
  const credentials = deleteLocalData
    ? {
        ok: localData?.credentialsCleared === true,
        removed: [],
        failed: localData?.credentialsCleared === true
          ? []
          : [{ path: 'credentials', errorCode: 'unknown' as const }],
        skippedProtected: [],
        credentialsCleared: localData?.credentialsCleared === true,
      }
    : await wipeLoginCredentials()
  const ok = deleteLocalData ? Boolean(localData?.ok && credentials.ok) : credentials.ok

  log.info('uninstallDesktopApp(pre-clean) 完成', { deleteLocalData, ok })
  return { ok, credentials, localData, willExit: false }
}

function getElectronApp(): typeof import('electron').app {
  const { app } = requireFromHere('electron') as typeof import('electron')
  return app
}

/** electron-vite / pnpm dev：父进程是 vite，app.relaunch+exit 会关窗且无法自动拉回 */
function isElectronViteDevRuntime(app: { isPackaged: boolean }): boolean {
  return !app.isPackaged || Boolean(process.env.ELECTRON_RENDERER_URL)
}

/**
 * 设置页「清除本地配置与缓存」：
 * - 安装包：写标记 → relaunch → exit，下次启动极早阶段删除
 * - pnpm/electron-vite：禁止 exit（会带走父进程）；先进程内清，失败则写标记并提示手动重启
 */
export async function scheduleLocalDataWipeAndRelaunch(): Promise<WipeResult> {
  const app = getElectronApp()
  const userDataDir = app.getPath('userData')

  if (isElectronViteDevRuntime(app)) {
    log.info('开发模式：优先进程内清理（避免 relaunch 关掉 electron-vite）', {
      userDataDir,
    })
    const inProcess = await wipeAllLocalData({
      currentUserDataDir: userDataDir,
      scope: 'current',
    })
    if (inProcess.ok) {
      return { ...inProcess, willRelaunch: false, needsManualDevRestart: false }
    }

    try {
      writePendingLocalDataWipeMarker(userDataDir)
    } catch (error) {
      log.error('开发模式写入 pending wipe 标记失败:', {
        errorCode: classifyWipeErrorCode(error),
        detail: wipeErrorDetail(error),
      })
      return {
        ...inProcess,
        willRelaunch: false,
        needsManualDevRestart: false,
      }
    }

    log.info('开发模式：进程内清理未完成，已预约下次 pnpm dev 启动清理', {
      failedCount: inProcess.failed.length,
    })
    return {
      ...inProcess,
      // 对 UI：不算硬失败黑盒，引导手动重启；窗口保持打开
      ok: false,
      willRelaunch: false,
      needsManualDevRestart: true,
    }
  }

  try {
    writePendingLocalDataWipeMarker(userDataDir)
  } catch (error) {
    log.error('写入 pending wipe 标记失败:', {
      errorCode: classifyWipeErrorCode(error),
      detail: wipeErrorDetail(error),
    })
    return {
      ok: false,
      removed: [],
      failed: [{ path: getPendingLocalDataWipePath(userDataDir), errorCode: classifyWipeErrorCode(error) }],
      skippedProtected: [],
      credentialsCleared: false,
      willRelaunch: false,
    }
  }

  log.info('已预约重启清理本地配置与缓存', { userDataDir })
  try {
    app.relaunch()
  } catch (error) {
    log.error('app.relaunch 失败，清除 pending 标记:', error)
    clearPendingLocalDataWipeMarker(userDataDir)
    return {
      ok: false,
      removed: [],
      failed: [{ path: 'relaunch', errorCode: 'unknown' }],
      skippedProtected: [],
      credentialsCleared: false,
      willRelaunch: false,
    }
  }

  // 稍延迟再 exit，确保 IPC 回包能送到 renderer
  setTimeout(() => {
    app.exit(0)
  }, 120)

  return {
    ok: true,
    removed: [],
    failed: [],
    skippedProtected: [],
    credentialsCleared: false,
    willRelaunch: true,
  }
}

/**
 * 启动时消费 pending 标记并执行磁盘清理。须在创建窗口 / 重度使用 session 之前调用。
 * @returns 无标记时 null；有标记时返回 wipe 结果
 */
export async function consumePendingLocalDataWipe(): Promise<WipeResult | null> {
  let userDataDir: string
  try {
    userDataDir = getElectronApp().getPath('userData')
  } catch (error) {
    log.warn('consumePendingLocalDataWipe: 无法读取 userData:', error)
    return null
  }

  if (!hasPendingLocalDataWipe(userDataDir)) {
    return null
  }

  // 先读再清标记，避免 wipe 中途崩溃后无限重启循环；失败可再次手动触发
  try {
    const raw = readFileSync(getPendingLocalDataWipePath(userDataDir), 'utf-8')
    log.info('检测到 pending wipe 标记，开始启动期清理', { raw: raw.slice(0, 200) })
  } catch {
    log.info('检测到 pending wipe 标记，开始启动期清理')
  }

  clearPendingLocalDataWipeMarker(userDataDir)

  // 设置页预约的清理只动当前实例，避免其它 profile（正式版 TabTin 等）被锁导致整单失败
  const result = await wipeAllLocalData({
    currentUserDataDir: userDataDir,
    scope: 'current',
  })
  log.info('启动期本地数据清理完成', {
    ok: result.ok,
    removedCount: result.removed.length,
    failedCount: result.failed.length,
  })
  return result
}

export function registerUninstallCleanupHandlers(): void {
  // 运行时 require('electron')：避免顶层静态 import 破坏 vitest；
  // 也避免相对路径动态 require 在 electron-vite 打包后 MODULE_NOT_FOUND。
  setUninstallCleanupBeforeWipeHook(async () => {
    const ok = await releaseDefaultSessionForWipe()
    if (!ok) {
      throw new Error('defaultSession unavailable or clear failed')
    }
  })

  guardedHandle('desktop:wipe-credentials', async () => wipeLoginCredentials())
  guardedHandle('desktop:wipe-local-data', async () => scheduleLocalDataWipeAndRelaunch())
  guardedHandle(
    'desktop:uninstall-app',
    async (_event, options?: UninstallDesktopOptions) => uninstallDesktopApp(options ?? {}),
  )
  guardedHandle('desktop:list-cleanup-paths', async () => {
    let currentUserDataDir: string | undefined
    try {
      currentUserDataDir = getElectronApp().getPath('userData')
    } catch {
      currentUserDataDir = undefined
    }
    const configAndCache = resolveLocalDataWipePaths(currentUserDataDir, 'current')
    return {
      credentials: currentUserDataDir
        ? [join(currentUserDataDir, 'credentials.json')]
        : resolveCredentialFilePaths(),
      configAndCache,
      fullWipe: configAndCache,
    }
  })
}
