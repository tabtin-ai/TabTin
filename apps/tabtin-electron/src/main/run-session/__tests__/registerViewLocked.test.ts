/**
 * AA-001 回归测试：registerView 绕过 openTab 互斥锁
 *
 * 验证：registerViewLocked 与 openTab 共享 _openTabLock 互斥锁，
 * 确保 reuseViewId 路径的 registerView 不会与 openTab 并发执行，防止 TOCTOU 竞态。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../crawlspace/CrawlspaceContextHub', () => ({
  getCrawlspaceContextHub: vi.fn(() => ({
    setActiveView: vi.fn(),
  })),
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

vi.mock('../EventPersistence', () => ({
  getEventPersistence: vi.fn(() => ({
    addEvent: vi.fn(),
    flush: vi.fn(),
  })),
}))

vi.mock('../../cli/cli-server', () => ({
  getCLISpaceId: vi.fn(() => null),
  getCLICrawlspaceId: vi.fn(() => null),
}))

import {
  getRunSessionManager,
  setViewFactoryAccessor,
} from '../RunSessionManager'

function createMockViewFactory(createDelay = 0) {
  const views = new Map<string, any>()
  return {
    createView: vi.fn().mockImplementation(async (config: any) => {
      if (createDelay > 0) {
        await new Promise(r => setTimeout(r, createDelay))
      }
      const id = config.id || `view-${Date.now()}`
      views.set(id, { id, profile: config.profile, config: { autoClose: true } })
      return { id, profile: config.profile, reused: false }
    }),
    markViewInUse: vi.fn(),
    hasView: (id: string) => views.has(id),
    getViewState: (id: string) => views.get(id) ?? null,
    getStats: () => ({ total: views.size }),
    showView: vi.fn(),
    destroyView: vi.fn(),
    onTaskCompleted: vi.fn(),
    _views: views,
  }
}

describe('AA-001: registerViewLocked 互斥锁保护', () => {
  let rsm: ReturnType<typeof getRunSessionManager>

  beforeEach(() => {
    setViewFactoryAccessor(() => createMockViewFactory(50) as any)
    rsm = getRunSessionManager()
  })

  it('registerViewLocked 应成功注册视图到 Run', async () => {
    const runId = 'run-rvl-basic'
    rsm.createRun(runId)

    await rsm.registerViewLocked(runId, {
      viewId: 'v-basic',
      createdAt: Date.now(),
      inUse: true,
    })

    expect(rsm.getRunIdByView('v-basic')).toBe(runId)
    const run = rsm.getRun(runId)
    expect(run?.views).toHaveLength(1)
    expect(run?.views[0].viewId).toBe('v-basic')
  })

  it('registerViewLocked 应与 openTab 串行执行（共享 _openTabLock）', async () => {
    const runId = 'run-rvl-serial'
    rsm.createRun(runId)

    const callOrder: string[] = []

    const openTabPromise = rsm.openTab({
      runId,
      id: 'ot-view-1',
      url: 'https://example.com',
    }).then(() => {
      callOrder.push('openTab')
    })

    const registerPromise = rsm.registerViewLocked(runId, {
      viewId: 'rv-view-1',
      createdAt: Date.now(),
      inUse: true,
    }).then(() => {
      callOrder.push('registerViewLocked')
    })

    await Promise.all([openTabPromise, registerPromise])

    expect(callOrder[0]).toBe('openTab')
    expect(callOrder[1]).toBe('registerViewLocked')
  })

  it('并发 registerViewLocked 应受 Run 配额限制', async () => {
    const runId = 'run-rvl-quota'
    rsm.createRun(runId)
    rsm.configureQuota({ maxViewsPerRun: 2, maxTotalViews: 100, enabled: true })

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) =>
        rsm.registerViewLocked(runId, {
          viewId: `v-q-${i}`,
          createdAt: Date.now(),
          inUse: true,
        })
      )
    )

    const successes = results.filter(r => r.status === 'fulfilled')
    const failures = results.filter(r => r.status === 'rejected')

    expect(successes).toHaveLength(2)
    expect(failures).toHaveLength(3)
  })

  it('registerViewLocked 配额错误不应影响后续调用', async () => {
    const runId = 'run-rvl-recover'
    rsm.createRun(runId)
    rsm.configureQuota({ maxViewsPerRun: 1, maxTotalViews: 100, enabled: true })

    await rsm.registerViewLocked(runId, {
      viewId: 'v-first',
      createdAt: Date.now(),
      inUse: true,
    })

    await expect(
      rsm.registerViewLocked(runId, {
        viewId: 'v-second',
        createdAt: Date.now(),
        inUse: true,
      })
    ).rejects.toThrow()

    const runId2 = 'run-rvl-recover-2'
    rsm.createRun(runId2)

    await expect(
      rsm.registerViewLocked(runId2, {
        viewId: 'v-other-run',
        createdAt: Date.now(),
        inUse: true,
      })
    ).resolves.not.toThrow()

    expect(rsm.getRunIdByView('v-other-run')).toBe(runId2)
  })
})
