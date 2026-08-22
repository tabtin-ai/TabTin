import { describe, expect, it } from 'vitest'
import { AdapterRegistry, hostMatchesDomain, hostnameOf } from '../registry'
import { xiaohongshuAdapter } from '../adapters/xiaohongshu'
import { createDefaultRegistry } from '../index'

describe('hostnameOf', () => {
  it('extracts hostname from a full URL', () => {
    expect(hostnameOf('https://www.xiaohongshu.com/explore/abc?x=1')).toBe('www.xiaohongshu.com')
  })
  it('tolerates a bare hostname', () => {
    expect(hostnameOf('xiaohongshu.com/foo')).toBe('xiaohongshu.com')
  })
  it('returns empty on garbage', () => {
    expect(hostnameOf('')).toBe('')
  })
})

describe('hostMatchesDomain', () => {
  it('matches same domain and subdomains', () => {
    expect(hostMatchesDomain('www.xiaohongshu.com', 'xiaohongshu.com')).toBe(true)
    expect(hostMatchesDomain('xiaohongshu.com', 'xiaohongshu.com')).toBe(true)
  })
  it('rejects unrelated / suffix-spoof domains', () => {
    expect(hostMatchesDomain('evilxiaohongshu.com', 'xiaohongshu.com')).toBe(false)
    expect(hostMatchesDomain('example.com', 'xiaohongshu.com')).toBe(false)
  })
})

describe('AdapterRegistry', () => {
  it('registers and looks up by id', () => {
    const r = new AdapterRegistry()
    r.register(xiaohongshuAdapter)
    expect(r.has('xiaohongshu')).toBe(true)
    expect(r.get('xiaohongshu')?.id).toBe('xiaohongshu')
    expect(r.list()).toHaveLength(1)
  })

  it('rejects duplicate ids', () => {
    const r = new AdapterRegistry()
    r.register(xiaohongshuAdapter)
    expect(() => r.register(xiaohongshuAdapter)).toThrow(/duplicate adapter id/)
  })

  it('resolves adapter by URL', () => {
    const r = createDefaultRegistry()
    expect(r.resolveByUrl('https://www.xiaohongshu.com/explore/abc')?.id).toBe('xiaohongshu')
    expect(r.resolveByUrl('https://xhslink.com/xyz')?.id).toBe('xiaohongshu')
    expect(r.resolveByUrl('https://search.bilibili.com/all?keyword=a')?.id).toBe('bilibili')
    expect(r.resolveByUrl('https://www.douyin.com/video/1')?.id).toBe('douyin')
    expect(r.resolveByUrl('https://reddit.com/r/foo')).toBeUndefined()
  })

  it('reports verb support', () => {
    const r = createDefaultRegistry()
    expect(r.supports('xiaohongshu', 'search')).toBe(true)
    expect(r.supports('bilibili', 'search')).toBe(true)
    expect(r.supports('xiaohongshu', 'publish')).toBe(false)
    expect(r.supports('nonexistent', 'search')).toBe(false)
  })
})
