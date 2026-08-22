import { describe, it, expect, vi, beforeEach } from 'vitest'
import { cleanupResourceInterceptionState, setupResourceInterception } from '../resource-interception'
import type { ResourceInterceptionContext } from '../resource-interception'

const webContentsById = new Map<number, { getURL: () => string }>()

vi.mock('electron', () => ({
  webContents: {
    fromId: vi.fn((id: number) => webContentsById.get(id) ?? null),
  },
}))

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

type RequestCallback = (details: any, callback: (resp: any) => void) => void

function createMockSessionHarness() {
  let onBeforeRequestCb: RequestCallback | null = null
  let onBeforeSendHeadersCb: RequestCallback | null = null

  return {
    session: {
      webRequest: {
        onBeforeRequest: vi.fn((filter: any, cb: RequestCallback) => {
          onBeforeRequestCb = cb
        }),
        onBeforeSendHeaders: vi.fn((filter: any, cb: RequestCallback) => {
          onBeforeSendHeadersCb = cb
        }),
      },
    },
    getOnBeforeRequestCb: () => onBeforeRequestCb,
    getOnBeforeSendHeadersCb: () => onBeforeSendHeadersCb,
  }
}

let nextWebContentsId = 1

function createMockView(options?: {
  sessionHarness?: ReturnType<typeof createMockSessionHarness>
  webContentsId?: number
}) {
  const sessionHarness = options?.sessionHarness ?? createMockSessionHarness()
  const webContentsId = options?.webContentsId ?? nextWebContentsId++
  let destroyedCb: (() => void) | null = null

  const view = {
    webContents: {
      id: webContentsId,
      getUserAgent: vi.fn(() => 'Mozilla/5.0 Chrome/132.0.0.0 Safari/537.36'),
      getURL: vi.fn(() => 'https://example.com'),
      isDestroyed: vi.fn(() => false),
      once: vi.fn((event: string, cb: () => void) => {
        if (event === 'destroyed') {
          destroyedCb = cb
        }
      }),
      session: sessionHarness.session,
    },
  }

  webContentsById.set(webContentsId, {
    getURL: () => {
      const getURL = (view.webContents.getURL as unknown as () => string)
      return getURL()
    },
  })

  return {
    view: view as any,
    simulateRequest(url: string, details: Record<string, unknown> = {}): { cancel: boolean } {
      const onBeforeRequestCb = sessionHarness.getOnBeforeRequestCb()
      if (!onBeforeRequestCb) throw new Error('onBeforeRequest not registered')
      let result: any
      onBeforeRequestCb({ url, webContentsId, ...details }, (resp) => { result = resp })
      return result
    },
    simulateHeaderRequest(
      url: string,
      resourceType = 'document',
      extraHeaders: Record<string, string> = {},
      details: Record<string, unknown> = {}
    ): Record<string, string> {
      const onBeforeSendHeadersCb = sessionHarness.getOnBeforeSendHeadersCb()
      if (!onBeforeSendHeadersCb) throw new Error('onBeforeSendHeaders not registered')
      let result: any
      onBeforeSendHeadersCb(
        { url, resourceType, requestHeaders: { ...extraHeaders }, webContentsId, ...details },
        (resp) => { result = resp },
      )
      return result.requestHeaders
    },
    destroy() {
      destroyedCb?.()
      webContentsById.delete(webContentsId)
    },
  }
}

function createMockCtx(): ResourceInterceptionContext {
  return {
    clientHintsService: {
      generateHeaders: vi.fn(() => ({
        'Sec-CH-UA': '"Chromium";v="132"',
      })),
    },
    systemInfo: { arch: 'arm64' },
    log: vi.fn(),
  }
}

// ---------------------------------------------------------------------------
// BLOCKED_DOMAINS 匹配逻辑
// ---------------------------------------------------------------------------

