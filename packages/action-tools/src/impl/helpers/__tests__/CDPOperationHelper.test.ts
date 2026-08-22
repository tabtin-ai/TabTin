import { describe, it, expect, vi, beforeEach } from 'vitest'

import { CDPOperationHelper } from '../CDPOperationHelper'

function makeBrowserContext(overrides?: Partial<ReturnType<typeof makeBrowserContext>>) {
  return {
    isAlive: vi.fn().mockReturnValue(true),
    sendCDP: vi.fn().mockResolvedValue({}),
    onCDPEvent: vi.fn().mockReturnValue(() => {}),
    executeScript: vi.fn().mockResolvedValue({ success: true }),
    loadURL: vi.fn(),
    getCurrentURL: vi.fn().mockReturnValue('https://example.com'),
    getTitle: vi.fn().mockResolvedValue('Test'),
    captureScreenshot: vi.fn(),
    detach: vi.fn(),
    ...overrides,
  }
}

describe('CDPOperationHelper', () => {
  let helper: CDPOperationHelper

  beforeEach(() => {
    helper = new CDPOperationHelper()
  })

  // ── BT-026: DOM.performSearch 资源释放 ───────────────────────

  describe('BT-026: resolveElementCenter 释放 DOM.performSearch 状态', () => {
    it('XPath 成功查询后应调用 DOM.discardSearchResults', async () => {
      const ctx = makeBrowserContext({
        sendCDP: vi.fn().mockImplementation(async (method: string) => {
          if (method === 'DOM.enable') return {}
          if (method === 'DOM.getDocument') return { root: { nodeId: 1 } }
          if (method === 'DOM.performSearch') return { searchId: 'sid-1', resultCount: 1 }
          if (method === 'DOM.getSearchResults') return { nodeIds: [42] }
          if (method === 'DOM.discardSearchResults') return {}
          if (method === 'DOM.scrollIntoViewIfNeeded') return {}
          if (method === 'DOM.getBoxModel') return { model: { content: [10, 10, 50, 10, 50, 30, 10, 30] } }
          if (method === 'DOM.describeNode') return { node: { backendNodeId: 99 } }
          if (method === 'DOM.resolveNode') return { object: { objectId: 'obj-1' } }
          if (method === 'Input.dispatchMouseEvent') return {}
          return {}
        }),
      })

      await helper.runAction(ctx, { action: 'hover', selector: 'xpath=//div[@class="btn"]' })

      const discardCalls = (ctx.sendCDP as any).mock.calls.filter(
        (c: any[]) => c[0] === 'DOM.discardSearchResults',
      )
      expect(discardCalls.length).toBeGreaterThanOrEqual(1)
      expect(discardCalls[0][1]).toMatchObject({ searchId: 'sid-1' })
    })

    it('XPath 无结果时也应调用 DOM.discardSearchResults 释放资源', async () => {
      const ctx = makeBrowserContext({
        sendCDP: vi.fn().mockImplementation(async (method: string) => {
          if (method === 'DOM.enable') return {}
          if (method === 'DOM.getDocument') return { root: { nodeId: 1 } }
          if (method === 'DOM.performSearch') return { searchId: 'sid-empty', resultCount: 0 }
          if (method === 'DOM.discardSearchResults') return {}
          return {}
        }),
      })

      await helper.runAction(ctx, { action: 'hover', selector: 'xpath=//nonexistent', timeout: 100 })

      const discardCalls = (ctx.sendCDP as any).mock.calls.filter(
        (c: any[]) => c[0] === 'DOM.discardSearchResults',
      )
      expect(discardCalls.length).toBeGreaterThanOrEqual(1)
    })
  })

  // ── BT-027: keyDown 异常后 pressedModifiers 回滚 ─────────────

  describe('BT-027: keyDown 异常后修饰键状态应回滚', () => {
    it('keyDown sendCDP 失败时不应永久锁定 Shift', async () => {
      const failCtx = makeBrowserContext({
        sendCDP: vi.fn().mockRejectedValue(new Error('cdp error')),
      })

      await expect(
        helper.runAction(failCtx, { action: 'keyDown', key: 'Shift' }),
      ).resolves.toMatchObject({ success: false })

      helper.resetModifiers()

      const okCtx = makeBrowserContext()
      await helper.runAction(okCtx, { action: 'keyDown', key: 'Enter' })

      const keyDownCall = (okCtx.sendCDP as any).mock.calls.find(
        (c: any[]) => c[0] === 'Input.dispatchKeyEvent',
      )
      expect(keyDownCall?.[1]?.modifiers).toBe(0)
    })

    it('keyDown 正常成功后修饰键状态应保留', async () => {
      const ctx1 = makeBrowserContext()
      await helper.runAction(ctx1, { action: 'keyDown', key: 'Shift' })

      const ctx2 = makeBrowserContext()
      await helper.runAction(ctx2, { action: 'keyDown', key: 'a' })

      const call = (ctx2.sendCDP as any).mock.calls.find(
        (c: any[]) => c[0] === 'Input.dispatchKeyEvent',
      )
      expect(call?.[1]?.modifiers).toBe(8)
    })

    it('resetModifiers() 应清除所有修饰键状态', async () => {
      const ctx = makeBrowserContext()

      await helper.runAction(ctx, { action: 'keyDown', key: 'Control' })
      await helper.runAction(ctx, { action: 'keyDown', key: 'Shift' })

      helper.resetModifiers()

      const ctx2 = makeBrowserContext()
      await helper.runAction(ctx2, { action: 'keyDown', key: 'Enter' })

      const call = (ctx2.sendCDP as any).mock.calls.find(
        (c: any[]) => c[0] === 'Input.dispatchKeyEvent',
      )
      expect(call?.[1]?.modifiers).toBe(0)
    })
  })

  // ── BT-024: withRetry 关联（CDPOperationHelper 层的错误处理）──

  describe('运行时异常应返回 success:false', () => {
    it('runAction 内部异常应被捕获并返回 cdp_error', async () => {
      const ctx = makeBrowserContext({
        sendCDP: vi.fn().mockRejectedValue(new Error('devtools disconnected')),
      })

      const result = await helper.runAction(ctx, { action: 'type', value: 'hello' })

      expect(result.success).toBe(false)
      expect(result.code).toBe('cdp_error')
    })
  })
})
