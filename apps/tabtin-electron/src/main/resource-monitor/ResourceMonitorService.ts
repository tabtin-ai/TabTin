import os from 'node:os'
import { BrowserWindow, app } from 'electron'
import { createLogger } from '../logger'
import { getPtyManager } from '../terminal/PtyManager'
import { getRunSessionManager } from '../run-session/RunSessionManager'
import { getViewFactory } from '../view-factory'
import { syncAllCrawlspaceViewInUseState } from '../crawlspace/sync-view-in-use'
import { getOrganizationTabManager } from '../organization/OrganizationTabManager'
import type {
  ResourceMonitorAppMetrics,
  ResourceMonitorBrowserViewMetrics,
  ResourceMonitorHostMetrics,
  ResourceMonitorPtySessionMetrics,
  ResourceMonitorRendererWindowMetrics,
  ResourceMonitorSnapshot,
  ResourceMonitorSnapshotMode,
  ResourceMonitorUsage,
} from '@shared/types/resource-monitor'
import {
  collectProcessSubtreeUsage,
  collectProcessUsageTable,
  type ProcessUsageEntry,
} from './process-usage'

const log = createLogger('ResourceMonitor')

const SNAPSHOT_MAX_AGE_MS: Record<ResourceMonitorSnapshotMode, number> = {
  interactive: 2500,
  idle: 15000,
}

const normalizeFiniteNumber = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.max(0, value)
}

function createHostMetrics(): ResourceMonitorHostMetrics {
  const totalMemory = normalizeFiniteNumber(os.totalmem())
  const freeMemory = normalizeFiniteNumber(os.freemem())
  const usedMemory = Math.max(0, totalMemory - freeMemory)
  return {
    totalMemory,
    freeMemory,
    usedMemory,
    memoryUsagePercent: totalMemory > 0 ? (usedMemory / totalMemory) * 100 : 0,
    cpuCoreCount: Math.max(1, os.cpus().length),
    loadAverage1m: normalizeFiniteNumber(os.loadavg()[0]),
  }
}

function emptyUsage(): ResourceMonitorUsage {
  return { cpu: 0, memory: 0 }
}

function createEmptySnapshot(): ResourceMonitorSnapshot {
  return {
    host: createHostMetrics(),
    app: {
      ...emptyUsage(),
      main: emptyUsage(),
      renderer: emptyUsage(),
      other: emptyUsage(),
    },
    rendererWindows: [],
    ptySessions: [],
    browserViews: [],
    runSummary: {
      totalRuns: 0,
      activeRuns: 0,
      totalViews: 0,
      inUseViews: 0,
    },
    runs: [],
    viewFactory: {
      total: 0,
      inUse: 0,
      idle: 0,
      byProfile: {},
      pending: { resource: 0, cdp: 0 },
    },
    totalCpu: 0,
    totalMemory: 0,
    collectedAt: Date.now(),
  }
}

type CollectOptions = {
  mode?: ResourceMonitorSnapshotMode
  force?: boolean
}

interface AppMetricSource {
  pid?: number
  type?: string
  cpu?: { percentCPUUsage?: number }
  memory?: { workingSetSize?: number }
}

type ProcessUsageMap = Map<number, ProcessUsageEntry>

export interface ResourceMonitorServiceDeps {
  getAppMetrics?: () => AppMetricSource[]
  collectProcessUsageTable?: () => Promise<ProcessUsageMap>
  getPtyManager?: typeof getPtyManager
  getRunSessionManager?: typeof getRunSessionManager
  getViewFactory?: typeof getViewFactory
  getOrganizationTabManager?: typeof getOrganizationTabManager
}

export class ResourceMonitorService {
  private cachedSnapshot: ResourceMonitorSnapshot | null = null
  private inflightCollection: Promise<ResourceMonitorSnapshot> | null = null
  private ptyUnavailableLogged = false
  private readonly getAppMetrics: () => AppMetricSource[]
  private readonly collectProcessUsageTable: () => Promise<ProcessUsageMap>
  private readonly getPtyManager: typeof getPtyManager
  private readonly getRunSessionManager: typeof getRunSessionManager
  private readonly getViewFactory: typeof getViewFactory
  private readonly getOrganizationTabManager: typeof getOrganizationTabManager

  constructor(deps: ResourceMonitorServiceDeps = {}) {
    this.getAppMetrics = deps.getAppMetrics ?? (() => app.getAppMetrics() as AppMetricSource[])
    this.collectProcessUsageTable = deps.collectProcessUsageTable ?? collectProcessUsageTable
    this.getPtyManager = deps.getPtyManager ?? getPtyManager
    this.getRunSessionManager = deps.getRunSessionManager ?? getRunSessionManager
    this.getViewFactory = deps.getViewFactory ?? getViewFactory
    this.getOrganizationTabManager = deps.getOrganizationTabManager ?? getOrganizationTabManager
  }

