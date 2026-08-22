/**
 * 回归：淘宝 search 在拦不到 wsearch 时不得先烧光 CLI 默认 30s。
 * 取证见 docs/agent/taobao-reach-search-timeout-evidence.md
 */
import { describe, expect, it, vi } from 'vitest'
import { taobaoAdapter } from '../adapters/ecommerce'
import type { RunContext } from '../adapter'
import type { BrowserPrimitives, NetworkCaptureEntry } from '../primitives'

const CLI_DEFAULT_TIMEOUT_MS = 30_000

function fakeBrowser(overrides: Partial<BrowserPrimitives> = {}): BrowserPrimitives {
  return {
    open: vi.fn(async ({ tabId }) => ({ tabId: tabId ?? 'tab-1', url: 'about:opened' })),
    captureNetwork: vi.fn(async () => [] as NetworkCaptureEntry[]),
    eval: vi.fn(async () => null),
    waitFor: vi.fn(async () => undefined),
    ...overrides,
  }
}

describe('taobao.search timeout budget', () => {
  it('DOM 有货时不再先烧 capture 预算（live 根因回归）', async () => {
    const capture = vi.fn(async () => [] as NetworkCaptureEntry[])
    const browser = fakeBrowser({
      captureNetwork: capture,
      eval: vi.fn(async ({ expression }) => {
        if (expression.includes('item.taobao.com/item.htm')) {
          return JSON.stringify([
            {
              id: '1',
              url: 'https://item.taobao.com/item.htm?id=1',
              title: '露营椅',
              price: '99',
            },
          ])
        }
        return null
      }),
    })
    const ctx: RunContext = { browser, authContext: 'anonymous', tabId: 'tab-1' }
    const items = await taobaoAdapter.verbs.search!.run(ctx, { query: '露营椅', limit: 3 })
    expect(items).toHaveLength(1)
    expect(items[0].title).toContain('露营椅')
    expect(capture).not.toHaveBeenCalled()
  })

  it('miss 路径 capture 总预算必须低于 CLI 默认 30s', async () => {
    const captureTimeouts: number[] = []
    const browser = fakeBrowser({
      captureNetwork: vi.fn(async ({ timeoutMs }) => {
        captureTimeouts.push(timeoutMs ?? 0)
        return []
      }),
      eval: vi.fn(async ({ expression }) => {
        if (expression.includes('亲，请登录')) return true
        // 空商品卡用 truthy JSON，避免 pollEval 真睡满多轮撞 vitest 默认超时
        if (expression.includes('item.taobao.com/item.htm')) return '[]'
        return null
      }),
    })
    const ctx: RunContext = { browser, authContext: 'anonymous', tabId: 'tab-1' }
    await expect(
      taobaoAdapter.verbs.search!.run(ctx, { query: '露营椅', limit: 3 }),
    ).rejects.toThrow(/登录墙/)
    const captureBudgetMs = captureTimeouts.reduce((a, b) => a + b, 0)
    expect(captureBudgetMs).toBeLessThan(CLI_DEFAULT_TIMEOUT_MS)
  })
})
