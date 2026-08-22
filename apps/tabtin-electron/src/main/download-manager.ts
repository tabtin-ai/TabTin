/**
 * DownloadManager - 统一下载管理器
 *
 * 核心编排：拦截 will-download → 跟踪进度/状态 → IPC 通信 → 委托持久化/安全/通知子模块
 */

import { app, session, shell, BrowserWindow, type DownloadItem, type Session } from 'electron'
import { guardedHandle } from './utils/guarded-handle'
import * as path from 'path'
import { access } from 'fs/promises'
import { existsSync, mkdirSync } from 'fs'
import { constants as fsConstants } from 'fs'
import { unlink } from 'fs/promises'
import { errResponse, okResponse } from '@tabtin/agent-wire'

import { DownloadIPCChannels, type DownloadItemData, type DownloadIPCResult } from '@shared/types/download'
import { DownloadPersistence } from './download-persistence'
import { DownloadNotifier } from './download-notifier'
import {
  isDangerousFile,
  isPathSafe,
  sanitizeFilename,
  validateDownloadUrl,
  confirmDangerousDownload,
} from './download-security'
import { getUniquePath } from './utils/file-path'
import { sanitizePathSegment } from './utils/path-sanitize'
import { DOWNLOAD_MESSAGES } from './download-messages'
import { resolveSpacesRoot, resolvePlatformDataRoot, resolveDataRoot } from '@tabtin/terminal-core'
import { resolveWorkspaceDownloadsDir } from '@tabtin/agent-runtime'
import { getCLIOrganizationId } from './cli/cli-context'
import { logger } from './utils/logger'
import { getStreamDownloadService } from './services/StreamDownloadService'
import { getViewFactory } from './view-factory'
import { TokenManager } from './auth'

export type { DownloadInfo } from '@shared/types/download'

// ==================== 常量 ====================

const PROGRESS_THROTTLE_MS = 250
const SPEED_EMA_ALPHA = 0.3
const SPEED_MIN_SAMPLE_INTERVAL_S = 0.5

// ==================== 工具函数 ====================

function validateId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && id.length < 64
}

// ==================== DownloadManager 类 ====================

class DownloadManager {
  private static instance: DownloadManager | null = null

  private activeItems = new Map<string, DownloadItem>()
  private downloads = new Map<string, DownloadItemData>()
  private registeredSessions = new WeakSet<Session>()
  private mainWindow: BrowserWindow | null = null

  /** Tracks download IDs that are awaiting a dangerous-file confirmation dialog. */
  private pendingDangerousConfirm = new Set<string>()

  private speedTracker = new Map<string, { bytes: number; time: number; lastSpeed: number }>()
  private downloadCounter = 0

  private lastProgressSend = new Map<string, number>()
  private pendingProgressTimers = new Map<string, ReturnType<typeof setTimeout>>()

  private persistence: DownloadPersistence | null = null
  private notifier: DownloadNotifier | null = null
  private initialized = false

  static getInstance(): DownloadManager {
    if (!DownloadManager.instance) {
      DownloadManager.instance = new DownloadManager()
    }
    return DownloadManager.instance
  }

  private constructor() {
    this.registerIPCHandlers()
  }

  // ==================== 初始化 ====================

  initialize(mainWindow: BrowserWindow): void {
    this.mainWindow = mainWindow

    if (this.initialized) return
    this.initialized = true

    this.persistence = new DownloadPersistence()
    this.notifier = new DownloadNotifier(() => this.mainWindow)
    this.downloads = this.persistence!.loadFromDisk()
    this.registerSession(session.defaultSession)

    app.on('session-created', (ses: Session) => {
      this.registerSession(ses)
    })

    app.on('before-quit', () => {
      this.persistence?.flushSync(this.downloads)
      this.persistence?.dispose()
    })

    logger.info('DownloadManager', '初始化完成')
  }