  async getSnapshot(options: CollectOptions = {}): Promise<ResourceMonitorSnapshot> {
    const mode = options.mode ?? 'interactive'
    const maxAgeMs = SNAPSHOT_MAX_AGE_MS[mode]

    if (!options.force && this.cachedSnapshot) {
      const ageMs = Date.now() - this.cachedSnapshot.collectedAt
      if (ageMs <= maxAgeMs) {
        return this.cachedSnapshot
      }
    }

    if (this.inflightCollection) {
      return this.inflightCollection
    }

    this.inflightCollection = this.collectNow()
      .catch((error) => {
        log.warn('采集资源快照失败，返回安全回退快照:', error)
        return this.cachedSnapshot ?? createEmptySnapshot()
      })
      .then((snapshot) => {
        this.cachedSnapshot = snapshot
        return snapshot
      })
      .finally(() => {
        this.inflightCollection = null
      })

    return this.inflightCollection
  }

  private collectAppMetrics(processMap: ProcessUsageMap): ResourceMonitorAppMetrics {
    const main = emptyUsage()
    const renderer = emptyUsage()
    const other = emptyUsage()

    const metrics = this.getAppMetrics()

    for (const metric of metrics) {
      const cpu = normalizeFiniteNumber(metric.cpu?.percentCPUUsage)
      const pid = metric.pid
      const rssEntry = pid ? processMap.get(pid) : null
      const memory = rssEntry
        ? rssEntry.memory
        : normalizeFiniteNumber(metric.memory?.workingSetSize) * 1024
      let target = other

      if (metric.type === 'Browser') {
        target = main
      } else if (typeof metric.type === 'string') {
        const normalizedType = metric.type.toLowerCase()
        if (normalizedType === 'renderer' || normalizedType === 'tab') {
          target = renderer
        }
      }

      target.cpu += cpu
      target.memory += memory
    }

    return {
      main,
      renderer,
      other,
      cpu: main.cpu + renderer.cpu + other.cpu,
      memory: main.memory + renderer.memory + other.memory,
    }
  }

  private collectPtySessionMetrics(
    processMap: ProcessUsageMap,
  ): ResourceMonitorPtySessionMetrics[] {
    let ptyManager: ReturnType<typeof getPtyManager>
    try {
      ptyManager = this.getPtyManager()
      this.ptyUnavailableLogged = false
    } catch (error) {
      if (!this.ptyUnavailableLogged) {
        log.warn('PtyManager 不可用，跳过 PTY 资源采集:', error)
        this.ptyUnavailableLogged = true
      }
      return []
    }
    const sessions = ptyManager.getAllSessionsWithStatus()

    return sessions.map((session) => {
      const usage = collectProcessSubtreeUsage(session.pid, processMap)
      const liveSession = ptyManager.getSession(session.id)
      return {
        sessionId: session.id,
        spaceId: liveSession?.spaceId ?? null,
        pid: session.pid,
        cwd: session.cwd,
        isRunning: session.isRunning,
        createdAt: session.createdAt,
        lastOutputAt: session.lastOutputAt,
        lastExitCode: session.lastExitCode,
        lastCommandCompletedAt: session.lastCommandCompletedAt,
        hasPendingCommand: session.hasPendingCommand,
        cpu: usage.cpu,
        memory: usage.memory,
      }
    })
  }