describe('setupResourceInterception — 请求拦截', () => {
  let mock: ReturnType<typeof createMockView>
  let ctx: ResourceInterceptionContext

  beforeEach(() => {
    webContentsById.clear()
    mock = createMockView()
    ctx = createMockCtx()
    setupResourceInterception(mock.view.webContents, 'https://example.com', ctx)
  })

  it('应阻止 doubleclick.net 请求', () => {
    const res = mock.simulateRequest('https://ad.doubleclick.net/pagead/id')
    expect(res.cancel).toBe(true)
  })

  it('应阻止 google-analytics.com 请求', () => {
    const res = mock.simulateRequest('https://www.google-analytics.com/analytics.js')
    expect(res.cancel).toBe(true)
  })

  it('应阻止包含 ads. 前缀的域名', () => {
    const res = mock.simulateRequest('https://ads.example.net/banner.js')
    expect(res.cancel).toBe(true)
  })

  it('应阻止 cnzz.com 统计请求', () => {
    const res = mock.simulateRequest('https://s.cnzz.com/stat.php')
    expect(res.cancel).toBe(true)
  })

  it('应放行普通第三方请求', () => {
    const res = mock.simulateRequest('https://cdn.jsdelivr.net/npm/vue@3/dist/vue.js')
    expect(res.cancel).toBe(false)
  })

  it('应放行主域名请求（即使匹配 BLOCKED_DOMAINS 的子串）', () => {
    const mock2 = createMockView()
    ;(mock2.view.webContents.getURL as any).mockReturnValue('https://analytics.mysite.com')
    setupResourceInterception(mock2.view.webContents, 'https://analytics.mysite.com', createMockCtx())
    const res = mock2.simulateRequest('https://analytics.mysite.com/api/data')
    expect(res.cancel).toBe(false)
  })

  it('应放行主域名的子域名请求', () => {
    const res = mock.simulateRequest('https://api.example.com/v1/data')
    expect(res.cancel).toBe(false)
  })

  it('应放行当前本地服务目标，同时继续阻止其它私有地址', () => {
    const local = createMockView()
    ;(local.view.webContents.getURL as any).mockReturnValue('http://127.0.0.1:43217/')
    setupResourceInterception(local.view.webContents, 'http://127.0.0.1:43217/', createMockCtx())

    expect(local.simulateRequest('http://127.0.0.1:43217/').cancel).toBe(false)
    expect(local.simulateRequest('http://127.0.0.1:43217/@vite/client').cancel).toBe(false)
    expect(local.simulateRequest('http://127.0.0.2:43217/').cancel).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 请求头注入
// ---------------------------------------------------------------------------

describe('setupResourceInterception — 请求头', () => {
  let mock: ReturnType<typeof createMockView>
  let ctx: ResourceInterceptionContext

  beforeEach(() => {
    mock = createMockView()
    ctx = createMockCtx()
    setupResourceInterception(mock.view.webContents, 'https://example.com', ctx)
  })

  it('应注入 User-Agent 请求头', () => {
    const headers = mock.simulateHeaderRequest('https://example.com/page')
    expect(headers['User-Agent']).toBeTruthy()
  })

  it('应注入 Client Hints 请求头', () => {
    const headers = mock.simulateHeaderRequest('https://example.com/page')
    expect(headers['Sec-CH-UA']).toBeTruthy()
  })

  it('图片请求应注入 Referer', () => {
    const headers = mock.simulateHeaderRequest(
      'https://cdn.example.com/image.jpg',
      'image',
    )
    expect(headers['Referer']).toBe('https://example.com')
  })

  it('图片请求已有 Referer 时不应覆盖', () => {
    const headers = mock.simulateHeaderRequest(
      'https://cdn.example.com/image.jpg',
      'image',
      { Referer: 'https://other.com' },
    )
    expect(headers['Referer']).toBe('https://other.com')
  })

  it('图片请求应优先使用当前页面 URL 作为 Referer', () => {
    ;(mock.view.webContents.getURL as any).mockReturnValue('https://example.com/next-page')
    const headers = mock.simulateHeaderRequest(
      'https://cdn.example.com/image.jpg',
      'image',
    )
    expect(headers['Referer']).toBe('https://example.com/next-page')
  })

  it('图片请求应注入 Accept 头', () => {
    const headers = mock.simulateHeaderRequest(
      'https://cdn.example.com/photo.png',
      'image',
    )
    expect(headers['Accept']).toContain('image/')
  })

  it('非图片请求不应注入 Referer', () => {
    const headers = mock.simulateHeaderRequest(
      'https://api.example.com/data.json',
      'xhr',
    )
    expect(headers['Referer']).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 边界情况
// ---------------------------------------------------------------------------

describe('setupResourceInterception — 边界情况', () => {
  it('非 http/https URL 应跳过拦截', () => {
    const mock2 = createMockView()
    const ctx = createMockCtx()
    setupResourceInterception(mock2.view.webContents, 'file:///local/page.html', ctx)
    expect(mock2.view.webContents.session.webRequest.onBeforeRequest).not.toHaveBeenCalled()
  })

  it('空 URL 应跳过拦截', () => {
    const mock2 = createMockView()
    const ctx = createMockCtx()
    setupResourceInterception(mock2.view.webContents, '', ctx)
    expect(mock2.view.webContents.session.webRequest.onBeforeRequest).not.toHaveBeenCalled()
  })

  it('Client Hints 生成失败时应使用降级方案', () => {
    const mock2 = createMockView()
    const ctx = createMockCtx()
    ;(ctx.clientHintsService.generateHeaders as any).mockImplementation(() => {
      throw new Error('parse failure')
    })
    setupResourceInterception(mock2.view.webContents, 'https://example.com', ctx)

    const headers = mock2.simulateHeaderRequest('https://example.com/page')
    expect(headers['Sec-CH-UA']).toBeTruthy()
    expect(headers['Sec-CH-UA-Mobile']).toBeTruthy()
    expect(headers['Sec-CH-UA-Platform']).toBeTruthy()
  })

  it('单个 view 缺少 webContentsId 时仍可回退到唯一上下文', () => {
    const sessionHarness = createMockSessionHarness()
    const mock2 = createMockView({ sessionHarness, webContentsId: 101 })
    const ctx = createMockCtx()
    setupResourceInterception(mock2.view.webContents, 'https://example.com', ctx)

    const headers = mock2.simulateHeaderRequest(
      'https://cdn.example.com/image.jpg',
      'image',
      {},
      { webContentsId: undefined },
    )

    expect(headers['Referer']).toBe('https://example.com')
  })

  it('同一 session 有多个 view 时，缺少 webContentsId 的请求不应串用 Referer', () => {
    const sessionHarness = createMockSessionHarness()
    const first = createMockView({ sessionHarness, webContentsId: 201 })
    const second = createMockView({ sessionHarness, webContentsId: 202 })

    setupResourceInterception(first.view.webContents, 'https://first.example.com', createMockCtx())
    setupResourceInterception(second.view.webContents, 'https://second.example.com', createMockCtx())

    const headers = first.simulateHeaderRequest(
      'https://cdn.example.com/image.jpg',
      'image',
      {},
      { webContentsId: undefined },
    )

    expect(headers['Referer']).toBeUndefined()
  })

  it('显式清理旧 view 后，同 session 新 view 仍可回退到唯一上下文', () => {
    const sessionHarness = createMockSessionHarness()
    const first = createMockView({ sessionHarness, webContentsId: 301 })
    setupResourceInterception(first.view.webContents, 'https://first.example.com', createMockCtx())

    cleanupResourceInterceptionState(first.view.webContents.session as any, 301)

    const second = createMockView({ sessionHarness, webContentsId: 302 })
    ;(second.view.webContents.getURL as any).mockReturnValue('https://second.example.com')
    setupResourceInterception(second.view.webContents, 'https://second.example.com', createMockCtx())

    const headers = second.simulateHeaderRequest(
      'https://cdn.example.com/image.jpg',
      'image',
      {},
      { webContentsId: undefined },
    )

    expect(headers['Referer']).toBe('https://second.example.com')
  })
})
