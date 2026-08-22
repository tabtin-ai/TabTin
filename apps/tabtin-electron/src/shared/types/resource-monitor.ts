export type ResourceMonitorSnapshotMode = 'interactive' | 'idle'

export interface ResourceMonitorUsage {
  cpu: number
  memory: number
}

export interface ResourceMonitorHostMetrics {
  totalMemory: number
  freeMemory: number
  usedMemory: number
  memoryUsagePercent: number
  cpuCoreCount: number
  loadAverage1m: number
}

export interface ResourceMonitorAppMetrics extends ResourceMonitorUsage {
  main: ResourceMonitorUsage
  renderer: ResourceMonitorUsage
  other: ResourceMonitorUsage
}

export interface ResourceMonitorRendererWindowMetrics extends ResourceMonitorUsage {
  windowId: number
  kind: 'main-window' | 'aux-window'
  title: string
  osPid: number | null
  isVisible: boolean
}

export interface ResourceMonitorPtySessionMetrics extends ResourceMonitorUsage {
  sessionId: string
  spaceId: string | null
  pid: number
  cwd: string
  isRunning: boolean
  createdAt: number
  lastOutputAt: number
  lastExitCode: number | null
  lastCommandCompletedAt: number | null
  hasPendingCommand: boolean
}

export interface ResourceMonitorBrowserViewMetrics extends ResourceMonitorUsage {
  viewId: string
  crawlspaceId: string | null
  runId: string | null
  /** 创建时直接绑定的 spaceId，资源监控归因首选来源 */
  spaceId?: string | null
  profile: string
  title: string
  url: string
  webContentsId: number | null
  osPid: number | null
  sharedProcessCount: number
  inUse: boolean
  attachedToMainWindow: boolean
  isLoading: boolean
  isPreview: boolean
}

export interface ResourceMonitorRunStats {
  runId: string
  sessionId: string
  spaceId: string | null
  crawlspaceId: string | null
  viewCount: number
  inUseViewCount: number
  activeViewId: string | null
  createdAt: number
  updatedAt: number
  lastEventAt: number | null
  eventCount: number
}

export interface ResourceMonitorRunSummary {
  totalRuns: number
  activeRuns: number
  totalViews: number
  inUseViews: number
}

export interface ResourceMonitorViewFactoryStats {
  total: number
  inUse: number
  idle: number
  byProfile: Record<string, number>
  pending: {
    resource: number
    cdp: number
  }
}

export interface ResourceMonitorSnapshot {
  host: ResourceMonitorHostMetrics
  app: ResourceMonitorAppMetrics
  rendererWindows: ResourceMonitorRendererWindowMetrics[]
  ptySessions: ResourceMonitorPtySessionMetrics[]
  browserViews: ResourceMonitorBrowserViewMetrics[]
  runSummary: ResourceMonitorRunSummary
  runs: ResourceMonitorRunStats[]
  viewFactory: ResourceMonitorViewFactoryStats
  totalCpu: number
  totalMemory: number
  collectedAt: number
}
