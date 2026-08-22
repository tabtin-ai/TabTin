/**
 * AA-005 回归测试：viewToRun 孤儿条目泄漏
 *
 * 验证：autoClose=false 的 View 在 endRun 后若通过非 closeTab 路径销毁，
 * view:destroyed 事件能自动清理 viewToRun 映射，不会永久驻留。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'events'

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

class MockViewFactory extends EventEmitter {
  private views = new Map<string, any>()

  async createView(config: any) {
    const id = config.id || `view-${Date.now()}`
    this.views.set(id, {
      id,
      profile: config.profile,
      config: { autoClose: config.autoClose ?? true },
    })
    return { id, profile: config.profile, reused: false }
  }

  markViewInUse(_id: string) {}

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
    const state = this.views.get(id)
    this.views.delete(id)
    if (state) {
      this.emit('view:destroyed', { id, profile: state.profile })
    }
  }

  async onTaskCompleted(viewId: string) {
    const state = this.views.get(viewId)
    if (!state) return
    if (state.config.autoClose) {
      await this.destroyView(viewId)
    }
  }
}

describe('AA-005: viewToRun 孤儿条目清理', () => {
  let mockVF: MockViewFactory
  let rsm: ReturnType<typeof getRunSessionManager>

  beforeEach(() => {
    mockVF = new MockViewFactory()
    setViewFactoryAccessor(() => mockVF as any)
    rsm = getRunSessionManager()
  })

  it('handleViewDestroyed 应清理 viewToRun 映射', () => {
    const runId = 'run-test-1'
    rsm.createRun(runId)
    rsm.registerView(runId, {
      viewId: 'v1',
      createdAt: Date.now(),
      inUse: true,
    })

    expect(rsm.getRunIdByView('v1')).toBe(runId)

    rsm.handleViewDestroyed('v1')

    expect(rsm.getRunIdByView('v1')).toBeUndefined()
  })

  it('handleViewDestroyed 应同时从 Run 的 views 中移除', () => {
    const runId = 'run-test-2'
    rsm.createRun(runId)
    rsm.registerView(runId, {
      viewId: 'v2',
      createdAt: Date.now(),
      inUse: true,
    })

    const before = rsm.getRun(runId)!
    expect(before.views).toHaveLength(1)

    rsm.handleViewDestroyed('v2')

    const after = rsm.getRun(runId)!
    expect(after.views).toHaveLength(0)
  })

  it('handleViewDestroyed 清除 activeViewId（如果匹配）', () => {
    const runId = 'run-test-3'
    rsm.createRun(runId)
    rsm.registerView(runId, {
      viewId: 'v3',
      createdAt: Date.now(),
      inUse: true,
    })
    rsm.setActiveView(runId, 'v3')

    expect(rsm.getRun(runId)!.activeViewId).toBe('v3')

    rsm.handleViewDestroyed('v3')

    expect(rsm.getRun(runId)!.activeViewId).toBeNull()
  })

  it('handleViewDestroyed 对不存在的 viewId 是幂等的', () => {
    expect(() => rsm.handleViewDestroyed('non-existent')).not.toThrow()
  })

  it('view:destroyed 事件应触发 viewToRun 自动清理', async () => {
    const runId = 'run-test-event'
    rsm.createRun(runId)

    // 先在 MockViewFactory 中创建 view，使其内部 views Map 中有记录
    await mockVF.createView({ id: 'v-evt', profile: 'user-tab' })
    rsm.registerView(runId, {
      viewId: 'v-evt',
      createdAt: Date.now(),
      inUse: true,
    })

    expect(rsm.getRunIdByView('v-evt')).toBe(runId)

    // 模拟 ViewFactory 销毁 view（会触发 view:destroyed 事件）
    await mockVF.destroyView('v-evt')

    expect(rsm.getRunIdByView('v-evt')).toBeUndefined()
  })

  it('endRun 后 autoClose=false View 被外部销毁时应清理映射（核心场景）', async () => {
    const runId = 'run-autoclose-false'
    rsm.createRun(runId)

    // 注册一个 autoClose=false 的 view
    await mockVF.createView({ id: 'v-keep', autoClose: false, profile: 'user-tab' })
    rsm.registerView(runId, {
      viewId: 'v-keep',
      createdAt: Date.now(),
      inUse: true,
    })

    expect(rsm.getRunIdByView('v-keep')).toBe(runId)

    // endRun 后 autoClose=false 的 view 保留 viewToRun 映射
    await rsm.endRun(runId)

    // Run 已被删除，但 viewToRun 映射仍存在（设计如此，等待 view 真正销毁）
    expect(rsm.getRunIdByView('v-keep')).toBe(runId)

    // 模拟用户直接关闭窗口 → ViewFactory.destroyView → view:destroyed 事件
    await mockVF.destroyView('v-keep')

    // 映射应被自动清理
    expect(rsm.getRunIdByView('v-keep')).toBeUndefined()
  })
})
