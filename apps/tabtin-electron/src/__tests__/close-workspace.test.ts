/**
 * close-workspace 模块测试（Wave 3.3）
 *
 * 验证从"effect 内多 listener"改为"module-level single handler"后的语义：
 *
 * - handler 注入语义（set / clear / 重复注入覆盖）
 * - requestCloseWorkspace 路由（按 crawlspaceId 路由到 handler）
 * - 各 cs 状态下的行为：hot/hidden/cold/已 unmount/已 closed
 * - handler 同步抛错 / Promise 拒绝时不冒泡
 * - handler 未注入时返回 false（调用方负责 fallback）
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  setCloseWorkspaceHandler,
  requestCloseWorkspace,
  hasCloseWorkspaceHandler,
} from '@tabtin/crawlspace-core'

describe('close-workspace event bus (Wave 3.3)', () => {
  beforeEach(() => {
    setCloseWorkspaceHandler(null)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    setCloseWorkspaceHandler(null)
    vi.restoreAllMocks()
  })

  describe('handler 注入语义', () => {
    it('未注入时 hasCloseWorkspaceHandler() 返回 false', () => {
      expect(hasCloseWorkspaceHandler()).toBe(false)
    })

    it('注入后 hasCloseWorkspaceHandler() 返回 true', () => {
      setCloseWorkspaceHandler(() => {})
      expect(hasCloseWorkspaceHandler()).toBe(true)
    })

    it('传 null 显式清除', () => {
      setCloseWorkspaceHandler(() => {})
      expect(hasCloseWorkspaceHandler()).toBe(true)
      setCloseWorkspaceHandler(null)
      expect(hasCloseWorkspaceHandler()).toBe(false)
    })

    it('重复注入覆盖旧 handler（HMR / 测试 reset）', () => {
      const oldHandler = vi.fn()
      const newHandler = vi.fn()

      setCloseWorkspaceHandler(oldHandler)
      setCloseWorkspaceHandler(newHandler)

      requestCloseWorkspace({ crawlspaceId: 'cs-1' })

      expect(oldHandler).not.toHaveBeenCalled()
      expect(newHandler).toHaveBeenCalledTimes(1)
    })
  })

  describe('requestCloseWorkspace 派发语义', () => {
    it('handler 未注入时返回 false（调用方负责 fallback）', () => {
      const handled = requestCloseWorkspace({ crawlspaceId: 'cs-1', reason: 'test' })
      expect(handled).toBe(false)
    })

    it('crawlspaceId 缺失时返回 false', () => {
      const handler = vi.fn()
      setCloseWorkspaceHandler(handler)

      // @ts-expect-error 故意传空校验防御
      expect(requestCloseWorkspace({})).toBe(false)
      // @ts-expect-error
      expect(requestCloseWorkspace({ crawlspaceId: '' })).toBe(false)
      // @ts-expect-error
      expect(requestCloseWorkspace(null)).toBe(false)

      expect(handler).not.toHaveBeenCalled()
    })

    it('handler 注入后返回 true 且 handler 收到完整 request', () => {
      const handler = vi.fn()
      setCloseWorkspaceHandler(handler)

      const handled = requestCloseWorkspace({
        crawlspaceId: 'cs-1',
        reason: 'user-close-tab',
      })

      expect(handled).toBe(true)
      expect(handler).toHaveBeenCalledTimes(1)
      expect(handler).toHaveBeenCalledWith({
        crawlspaceId: 'cs-1',
        reason: 'user-close-tab',
      })
    })

    it('handler 同步抛错时仍返回 true（不拖垮事件总线）', () => {
      const handler = vi.fn(() => {
        throw new Error('boom')
      })
      setCloseWorkspaceHandler(handler)

      const handled = requestCloseWorkspace({ crawlspaceId: 'cs-1' })

      expect(handled).toBe(true)
      expect(handler).toHaveBeenCalledTimes(1)
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('handler 同步抛错'),
        expect.objectContaining({ crawlspaceId: 'cs-1' }),
      )
    })

    it('handler async 拒绝时不冒泡（仅 warn）', async () => {
      const handler = vi.fn(() => Promise.reject(new Error('async-boom')))
      setCloseWorkspaceHandler(handler)

      const handled = requestCloseWorkspace({ crawlspaceId: 'cs-1' })

      expect(handled).toBe(true)
      // 等待 microtask 队列让 catch 跑
      await new Promise(resolve => setTimeout(resolve, 0))

      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('handler 异步异常'),
        expect.objectContaining({ crawlspaceId: 'cs-1' }),
      )
    })
  })

  describe('多 cs 路由', () => {
    it('handler 按 request.crawlspaceId 路由（同 handler 处理多 cs）', () => {
      const calls: Array<{ crawlspaceId: string; reason?: string }> = []
      setCloseWorkspaceHandler(request => {
        calls.push(request)
      })

      requestCloseWorkspace({ crawlspaceId: 'cs-A', reason: 'user' })
      requestCloseWorkspace({ crawlspaceId: 'cs-B', reason: 'menu' })
      requestCloseWorkspace({ crawlspaceId: 'cs-A', reason: 'duplicate' })

      expect(calls).toEqual([
        { crawlspaceId: 'cs-A', reason: 'user' },
        { crawlspaceId: 'cs-B', reason: 'menu' },
        { crawlspaceId: 'cs-A', reason: 'duplicate' },
      ])
    })
  })

  describe('Wave 2c 关键场景：hidden / cold / unmounted', () => {
    /**
     * 场景 A：close 请求发送给 hot 但 hidden 的 Space。
     *
     * 改造前：listener 在 Shell effect 内，`<Activity hidden>` 触发 cleanup
     * → listener 退订 → 请求丢失。改造后：handler 由 store 持有，hidden 期间
     * 仍可响应——handler 调到 store.closeCrawlspace 完成清理。
     */
    it('Wave 2c hidden 场景：handler 不依赖 React 组件生命周期，hidden 期间仍响应', () => {
      const closeStore = vi.fn()
      setCloseWorkspaceHandler(({ crawlspaceId, reason }) => {
        closeStore(crawlspaceId, reason)
      })

      // 模拟 Wave 2c：Shell unmount（effect cleanup 全跑）但 store handler 仍在
      // 此时收到 close 请求
      const handled = requestCloseWorkspace({
        crawlspaceId: 'cs-hidden',
        reason: 'cross-space-close',
      })

      expect(handled).toBe(true)
      expect(closeStore).toHaveBeenCalledWith('cs-hidden', 'cross-space-close')
    })

    /**
     * 场景 B：close 请求发送给已 cold 的 Space（hot 集合驱逐已发生）。
     *
     * Wave 3.1 已经处理了 cold 时释放 context 订阅；Wave 3.2 处理了 cold 时
     * endRun。Wave 3.3 的 handler 仍能收到 close 请求——store.closeCrawlspace
     * 对已 cold 的 cs 是幂等的（cache 已清、tabs 已清）。
     */
    it('Wave 2c cold 场景：handler 对已 cold 的 cs 仍能调度（store 自己保证幂等）', () => {
      const callRecord: Array<string> = []
      setCloseWorkspaceHandler(({ crawlspaceId }) => {
        callRecord.push(crawlspaceId)
      })

      requestCloseWorkspace({ crawlspaceId: 'cs-cold', reason: 'cleanup-cold' })

      // handler 不知道 cs 是 hot/cold，单纯路由——具体清理由 store 决定
      expect(callRecord).toEqual(['cs-cold'])
    })

    /**
     * 场景 C：app 退出时——handler 不需要显式清理（生命周期跟 store 一致，
     * store 单例随应用销毁）。但暴露 setCloseWorkspaceHandler(null) 用于测试
     * reset / 显式 shutdown。
     */
    it('Wave 2c shutdown 场景：setCloseWorkspaceHandler(null) 可用于显式清理', () => {
      const handler = vi.fn()
      setCloseWorkspaceHandler(handler)

      // 模拟 shutdown
      setCloseWorkspaceHandler(null)

      const handled = requestCloseWorkspace({ crawlspaceId: 'cs-1' })

      expect(handled).toBe(false)
      expect(handler).not.toHaveBeenCalled()
    })
  })

  describe('回归：API 变更（Wave 3.3 北极星）', () => {
    it('subscribeCloseWorkspace 已删除（不再支持多 listener Set）', async () => {
      const module = await import('@tabtin/crawlspace-core')
      // @ts-expect-error: subscribeCloseWorkspace 已被 setCloseWorkspaceHandler 取代
      expect(module.subscribeCloseWorkspace).toBeUndefined()
    })

    it('暴露的 API 与文档一致', async () => {
      const module = await import('@tabtin/crawlspace-core')
      expect(typeof module.requestCloseWorkspace).toBe('function')
      expect(typeof module.setCloseWorkspaceHandler).toBe('function')
      expect(typeof module.hasCloseWorkspaceHandler).toBe('function')
    })
  })
})