  registerSession(ses: Session): void {
    if (this.registeredSessions.has(ses)) return
    this.registeredSessions.add(ses)
    ses.on('will-download', (event, item, webContents) => {
      this.handleWillDownload(event, item, webContents)
    })
  }

  // ==================== 下载事件处理 ====================

  private handleWillDownload(
    _event: Electron.Event,
    item: DownloadItem,
    webContents: Electron.WebContents
  ): void {
    const id = `dl-${Date.now()}-${++this.downloadCounter}`
    const viewId = this.resolveViewId(webContents)

    const downloadsPath = app.getPath('downloads')
    const filename = sanitizeFilename(item.getFilename() || `download-${id}`)
    const safePath = getUniquePath(path.join(downloadsPath, filename))
    item.setSavePath(safePath)

    const info: DownloadItemData = {
      id,
      name: filename,
      url: item.getURL(),
      savePath: safePath,
      status: 'progressing',
      size: { received: 0, total: item.getTotalBytes() },
      mimeType: item.getMimeType(),
      startTime: Date.now(),
      speed: 0,
      canResume: item.canResume(),
      viewId,
    }

    this.downloads.set(id, info)
    this.activeItems.set(id, item)
    this.speedTracker.set(id, { bytes: 0, time: Date.now(), lastSpeed: 0 })
    this.sendToRenderer(DownloadIPCChannels.onStarted, info)

    if (isDangerousFile(filename)) {
      item.pause()
      this.pendingDangerousConfirm.add(id)
      this.handleDangerousFile(id, item, info).finally(() => {
        this.pendingDangerousConfirm.delete(id)
      })
    }

    item.on('updated', (_e, state) => {
      info.savePath = item.getSavePath()
      info.name = path.basename(info.savePath) || filename
      info.status = state === 'interrupted' ? 'interrupted' : 'progressing'
      info.size = { received: item.getReceivedBytes(), total: item.getTotalBytes() }
      info.speed = this.calculateSpeed(id, info.size.received)
      info.canResume = item.canResume()
      this.throttledProgressSend(id, info)
    })

    item.once('done', (_e, state) => {
      // If the dangerous-file confirmation dialog is still open, skip processing:
      // handleDangerousFile will call item.resume() or item.cancel() after the dialog
      // resolves, which will trigger another 'done' event at that point.
      if (this.pendingDangerousConfirm.has(id)) return

      this.activeItems.delete(id)
      this.speedTracker.delete(id)
      this.clearProgressThrottle(id)

      if (info.status === 'cancelled' || info.status === 'completed') return

      info.status = state as DownloadItemData['status']
      info.endTime = Date.now()
      info.size.received = state === 'completed'
        ? (info.size.total > 0 ? info.size.total : item.getReceivedBytes())
        : item.getReceivedBytes()
      info.speed = 0

      this.sendToRenderer(DownloadIPCChannels.onCompleted, info)
      this.persistence?.schedulePersist(this.downloads)
      this.notifier?.showCompletionNotification(info)

      logger.info('DownloadManager', `下载${state}: ${info.name}`)
    })
  }

  private async handleDangerousFile(id: string, item: DownloadItem, info: DownloadItemData): Promise<void> {
    const win = this.mainWindow && !this.mainWindow.isDestroyed() ? this.mainWindow : null
    const confirmed = await confirmDangerousDownload(win, info.name)

    if (confirmed) {
      try { item.resume() } catch { /* item may have been externally cancelled */ }
    } else {
      try { item.cancel() } catch { /* item may already be done */ }
      info.status = 'cancelled'
      info.endTime = Date.now()
      info.speed = 0
      this.activeItems.delete(id)
      this.speedTracker.delete(id)
      this.clearProgressThrottle(id)
      this.sendToRenderer(DownloadIPCChannels.onCompleted, info)
      this.persistence?.schedulePersist(this.downloads)
    }
  }

  // ==================== 外部下载登记 ====================

