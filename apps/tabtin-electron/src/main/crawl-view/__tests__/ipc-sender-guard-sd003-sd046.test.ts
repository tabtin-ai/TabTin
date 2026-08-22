/**
 * SD-003, SD-004, SD-012, SD-013, SD-014, SD-015, SD-044, SD-045, SD-046 回归测试
 *
 * 验证 crawl-view:* 敏感 IPC handler 拒绝来自不受信任渲染进程的调用。
 * 纯逻辑测试，不依赖真实 Electron 运行时。
 */
import { describe, it, expect } from 'vitest'

// ── 复刻 isTrustedSender 核心判断逻辑（脱离 Electron 运行时） ──

function isTrustedSender(senderFrameUrl: string | undefined): boolean {
  try {
    const frameUrl = senderFrameUrl
    if (!frameUrl) return false
    if (frameUrl.startsWith('file://')) return true
    if (frameUrl.startsWith('http://localhost:')) return true
    const rendererUrl = process.env['ELECTRON_RENDERER_URL']
    if (rendererUrl && frameUrl.startsWith(rendererUrl)) return true
    return false
  } catch {
    return false
  }
}

interface MockEvent {
  senderFrame?: { url: string }
  sender: { id: number }
}

function makeTrustedEvent(): MockEvent {
  return { senderFrame: { url: 'file:///app/index.html' }, sender: { id: 1 } }
}

function makeUntrustedEvent(url = 'https://evil.example.com/exploit.html'): MockEvent {
  return { senderFrame: { url }, sender: { id: 99 } }
}

function makeNoFrameEvent(): MockEvent {
  return { sender: { id: 100 } }
}

// Wave 0 contract: guardedHandle 改返 envelope 形状 ({ok, error.code/message});
// 测试中复刻的 stub 也跟着新形状，跟生产 utils/guarded-handle.ts 保持一致。
const UNAUTHORIZED = {
  ok: false,
  error: {
    code: 'UNAUTHORIZED',
    message: 'Unauthorized: untrusted origin',
    retryable: false,
  },
}

function guardedHandle(
  listener: (...args: any[]) => any,
): (event: MockEvent, ...args: any[]) => any {
  return async (event: MockEvent, ...args: any[]) => {
    if (!isTrustedSender(event.senderFrame?.url)) {
      return UNAUTHORIZED
    }
    return listener(event, ...args)
  }
}

// ── SD-003: crawl-view:getCDPEndpoint ──

describe('SD-003: crawl-view:getCDPEndpoint senderFrame 防护', () => {
  const handler = guardedHandle((_event: MockEvent) => {
    return { success: true, endpoint: 'ws://127.0.0.1:9222/devtools/browser/xxx' }
  })

  it('受信来源正常获取 CDP 端点', async () => {
    const result = await handler(makeTrustedEvent())
    expect(result.success).toBe(true)
    expect(result.endpoint).toBeDefined()
  })

  it('外部页面无法获取 CDP 端点（防止远程调试劫持）', async () => {
    const result = await handler(makeUntrustedEvent())
    expect(result).toEqual(UNAUTHORIZED)
  })

  it('无 senderFrame 时被拒绝', async () => {
    const result = await handler(makeNoFrameEvent())
    expect(result).toEqual(UNAUTHORIZED)
  })
})

// ── SD-004: crawl-view:getWebContentsId ──

describe('SD-004: crawl-view:getWebContentsId senderFrame 防护', () => {
  const handler = guardedHandle((_event: MockEvent) => {
    return { success: true, id: 42 }
  })

  it('受信来源正常获取 WebContents ID', async () => {
    const result = await handler(makeTrustedEvent())
    expect(result.success).toBe(true)
    expect(result.id).toBe(42)
  })

  it('外部页面无法获取 WebContents ID（防止横向攻击）', async () => {
    const result = await handler(makeUntrustedEvent())
    expect(result).toEqual(UNAUTHORIZED)
  })
})

// ── SD-012: crawl-view:screenshot ──

describe('SD-012: crawl-view:screenshot senderFrame 防护', () => {
  const handler = guardedHandle((_event: MockEvent, _options?: any, _tabId?: string) => {
    return { success: true, data: 'base64data', format: 'png' }
  })

  it('受信来源正常截图', async () => {
    const result = await handler(makeTrustedEvent(), { format: 'png' }, 'tab-1')
    expect(result.success).toBe(true)
  })

  it('外部页面无法对 Tab 截屏（防止界面内容泄漏）', async () => {
    const result = await handler(makeUntrustedEvent(), { format: 'png' }, 'tab-1')
    expect(result).toEqual(UNAUTHORIZED)
  })
})

// ── SD-013: crawl-view:getHTML ──

describe('SD-013: crawl-view:getHTML senderFrame 防护', () => {
  const handler = guardedHandle((_event: MockEvent, _tabId?: string) => {
    return { success: true, html: '<html></html>' }
  })

  it('受信来源正常获取 HTML', async () => {
    const result = await handler(makeTrustedEvent(), 'tab-1')
    expect(result.success).toBe(true)
  })

  it('外部页面无法读取任意 Tab 的 HTML（防止内容泄漏）', async () => {
    const result = await handler(makeUntrustedEvent(), 'tab-1')
    expect(result).toEqual(UNAUTHORIZED)
  })
})

// ── SD-014: crawl-view:show / hide / setViewBounds ──

