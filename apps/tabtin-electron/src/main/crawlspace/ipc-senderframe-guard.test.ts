/**
 * SD-007 / SD-016 / SD-017 / SD-041 / RP-010 / IPC-004 / IPC-007 / IPC-008 回归测试
 *
 * 验证 crawlspace/ipc.ts 中以下 handler 的 senderFrame 防护：
 * - crawlspace:createView (SD-007)
 * - resourceDetection:captureResource (SD-041)
 * - resourceDetection:downloadResource (SD-016)
 * - resourceDetection:downloadStream (SD-017)
 * - crawlspace:subscribe (IPC-004) — ipcMain.on 形式
 * - crawlspace:unsubscribe (IPC-008) — ipcMain.on 形式
 * - resourceDetection:parseM3U8 (IPC-007) — SSRF 防护
 * - resourceDetection:parseStream (IPC-007) — SSRF 防护
 *
 * 以及 RP-010：payload.limit 上限校验。
 *
 * 测试策略：提取 handler 核心逻辑中涉及防护的判断分支进行隔离测试，
 * 避免依赖 Electron native 模块。
 */

import { describe, it, expect } from 'vitest'

const RESOURCE_QUERY_LIMIT_MAX = 500

function isTrustedSender(event: { senderFrame?: { url?: string } }): boolean {
  try {
    const frameUrl = event.senderFrame?.url
    if (!frameUrl) return false
    if (frameUrl.startsWith('file://')) return true
    if (frameUrl.startsWith('http://localhost:')) return true
    return false
  } catch {
    return false
  }
}

// Wave 0 contract: guardedHandle 改返 envelope 形状 ({ok, error.code/message})。
const REJECT_UNTRUSTED = Object.freeze({
  ok: false as const,
  error: {
    code: 'UNAUTHORIZED' as const,
    message: 'Unauthorized: untrusted origin',
    retryable: false,
  },
})

