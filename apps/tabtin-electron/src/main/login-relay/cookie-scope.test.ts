import { describe, expect, it } from 'vitest'
import {
  matchesRelayDomain,
  normalizeRelayDomain,
  normalizeRelayTargetDomain,
  toCookiesSetDetails,
  toRelayCookies,
  type RelayCookie,
} from './cookie-scope'

const relayCookie = (overrides: Partial<RelayCookie> = {}): RelayCookie => ({
  name: 'sid',
  value: 'secret',
  domain: 'example.com',
  path: '/',
  secure: false,
  httpOnly: true,
  ...overrides,
})

describe('matchesRelayDomain', () => {
  it.each([
    ['Example.COM', 'example.com'],
    ['食狮.com.cn', 'xn--85x722f.com.cn'],
    ['localhost', null],
    ['127.0.0.1', null],
    ['[2001:db8::1]', null],
    ['com', null],
    ['github.io', null],
    ['example.com:443', null],
    ['https://example.com', null],
    ['user@example.com', null],
    ['example.com/path', null],
  ])('normalizes safe relay target %s', (domain, expected) => {
    expect(normalizeRelayTargetDomain(domain)).toBe(expected)
  })

  it.each([
    ['.xiaohongshu.com', 'login.xiaohongshu.com'],
    ['login.xiaohongshu.com', 'xiaohongshu.com'],
    ['LOGIN.XIAOHONGSHU.COM', '.XiaoHongShu.Com'],
    ['.食狮.com.cn', 'WWW.食狮.COM.CN'],
    ['xiaohongshu.com', 'xiaohongshu.com'],
  ])('accepts cookie domain %s for wall %s', (cookieDomain, wallDomain) => {
    expect(matchesRelayDomain(cookieDomain, wallDomain)).toBe(true)
  })

  it.each([
    ['not-xiaohongshu.com', 'xiaohongshu.com'],
    ['xiaohongshu.com.evil.test', 'xiaohongshu.com'],
    ['', 'xiaohongshu.com'],
    ['xiaohongshu.com', ''],
    ['https://xiaohongshu.com', 'xiaohongshu.com'],
    ['.github.io', 'foo.github.io'],
    ['.公司.cn', 'foo.公司.cn'],
  ])('rejects cookie domain %s for wall %s', (cookieDomain, wallDomain) => {
    expect(matchesRelayDomain(cookieDomain, wallDomain)).toBe(false)
  })

  it('normalizes IDN, case, and bracketed IPv6 hosts', () => {
    expect(normalizeRelayDomain('食狮.COM.CN')).toBe('xn--85x722f.com.cn')
    expect(normalizeRelayDomain('[2001:0DB8:0:0:0:0:0:1]')).toBe('[2001:db8::1]')
  })

  it.each([
    ['127.0.0.1', '127.0.0.1', true],
    ['127.0.0.1', '127.0.0.2', false],
    ['.127.0.0.1', '127.0.0.1', false],
    ['[2001:db8::1]', '[2001:0DB8:0:0:0:0:0:1]', true],
    ['.[2001:db8::1]', '[2001:db8::1]', false],
    ['localhost', 'LOCALHOST', true],
    ['localhost', 'sub.localhost', false],
    ['.localhost', 'localhost', false],
  ])('restricts non-DNS cookie %s against wall %s', (cookieDomain, wallDomain, expected) => {
    expect(matchesRelayDomain(cookieDomain, wallDomain)).toBe(expected)
  })
})

describe('cookie relay mapping', () => {
  it('preserves host-only cookies by omitting domain and locating with url', () => {
    expect(toCookiesSetDetails(relayCookie({
      domain: 'login.example.com',
      path: '/account',
    }), 1_000)).toEqual({
      url: 'http://login.example.com/account',
      name: 'sid',
      value: 'secret',
      path: '/account',
      secure: false,
      httpOnly: true,
      sameSite: 'lax',
    })
  })

  it('preserves domain cookies, secure, sameSite, and expirationDate', () => {
    expect(toCookiesSetDetails(relayCookie({
      domain: '.example.com',
      secure: true,
      sameSite: 'None',
      expirationDate: 2_000,
    }), 1_000)).toEqual({
      url: 'https://example.com/',
      name: 'sid',
      value: 'secret',
      domain: '.example.com',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'no_restriction',
      expirationDate: 2_000,
    })
  })

  it('keeps session cookies session-scoped and normalizes strict/lax', () => {
    expect(toCookiesSetDetails(relayCookie({ sameSite: 'Strict' }), 1_000))
      .toMatchObject({ sameSite: 'strict' })
    expect(toCookiesSetDetails(relayCookie({ sameSite: 'Lax' }), 1_000))
      .toMatchObject({ sameSite: 'lax' })
    expect(toCookiesSetDetails(relayCookie({ expirationDate: undefined }), 1_000))
      .not.toHaveProperty('expirationDate')
  })

  it('skips expired cookies and rejects invalid domains, paths, and SameSite=None over HTTP', () => {
    expect(toCookiesSetDetails(relayCookie({ expirationDate: 999 }), 1_000)).toBeNull()
    expect(toCookiesSetDetails(relayCookie({ domain: 'bad domain' }), 1_000)).toBeNull()
    expect(toCookiesSetDetails(relayCookie({ path: 'relative' }), 1_000)).toBeNull()
    expect(toCookiesSetDetails(relayCookie({ sameSite: 'None', secure: false }), 1_000)).toBeNull()
    expect(toCookiesSetDetails(relayCookie({ domain: '.127.0.0.1' }), 1_000)).toBeNull()
    expect(toCookiesSetDetails(relayCookie({ domain: '.[2001:db8::1]' }), 1_000)).toBeNull()
    expect(toCookiesSetDetails(relayCookie({ domain: '.localhost' }), 1_000)).toBeNull()
  })

  it('exports only valid, in-scope, non-expired Electron cookies', () => {
    const cookies = [
      relayCookie({ domain: '.example.com' }),
      relayCookie({ name: 'sub', domain: 'login.example.com' }),
      relayCookie({ name: 'other', domain: 'not-example.com' }),
      relayCookie({ name: 'old', domain: '.example.com', expirationDate: 999 }),
    ] as Electron.Cookie[]

    expect(toRelayCookies(cookies, 'example.com', 1_000).map(cookie => cookie.name))
      .toEqual(['sid', 'sub'])
  })
})
