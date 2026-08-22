import { describe, expect, it } from 'vitest'
import type { ResourceMonitorSnapshot } from '@shared/types/resource-monitor'
import {
  clearResourceMonitorGovernanceHistory,
  getResourceMonitorGovernanceEvents,
  deriveResourceMonitorHistoryState,
  recordResourceMonitorGovernanceEvent,
  reduceResourceMonitorHistory,
} from './history'

function createSnapshot(overrides: Partial<ResourceMonitorSnapshot> = {}): ResourceMonitorSnapshot {
  return {
    host: {
      totalMemory: 16 * 1024 * 1024 * 1024,
      freeMemory: 8 * 1024 * 1024 * 1024,
      usedMemory: 8 * 1024 * 1024 * 1024,
      memoryUsagePercent: 50,
      cpuCoreCount: 8,
      loadAverage1m: 1,
    },
    app: {
      cpu: 40,
      memory: 600 * 1024 * 1024,
      main: { cpu: 8, memory: 120 * 1024 * 1024 },
      renderer: { cpu: 22, memory: 420 * 1024 * 1024 },
      other: { cpu: 10, memory: 60 * 1024 * 1024 },
    },
    ptySessions: [],
    browserViews: [],
    runSummary: {
      totalRuns: 2,
      activeRuns: 1,
      totalViews: 1,
      inUseViews: 1,
    },
    runs: [],
    viewFactory: {
      total: 3,
      inUse: 1,
      idle: 2,
      byProfile: {},
      pending: {
        resource: 0,
        cdp: 0,
      },
    },
    totalCpu: 60,
    totalMemory: 900 * 1024 * 1024,
    collectedAt: 1000,
    ...overrides,
  }
}

describe('resource-monitor history', () => {
  it('按 collectedAt 去重并保留最新样本', () => {
    const base = createSnapshot({ collectedAt: 1000, totalMemory: 900 * 1024 * 1024 })
    const updated = createSnapshot({ collectedAt: 1000, totalMemory: 980 * 1024 * 1024 })

    const once = reduceResourceMonitorHistory([], base, { now: 1000 })
    const deduped = reduceResourceMonitorHistory(once, updated, { now: 1000 })

    expect(deduped).toHaveLength(1)
    expect(deduped[0]?.totalMemory).toBe(980 * 1024 * 1024)
  })

  it('计算最近趋势并标记 stale 状态', () => {
    const samples = [
      {
        collectedAt: 1,
        totalCpu: 48,
        totalMemory: 800 * 1024 * 1024,
        ramSharePercent: 5,
        hostUsedMemoryPercent: 30,
        browserCpu: 12,
        browserMemory: 240 * 1024 * 1024,
        browserViewCount: 1,
        detachedBrowserViewCount: 0,
        previewBrowserViewCount: 0,
        loadingBrowserViewCount: 0,
        ptySessionCount: 1,
        activeRuns: 1,
      },
      {
        collectedAt: 2 * 60 * 1000,
        totalCpu: 92,
        totalMemory: 1024 * 1024 * 1024,
        ramSharePercent: 6.5,
        hostUsedMemoryPercent: 34,
        browserCpu: 24,
        browserMemory: 420 * 1024 * 1024,
        browserViewCount: 2,
        detachedBrowserViewCount: 1,
        previewBrowserViewCount: 0,
        loadingBrowserViewCount: 1,
        ptySessionCount: 2,
        activeRuns: 2,
      },
      {
        collectedAt: 4 * 60 * 1000,
        totalCpu: 118,
        totalMemory: 1280 * 1024 * 1024,
        ramSharePercent: 8,
        hostUsedMemoryPercent: 38,
        browserCpu: 38,
        browserMemory: 620 * 1024 * 1024,
        browserViewCount: 3,
        detachedBrowserViewCount: 2,
        previewBrowserViewCount: 1,
        loadingBrowserViewCount: 1,
        ptySessionCount: 2,
        activeRuns: 2,
      },
    ]

    const history = deriveResourceMonitorHistoryState(samples, {
      now: 4 * 60 * 1000 + 40 * 1000,
      staleThresholdMs: 30 * 1000,
    })

    expect(history.sampleCount).toBe(3)
    expect(history.memoryTrend.direction).toBe('up')
    expect(history.cpuTrend.direction).toBe('up')
    expect(history.browserMemoryTrend.direction).toBe('up')
    expect(history.browserSummary.viewCountDelta).toBe(2)
    expect(history.browserSummary.detachedCountDelta).toBe(2)
    expect(history.stale).toBe(true)
    expect(history.staleMs).toBe(40 * 1000)
  })

  it('保留最近的治理记录并清理过期项', () => {
    clearResourceMonitorGovernanceHistory()

    recordResourceMonitorGovernanceEvent({
      kind: 'browser-close',
      at: 1,
      attemptedCount: 1,
      succeeded: [{ title: 'old', reason: '脱屏' }],
      failed: [],
    })
    recordResourceMonitorGovernanceEvent({
      kind: 'browser-close',
      at: 10 * 60 * 1000,
      attemptedCount: 2,
      succeeded: [{ title: 'preview-1', reason: '预览态' }],
      failed: [{ title: 'preview-2', reason: '预览态', error: 'still loading' }],
    })
    recordResourceMonitorGovernanceEvent({
      kind: 'browser-close',
      at: 31 * 60 * 1000,
      attemptedCount: 1,
      succeeded: [{ title: 'detached-1', reason: '脱屏' }],
      failed: [],
    })

    const events = getResourceMonitorGovernanceEvents()
    expect(events).toHaveLength(2)
    expect(events.map((event) => event.at)).toEqual([10 * 60 * 1000, 31 * 60 * 1000])

    clearResourceMonitorGovernanceHistory()
    expect(getResourceMonitorGovernanceEvents()).toHaveLength(0)
  })
})
