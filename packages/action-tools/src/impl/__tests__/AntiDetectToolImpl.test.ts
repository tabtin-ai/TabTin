import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockPoolNext, mockCheckerCheck, MockUAPool, MockProxyHealthChecker } = vi.hoisted(() => {
  const mockPoolNext = vi.fn(() => 'mock-ua')
  const mockCheckerCheck = vi.fn()
  const MockUAPool = vi.fn(function (this: any) {
    this.next = mockPoolNext
  })
  const MockProxyHealthChecker = vi.fn(function (this: any) {
    this.check = mockCheckerCheck
  })
  return { mockPoolNext, mockCheckerCheck, MockUAPool, MockProxyHealthChecker }
})

vi.mock('@tabtin/anti-detect', () => ({
  UAPool: MockUAPool,
  DESKTOP_UA_POOL: ['desktop-ua-1', 'desktop-ua-2'],
  MOBILE_UA_POOL: ['mobile-ua-1'],
  TABLET_UA_POOL: ['tablet-ua-1'],
  ProxyHealthChecker: MockProxyHealthChecker,
}))

vi.mock('../../i18n', () => ({
  t: (key: string) => key,
}))

import { AntiDetectToolImpl } from '../AntiDetectToolImpl'

describe('AntiDetectToolImpl', () => {
  let impl: AntiDetectToolImpl

  beforeEach(() => {
    vi.clearAllMocks()
    impl = new AntiDetectToolImpl()
  })

  // ── getRandomUA ───────────────────────────────────────────

  describe('getRandomUA', () => {
    it('默认（无 platform）应创建 UAPool 并返回 UA', () => {
      const result = impl.getRandomUA({})

      expect(result.success).toBe(true)
      expect(result.data?.userAgent).toBe('mock-ua')
      expect(MockUAPool).toHaveBeenCalledWith(undefined, undefined)
    })

    it('platform=desktop 应传入 DESKTOP_UA_POOL', () => {
      impl.getRandomUA({ platform: 'desktop' })

      expect(MockUAPool).toHaveBeenCalledWith(
        expect.arrayContaining(['desktop-ua-1', 'desktop-ua-2']),
        undefined,
      )
    })

    it('platform=mobile 应传入 MOBILE_UA_POOL', () => {
      impl.getRandomUA({ platform: 'mobile' })

      expect(MockUAPool).toHaveBeenCalledWith(
        expect.arrayContaining(['mobile-ua-1']),
        undefined,
      )
    })

    it('platform=tablet 应传入 TABLET_UA_POOL', () => {
      impl.getRandomUA({ platform: 'tablet' })

      expect(MockUAPool).toHaveBeenCalledWith(
        expect.arrayContaining(['tablet-ua-1']),
        undefined,
      )
    })

    it('自定义 userAgents 应优先使用', () => {
      impl.getRandomUA({ userAgents: ['custom-ua'] })

      expect(MockUAPool).toHaveBeenCalledWith(['custom-ua'], undefined)
    })

    it('rotation=sequential 应传递到 UAPool', () => {
      impl.getRandomUA({ rotation: 'sequential' })

      expect(MockUAPool).toHaveBeenCalledWith(undefined, 'sequential')
    })

    it('相同 key 应复用缓存的 pool', () => {
      impl.getRandomUA({ platform: 'desktop' })
      impl.getRandomUA({ platform: 'desktop' })

      expect(MockUAPool).toHaveBeenCalledTimes(1)
    })

    it('UAPool 抛异常应返回失败', () => {
      mockPoolNext.mockImplementationOnce(() => {
        throw new Error('pool error')
      })

      const result = impl.getRandomUA({})

      expect(result.success).toBe(false)
      expect(result.error).toBeDefined()
    })
  })

  // ── checkProxyHealth ──────────────────────────────────────

  describe('checkProxyHealth', () => {
    it('健康代理应返回 success + latencyMs', async () => {
      mockCheckerCheck.mockResolvedValue({ healthy: true, latencyMs: 42 })

      const result = await impl.checkProxyHealth({ proxy: { host: '1.2.3.4', port: 8080 } })

      expect(result.success).toBe(true)
      expect(result.data?.healthy).toBe(true)
      expect(result.data?.latencyMs).toBe(42)
    })

    it('不健康代理应返回 retriable 错误', async () => {
      mockCheckerCheck.mockResolvedValue({ healthy: false, error: 'TIMEOUT', latencyMs: 3000 })

      const result = await impl.checkProxyHealth({ proxy: { host: '1.2.3.4', port: 8080 } })

      expect(result.success).toBe(false)
      expect(result.error?.retriable).toBe(true)
    })

    it('checker 抛异常应返回 retriable 错误', async () => {
      mockCheckerCheck.mockRejectedValue(new Error('connection refused'))

      const result = await impl.checkProxyHealth({ proxy: { host: '1.2.3.4', port: 8080 } })

      expect(result.success).toBe(false)
      expect(result.error?.retriable).toBe(true)
    })

    it('自定义 timeoutMs 应传递到 checker', async () => {
      mockCheckerCheck.mockResolvedValue({ healthy: true, latencyMs: 10 })

      await impl.checkProxyHealth({ proxy: { host: '1.2.3.4', port: 8080 }, timeoutMs: 5000 })

      expect(mockCheckerCheck).toHaveBeenCalledWith(
        expect.objectContaining({ host: '1.2.3.4', port: 8080 }),
        5000,
      )
    })
  })
})