  /**
   * 登记一条不经 will-download 的外部下载（资源中心 / Agent 工具走
   * ResourceDownloadService 直下的文件），使其出现在「下载管理」页。
   *
   * - 登记时文件已落盘，记录直接为 completed 态；
   * - `origin: 'external'` 供渲染层静音全局 toast（发起方自行提示）；
   * - 容忍主窗口 / 持久化未就绪（如 Agent 在窗口创建前触发下载）：
   *   记录先进内存，事件与持久化各自跳过；
   * - 同一 savePath 的已完成记录不重复登记（重复下载同一资源时
   *   ResourceDownloadService 会直接返回已捕获文件的原路径）。
   */
  trackExternalDownload(input: {
    url: string
    savePath: string
    size: number
    mimeType?: string
    viewId?: string
  }): void {
    if (!input.savePath) return

    for (const existing of this.downloads.values()) {
      if (existing.status === 'completed' && existing.savePath === input.savePath) {
        return
      }
    }

    const now = Date.now()
    const info: DownloadItemData = {
      id: `dl-ext-${now}-${++this.downloadCounter}`,
      name: path.basename(input.savePath),
      url: input.url,
      savePath: input.savePath,
      status: 'completed',
      size: { received: input.size, total: input.size },
      mimeType: input.mimeType || 'application/octet-stream',
      startTime: now,
      endTime: now,
      speed: 0,
      canResume: false,
      viewId: input.viewId,
      origin: 'external',
    }

    this.downloads.set(info.id, info)
    // 记录已是完成态，onStarted 一条即可让渲染层入列；store 的 onCompleted
    // 只更新既有条目，不再需要补发。
    this.sendToRenderer(DownloadIPCChannels.onStarted, info)
    this.persistence?.schedulePersist(this.downloads)

    logger.info('DownloadManager', `登记外部下载: ${info.name}`)
  }

  // ==================== 进度节流 ====================

  private throttledProgressSend(id: string, info: DownloadItemData): void {
    const now = Date.now()
    const lastSend = this.lastProgressSend.get(id) || 0
    const elapsed = now - lastSend

    if (elapsed >= PROGRESS_THROTTLE_MS) {
      this.lastProgressSend.set(id, now)
      this.sendToRenderer(DownloadIPCChannels.onProgress, info)
      return
    }

    const existing = this.pendingProgressTimers.get(id)
    if (existing) clearTimeout(existing)

    const timer = setTimeout(() => {
      this.pendingProgressTimers.delete(id)
      this.lastProgressSend.set(id, Date.now())
      this.sendToRenderer(DownloadIPCChannels.onProgress, info)
    }, PROGRESS_THROTTLE_MS - elapsed)

    this.pendingProgressTimers.set(id, timer)
  }

  private clearProgressThrottle(id: string): void {
    this.lastProgressSend.delete(id)
    const timer = this.pendingProgressTimers.get(id)
    if (timer) {
      clearTimeout(timer)
      this.pendingProgressTimers.delete(id)
    }
  }

  // ==================== IPC 高阶函数 ====================

  private withDownloadInfo(
    handler: (info: DownloadItemData, id: string) => DownloadIPCResult | Promise<DownloadIPCResult>
  ): (_e: Electron.IpcMainInvokeEvent, id: unknown) => Promise<unknown> {
    return async (_e, id) => {
      if (!validateId(id)) return errResponse('DOWNLOAD_ERROR', DOWNLOAD_MESSAGES.invalidId)
      const info = this.downloads.get(id)
      if (!info) return errResponse('DOWNLOAD_ERROR', DOWNLOAD_MESSAGES.notFound)
      return okResponse(await handler(info, id))
    }
  }

