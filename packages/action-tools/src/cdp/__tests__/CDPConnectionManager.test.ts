import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { CDPConnectionManager, destroyCDPConnectionManager } from '../CDPConnectionManager'

function makeWebContents(id: number, url = 'https://example.com') {
  let attached = false
  return {
    id,
    getURL: () => url,
    isDestroyed: () => false,
    once: vi.fn(),
    debugger: {
      isAttached: () => attached,
      attach: vi.fn(async () => { attached = true }),
      detach: vi.fn(async () => { attached = false }),
      sendCommand: vi.fn(async () => ({})),
    },
  }
}

describe('CDPConnectionManager', () => {
  let manager: CDPConnectionManager

  beforeEach(() => {
    manager = new CDPConnectionManager({ enableAutoCleanup: false })
  })

  afterEach(() => {
    manager.destroy()
    destroyCDPConnectionManager()
  })

  // ── BT-020: detach() 调用 debugger.detach() ─────────────────

  describe('BT-020: detach() 应调用 debugger.detach()', () => {
    it('正常 detach 时应调用 webContents.debugger.detach()', async () => {
      const wc = makeWebContents(1)
      await manager.getOrAttach(wc)

      manager.detach(1, 'test')

      expect(wc.debugger.detach).toHaveBeenCalled()
    })

    it('detach 后连接状态应被清除', async () => {
      const wc = makeWebContents(2)
      await manager.getOrAttach(wc)
      expect(manager.isConnected(2)).toBe(true)

      manager.detach(2, 'test')

      expect(manager.isConnected(2)).toBe(false)
    })

    it('WebContents 已销毁时 detach 不应抛错', async () => {
      const wc = makeWebContents(3)
      await manager.getOrAttach(wc)
      // 模拟已销毁
      ;(wc as any).isDestroyed = () => true

      expect(() => manager.detach(3, 'destroyed')).not.toThrow()
    })

    it('debugger.detach() 抛错时整体 detach 不应失败', async () => {
      const wc = makeWebContents(4)
      await manager.getOrAttach(wc)
      wc.debugger.detach.mockRejectedValue(new Error('already detached'))

      expect(() => manager.detach(4, 'error_case')).not.toThrow()
      expect(manager.isConnected(4)).toBe(false)
    })
  })

  // ── BT-021: getOrAttach() 并发锁 ─────────────────────────────

  describe('BT-021: getOrAttach() 并发安全', () => {
    it('同一 wcId 并发调用只应 attach 一次', async () => {
      const wc = makeWebContents(10)

      // 使用可手动控制的 Promise 模拟慢速 attach
      let resolveAttach!: () => void
      const attachInFlight = new Promise<void>(r => { resolveAttach = r })
      let attachCalls = 0
      let attached = false

      wc.debugger.isAttached = () => attached
      wc.debugger.attach = vi.fn(() => {
        attachCalls++
        return attachInFlight.then(() => { attached = true })
      })

      // 并发发起 3 个 getOrAttach，全部挂起等待 attachInFlight
      const p1 = manager.getOrAttach(wc)
      const p2 = manager.getOrAttach(wc)
      const p3 = manager.getOrAttach(wc)

      // 解锁 attach
      resolveAttach()
      await Promise.all([p1, p2, p3])

      // 只应 attach 一次
      expect(attachCalls).toBe(1)
    })

    it('attach 失败时不应有半初始化状态残留', async () => {
      const wc = makeWebContents(11)
      wc.debugger.attach.mockRejectedValue(new Error('attach failed'))

      await expect(manager.getOrAttach(wc)).rejects.toThrow('attach failed')
      expect(manager.isConnected(11)).toBe(false)
    })
  })

  // ── BT-022: 心跳重连后恢复 enabledDomains ────────────────────

  describe('BT-022: 心跳重连后应恢复 enabledDomains', () => {
    it('重连后已注册的 Domain 应被重新 enable', async () => {
      const wc = makeWebContents(20)
      let isAttached = true
      wc.debugger.isAttached = () => isAttached
      wc.debugger.attach = vi.fn(async () => { isAttached = true })

      await manager.getOrAttach(wc)
      await manager.enableDomain(wc, 'DOM')
      await manager.enableDomain(wc, 'Network')

      const state = manager.getConnectionState(20)
      expect(state?.enabledDomains.has('DOM')).toBe(true)
      expect(state?.enabledDomains.has('Network')).toBe(true)

      // 模拟断连
      isAttached = false

      // 手动触发单个心跳
      await (manager as any).heartbeatSingle(20, state)

      // 重连后 enabledDomains 应被恢复
      const restoredState = manager.getConnectionState(20)
      expect(restoredState?.enabledDomains.has('DOM')).toBe(true)
      expect(restoredState?.enabledDomains.has('Network')).toBe(true)

      // sendCommand 应被调用了 DOM.enable 和 Network.enable
      const calls = wc.debugger.sendCommand.mock.calls.map((c: any[]) => c[0])
      expect(calls).toContain('DOM.enable')
      expect(calls).toContain('Network.enable')
    })
  })

  // ── BT-023: 连接池上限 ───────────────────────────────────────

  describe('BT-023: 连接池上限', () => {
    it('超过 20 个连接时应驱逐 LRU keep-alive 连接', async () => {
      const allWc: ReturnType<typeof makeWebContents>[] = []

      for (let i = 0; i < 20; i++) {
        const wc = makeWebContents(100 + i)
        allWc.push(wc)
        await manager.getOrAttach(wc, { strategy: 'keep-alive' })
        // 更新时间，确保第一个连接最旧
        if (i > 0) {
          const s = manager.getConnectionState(100 + i)
          if (s) s.lastUsedTime = Date.now() + i * 1000
        }
      }

      expect(manager.getStats().totalConnections).toBe(20)

      // 第 21 个连接
      const newWc = makeWebContents(200)
      await manager.getOrAttach(newWc, { strategy: 'keep-alive' })

      // 连接总数不超过 20（驱逐了一个）
      expect(manager.getStats().totalConnections).toBe(20)
      expect(manager.isConnected(200)).toBe(true)
    })
  })
})
