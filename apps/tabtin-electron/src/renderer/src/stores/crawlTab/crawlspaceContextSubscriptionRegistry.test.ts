import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// 在 import registry 之前 mock client，确保 module-level 的 import 拿到 mock 版本。
const mockSubscribe = vi.fn()
vi.mock('../../crawlspace/electron/crawlspace-context-client', () => ({
  crawlspaceContextClient: {
    subscribe: (...args: unknown[]) => mockSubscribe(...args),
  },
}))

import {
  configureCrawlspaceContextSubscription,
  ensureCrawlspaceContextSubscription,
  releaseCrawlspaceContextSubscription,
  releaseAllCrawlspaceContextSubscriptions,
  hasCrawlspaceContextSubscription,
  resetCrawlspaceContextSubscriptionRegistry,
} from './crawlspaceContextSubscriptionRegistry'

type Listener = (snapshot: any) => void

describe('crawlspaceContextSubscriptionRegistry', () => {
  let mockApplier: ReturnType<typeof vi.fn>
  let lastListener: Listener | null = null
  let lastUnsubscribe: ReturnType<typeof vi.fn> = vi.fn()

  beforeEach(() => {
    resetCrawlspaceContextSubscriptionRegistry()
    mockApplier = vi.fn()
    configureCrawlspaceContextSubscription(mockApplier)

    lastListener = null
    lastUnsubscribe = vi.fn()
    mockSubscribe.mockImplementation((_csId: string, listener: Listener) => {
      lastListener = listener
      return lastUnsubscribe
    })
  })

  afterEach(() => {
    resetCrawlspaceContextSubscriptionRegistry()
    mockSubscribe.mockReset()
  })

  it('ensureCrawlspaceContextSubscription 幂等：同 csId 多次调用只订阅一次', () => {
    ensureCrawlspaceContextSubscription('cs-1')
    ensureCrawlspaceContextSubscription('cs-1')
    ensureCrawlspaceContextSubscription('cs-1')

    expect(mockSubscribe).toHaveBeenCalledTimes(1)
    expect(hasCrawlspaceContextSubscription('cs-1')).toBe(true)
  })

  it('listener 收到 snapshot 时应转发到 applier', () => {
    ensureCrawlspaceContextSubscription('cs-1')
    expect(lastListener).toBeTruthy()

    lastListener!({
      crawlspaceId: 'cs-1',
      activeViewId: 'view-1',
      viewCount: 1,
      views: [{ viewId: 'view-1', isActive: true, updatedAt: 100 }],
      updatedAt: 100,
    })

    expect(mockApplier).toHaveBeenCalledTimes(1)
    expect(mockApplier).toHaveBeenCalledWith('cs-1', expect.objectContaining({
      crawlspaceId: 'cs-1',
    }))
  })

  it('release 之后 in-flight promise 触发 listener 也不应 invoke applier (race 防御)', () => {
    // 模拟 race：subscribe 注册 listener，调用方释放订阅后，client 内部
    // 异步 getContext promise resolve 仍持有 listener 闭包引用，调用 listener。
    ensureCrawlspaceContextSubscription('cs-1')
    const heldListener = lastListener!

    releaseCrawlspaceContextSubscription('cs-1')

    // unsubscribe 应被调
    expect(lastUnsubscribe).toHaveBeenCalledTimes(1)

    // 模拟迟到的 in-flight snapshot 到达
    heldListener({
      crawlspaceId: 'cs-1',
      activeViewId: 'view-late',
      viewCount: 0,
      views: [],
      updatedAt: 100,
    })

    expect(mockApplier).not.toHaveBeenCalled()
  })

  it('迟到 snapshot 守护：updatedAt < latest 时应丢弃', () => {
    ensureCrawlspaceContextSubscription('cs-1')
    const listener = lastListener!

    listener({
      crawlspaceId: 'cs-1',
      activeViewId: 'view-1',
      viewCount: 1,
      views: [],
      updatedAt: 200,
    })
    listener({
      // 迟到的旧 snapshot
      crawlspaceId: 'cs-1',
      activeViewId: 'view-1',
      viewCount: 1,
      views: [],
      updatedAt: 100,
    })
    listener({
      // 较新的 snapshot
      crawlspaceId: 'cs-1',
      activeViewId: 'view-1',
      viewCount: 1,
      views: [],
      updatedAt: 250,
    })

    expect(mockApplier).toHaveBeenCalledTimes(2)
    expect(mockApplier).toHaveBeenNthCalledWith(1, 'cs-1', expect.objectContaining({ updatedAt: 200 }))
    expect(mockApplier).toHaveBeenNthCalledWith(2, 'cs-1', expect.objectContaining({ updatedAt: 250 }))
  })

  it('crawlspaceId 不匹配时应丢弃 snapshot', () => {
    ensureCrawlspaceContextSubscription('cs-1')
    const listener = lastListener!

    listener({
      crawlspaceId: 'cs-2',
      activeViewId: null,
      viewCount: 0,
      views: [],
      updatedAt: 100,
    })

    expect(mockApplier).not.toHaveBeenCalled()
  })

  it('applier 未注入时应丢弃 snapshot 且 console.warn', () => {
    resetCrawlspaceContextSubscriptionRegistry()
    // 不注入 applier
    ensureCrawlspaceContextSubscription('cs-1')
    const listener = lastListener!

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    listener({
      crawlspaceId: 'cs-1',
      activeViewId: null,
      viewCount: 0,
      views: [],
      updatedAt: 100,
    })

    // createLogger 会把 [模块前缀] 作为首个参数，且跨测试可能有其它 warn 混入，
    // 按消息内容过滤更鲁棒（仍精确验证"applier 未注入"这一条 warn 发生一次）。
    const applierWarns = warnSpy.mock.calls.filter((c) =>
      c.some((a) => String(a).includes('applier not configured')),
    )
    expect(applierWarns).toHaveLength(1)
    warnSpy.mockRestore()
  })

  it('releaseAllCrawlspaceContextSubscriptions 释放所有但保留 applier', () => {
    ensureCrawlspaceContextSubscription('cs-1')
    const heldListener1 = lastListener!
    const unsub1 = lastUnsubscribe

    mockSubscribe.mockImplementation((_csId: string, listener: Listener) => {
      lastListener = listener
      lastUnsubscribe = vi.fn()
      return lastUnsubscribe
    })

    ensureCrawlspaceContextSubscription('cs-2')
    const unsub2 = lastUnsubscribe

    releaseAllCrawlspaceContextSubscriptions()

    expect(unsub1).toHaveBeenCalledTimes(1)
    expect(unsub2).toHaveBeenCalledTimes(1)
    expect(hasCrawlspaceContextSubscription('cs-1')).toBe(false)
    expect(hasCrawlspaceContextSubscription('cs-2')).toBe(false)

    // applier 仍在——下次 ensure 还能正常工作
    ensureCrawlspaceContextSubscription('cs-3')
    lastListener!({
      crawlspaceId: 'cs-3',
      activeViewId: null,
      viewCount: 0,
      views: [],
      updatedAt: 100,
    })

    expect(mockApplier).toHaveBeenCalledTimes(1)

    // release 后 in-flight 不能复活
    heldListener1({
      crawlspaceId: 'cs-1',
      activeViewId: null,
      viewCount: 0,
      views: [],
      updatedAt: 200,
    })
    // applier 调用次数不变
    expect(mockApplier).toHaveBeenCalledTimes(1)
  })

  it('ensure → release → ensure 同 csId 快循环：旧 in-flight 不能复活到新 entry', () => {
    // 旧 entry 的 listener 闭包持有旧 active flag，新 entry 是独立闭包；
    // 旧 listener 收到迟到 snapshot 仅查旧 entry.active=false → 丢弃，
    // 不影响新 entry。
    ensureCrawlspaceContextSubscription('cs-1')
    const oldListener = lastListener!
    const oldUnsub = lastUnsubscribe

    releaseCrawlspaceContextSubscription('cs-1')
    expect(oldUnsub).toHaveBeenCalledTimes(1)

    mockSubscribe.mockImplementation((_csId: string, listener: Listener) => {
      lastListener = listener
      lastUnsubscribe = vi.fn()
      return lastUnsubscribe
    })

    ensureCrawlspaceContextSubscription('cs-1')
    const newListener = lastListener!
    expect(newListener).not.toBe(oldListener)

    // 旧 listener 接到迟到 snapshot——应被旧 entry.active 拦截
    oldListener({
      crawlspaceId: 'cs-1',
      activeViewId: 'view-stale',
      viewCount: 0,
      views: [],
      updatedAt: 999,
    })
    expect(mockApplier).not.toHaveBeenCalled()

    // 新 listener 正常工作，从 latestUpdatedAt=0 起算
    newListener({
      crawlspaceId: 'cs-1',
      activeViewId: 'view-fresh',
      viewCount: 0,
      views: [],
      updatedAt: 50,
    })
    expect(mockApplier).toHaveBeenCalledTimes(1)
    expect(mockApplier).toHaveBeenCalledWith('cs-1', expect.objectContaining({ updatedAt: 50 }))
  })

  it('多 csId 并发隔离：release 单个不影响其他订阅', () => {
    ensureCrawlspaceContextSubscription('cs-1')
    const listener1 = lastListener!

    mockSubscribe.mockImplementation((_csId: string, listener: Listener) => {
      lastListener = listener
      lastUnsubscribe = vi.fn()
      return lastUnsubscribe
    })

    ensureCrawlspaceContextSubscription('cs-2')
    const listener2 = lastListener!

    releaseCrawlspaceContextSubscription('cs-1')
    expect(hasCrawlspaceContextSubscription('cs-1')).toBe(false)
    expect(hasCrawlspaceContextSubscription('cs-2')).toBe(true)

    // cs-1 listener 已被标 active=false
    listener1({
      crawlspaceId: 'cs-1',
      activeViewId: null,
      viewCount: 0,
      views: [],
      updatedAt: 100,
    })
    expect(mockApplier).not.toHaveBeenCalled()

    // cs-2 仍正常
    listener2({
      crawlspaceId: 'cs-2',
      activeViewId: 'view-cs2',
      viewCount: 0,
      views: [],
      updatedAt: 100,
    })
    expect(mockApplier).toHaveBeenCalledTimes(1)
    expect(mockApplier).toHaveBeenCalledWith('cs-2', expect.objectContaining({ crawlspaceId: 'cs-2' }))
  })

  it('applier 抛异常时不破坏后续 dispatch（错误隔离）', () => {
    // applier 异常如果冒到 client.dispatchSnapshot.forEach，会破坏同 IPC
    // 推送下其他 listener 的 dispatch。registry 用 try/catch 隔离单帧错误。
    let throwOnce = true
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockApplier.mockImplementation(() => {
      if (throwOnce) {
        throwOnce = false
        throw new Error('applier-boom')
      }
    })

    ensureCrawlspaceContextSubscription('cs-1')
    const listener = lastListener!

    // 第一次：applier 抛错——registry 应吞错，console.error 一次
    listener({
      crawlspaceId: 'cs-1',
      activeViewId: 'view-1',
      viewCount: 1,
      views: [],
      updatedAt: 100,
    })
    expect(mockApplier).toHaveBeenCalledTimes(1)
    expect(errorSpy).toHaveBeenCalledTimes(1)

    // 第二次：applier 不再抛——正常 invoke
    listener({
      crawlspaceId: 'cs-1',
      activeViewId: 'view-2',
      viewCount: 1,
      views: [],
      updatedAt: 200,
    })
    expect(mockApplier).toHaveBeenCalledTimes(2)
    expect(errorSpy).toHaveBeenCalledTimes(1)

    errorSpy.mockRestore()
  })

  it('configureCrawlspaceContextSubscription 重复调用覆盖旧 applier', () => {
    const newApplier = vi.fn()
    configureCrawlspaceContextSubscription(newApplier)

    ensureCrawlspaceContextSubscription('cs-1')
    lastListener!({
      crawlspaceId: 'cs-1',
      activeViewId: null,
      viewCount: 0,
      views: [],
      updatedAt: 100,
    })

    expect(mockApplier).not.toHaveBeenCalled()
    expect(newApplier).toHaveBeenCalledTimes(1)
  })

  it('相同 updatedAt 重复 dispatch 时丢弃（不依赖 client 去重）', () => {
    // 对应 B2 修复：registry 自身保证去重，不依赖 client.dispatchSnapshot 的 ===。
    // 第一帧 latestUpdatedAt=0 放行；之后相同 updatedAt 被拒。
    ensureCrawlspaceContextSubscription('cs-1')
    const listener = lastListener!

    listener({
      crawlspaceId: 'cs-1',
      activeViewId: 'view-1',
      viewCount: 1,
      views: [],
      updatedAt: 100,
    })
    listener({
      crawlspaceId: 'cs-1',
      activeViewId: 'view-1',
      viewCount: 1,
      views: [],
      updatedAt: 100, // 同 updatedAt —— 应被丢弃
    })

    expect(mockApplier).toHaveBeenCalledTimes(1)
  })

  it('IPC 不可用时（client.subscribe 返 null）不写入 subscriptions Map，留给下次 ensure 重试', () => {
    // 对应"伪订阅"修复：client 在 !ipc 时显式返回 null，registry 据此不记录。
    // 否则 has() 短路会让 IPC 恢复后的 ensure 永远不执行实际订阅。
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // 第一次：模拟 IPC 不可用——client 返 null
    mockSubscribe.mockImplementationOnce(() => null)
    ensureCrawlspaceContextSubscription('cs-1')

    expect(hasCrawlspaceContextSubscription('cs-1')).toBe(false)
    const failWarns = warnSpy.mock.calls.filter((c) =>
      c.some((a) => String(a).includes('subscribe failed (IPC unavailable)')),
    )
    expect(failWarns).toHaveLength(1)
    expect(mockSubscribe).toHaveBeenCalledTimes(1)

    // 第二次：IPC 恢复——client 返正常 unsubscribe
    mockSubscribe.mockImplementation((_csId: string, listener: Listener) => {
      lastListener = listener
      lastUnsubscribe = vi.fn()
      return lastUnsubscribe
    })
    ensureCrawlspaceContextSubscription('cs-1')

    expect(hasCrawlspaceContextSubscription('cs-1')).toBe(true)
    expect(mockSubscribe).toHaveBeenCalledTimes(2)

    // 现在 listener 应该正常工作
    lastListener!({
      crawlspaceId: 'cs-1',
      activeViewId: 'view-1',
      viewCount: 0,
      views: [],
      updatedAt: 100,
    })
    expect(mockApplier).toHaveBeenCalledTimes(1)

    warnSpy.mockRestore()
  })

  it('IPC 反复不可用时同 csId 仅 warn 一次，后续降级 debug（噪音 throttle）', () => {
    // CrawlspaceWorkspace 重 mount + zustand subscribe diff 期间 ensure 反复
    // 触发——若每次都 warn，dev/test 日志被淹没。throttle 后第一次 warn，后续
    // 同 csId 改 debug。entry 写入 Map 后清掉记录，下次失败重新 warn 一次。
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})

    // 同 csId 连续 3 次 IPC 不可用
    mockSubscribe.mockImplementation(() => null)
    ensureCrawlspaceContextSubscription('cs-1')
    ensureCrawlspaceContextSubscription('cs-1')
    ensureCrawlspaceContextSubscription('cs-1')

    const failWarns = warnSpy.mock.calls.filter((c) =>
      c.some((a) => String(a).includes('subscribe failed (IPC unavailable)')),
    )
    const stillFailingDebugs = debugSpy.mock.calls.filter((c) =>
      c.some((a) => String(a).includes('subscribe still failing')),
    )
    expect(failWarns).toHaveLength(1)
    expect(stillFailingDebugs).toHaveLength(2)

    // IPC 恢复——成功路径会清掉 warn 记录
    mockSubscribe.mockImplementation((_csId: string, listener: Listener) => {
      lastListener = listener
      lastUnsubscribe = vi.fn()
      return lastUnsubscribe
    })
    ensureCrawlspaceContextSubscription('cs-1')
    expect(hasCrawlspaceContextSubscription('cs-1')).toBe(true)

    // 释放后再失败——应重新 warn 一次（不再受之前的 throttle 影响）
    releaseCrawlspaceContextSubscription('cs-1')
    mockSubscribe.mockImplementation(() => null)
    ensureCrawlspaceContextSubscription('cs-1')

    expect(warnSpy).toHaveBeenCalledTimes(2)

    // 不同 csId 第一次失败——独立 warn
    ensureCrawlspaceContextSubscription('cs-2')
    expect(warnSpy).toHaveBeenCalledTimes(3)

    warnSpy.mockRestore()
    debugSpy.mockRestore()
  })
})
