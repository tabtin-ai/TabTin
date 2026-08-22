/**
 * DI-011 / DI-019 回归测试
 * DI-011: endAllRuns 应结束所有活跃 Run
 * DI-019: 超时检查定时器应调用 .unref()
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

vi.mock('../../crawlspace/CrawlspaceContextHub', () => ({
  getCrawlspaceContextHub: () => ({
    setActiveView: vi.fn(),
    updateViewResourceSummary: vi.fn(),
  }),
}))
vi.mock('../../crawlspace/view-metadata-sync', () => ({
  syncWorkspaceViewMetadata: vi.fn(),
}))
vi.mock('../../organization/OrganizationTabManager', () => ({
  getOrganizationTabManager: () => ({
    getTabByView: vi.fn(),
    isOrganizationTab: vi.fn(),
  }),
}))
vi.mock('../EventPersistence', () => ({
  getEventPersistence: () => ({
    init: vi.fn().mockResolvedValue(undefined),
    addEvent: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
  }),
}))
vi.mock('../../cli/cli-server', () => ({
  getCLISpaceId: () => null,
  getCLICrawlspaceId: () => null,
}))

import { setViewFactoryAccessor, getRunSessionManager } from '../RunSessionManager'
import type { RunViewInfo } from '../RunSessionManager'

function createMockViewFactory() {
  const views = new Map<string, any>()
  return {
    createView: vi.fn(async (config: any) => {
      const id = config.id || `view-${Date.now()}`
      views.set(id, { id, config })
      return { id, profile: config.profile }
    }),
    markViewInUse: vi.fn(),
    hasView: (id: string) => views.has(id),
    getView: (id: string) => views.get(id),
    getViewState: (id: string) => views.get(id),
    getStats: () => ({ total: views.size }),
    showView: vi.fn().mockResolvedValue(undefined),
    destroyView: vi.fn(async (id: string) => { views.delete(id) }),
    onTaskCompleted: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
  }
}

describe('DI-011: RunSessionManager.endAllRuns()', () => {
  let mockVF: ReturnType<typeof createMockViewFactory>
  let manager: ReturnType<typeof getRunSessionManager>

  beforeEach(async () => {
    mockVF = createMockViewFactory()
    setViewFactoryAccessor(() => mockVF as any)
    manager = getRunSessionManager()
    // 确保测试前没有残留 Run
    await manager.endAllRuns()
    mockVF.onTaskCompleted.mockClear()
  })

  it('endAllRuns 应结束所有活跃 Run', async () => {
    const run1 = manager.createRun('run-1')
    const run2 = manager.createRun('run-2')

    manager.registerView('run-1', {
      viewId: 'v1',
      createdAt: Date.now(),
      inUse: true,
    } as RunViewInfo)
    manager.registerView('run-2', {
      viewId: 'v2',
      createdAt: Date.now(),
      inUse: true,
    } as RunViewInfo)

    expect(manager.listRuns()).toHaveLength(2)

    await manager.endAllRuns()

    expect(manager.listRuns()).toHaveLength(0)
    expect(mockVF.onTaskCompleted).toHaveBeenCalledTimes(2)
  })

  it('endAllRuns 无活跃 Run 时不报错', async () => {
    await expect(manager.endAllRuns()).resolves.toBeUndefined()
  })

  it('endAllRuns 单个 Run 清理失败不影响其他', async () => {
    manager.createRun('run-ok')
    manager.createRun('run-fail')
    manager.registerView('run-ok', {
      viewId: 'v-ok',
      createdAt: Date.now(),
      inUse: true,
    } as RunViewInfo)
    manager.registerView('run-fail', {
      viewId: 'v-fail',
      createdAt: Date.now(),
      inUse: true,
    } as RunViewInfo)

    mockVF.onTaskCompleted.mockImplementation(async (viewId: string) => {
      if (viewId === 'v-fail') throw new Error('模拟失败')
    })

    await manager.endAllRuns()
    expect(manager.listRuns()).toHaveLength(0)
  })
})

describe('DI-019: 超时检查定时器 .unref()', () => {
  it('setInterval 应调用 .unref()（源码验证）', () => {
    const source = readFileSync(
      resolve(__dirname, '../RunSessionManager.ts'),
      'utf-8',
    )
    const startTimeoutCheckerMatch = source.match(
      /this\.timeoutCheckInterval\s*=\s*setInterval\([^)]*\)[^;]*;?\s*\n\s*this\.timeoutCheckInterval\.unref\(\)/,
    )
    expect(startTimeoutCheckerMatch).not.toBeNull()
  })
})