  private collectBrowserViewMetrics(
    processMap: ProcessUsageMap,
  ): ResourceMonitorBrowserViewMetrics[] {
    // 打开监控面板时自愈：预览/脱屏未激活应已是 inUse=false
    // getViewFactory() 会 ensure configureSyncViewInUse
    try {
      this.getViewFactory()
      syncAllCrawlspaceViewInUseState()
    } catch (err) {
      log.debug('采集前同步 Browser inUse 失败（可忽略）:', err)
    }

    const viewFactory = this.getViewFactory()
    const organizationTabManager = this.getOrganizationTabManager()
    const states = viewFactory.getAllViewStates()

    const pidOwners = new Map<number, string[]>()
    const rows = states.map((state) => {
      let webContentsId: number | null = null
      let osPid: number | null = null
      const webContents = state.view?.webContents ?? state.guestWebContents
      try {
        if (webContents && !webContents.isDestroyed()) {
          webContentsId = webContents.id
          osPid = normalizeFiniteNumber(webContents.getOSProcessId?.()) || null
        }
      } catch (err) {
        log.debug('采集 BrowserView 指标时 webContents 竞态销毁:', state.id, err)
      }
      if (osPid) {
        const owners = pidOwners.get(osPid) ?? []
        owners.push(state.id)
        pidOwners.set(osPid, owners)
      }

      return {
        state,
        webContents,
        webContentsId,
        osPid,
      }
    })

    return rows.map(({ state, webContents, webContentsId, osPid }) => {
      const ownerCount = osPid ? Math.max(1, pidOwners.get(osPid)?.length ?? 1) : 1
      const proc = osPid ? processMap.get(osPid) : null
      const cpu = proc ? proc.cpu / ownerCount : 0
      const memory = proc ? proc.memory / ownerCount : 0
      const organizationMeta = organizationTabManager.getViewMetadata(state.id)
      const crawlspaceId = (state.config.metadata?.crawlspaceId as string | undefined)
        ?? organizationTabManager.getTabByView(state.id)
        ?? null

      let isLoading = false
      try {
        isLoading = Boolean(webContents && !webContents.isDestroyed() && webContents.isLoading())
      } catch (err) {
        log.debug('检查 BrowserView isLoading 时 webContents 竞态销毁:', state.id, err)
      }

      return {
        viewId: state.id,
        crawlspaceId,
        runId: state.config.runId ?? null,
        spaceId: state.config.spaceId || null,
        profile: state.profile,
        title: organizationMeta?.title ?? state.config.tabName ?? '',
        url: organizationMeta?.url ?? state.url ?? '',
        webContentsId,
        osPid,
        sharedProcessCount: ownerCount,
        inUse: state.inUse,
        attachedToMainWindow: state.attachedToMainWindow,
        isLoading,
        isPreview: Boolean(state.config.metadata?.isPreview),
        cpu: normalizeFiniteNumber(cpu),
        memory: normalizeFiniteNumber(memory),
      }
    })
  }

  private collectRendererWindowMetrics(
    processMap: ProcessUsageMap,
  ): ResourceMonitorRendererWindowMetrics[] {
    return BrowserWindow.getAllWindows().map((window) => {
      let osPid: number | null = null
      let title = ''
      try {
        const webContents = window.webContents
        if (webContents && !webContents.isDestroyed()) {
          osPid = normalizeFiniteNumber(webContents.getOSProcessId?.()) || null
          title = webContents.getTitle()
        }
      } catch (err) {
        log.debug('采集 RendererWindow 指标时 webContents 竞态销毁:', window.id, err)
      }
      const proc = osPid ? processMap.get(osPid) : null

      return {
        windowId: window.id,
        kind: window.getParentWindow() ? 'aux-window' : 'main-window',
        title,
        osPid,
        isVisible: !window.isDestroyed() && window.isVisible(),
        cpu: normalizeFiniteNumber(proc?.cpu),
        memory: normalizeFiniteNumber(proc?.memory),
      }
    })
  }

  private async collectNow(): Promise<ResourceMonitorSnapshot> {
    const host = createHostMetrics()
    const processMap = await this.collectProcessUsageTable()
    const appMetrics = this.collectAppMetrics(processMap)
    const rendererWindows = this.collectRendererWindowMetrics(processMap)
    const ptySessions = this.collectPtySessionMetrics(processMap)
    const browserViews = this.collectBrowserViewMetrics(processMap)
    const runSessionStats = this.getRunSessionManager().getStats()
    const viewFactoryStats = this.getViewFactory().getStats()

    const ptyCpu = ptySessions.reduce((sum, session) => sum + session.cpu, 0)
    const ptyMemory = ptySessions.reduce((sum, session) => sum + session.memory, 0)

    return {
      host,
      app: appMetrics,
      rendererWindows,
      ptySessions,
      browserViews,
      runSummary: {
        totalRuns: runSessionStats.totalRuns,
        activeRuns: runSessionStats.activeRuns,
        totalViews: runSessionStats.totalViews,
        inUseViews: runSessionStats.inUseViews,
      },
      runs: runSessionStats.runs,
      viewFactory: viewFactoryStats,
      totalCpu: appMetrics.cpu + ptyCpu,
      totalMemory: appMetrics.memory + ptyMemory,
      collectedAt: Date.now(),
    }
  }
}

let service: ResourceMonitorService | null = null

export function getResourceMonitorService(): ResourceMonitorService {
  if (!service) {
    service = new ResourceMonitorService()
  }
  return service
}
