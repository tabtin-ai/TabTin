/**
 * AppDiscoveryService — TabWeb 智能发现
 *
 * 当用户在 TabWeb 中浏览某个 URL 时，检测是否匹配已知 marketplace app 的 urlPatterns。
 * 若匹配且该 app 未安装，通过 IPC 通知渲染进程展示安装提示横幅。
 *
 * **Patterns 来源（PRD §5.4 B3 / N5）**：
 * 主进程不再硬编码任何 App；renderer bootstrap 从后端
 * ``GET /api/marketplace/discovery-patterns`` 动态拉取（聚合所有 marketplace App 的
 * ``embeddedWeb.urlPatterns``），通过 ``app-discovery:update-patterns`` IPC 推送。
 * 见 ``renderer/src/services/marketplaceDiscoveryClient.ts``。
 */

import { ipcMain, BrowserWindow } from 'electron'
import { getMarketplaceAppInstaller } from './MarketplaceAppInstaller'
import { createLogger } from '../logger'

const log = createLogger('AppDiscovery')

export interface UrlPattern {
  appId: string
  appName: string
  patterns: string[]
}

const DISCOVERY_COOLDOWN_MS = 30 * 60 * 1000

interface PendingCheck {
  url: string
  mainWindow: BrowserWindow
}

class AppDiscoveryService {
  private urlPatterns: UrlPattern[] = []
  private patternsBySource = new Map<string, UrlPattern[]>()
  private dismissedApps: Map<string, number> = new Map()
  /**
   * 最近一次 ``checkUrl(url, mainWindow)`` 的入参，按 webContents id 去重。
   *
   * Patterns 经 ``app-discovery:update-patterns`` IPC 推送是异步过程，可能晚于
   * 第一次 TabWeb ``did-finish-load`` → ``checkUrl`` 调用；为了避免冷启动后
   * "打开 marketplace App 域名但 patterns 还没到 → 横幅永远不弹"，patterns 一旦
   * 更新，我们用此 Map replay 最近的 checkUrl，让横幅按预期出现。
   */
  private pendingChecks = new Map<number, PendingCheck>()

  registerPatterns(patterns: UrlPattern[], sourceId?: string): void {
    if (sourceId) {
      this.patternsBySource.set(sourceId, patterns)
      const merged = new Map<string, UrlPattern>()
      for (const entries of this.patternsBySource.values()) {
        for (const entry of entries) {
          merged.set(entry.appId, entry)
        }
      }
      this.urlPatterns = [...merged.values()]
    } else {
      this.urlPatterns = patterns
    }
    log.debug(`patterns 更新: count=${this.urlPatterns.length} source=${sourceId ?? 'default'}`)
    this.replayPendingChecks()
  }

  checkUrl(url: string, mainWindow: BrowserWindow | null): void {
    if (!url || !mainWindow) return
    if (typeof mainWindow.isDestroyed === 'function' && mainWindow.isDestroyed()) return

    const wcId = mainWindow.webContents?.id
    if (typeof wcId === 'number') {
      this.pendingChecks.set(wcId, { url, mainWindow })
    }

    this.performCheck(url, mainWindow)
  }

  dismissApp(appId: string): void {
    this.dismissedApps.set(appId, Date.now())
  }

  private replayPendingChecks(): void {
    if (this.urlPatterns.length === 0) return
    for (const [wcId, { url, mainWindow }] of this.pendingChecks) {
      if (typeof mainWindow.isDestroyed === 'function' && mainWindow.isDestroyed()) {
        this.pendingChecks.delete(wcId)
        continue
      }
      this.performCheck(url, mainWindow)
    }
  }

  private performCheck(url: string, mainWindow: BrowserWindow): void {
    let hostname: string
    try {
      hostname = new URL(url).hostname
    } catch {
      // 非标准 URL（blob:/about: 等）无 hostname，静默跳过——发现横幅只针对可解析的 http(s) 站点
      return
    }

    for (const entry of this.urlPatterns) {
      if (!this.matchesHostname(hostname, entry.patterns)) continue

      const dismissedAt = this.dismissedApps.get(entry.appId)
      if (dismissedAt && Date.now() - dismissedAt < DISCOVERY_COOLDOWN_MS) continue

      const installer = getMarketplaceAppInstaller()
      const installedVersion = installer.getInstalledVersion(entry.appId)
      if (installedVersion) continue

      log.info(`发现未安装的匹配 App，推送安装横幅: appId=${entry.appId} hostname=${hostname}`)
      mainWindow.webContents.send('marketplace:app-discovery', {
        appId: entry.appId,
        appName: entry.appName,
        matchedUrl: url,
      })
      break
    }
  }

  private matchesHostname(hostname: string, patterns: string[]): boolean {
    for (const pattern of patterns) {
      if (pattern.startsWith('*.')) {
        const suffix = pattern.slice(1)
        if (hostname.endsWith(suffix) || hostname === suffix.slice(1)) {
          return true
        }
      } else if (hostname === pattern) {
        return true
      }
    }
    return false
  }
}

let _instance: AppDiscoveryService | null = null

export function getAppDiscoveryService(): AppDiscoveryService {
  if (!_instance) {
    _instance = new AppDiscoveryService()
  }
  return _instance
}

export function registerAppDiscoveryIpc(): void {
  ipcMain.on('marketplace:dismiss-discovery', (_event, appId: string) => {
    getAppDiscoveryService().dismissApp(appId)
  })

  ipcMain.on('app-discovery:update-patterns', (_event, patterns: UrlPattern[], sourceId?: string) => {
    getAppDiscoveryService().registerPatterns(patterns, sourceId || undefined)
  })
}

export function initAppDiscoveryPatterns(): void {
  // PRD §5.4 B3：主进程不再硬编码任何 App 的 patterns。
  //
  // patterns 完全由 renderer bootstrap 通过 ``GET /api/marketplace/discovery-patterns``
  // 拉取后经 ``app-discovery:update-patterns`` IPC 推送。后端 API 在
  // ``apps/tabtin_django/apps/services/common/marketplace_discovery.py`` 聚合
  // ``MARKETPLACE_APPS`` 中的 ``embeddedWeb.urlPatterns``（复用既有字段，N5）。
  //
  // 兜底策略：API 失败时 patterns 维持空集；AppDiscovery 静默不弹横幅，
  // 既避免误报（弹用户没装的过期推荐），又不会因网络抖动给出错误信号。
  // 显式调用 getAppDiscoveryService() 保留单例预热语义，
  // 让 IPC 通道在 ipc-registry 阶段已经就位。
  getAppDiscoveryService()
}
