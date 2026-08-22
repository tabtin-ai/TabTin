import { afterAll, beforeAll, describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  fileUrlToLocalPath,
  getAliveWebContents,
  hasAliveWebContents,
  isAllowedLocalFileUrl,
  isAllowedUrl,
  isPathWithinRoot,
  isPrivateHost,
  validateNavigationUrl,
  toErrorMessage,
  sleep,
  ts,
} from '../utils'

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockView(opts: {
  hasWebContents?: boolean
  isDestroyed?: boolean | 'throws'
} = {}) {
  const { hasWebContents = true, isDestroyed = false } = opts

  if (!hasWebContents) return {} as any

  const isDestroyedFn =
    isDestroyed === 'throws'
      ? vi.fn(() => { throw new Error('object destroyed') })
      : vi.fn(() => isDestroyed)

  return {
    webContents: {
      isDestroyed: isDestroyedFn,
      getURL: vi.fn(() => 'https://example.com'),
    },
  } as any
}

// ---------------------------------------------------------------------------
// getAliveWebContents / hasAliveWebContents
// ---------------------------------------------------------------------------

describe('getAliveWebContents', () => {
  it('正常存活的 view 应返回 webContents', () => {
    const view = createMockView({ isDestroyed: false })
    expect(getAliveWebContents(view)).toBe(view.webContents)
  })

  it('已销毁的 view 应返回 null', () => {
    const view = createMockView({ isDestroyed: true })
    expect(getAliveWebContents(view)).toBeNull()
  })

  it('传入 null 应返回 null', () => {
    expect(getAliveWebContents(null)).toBeNull()
  })

  it('传入 undefined 应返回 null', () => {
    expect(getAliveWebContents(undefined)).toBeNull()
  })

  it('view 没有 webContents 属性时应返回 null', () => {
    expect(getAliveWebContents({} as any)).toBeNull()
  })

  it('isDestroyed 抛出异常时应返回 null', () => {
    const view = createMockView({ isDestroyed: 'throws' })
    expect(getAliveWebContents(view)).toBeNull()
  })

  it('webContents 没有 isDestroyed 方法时仍返回 webContents', () => {
    const view = { webContents: { foo: 'bar' } } as any
    expect(getAliveWebContents(view)).toBe(view.webContents)
  })
})

