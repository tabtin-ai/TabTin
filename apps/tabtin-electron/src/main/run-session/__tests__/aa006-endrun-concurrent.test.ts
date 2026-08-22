/**
 * AA-006 回归测试
 *
 * endRun 遍历期间 viewToRun 映射延迟删除，
 * 并发 addObservation IPC 不会因映射提前清理而静默丢失事件。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'events'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/fake') },
}))

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

vi.mock('../../cli/cli-server', () => ({
  getCLISpaceId: vi.fn(() => null),
  getCLICrawlspaceId: vi.fn(() => null),
}))

const mockAddEvent = vi.fn()
const mockFlush = vi.fn().mockResolvedValue(undefined)

vi.mock('../EventPersistence', () => ({
  getEventPersistence: vi.fn(() => ({
    addEvent: mockAddEvent,
    flush: mockFlush,
  })),
}))

import {
  getRunSessionManager,
  setViewFactoryAccessor,
} from '../RunSessionManager'

class MockViewFactory extends EventEmitter {
  private views = new Map<string, any>()
  onTaskCompletedHook: ((viewId: string) => void) | null = null

  async createView(config: any) {
    const id = config.id || `view-${Date.now()}`
    this.views.set(id, {
      id,
      profile: config.profile,
      config: { autoClose: config.autoClose ?? true },
    })
    return { id, profile: config.profile, reused: false }
  }

  markViewInUse() {}

  hasView(id: string) {
    return this.views.has(id)
  }

  getViewState(id: string) {
    return this.views.get(id) ?? null
  }

  getStats() {
    return { total: this.views.size }
  }

  async showView() {}

  async destroyView(id: string) {
    this.views.delete(id)
  }

  async onTaskCompleted(viewId: string) {
    this.onTaskCompletedHook?.(viewId)
    const state = this.views.get(viewId)
    if (!state) return
    if (state.config.autoClose) {
      await this.destroyView(viewId)
    }
  }
}

describe('AA-006: endRun 期间 viewToRun 映射延迟删除', () => {
  let mockVF: MockViewFactory
  let rsm: ReturnType<typeof getRunSessionManager>

  beforeEach(() => {
    vi.clearAllMocks()
    mockVF = new MockViewFactory()
    setViewFactoryAccessor(() => mockVF as any)
    rsm = getRunSessionManager()
  })

  it('endRun 期间 addObservation 仍能通过 viewId 找到 runId', async () => {
    const runId = 'run-concurrent-obs'
    rsm.createRun(runId)

    await mockVF.createView({ id: 'v1', profile: 'bg', autoClose: true })
    await mockVF.createView({ id: 'v2', profile: 'bg', autoClose: true })

    rsm.registerView(runId, { viewId: 'v1', createdAt: Date.now(), inUse: true })
    rsm.registerView(runId, { viewId: 'v2', createdAt: Date.now(), inUse: true })

    let lateEventPersisted = false

    mockVF.onTaskCompletedHook = (viewId: string) => {
      if (viewId === 'v1') {
        expect(rsm.getRunIdByView('v2')).toBe(runId)

        rsm.addObservation({
          viewId: 'v2',
          type: 'LATE_IPC_EVENT',
          timestamp: Date.now(),
          data: { source: 'concurrent-ipc' },
        })

        const calls = mockAddEvent.mock.calls
        const lateCall = calls.find(
          (c: any[]) => c[0].type === 'LATE_IPC_EVENT' && c[0].viewId === 'v2'
        )
        if (lateCall) lateEventPersisted = true
      }
    }

    await rsm.endRun(runId)

    expect(lateEventPersisted).toBe(true)
  })

  it('endRun 后 autoClose=true 的 viewToRun 映射被清理', async () => {
    const runId = 'run-cleanup-check'
    rsm.createRun(runId)

    await mockVF.createView({ id: 'vc1', profile: 'bg', autoClose: true })
    rsm.registerView(runId, { viewId: 'vc1', createdAt: Date.now(), inUse: true })

    expect(rsm.getRunIdByView('vc1')).toBe(runId)

    await rsm.endRun(runId)

    expect(rsm.getRunIdByView('vc1')).toBeUndefined()
  })

  it('endRun 应 await flush() 确保事件持久化', async () => {
    const runId = 'run-flush-await'
    rsm.createRun(runId)

    await rsm.endRun(runId)

    expect(mockFlush).toHaveBeenCalled()
  })

  it('endRun 处理多视图时映射全部延迟删除', async () => {
    const runId = 'run-multi-view'
    rsm.createRun(runId)

    const viewIds = ['mv1', 'mv2', 'mv3']
    for (const vid of viewIds) {
      await mockVF.createView({ id: vid, profile: 'bg', autoClose: true })
      rsm.registerView(runId, { viewId: vid, createdAt: Date.now(), inUse: true })
    }

    const mappingsDuringLoop: boolean[] = []

    mockVF.onTaskCompletedHook = () => {
      mappingsDuringLoop.push(
        ...viewIds.map(vid => rsm.getRunIdByView(vid) === runId)
      )
    }

    await rsm.endRun(runId)

    expect(mappingsDuringLoop.every(Boolean)).toBe(true)

    for (const vid of viewIds) {
      expect(rsm.getRunIdByView(vid)).toBeUndefined()
    }
  })
})
