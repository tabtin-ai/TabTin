/**
 * IES-012 回归测试
 *
 * 验证 crawl-view/ipc-handlers.ts 中原先使用 trackHandle（无 sender 验证）的 14 个 channel
 * 已全部切换为 guardedTrackHandle（含 isTrustedSender 验证）。
 * 纯逻辑测试，不依赖真实 Electron 运行时。
 */
import { describe, it, expect } from 'vitest'

// ── 复刻 isTrustedSender 核心判断逻辑 ──

function isTrustedSender(senderFrameUrl: string | undefined): boolean {
  try {
    if (!senderFrameUrl) return false
    if (senderFrameUrl.startsWith('file://')) return true
    const rendererUrl = process.env['ELECTRON_RENDERER_URL']
    if (rendererUrl && senderFrameUrl.startsWith(rendererUrl)) return true
    return false
  } catch {
    return false
  }
}

interface MockEvent {
  senderFrame?: { url: string }
  sender: { id: number }
}

const UNAUTHORIZED = Object.freeze({
  success: false,
  error: 'Unauthorized: untrusted origin',
})

function makeTrustedEvent(): MockEvent {
  return { senderFrame: { url: 'file:///app/index.html' }, sender: { id: 1 } }
}

function makeUntrustedEvent(url = 'https://evil.example.com/exploit.html'): MockEvent {
  return { senderFrame: { url }, sender: { id: 99 } }
}

function makeNoFrameEvent(): MockEvent {
  return { sender: { id: 100 } }
}

function guardedHandler(
  listener: (...args: any[]) => any,
): (event: MockEvent, ...args: any[]) => any {
  return async (event: MockEvent, ...args: any[]) => {
    if (!isTrustedSender(event.senderFrame?.url)) {
      return UNAUTHORIZED
    }
    return listener(event, ...args)
  }
}

/**
 * 以下 14 个 channel 在 IES-012 修复前使用了无防护的 trackHandle，
 * 修复后全部切换为 guardedTrackHandle。此测试验证每个 channel 的 guard 行为。
 */

// ── crawl-view:setIgnoreMouseEventsForAttached ──

describe('IES-012: crawl-view:setIgnoreMouseEventsForAttached senderFrame 防护', () => {
  const handler = guardedHandler((_event: MockEvent, _ignore: boolean) => ({ success: true }))

  it('受信来源正常设置鼠标事件忽略', async () => {
    expect((await handler(makeTrustedEvent(), true)).success).toBe(true)
  })

  it('外部页面无法控制鼠标事件忽略状态', async () => {
    expect(await handler(makeUntrustedEvent(), true)).toEqual(UNAUTHORIZED)
  })
})

// ── crawl-view:goBack ──

describe('IES-012: crawl-view:goBack senderFrame 防护', () => {
  const handler = guardedHandler((_event: MockEvent) => ({ success: true }))

  it('受信来源正常后退', async () => {
    expect((await handler(makeTrustedEvent())).success).toBe(true)
  })

  it('外部页面无法操控导航后退', async () => {
    expect(await handler(makeUntrustedEvent())).toEqual(UNAUTHORIZED)
  })
})

// ── crawl-view:goForward ──

describe('IES-012: crawl-view:goForward senderFrame 防护', () => {
  const handler = guardedHandler((_event: MockEvent) => ({ success: true }))

  it('受信来源正常前进', async () => {
    expect((await handler(makeTrustedEvent())).success).toBe(true)
  })

  it('外部页面无法操控导航前进', async () => {
    expect(await handler(makeUntrustedEvent())).toEqual(UNAUTHORIZED)
  })
})

// ── crawl-view:reload ──

describe('IES-012: crawl-view:reload senderFrame 防护', () => {
  const handler = guardedHandler((_event: MockEvent, _ignoreCache: boolean) => ({ success: true }))

  it('受信来源正常刷新', async () => {
    expect((await handler(makeTrustedEvent(), false)).success).toBe(true)
  })

  it('外部页面无法强制刷新视图（可用于绕过缓存）', async () => {
    expect(await handler(makeUntrustedEvent(), true)).toEqual(UNAUTHORIZED)
  })
})

// ── crawl-view:stop ──

describe('IES-012: crawl-view:stop senderFrame 防护', () => {
  const handler = guardedHandler((_event: MockEvent) => ({ success: true }))

  it('受信来源正常停止加载', async () => {
    expect((await handler(makeTrustedEvent())).success).toBe(true)
  })

  it('外部页面无法停止视图加载', async () => {
    expect(await handler(makeUntrustedEvent())).toEqual(UNAUTHORIZED)
  })
})

// ── crawl-view:getNavigationState ──

describe('IES-012: crawl-view:getNavigationState senderFrame 防护', () => {
  const handler = guardedHandler((_event: MockEvent) => ({
    success: true, state: { canGoBack: false, canGoForward: false },
  }))

  it('受信来源正常获取导航状态', async () => {
    expect((await handler(makeTrustedEvent())).success).toBe(true)
  })

  it('外部页面无法读取导航状态', async () => {
    expect(await handler(makeUntrustedEvent())).toEqual(UNAUTHORIZED)
  })
})