describe('hasAliveWebContents', () => {
  it('存活的 view 应返回 true', () => {
    expect(hasAliveWebContents(createMockView())).toBe(true)
  })

  it('已销毁的 view 应返回 false', () => {
    expect(hasAliveWebContents(createMockView({ isDestroyed: true }))).toBe(false)
  })

  it('null 应返回 false', () => {
    expect(hasAliveWebContents(null)).toBe(false)
  })

  it('undefined 应返回 false', () => {
    expect(hasAliveWebContents(undefined)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// isAllowedUrl
// ---------------------------------------------------------------------------

describe('isAllowedUrl', () => {
  it('空字符串应返回 true', () => {
    expect(isAllowedUrl('')).toBe(true)
  })

  it('about:blank 应返回 true', () => {
    expect(isAllowedUrl('about:blank')).toBe(true)
  })

  it('https 协议应允许', () => {
    expect(isAllowedUrl('https://example.com')).toBe(true)
  })

  it('http 协议应允许', () => {
    expect(isAllowedUrl('http://localhost:3000')).toBe(true)
  })

  it('about: 协议应允许', () => {
    expect(isAllowedUrl('about:srcdoc')).toBe(true)
  })

  it('file: 协议应拒绝', () => {
    expect(isAllowedUrl('file:///etc/passwd')).toBe(false)
  })

  it('javascript: 协议应拒绝', () => {
    expect(isAllowedUrl('javascript:alert(1)')).toBe(false)
  })

  it('data: 协议应拒绝', () => {
    expect(isAllowedUrl('data:text/html,<h1>hi</h1>')).toBe(false)
  })

  it('非法 URL 应拒绝', () => {
    expect(isAllowedUrl('not a url at all')).toBe(false)
  })

  it('ftp: 协议应拒绝', () => {
    expect(isAllowedUrl('ftp://files.example.com/file.txt')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// validateNavigationUrl
// ---------------------------------------------------------------------------

describe('validateNavigationUrl', () => {
  it('默认阻止私有地址，显式授权时允许本地服务导航', () => {
    expect(validateNavigationUrl('http://127.0.0.1:43217/')).toEqual({
      ok: false,
      error: 'Blocked private host: 127.0.0.1',
    })
    expect(validateNavigationUrl('http://127.0.0.1:43217/', {
      allowPrivateHostNavigation: true,
    })).toEqual({ ok: true })
  })

  it('显式授权可限制到指定本地服务 origin', () => {
    expect(validateNavigationUrl('http://127.0.0.1:43217/', {
      allowPrivateHostNavigation: true,
      allowedPrivateOrigins: ['http://127.0.0.1:43217'],
    })).toEqual({ ok: true })
    expect(validateNavigationUrl('http://127.0.0.1:43218/', {
      allowPrivateHostNavigation: true,
      allowedPrivateOrigins: ['http://127.0.0.1:43217'],
    })).toEqual({
      ok: false,
      error: 'Blocked private host: 127.0.0.1',
    })
  })

  it('显式授权不放行危险 scheme 或 userinfo URL', () => {
    expect(validateNavigationUrl('javascript:alert(1)', {
      allowPrivateHostNavigation: true,
    }).ok).toBe(false)
    expect(validateNavigationUrl('http://user:pass@127.0.0.1:43217/', {
      allowPrivateHostNavigation: true,
    }).ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// isPrivateHost
// ---------------------------------------------------------------------------

describe('isPrivateHost', () => {
  it('localhost 应判定为内网', () => {
    expect(isPrivateHost('localhost')).toBe(true)
    expect(isPrivateHost('localhost.localdomain')).toBe(true)
  })

  it('127.x.x.x 应判定为内网', () => {
    expect(isPrivateHost('127.0.0.1')).toBe(true)
    expect(isPrivateHost('127.255.255.255')).toBe(true)
  })

  it('10.x.x.x 应判定为内网', () => {
    expect(isPrivateHost('10.0.0.1')).toBe(true)
    expect(isPrivateHost('10.255.255.255')).toBe(true)
  })

  it('172.16-31.x.x 应判定为内网', () => {
    expect(isPrivateHost('172.16.0.1')).toBe(true)
    expect(isPrivateHost('172.31.255.255')).toBe(true)
    expect(isPrivateHost('172.15.0.1')).toBe(false)
    expect(isPrivateHost('172.32.0.1')).toBe(false)
  })

  it('192.168.x.x 应判定为内网', () => {
    expect(isPrivateHost('192.168.0.1')).toBe(true)
    expect(isPrivateHost('192.168.1.100')).toBe(true)
  })

  it('169.254.x.x (link-local) 应判定为内网', () => {
    expect(isPrivateHost('169.254.0.1')).toBe(true)
  })

  it('0.x.x.x 应判定为内网', () => {
    expect(isPrivateHost('0.0.0.0')).toBe(true)
  })

  it('公网 IP 不应判定为内网', () => {
    expect(isPrivateHost('8.8.8.8')).toBe(false)
    expect(isPrivateHost('1.1.1.1')).toBe(false)
    expect(isPrivateHost('203.0.113.50')).toBe(false)
  })

  it('公网域名不应判定为内网', () => {
    expect(isPrivateHost('example.com')).toBe(false)
    expect(isPrivateHost('google.com')).toBe(false)
  })

  it('IPv6 环回应判定为内网', () => {
    expect(isPrivateHost('::1')).toBe(true)
    expect(isPrivateHost('0:0:0:0:0:0:0:1')).toBe(true)
  })

  it('IPv6 ULA (fc/fd) 应判定为内网', () => {
    expect(isPrivateHost('fc00::1')).toBe(true)
    expect(isPrivateHost('fd12:3456::1')).toBe(true)
  })

  it('IPv6 link-local (fe80) 应判定为内网', () => {
    expect(isPrivateHost('fe80::1')).toBe(true)
  })

  it('IPv4-mapped IPv6 (::ffff:127.0.0.1) 应判定为内网', () => {
    expect(isPrivateHost('::ffff:127.0.0.1')).toBe(true)
    expect(isPrivateHost('::ffff:192.168.1.1')).toBe(true)
  })

  it('IPv4-mapped IPv6 hex 形式应判定为内网', () => {
    expect(isPrivateHost('::ffff:7f00:1')).toBe(true)
  })

  it('hex/octal/decimal-long 绕过形式应判定为内网', () => {
    expect(isPrivateHost('0x7f000001')).toBe(true)
    expect(isPrivateHost('2130706433')).toBe(true)
    expect(isPrivateHost('0177.0.0.1')).toBe(true)
  })

  it('方括号包裹的 IPv6 应正确处理', () => {
    expect(isPrivateHost('[::1]')).toBe(true)
    expect(isPrivateHost('[fe80::1]')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// toErrorMessage
// ---------------------------------------------------------------------------

describe('toErrorMessage', () => {
  it('Error 对象应提取 message', () => {
    expect(toErrorMessage(new Error('boom'))).toBe('boom')
  })

  it('非空字符串应原样返回', () => {
    expect(toErrorMessage('something failed')).toBe('something failed')
  })

  it('空字符串应返回 Unknown error', () => {
    expect(toErrorMessage('')).toBe('Unknown error')
  })

  it('仅空格的字符串应返回 Unknown error', () => {
    expect(toErrorMessage('   ')).toBe('Unknown error')
  })

  it('null 应返回 Unknown error', () => {
    expect(toErrorMessage(null)).toBe('Unknown error')
  })

  it('undefined 应返回 Unknown error', () => {
    expect(toErrorMessage(undefined)).toBe('Unknown error')
  })

  it('数字应返回 Unknown error', () => {
    expect(toErrorMessage(42)).toBe('Unknown error')
  })

  it('带 message 属性的普通对象应提取 message', () => {
    expect(toErrorMessage({ message: 'oops' })).toBe('oops')
  })

  it('message 为空字符串的对象应 JSON 序列化', () => {
    expect(toErrorMessage({ message: '', code: 42 })).toBe('{"message":"","code":42}')
  })

  it('无 message 的对象应 JSON 序列化', () => {
    expect(toErrorMessage({ code: 500 })).toBe('{"code":500}')
  })

  it('循环引用对象应返回 Unknown error', () => {
    const obj: any = {}
    obj.self = obj
    expect(toErrorMessage(obj)).toBe('Unknown error')
  })
})

// ---------------------------------------------------------------------------
// sleep
// ---------------------------------------------------------------------------

describe('sleep', () => {
  it('应在指定时间后 resolve', async () => {
    vi.useFakeTimers()
    const p = sleep(100)
    vi.advanceTimersByTime(100)
    await expect(p).resolves.toBeUndefined()
    vi.useRealTimers()
  })
})

// ---------------------------------------------------------------------------
// ts (timestamp)
// ---------------------------------------------------------------------------

describe('ts', () => {
  it('应返回 ISO 格式时间戳', () => {
    const result = ts()
    expect(() => new Date(result).toISOString()).not.toThrow()
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })
})
