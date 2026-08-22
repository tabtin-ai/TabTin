import { describe, expect, it } from 'vitest'
import { normalizeUrlCellHref } from './normalizeUrlCellHref'

describe('normalizeUrlCellHref ', () => {
  it('keeps clean http(s) urls', () => {
    expect(normalizeUrlCellHref('https://example.com')).toBe('https://example.com')
    expect(normalizeUrlCellHref('http://example.com/path')).toBe('http://example.com/path')
  })

  it('trims leading/trailing whitespace from pasted urls', () => {
    expect(normalizeUrlCellHref(' https://example.com')).toBe('https://example.com')
    expect(normalizeUrlCellHref('https://example.com\n')).toBe('https://example.com')
    expect(normalizeUrlCellHref('\r\nhttps://example.com\t')).toBe('https://example.com')
  })

  it('prefixes https for scheme-less hosts after trim', () => {
    expect(normalizeUrlCellHref(' example.com ')).toBe('https://example.com')
    expect(normalizeUrlCellHref('sub.example.com/path')).toBe('https://sub.example.com/path')
    // 单标签 / 乱码也可补全并打开；回表不被劫持由 tab 同步保证
    expect(normalizeUrlCellHref('cdbsygt')).toBe('https://cdbsygt')
  })

  it('allows localhost and ipv4 without scheme', () => {
    expect(normalizeUrlCellHref('localhost')).toBe('https://localhost')
    expect(normalizeUrlCellHref('localhost:3000')).toBe('https://localhost:3000')
    expect(normalizeUrlCellHref('127.0.0.1')).toBe('https://127.0.0.1')
    expect(normalizeUrlCellHref('127.0.0.1:8080/x')).toBe('https://127.0.0.1:8080/x')
  })

  it('rejects empty, whitespace-only, relative path, and non-http(s) schemes', () => {
    expect(normalizeUrlCellHref('')).toBeNull()
    expect(normalizeUrlCellHref('   ')).toBeNull()
    expect(normalizeUrlCellHref('not a url')).toBeNull()
    expect(normalizeUrlCellHref('javascript:alert(1)')).toBeNull()
    expect(normalizeUrlCellHref('/relative/path')).toBeNull()
  })

  it('still opens explicit http(s) single-label hosts (intranet)', () => {
    expect(normalizeUrlCellHref('https://cdbsygt')).toBe('https://cdbsygt')
    expect(normalizeUrlCellHref('http://nas/admin')).toBe('http://nas/admin')
  })
})
