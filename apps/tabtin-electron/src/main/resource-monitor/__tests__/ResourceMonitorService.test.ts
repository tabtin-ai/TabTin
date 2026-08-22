import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppMetrics: () => [],
    getPath: () => '/tmp',
  },
  BrowserWindow: {
    getAllWindows: () => [],
  },
}))

vi.mock('../../logger', () => ({
  createLogger: vi.fn().mockReturnValue({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}))

vi.mock('../../terminal/PtyManager', () => ({
  getPtyManager: vi.fn(() => ({
    getAllSessionsWithStatus: () => [],
    getSession: () => null,
  })),
}))

vi.mock('../../run-session/RunSessionManager', () => ({
  getRunSessionManager: vi.fn(() => ({
    getStats: () => ({
      totalRuns: 0,
      activeRuns: 0,
      totalViews: 0,
      inUseViews: 0,
      runs: [],
    }),
  })),
}))

vi.mock('../../view-factory', () => ({
  getViewFactory: vi.fn(() => ({
    getAllViewStates: () => [],
    getStats: () => ({
      total: 0,
      inUse: 0,
      idle: 0,
      byProfile: {},
      pending: { resource: 0, cdp: 0 },
    }),
  })),
}))

vi.mock('../../organization/OrganizationTabManager', () => ({
  getOrganizationTabManager: vi.fn(() => ({
    getViewMetadata: () => null,
    getTabByView: () => null,
  })),
}))

import { ResourceMonitorService } from '../ResourceMonitorService'
import type { ProcessUsageEntry } from '../process-usage'

function createProcessMap(entries: ProcessUsageEntry[]): Map<number, ProcessUsageEntry> {
  return new Map(entries.map((entry) => [entry.pid, entry]))
}

function createService(options: {
  processMap: Map<number, ProcessUsageEntry>
  viewStates?: unknown[]
  sessions: Array<{
    id: string
    pid: number
    cwd: string
    isRunning: boolean
    lastOutputAt: number
    createdAt: number
    lastExitCode: number | null
    lastCommandCompletedAt: number | null
    hasPendingCommand: boolean
  }>
  liveSessionsById?: Record<string, { spaceId?: string | null }>
}): ResourceMonitorService {
  const ptyManager = {
    getAllSessionsWithStatus: () => options.sessions,
    getSession: (sessionId: string) => options.liveSessionsById?.[sessionId] ?? null,
  }

  const runSessionManager = {
    getStats: () => ({
      totalRuns: 0,
      activeRuns: 0,
      totalViews: 0,
      inUseViews: 0,
      runs: [],
    }),
  }

  const viewFactory = {
    getAllViewStates: () => options.viewStates ?? [],
    getStats: () => ({
      total: 0,
      inUse: 0,
      idle: 0,
      byProfile: {},
      pending: { resource: 0, cdp: 0 },
    }),
  }

  const organizationTabManager = {
    getViewMetadata: () => null,
    getTabByView: () => null,
  }

  return new ResourceMonitorService({
    getAppMetrics: () => [],
    collectProcessUsageTable: async () => options.processMap,
    getPtyManager: () => ptyManager as any,
    getRunSessionManager: () => runSessionManager as any,
    getViewFactory: () => viewFactory as any,
    getOrganizationTabManager: () => organizationTabManager as any,
  })
}

describe('ResourceMonitorService', () => {
  it('从 webview guest WebContents 归因 Browser 的进程资源', async () => {
    const guestWebContents = {
      id: 42,
      isDestroyed: () => false,
      getOSProcessId: () => 900,
      isLoading: () => true,
    }
    const service = createService({
      processMap: createProcessMap([
        { pid: 900, ppid: 1, cpu: 6.5, memory: 256 * 1024 * 1024, command: 'electron --type=renderer' },
      ]),
      sessions: [],
      viewStates: [
        {
          id: 'webview-browser',
          view: null,
          guestWebContents,
          containerKind: 'webview-tag',
          profile: 'agent-workspace',
          config: { runId: 'run-1', spaceId: 'space-1', metadata: { crawlspaceId: 'cs-1' } },
          url: 'https://www.baidu.com',
          inUse: true,
          attachedToMainWindow: false,
        },
      ],
    })

    const snapshot = await service.getSnapshot({ force: true })

    expect(snapshot.browserViews).toEqual([
      expect.objectContaining({
        viewId: 'webview-browser',
        webContentsId: 42,
        osPid: 900,
        cpu: 6.5,
        memory: 256 * 1024 * 1024,
        isLoading: true,
      }),
    ])
  })

  it('按 session.pid 聚合 PTY 进程树资源，并保留 live session 的 spaceId', async () => {
    const service = createService({
      processMap: createProcessMap([
        { pid: 700, ppid: 1, cpu: 1.25, memory: 2_048, command: '/bin/cat' },
        { pid: 701, ppid: 700, cpu: 2, memory: 4_096, command: 'child-worker' },
      ]),
      sessions: [
        {
          id: 'session-subprocess',
          pid: 700,
          cwd: '/tmp',
          isRunning: true,
          lastOutputAt: 11,
          createdAt: 10,
          lastExitCode: null,
          lastCommandCompletedAt: null,
          hasPendingCommand: false,
        },
      ],
      liveSessionsById: {
        'session-subprocess': { spaceId: 'space-123' },
      },
    })

    const snapshot = await service.getSnapshot({ force: true })

    expect(snapshot.ptySessions).toEqual([
      expect.objectContaining({
        sessionId: 'session-subprocess',
        spaceId: 'space-123',
        pid: 700,
        cpu: 3.25,
        memory: 6_144,
      }),
    ])
  })

  it('在 process map 缺失 session.pid 时安全回退到零资源占用', async () => {
    const service = createService({
      processMap: createProcessMap([]),
      sessions: [
        {
          id: 'session-pending-spawn',
          pid: 999_999,
          cwd: '/tmp',
          isRunning: true,
          lastOutputAt: 22,
          createdAt: 21,
          lastExitCode: null,
          lastCommandCompletedAt: null,
          hasPendingCommand: true,
        },
      ],
    })

    const snapshot = await service.getSnapshot({ force: true })

    expect(snapshot.ptySessions).toEqual([
      expect.objectContaining({
        sessionId: 'session-pending-spawn',
        pid: 999_999,
        cpu: 0,
        memory: 0,
        hasPendingCommand: true,
      }),
    ])
  })

  it('当 PtyManager 不可用时，应跳过 PTY 指标采集而不是让整次快照失败', async () => {
    const service = new ResourceMonitorService({
      getAppMetrics: () => [],
      collectProcessUsageTable: async () => createProcessMap([]),
      getPtyManager: () => {
        throw new Error('pty unavailable')
      },
      getRunSessionManager: () => ({
        getStats: () => ({
          totalRuns: 0,
          activeRuns: 0,
          totalViews: 0,
          inUseViews: 0,
          runs: [],
        }),
      }) as any,
      getViewFactory: () => ({
        getAllViewStates: () => [],
        getStats: () => ({
          total: 0,
          inUse: 0,
          idle: 0,
          byProfile: {},
          pending: { resource: 0, cdp: 0 },
        }),
      }) as any,
      getOrganizationTabManager: () => ({
        getViewMetadata: () => null,
        getTabByView: () => null,
      }) as any,
    })

    const snapshot = await service.getSnapshot({ force: true })

    expect(snapshot.ptySessions).toEqual([])
    expect(snapshot.app.cpu).toBe(0)
  })
})