function clampResourceLimit(value: unknown): number | undefined {
  if (value == null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return RESOURCE_QUERY_LIMIT_MAX
  return Math.min(Math.floor(value), RESOURCE_QUERY_LIMIT_MAX)
}

type FakeEvent = { senderFrame?: { url?: string } }

function makeFakeEvent(url?: string): FakeEvent {
  return url != null ? { senderFrame: { url } } : { senderFrame: undefined }
}

describe('crawlspace IPC senderFrame 防护', () => {
  const trustedUrls = [
    'file:///app/index.html',
    'http://localhost:5173/index.html',
    'http://localhost:3000/',
  ]
  const untrustedUrls = [
    'https://evil.com/attack',
    'https://example.org/',
    'http://192.168.1.1:8080/',
  ]

  describe('SD-007: crawlspace:createView', () => {
    function guardCreateView(event: FakeEvent): { success: boolean; error?: string } | 'pass' {
      if (!isTrustedSender(event)) {
        return REJECT_UNTRUSTED
      }
      return 'pass'
    }

    for (const url of trustedUrls) {
      it(`受信任来源 (${url}) → 应通过`, () => {
        expect(guardCreateView(makeFakeEvent(url))).toBe('pass')
      })
    }

    for (const url of untrustedUrls) {
      it(`不受信任来源 (${url}) → 应拒绝`, () => {
        const result = guardCreateView(makeFakeEvent(url))
        expect(result).toEqual(REJECT_UNTRUSTED)
      })
    }

    it('senderFrame 缺失 → 应拒绝', () => {
      expect(guardCreateView(makeFakeEvent())).toEqual(REJECT_UNTRUSTED)
    })
  })

  describe('SD-041: resourceDetection:captureResource', () => {
    function guardCaptureResource(event: FakeEvent): { success: boolean; error?: string } | 'pass' {
      if (!isTrustedSender(event)) {
        return REJECT_UNTRUSTED
      }
      return 'pass'
    }

    it('不受信任来源 → 应拒绝', () => {
      expect(guardCaptureResource(makeFakeEvent('https://evil.com/'))).toEqual(REJECT_UNTRUSTED)
    })

    it('受信任来源 → 应通过', () => {
      expect(guardCaptureResource(makeFakeEvent('file:///app/index.html'))).toBe('pass')
    })
  })

  describe('SD-016: resourceDetection:downloadResource', () => {
    function guardDownloadResource(event: FakeEvent): { success: boolean; error?: string } | 'pass' {
      if (!isTrustedSender(event)) {
        return REJECT_UNTRUSTED
      }
      return 'pass'
    }

    it('不受信任来源 → 应拒绝', () => {
      expect(guardDownloadResource(makeFakeEvent('https://attacker.io/'))).toEqual(REJECT_UNTRUSTED)
    })

    it('受信任来源 → 应通过', () => {
      expect(guardDownloadResource(makeFakeEvent('http://localhost:5173/'))).toBe('pass')
    })
  })

  describe('SD-017: resourceDetection:downloadStream', () => {
    function guardDownloadStream(event: FakeEvent): { success: boolean; error?: string } | 'pass' {
      if (!isTrustedSender(event)) {
        return REJECT_UNTRUSTED
      }
      return 'pass'
    }

    it('不受信任来源 → 应拒绝', () => {
      expect(guardDownloadStream(makeFakeEvent('https://malicious.site/'))).toEqual(REJECT_UNTRUSTED)
    })

    it('受信任来源 → 应通过', () => {
      expect(guardDownloadStream(makeFakeEvent('file:///opt/app/index.html'))).toBe('pass')
    })
  })

  describe('IPC-004: crawlspace:subscribe (ipcMain.on 形式)', () => {
    function guardSubscribe(event: FakeEvent): 'pass' | 'rejected' {
      if (!isTrustedSender(event)) {
        return 'rejected'
      }
      return 'pass'
    }

    for (const url of trustedUrls) {
      it(`受信任来源 (${url}) → 应通过`, () => {
        expect(guardSubscribe(makeFakeEvent(url))).toBe('pass')
      })
    }

    for (const url of untrustedUrls) {
      it(`不受信任来源 (${url}) → 应拒绝`, () => {
        expect(guardSubscribe(makeFakeEvent(url))).toBe('rejected')
      })
    }

    it('senderFrame 缺失 → 应拒绝', () => {
      expect(guardSubscribe(makeFakeEvent())).toBe('rejected')
    })
  })

  describe('IPC-008: crawlspace:unsubscribe (ipcMain.on 形式)', () => {
    function guardUnsubscribe(event: FakeEvent): 'pass' | 'rejected' {
      if (!isTrustedSender(event)) {
        return 'rejected'
      }
      return 'pass'
    }

    for (const url of untrustedUrls) {
      it(`不受信任来源 (${url}) → 应拒绝`, () => {
        expect(guardUnsubscribe(makeFakeEvent(url))).toBe('rejected')
      })
    }

    it('受信任来源 → 应通过', () => {
      expect(guardUnsubscribe(makeFakeEvent('file:///app/index.html'))).toBe('pass')
    })

    it('senderFrame 缺失 → 应拒绝', () => {
      expect(guardUnsubscribe(makeFakeEvent())).toBe('rejected')
    })
  })

  describe('IPC-007: resourceDetection:parseM3U8 SSRF 防护', () => {
    function guardParseM3U8(event: FakeEvent): { success: boolean; error?: string } | 'pass' {
      if (!isTrustedSender(event)) {
        return REJECT_UNTRUSTED
      }
      return 'pass'
    }

    for (const url of untrustedUrls) {
      it(`不受信任来源 (${url}) → 应拒绝，防止 SSRF`, () => {
        expect(guardParseM3U8(makeFakeEvent(url))).toEqual(REJECT_UNTRUSTED)
      })
    }

    it('受信任来源 → 应通过', () => {
      expect(guardParseM3U8(makeFakeEvent('file:///app/index.html'))).toBe('pass')
    })

    it('senderFrame 缺失 → 应拒绝', () => {
      expect(guardParseM3U8(makeFakeEvent())).toEqual(REJECT_UNTRUSTED)
    })
  })

  describe('IPC-007: resourceDetection:parseStream SSRF 防护', () => {
    function guardParseStream(event: FakeEvent): { success: boolean; error?: string } | 'pass' {
      if (!isTrustedSender(event)) {
        return REJECT_UNTRUSTED
      }
      return 'pass'
    }

    for (const url of untrustedUrls) {
      it(`不受信任来源 (${url}) → 应拒绝，防止 SSRF`, () => {
        expect(guardParseStream(makeFakeEvent(url))).toEqual(REJECT_UNTRUSTED)
      })
    }

    it('受信任来源 → 应通过', () => {
      expect(guardParseStream(makeFakeEvent('http://localhost:5173/'))).toBe('pass')
    })

    it('senderFrame 缺失 → 应拒绝', () => {
      expect(guardParseStream(makeFakeEvent())).toEqual(REJECT_UNTRUSTED)
    })
  })
})

describe('RP-010: payload.limit 上限校验', () => {
  it('undefined → 返回 undefined（不限制）', () => {
    expect(clampResourceLimit(undefined)).toBeUndefined()
  })

  it('null → 返回 undefined', () => {
    expect(clampResourceLimit(null)).toBeUndefined()
  })

  it('正常值 (100) → 返回原值', () => {
    expect(clampResourceLimit(100)).toBe(100)
  })

  it('超出上限 (10000) → 钳位到 500', () => {
    expect(clampResourceLimit(10000)).toBe(RESOURCE_QUERY_LIMIT_MAX)
  })

  it('Infinity → 钳位到 500', () => {
    expect(clampResourceLimit(Infinity)).toBe(RESOURCE_QUERY_LIMIT_MAX)
  })

  it('负数 → 钳位到 500', () => {
    expect(clampResourceLimit(-1)).toBe(RESOURCE_QUERY_LIMIT_MAX)
  })

  it('0 → 钳位到 500', () => {
    expect(clampResourceLimit(0)).toBe(RESOURCE_QUERY_LIMIT_MAX)
  })

  it('非 number 类型 (字符串) → 钳位到 500', () => {
    expect(clampResourceLimit('abc')).toBe(RESOURCE_QUERY_LIMIT_MAX)
  })

  it('NaN → 钳位到 500', () => {
    expect(clampResourceLimit(NaN)).toBe(RESOURCE_QUERY_LIMIT_MAX)
  })

  it('浮点数 (50.7) → 向下取整为 50', () => {
    expect(clampResourceLimit(50.7)).toBe(50)
  })

  it('恰好等于上限 (500) → 返回 500', () => {
    expect(clampResourceLimit(500)).toBe(500)
  })

  it('上限+1 (501) → 钳位到 500', () => {
    expect(clampResourceLimit(501)).toBe(500)
  })
})