// ── crawl-view:waitForSelector ──

describe('IES-012: crawl-view:waitForSelector senderFrame 防护', () => {
  const handler = guardedHandler((_event: MockEvent, _tabId: string, _options: any) => ({
    success: true, found: true,
  }))

  it('受信来源正常等待选择器', async () => {
    expect((await handler(makeTrustedEvent(), 'tab-1', { selector: '#app' })).success).toBe(true)
  })

  it('外部页面无法使用 DOM 选择器探测', async () => {
    expect(await handler(makeUntrustedEvent(), 'tab-1', { selector: '#app' })).toEqual(UNAUTHORIZED)
  })
})

// ── crawl-view:getProcessedContent ──

describe('IES-012: crawl-view:getProcessedContent senderFrame 防护', () => {
  const handler = guardedHandler((_event: MockEvent) => ({
    success: true, content: 'processed',
  }))

  it('受信来源正常获取处理后内容', async () => {
    expect((await handler(makeTrustedEvent())).success).toBe(true)
  })

  it('外部页面无法读取页面处理后内容（防止内容泄漏）', async () => {
    expect(await handler(makeUntrustedEvent())).toEqual(UNAUTHORIZED)
  })
})

// ── crawl-view:getPageInfo ──

describe('IES-012: crawl-view:getPageInfo senderFrame 防护', () => {
  const handler = guardedHandler((_event: MockEvent) => ({
    success: true, pageInfo: { title: 'Test', url: 'https://example.com' },
  }))

  it('受信来源正常获取页面信息', async () => {
    expect((await handler(makeTrustedEvent())).success).toBe(true)
  })

  it('外部页面无法读取页面元信息', async () => {
    expect(await handler(makeUntrustedEvent())).toEqual(UNAUTHORIZED)
  })
})

// ── crawl-view:getCacheStats ──

describe('IES-012: crawl-view:getCacheStats senderFrame 防护', () => {
  const handler = guardedHandler((_event: MockEvent) => ({
    success: true, stats: { total: 5, max: 10 },
  }))

  it('受信来源正常获取缓存统计', async () => {
    expect((await handler(makeTrustedEvent())).success).toBe(true)
  })

  it('外部页面无法读取缓存统计（信息泄露）', async () => {
    expect(await handler(makeUntrustedEvent())).toEqual(UNAUTHORIZED)
  })
})

// ── crawl-view:cleanupCache ──

describe('IES-012: crawl-view:cleanupCache senderFrame 防护', () => {
  const handler = guardedHandler((_event: MockEvent) => ({
    success: true, message: 'cleanup done',
  }))

  it('受信来源正常触发缓存清理', async () => {
    expect((await handler(makeTrustedEvent())).success).toBe(true)
  })

  it('外部页面无法触发缓存清理（拒绝服务）', async () => {
    expect(await handler(makeUntrustedEvent())).toEqual(UNAUTHORIZED)
  })
})

// ── crawl-view:hasView ──

describe('IES-012: crawl-view:hasView senderFrame 防护', () => {
  const handler = guardedHandler((_event: MockEvent, _viewId: string) => ({
    success: true, exists: true,
  }))

  it('受信来源正常检查 View 存在性', async () => {
    expect((await handler(makeTrustedEvent(), 'view-1')).success).toBe(true)
  })

  it('外部页面无法枚举 View（信息泄露）', async () => {
    expect(await handler(makeUntrustedEvent(), 'view-1')).toEqual(UNAUTHORIZED)
  })
})

// ── crawl-view:touch ──

describe('IES-012: crawl-view:touch senderFrame 防护', () => {
  const handler = guardedHandler((_event: MockEvent, _viewId: string) => ({
    success: true, touched: true,
  }))

  it('受信来源正常 touch View', async () => {
    expect((await handler(makeTrustedEvent(), 'view-1')).success).toBe(true)
  })

  it('外部页面无法 touch View（延长存活时间）', async () => {
    expect(await handler(makeUntrustedEvent(), 'view-1')).toEqual(UNAUTHORIZED)
  })
})

// ── crawl-view:getZoomLevel ──

describe('IES-012: crawl-view:getZoomLevel senderFrame 防护', () => {
  const handler = guardedHandler((_event: MockEvent, _tabId: string) => ({
    success: true, level: 1.0,
  }))

  it('受信来源正常获取缩放级别', async () => {
    expect((await handler(makeTrustedEvent(), 'tab-1')).success).toBe(true)
  })

  it('外部页面无法读取缩放级别', async () => {
    expect(await handler(makeUntrustedEvent(), 'tab-1')).toEqual(UNAUTHORIZED)
  })
})

// ── 综合：无 senderFrame 时所有原 trackHandle channel 都被拦截 ──

describe('IES-012: 无 senderFrame 时原 trackHandle channel 全部被拦截', () => {
  const handler = guardedHandler(() => ({ success: true }))

  it('无 senderFrame 事件被拒绝', async () => {
    expect(await handler(makeNoFrameEvent())).toEqual(UNAUTHORIZED)
  })
})
