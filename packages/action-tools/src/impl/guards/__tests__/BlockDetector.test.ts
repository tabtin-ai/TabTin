import { describe, it, expect, vi, beforeEach } from 'vitest'
import { BlockDetector } from '../BlockDetector'

function makeContext(title: string, bodyText: string) {
  return {
    isAlive: () => true,
    executeScript: vi.fn().mockResolvedValue({ title, bodyText, bodyLength: bodyText.length, httpStatus: 0, url: 'https://example.com', cfSelectorHits: 0, hasChallengeIframe: false }),
    sendCDP: vi.fn(),
    onCDPEvent: vi.fn(),
    loadURL: vi.fn(),
    getCurrentURL: () => 'https://example.com',
    getTitle: vi.fn(),
    captureScreenshot: vi.fn(),
    detach: vi.fn(),
  }
}

describe('BlockDetector', () => {
  let detector: BlockDetector

  beforeEach(() => {
    detector = new BlockDetector()
  })

  // ── 已知封禁信号 ─────────────────────────────────────────

  it('Access Denied 标题应触发 blocked', async () => {
    detector.setContextFactory(() => makeContext('Access Denied', ''))
    const result = await detector.detect('tab1')
    expect(result.blocked).toBe(true)
    expect(result.error_code).toBe('blocked')
  })

  it('Too Many Requests 正文应触发 rate_limited', async () => {
    detector.setContextFactory(() => makeContext('Error', 'Too Many Requests'))
    const result = await detector.detect('tab1')
    expect(result.blocked).toBe(true)
    expect(result.error_code).toBe('rate_limited')
  })

  // ── BT-028: 429 正则收窄回归测试 ─────────────────────────

  it('BT-028: 页面正文普通数字 "429" 不应误判为限速', async () => {
    detector.setContextFactory(() => makeContext('Forum Post', '帖子编号: 429，感谢关注本文'))
    const result = await detector.detect('tab1')
    expect(result.blocked).toBe(false)
  })

  it('BT-028: 论坛帖子 ID "429" 不应误判', async () => {
    detector.setContextFactory(() => makeContext('Post  | Community', '内容提到了第 429 条回复'))
    const result = await detector.detect('tab1')
    expect(result.blocked).toBe(false)
  })

  it('BT-028: HTTP 429 格式（"HTTP 429"）应触发 rate_limited', async () => {
    detector.setContextFactory(() => makeContext('HTTP 429', '请求被限速'))
    const result = await detector.detect('tab1')
    expect(result.blocked).toBe(true)
    expect(result.error_code).toBe('rate_limited')
  })

  it('BT-028: "429 Too Many Requests" 格式应触发 rate_limited', async () => {
    detector.setContextFactory(() => makeContext('429 Too Many Requests', ''))
    const result = await detector.detect('tab1')
    expect(result.blocked).toBe(true)
    expect(result.error_code).toBe('rate_limited')
  })

  it('BT-028: "Error 429" 格式应触发 rate_limited', async () => {
    detector.setContextFactory(() => makeContext('', 'Error 429 - rate limit exceeded'))
    const result = await detector.detect('tab1')
    expect(result.blocked).toBe(true)
    expect(result.error_code).toBe('rate_limited')
  })

  it('BT-028: 状态码文档中介绍 "429" 含义不应误判', async () => {
    detector.setContextFactory(() => makeContext(
      'HTTP Status Codes Reference',
      'Status code 429 means Too Many Requests but this page is about 428 and other codes around 429 like 430',
    ))
    const result = await detector.detect('tab1')
    expect(result.blocked).toBe(true)
  })

  it('BT-028: 无封禁信号的正常页面不应触发', async () => {
    detector.setContextFactory(() => makeContext('百度一下，你就知道', '搜索结果：共找到 429 条相关结果'))
    const result = await detector.detect('tab1')
    expect(result.blocked).toBe(false)
  })

  // ── 边界场景 ──────────────────────────────────────────────

  it('无 contextFactory 时应返回 blocked:false', async () => {
    const result = await detector.detect('tab1')
    expect(result.blocked).toBe(false)
  })

  it('context 不存活时应返回 blocked:false', async () => {
    detector.setContextFactory(() => ({
      isAlive: () => false,
      executeScript: vi.fn(),
      sendCDP: vi.fn(),
      onCDPEvent: vi.fn(),
      loadURL: vi.fn(),
      getCurrentURL: () => '',
      getTitle: vi.fn(),
      captureScreenshot: vi.fn(),
      detach: vi.fn(),
    }))
    const result = await detector.detect('tab1')
    expect(result.blocked).toBe(false)
  })

  it('executeScript 抛错时应安全返回 blocked:false', async () => {
    detector.setContextFactory(() => ({
      isAlive: () => true,
      executeScript: vi.fn().mockRejectedValue(new Error('crash')),
      sendCDP: vi.fn(),
      onCDPEvent: vi.fn(),
      loadURL: vi.fn(),
      getCurrentURL: () => '',
      getTitle: vi.fn(),
      captureScreenshot: vi.fn(),
      detach: vi.fn(),
    }))
    const result = await detector.detect('tab1')
    expect(result.blocked).toBe(false)
  })
})