  private withFileAccess(
    handler: (info: DownloadItemData, id: string) => DownloadIPCResult | Promise<DownloadIPCResult>
  ): (_e: Electron.IpcMainInvokeEvent, id: unknown) => Promise<unknown> {
    return this.withDownloadInfo(async (info, id) => {
      const allowedDirs = [
        app.getPath('downloads'),
        resolveDataRoot(),
        resolveSpacesRoot(),
        resolvePlatformDataRoot(),
      ]
      if (!isPathSafe(info.savePath, allowedDirs)) throw new Error(DOWNLOAD_MESSAGES.pathUnsafe)
      try { await access(info.savePath, fsConstants.F_OK) }
      catch { throw new Error(DOWNLOAD_MESSAGES.fileMissing) }
      return handler(info, id)
    })
  }

  private withActiveItem(
    handler: (item: DownloadItem, info: DownloadItemData | undefined, id: string) => DownloadIPCResult
  ): (_e: Electron.IpcMainInvokeEvent, id: unknown) => unknown {
    return (_e, id) => {
      if (!validateId(id)) return errResponse('DOWNLOAD_ERROR', DOWNLOAD_MESSAGES.invalidId)
      const item = this.activeItems.get(id)
      if (!item) return errResponse('DOWNLOAD_ERROR', DOWNLOAD_MESSAGES.notFoundOrCompleted)
      return okResponse(handler(item, this.downloads.get(id), id))
    }
  }

  // ==================== IPC 处理 ====================

