import { describe, it, expect } from 'vitest'
import {
  cleanUserAgent,
  buildProxyRule,
  tagProxy,
  tagUserAgent,
} from '../anti-detect-config'

// ---------------------------------------------------------------------------
// cleanUserAgent
// ---------------------------------------------------------------------------

describe('cleanUserAgent', () => {
  const baseUA =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36'

  it('应移除 Electron/xxx 标识', () => {
    const dirty = `${baseUA} Electron/28.0.0`
    expect(cleanUserAgent(dirty)).toBe(baseUA)
  })

  it('应移除 tabtin-electron/xxx 标识', () => {
    const dirty = `${baseUA} tabtin-electron/1.2.3`
    expect(cleanUserAgent(dirty)).toBe(baseUA)
  })

  it('应同时移除多个标识', () => {
    const dirty = `${baseUA} Electron/28.0.0 tabtin-electron/1.0.0`
    expect(cleanUserAgent(dirty)).toBe(baseUA)
  })

  it('应大小写不敏感', () => {
    const dirty = `${baseUA} ELECTRON/28.0.0 TABTIN-ELECTRON/1.0.0`
    expect(cleanUserAgent(dirty)).toBe(baseUA)
  })

  it('无需清洗的 UA 应原样返回', () => {
    expect(cleanUserAgent(baseUA)).toBe(baseUA)
  })

  it('空字符串应返回空字符串', () => {
    expect(cleanUserAgent('')).toBe('')
  })
})

// ---------------------------------------------------------------------------
// buildProxyRule
// ---------------------------------------------------------------------------

describe('buildProxyRule', () => {
  it('应构建基础代理 URL', () => {
    const result = buildProxyRule({ server: 'http://proxy.example.com:8080' })
    expect(result).toBe('http://proxy.example.com:8080/')
  })

  it('应注入用户名', () => {
    const result = buildProxyRule({
      server: 'http://proxy.example.com:8080',
      username: 'user1',
    })
    expect(result).toContain('user1@')
  })

  it('应注入用户名和密码', () => {
    const result = buildProxyRule({
      server: 'http://proxy.example.com:8080',
      username: 'user1',
      password: 's3cret',
    })
    const parsed = new URL(result)
    expect(parsed.username).toBe('user1')
    expect(parsed.password).toBe('s3cret')
  })

  it('socks5 协议应正常处理', () => {
    const result = buildProxyRule({ server: 'socks5://socks.example.com:1080' })
    expect(result).toMatch(/^socks5:\/\//)
  })

  it('特殊字符密码应正确编码', () => {
    const result = buildProxyRule({
      server: 'http://proxy.example.com:8080',
      username: 'user',
      password: 'p@ss:word/123',
    })
    const parsed = new URL(result)
    expect(decodeURIComponent(parsed.password)).toBe('p@ss:word/123')
  })
})

// ---------------------------------------------------------------------------
// tagProxy
// ---------------------------------------------------------------------------

describe('tagProxy', () => {
  it('null 应返回 none', () => {
    expect(tagProxy(null)).toBe('none')
  })

  it('undefined 应返回 none', () => {
    expect(tagProxy(undefined)).toBe('none')
  })

  it('有 server 应返回 server', () => {
    expect(tagProxy({ server: 'http://proxy:8080' })).toBe('http://proxy:8080')
  })

  it('有 host 应回退到 host', () => {
    expect(tagProxy({ host: '192.168.1.1' })).toBe('192.168.1.1')
  })

  it('无 server/host 应返回 unknown', () => {
    expect(tagProxy({})).toBe('unknown')
  })

  it('有认证信息时应标注 (auth)', () => {
    expect(tagProxy({ server: 'http://proxy:8080', username: 'u' })).toBe(
      'http://proxy:8080 (auth)',
    )
  })

  it('仅 password 也应标注 (auth)', () => {
    expect(tagProxy({ server: 'http://proxy:8080', password: 'p' })).toBe(
      'http://proxy:8080 (auth)',
    )
  })

  it('无认证时不应有 (auth)', () => {
    expect(tagProxy({ server: 'http://proxy:8080' })).not.toContain('(auth)')
  })
})

// ---------------------------------------------------------------------------
// tagUserAgent
// ---------------------------------------------------------------------------

describe('tagUserAgent', () => {
  it('空字符串应返回 empty', () => {
    expect(tagUserAgent('')).toBe('empty')
  })

  it('应提取 Chrome 版本标签', () => {
    const ua = 'Mozilla/5.0 ... Chrome/132.0.6834.83 Safari/537.36'
    expect(tagUserAgent(ua)).toBe('Chrome/132.0.6834.83')
  })

  it('应提取 Firefox 版本标签', () => {
    const ua = 'Mozilla/5.0 ... Firefox/121.0'
    expect(tagUserAgent(ua)).toBe('Firefox/121.0')
  })

  it('应提取 Safari 版本标签', () => {
    const ua = 'Mozilla/5.0 ... Safari/605.1.15'
    expect(tagUserAgent(ua)).toBe('Safari/605.1.15')
  })

  it('应提取 Edge 版本标签', () => {
    const ua = 'Mozilla/5.0 ... Chrome/120.0 Edge/120.0.2210.91'
    expect(tagUserAgent(ua)).toBe('Chrome/120.0')
  })

  it('无法匹配浏览器时应返回截断字符串', () => {
    const ua = 'SomeCustomBot/1.0 (compatible; SomeEngine/2.0)'
    const result = tagUserAgent(ua)
    expect(result).toContain('...')
    expect(result.length).toBeLessThanOrEqual(33)
  })
})
