/**
 * UpdateManager - 应用更新管理服务
 *
 * 职责：
 * 1. 封装 electron-updater，管理检查 / 下载 / 安装生命周期
 * 2. 订阅后端 WS 推送，并把服务端策略和客户端下载链路对齐
 * 3. 暴露统一运行时状态给 renderer，支撑全局提醒和设置页
 * 4. 上报更新过程埋点，便于后台统计和灰度治理
 */

import pkg from 'electron-updater'
const { autoUpdater } = pkg
import type { ProgressInfo, UpdateInfo } from 'electron-updater'
import { app, BrowserWindow, dialog, type MessageBoxOptions, type MessageBoxReturnValue } from 'electron'
import log from 'electron-log'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { joinApiPath } from '@tabtin/config'
import type { WsGatewayClient } from '../ws/WsGatewayClient'
import { TokenManager } from '../auth'
import { API_BASE_URL } from '../config/api'
import {
  LEGACY_DEFAULT_FEED_URL,
  loadPackagedDistributionMetadata,
  normalizeFeedUrl,
  resolvePackagedUpdaterConfig,
  resolveUpdateChannel,
} from './update-feed-config'
import { notificationService } from './notification'

type UpdateEventSource = 'feed' | 'backend'
type UpdateCheckSource = 'manual' | 'startup' | 'background' | 'ws_push' | 'silent'
type ProgressTriggerSource = 'ws_push' | 'http_poll' | 'manual'

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'error'

export interface UpdateRuntimeState {
  currentVersion: string
  platform: 'mac' | 'win' | 'linux'
  arch: 'x64' | 'arm64'
  channel: 'stable' | 'beta' | 'alpha'
  status: UpdateStatus
  downloadProgress: number
  updateInfo: Record<string, any> | null
  errorMessage: string | null
  lastCheckedAt: string | null
  lastCheckSource: UpdateCheckSource | null
  releaseSource: UpdateEventSource | null
}

export interface UpdateConfig {
  checkOnStartup?: boolean
  autoDownload?: boolean
  autoInstallOnAppQuit?: boolean
  updateServerUrl?: string
}

const WS_RETRY_BASE_DELAY_MS = 30_000
const WS_RETRY_MAX_DELAY_MS = 2 * 60_000
const PENDING_INSTALL_FILE = 'pending-update-install.json'

type BackendUpdateHint = {
  has_update: boolean
  version?: string
  release_notes?: string
  release_date?: string
  file_url?: string
  feed_url?: string
  manifest_url?: string
  manifest_file?: string
  file_size?: number
  checksum?: string
  mandatory?: boolean
  priority?: string
}

type BackendCheckEnvelope = {
  success?: boolean
  code?: string
  message?: string
  data?: BackendUpdateHint | null
}

type ReleaseHistoryOptions = {
  platform?: 'mac' | 'win' | 'linux'
  arch?: 'x64' | 'arm64'
  channel?: 'stable' | 'beta' | 'alpha'
  limit?: number
  locale?: string
}

type ReleaseHistoryEnvelope = {
  success?: boolean
  code?: string
  message?: string
  data?: {
    items?: Array<Record<string, any>>
  } | null
}

function resolveUpdatePlatform(platform = process.platform): 'mac' | 'win' | 'linux' {
  if (platform === 'darwin') return 'mac'
  if (platform === 'win32') return 'win'
  return 'linux'
}

function resolveUpdateArch(arch = process.arch): 'x64' | 'arm64' {
  return arch === 'arm64' ? 'arm64' : 'x64'
}

function resolveFeedChannel(channel: 'stable' | 'beta' | 'alpha'): string | null {
  return channel === 'stable' ? null : channel
}

function mapCheckSourceToTriggerSource(source: UpdateCheckSource): ProgressTriggerSource {
  if (source === 'manual') return 'manual'
  if (source === 'startup' || source === 'background') return 'http_poll'
  return 'ws_push'
}

export class UpdateManager {
  private mainWindow: BrowserWindow | null = null
  private wsClient?: WsGatewayClient
  private wsUnsubscribe?: () => void
  private authUnsubscribe?: () => void
  private httpCheckInterval?: ReturnType<typeof setInterval>
  private wsRetryTimer?: ReturnType<typeof setTimeout>
  private activeCheckPromises = new Map<string, Promise<any>>()
  private updaterCheckTail: Promise<void> = Promise.resolve()
  private destroyed = false

  private readonly checkOnStartup: boolean
  private readonly runtimePlatform = resolveUpdatePlatform()
  private readonly runtimeArch = resolveUpdateArch()
  private readonly runtimeChannel = resolveUpdateChannel({
    env: process.env,
    packageJsonPath: join(app.getAppPath(), 'package.json'),
  })
  private readonly feedChannel = resolveFeedChannel(this.runtimeChannel)