  private registerIPCHandlers(): void {
    // download invoke handlers 统一返回 IPC envelope，由 preload invokeIpc
    // 自动 unwrap；renderer 只看到 `{ downloads }` / `{ cleared }` / `{ aborted }`
    // 等业务 payload，失败路径统一变成 throw。
    guardedHandle(DownloadIPCChannels.getAll, (_event) => okResponse({
      // 对已完成项探测磁盘文件是否仍存在，供 UI 标记「文件已失效」并禁用打开/删除等无效操作。
      // 返回浅拷贝附带 fileAvailable，避免把这个瞬时标记写回持久化对象。
      downloads: Array.from(this.downloads.values())
        .sort((a, b) => b.startTime - a.startTime)
        .map((info) =>
          info.status === 'completed'
            ? { ...info, fileAvailable: Boolean(info.savePath) && existsSync(info.savePath) }
            : info,
        ),
    }))

    guardedHandle(DownloadIPCChannels.pause, this.withActiveItem((item, info) => {
      item.pause()
      if (info) {
        info.status = 'paused'
        this.sendToRenderer(DownloadIPCChannels.onProgress, info)
      }
      return {}
    }))

    guardedHandle(DownloadIPCChannels.resume, this.withActiveItem((item, info) => {
      if (!item.canResume()) throw new Error(DOWNLOAD_MESSAGES.cannotResume)
      item.resume()
      if (info) {
        info.status = 'progressing'
        this.sendToRenderer(DownloadIPCChannels.onProgress, info)
      }
      return {}
    }))

    guardedHandle(DownloadIPCChannels.cancel, (_e, id: unknown) => {
      if (!validateId(id)) return errResponse('DOWNLOAD_ERROR', DOWNLOAD_MESSAGES.invalidId)
      const info = this.downloads.get(id)
      if (!info) return okResponse({})

      const item = this.activeItems.get(id)
      if (item) {
        item.cancel()
        this.activeItems.delete(id)
      }
      if (info.status === 'progressing' || info.status === 'paused') {
        info.status = 'cancelled'
        info.endTime = Date.now()
        info.speed = 0
        this.sendToRenderer(DownloadIPCChannels.onCompleted, info)
        this.persistence?.schedulePersist(this.downloads)
      }
      return okResponse({})
    })

    guardedHandle(DownloadIPCChannels.open, this.withFileAccess(async (info) => {
      try {
        const errMsg = await shell.openPath(info.savePath)
        if (errMsg) throw new Error(errMsg)
        return {}
      } catch (error) {
        throw new Error(error instanceof Error ? error.message : String(error))
      }
    }))

    guardedHandle(DownloadIPCChannels.showInFolder, this.withFileAccess((info) => {
      shell.showItemInFolder(info.savePath)
      return {}
    }))

    guardedHandle(DownloadIPCChannels.removeItem, (_e, id: unknown) => {
      if (!validateId(id)) return errResponse('DOWNLOAD_ERROR', DOWNLOAD_MESSAGES.invalidId)
      const item = this.activeItems.get(id)
      if (item) item.cancel()
      this.clearProgressThrottle(id)
      this.speedTracker.delete(id)
      this.activeItems.delete(id)
      this.downloads.delete(id)
      this.persistence?.schedulePersist(this.downloads)
      return okResponse({})
    })

    guardedHandle(DownloadIPCChannels.clearCompleted, (_event) => {
      const toRemove: string[] = []
      for (const [id, info] of this.downloads) {
        if (info.status !== 'progressing' && info.status !== 'paused') toRemove.push(id)
      }
      toRemove.forEach(id => this.downloads.delete(id))
      this.persistence?.schedulePersist(this.downloads)
      return okResponse({ cleared: toRemove.length })
    })

    guardedHandle(DownloadIPCChannels.retry, this.withDownloadInfo((info, id) => {
      if (info.status === 'progressing' || info.status === 'paused') {
        throw new Error(DOWNLOAD_MESSAGES.inProgress)
      }
      if (!info.url) throw new Error(DOWNLOAD_MESSAGES.missingUrl)
      const urlCheck = validateDownloadUrl(info.url)
      if (!urlCheck.valid) throw new Error(urlCheck.error!)

      let targetWebContents: Electron.WebContents | null = null
      if (info.viewId) targetWebContents = this.tryGetViewWebContents(info.viewId)
      if (!targetWebContents) {
        if (!this.mainWindow || this.mainWindow.isDestroyed()) throw new Error(DOWNLOAD_MESSAGES.windowUnavailable)
        targetWebContents = this.mainWindow.webContents
      }
      if (targetWebContents.isDestroyed()) throw new Error(DOWNLOAD_MESSAGES.targetDestroyed)

      const activeItem = this.activeItems.get(id)
      if (activeItem) activeItem.cancel()
      this.activeItems.delete(id)
      this.speedTracker.delete(id)
      this.clearProgressThrottle(id)

      targetWebContents.downloadURL(info.url)
      this.downloads.delete(id)
      this.persistence?.schedulePersist(this.downloads)
      return {}
    }))

    guardedHandle(DownloadIPCChannels.deleteFile, this.withFileAccess(async (info, id) => {
      try {
        await unlink(info.savePath)
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException)?.code
        if (code !== 'ENOENT') {
          throw new Error(err instanceof Error ? err.message : String(err))
        }
      }
      this.downloads.delete(id)
      this.persistence?.schedulePersist(this.downloads)
      return {}
    }))

    guardedHandle(DownloadIPCChannels.getActiveCount, (_event) => okResponse({
      count: this.getActiveCount(),
    }))

