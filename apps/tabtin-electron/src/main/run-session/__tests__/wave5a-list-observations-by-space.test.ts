/**
 * Wave 5a (L-W4-1) — `RunSessionManager.listObservationsBySpaceSince` 单测。
 *
 * 这是 agent-runtime 通过 `EngineConfig.getRecentRunObservations` 拿"自上次以来
 * 新增 observation"的核心 RSM 入口。验证：
 *   1. 跨 run 聚合：同 spaceId 多个 run 的 observation 一起返回（按 timestamp 排序）；
 *   2. 时间过滤是 strict greater than（`> since`），调用方传上次最大 timestamp 即可
 *      跳过已读条目，无需 +1ms；
 *   3. 跨 spaceId 隔离：另一个 spaceId 的 observation 不会泄漏到本 spaceId 查询；
 *   4. 边界 case：spaceId 不存在 / observation 数组为空 → 返回空数组。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/fake') },
}))

vi.mock('../../crawlspace/CrawlspaceContextHub', () => ({
  getCrawlspaceContextHub: vi.fn(() => ({ setActiveView: vi.fn() })),
}))

vi.mock('../../crawlspace/view-metadata-sync', () => ({
  syncWorkspaceViewMetadata: vi.fn(),
}))

vi.mock('../../organization/OrganizationTabManager', () => ({
  getOrganizationTabManager: vi.fn(() => ({
    getTabByView: vi.fn(),
    isOrganizationTab: vi.fn(() => false),
  })),
}))

vi.mock('../../cli/cli-server', () => ({
  getCLISpaceId: vi.fn(() => null),
  getCLICrawlspaceId: vi.fn(() => null),
}))

vi.mock('../../browser-env/BrowserEnvironmentService', () => ({
  getBrowserEnvironmentService: vi.fn(() => ({
    getPartitionForSpace: vi.fn(() => null),
    getAllKnownSpaceEnvBindings: vi.fn(() => []),
    onChanged: vi.fn(() => () => undefined),
  })),
}))

vi.mock('../EventPersistence', () => ({
  getEventPersistence: vi.fn(() => ({
    addEvent: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
  })),
}))

import { getRunSessionManager, disposeRunSessionManager } from '../RunSessionManager'

describe('RunSessionManager.listObservationsBySpaceSince — Wave 5a (L-W4-1)', () => {
  beforeEach(() => {
    disposeRunSessionManager()
  })

  it('跨 run 聚合 + 按 timestamp 排序', async () => {
    const rsm = getRunSessionManager()
    rsm.createRun('run-A')
    rsm.createRun('run-B')
    // 直接访问内部 runs map（测试无外部 API 设 spaceId）
    ;(rsm as any).runs.get('run-A').spaceId = 'space-x'
    ;(rsm as any).runs.get('run-B').spaceId = 'space-x'

    rsm.addObservation({ runId: 'run-A', type: 'AGENT_AUTOFILL_FAILED', timestamp: 1000, data: { domain: 'a.com' } })
    rsm.addObservation({ runId: 'run-B', type: 'AGENT_AUTOFILL_FAILED', timestamp: 500, data: { domain: 'b.com' } })
    rsm.addObservation({ runId: 'run-A', type: 'SPACE_ENV_CHANGED', timestamp: 2000, data: {} })

    const result = rsm.listObservationsBySpaceSince('space-x', 0)
    expect(result.map((o) => o.timestamp)).toEqual([500, 1000, 2000])
    expect(result.map((o) => o.runId)).toEqual(['run-B', 'run-A', 'run-A'])
  })

  it('strict greater than：上次最大 ts 直接传入跳过已读', async () => {
    const rsm = getRunSessionManager()
    rsm.createRun('run-A')
    ;(rsm as any).runs.get('run-A').spaceId = 'space-y'

    rsm.addObservation({ runId: 'run-A', type: 'AGENT_AUTOFILL_FAILED', timestamp: 100, data: {} })
    rsm.addObservation({ runId: 'run-A', type: 'AGENT_AUTOFILL_FAILED', timestamp: 200, data: {} })
    rsm.addObservation({ runId: 'run-A', type: 'AGENT_AUTOFILL_FAILED', timestamp: 300, data: {} })

    const firstBatch = rsm.listObservationsBySpaceSince('space-y', 0)
    expect(firstBatch.map((o) => o.timestamp)).toEqual([100, 200, 300])

    // 第二次传入上次最大 timestamp 200，期望返回 (200, +∞) 不含等号
    const secondBatch = rsm.listObservationsBySpaceSince('space-y', 200)
    expect(secondBatch.map((o) => o.timestamp)).toEqual([300])

    // 全已读
    const thirdBatch = rsm.listObservationsBySpaceSince('space-y', 300)
    expect(thirdBatch).toEqual([])
  })

  it('跨 spaceId 隔离：另一 spaceId 的 observation 不会泄漏', async () => {
    const rsm = getRunSessionManager()
    rsm.createRun('run-X')
    rsm.createRun('run-Y')
    ;(rsm as any).runs.get('run-X').spaceId = 'space-x'
    ;(rsm as any).runs.get('run-Y').spaceId = 'space-y'

    rsm.addObservation({ runId: 'run-X', type: 'AGENT_AUTOFILL_FAILED', timestamp: 100, data: { domain: 'x.com' } })
    rsm.addObservation({ runId: 'run-Y', type: 'AGENT_AUTOFILL_FAILED', timestamp: 200, data: { domain: 'y.com' } })

    const xResults = rsm.listObservationsBySpaceSince('space-x', 0)
    expect(xResults.map((o) => o.runId)).toEqual(['run-X'])
    expect((xResults[0]!.data as { domain: string }).domain).toBe('x.com')

    const yResults = rsm.listObservationsBySpaceSince('space-y', 0)
    expect(yResults.map((o) => o.runId)).toEqual(['run-Y'])
  })

  it('未知 spaceId / 空 observation 数组 → 返回空数组', async () => {
    const rsm = getRunSessionManager()
    rsm.createRun('run-Z')
    ;(rsm as any).runs.get('run-Z').spaceId = 'space-z'
    // run-Z 无 observation
    expect(rsm.listObservationsBySpaceSince('space-z', 0)).toEqual([])
    // 完全未知 spaceId
    expect(rsm.listObservationsBySpaceSince('does-not-exist', 0)).toEqual([])
  })
})