describe('SD-014: crawl-view:show senderFrame 防护', () => {
  const handler = guardedHandle((_event: MockEvent, _urlOrTabId: string) => {
    return { success: true }
  })

  it('受信来源正常显示视图', async () => {
    const result = await handler(makeTrustedEvent(), 'tab-1')
    expect(result.success).toBe(true)
  })

  it('外部页面无法控制视图显示', async () => {
    const result = await handler(makeUntrustedEvent(), 'tab-1')
    expect(result).toEqual(UNAUTHORIZED)
  })
})

describe('SD-014: crawl-view:hide senderFrame 防护', () => {
  const handler = guardedHandle((_event: MockEvent, _tabId?: string) => {
    return { success: true }
  })

  it('受信来源正常隐藏视图', async () => {
    const result = await handler(makeTrustedEvent())
    expect(result.success).toBe(true)
  })

  it('外部页面无法隐藏视图', async () => {
    const result = await handler(makeUntrustedEvent())
    expect(result).toEqual(UNAUTHORIZED)
  })
})

describe('SD-014: crawl-view:setViewBounds senderFrame 防护', () => {
  const handler = guardedHandle((_event: MockEvent, _tabId: string, _bounds: any) => {
    return { success: true }
  })

  it('受信来源正常设置视图边界', async () => {
    const result = await handler(makeTrustedEvent(), 'tab-1', { x: 0, y: 0, width: 800, height: 600 })
    expect(result.success).toBe(true)
  })

  it('外部页面无法设置视图边界', async () => {
    const result = await handler(makeUntrustedEvent(), 'tab-1', { x: 0, y: 0, width: 800, height: 600 })
    expect(result).toEqual(UNAUTHORIZED)
  })
})

// ── SD-015: crawl-view:destroyTabView ──

describe('SD-015: crawl-view:destroyTabView senderFrame 防护', () => {
  const handler = guardedHandle((_event: MockEvent, _tabId: string) => {
    return { success: true }
  })

  it('受信来源正常销毁标签', async () => {
    const result = await handler(makeTrustedEvent(), 'tab-1')
    expect(result.success).toBe(true)
  })

  it('外部页面无法销毁用户 Tab（防止拒绝服务）', async () => {
    const result = await handler(makeUntrustedEvent(), 'tab-1')
    expect(result).toEqual(UNAUTHORIZED)
  })

  it('无 senderFrame 时被拒绝', async () => {
    const result = await handler(makeNoFrameEvent(), 'tab-1')
    expect(result).toEqual(UNAUTHORIZED)
  })
})

// ── SD-044: crawl-view:findInPage / stopFindInPage ──

describe('SD-044: crawl-view:findInPage senderFrame 防护', () => {
  const handler = guardedHandle((_event: MockEvent, _tabId: string, _text: string) => {
    return { success: true, requestId: 1 }
  })

  it('受信来源正常查找', async () => {
    const result = await handler(makeTrustedEvent(), 'tab-1', 'search text')
    expect(result.success).toBe(true)
  })

  it('外部页面无法触发页面内查找', async () => {
    const result = await handler(makeUntrustedEvent(), 'tab-1', 'search text')
    expect(result).toEqual(UNAUTHORIZED)
  })
})

describe('SD-044: crawl-view:stopFindInPage senderFrame 防护', () => {
  const handler = guardedHandle((_event: MockEvent, _tabId: string) => {
    return { success: true }
  })

  it('受信来源正常停止查找', async () => {
    const result = await handler(makeTrustedEvent(), 'tab-1')
    expect(result.success).toBe(true)
  })

  it('外部页面无法干扰页面查找操作', async () => {
    const result = await handler(makeUntrustedEvent(), 'tab-1')
    expect(result).toEqual(UNAUTHORIZED)
  })
})

// ── SD-045: crawl-view:setZoomLevel ──

describe('SD-045: crawl-view:setZoomLevel senderFrame 防护', () => {
  const handler = guardedHandle((_event: MockEvent, _tabId: string, _level: number) => {
    return { success: true }
  })

  it('受信来源正常设置缩放', async () => {
    const result = await handler(makeTrustedEvent(), 'tab-1', 1.5)
    expect(result.success).toBe(true)
  })

  it('外部页面无法修改缩放级别', async () => {
    const result = await handler(makeUntrustedEvent(), 'tab-1', 1.5)
    expect(result).toEqual(UNAUTHORIZED)
  })
})

// ── SD-046: crawl-view:reconcileOrphans ──

describe('SD-046: crawl-view:reconcileOrphans senderFrame 防护', () => {
  const handler = guardedHandle((_event: MockEvent, _payload: any) => {
    return { success: true }
  })

  it('受信来源正常调和孤儿资源', async () => {
    const result = await handler(makeTrustedEvent(), { knownTabIds: ['tab-1'] })
    expect(result.success).toBe(true)
  })

  it('外部页面无法触发视图资源调和', async () => {
    const result = await handler(makeUntrustedEvent(), { knownTabIds: ['tab-1'] })
    expect(result).toEqual(UNAUTHORIZED)
  })
})

// ── 综合：多种攻击 URL 全部被拦截 ──

describe('crawl-view senderFrame 伪装 URL 边界测试', () => {
  const handler = guardedHandle(() => ({ success: true }))

  const maliciousUrls = [
    'https://evil.example.com/steal-cdp',
    'http://attacker.io:8080/exploit',
    'http://localhost.evil.com:5173',
    'javascript:void(0)',
    'data:text/html,<script>alert(1)</script>',
    'about:blank',
    'chrome-extension://malicious-id/popup.html',
  ]

  for (const url of maliciousUrls) {
    it(`拒绝伪装 URL: ${url}`, async () => {
      const result = await handler(makeUntrustedEvent(url))
      expect(result).toEqual(UNAUTHORIZED)
    })
  }
})