    guardedHandle(DownloadIPCChannels.streamCancel, (_e, downloadId: string) => {
      if (!downloadId || typeof downloadId !== 'string') {
        return errResponse('DOWNLOAD_ERROR', DOWNLOAD_MESSAGES.invalidId)
      }
      try {
        const aborted = getStreamDownloadService().abort(downloadId)
        return okResponse({ aborted })
      } catch {
        return errResponse('DOWNLOAD_ERROR', DOWNLOAD_MESSAGES.streamServiceUnavailable)
      }
    })
  }

  // ==================== 工具方法 ====================

  private sendToRenderer(channel: string, data: DownloadItemData): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, { ...data })
    }
  }

  private tryGetViewWebContents(viewId: string): Electron.WebContents | null {
    try {
      const view = getViewFactory()?.getView?.(viewId)
      return view && !view.webContents.isDestroyed() ? view.webContents : null
    } catch { return null }
  }

  private resolveViewId(webContents: Electron.WebContents): string | undefined {
    try {
      const factory = getViewFactory()
      if (!factory) return undefined
      const allIds: string[] = factory.getAllViewIds?.() ?? []
      for (const vid of allIds) {
        const view = factory.getView?.(vid)
        if (view?.webContents === webContents) return vid
      }
    } catch { /* ignore */ }
    return undefined
  }

  private calculateSpeed(id: string, currentBytes: number): number {
    const tracker = this.speedTracker.get(id)
    if (!tracker) return 0

    const now = Date.now()
    const timeDiff = (now - tracker.time) / 1000
    const bytesDiff = currentBytes - tracker.bytes

    if (timeDiff >= SPEED_MIN_SAMPLE_INTERVAL_S) {
      const instantSpeed = timeDiff > 0 ? Math.round(bytesDiff / timeDiff) : 0
      const smoothed = tracker.lastSpeed === 0
        ? instantSpeed
        : Math.round(tracker.lastSpeed * (1 - SPEED_EMA_ALPHA) + instantSpeed * SPEED_EMA_ALPHA)
      this.speedTracker.set(id, { bytes: currentBytes, time: now, lastSpeed: smoothed })
      return smoothed
    }
    return tracker.lastSpeed
  }

  getActiveCount(): number {
    let count = 0
    for (const info of this.downloads.values()) {
      if (info.status === 'progressing' || info.status === 'paused') count++
    }
    return count
  }
}

// ==================== 导出 ====================

export function getDownloadManager(): DownloadManager {
  return DownloadManager.getInstance()
}

export function initDownloadManager(mainWindow: BrowserWindow): DownloadManager {
  const manager = DownloadManager.getInstance()
  manager.initialize(mainWindow)
  return manager
}

// ==================== Space 下载路径 ====================

export { sanitizePathSegment } from './utils/path-sanitize'

/**
 * 解析当前登录用户的 userId（ 新布局落盘必须字段）。
 * 字段兼容与 ElectronAgentHost.resolveSkillUserId 同源（id / user_id / userId
 * 三种字段名）；未认证时返回 undefined。
 */
async function resolveCurrentUserId(): Promise<string | undefined> {
  const userInfo = (await TokenManager.getUserInfo()) as
    | { id?: unknown; user_id?: unknown; userId?: unknown }
    | null
  const raw = userInfo?.id ?? userInfo?.user_id ?? userInfo?.userId
  if (raw === undefined || raw === null || raw === '') return undefined
  return String(raw)
}

/**
 * 解析 workspace 的下载目录路径，不存在时自动创建。
 * 返回 null 表示输入无效、未认证，或缺少 organizationId（ 硬切：
 * userId / orgId / workspaceId 均为新布局必填段，不再静默落到 `_unscoped`）。
 *
 * ：downloads 目录固定
 * `.../users/{userId}/organizations/{orgId}/workspaces/{workspaceId}/downloads/`，
 * userId 由当前登录态解析；organizationId 从 CLI context 获取；
 * spaceId 视作 workspaceId 兼容期。
 */
export async function resolveSpaceDownloadDir(spaceId: unknown): Promise<string | null> {
  if (!spaceId || typeof spaceId !== 'string') return null
  const sanitized = sanitizePathSegment(spaceId)
  const organizationId = getCLIOrganizationId() ?? undefined
  const userId = await resolveCurrentUserId()
  if (!userId) {
    logger.warn('DownloadManager', '未登录，无法确定 downloads 目录归属（缺少 userId）')
    return null
  }
  if (!organizationId) {
    logger.warn(
      'DownloadManager',
      '缺少 organizationId，无法确定 downloads 目录归属（ hard-cut）',
    )
    return null
  }
  const dir = resolveWorkspaceDownloadsDir(resolveDataRoot(), userId, organizationId, sanitized)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return dir
}

