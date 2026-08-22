import { describe, expect, it, vi } from 'vitest'
import { xiaohongshuAdapter } from '../adapters/xiaohongshu'
import type { RunContext } from '../adapter'
import type { BrowserPrimitives, NetworkCaptureEntry } from '../primitives'

/** 可编程的假浏览器端口：只实现测试需要的动作。 */
function fakeBrowser(overrides: Partial<BrowserPrimitives> = {}): BrowserPrimitives {
  return {
    open: vi.fn(async ({ tabId }) => ({ tabId: tabId ?? 'tab-1', url: 'about:opened' })),
    captureNetwork: vi.fn(async () => [] as NetworkCaptureEntry[]),
    eval: vi.fn(async () => false),
    waitFor: vi.fn(async () => undefined),
    ...overrides,
  }
}

function ctxWith(browser: BrowserPrimitives): RunContext {
  return { browser, authContext: 'anonymous', tabId: 'tab-1' }
}

const searchFeedBody = JSON.stringify({
  data: {
    items: [
      {
        id: 'n1',
        xsec_token: 'TK1',
        note_card: {
          display_title: 'agent 浏览器横评',
          user: { user_id: 'u1', nickname: '作者' },
          interact_info: { liked_count: '2000' },
        },
      },
    ],
  },
})

describe('xiaohongshu.resolve (xsec_token 两跳约束)', () => {
  it('passes through an already-signed URL', async () => {
    const ctx = ctxWith(fakeBrowser())
    const url = 'https://www.xiaohongshu.com/explore/n1?xsec_token=TK1'
    await expect(xiaohongshuAdapter.resolve!(ctx, url)).resolves.toBe(url)
  })

  it('rejects a bare note id and tells caller to search first', async () => {
    const ctx = ctxWith(fakeBrowser())
    await expect(xiaohongshuAdapter.resolve!(ctx, 'bareid123')).rejects.toThrow(/先用 search/)
  })
})

describe('xiaohongshu.search', () => {
  it('opens search page, captures feed, returns normalized items', async () => {
    const browser = fakeBrowser({
      captureNetwork: vi.fn(async ({ urlPattern }) => {
        if (urlPattern && '/api/sns/web/v1/search/notes'.includes(urlPattern)) {
          return [
            {
              url: 'https://www.xiaohongshu.com/api/sns/web/v1/search/notes?keyword=x',
              method: 'GET',
              status: 200,
              responseBody: searchFeedBody,
            },
          ]
        }
        return []
      }),
    })
    const ctx = ctxWith(browser)
    const items = await xiaohongshuAdapter.verbs.search!.run(ctx, { query: 'agent 浏览器', limit: 5 })
    expect(browser.open).toHaveBeenCalledOnce()
    expect(items).toHaveLength(1)
    expect(items[0].title).toBe('agent 浏览器横评')
    expect(items[0].url).toContain('xsec_token=TK1')
    expect(items[0].metrics?.likes).toBe(2000)
  })

  it('returns [] (not throw) when feed not captured — 可能撞登录墙/验证码', async () => {
    const ctx = ctxWith(fakeBrowser())
    const items = await xiaohongshuAdapter.verbs.search!.run(ctx, { query: 'x' })
    expect(items).toEqual([])
  })

  it('throws when query missing', async () => {
    const ctx = ctxWith(fakeBrowser())
    await expect(xiaohongshuAdapter.verbs.search!.run(ctx, {})).rejects.toThrow(/query/)
  })

  it('honors limit', async () => {
    const twoItems = JSON.stringify({
      data: {
        items: [
          { id: 'a', xsec_token: 't', note_card: { display_title: 'A' } },
          { id: 'b', xsec_token: 't', note_card: { display_title: 'B' } },
        ],
      },
    })
    const browser = fakeBrowser({
      captureNetwork: vi.fn(async () => [
        { url: 'x/api/sns/web/v1/search/notes', method: 'GET', responseBody: twoItems },
      ]),
    })
    const items = await xiaohongshuAdapter.verbs.search!.run(ctxWith(browser), { query: 'x', limit: 1 })
    expect(items).toHaveLength(1)
  })
})

describe('xiaohongshu.read / comments require signed URL', () => {
  it('read rejects unsigned URL', async () => {
    const ctx = ctxWith(fakeBrowser())
    await expect(
      xiaohongshuAdapter.verbs.read!.run(ctx, { url: 'https://www.xiaohongshu.com/explore/n1' }),
    ).rejects.toThrow(/签名 URL/)
  })

  it('comments rejects missing URL', async () => {
    const ctx = ctxWith(fakeBrowser())
    await expect(xiaohongshuAdapter.verbs.comments!.run(ctx, {})).rejects.toThrow(/签名 URL/)
  })
})
