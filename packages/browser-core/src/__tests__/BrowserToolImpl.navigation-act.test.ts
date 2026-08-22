import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserToolImpl } from '../BrowserToolImpl'

const BOX = {
  model: {
    content: [0, 0, 20, 0, 20, 10, 0, 10],
    border: [0, 0, 20, 0, 20, 10, 0, 10],
  },
}

afterEach(() => {
  vi.useRealTimers()
})

describe('BrowserToolImpl 提交导航 act', () => {
  it('提交后页面脚本永不 settle 时仍在宿主上限内返回成功结果', async () => {
    vi.useFakeTimers()
    let navigationStarted = false
    const ctx = {
      isAlive: () => true,
      getCurrentURL: () => navigationStarted ? 'https://example.test/post' : 'https://example.test/form',
      getTitle: vi.fn(async () => ''),
      captureScreenshot: vi.fn(async () => Buffer.from('screenshot')),
      executeScript: vi.fn((script?: string) => {
        const text = typeof script === 'string' ? script : ''
        // 本用例只模拟「导航销毁 settle 观察脚本」；指针 / 验证码探测不得一起挂死。
        if (navigationStarted && text.includes('MutationObserver')) {
          return new Promise(() => {})
        }
        return Promise.resolve(true)
      }),
      sendCDP: vi.fn(async (method: string, params: any) => {
        switch (method) {
          case 'DOM.enable':
          case 'Runtime.enable':
          case 'DOM.scrollIntoViewIfNeeded':
          case 'Runtime.releaseObject':
            return {}
          case 'DOM.getDocument':
            return { root: { nodeId: 1 } }
          case 'DOM.querySelectorAll':
            return { nodeIds: [13] }
          case 'DOM.getBoxModel':
            return BOX
          case 'DOM.describeNode':
            return { node: { backendNodeId: 130 } }
          case 'DOM.resolveNode':
            return { object: { objectId: 'submit-button' } }
          case 'Runtime.callFunctionOn':
            return { result: { value: null } }
          case 'Input.dispatchMouseEvent':
            if (params.type === 'mouseReleased') navigationStarted = true
            return {}
          default:
            throw new Error(`unexpected CDP method: ${method}`)
        }
      }),
    } as any
    const impl = new BrowserToolImpl()
    impl.setContextFactory(() => ctx)

    const pending = (impl as any).coreExecuteAct(
      'tab-submit',
      {
        actions: [{ type: 'click', selector: '#submit' }],
        stop_on_error: true,
      },
      Date.now(),
    )
    await vi.advanceTimersByTimeAsync(5000)
    const result = await pending

    expect(result).toMatchObject({
      success: true,
      page_url: 'https://example.test/post',
      executed_actions: [
        {
          type: 'click',
          status: 'success',
        },
      ],
    })
    const scripts = ctx.executeScript.mock.calls.map(([script]: [string]) => String(script))
    expect(scripts.some((script) => script.includes('__tabtinAgentCursor'))).toBe(true)
    expect(scripts.some((script) => script.includes('MutationObserver'))).toBe(true)
  })
})
