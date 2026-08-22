import { describe, expect, it, vi } from 'vitest'

vi.mock('@stores/useBrowserPrefsStore', () => ({
  buildSearchUrl: (engineId: string, query: string) =>
    `https://www.baidu.com/s?wd=${encodeURIComponent(query)}`,
}))

import { normalizeBrowserAddressInput } from './browserAddressInput'

describe('normalizeBrowserAddressInput', () => {
  it('falls back to search for a malformed IP with a stray protocol prefix ()', () => {
    const result = normalizeBrowserAddressInput('http://180.101.51.73333333', 'baidu')
    expect(result).toBe('https://www.baidu.com/s?wd=http%3A%2F%2F180.101.51.73333333')
  })

  it('falls back to search for a malformed IP without a protocol prefix', () => {
    const result = normalizeBrowserAddressInput('180.101.51.73333333', 'baidu')
    expect(result).toBe('https://www.baidu.com/s?wd=180.101.51.73333333')
  })

  it('falls back to search for an out-of-range octet IP', () => {
    const result = normalizeBrowserAddressInput('999.999.999.999', 'baidu')
    expect(result).toBe('https://www.baidu.com/s?wd=999.999.999.999')
  })

  it('navigates a valid IP with an already-present protocol unchanged', () => {
    expect(normalizeBrowserAddressInput('http://180.101.51.73/', 'baidu')).toBe('http://180.101.51.73/')
  })

  it('navigates a valid protocol-less IP by adding http://', () => {
    expect(normalizeBrowserAddressInput('180.101.51.73', 'baidu')).toBe('http://180.101.51.73')
  })

  it('navigates a valid IP with a path and port', () => {
    expect(normalizeBrowserAddressInput('192.168.1.1:8080/admin', 'baidu')).toBe('http://192.168.1.1:8080/admin')
  })

  it('navigates localhost by adding http://', () => {
    expect(normalizeBrowserAddressInput('localhost:5175', 'baidu')).toBe('http://localhost:5175')
  })

  it('navigates a bracketed IPv6 literal by adding http://', () => {
    expect(normalizeBrowserAddressInput('[::1]:8080', 'baidu')).toBe('http://[::1]:8080')
  })

  it('navigates a bare domain by adding https://', () => {
    expect(normalizeBrowserAddressInput('example.com', 'baidu')).toBe('https://example.com')
  })

  it('navigates a domain with a path unchanged apart from protocol', () => {
    expect(normalizeBrowserAddressInput('example.com/path?x=1', 'baidu')).toBe('https://example.com/path?x=1')
  })

  it('navigates a bare host:port by adding http://', () => {
    expect(normalizeBrowserAddressInput('myserver:8080', 'baidu')).toBe('http://myserver:8080')
  })

  it('falls back to search for a plain phrase', () => {
    const result = normalizeBrowserAddressInput('how to fix a bug', 'baidu')
    expect(result).toBe('https://www.baidu.com/s?wd=how%20to%20fix%20a%20bug')
  })

  it('falls back to search for a single word with no dot', () => {
    const result = normalizeBrowserAddressInput('typescript', 'baidu')
    expect(result).toBe('https://www.baidu.com/s?wd=typescript')
  })

  it('returns empty string for empty input', () => {
    expect(normalizeBrowserAddressInput('   ', 'baidu')).toBe('')
  })
})
