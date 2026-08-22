/**
 * close-workspace handler 注入集成测试（Wave 3.3）
 *
 * 验证 useCrawlTabStore 模块加载后：
 * 1. close handler 已注入（hasCloseWorkspaceHandler === true）
 * 2. requestCloseWorkspace 触发 store.closeCrawlspace
 * 3. 对未注册 cs 路由是幂等 noop（不抛错，set 都是 no-op）
 *
 * 这是单元测试（close-workspace.test.ts）之外的端到端契约——核心
 * 防御 Wave 2c 落地时"close 请求丢失"的根本场景。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// 必要的 mock —— useCrawlTabStore.ts 加载会拉一长串副作用（IPC client、
// session reset registry、syncer 等）；mock IPC clients 让 test 环境 0 副作用。
vi.mock('../../crawlspace/electron/run-session-client', () => ({
  runSessionClient: {
    endRun: vi.fn().mockResolvedValue({ success: true }),
  },
}))

vi.mock('../../crawlspace/electron/crawl-view-client', () => ({
  crawlViewClient: {
    hasView: vi.fn().mockResolvedValue({ exists: false }),
    destroyTabView: vi.fn().mockResolvedValue({ success: true }),
  },
}))

vi.mock('../../crawlspace/electron/crawlspace-context-client', () => ({
  crawlspaceContextClient: {
    subscribe: vi.fn().mockReturnValue(() => {}),
    closeView: vi.fn().mockResolvedValue({ ok: true }),
    getContext: vi.fn().mockResolvedValue(null),
  },
}))

import {
  hasCloseWorkspaceHandler,
  requestCloseWorkspace,
  setCloseWorkspaceHandler,
} from '@tabtin/crawlspace-core'
import { useCrawlTabStore } from '../useCrawlTabStore'

describe('useCrawlTabStore close handler 注入集成（Wave 3.3）', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.spyOn(console, 'debug').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('store 加载后 hasCloseWorkspaceHandler() === true（注入语义即时生效）', () => {
    // import useCrawlTabStore 触发 setCloseWorkspaceHandler 注入
    expect(useCrawlTabStore).toBeDefined()
    expect(hasCloseWorkspaceHandler()).toBe(true)
  })

  it('requestCloseWorkspace 路由到 store.closeCrawlspace', async () => {
    const closeCrawlspaceSpy = vi.spyOn(
      useCrawlTabStore.getState(),
      'closeCrawlspace',
    )

    const handled = requestCloseWorkspace({
      crawlspaceId: 'cs-test',
      reason: 'integration-test',
    })

    expect(handled).toBe(true)
    // handler 是 async，让 microtask 跑完
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(closeCrawlspaceSpy).toHaveBeenCalledWith(
      'cs-test',
      'integration-test',
      { reason: 'integration-test' },
    )
  })

  it('对未注册 cs 调用 close 是幂等 noop（store.closeCrawlspace 内部所有 set 不影响其他 cs）', async () => {
    const before = useCrawlTabStore.getState()
    const tabsBefore = before.tabs
    const cacheBefore = before.crawlspaceContextCache

    requestCloseWorkspace({
      crawlspaceId: 'cs-never-existed',
      reason: 'test-noop',
    })

    await new Promise(resolve => setTimeout(resolve, 0))

    const after = useCrawlTabStore.getState()
    expect(after.tabs).toEqual(tabsBefore)
    expect(after.crawlspaceContextCache).toEqual(cacheBefore)
  })

  it('reason 缺失时使用 fallback（"close-workspace-handler"）', async () => {
    const closeCrawlspaceSpy = vi.spyOn(
      useCrawlTabStore.getState(),
      'closeCrawlspace',
    )

    requestCloseWorkspace({ crawlspaceId: 'cs-no-reason' })

    await new Promise(resolve => setTimeout(resolve, 0))

    expect(closeCrawlspaceSpy).toHaveBeenCalledWith(
      'cs-no-reason',
      'close-workspace-handler',
      { reason: 'close-workspace-handler' },
    )
  })

  it('调用方可以临时覆盖 handler 做调试拦截（重复注入覆盖语义）', () => {
    const interceptor = vi.fn()
    setCloseWorkspaceHandler(interceptor)

    requestCloseWorkspace({ crawlspaceId: 'cs-debug', reason: 'inspect' })

    expect(interceptor).toHaveBeenCalledTimes(1)
    expect(interceptor).toHaveBeenCalledWith({
      crawlspaceId: 'cs-debug',
      reason: 'inspect',
    })

    // 还原 store 注入的 handler，避免污染后续测试
    setCloseWorkspaceHandler(async (request) => {
      const reason = request.reason || 'close-workspace-handler'
      await useCrawlTabStore.getState().closeCrawlspace(
        request.crawlspaceId,
        reason,
        { reason },
      )
    })
  })
})