  private updaterEnabled = true
  private updaterRequiresExactFeedOrigin = false
  private updaterFeedOrigin: string | undefined
  private defaultFeedUrl = LEGACY_DEFAULT_FEED_URL
  private activeFeedUrl = this.defaultFeedUrl
  private currentDownloadVersion?: string
  private preparedDownloadVersion?: string
  private lastBackendHint?: Record<string, any> | null
  private lastTriggerSource: ProgressTriggerSource = 'http_poll'

  private runtimeState: UpdateRuntimeState = {
    currentVersion: app.getVersion(),
    platform: this.runtimePlatform,
    arch: this.runtimeArch,
    channel: this.runtimeChannel,
    status: 'idle',
    downloadProgress: 0,
    updateInfo: null,
    errorMessage: null,
    lastCheckedAt: null,
    lastCheckSource: null,
    releaseSource: null,
  }

  constructor(config?: UpdateConfig) {
    this.checkOnStartup = config?.checkOnStartup ?? true
    this.configureUpdater(config)
    this.setupEventListeners()
    void this.reportPendingInstalledUpdate()
  }

  getState(): UpdateRuntimeState {
    return { ...this.runtimeState }
  }

  async fetchReleaseHistory(options: ReleaseHistoryOptions = {}): Promise<Array<Record<string, any>>> {
    const platform = options.platform || this.runtimePlatform
    const arch = options.arch || this.runtimeArch
    const channel = options.channel || this.runtimeChannel
    const limit = Math.min(Math.max(Number(options.limit || 10), 1), 50)
    const params = new URLSearchParams({
      platform,
      arch,
      channel,
      limit: String(limit),
    })
    if (options.locale) {
      params.set('locale', options.locale)
    }

    const response = await fetch(`${joinApiPath(API_BASE_URL, '/updates/releases')}?${params.toString()}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    })

    if (!response.ok) {
      throw new Error(`获取版本历史失败（${response.status}）`)
    }

    const envelope = (await response.json()) as ReleaseHistoryEnvelope
    if (!envelope?.success) {
      throw new Error(envelope?.message || '获取版本历史失败')
    }

    return Array.isArray(envelope.data?.items) ? envelope.data.items : []
  }

  private setState(patch: Partial<UpdateRuntimeState>): void {
    this.runtimeState = {
      ...this.runtimeState,
      ...patch,
    }
    this.emitRuntimeState()
  }

  private emitRuntimeState(): void {
    this.mainWindow?.webContents.send('update-event', {
      event: 'update-state',
      data: this.getState(),
    })
  }

  /**
   * SS-17: feedUrl 白名单校验，仅允许 https:// 且域名属于 *.example.com
   */
  private isAllowedFeedUrl(url: string): boolean {
    try {
      const parsed = new URL(url)
      if (parsed.protocol !== 'https:') return false
      if (this.updaterRequiresExactFeedOrigin && this.updaterFeedOrigin) {
        return parsed.origin === this.updaterFeedOrigin
      }
      const host = parsed.hostname.toLowerCase()
      return host === 'example.com' || host.endsWith('.example.com')
    } catch {
      return false
    }
  }

  private applyFeedConfig(feedUrl?: string | null): void {
    if (!this.updaterEnabled) return
    const normalizedFeedUrl = normalizeFeedUrl(feedUrl) || this.defaultFeedUrl

    if (normalizedFeedUrl !== this.defaultFeedUrl && !this.isAllowedFeedUrl(normalizedFeedUrl)) {
      log.warn('[UpdateManager] Rejected untrusted feedUrl, falling back to default:', normalizedFeedUrl)
      this.activeFeedUrl = this.defaultFeedUrl
      autoUpdater.setFeedURL({
        provider: 'generic',
        url: this.defaultFeedUrl,
        ...(this.feedChannel ? { channel: this.feedChannel } : {}),
      })
      return
    }

    this.activeFeedUrl = normalizedFeedUrl
    autoUpdater.setFeedURL({
      provider: 'generic',
      url: normalizedFeedUrl,
      ...(this.feedChannel ? { channel: this.feedChannel } : {}),
    })
  }

  private async reportProgress(
    version: string,
    status: 'checking' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'installed' | 'failed',
    progress: number,
    error?: { code: string; message: string },
  ): Promise<void> {
    if (this.wsClient?.getStatus() === 'ready') {
      try {
        await this.wsClient.reportUpdateProgress(version, status, progress, error, this.lastTriggerSource)
        return
      } catch (err) {
        log.warn('[UpdateManager] WS progress report failed, falling back to HTTP:', err)
      }
    }

    try {
      await this.reportProgressViaHttp(version, status, progress, error)
    } catch (err) {
      log.error('[UpdateManager] Failed to report progress:', err)
    }
  }

  /**
   * HTTP 埋点兜底：WS 未就绪或上报失败时走 POST /updates/progress。
   * 该接口需要 JWT，未登录时放弃本次埋点（埋点丢失可接受，不能抛错打断更新流程）。
   */
  private async reportProgressViaHttp(
    version: string,
    status: 'checking' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'installed' | 'failed',
    progress: number,
    error?: { code: string; message: string },
  ): Promise<void> {
    const token = await TokenManager.getAccessToken()
    if (!token) {
      return
    }

    const response = await fetch(joinApiPath(API_BASE_URL, '/updates/progress'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        version,
        status,
        progress,
        from_version: app.getVersion(),
        device_id: this.wsClient?.getDeviceId() || '',
        error_code: error?.code,
        error_message: error?.message,
      }),
    })

    if (!response.ok) {
      throw new Error(`HTTP 埋点上报失败（${response.status}）`)
    }
  }

  private pendingInstallPath(): string {
    return join(app.getPath('userData'), PENDING_INSTALL_FILE)
  }

  private writePendingInstall(version: string): void {
    try {
      const filePath = this.pendingInstallPath()
      mkdirSync(dirname(filePath), { recursive: true })
      writeFileSync(
        filePath,
        JSON.stringify({
          version,
          fromVersion: app.getVersion(),
          createdAt: new Date().toISOString(),
        }),
        { encoding: 'utf-8', mode: 0o600 },
      )
    } catch (err) {
      log.warn('[UpdateManager] Failed to persist pending install marker:', err)
    }
  }

  private clearPendingInstall(): void {
    try {
      const filePath = this.pendingInstallPath()
      if (existsSync(filePath)) {
        rmSync(filePath, { force: true })
      }
    } catch (err) {
      log.warn('[UpdateManager] Failed to clear pending install marker:', err)
    }
  }

  private async reportPendingInstalledUpdate(): Promise<void> {
    const filePath = this.pendingInstallPath()
    if (!existsSync(filePath)) return

    try {
      const raw = readFileSync(filePath, 'utf-8')
      const marker = JSON.parse(raw) as { version?: string }
      const installedVersion = String(marker.version || '').trim()
      if (!installedVersion) {
        this.clearPendingInstall()
        return
      }

      if (installedVersion === app.getVersion()) {
        await this.reportProgress(installedVersion, 'installed', 100)
        this.clearPendingInstall()
        log.info('[UpdateManager] Reported installed update:', installedVersion)
      }
    } catch (err) {
      log.warn('[UpdateManager] Failed to report pending installed update:', err)
    }
  }

  private configureUpdater(config?: UpdateConfig): void {
    autoUpdater.logger = log
    log.transports.file.level = 'info'
    autoUpdater.forceDevUpdateConfig = !app.isPackaged

    const packageJsonPath = join(app.getAppPath(), 'package.json')
    this.updaterRequiresExactFeedOrigin =
      loadPackagedDistributionMetadata(packageJsonPath)?.kind === 'community'
    const updaterConfig = resolvePackagedUpdaterConfig({
      updateServerUrl: config?.updateServerUrl,
      env: process.env,
      packageJsonPath,
    })
    this.updaterEnabled = updaterConfig.enabled
    if (!updaterConfig.enabled) {
      log.info('[UpdateManager] Updater disabled by packaged distribution metadata')
      autoUpdater.autoDownload = false
      autoUpdater.autoInstallOnAppQuit = false
      return
    }

    this.defaultFeedUrl = updaterConfig.feedUrl
    this.updaterFeedOrigin = updaterConfig.feedOrigin
    this.applyFeedConfig(this.defaultFeedUrl)

    autoUpdater.autoDownload = config?.autoDownload ?? false
    autoUpdater.autoInstallOnAppQuit = config?.autoInstallOnAppQuit ?? true
  }

  private setupEventListeners(): void {
    autoUpdater.on('update-available', (info: UpdateInfo) => {
      const merged = this.mergeUpdateInfo(info, 'feed')
      log.info('[UpdateManager] Update available:', merged.version)
      this.currentDownloadVersion = merged.version
      this.preparedDownloadVersion = merged.version
      this.lastBackendHint = merged
      this.setState({
        status: 'available',
        updateInfo: merged,
        errorMessage: null,
        releaseSource: 'feed',
      })
      this.notifyRenderer('update-available', merged)

      if (merged.version) {
        void this.reportProgress(merged.version, 'available', 0)
      }
    })

    autoUpdater.on('update-not-available', () => {
      log.info('[UpdateManager] No update available')
      this.applyFeedConfig(this.defaultFeedUrl)
      this.currentDownloadVersion = undefined
      this.preparedDownloadVersion = undefined
      this.lastBackendHint = null
      this.setState({
        status: 'idle',
        downloadProgress: 0,
        updateInfo: null,
        errorMessage: null,
        releaseSource: null,
      })
      this.notifyRenderer('update-not-available')
    })

    autoUpdater.on('download-progress', (progress: ProgressInfo) => {
      this.setState({
        status: 'downloading',
        downloadProgress: Math.round(progress.percent ?? 0),
        errorMessage: null,
      })
      this.notifyRenderer('download-progress', progress)

      if (this.currentDownloadVersion) {
        void this.reportProgress(this.currentDownloadVersion, 'downloading', progress.percent)
      }
    })

    autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
      const merged = this.mergeUpdateInfo(info, 'feed')
      log.info('[UpdateManager] Update downloaded:', merged.version)
      this.setState({
        status: 'downloaded',
        downloadProgress: 100,
        updateInfo: merged,
        errorMessage: null,
        releaseSource: 'feed',
      })
      this.notifyRenderer('update-downloaded', merged)

      if (merged.version) {
        void this.reportProgress(merged.version, 'downloaded', 100)
      }

      this.showRestartDialog(merged as UpdateInfo)
    })

    autoUpdater.on('error', (err: Error) => {
      log.error('[UpdateManager] Update error:', err)
      this.preparedDownloadVersion = undefined
      this.setState({
        status: 'error',
        errorMessage: err.message,
      })
      this.notifyRenderer('update-error', err.message)

      if (this.currentDownloadVersion) {
        void this.reportProgress(this.currentDownloadVersion, 'failed', 0, {
          code: 'UPDATE_ERROR',
          message: err.message,
        })
      }
    })
  }

  /**
   * 注册 WebSocket 客户端，订阅更新推送事件。
   * 连接会在 auth 可用时自动建立。
   */
  setWsClient(wsClient: WsGatewayClient): void {
    this.wsClient = wsClient

    this.wsUnsubscribe = wsClient.on('app.update.available', (payload: any) => {
      this.handleWsUpdatePush(payload)
    })
    this.authUnsubscribe = TokenManager.onAuthChanged(() => {
      if (this.destroyed || this.wsClient?.getStatus() === 'ready') return
      if (this.wsRetryTimer) {
        clearTimeout(this.wsRetryTimer)
        this.wsRetryTimer = undefined
      }
      void this.tryConnectWs(0)
    })

    void this.tryConnectWs()
    log.info('[UpdateManager] WebSocket client registered')
  }

  /**
   * 尝试用 TokenManager 获取 auth 并连接 WS。
   * 登录未完成时持续重试，保证后登录场景也能收到更新推送。
   */
  private async tryConnectWs(retryCount = 0): Promise<void> {
    if (!this.wsClient || this.destroyed) return
    if (this.wsClient.getStatus() === 'ready') return

    try {
      const token = await TokenManager.getAccessToken()
      const userInfo = await TokenManager.getUserInfo()
      const organizationId =
        userInfo?.organization_id ?? userInfo?.organizationId ??
        userInfo?.default_organization_id ?? userInfo?.defaultOrganizationId ?? ''

      if (!token) {
        this.scheduleWsRetry(retryCount + 1, 'auth not ready')
        return
      }

      const ok = await this.wsClient.connectWithAuth({
        token,
        ...(organizationId ? { organizationId: String(organizationId) } : {}),
        device: {
          name: 'TabTin Desktop',
          platform: this.runtimePlatform,
          os: process.platform,
          app_version: app.getVersion(),
          arch: this.runtimeArch,
          channel: this.runtimeChannel,
        } as any,
      })

      log.info(`[UpdateManager] WS connect result: ${ok}`)
      if (!ok) {
        this.scheduleWsRetry(retryCount + 1, 'connect returned false')
      }
    } catch (err) {
      log.warn('[UpdateManager] WS connect failed:', err)
      this.scheduleWsRetry(retryCount + 1, 'connect exception')
    }
  }

  private scheduleWsRetry(retryCount: number, reason: string): void {
    if (this.destroyed || !this.wsClient || this.wsClient.getStatus() === 'ready') return
    if (this.wsRetryTimer) {
      clearTimeout(this.wsRetryTimer)
    }

    const delay = Math.min(WS_RETRY_BASE_DELAY_MS * Math.max(1, retryCount), WS_RETRY_MAX_DELAY_MS)
    log.info(`[UpdateManager] WS retry in ${Math.round(delay / 1000)}s (${reason})`)
    this.wsRetryTimer = setTimeout(() => {
      this.wsRetryTimer = undefined
      void this.tryConnectWs(retryCount)
    }, delay)
  }

  /**
   * 设置主窗口（用于向 renderer 发送事件）
   */
  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window
    this.emitRuntimeState()
  }

  private resolveUserId(userInfo: Record<string, any> | null | undefined): string | undefined {
    const rawUserId = userInfo?.id ?? userInfo?.user_id ?? userInfo?.userId
    if (rawUserId === undefined || rawUserId === null || rawUserId === '') return undefined
    return String(rawUserId)
  }

  private async getOptionalUserInfo(): Promise<Record<string, any> | null> {
    try {
      return await TokenManager.getUserInfo()
    } catch (err) {
      log.warn('[UpdateManager] Continue update check without user info:', err)
      return null
    }
  }

  private async fetchEligibleUpdateHint(source: UpdateCheckSource): Promise<Record<string, any> | null> {
    const userInfo = await this.getOptionalUserInfo()
    const response = await fetch(joinApiPath(API_BASE_URL, '/updates/check'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        current_version: app.getVersion(),
        platform: this.runtimePlatform,
        arch: this.runtimeArch,
        channel: this.runtimeChannel,
        device_id: this.wsClient?.getDeviceId() || '',
        user_id: this.resolveUserId(userInfo),
        trigger_source: mapCheckSourceToTriggerSource(source),
      }),
    })

    if (!response.ok) {
      throw new Error(`后端检查更新失败（${response.status}）`)
    }

    const envelope = (await response.json()) as BackendCheckEnvelope
    if (!envelope?.success) {
      throw new Error(envelope?.message || '后端检查更新失败')
    }

    const data = envelope?.data
    if (!data?.has_update) {
      return null
    }

    return this.mergeUpdateInfo(data, 'backend')
  }

  /**
   * 检查更新
   */
  async checkForUpdates(
    silent = true,
    source: UpdateCheckSource = silent ? 'background' : 'manual',
    expectedVersion?: string,
  ): Promise<any> {
    const checkKey = expectedVersion ? `expected:${expectedVersion}` : 'general'
    const activeCheckPromise = this.activeCheckPromises.get(checkKey)
    if (activeCheckPromise) {
      log.info(`[UpdateManager] Reusing active update check (source=${source})`)
      return activeCheckPromise
    }

    const checkPromise = this.runCheckForUpdates(silent, source, expectedVersion)
      .finally(() => {
        this.activeCheckPromises.delete(checkKey)
      })
    this.activeCheckPromises.set(checkKey, checkPromise)

    return checkPromise
  }

  private async runCheckForUpdates(
    silent: boolean,
    source: UpdateCheckSource,
    expectedVersion?: string,
  ): Promise<any> {
    if (!this.updaterEnabled) {
      log.info(`[UpdateManager] Update check skipped: updater disabled (source=${source})`)
      return null
    }
    try {
      this.lastTriggerSource = mapCheckSourceToTriggerSource(source)
      this.setState({
        status: 'checking',
        errorMessage: null,
        lastCheckedAt: new Date().toISOString(),
        lastCheckSource: source,
      })
      this.notifyRenderer('update-checking', { source })

      let backendHint: Record<string, any> | null = null
      if (!expectedVersion) {
        backendHint = await this.fetchEligibleUpdateHint(source)
        if (!backendHint?.version) {
          log.info(`[UpdateManager] No eligible update from backend (source=${source})`)
          this.applyFeedConfig(this.defaultFeedUrl)
          this.preparedDownloadVersion = undefined
          this.currentDownloadVersion = undefined
          this.lastBackendHint = null
          this.setState({
            status: 'idle',
            downloadProgress: 0,
            updateInfo: null,
            errorMessage: null,
            releaseSource: null,
          })
          this.notifyRenderer('update-not-available')
          return null
        }

        expectedVersion = backendHint.version
        this.lastBackendHint = backendHint
        this.currentDownloadVersion = backendHint.version
      }

      const feedHint =
        (expectedVersion && this.lastBackendHint?.version === expectedVersion ? this.lastBackendHint : null) ||
        backendHint

      if (this.currentDownloadVersion) {
        void this.reportProgress(this.currentDownloadVersion, 'checking', 0)
      }

      const result = await this.withSerializedUpdaterCheck(async () => {
        this.applyFeedConfig(feedHint?.feedUrl ?? feedHint?.feed_url ?? null)
        log.info(
          `[UpdateManager] Checking for updates (source=${source}, feed=${this.activeFeedUrl}, channel=${this.feedChannel || 'latest'})...`,
        )
        return autoUpdater.checkForUpdates()
      })
      const checkedVersion = result?.updateInfo?.version

      if (expectedVersion && !checkedVersion) {
        throw new Error(`更新源中未找到期望版本 ${expectedVersion}`)
      }

      if (expectedVersion && checkedVersion && checkedVersion !== expectedVersion) {
        throw new Error(`更新源版本不匹配，期望 ${expectedVersion}，实际 ${checkedVersion}`)
      }

      // mandatory / critical 不等用户点击，直接进入下载（mandatory 下载完
      // 阻断重启，critical 不阻断）。仅在直接检查流（backendHint 非空）触发——
      // prepare 流（expectedVersion 由调用方传入，如 handleCriticalUpdate）
      // 由调用方自己负责下载，避免重复。
      const autoDownloadWanted =
        Boolean(backendHint?.mandatory) || backendHint?.priority === 'critical'
      if (autoDownloadWanted && checkedVersion && !autoUpdater.autoDownload) {
        log.info('[UpdateManager] Mandatory/critical update detected, starting automatic download')
        void this.downloadUpdate().catch((err) =>
          log.error('[UpdateManager] Mandatory auto download failed:', err),
        )
      }

      return result
    } catch (err) {
      log.error('[UpdateManager] Check update failed:', err)
      const message = err instanceof Error ? err.message : String(err)
      this.preparedDownloadVersion = undefined
      this.setState({
        status: 'error',
        downloadProgress: 0,
        errorMessage: message,
      })
      this.notifyRenderer('update-error', message)

      if (this.currentDownloadVersion) {
        void this.reportProgress(this.currentDownloadVersion, 'failed', 0, {
          code: 'CHECK_UPDATE_FAILED',
          message,
        })
      }
      throw err
    }
  }

  private async withSerializedUpdaterCheck<T>(run: () => Promise<T>): Promise<T> {
    const previous = this.updaterCheckTail
    let release!: () => void
    this.updaterCheckTail = new Promise<void>((resolve) => {
      release = resolve
    })

    await previous.catch(() => {})

    try {
      return await run()
    } finally {
      release()
    }
  }

  /**
   * 下载更新
   */
  async downloadUpdate(): Promise<any> {
    const targetVersion =
      this.runtimeState.updateInfo?.version ||
      this.currentDownloadVersion ||
      this.lastBackendHint?.version

    if (!targetVersion) {
      const message = '当前没有可下载的更新'
      this.setState({
        status: 'error',
        downloadProgress: 0,
        errorMessage: message,
      })
      this.notifyRenderer('update-error', message)
      return null
    }

    try {
      await this.ensureUpdatePrepared(targetVersion)

      log.info('[UpdateManager] Downloading update...')
      this.setState({
        status: 'downloading',
        downloadProgress: 0,
        errorMessage: null,
      })
      return await autoUpdater.downloadUpdate()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error('[UpdateManager] Download update failed:', err)
      this.preparedDownloadVersion = undefined
      this.setState({
        status: 'error',
        downloadProgress: 0,
        errorMessage: message,
      })
      this.notifyRenderer('update-error', message)
      void this.reportProgress(targetVersion, 'failed', 0, {
        code: 'DOWNLOAD_UPDATE_FAILED',
        message,
      })
      return null
    }
  }

  /**
   * 退出并安装
   */
  quitAndInstall(): void {
    log.info('[UpdateManager] Quit and install')
    const version = this.runtimeState.updateInfo?.version || this.currentDownloadVersion
    this.setState({
      status: 'installing',
      errorMessage: null,
    })
    this.notifyRenderer('update-installing', version ? { version } : undefined)

    if (version) {
      this.writePendingInstall(version)
      void this.reportProgress(version, 'installing', 100)
    }

    autoUpdater.quitAndInstall(false, true)
  }

  private async ensureUpdatePrepared(targetVersion: string): Promise<void> {
    if (this.preparedDownloadVersion === targetVersion) {
      return
    }

    const result = await this.checkForUpdates(true, 'ws_push', targetVersion)
    const preparedVersion = result?.updateInfo?.version

    if (preparedVersion !== targetVersion) {
      throw new Error(`更新准备失败，期望 ${targetVersion}，实际 ${preparedVersion || '未知版本'}`)
    }

    this.preparedDownloadVersion = preparedVersion
  }

  /**
   * 启动 HTTP 轮询兜底
   */
  startHttpPolling(intervalHours = 24): void {
    if (!this.updaterEnabled) {
      log.info('[UpdateManager] HTTP polling disabled by distribution profile')
      return
    }
    if (this.httpCheckInterval) {
      clearInterval(this.httpCheckInterval)
    }

    if (this.checkOnStartup) {
      setTimeout(() => {
        void this.checkForUpdates(true, 'startup').catch((err) =>
          log.error('[UpdateManager] Initial check failed:', err),
        )
      }, 30_000)
    }

    this.httpCheckInterval = setInterval(
      () => {
        void this.checkForUpdates(true, 'background').catch((err) =>
          log.error('[UpdateManager] Scheduled check failed:', err),
        )
      },
      intervalHours * 60 * 60 * 1000,
    )

    log.info(`[UpdateManager] HTTP polling started (every ${intervalHours}h)`)
  }

  /**
   * 停止 HTTP 轮询
   */
  stopHttpPolling(): void {
    if (this.httpCheckInterval) {
      clearInterval(this.httpCheckInterval)
      this.httpCheckInterval = undefined
      log.info('[UpdateManager] HTTP polling stopped')
    }
  }

  /**
   * 清理资源
   */
  destroy(): void {
    this.destroyed = true
    this.stopHttpPolling()
    if (this.wsRetryTimer) {
      clearTimeout(this.wsRetryTimer)
      this.wsRetryTimer = undefined
    }
    if (this.wsUnsubscribe) {
      this.wsUnsubscribe()
    }
    if (this.authUnsubscribe) {
      this.authUnsubscribe()
      this.authUnsubscribe = undefined
    }
    this.wsClient?.close()
    // SS-16: 移除所有 autoUpdater 监听器，防止服务重建时叠加
    autoUpdater.removeAllListeners()
  }

  // ==================== WebSocket 推送处理 ====================

  /**
   * WS 推送只是「叫醒信号」：版本比较、灰度、白名单、强更资格一律回查
   * 后端 /updates/check 统一裁决（后端是唯一大脑），客户端不再本地判定。
   * 推送 payload 仅保留 silent 标记（来自推送策略，check 响应不携带）。
   */
  private handleWsUpdatePush(payload: any): void {
    if (!this.updaterEnabled) {
      log.info('[UpdateManager] Ignoring update push: updater disabled by distribution profile')
      return
    }
    log.info('[UpdateManager] Received WS push:', payload)
    this.lastTriggerSource = 'ws_push'
    void this.recheckAfterWsPush(payload)
  }

  private async recheckAfterWsPush(payload: any): Promise<void> {
    let hint: Record<string, any> | null = null
    try {
      hint = await this.fetchEligibleUpdateHint('ws_push')
    } catch (err) {
      log.error('[UpdateManager] WS push recheck failed:', err)
      return
    }

    if (!hint?.version) {
      log.info('[UpdateManager] WS push recheck: no eligible update from backend')
      return
    }

    this.lastBackendHint = hint
    this.currentDownloadVersion = hint.version
    this.preparedDownloadVersion = undefined
    this.setState({
      status: 'available',
      updateInfo: hint,
      errorMessage: null,
      releaseSource: 'backend',
    })

    if (hint.priority === 'critical' || hint.mandatory) {
      await this.handleCriticalUpdate(hint)
    } else if (payload?.silent) {
      await this.handleSilentUpdate(hint)
    } else {
      this.showUpdateNotification(hint)
    }
  }

  private async handleCriticalUpdate(payload: any): Promise<void> {
    log.warn('[UpdateManager] Critical update received')
    this.notifyRenderer('update-available', this.lastBackendHint)
    this.showUpdateDesktopNotification(payload, true)

    try {
      await this.ensureUpdatePrepared(payload.version)
      await this.downloadUpdate()
    } catch (err) {
      log.error('[UpdateManager] Failed to download critical update:', err)
      this.notifyRenderer('update-error', err instanceof Error ? err.message : String(err))
    }
  }

  private async handleSilentUpdate(payload: any): Promise<void> {
    log.info('[UpdateManager] Starting silent download')
    const prevAutoDownload = autoUpdater.autoDownload

    try {
      autoUpdater.autoDownload = true
      await this.checkForUpdates(true, 'silent', payload.version)
    } catch (err) {
      log.error('[UpdateManager] Silent download failed:', err)
      this.notifyRenderer('update-error', err instanceof Error ? err.message : String(err))
    } finally {
      autoUpdater.autoDownload = prevAutoDownload
    }
  }

  private mergeUpdateInfo(info: Record<string, any>, source: UpdateEventSource): Record<string, any> {
    const backendHint =
      this.lastBackendHint && this.lastBackendHint.version === info.version
        ? this.lastBackendHint
        : null

    return {
      ...info,
      platform: info.platform ?? backendHint?.platform ?? this.runtimePlatform,
      arch: info.arch ?? backendHint?.arch ?? this.runtimeArch,
      channel: info.channel ?? backendHint?.channel ?? this.runtimeChannel,
      version: info.version || backendHint?.version || null,
      mandatory: Boolean(info.mandatory ?? backendHint?.mandatory ?? false),
      priority: info.priority || backendHint?.priority || 'normal',
      releaseNotes:
        info.releaseNotes ??
        info.release_notes ??
        backendHint?.releaseNotes ??
        backendHint?.release_notes ??
        '',
      releaseDate:
        info.releaseDate ??
        info.release_date ??
        backendHint?.releaseDate ??
        backendHint?.release_date ??
        null,
      feedUrl: info.feedUrl ?? info.feed_url ?? backendHint?.feedUrl ?? backendHint?.feed_url ?? null,
      manifestUrl:
        info.manifestUrl ?? info.manifest_url ?? backendHint?.manifestUrl ?? backendHint?.manifest_url ?? null,
      manifestFile:
        info.manifestFile ?? info.manifest_file ?? backendHint?.manifestFile ?? backendHint?.manifest_file ?? null,
      fileUrl: info.fileUrl ?? info.file_url ?? backendHint?.fileUrl ?? backendHint?.file_url ?? null,
      fileSize: info.fileSize ?? info.file_size ?? backendHint?.fileSize ?? backendHint?.file_size ?? null,
      checksum: info.checksum ?? backendHint?.checksum ?? null,
      source,
    }
  }

  private showUpdateNotification(payload: Record<string, any>): void {
    this.notifyRenderer('update-available', payload)
    this.showUpdateDesktopNotification(payload, false)
  }

  private showUpdateDesktopNotification(payload: Record<string, any>, mandatory: boolean): void {
    notificationService.show({
      type: mandatory ? 'system.update.mandatory' : 'system.update.available',
      title: mandatory ? `必须更新到 v${payload.version}` : `发现新版本 v${payload.version}`,
      body:
        (payload.releaseNotes || payload.release_notes || '').slice(0, 100) +
        ((payload.releaseNotes || payload.release_notes || '').length > 100 ? '...' : '')
        || (mandatory ? '请完成更新后继续使用。' : '新版本已可用。'),
      priority: mandatory ? 'urgent' as const : 'high' as const,
      onClick: 'navigate',
      navigateTo: {
        type: 'settings',
        id: 'about',
        route: 'about',
      },
      metadata: {
        version: payload.version,
        dedup_ref: `system-update:${payload.version}:${mandatory ? 'mandatory' : 'available'}`,
      },
      mirrorToCenter: false,
      toastFallback: true,
    })
  }


  private showUpdateMessageBox(
    options: MessageBoxOptions,
  ): Promise<MessageBoxReturnValue> {
    const parent =
      this.mainWindow && !this.mainWindow.isDestroyed() ? this.mainWindow : undefined
    if (parent) {
      return dialog.showMessageBox(parent, options)
    }
    return dialog.showMessageBox(options)
  }

  private async showRestartDialog(info: UpdateInfo): Promise<void> {
    // mandatory = 必须装上才能继续用：下载完成即阻断，只有「立即重启」一条路。
    // critical（非 mandatory）自动下载但不阻断，与普通更新走同一个可延后对话框。
    if ((info as any).mandatory) {
      this.notifyRenderer('update-restart-dialog-open', { version: info.version, mandatory: true })
      await this.showUpdateMessageBox({
        type: 'warning',
        title: '必须更新',
        message: `新版本 v${info.version} 为强制更新，需要立即重启安装后才能继续使用。`,
        buttons: ['立即重启并安装'],
        defaultId: 0,
      })
      this.quitAndInstall()
      return
    }

    this.notifyRenderer('update-restart-dialog-open', { version: info.version, mandatory: false })
    const { response } = await this.showUpdateMessageBox({
      type: 'info',
      title: '更新已下载',
      message: `新版本 v${info.version} 已下载完成，是否立即重启应用？`,
      buttons: ['稍后重启', '立即重启'],
      defaultId: 1,
    })

    if (response === 1) {
      this.quitAndInstall()
    } else {
      this.notifyRenderer('update-restart-dialog-closed', { version: info.version, action: 'later' })
    }
  }

  private notifyRenderer(event: string, data?: any): void {
    this.mainWindow?.webContents.send('update-event', { event, data })
  }
}
